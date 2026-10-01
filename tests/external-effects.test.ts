/**
 * external-effects: the unmatched-STARTED scan shared with missions and
 * background tasks, the routine pending gate, items of deleted routines,
 * acknowledgement, 7-day publish history, the per-run publish summary and
 * runEvents. Pure SQLite fixtures: no browser, no model, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import type { RoutineRecord } from '../src/daemon/db/schema.js';
import { PublishPolicy } from '../src/daemon/publish-policy.js';
import { xCreateTweet } from '../src/daemon/publish-probes.js';
import {
  acknowledgeRoutine,
  pendingForRoutine,
  pendingMessage,
  pendingOfDeletedRoutines,
  publishSummary,
  recentPublishes,
  runEvents,
  unmatchedStarts,
  type PendingEffect,
} from '../src/daemon/external-effects.js';

const X = 'https://x.com';
/** wveu4's Post click: 2026-09-22 10:56:50 UTC. */
const CLICK_AT = Date.UTC(2026, 8, 22, 10, 56, 50);
const DAY = 86_400_000;
const START = 'EXTERNAL_ACTION_STARTED';
const FINISH = 'EXTERNAL_ACTION_FINISHED';

type Step = [eventType: string, payload: Record<string, unknown>];
let sequence = 0;

function fixture(): AgentStore {
  const store = new AgentStore(':memory:');
  for (const id of ['milo', 'other']) {
    store.createAgent({ id, name: id, model_id: 'test-model', budget_cap_usd: 10, current_status: 'IDLE' });
  }
  return store;
}

function addRoutine(store: AgentStore, name: string, agentId = 'milo'): RoutineRecord {
  return store.createRoutine({ agentId, name, cronExpression: '*/15 * * * *', promptTemplate: `Run ${name}`, nextRunAt: CLICK_AT + DAY });
}

/**
 * A routine run: ROUTINE_TRIGGERED one second before `at`, TASK_STARTED, the steps
 * one second apart from `at`, then the terminal status (FAILED unless told otherwise;
 * RUNNING leaves it open).
 */
function addRun(store: AgentStore, routine: RoutineRecord, steps: Step[], options: { at?: number; status?: 'COMPLETED' | 'FAILED' | 'CRASHED' | 'RUNNING' } = {}) {
  sequence += 1;
  const at = options.at ?? CLICK_AT;
  const run = store.createTaskRun({ id: `run-${at}-e${String(sequence).padStart(4, '0')}`, agentId: routine.agent_id, taskName: `routine-${routine.id}`, routineId: routine.id });
  store.recordEvent({ task_run_id: run.id, agent_id: routine.agent_id, event_type: 'ROUTINE_TRIGGERED', payload_json: JSON.stringify({ routineId: routine.id, routineName: routine.name, source: 'schedule' }), timestamp: at - 1000 });
  store.startTaskRun(run.id);
  steps.forEach(([eventType, payload], index) => {
    store.recordEvent({ task_run_id: run.id, agent_id: routine.agent_id, event_type: eventType, payload_json: JSON.stringify(payload), timestamp: at + index * 1000 });
  });
  const status = options.status ?? 'FAILED';
  if (status !== 'RUNNING') store.finishTaskRun(run.id, status, 'fixture');
  return run;
}

const browser = (actionId: string, action: string, origin = X): Step => [START, { actionId, transport: 'browser', origin, action }];
const computer = (actionId: string, action = 'type'): Step => [START, { actionId, transport: 'computer', action }];
const finished = (actionId: string): Step => [FINISH, { actionId, transport: 'browser' }];
const attempted = (publishId: string, extra: Record<string, unknown> = {}): Step =>
  ['PUBLISH_ATTEMPTED', { publishId, by: 'model', probe: 'x.com/create-tweet', op: 'reply', origin: X, sentAt: CLICK_AT, ...extra }];
const observed = (publishId: string, outcome: 'confirmed' | 'rejected' | 'unobserved', extra: Record<string, unknown> = {}): Step =>
  ['PUBLISH_OBSERVED', { publishId, outcome, settledAt: CLICK_AT + 2000, ...extra }];
