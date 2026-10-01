import { createHash, randomUUID } from 'node:crypto';
import type { AgentStore } from './agent-store.js';
import type { CharacterJournal, ExpiryReason } from './character-journal.js';
import { textSha256 } from './publish-probes.js';

export const ADMISSION_TTL_MS = 5 * 60_000;
export const CHARACTER_REFUSED_NOTE =
  "Refused: this text wasn't prepared with prepare_post, or its approval expired or changed. Nothing was sent. Call prepare_post, then type the returned text exactly.";

/**
 * Exact text digest canonicalised according to §11.1:
 * sha256(utf8(text.normalize('NFC').replace(/\r\n/g, '\n').trim()))
 */
export function exactSha256(text: string): string {
  const canonical = text
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .trim();
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export type AdmissionState = 'live' | 'consuming' | 'consumed' | 'invalid';

export interface CharacterAdmission {
  id: string;
  agentId: string;
  runId: string;
  utteranceId: string;
  candidateId: string;
  op: 'post' | 'reply';
  replyTo: string | null;
  exactSha256: string;
  textSha256: string;
  version: number;
  issuedAt: number;
  expiresAt: number;
  state: AdmissionState;
  consumedByPublishId: string | null;
  invalidReason?: string;
}

export interface CharacterReservation {
  readonly admissionId: string;
  readonly utteranceId: string;
  commitAttempt(publishId: string, writeAttempted: () => void): void;
}

export interface CharacterGate {
  reserve(request: {
    text: string;
    op: 'post' | 'reply' | 'unknown';
    inReplyTo: string | undefined;
  }): { kind: 'reserved'; reservation: CharacterReservation } | { kind: 'none'; utteranceId?: string };
  invalidate(reason: 'takeover'): void;
}

export interface CharacterPolicy {
  requireAdmission: boolean;
  gate: CharacterGate;
}

interface AdmissionEntry {
  admission: CharacterAdmission;
  exactText: string;
  timerHandle?: unknown;
}

export interface CharacterAdmissionsOptions {
  store: AgentStore;
  journal: CharacterJournal;
  activeVersion: (agentId: string) => { version: number; mode: 'off' | 'voice' | 'character' } | null;
  now?: () => number;
  ids?: () => string;
  assertRelease?:(utteranceId:string)=>void;
  timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

export class CharacterAdmissions {
  private assertRelease?: (utteranceId:string)=>void;
  private readonly store: AgentStore;
  private readonly journal: CharacterJournal;
  private readonly activeVersion: (agentId: string) => { version: number; mode: 'off' | 'voice' | 'character' } | null;
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly timers: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };

  private readonly byId = new Map<string, AdmissionEntry>();
  private readonly byRunId = new Map<string, AdmissionEntry>();
  private readonly historyByRun = new Map<string, AdmissionEntry[]>();

  constructor(opts: CharacterAdmissionsOptions) {
    this.assertRelease=opts.assertRelease;
    this.store = opts.store;
    this.journal = opts.journal;
    this.activeVersion = opts.activeVersion;
    this.now = opts.now ?? (() => Date.now());
    this.ids = opts.ids ?? (() => randomUUID());
    this.timers = opts.timers ?? {
      set: (fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as any).unref?.();
        return t;
      },
      clear: (handle) => {
        clearTimeout(handle as any);
      },
    };
  }

  issue(i: {
    runId: string;
    agentId: string;
    utteranceId: string;
    candidateId: string;
    op: 'post' | 'reply';
    replyTo: string | null;
    text: string;
    version: number;
  }): Readonly<CharacterAdmission> {
    // A run has at most one live admission; issue() replaces any live admission
    const existing = this.byRunId.get(i.runId);
    if (existing && existing.admission.state === 'live') {
      existing.admission.state = 'invalid';
      existing.admission.invalidReason = 'replaced';
      this.timers.clear(existing.timerHandle);
      try {
        this.journal.expire(existing.admission.utteranceId, 'replaced');
      } catch {
        /* best-effort journal expire */
      }
    }

    const exactHash = exactSha256(i.text);
    const tSha = textSha256(i.text);
    const id = `adm-${this.ids()}`;
    const issuedAt = this.now();
    const expiresAt = issuedAt + ADMISSION_TTL_MS;

    const admission: CharacterAdmission = {
      id,
      agentId: i.agentId,
      runId: i.runId,
      utteranceId: i.utteranceId,
      candidateId: i.candidateId,
      op: i.op,
      replyTo: i.replyTo,
      exactSha256: exactHash,
      textSha256: tSha,
      version: i.version,
      issuedAt,
      expiresAt,
      state: 'live',
      consumedByPublishId: null,
    };

    const entry: AdmissionEntry = {
      admission,
      exactText: i.text,
    };

    const timerHandle = this.timers.set(() => {
      this.handleExpiry(id);
    }, ADMISSION_TTL_MS);
    entry.timerHandle = timerHandle;

    this.byId.set(id, entry);
    this.byRunId.set(i.runId, entry);

    const history = this.historyByRun.get(i.runId) ?? [];
    history.push(entry);
    this.historyByRun.set(i.runId, history);

    return admission;
  }

  private handleExpiry(id: string): void {
    const entry = this.byId.get(id);
    if (entry && entry.admission.state === 'live') {
      entry.admission.state = 'invalid';
      entry.admission.invalidReason = 'expired';
      try {
        this.journal.expire(entry.admission.utteranceId, 'expired');
      } catch {
        /* best effort */
      }
    }
  }

  gateFor(runId: string, agentId: string): CharacterGate {
    return {
      reserve: (request) => this.reserveForRun(runId, agentId, request),
      invalidate: (reason: 'takeover') => {
        this.invalidateRun(runId, reason);
      },
    };
  }

  private reserveForRun(
    runId: string,
    agentId: string,
    request: { text: string; op: 'post' | 'reply' | 'unknown'; inReplyTo: string | undefined }
  ): { kind: 'reserved'; reservation: CharacterReservation } | { kind: 'none'; utteranceId?: string } {
    const inputHash = exactSha256(request.text);
    const history = this.historyByRun.get(runId) ?? [];

    // Find any admission of the run whose digest matched (for diagnostics/events on miss)
    let matchedUtteranceId: string | undefined;
    for (const h of history) {
      if (h.admission.exactSha256 === inputHash) {
        matchedUtteranceId = h.admission.utteranceId;
        break;
      }
    }

    const current = this.byRunId.get(runId);
    if (!current) {
      return { kind: 'none', ...(matchedUtteranceId ? { utteranceId: matchedUtteranceId } : {}) };
    }

    const adm = current.admission;

    // Check if current admission matches:
    // 1. Digest matches
    // 2. Same op (unknown never matches post/reply)
    // 3. replyTo === (inReplyTo ?? null)
    // 4. state === 'live'
    // 5. now < expiresAt
    // 6. version matches active enabled version
    const now = this.now();
    const opMatches = request.op !== 'unknown' && adm.op === request.op;
    const replyMatches = adm.replyTo === (request.inReplyTo ?? null);
    const isLive = adm.state === 'live';
    const notExpired = now < adm.expiresAt;
    const digestMatches = adm.exactSha256 === inputHash;

    if (!digestMatches || !opMatches || !replyMatches || !isLive || !notExpired) {
      return { kind: 'none', ...(matchedUtteranceId ? { utteranceId: matchedUtteranceId } : {}) };
    }

    const active = this.activeVersion(agentId);
    if (!active || active.mode === 'off' || active.version !== adm.version) {
      return { kind: 'none', ...(matchedUtteranceId ? { utteranceId: matchedUtteranceId } : {}) };
    }

    try{this.assertRelease?.(adm.utteranceId);}catch{return {kind:'none',utteranceId:adm.utteranceId};}
    // Match! Mark consuming and return reservation
    adm.state = 'consuming';
    const admissionId = adm.id;
    const utteranceId = adm.utteranceId;

    const reservation: CharacterReservation = {
      admissionId,
      utteranceId,
      commitAttempt: (publishId: string, writeAttempted: () => void): void => {
        try {
          this.store.transaction(() => {
            writeAttempted();
            this.journal.markAttempted(utteranceId, publishId, request.text, textSha256(request.text));
          });
        } catch (error) {
          adm.state = 'invalid';
          adm.invalidReason = 'attempt-write-failed';
          this.timers.clear(current.timerHandle);
          try {
            this.journal.markRefused(utteranceId, 'attempt-write-failed');
          } catch {
            /* the rollback already left nothing attempted */
          }
          throw error;
        }

        adm.state = 'consumed';
        adm.consumedByPublishId = publishId;
        this.timers.clear(current.timerHandle);
      },
    };

    return { kind: 'reserved', reservation };
  }

  invalidateRun(runId: string, reason: 'run-ended' | 'cancelled' | 'takeover'): number {
    let count = 0;
    const history = this.historyByRun.get(runId) ?? [];
    for (const entry of history) {
      if (entry.admission.state === 'live' || entry.admission.state === 'consuming') {
        entry.admission.state = 'invalid';
        entry.admission.invalidReason = reason;
        this.timers.clear(entry.timerHandle);
        const expiryReason = reason as ExpiryReason;
        try {
          this.journal.expire(entry.admission.utteranceId, expiryReason);
        } catch {
          /* best effort */
        }
        count++;
      }
    }

    if (reason === 'run-ended') {
      this.byRunId.delete(runId);
    }

    return count;
  }

  invalidateAgent(agentId: string, reason: 'version-changed'): number {
    let count = 0;
    for (const entry of this.byId.values()) {
      if (entry.admission.agentId === agentId && (entry.admission.state === 'live' || entry.admission.state === 'consuming')) {
        entry.admission.state = 'invalid';
        entry.admission.invalidReason = reason;
        this.timers.clear(entry.timerHandle);
        try {
          this.journal.expire(entry.admission.utteranceId, 'version-changed');
        } catch {
          /* best effort */
        }
        count++;
      }
    }
    return count;
  }

  inspect(id: string): Readonly<CharacterAdmission> | undefined {
    return this.byId.get(id)?.admission;
  }

  liveFor(runId: string): Readonly<CharacterAdmission> | undefined {
    const entry = this.byRunId.get(runId);
    if (!entry) return undefined;
    if (entry.admission.state === 'live' && this.now() < entry.admission.expiresAt) {
      return entry.admission;
    }
    return undefined;
  }
}
