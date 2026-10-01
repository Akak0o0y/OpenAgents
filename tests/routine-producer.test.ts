/**
 * RoutineWorkProducer tests.
 *
 * Exercises:
 * - Producing task runs for due routines.
 * - Dynamic task definition registration.
 * - Respecting maxQueueDepth and agent availability.
 * - Schedule advancement and lifecycle event emission.
 * - realignRoutineSchedules catch_up_policy ('skip' vs 'run_once').
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { RoutineWorkProducer, realignRoutineSchedules } from '../src/daemon/routine-producer.js';
import type { TaskDefinition } from '../src/daemon/scheduler.js';
import { enqueueRoutine } from '../src/daemon/routine-dispatch.js';
import { acknowledgeRoutine, pendingForRoutine, pendingOfDeletedRoutines } from '../src/daemon/external-effects.js';

const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);
const T0 = utc(2026, 6, 15, 9, 0);

function createStore(): AgentStore {
  const store = new AgentStore(':memory:');
  store.createAgent({
    id: 'alpha',
    name: 'Alpha',
    model_id: 'test-model-1',
    budget_cap_usd: 10,
    current_status: 'IDLE',
  });
  return store;
}

describe('RoutineWorkProducer', () => {
  it('never schedules webhook-only routines, including leap day, catch-up and direct dispatch', async () => {
    const store = createStore();
    try {
      const leapDay = utc(2028, 2, 29, 3, 4);
      const routine = store.createRoutine({ agentId: 'alpha', name: 'Webhook only', cronExpression: '4 3 29 2 *', promptTemplate: 'On demand', nextRunAt: leapDay, scheduleEnabled: false, catchUpPolicy: 'run_once' });
      const producer = new RoutineWorkProducer({ now: () => leapDay });
      await producer.start();
      assert.equal(await producer.produceNextTasks(store), 0);
      assert.equal(realignRoutineSchedules(store, leapDay + 86_400_000), 0);
      assert.throws(() => enqueueRoutine(store, routine.id, { source: 'schedule', maxQueueDepth: 5 }), /no active timetable/);
      assert.equal(store.listTaskRuns().length, 0);
      assert.equal(enqueueRoutine(store, routine.id, { source: 'webhook', maxQueueDepth: 5 }).created, true);
      assert.equal(enqueueRoutine(store, routine.id, { source: 'manual', maxQueueDepth: 5 }).created, false, 'existing active run is coalesced');
      store.updateRoutine(routine.id, { enabled: 0 });
      assert.throws(() => enqueueRoutine(store, routine.id, { source: 'webhook', maxQueueDepth: 5 }), /disabled/);
      store.updateRoutine(routine.id, { enabled: 1, schedule_enabled: 1 });
      assert.equal(store.getDueRoutines(leapDay)[0]?.id, routine.id);
    } finally { store.close(); }
  });
  it('does not produce when stopped', async () => {
    const store = createStore();
    try {
      store.createRoutine({
        agentId: 'alpha',
        name: 'Due routine',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Run check',
        nextRunAt: T0 - 1000,
      });

      const producer = new RoutineWorkProducer({ now: () => T0 });
      const created = await producer.produceNextTasks(store);
      assert.equal(created, 0);
    } finally {
      store.close();
    }
  });

  it('produces task runs for due routines, advances next_run_at, and emits events', async () => {
    const store = createStore();
    const registered = new Map<string, TaskDefinition>();
    try {
      const routine = store.createRoutine({
        agentId: 'alpha',
        name: 'Daily 9am check',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Check standing system health',
        nextRunAt: T0,
      });

      const producer = new RoutineWorkProducer({
        maxQueueDepth: 5,
        now: () => T0,
        registerTaskDefinition: (name, def) => {
          registered.set(name, def);
        },
      });

      await producer.start();
      const created = await producer.produceNextTasks(store);
      assert.equal(created, 1);

      // Task run created in store
      const runs = store.listTaskRuns();
      assert.equal(runs.length, 1);
      assert.equal(runs[0].agent_id, 'alpha');
      assert.equal(runs[0].model_id, 'test-model-1', 'exact model attribution preserved');
      assert.equal(runs[0].routine_id, routine.id);

      // Schedule advanced
      const updatedRoutine = store.getRoutine(routine.id)!;
      assert.equal(updatedRoutine.last_run_status, 'QUEUED');
      assert.ok(updatedRoutine.next_run_at > T0, 'schedule advanced to next day');
      assert.equal(updatedRoutine.next_run_at, utc(2026, 6, 16, 9, 0));

      // Task definition was dynamically registered
      const taskName = `routine-${routine.id}`;
      assert.ok(registered.has(taskName));
      assert.equal(
        registered.get(taskName)!.initialFiles['PROMPT.md'],
        'Check standing system health'
      );

      // Event recorded
      const events = store.getTaskEvents(runs[0].id);
      assert.ok(events.some((e) => e.event_type === 'ROUTINE_TRIGGERED'));
    } finally {
      store.close();
    }
  });

  it('skips when maxQueueDepth is reached', async () => {
    const store = createStore();
    try {
      store.createRoutine({
        agentId: 'alpha',
        name: 'R1',
        cronExpression: '0 9 * * *',
        promptTemplate: 'p',
        nextRunAt: T0 - 1000,
      });

      // Existing task in flight
      store.createTaskRun({ agentId: 'alpha', taskName: 't1' });

      const producer = new RoutineWorkProducer({
        maxQueueDepth: 1,
        now: () => T0,
      });
      await producer.start();

      const created = await producer.produceNextTasks(store);
      assert.equal(created, 0);
    } finally {
      store.close();
    }
  });

  it('leaves routine due if agent is PAUSED or DISABLED', async () => {
    const store = createStore();
    try {
      store.updateAgentStatus('alpha', 'PAUSED');
      const r = store.createRoutine({
        agentId: 'alpha',
        name: 'R1',
        cronExpression: '0 9 * * *',
        promptTemplate: 'p',
        nextRunAt: T0 - 1000,
      });

      const producer = new RoutineWorkProducer({ now: () => T0 });
      await producer.start();

      const created = await producer.produceNextTasks(store);
      assert.equal(created, 0);

      // Still due, next_run_at unchanged
      const after = store.getRoutine(r.id)!;
      assert.equal(after.next_run_at, T0 - 1000);
    } finally {
      store.close();
    }
  });
});

describe('realignRoutineSchedules', () => {
  it('skips missed runs and advances next_run_at for catch_up_policy=skip', () => {
    const store = createStore();
    try {
      const r = store.createRoutine({
        agentId: 'alpha',
        name: 'Overdue daily',
        cronExpression: '0 9 * * *',
        promptTemplate: 'p',
        catchUpPolicy: 'skip',
        nextRunAt: T0 - 86_400_000 * 3, // 3 days overdue
      });

      const realigned = realignRoutineSchedules(store, T0);
      assert.equal(realigned, 1);

      const after = store.getRoutine(r.id)!;
      assert.equal(after.next_run_at, utc(2026, 6, 16, 9, 0), 'advanced to next occurrence');
    } finally {
      store.close();
    }
  });

  it('leaves overdue next_run_at untouched for catch_up_policy=run_once', () => {
    const store = createStore();
    try {
      const overdueTime = T0 - 86_400_000;
      const r = store.createRoutine({
        agentId: 'alpha',
        name: 'Overdue run_once',
        cronExpression: '0 9 * * *',
        promptTemplate: 'p',
        catchUpPolicy: 'run_once',
        nextRunAt: overdueTime,
      });

      const realigned = realignRoutineSchedules(store, T0);
      assert.equal(realigned, 0, 'did not skip');

      const after = store.getRoutine(r.id)!;
      assert.equal(after.next_run_at, overdueTime, 'kept overdue time for immediate run');
    } finally {
      store.close();
    }
  });
});

describe('RoutineWorkProducer pending hold', () => {
  /** The wiring index.ts uses (task 11): hold while the routine has a pending item. */
  const holdsFor = (store: AgentStore) => (_agentId: string, routineId: string) => pendingForRoutine(store, routineId).length > 0;
  const triggers = (store: AgentStore) =>
    Number((store.getDatabase().prepare("SELECT COUNT(*) AS n FROM execution_events WHERE event_type = 'ROUTINE_TRIGGERED'").get() as { n: number }).n);

  /** A due routine whose previous run clicked Post on x.com and failed with no confirmed result (the wveu4 shape). */
  function heldRoutine(store: AgentStore, name = 'viral-life') {
    const routine = store.createRoutine({ agentId: 'alpha', name, cronExpression: '*/15 * * * *', promptTemplate: 'Post one tweet', nextRunAt: T0 - 1000 });
    const previous = store.createTaskRun({ agentId: 'alpha', taskName: `routine-${routine.id}`, routineId: routine.id });
    store.startTaskRun(previous.id);
    store.recordEvent({
      task_run_id: previous.id, agent_id: 'alpha', event_type: 'EXTERNAL_ACTION_STARTED',
      payload_json: JSON.stringify({ actionId: `post-${routine.id}`, transport: 'browser', origin: 'https://x.com', action: 'click' }), timestamp: T0 - 600_000,
    });
    store.finishTaskRun(previous.id, 'FAILED', 'Browser interaction outcome is uncertain. Inspect the page and action history; do not repeat the submission automatically.');
    return { routine, previous };
  }

  it('leaves a routine with an unconfirmed click due: no run, no trigger, no schedule change', async () => {
    const store = createStore();
    try {
      const { routine, previous } = heldRoutine(store);
      const producer = new RoutineWorkProducer({ maxQueueDepth: 5, now: () => T0, holds: holdsFor(store) });
      await producer.start();
      assert.equal(await producer.produceNextTasks(store), 0);
      assert.deepEqual(store.listTaskRuns().map((r) => r.id), [previous.id]);
      assert.equal(store.getRoutine(routine.id)!.next_run_at, T0 - 1000);
      assert.equal(store.getDueRoutines(T0)[0]?.id, routine.id);
      assert.equal(triggers(store), 0);
    } finally {
      store.close();
    }
  });

  it('starts the routine on the first tick after acknowledgement', async () => {
    const store = createStore();
    try {
      const { routine, previous } = heldRoutine(store);
      const producer = new RoutineWorkProducer({ maxQueueDepth: 5, now: () => T0, holds: holdsFor(store) });
      await producer.start();
      assert.equal(await producer.produceNextTasks(store), 0);
      assert.equal(acknowledgeRoutine(store, 'alpha', routine.id), 1);
      assert.equal(await producer.produceNextTasks(store), 1);
      const created = store.listRoutineRuns(routine.id).find((r) => r.id !== previous.id)!;
      const trigger = store.getTaskEvents(created.id).find((e) => e.event_type === 'ROUTINE_TRIGGERED')!;
      assert.equal(JSON.parse(trigger.payload_json).source, 'schedule');
      assert.ok(store.getRoutine(routine.id)!.next_run_at > T0, 'the schedule advanced');
    } finally {
      store.close();
    }
  });

  it('does not hold a routine whose bot has only items of a deleted routine', async () => {
    const store = createStore();
    try {
      const { routine: gone } = heldRoutine(store, 'Milo life');
      assert.equal(store.deleteRoutine(gone.id), true);
      assert.equal(pendingOfDeletedRoutines(store, 'alpha').length, 1, 'the deleted routine still has its unconfirmed click');
      const live = store.createRoutine({ agentId: 'alpha', name: 'honest-tweet', cronExpression: '*/15 * * * *', promptTemplate: 'Reply once', nextRunAt: T0 - 1000 });
      const producer = new RoutineWorkProducer({ maxQueueDepth: 5, now: () => T0, holds: holdsFor(store) });
      await producer.start();
      assert.equal(await producer.produceNextTasks(store), 1);
      assert.equal(store.listRoutineRuns(live.id).length, 1);
    } finally {
      store.close();
    }
  });

  it('applies the one-routine-per-bot rule before asking whether a routine is held', async () => {
    const store = createStore();
    try {
      const busy = store.createRoutine({ agentId: 'alpha', name: 'busy', cronExpression: '0 9 * * *', promptTemplate: 'p', nextRunAt: T0 + 86_400_000 });
      const active = store.createTaskRun({ agentId: 'alpha', taskName: `routine-${busy.id}`, routineId: busy.id });
      store.startTaskRun(active.id);
      const due = store.createRoutine({ agentId: 'alpha', name: 'due', cronExpression: '0 9 * * *', promptTemplate: 'p', nextRunAt: T0 - 1000 });
      let asked = 0;
      const producer = new RoutineWorkProducer({ maxQueueDepth: 5, now: () => T0, holds: () => { asked += 1; return false; } });
      await producer.start();
      assert.equal(await producer.produceNextTasks(store), 0);
      assert.equal(asked, 0, 'an active routine run leaves the others due before the hold is consulted');
      assert.equal(store.getRoutine(due.id)!.next_run_at, T0 - 1000);
      store.finishTaskRun(active.id, 'COMPLETED');
      assert.equal(await producer.produceNextTasks(store), 1);
      assert.equal(asked, 1);
    } finally {
      store.close();
    }
  });

  it('without the holds option produces a held-shaped routine exactly as before', async () => {
    const store = createStore();
    try {
      const { routine } = heldRoutine(store);
      const producer = new RoutineWorkProducer({ maxQueueDepth: 5, now: () => T0 });
      await producer.start();
      assert.equal(await producer.produceNextTasks(store), 1);
      assert.equal(store.listRoutineRuns(routine.id).length, 2);
    } finally {
      store.close();
    }
  });
});