const reconciled = (publishId: string, verdict: 'present' | 'not-found', extra: Record<string, unknown> = {}): Step =>
  ['PUBLISH_RECONCILED', { publishId, verdict, by: 'page-check', ...extra }];
const refused = (reason: string): Step => ['PUBLISH_REFUSED', { probe: 'x.com/create-tweet', op: 'reply', reason, by: 'model' }];
const acknowledged = (key: string, kind: 'action' | 'publish'): Step => ['EXTERNAL_ACTION_ACKNOWLEDGED', { key, kind, by: 'operator', at: CLICK_AT + 60_000 }];
const keys = (items: readonly PendingEffect[]) => items.map((item) => item.key);

describe('unmatchedStarts', () => {
  type Row = { event_type: string; payload_json: string | null };
  const row = (event_type: string, payload: unknown): Row => ({ event_type, payload_json: JSON.stringify(payload) });

  /** missions.ts:162-166 before this change. */
  function oldMissionsScan(events: readonly Row[]): Set<string | undefined> {
    const pending = new Set<string | undefined>();
    for (const e of events) {
      if (e.event_type === START) pending.add(JSON.parse(e.payload_json!).actionId);
      if (e.event_type === FINISH) pending.delete(JSON.parse(e.payload_json!).actionId);
    }
    return pending;
  }

  /** background-tasks.ts:47-48 before this change (its query kept only these two types, in id order). */
  function oldBackgroundScan(events: readonly Row[]): Set<string> {
    const pending = new Set<string>();
    for (const e of events.filter((x) => x.event_type === START || x.event_type === FINISH)) {
      const p = JSON.parse(e.payload_json!);
      const key = p.actionId ?? p.callId ?? 'external';
      if (e.event_type === START) pending.add(key); else pending.delete(key);
    }
    return pending;
  }

  const click = (actionId: string) => row(START, { actionId, transport: 'browser', origin: X, action: 'click' });
  const cases: Record<string, Row[]> = {
    'a finished browser click': [click('a1'), row('BROWSER_STATE', { url: X }), row(FINISH, { actionId: 'a1', transport: 'browser' })],
    'an open browser click': [click('a1')],
    'repository publication paired without actionId': [
      row(START, { kind: 'repository-publication', repository: 'owner/repo', digest: 'd1', branch: 'fix' }),
      row(FINISH, { kind: 'repository-publication', repository: 'owner/repo', digest: 'd1', url: 'https://github.com/owner/repo/pull/1', commit: 'c1' }),
    ],
    'repository publication left open': [row(START, { kind: 'repository-publication', repository: 'owner/repo', digest: 'd1', branch: 'fix' })],
    'MCP finished and a computer action left open': [
      row(START, { actionId: 'm1', server: 'echo', tool: 'reverse' }),
      row('TOOL_CALL', { tool: 'reverse' }),
      row(FINISH, { actionId: 'm1', isError: false }),
      row(START, { actionId: 'c1', transport: 'computer', action: 'type' }),
    ],
    'two open, one finished': [click('a1'), click('a2'), row(FINISH, { actionId: 'a1', transport: 'browser' })],
  };

  it('pairs STARTED and FINISHED exactly as the old missions and background scans did', () => {
    for (const [name, events] of Object.entries(cases)) {
      const scanned = unmatchedStarts(events);
      assert.deepEqual([...scanned.keys()], [...oldBackgroundScan(events)], name);
      assert.deepEqual([...scanned.keys()], [...oldMissionsScan(events)].map((key) => key ?? 'external'), name);
    }
    assert.deepEqual(unmatchedStarts(cases['two open, one finished']).get('a2'), { action: 'click', transport: 'browser', origin: X });
    assert.deepEqual(unmatchedStarts(cases['MCP finished and a computer action left open']).get('c1'), { action: 'type', transport: 'computer' });
    assert.deepEqual([...unmatchedStarts(cases['repository publication left open'])], [['external', {}]]);
  });

  it("keys a null payload as 'external', where the old missions scan threw", () => {
    const events: Row[] = [{ event_type: START, payload_json: null }];
    assert.deepEqual([...unmatchedStarts(events)], [['external', {}]]);
    assert.throws(() => oldMissionsScan(events), TypeError);
  });
});

