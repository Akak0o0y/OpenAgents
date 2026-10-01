/**
 * Live execution stream and subscription channel.
 *
 * Emits non-persisted RUN_LIVE frames directly to subscribed WebSocket clients.
 * - Merges output for 100 ms or 8 KB
 * - Strips ANSI escapes and control characters (preserving \n, \r, \t)
 * - Caps live output at 1 MiB per call (marking truncated: true)
 * - Retains a 16 KB tail per active call for late-subscriber snapshots
 */

export interface AttemptSnapshot {
  attemptId: string;
  revision: number;
  text: string;
  reasoning?: string;
}

export type RunLiveFrame = { type: 'RUN_LIVE'; runId: string } & (
  | { kind: 'output'; callId: string; stream: 'stdout' | 'stderr'; seq: number; data: string; truncated?: boolean }
  | { kind: 'snapshot'; calls: { callId: string; tail: string; seq: number; bytes: number }[]; attempts: AttemptSnapshot[] }
  | { kind: 'attempt'; attemptId: string; revision: number; phase: 'start' | 'end'; outcome?: 'committed' | 'abandoned' }
  | { kind: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: any }
);

export function stripAnsi(str: string): string {
  return str
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

interface CallStreamState {
  callId: string;
  stream: 'stdout' | 'stderr';
  seq: number;
  totalBytes: number;
  truncated: boolean;
  tail: string;
  pendingBuffer: string;
  timer: NodeJS.Timeout | null;
}

interface RunStreamState {
  runId: string;
  calls: Map<string, CallStreamState>;
  attempts: AttemptSnapshot[];
}

const FLUSH_DELAY_MS = 100;
const FLUSH_SIZE_BYTES = 8192;
const MAX_CALL_BYTES = 1024 * 1024; // 1 MiB
const MAX_TAIL_CHARS = 16384; // 16 KB tail

export class LiveChannel {
  private readonly runs = new Map<string, RunStreamState>();

  constructor(
    private readonly send: (runId: string, frame: RunLiveFrame) => void
  ) {}

  private getOrCreateRun(runId: string): RunStreamState {
    let run = this.runs.get(runId);
    if (!run) {
      run = { runId, calls: new Map(), attempts: [] };
      this.runs.set(runId, run);
    }
    return run;
  }

  private getOrCreateCall(runId: string, callId: string, stream: 'stdout' | 'stderr'): CallStreamState {
    const run = this.getOrCreateRun(runId);
    let call = run.calls.get(callId);
    if (!call) {
      call = {
        callId,
        stream,
        seq: 0,
        totalBytes: 0,
        truncated: false,
        tail: '',
        pendingBuffer: '',
        timer: null,
      };
      run.calls.set(callId, call);
    }
    return call;
  }

  /**
   * Append raw output to a call's live stream.
   * Strips ANSI escape sequences and merges chunks.
   */
  output(runId: string, callId: string, stream: 'stdout' | 'stderr', rawChunk: string): void {
    const cleaned = stripAnsi(rawChunk);
    if (!cleaned) return;

    const call = this.getOrCreateCall(runId, callId, stream);
    if (call.truncated) return;

    const available = MAX_CALL_BYTES - call.totalBytes;
    if (available <= 0) {
      call.truncated = true;
      this.flushCall(runId, callId);
      return;
    }

    let toAppend = cleaned;
    let willTruncate = false;
    if (Buffer.byteLength(toAppend, 'utf8') > available) {
      toAppend = toAppend.slice(0, available);
      willTruncate = true;
    }

    call.pendingBuffer += toAppend;
    call.totalBytes += Buffer.byteLength(toAppend, 'utf8');

    // Update 16 KB tail
    call.tail = (call.tail + toAppend).slice(-MAX_TAIL_CHARS);

    if (willTruncate || call.totalBytes >= MAX_CALL_BYTES) {
      call.truncated = true;
      this.flushCall(runId, callId);
      return;
    }

    if (Buffer.byteLength(call.pendingBuffer, 'utf8') >= FLUSH_SIZE_BYTES) {
      this.flushCall(runId, callId);
    } else if (!call.timer) {
      call.timer = setTimeout(() => {
        call.timer = null;
        this.flushCall(runId, callId);
      }, FLUSH_DELAY_MS);
    }
  }

  /**
   * Immediately flush any pending buffer for a call.
   */
  flushCall(runId: string, callId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const call = run.calls.get(callId);
    if (!call) return;

    if (call.timer) {
      clearTimeout(call.timer);
      call.timer = null;
    }

    if (call.pendingBuffer.length === 0 && !call.truncated) return;

    const data = call.pendingBuffer;
    call.pendingBuffer = '';

    const frame: RunLiveFrame = {
      type: 'RUN_LIVE',
      runId,
      kind: 'output',
      callId,
      stream: call.stream,
      seq: call.seq++,
      data,
      ...(call.truncated ? { truncated: true } : {}),
    };

    this.send(runId, frame);
  }

  /**
   * Close a specific call turn, flushing remaining buffers.
   */
  closeCall(runId: string, callId: string): void {
    this.flushCall(runId, callId);
  }

  /**
   * Start a new streaming attempt for an LLM turn.
   */
  startAttempt(runId: string, attemptId: string, revision: number): void {
    const run = this.getOrCreateRun(runId);
    run.attempts = run.attempts.filter(a => a.attemptId !== attemptId);
    run.attempts.push({
      attemptId,
      revision,
      text: '',
      reasoning: '',
    });
    this.send(runId, {
      type: 'RUN_LIVE',
      runId,
      kind: 'attempt',
      attemptId,
      revision,
      phase: 'start',
    });
  }

  /**
   * Emit a streamed chunk for an active attempt.
   */
  chunk(runId: string, attemptId: string, revision: number, index: number, streamChunk: any): void {
    const run = this.getOrCreateRun(runId);
    const attempt = run.attempts.find(a => a.attemptId === attemptId && a.revision === revision);
    if (attempt && streamChunk) {
      if (streamChunk.type === 'text-delta' && typeof streamChunk.text === 'string') {
        attempt.text += streamChunk.text;
      } else if (streamChunk.type === 'reasoning-delta' && typeof streamChunk.text === 'string') {
        attempt.reasoning = (attempt.reasoning ?? '') + streamChunk.text;
      }
    }
    this.send(runId, {
      type: 'RUN_LIVE',
      runId,
      kind: 'chunk',
      attemptId,
      revision,
      index,
      time: Date.now(),
      chunk: streamChunk,
    });
  }

  /**
   * End a streaming attempt, marking it committed or abandoned.
   */
  endAttempt(runId: string, attemptId: string, revision: number, outcome: 'committed' | 'abandoned'): void {
    const run = this.runs.get(runId);
    if (run) {
      run.attempts = run.attempts.filter(a => a.attemptId !== attemptId);
    }
    this.send(runId, {
      type: 'RUN_LIVE',
      runId,
      kind: 'attempt',
      attemptId,
      revision,
      phase: 'end',
      outcome,
    });
  }

  /**
   * Return a snapshot of current active call tails and attempts for a run.
   */
  snapshot(runId: string) {

    return this.getSnapshot(runId);
  }

  getSnapshot(runId: string): {
    calls: { callId: string; tail: string; seq: number; bytes: number }[];
    attempts: AttemptSnapshot[];
  } {
    const run = this.runs.get(runId);
    if (!run) return { calls: [], attempts: [] };

    const calls = Array.from(run.calls.values()).map(c => ({
      callId: c.callId,
      tail: c.tail,
      seq: c.seq,
      bytes: c.totalBytes,
    }));

    return {
      calls,
      attempts: [...run.attempts],
    };
  }

  /**
   * Clean up all state for a completed or terminated run.
   */
  closeRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    for (const call of run.calls.values()) {
      if (call.timer) {
        clearTimeout(call.timer);
        call.timer = null;
      }
    }
    this.runs.delete(runId);
  }
}
