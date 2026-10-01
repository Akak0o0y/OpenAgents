import type { AgentStore } from './agent-store.js';
import {RoutineAttention} from './routine-attention.js';
import type { TaskDefinition } from './scheduler.js';
import { routineTaskDefinition } from './routine-task.js';
import { ACTIVITY_DIGEST_TASK, activityDigestContext } from './activity-digest.js';

/** Single synchronous transaction for cron, manual and webhook admission. */
export function enqueueRoutine(store: AgentStore, id: string, options: {
  source: 'schedule' | 'manual' | 'webhook'; nextRunAt?: number; maxQueueDepth: number;
  definition?: TaskDefinition; now?: number;
}) {
  const db = store.getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const routine = store.getRoutine(id);
    if (!routine) throw new Error('Routine not found.');
    const agent = store.getAgent(routine.agent_id);
    if (!agent) throw new Error('Routine bot not found.');
    if(new RoutineAttention(store).status(agent.id,id).held)throw new Error('Routine needs attention after three repeated prerequisite failures. Fix the prerequisite and explicitly resume it.');
    if (options.source !== 'manual' && routine.enabled !== 1) throw new Error('Routine is disabled.');
    if (options.source === 'schedule' && routine.schedule_enabled === 0) throw new Error('Routine has no active timetable.');
    const active = db.prepare("SELECT id FROM task_runs WHERE routine_id = ? AND status IN ('QUEUED','RUNNING') LIMIT 1").get(id) as { id: string } | undefined;
    if (active) {
      db.exec('COMMIT');
      return { run: store.getTaskRun(active.id)!, routine, agent, created: false };
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE status IN ('QUEUED','RUNNING')").get() as { n: number };
    if (count.n >= options.maxQueueDepth) throw new Error('Installation queue is full. Retry when work finishes.');
    const taskName = routine.task_name ?? `routine-${id}`;
    const run = store.createTaskRun({ agentId: agent.id, taskName, modelId: agent.model_id, routineId: id });
    const context = taskName === ACTIVITY_DIGEST_TASK && options.definition?.work ? activityDigestContext(store, routine, options.now ?? Date.now()) : undefined;
    store.setRunDefinition(run.id, routineTaskDefinition(routine, options.definition, context));
    store.recordRoutineRun(id, run.id, 'QUEUED', options.nextRunAt ?? routine.next_run_at);
    db.exec('COMMIT');
    store.recordEvent({ task_run_id: run.id, agent_id: agent.id, model_id: agent.model_id, event_type: 'ROUTINE_TRIGGERED',
      payload_json: JSON.stringify({ routineId: id, routineName: routine.name, source: options.source, nextRunAt: options.nextRunAt }), timestamp: options.now ?? Date.now() });
    return { run, routine, agent, created: true };
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