describe('pendingForRoutine', () => {
  it('counts click, double_click, press and computer actions, and never the excluded kinds', () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'viral-life');
      addRun(store, r, [
        browser('k-fill', 'fill'), browser('k-right', 'right_click'), browser('k-select', 'select'), browser('k-check', 'check'),
        browser('k-drag', 'drag'), browser('k-upload', 'upload'), browser('k-download', 'download'),
        [START, { actionId: 'k-mcp', server: 'echo', tool: 'reverse' }],
        [START, { kind: 'repository-publication', repository: 'owner/repo', digest: 'd1', branch: 'fix' }],
        browser('k-click', 'click'), browser('k-double', 'double_click'), browser('k-press', 'press'), computer('k-desktop'),
      ]);
      assert.deepEqual(pendingForRoutine(store, r.id).map((i) => [i.key, i.kind, i.action, i.transport]), [
        ['k-click', 'action', 'click', 'browser'],
        ['k-double', 'action', 'double_click', 'browser'],
        ['k-press', 'action', 'press', 'browser'],
        ['k-desktop', 'action', 'type', 'computer'],
      ]);
    } finally {
      store.close();
    }
  });

  it('describes a timed-out Post click in full (the wveu4 shape), with before false when no install marker exists', () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'viral-life');
      const run = addRun(store, r, [browser('post-click', 'click')]);
      assert.deepEqual(pendingForRoutine(store, r.id), [{
        runId: run.id, routineId: r.id, routineName: 'viral-life', routineDeleted: false,
        key: 'post-click', kind: 'action', action: 'click', transport: 'browser', origin: X, at: CLICK_AT, before: false,
        detail: `Not started: run ${run.id} at 2026-09-22 10:56 UTC submitted something on x.com whose result was never confirmed. Check the account, then choose “Checked — continue” on this routine.`,
      }]);
    } finally {
      store.close();
    }
  });

  it('labels items of runs that started before Stage 1 was installed', () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'viral-life');
      new PublishPolicy(store, [xCreateTweet()]);
      const db = store.getDatabase();
      const installed = Number((db.prepare("SELECT value FROM routine_publish_meta WHERE key = 'installed_at'").get() as { value: string }).value);
      const old = addRun(store, r, [browser('old-click', 'click')]);
      const late = addRun(store, r, [browser('late-click', 'click')]); // timed out, and no CreateTweet was ever seen
      db.prepare('UPDATE task_runs SET started_at = ? WHERE id = ?').run(installed - 60_000, old.id);
      db.prepare('UPDATE task_runs SET started_at = ? WHERE id = ?').run(installed + 60_000, late.id);
      const before = new Map(pendingForRoutine(store, r.id).map((item) => [item.key, item.before]));
      assert.deepEqual([...before].sort(), [['late-click', false], ['old-click', true]]);
    } finally {
      store.close();
    }
  });

  it('resolves an action item by a confirmed, rejected or page-confirmed publish of the same action, or by acknowledgement', () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'honest-tweet');
      const postUrl = `${X}/example_account/status/1234567890123456789`;
      addRun(store, r, [browser('a-confirmed', 'click'), attempted('p1', { actionId: 'a-confirmed' }), observed('p1', 'confirmed', { postId: '1234567890123456789', postUrl })]);
      addRun(store, r, [browser('a-rejected', 'click'), attempted('p2', { actionId: 'a-rejected' }), observed('p2', 'rejected', { reason: 'code 187', errorCodes: [187] })]);
      addRun(store, r, [browser('a-on-page', 'click'), attempted('p3', { actionId: 'a-on-page' }), observed('p3', 'unobserved', { reason: 'timeout' }), reconciled('p3', 'present', { postUrl })]);
      addRun(store, r, [browser('a-acknowledged', 'click'), acknowledged('a-acknowledged', 'action')]);
      addRun(store, r, [browser('a-unrelated', 'click'), attempted('p4', { actionId: 'another-action' }), observed('p4', 'confirmed', { postId: '1', postUrl })]);
      assert.deepEqual(keys(pendingForRoutine(store, r.id)), ['a-unrelated']);
    } finally {
      store.close();
    }
  });

  it('keeps a sent post pending until it is confirmed, rejected, found on the page or acknowledged', () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'honest-tweet');
      addRun(store, r, [attempted('p-bare')]);
      addRun(store, r, [attempted('p-unobserved'), observed('p-unobserved', 'unobserved', { reason: 'timeout' })]);
      addRun(store, r, [attempted('p-not-found'), observed('p-not-found', 'unobserved', { reason: 'no-response' }), reconciled('p-not-found', 'not-found')]);
      addRun(store, r, [attempted('p-confirmed'), observed('p-confirmed', 'confirmed', { postId: '1', postUrl: `${X}/milo/status/1` })]);
      addRun(store, r, [attempted('p-rejected'), observed('p-rejected', 'rejected', { reason: 'code 187', errorCodes: [187] })]);
      addRun(store, r, [attempted('p-on-page'), observed('p-on-page', 'unobserved', { reason: 'timeout' }), reconciled('p-on-page', 'present', { postUrl: `${X}/milo/status/2` })]);
      addRun(store, r, [attempted('p-acknowledged'), acknowledged('p-acknowledged', 'publish')]);
      const pending = pendingForRoutine(store, r.id);
      assert.deepEqual(keys(pending), ['p-not-found', 'p-unobserved', 'p-bare'], 'newest run first');
      for (const item of pending) {
        assert.equal(item.kind, 'publish');
        assert.equal(item.transport, 'browser');
        assert.equal(item.origin, X);
      }
    } finally {
      store.close();
    }
  });

  it('keeps a pending run in the window after 25 gate-refused runs, and counts only dispatching runs', () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'viral-life');
      const stuck = addRun(store, r, [browser('stuck', 'click')]);
      for (let i = 0; i < 25; i += 1) addRun(store, r, []); // refused at the gate: nothing dispatched
      assert.deepEqual(keys(pendingForRoutine(store, r.id)), ['stuck']);

      for (let i = 0; i < 20; i += 1) addRun(store, r, [browser(`ok-${i}`, 'click'), finished(`ok-${i}`)]);
      assert.deepEqual(pendingForRoutine(store, r.id), [], '20 newer dispatching runs fill the default window');
      assert.deepEqual(keys(pendingForRoutine(store, r.id, { window: 21 })), ['stuck']);
      assert.deepEqual(pendingForRoutine(store, r.id, { window: 21, excludeRunId: stuck.id }), []);
    } finally {
      store.close();
    }
  });

  it('ignores runs that are still queued or running, and scans crashed ones', () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'viral-life');
      const inFlight = addRun(store, r, [browser('in-flight', 'click')], { status: 'RUNNING' });
      assert.deepEqual(pendingForRoutine(store, r.id), []);
      store.finishTaskRun(inFlight.id, 'FAILED', 'Browser interaction outcome is uncertain. Inspect the page and action history; do not repeat the submission automatically.');
      assert.deepEqual(keys(pendingForRoutine(store, r.id)), ['in-flight']);
      const crashed = addRun(store, r, [attempted('p-crash')], { status: 'CRASHED' });
      const items = pendingForRoutine(store, r.id);
      assert.deepEqual(keys(items), ['p-crash', 'in-flight']);
      assert.equal(items[0].runId, crashed.id);
    } finally {
      store.close();
    }
  });

  it('returns nothing for a routine that does not exist', () => {
    const store = fixture();
    try {
      assert.deepEqual(pendingForRoutine(store, 'rtn-missing'), []);
    } finally {
      store.close();
    }
  });
});

