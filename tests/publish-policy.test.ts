/**
 * PublishPolicy: the must-post table, seeding from history, the owner's switch
 * and the install marker. Pure SQLite, with foreign keys enforced (the node:sqlite
 * default). No browser, no model, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import type { RoutineRecord } from '../src/daemon/db/schema.js';
import { PublishPolicy, type PublishPolicyRecord } from '../src/daemon/publish-policy.js';
import { xCreateTweet } from '../src/daemon/publish-probes.js';

const X = 'https://x.com';
/** gqw8h's first click on x.com: 2026-09-22 08:16:58 UTC. */
const T0 = Date.UTC(2026, 8, 22, 8, 16, 58);
type Step = [eventType: string, payload: Record<string, unknown>, at: number];
let sequence = 0;

function fixture(): AgentStore {
  const store = new AgentStore(':memory:');
  for (const id of ['milo', 'other']) {
    store.createAgent({ id, name: id, model_id: 'test-model', budget_cap_usd: 10, current_status: 'IDLE' });
  }
  return store;
}

function addRoutine(store: AgentStore, name: string, agentId = 'milo'): RoutineRecord {
  return store.createRoutine({ agentId, name, cronExpression: '*/15 * * * *', promptTemplate: `Run ${name}`, nextRunAt: T0 + 86_400_000 });
}

/** A finished routine run holding the given events. */
function pastRun(store: AgentStore, routine: RoutineRecord, steps: Step[]) {
  sequence += 1;
  const run = store.createTaskRun({ id: `run-${T0}-p${String(sequence).padStart(4, '0')}`, agentId: routine.agent_id, taskName: `routine-${routine.id}`, routineId: routine.id });
  store.startTaskRun(run.id);
  for (const [eventType, payload, at] of steps) {
    store.recordEvent({ task_run_id: run.id, agent_id: routine.agent_id, event_type: eventType, payload_json: JSON.stringify(payload), timestamp: at });
  }
  store.finishTaskRun(run.id, 'FAILED', 'fixture');
  return run;
}

const browserStart = (action: string, at: number, origin = X): Step =>
  ['EXTERNAL_ACTION_STARTED', { actionId: `a-${action}-${at}`, transport: 'browser', origin, action }, at];

const pick = (record: PublishPolicyRecord | null) => record && {
  routineId: record.routineId, agentId: record.agentId, origin: record.origin, probe: record.probe,
  required: record.required, source: record.source, evidenceRunId: record.evidenceRunId,
};

