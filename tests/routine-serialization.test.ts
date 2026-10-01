import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';

/**
 * A bot owns one browser and one desktop, so it does one routine at a time.
 *
 * Two routines that came due together were both dispatched and then collided: the second
 * acted on a page the first had navigated away from, and both could report an uncertain
 * outcome. The second now waits rather than being lost.
 */
test('routine work in flight for a bot is counted, and other work is not', () => {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'milo', name: 'Milo', model_id: 'claude-haiku-4-5', current_status: 'IDLE', budget_cap_usd: 1 });
  store.createAgent({ id: 'other', name: 'Other', model_id: 'claude-haiku-4-5', current_status: 'IDLE', budget_cap_usd: 1 });
  const routine = store.createRoutine({
    agentId: 'milo', name: 'tweets', cronExpression: '@every 29m', humanSchedule: 'Every 29 minutes',
    timezone: 'Asia/Riyadh', promptTemplate: 'p', enabled: true, catchUpPolicy: 'skip', nextRunAt: Date.now() + 60_000,
  });

  assert.equal(store.activeRoutineRuns('milo'), 0, 'nothing has run yet');

  // A queued routine run counts: it is already committed to this bot.
  const queued = store.createTaskRun({ agentId: 'milo', taskName: 'tweets', routineId: routine.id });
  assert.equal(store.activeRoutineRuns('milo'), 1);

  store.startTaskRun(queued.id, 'claude-haiku-4-5');
  assert.equal(store.activeRoutineRuns('milo'), 1, 'still in flight once running');

  // Another bot's routine is its own business.
  assert.equal(store.activeRoutineRuns('other'), 0);

  // Chat and other non-routine work must not block a routine: only routine runs count.
  const adhoc = store.createTaskRun({ agentId: 'milo', taskName: 'a chat answer' });
  store.startTaskRun(adhoc.id, 'claude-haiku-4-5');
  assert.equal(store.activeRoutineRuns('milo'), 1, 'a chat turn is not a routine');

  // Once the first finishes, the next routine is free to start.
  store.finishTaskRun(queued.id, 'COMPLETED');
  assert.equal(store.activeRoutineRuns('milo'), 0, 'the next routine may now run');
  store.close();
});