describe('items of deleted routines', () => {
  it('lists them under the triggered name, filters them by origin and never holds a live routine', () => {
    const store = fixture();
    try {
      const gone = addRoutine(store, 'Milo life');
      const goneRun = addRun(store, gone, [browser('gone-click', 'click'), computer('gone-desktop')]);
      assert.equal(store.deleteRoutine(gone.id), true);
      const live = addRoutine(store, 'honest-tweet');

      const all = pendingOfDeletedRoutines(store, 'milo');
      assert.deepEqual(all.map((i) => [i.key, i.routineId, i.routineName, i.routineDeleted, i.runId]), [
        ['gone-click', gone.id, 'Milo life', true, goneRun.id],
        ['gone-desktop', gone.id, 'Milo life', true, goneRun.id],
      ]);
      assert.equal(all[1].detail, `Not started: run ${goneRun.id} at 2026-09-22 10:56 UTC acted on this bot's desktop and its result was never confirmed. Check the desktop, then choose “Checked — continue” on this routine.`);
      assert.deepEqual(keys(pendingOfDeletedRoutines(store, 'milo', X)), ['gone-click', 'gone-desktop']);
      assert.deepEqual(keys(pendingOfDeletedRoutines(store, 'milo', 'https://mastodon.example')), ['gone-desktop']);
      assert.deepEqual(pendingOfDeletedRoutines(store, 'other'), []);
      assert.deepEqual(pendingForRoutine(store, live.id), [], 'a deleted routine holds no other routine');
      assert.deepEqual(pendingForRoutine(store, gone.id), []);
    } finally {
      store.close();
    }
  });

  it('acknowledges the deleted-routine items shown on a routine: those on its policy origin, plus origin-less ones', () => {
    const store = fixture();
    try {
      const policy = new PublishPolicy(store, [xCreateTweet()]);
      const onX = addRoutine(store, 'viral-life');
      const elsewhere = addRoutine(store, 'mastodon-digest');
      const bare = addRoutine(store, 'read-only');
      policy.set('milo', onX.id, true);
      policy.noteAttempt({ agentId: 'milo', routineId: elsewhere.id, origin: 'https://mastodon.example', probe: 'mastodon/status', runId: 'run-mastodon' });
      assert.equal(policy.get(onX.id)?.origin, X);
      const gone = addRoutine(store, 'Milo life');
      addRun(store, gone, [browser('gone-click', 'click'), computer('gone-desktop')]);
      assert.equal(store.deleteRoutine(gone.id), true);
      addRun(store, onX, [browser('own-click', 'click')]);

      assert.equal(acknowledgeRoutine(store, 'milo', elsewhere.id), 1, 'another origin: only the origin-less desktop item');
      assert.deepEqual(keys(pendingOfDeletedRoutines(store, 'milo')), ['gone-click']);
      assert.equal(acknowledgeRoutine(store, 'milo', bare.id), 0, 'no policy row: origin-less items only, and none is left');
      assert.equal(acknowledgeRoutine(store, 'milo', onX.id), 2, 'its own click plus the x.com item of the deleted routine');
      assert.deepEqual(pendingForRoutine(store, onX.id), []);
      assert.deepEqual(pendingOfDeletedRoutines(store, 'milo'), []);
    } finally {
      store.close();
    }
  });
});