describe('PublishPolicy', () => {
  it('creates its tables idempotently and keeps the first installation time', () => {
    const store = fixture();
    try {
      const probes = [xCreateTweet()];
      const honest = addRoutine(store, 'milo-15m-honest-tweet');
      pastRun(store, honest, [browserStart('click', T0)]);
      const first = new PublishPolicy(store, probes);
      const db = store.getDatabase();
      const meta = () => db.prepare('SELECT key, value FROM routine_publish_meta ORDER BY key').all().map((row) => ({ ...row }));
      assert.equal(meta().length, 1);
      assert.equal(meta()[0].key, 'installed_at');
      assert.match(String(meta()[0].value), /^\d{13}$/);
      db.prepare("UPDATE routine_publish_meta SET value = '12345' WHERE key = 'installed_at'").run();
      const rows = first.list('milo');
      assert.equal(rows.length, 1);

      const second = new PublishPolicy(store, probes);
      assert.deepEqual(meta(), [{ key: 'installed_at', value: '12345' }], 'the first installation time is kept');
      assert.deepEqual(second.list('milo'), rows, 'a second construction changes nothing');
    } finally {
      store.close();
    }
  });

  it('seeds must-post from a browser click, double_click or press on a probe origin, earliest clicking run as evidence', () => {
    const store = fixture();
    try {
      const probes = [xCreateTweet()];
      assert.equal(probes[0].origins[0], X);
      const honest = addRoutine(store, 'milo-15m-honest-tweet');
      const viral = addRoutine(store, 'milo-viral-life-tweets');
      const doubled = addRoutine(store, 'double-clicker');
      pastRun(store, honest, [browserStart('click', T0 + 60_000)]);
      const earliest = pastRun(store, honest, [browserStart('click', T0)]); // created later, clicked first
      const pressed = pastRun(store, viral, [browserStart('fill', T0), browserStart('press', T0 + 5_000)]);
      const dbl = pastRun(store, doubled, [browserStart('double_click', T0)]);

      const policy = new PublishPolicy(store, probes);
      assert.deepEqual(pick(policy.get(honest.id)), {
        routineId: honest.id, agentId: 'milo', origin: X, probe: probes[0].id, required: true, source: 'history', evidenceRunId: earliest.id,
      });
      assert.equal(policy.get(viral.id)?.evidenceRunId, pressed.id);
      assert.equal(policy.get(doubled.id)?.evidenceRunId, dbl.id);
      assert.equal(policy.mustPublish(honest.id)?.routineId, honest.id);
      assert.deepEqual(policy.list('milo').map((r) => r.routineId).sort(), [honest.id, viral.id, doubled.id].sort());
    } finally {
      store.close();
    }
  });

  it('never seeds from fills, other origins, visits, other transports or runs of deleted routines', () => {
    const store = fixture();
    try {
      const reader = addRoutine(store, 'fill-only');
      const elsewhere = addRoutine(store, 'other-origin');
      const visitor = addRoutine(store, 'visit-only');
      const desktop = addRoutine(store, 'computer-click');
      const mcp = addRoutine(store, 'mcp-only');
      const gone = addRoutine(store, 'Milo life');
      pastRun(store, reader, [browserStart('fill', T0)]);
      pastRun(store, elsewhere, [browserStart('click', T0, 'https://example.org')]);
      pastRun(store, visitor, [
        ['WORK_ACTION', { tool: 'browser', action: 'navigate', url: `${X}/home` }, T0],
        ['BROWSER_STATE', { url: `${X}/home`, title: 'Home / X' }, T0 + 1000],
      ]);
      pastRun(store, desktop, [['EXTERNAL_ACTION_STARTED', { actionId: 'c1', transport: 'computer', action: 'click' }, T0]]);
      pastRun(store, mcp, [['EXTERNAL_ACTION_STARTED', { actionId: 'm1', server: 'echo', tool: 'reverse' }, T0]]);
      pastRun(store, gone, [browserStart('click', T0)]);
      assert.equal(store.deleteRoutine(gone.id), true);

      const policy = new PublishPolicy(store, [xCreateTweet()]);
      for (const routine of [reader, elsewhere, visitor, desktop, mcp]) {
        assert.equal(policy.get(routine.id), null, routine.name);
        assert.equal(policy.mustPublish(routine.id), null, routine.name);
      }
      const rows = store.getDatabase().prepare('SELECT COUNT(*) AS n FROM routine_publish_policy').get() as { n: number };
      assert.equal(Number(rows.n), 0);
    } finally {
      store.close();
    }
  });

  it("keeps the owner's off across reconstruction and later attempts", () => {
    const store = fixture();
    try {
      const probes = [xCreateTweet()];
      const honest = addRoutine(store, 'milo-15m-honest-tweet');
      const evidence = pastRun(store, honest, [browserStart('click', T0)]);
      const policy = new PublishPolicy(store, probes);
      const off = policy.set('milo', honest.id, false);
      assert.deepEqual(pick(off), {
        routineId: honest.id, agentId: 'milo', origin: X, probe: probes[0].id, required: false, source: 'owner', evidenceRunId: evidence.id,
      });

      const reopened = new PublishPolicy(store, probes);
      reopened.noteAttempt({ agentId: 'milo', routineId: honest.id, origin: X, probe: probes[0].id, runId: 'run-later-post' });
      assert.deepEqual(pick(reopened.get(honest.id)), pick(off));
      assert.equal(reopened.mustPublish(honest.id), null);

      const on = reopened.set('milo', honest.id, true);
      assert.equal(on.required, true);
      assert.equal(on.source, 'owner');
      assert.equal(reopened.mustPublish(honest.id)?.source, 'owner');
    } finally {
      store.close();
    }
  });

  it('notes an observed attempt only where no row exists, and only for a live routine of that bot', () => {
    const store = fixture();
    try {
      const probes = [xCreateTweet()];
      const fresh = addRoutine(store, 'fresh');
      const viral = addRoutine(store, 'milo-viral-life-tweets');
      const doomed = addRoutine(store, 'doomed');
      const seeded = pastRun(store, viral, [browserStart('click', T0)]);
      const policy = new PublishPolicy(store, probes);
      const attempt = (routineId: string, runId: string, agentId = 'milo') =>
        policy.noteAttempt({ agentId, routineId, origin: X, probe: probes[0].id, runId });

      assert.equal(policy.get(fresh.id), null);
      attempt(fresh.id, 'run-first-post');
      assert.deepEqual(pick(policy.get(fresh.id)), {
        routineId: fresh.id, agentId: 'milo', origin: X, probe: probes[0].id, required: true, source: 'observed', evidenceRunId: 'run-first-post',
      });
      attempt(fresh.id, 'run-second-post');
      assert.equal(policy.get(fresh.id)?.evidenceRunId, 'run-first-post');

      attempt(viral.id, 'run-later');
      assert.equal(policy.get(viral.id)?.source, 'history');
      assert.equal(policy.get(viral.id)?.evidenceRunId, seeded.id);

      assert.equal(store.deleteRoutine(doomed.id), true);
      assert.doesNotThrow(() => attempt(doomed.id, 'run-orphan'));
      assert.equal(policy.get(doomed.id), null);

      const theirs = addRoutine(store, 'their-routine', 'other');
      attempt(theirs.id, 'run-wrong-bot', 'milo');
      assert.equal(policy.get(theirs.id), null);
    } finally {
      store.close();
    }
  });

  it('survives an instruction edit', () => {
    const store = fixture();
    try {
      const honest = addRoutine(store, 'milo-15m-honest-tweet');
      pastRun(store, honest, [browserStart('click', T0)]);
      const policy = new PublishPolicy(store, [xCreateTweet()]);
      const before = policy.get(honest.id);
      assert.ok(before);
      store.updateRoutine(honest.id, { prompt_template: 'Reply to one post about local-first software.' });
      assert.equal(store.getRoutine(honest.id)?.prompt_template, 'Reply to one post about local-first software.');
      assert.deepEqual(policy.get(honest.id), before);
      assert.deepEqual(new PublishPolicy(store, [xCreateTweet()]).get(honest.id), before);
    } finally {
      store.close();
    }
  });

  it('cascades with deleteRoutine and deleteAgent while foreign keys are enforced', () => {
    const store = fixture();
    try {
      const db = store.getDatabase();
      assert.equal(Number((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys), 1);
      const honest = addRoutine(store, 'milo-15m-honest-tweet');
      const viral = addRoutine(store, 'milo-viral-life-tweets');
      const theirs = addRoutine(store, 'their-routine', 'other');
      pastRun(store, honest, [browserStart('click', T0)]);
      pastRun(store, viral, [browserStart('click', T0)]);
      const policy = new PublishPolicy(store, [xCreateTweet()]);
      policy.set('other', theirs.id, true);

      assert.equal(store.deleteRoutine(honest.id), true, 'no FOREIGN KEY constraint failed');
      assert.equal(policy.get(honest.id), null);
      assert.equal(policy.get(viral.id)?.source, 'history');

      assert.equal(store.deleteAgent('milo').deleted, true);
      assert.deepEqual(policy.list('milo'), []);
      assert.deepEqual(policy.list('other').map((r) => r.routineId), [theirs.id]);
    } finally {
      store.close();
    }
  });

  it("creates an owner row from the first probe when the routine has none, and refuses another bot's routine", () => {
    const store = fixture();
    try {
      const probes = [xCreateTweet()];
      const fresh = addRoutine(store, 'fresh');
      const policy = new PublishPolicy(store, probes);
      const on = policy.set('milo', fresh.id, true);
      assert.deepEqual(pick(on), {
        routineId: fresh.id, agentId: 'milo', origin: probes[0].origins[0], probe: probes[0].id, required: true, source: 'owner', evidenceRunId: null,
      });
      assert.equal(on.createdAt, on.updatedAt);
      assert.throws(() => policy.set('other', fresh.id, false), /does not belong to this bot/);
      assert.throws(() => policy.set('milo', 'rtn-missing', true), /does not belong to this bot/);

      const unmarked = addRoutine(store, 'unmarked');
      assert.throws(() => new PublishPolicy(store, []).set('milo', unmarked.id, true), /No publish probe is configured/);
      assert.equal(new PublishPolicy(store, []).set('milo', fresh.id, false).required, false, 'an existing row needs no probe');
    } finally {
      store.close();
    }
  });
});
