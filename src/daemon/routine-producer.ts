import { enqueueRoutine } from './routine-dispatch.js';
import {RoutineAttention} from './routine-attention.js';
/**
 * Routine Work Producer
 *
 * Scans for enabled routines whose `next_run_at <= now`, enqueues task runs
 * targeting their assigned agents, advances the schedule to the next instant
 * via the cron engine, and stamps execution history.
 *
 * Priority over general background queues: routines have specific wall-clock
 * deadlines (e.g. "every day at 9 am"), so they must never be starved by an
 * infinite backlog cycle.
 */

import type { AgentStore } from './agent-store.js';
import type { IWorkProducer } from './work-producer.js';
import { computeNextRun } from './cron.js';
import type { TaskDefinition } from './scheduler.js';
import { routineTaskDefinition } from './routine-task.js';

export interface RoutineWorkProducerOptions {
  /** Maximum active (QUEUED + RUNNING) tasks allowed across the daemon. */
  maxQueueDepth?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Optional registrar for ad-hoc prompt tasks. */
  registerTaskDefinition?: (taskName: string, def: TaskDefinition) => void;
  getTaskDefinition?: (taskName: string) => TaskDefinition | undefined;
  /**
   * Leave a due routine due while this returns true. index.ts passes the pending
   * gate (an earlier run of the routine sent something whose result was never
   * confirmed). Without it every due routine is produced exactly as before.
   */
  holds?: (agentId: string, routineId: string) => boolean;
}

/**
 * Re-align overdue routines at daemon startup.
 *
 * For routines with `catch_up_policy = 'skip'`, any missed run while the daemon
 * was down is skipped and `next_run_at` is moved forward to the next future
 * occurrence.
 *
 * Routines with `catch_up_policy = 'run_once'` are left untouched so the first
 * scheduler cycle executes exactly one catch-up run.
 */
export function realignRoutineSchedules(
  store: AgentStore,
  now: number = Date.now()
): number {
  const overdue = store.getDueRoutines(now);
  let realigned = 0;

  for (const routine of overdue) {
    if (routine.catch_up_policy === 'skip') {
      try {
        const next = computeNextRun(routine.cron_expression, now, routine.timezone);
        store.updateRoutine(routine.id, { next_run_at: next });
        realigned++;
      } catch (err) {
        console.error(
          `[Routine] Failed to compute next run for routine "${routine.id}" (${routine.name}):`,
          err
        );
      }
    }
  }

  return realigned;
}

export class RoutineWorkProducer implements IWorkProducer {
  private readonly maxQueueDepth: number;
  private readonly now: () => number;
  private readonly registerTaskDefinition?: (taskName: string, def: TaskDefinition) => void;
  private readonly getTaskDefinition?: (taskName: string) => TaskDefinition | undefined;
  private readonly holds?: (agentId: string, routineId: string) => boolean;
  private running = false;

  constructor(options: RoutineWorkProducerOptions = {}) {
    this.maxQueueDepth = options.maxQueueDepth ?? 1;
    this.now = options.now ?? (() => Date.now());
    this.registerTaskDefinition = options.registerTaskDefinition;
    this.getTaskDefinition = options.getTaskDefinition;
    this.holds = options.holds;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async produceNextTasks(store: AgentStore): Promise<number> {
    if (!this.running) return 0;

    const inFlight = store.countPendingTaskRuns();

    if (inFlight >= this.maxQueueDepth) {
      return 0;
    }

    const currentTime = this.now();
    const dueRoutines = store.getDueRoutines(currentTime);
    let created = 0;

    for (const routine of dueRoutines) {
      if (inFlight + created >= this.maxQueueDepth) {
        break;
      }

      const agent = store.getAgent(routine.agent_id);
      if (!agent || agent.current_status === 'PAUSED' || agent.current_status === 'DISABLED') {
        // Agent is unavailable; leave routine due so it triggers once resumed.
        continue;
      }

      // One routine at a time per bot. Two that came due together were dispatched
      // together and then fought over the single browser and desktop that bot owns: the
      // second would act on a page the first had navigated away from, and both could end
      // up reporting an uncertain outcome. Leaving this one due means it starts as soon
      // as the first finishes, rather than being lost.
      if (store.activeRoutineRuns(routine.agent_id) > 0) continue;

      // An earlier run of this routine sent something whose result was never
      // confirmed. Leave it due, with no run, no trigger and no schedule change: it
      // starts on the first tick after the owner acknowledges the pending item.
      if (this.holds?.(routine.agent_id, routine.id)) continue;
      if(new RoutineAttention(store).status(routine.agent_id,routine.id).held)continue;

      let nextRunAt: number;
      try {
        nextRunAt = computeNextRun(routine.cron_expression, currentTime, routine.timezone);
      } catch (err: any) {
        console.error(`[Routine] Invalid next occurrence for routine "${routine.id}": ${err.message}`);
        // Disable broken routine so it does not peg the scheduler in a tight loop.
        store.updateRoutine(routine.id, { enabled: 0, last_run_status: 'FAILED_SCHEDULE' });
        continue;
      }

      const taskName = routine.task_name ?? `routine-${routine.id}`;

      // If an ad-hoc prompt template is defined and registration is available,
      // register a task definition with the prompt in PROMPT.md.
      const definition = routineTaskDefinition(routine, routine.task_name ? this.getTaskDefinition?.(taskName) : undefined);
      if (!routine.task_name) this.registerTaskDefinition?.(taskName, definition);

      const dispatched = enqueueRoutine(store, routine.id, { source: 'schedule', nextRunAt, maxQueueDepth: this.maxQueueDepth,
        definition: routine.task_name ? this.getTaskDefinition?.(taskName) : undefined, now: currentTime });
      if (dispatched.created) created++;
    }

    return created;
  }
}