describe('acknowledgeRoutine', () => {
  it("appends EXTERNAL_ACTION_ACKNOWLEDGED (layer null) to the item's own run and never a FINISHED", () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'viral-life');
      const run = addRun(store, r, [browser('post-click', 'click'), attempted('p1', { actionId: 'post-click' })]);
      const seen = store.getTaskEvents(run.id).length;
      const at = CLICK_AT + 3_600_000;
      assert.equal(acknowledgeRoutine(store, 'milo', r.id, at), 2);
      const added = store.getTaskEvents(run.id).slice(seen);
      assert.deepEqual(added.map((e) => [e.event_type, e.layer, e.timestamp, JSON.parse(e.payload_json)]), [
        ['EXTERNAL_ACTION_ACKNOWLEDGED', null, at, { key: 'post-click', kind: 'action', by: 'operator', at }],
        ['EXTERNAL_ACTION_ACKNOWLEDGED', null, at, { key: 'p1', kind: 'publish', by: 'operator', at }],
      ]);
      assert.deepEqual(pendingForRoutine(store, r.id), []);
      assert.equal(acknowledgeRoutine(store, 'milo', r.id, at), 0);
      assert.throws(() => acknowledgeRoutine(store, 'other', r.id), /does not belong to this bot/);
      assert.throws(() => acknowledgeRoutine(store, 'milo', 'rtn-missing'), /does not belong to this bot/);
    } finally {
      store.close();
    }
  });
});

