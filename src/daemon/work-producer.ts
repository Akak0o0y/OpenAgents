/**
 * Work Producer
 *
 * The scheduler CONSUMES queued task runs; this module is what CREATES them.
 * Without a producer the daemon is a crash-safe runner with no work: it only
 * executes what an operator enqueues by hand.
 *
 * The interface is deliberately narrow so the generation strategy can change
 * without touching the scheduler:
 *   - BacklogWorkProducer (below): cycles a declared list of task names. This is
 *     the "job runner" strategy - deterministic, bounded, no model calls.
 *   - A goal-decomposition producer (not built): would derive tasks from a
 *     mission statement. That is the "autonomous agent" strategy and is a
 *     product decision, not an engineering one. It plugs into this same slot.
 */

import type { AgentStore } from './agent-store.js';

export interface IWorkProducer {
  start(): Promise<void>;
  stop(): Promise<void>;
  produceNextTasks(store: AgentStore): Promise<number>;
}

export interface BacklogItem {
  agentId: string;
  taskName: string;
}

export interface BacklogWorkProducerOptions {
  backlog: BacklogItem[];
  /** 'cycle' repeats the backlog indefinitely (24/7 operation); 'once' drains and stops. */
  mode?: 'cycle' | 'once';
  /** Ceiling on QUEUED + RUNNING rows this producer will allow to exist at once. */
  maxQueueDepth?: number;
  /**
   * Task names the scheduler actually has definitions for. Supplying these makes
   * an unrunnable backlog fail LOUDLY at construction instead of silently
   * enqueueing rows the scheduler will immediately mark FAILED.
   */
  knownTaskNames?: string[];
}

export class BacklogWorkProducer implements IWorkProducer {
  private readonly backlog: BacklogItem[];
  private readonly mode: 'cycle' | 'once';
  private readonly maxQueueDepth: number;
  private cursor = 0;
  private running = false;
  private drained = false;

  constructor(options: BacklogWorkProducerOptions) {
    this.backlog = [...options.backlog];
    this.mode = options.mode ?? 'cycle';
    this.maxQueueDepth = options.maxQueueDepth ?? 1;

    if (this.maxQueueDepth < 1) {
      throw new Error(`maxQueueDepth must be >= 1, received ${this.maxQueueDepth}`);
    }

    if (options.knownTaskNames) {
      const known = new Set(options.knownTaskNames);
      const unknown = [...new Set(this.backlog.map((i) => i.taskName).filter((n) => !known.has(n)))];
      if (unknown.length > 0) {
        throw new Error(
          `Backlog references task definitions the scheduler does not know: ${unknown.join(', ')}. ` +
          `Known definitions: ${options.knownTaskNames.join(', ') || '(none)'}`
        );
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /** True once a 'once'-mode backlog has been fully emitted. */
  get isDrained(): boolean {
    return this.drained;
  }

  async produceNextTasks(store: AgentStore): Promise<number> {
    if (!this.running || this.drained || this.backlog.length === 0) return 0;

    const inFlight = store
      .listTaskRuns()
      .filter((r) => r.status === 'QUEUED' || r.status === 'RUNNING').length;

    let created = 0;
    // Bound the scan by one full pass so an all-paused fleet cannot spin here.
    let scanned = 0;

    while (inFlight + created < this.maxQueueDepth && scanned < this.backlog.length) {
      if (this.cursor >= this.backlog.length) {
        if (this.mode === 'once') {
          this.drained = true;
          break;
        }
        this.cursor = 0;
      }

      const item = this.backlog[this.cursor];
      this.cursor++;
      scanned++;

      const agent = store.getAgent(item.agentId);
      if (!agent || agent.current_status === 'PAUSED' || agent.current_status === 'DISABLED') {
        continue; // agent unavailable this cycle; fall through to the next entry
      }

      store.createTaskRun({ agentId: item.agentId, taskName: item.taskName });
      created++;
    }

    return created;
  }
}

/** Produces nothing. The explicit "no autonomy configured" default. */
export class PlaceholderWorkProducer implements IWorkProducer {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async produceNextTasks(_store: AgentStore): Promise<number> {
    return 0;
  }
}
