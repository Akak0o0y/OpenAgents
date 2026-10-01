import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { routineHistory } from '../src/daemon/routine-history.js';

const MODEL = 'claude-haiku-4-5';

function fixture() {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'milo', name: 'Milo', model_id: MODEL, budget_cap_usd: 1, current_status: 'IDLE' });
  const routine = store.createRoutine({ agentId: 'milo', name: 'honest-tweet', cronExpression: '*/15 * * * *', promptTemplate: 'Post one honest tweet.', nextRunAt: Date.now() });
  const thread = store.createThread({ agentId: 'milo' });
  const report = (status: 'COMPLETED' | 'FAILED' | 'ABORTED' | 'CRASHED', content: string) => {
    const run = store.createTaskRun({ agentId: 'milo', taskName: 'routine:ask', routineId: routine.id });
    store.startTaskRun(run.id, MODEL);
    store.finishTaskRun(run.id, status, status === 'COMPLETED' ? undefined : content);
    store.appendMessage({ thread_id: thread.id, role: 'assistant', content, task_run_id: run.id });
  };
  return { store, routine, report };
}

// A failed run's report is not a result. Given back as the bot's own earlier turn, an old
// "Desktop build failed" was repeated by every later run without trying the desktop again.
test('a routine builds on earlier results, not on earlier failures', () => {
  const { store, routine, report } = fixture();
  try {
    report('COMPLETED', 'Posted: coffee first.');
    report('FAILED', "I can't do that here: Desktop build failed.");
    report('COMPLETED', 'Posted: tabs over spaces.');
    report('ABORTED', 'Stopped before posting.');
    report('CRASHED', 'The daemon stopped.');
    assert.deepEqual(routineHistory(store, routine.id).map(message => [message.role, message.content]),
      [['assistant', 'Posted: coffee first.'], ['assistant', 'Posted: tabs over spaces.']]);
  } finally {
    store.close();
  }
});

test('earlier results stay bounded: the three latest, oldest first, each capped at 4000 characters', () => {
  const { store, routine, report } = fixture();
  try {
    for (const n of [1, 2, 3, 4]) report('COMPLETED', `Posted ${n}: ` + 'x'.repeat(n === 4 ? 5000 : 10));
    const history = routineHistory(store, routine.id);
    assert.deepEqual(history.map(message => message.content.slice(0, 8)), ['Posted 2', 'Posted 3', 'Posted 4']);
    assert.equal(history[2]!.content.length, 4000);
  } finally {
    store.close();
  }
});