describe('recentPublishes', () => {
  it('collects every attempt of the bot within the window, rejected included, and none older', () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'honest-tweet');
      const theirs = addRoutine(store, 'their-routine', 'other');
      const now = CLICK_AT;
      addRun(store, r, [attempted('p-old', { textSha256: 'a'.repeat(64), inReplyTo: '111' })], { at: now - 8 * DAY });
      addRun(store, r, [attempted('p-rejected', { textSha256: 'b'.repeat(64), inReplyTo: '222' }), observed('p-rejected', 'rejected', { reason: 'code 187', errorCodes: [187] })], { at: now - 6 * DAY });
      addRun(store, r, [attempted('p-recent', { textSha256: 'c'.repeat(64), op: 'post' })], { at: now - 3_600_000 });
      addRun(store, theirs, [attempted('p-their-bot', { textSha256: 'd'.repeat(64), inReplyTo: '444' })], { at: now - 3_600_000 });
      const recent = recentPublishes(store, 'milo', now - 7 * DAY);
      assert.deepEqual([...recent.textHashes].sort(), ['b'.repeat(64), 'c'.repeat(64)]);
      assert.deepEqual([...recent.targets], ['222']);
    } finally {
      store.close();
    }
  });
});

describe('pendingMessage', () => {
  const item: PendingEffect = {
    runId: 'run-1790074518658-wveu4', routineId: 'rtn-viral', routineName: 'viral-life', routineDeleted: false,
    key: 'post-click', kind: 'action', action: 'click', transport: 'browser', origin: X, at: CLICK_AT, before: true, detail: '',
  };
  const desktopText = "Not started: run run-1790074518658-wveu4 at 2026-09-22 10:56 UTC acted on this bot's desktop and its result was never confirmed. Check the desktop, then choose “Checked — continue” on this routine.";

  it('renders the two fixed texts with the UTC minute and the origin host', () => {
    assert.equal(pendingMessage(item), 'Not started: run run-1790074518658-wveu4 at 2026-09-22 10:56 UTC submitted something on x.com whose result was never confirmed. Check the account, then choose “Checked — continue” on this routine.');
    const { origin: _origin, ...noOrigin } = item;
    assert.equal(pendingMessage({ ...noOrigin, transport: 'computer', action: 'type' }), desktopText);
    assert.equal(pendingMessage(noOrigin), desktopText, 'no origin gives the desktop text');
    assert.match(
      pendingMessage({ ...item, origin: 'http://127.0.0.1:4555', at: Date.UTC(2026, 0, 5, 7, 3, 59) }),
      /^Not started: run run-1790074518658-wveu4 at 2026-01-05 07:03 UTC submitted something on 127\.0\.0\.1:4555 whose result/,
    );
    assert.ok(pendingMessage(item).includes('“Checked — continue”'), 'curly quotes and an em dash');
  });
});

describe('runEvents', () => {
  it("returns the run's events as (event_type, payload_json, timestamp) in insertion order", () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'honest-tweet');
      const run = addRun(store, r, [browser('a1', 'click'), finished('a1')]);
      store.recordEvent({ task_run_id: run.id, agent_id: 'milo', event_type: 'LATE_NOTE', payload_json: '{}', timestamp: 1 });
      const events = runEvents(store, run.id);
      assert.deepEqual(events.map((e) => e.event_type), ['ROUTINE_TRIGGERED', 'TASK_STARTED', START, FINISH, 'TASK_FAILED', 'LATE_NOTE']);
      assert.deepEqual(Object.keys(events[2]).sort(), ['event_type', 'payload_json', 'timestamp']);
      assert.equal(events[2].timestamp, CLICK_AT);
      assert.equal(JSON.parse(events[2].payload_json!).actionId, 'a1');
      assert.deepEqual(runEvents(store, 'run-unknown'), []);
    } finally {
      store.close();
    }
  });
});

describe('publishSummary', () => {
  it('summarizes each run that sent a post and leaves out runs that sent none', () => {
    const store = fixture();
    try {
      const r = addRoutine(store, 'honest-tweet');
      const url = (id: string) => `${X}/example_account/status/${id}`;
      const confirmed = addRun(store, r, [attempted('p1'), observed('p1', 'confirmed', { postId: '101', postUrl: url('101') })]);
      const onPage = addRun(store, r, [attempted('p2'), observed('p2', 'unobserved', { reason: 'timeout' }), reconciled('p2', 'present', { postUrl: url('102') })]);
      const rejected = addRun(store, r, [attempted('p3'), observed('p3', 'rejected', { reason: 'code 187', errorCodes: [187] })]);
      const heldAfterOperator = addRun(store, r, [attempted('p4', { by: 'operator' }), refused('duplicate-text'), refused('budget')]);
      const mixed = addRun(store, r, [
        attempted('p5'), observed('p5', 'rejected', { reason: 'code 187' }),
        attempted('p6', { by: 'page' }), observed('p6', 'unobserved', { reason: 'no-response' }),
        refused('internal'), refused('duplicate-target'),
      ]);
      const byOperator = addRun(store, r, [attempted('p7'), observed('p7', 'rejected', { reason: 'code 187' }), attempted('p8', { by: 'operator' }), observed('p8', 'confirmed', { postId: '108', postUrl: url('108') })]);
      const mismatch = addRun(store, r, [attempted('p9', { by: 'flow' }), observed('p9', 'rejected', { reason: 'code 187' }), refused('internal'), refused('expected-mismatch')]);
      const internalOnly = addRun(store, r, [attempted('p10'), refused('internal')]);
      const notFound = addRun(store, r, [attempted('p11'), observed('p11', 'unobserved', { reason: 'timeout' }), reconciled('p11', 'not-found')]);
      const refusedOnly = addRun(store, r, [refused('duplicate-target')]);
      const quiet = addRun(store, r, [browser('a1', 'click'), finished('a1')]);
      const all = [confirmed, onPage, rejected, heldAfterOperator, mixed, byOperator, mismatch, internalOnly, notFound, refusedOnly, quiet];
      const summary = publishSummary(store, [...all.map((run) => run.id), 'run-unknown']);

      assert.deepEqual(summary.get(confirmed.id), { state: 'confirmed', by: 'model', postUrl: url('101'), heldBack: null });
      assert.deepEqual(summary.get(onPage.id), { state: 'confirmed-page', by: 'model', postUrl: url('102'), heldBack: null });
      assert.deepEqual(summary.get(rejected.id), { state: 'rejected', by: 'model', heldBack: null });
      assert.deepEqual(summary.get(heldAfterOperator.id), { state: 'unconfirmed', by: 'operator', heldBack: 'budget' });
      assert.deepEqual(summary.get(mixed.id), { state: 'unconfirmed', by: 'page', heldBack: 'duplicate' });
      assert.deepEqual(summary.get(byOperator.id), { state: 'confirmed', by: 'operator', postUrl: url('108'), heldBack: null });
      assert.deepEqual(summary.get(mismatch.id), { state: 'rejected', by: 'flow', heldBack: 'mismatch' });
      assert.deepEqual(summary.get(internalOnly.id), { state: 'unconfirmed', by: 'model', heldBack: 'internal' });
      assert.deepEqual(summary.get(notFound.id), { state: 'unconfirmed', by: 'model', heldBack: null });
      assert.deepEqual(
        [...summary.keys()].sort(),
        [confirmed, onPage, rejected, heldAfterOperator, mixed, byOperator, mismatch, internalOnly, notFound].map((run) => run.id).sort(),
        'runs without PUBLISH_ATTEMPTED, and unknown ids, are absent',
      );
    } finally {
      store.close();
    }
  });
});
