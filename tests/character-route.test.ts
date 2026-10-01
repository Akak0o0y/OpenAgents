import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CharacterJournal } from '../src/daemon/character-journal.js';
import {
  CharacterAdmissions,
  CHARACTER_REFUSED_NOTE,
  exactSha256,
} from '../src/daemon/character-admission.js';
import {
  PublishWatch,
  publishRouteDecision,
  type PublishRequest,
  type RunPolicy,
} from '../src/daemon/browser-publish.js';
import { textSha256, xCreateTweet, type PublishProbe } from '../src/daemon/publish-probes.js';
import { publishNote, publishObservation } from '../src/daemon/work-runtime.js';
import { publishSummary } from '../src/daemon/external-effects.js';
import { layerForEvent } from '../src/kernel/agent-layers.js';

const ORIGIN = 'https://publish-fixture.invalid';
const PROBE_ID = 'fixture/publish';

const fixtureProbe: PublishProbe = {
  id: PROBE_ID,
  origins: [ORIGIN],
  notCreatedCodes: new Set([1]),
  account: { role: 'link', name: 'Profile' },
  match(req: { method: string; url: URL; postData: string | null }) {
    if (req.method !== 'POST' || req.url.origin !== ORIGIN || req.url.pathname !== '/publish') return null;
    const parsed = JSON.parse(req.postData ?? '{}') as { text?: string; replyTo?: string };
    return { probe: PROBE_ID, op: parsed.replyTo ? 'reply' : 'post', text: parsed.text, ...(parsed.replyTo ? { inReplyTo: parsed.replyTo } : {}) };
  },
  classify(res: { status: number; body: Buffer | null }) {
    const json = res.body && res.body.length ? JSON.parse(res.body.toString('utf8')) as { id?: string; refused?: boolean } : null;
    if (res.status === 200 && json?.id) return { outcome: 'confirmed', postId: json.id, shape: ['id'] };
    if (json?.refused) return { outcome: 'rejected', reason: 'code 1', errorCodes: [1], shape: ['refused'] };
    return { outcome: 'unobserved', reason: json ? 'no-id' : 'empty-body', errorCodes: [], shape: [] };
  },
  postPath: (account: string, postId: string) => `/${account}/status/${postId}`,
  profilePaths: (account: string) => [`/${account}`],
};

const publish = (text: string, replyTo?: string): PublishRequest =>
  ({ method: 'POST', url: new URL(`${ORIGIN}/publish?session=QUERY_MARKER`), postData: JSON.stringify({ text, ...(replyTo ? { replyTo } : {}) }) });

function createHarness(opts?: {
  version?: number;
  mode?: 'off' | 'voice' | 'character';
  now?: () => number;
}) {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'bot-1', name: 'Milo', model_id: 'gpt-4o', current_status: 'IDLE', budget_cap_usd: 10 });
  const journal = new CharacterJournal({ store, now: opts?.now });
  let currentVersion = opts?.version ?? 1;
  let currentMode: 'off' | 'voice' | 'character' = opts?.mode ?? 'character';

  const admissions = new CharacterAdmissions({
    store,
    journal,
    now: opts?.now,
    activeVersion: () => ({ version: currentVersion, mode: currentMode }),
  });

  return {
    store,
    journal,
    admissions,
    setVersion: (v: number) => { currentVersion = v; },
    setMode: (m: 'off' | 'voice' | 'character') => { currentMode = m; },
  };
}

function issueAdmittedUtterance(
  h: ReturnType<typeof createHarness>,
  input: {
    runId: string;
    agentId?: string;
    op: 'post' | 'reply';
    replyTo?: string | null;
    text: string;
    version?: number;
  }
) {
  const agentId = input.agentId ?? 'bot-1';
  const version = input.version ?? 1;
  const utt = h.journal.createUtterance({
    agentId,
    runId: input.runId,
    op: input.op,
    replyTo: input.replyTo ?? null,
    version,
  });

  const cand = h.journal.recordCandidate({
    agentId,
    utteranceId: utt.id,
    attempt: 1,
    text: input.text,
    exactSha256: exactSha256(input.text),
    textSha256: textSha256(input.text),
    version,
    selection: {},
    evidence: [],
    rules: { hardFailed: false, hard: [], advisory: [] },
  });

  h.journal.admit(utt.id, cand.id, 'passed');

  const adm = h.admissions.issue({
    runId: input.runId,
    agentId,
    utteranceId: utt.id,
    candidateId: cand.id,
    op: input.op,
    replyTo: input.replyTo ?? null,
    text: input.text,
    version,
  });

  return { utt, cand, adm };
}

test('an admitted exact text is tracked and its utterance is attempted with the request\'s own text', () => {
  const h = createHarness();
  const text = 'Hello exact world';
  const { utt, adm } = issueAdmittedUtterance(h, { runId: 'run-1', op: 'post', text });

  const events: Array<{ type: string; payload: any }> = [];
  const gate = h.admissions.gateFor('run-1', 'bot-1');
  const policy: RunPolicy = { character: { requireAdmission: true, gate } };
  const emit = (type: string, payload: unknown) => {
    events.push({ type, payload });
  };

  const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
  watch.beginAction('act-1', 'model', 'click', Date.now());

  const req = publish(text);
  const decision = publishRouteDecision({ watch, probes: [fixtureProbe], req, emit });

  assert.equal(decision.kind, 'track');
  const attemptedEvents = events.filter(e => e.type === 'PUBLISH_ATTEMPTED');
  assert.equal(attemptedEvents.length, 1);
  const attempted = attemptedEvents[0].payload;
  assert.equal(attempted.textSha256, textSha256(text));

  const uttRow = h.journal.get('bot-1', utt.id)!;
  assert.equal(uttRow.status, 'attempted');
  assert.equal(uttRow.publishId, attempted.publishId);
  assert.equal(uttRow.text, text);
  assert.equal(uttRow.textSha256, attempted.textSha256);
  assert.equal(h.admissions.inspect(adm.id)?.state, 'consumed');

  // Also run against the real xCreateTweet probe (assumed X shape)
  const xProbe = xCreateTweet([ORIGIN]);
  const xText = 'Tweet on X with real probe';
  const xUtterance = issueAdmittedUtterance(h, { runId: 'run-x', op: 'post', text: xText });

  const xEvents: Array<{ type: string; payload: any }> = [];
  const xGate = h.admissions.gateFor('run-x', 'bot-1');
  const xPolicy: RunPolicy = { character: { requireAdmission: true, gate: xGate } };
  const xEmit = (type: string, payload: unknown) => xEvents.push({ type, payload });

  const xWatch = new PublishWatch({ probes: [xProbe], policy: xPolicy, emit: xEmit });
  xWatch.beginAction('act-x', 'model', 'click', Date.now());

  const xReq: PublishRequest = {
    method: 'POST',
    url: new URL(`${ORIGIN}/i/api/graphql/q1/CreateTweet`),
    postData: JSON.stringify({ variables: { tweet_text: xText } }),
  };

  const xDecision = publishRouteDecision({ watch: xWatch, probes: [xProbe], req: xReq, emit: xEmit });
  assert.equal(xDecision.kind, 'track');
  const xAttempted = xEvents.find(e => e.type === 'PUBLISH_ATTEMPTED')!.payload;
  const xUttRow = h.journal.get('bot-1', xUtterance.utt.id)!;
  assert.equal(xUttRow.status, 'attempted');
  assert.equal(xUttRow.publishId, xAttempted.publishId);
  assert.equal(xUttRow.text, xText);
  assert.equal(h.admissions.inspect(xUtterance.adm.id)?.state, 'consumed');
});

test('P2-B1: reserve, one transaction, then consume, with no await before continue', () => {
  const h = createHarness();
  const text = 'Transaction check text';
  const { utt, adm } = issueAdmittedUtterance(h, { runId: 'run-1', op: 'post', text });

  let emitSawConsuming = false;
  let emitSawInTransaction = false;
  let emitSawOutsideAttempted = true;

  const gate = h.admissions.gateFor('run-1', 'bot-1');
  const policy: RunPolicy = { character: { requireAdmission: true, gate } };
  const emit = (type: string, _payload: unknown) => {
    if (type === 'PUBLISH_ATTEMPTED') {
      const live = h.admissions.inspect(adm.id);
      emitSawConsuming = live?.state === 'consuming';
      const db = h.store.getDatabase();
      emitSawInTransaction = db.isTransaction;
      const inTxUtt = h.journal.get('bot-1', utt.id);
      emitSawOutsideAttempted = inTxUtt?.status !== 'attempted';
    }
  };

  const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
  watch.beginAction('act-1', 'model', 'click', Date.now());

  const decision = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish(text), emit });

  assert.ok(!(decision instanceof Promise), 'publishRouteDecision must return synchronously');
  assert.equal(decision.kind, 'track');
  assert.ok(emitSawConsuming, 'Admission state was consuming during emit');
  assert.ok(emitSawInTransaction, 'Database is inside transaction during commitAttempt');
  assert.ok(emitSawOutsideAttempted, 'Utterance status not yet attempted from outside at moment of emit');
  assert.equal(h.admissions.inspect(adm.id)?.state, 'consumed');
  assert.equal(h.journal.get('bot-1', utt.id)?.status, 'attempted');
});

test('a forced SQL failure leaves the admission invalid, the request aborted and no PUBLISH_ATTEMPTED', () => {
  // Case 1: journal.markAttempted throws
  {
    const h = createHarness();
    const text = 'Forced SQL error text';
    const { utt, adm } = issueAdmittedUtterance(h, { runId: 'run-1', op: 'post', text });

    const originalMarkAttempted = h.journal.markAttempted.bind(h.journal);
    h.journal.markAttempted = () => {
      throw new Error('Forced SQLite disk failure');
    };

    const events: Array<{ type: string; payload: any }> = [];
    const gate = h.admissions.gateFor('run-1', 'bot-1');
    const policy: RunPolicy = { character: { requireAdmission: true, gate } };
    const emit = (type: string, payload: unknown) => {
      h.store.recordEvent({
        task_run_id: 'run-1',
        agent_id: 'bot-1',
        event_type: type,
        payload_json: JSON.stringify(payload),
        timestamp: Date.now(),
      });
      events.push({ type, payload });
    };

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.beginAction('act-1', 'model', 'click', Date.now());

    const decision = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish(text), emit });

    assert.equal(decision.kind, 'abort');
    if (decision.kind === 'abort') {
      assert.equal(decision.refusal?.reason, 'internal');
    }

    // Database row was rolled back with the transaction
    const dbRows = h.store.getDatabase().prepare("SELECT * FROM execution_events WHERE task_run_id = 'run-1' AND event_type = 'PUBLISH_ATTEMPTED'").all();
    assert.equal(dbRows.length, 0);
    // Watch has dropped the record
    assert.equal(watch.all().length, 0);

    assert.equal(h.admissions.inspect(adm.id)?.state, 'invalid');
    assert.equal(h.admissions.inspect(adm.id)?.invalidReason, 'attempt-write-failed');
    assert.equal(h.journal.get('bot-1', utt.id)?.status, 'refused');
    assert.equal(h.journal.get('bot-1', utt.id)?.statusReason, 'attempt-write-failed');

    h.journal.markAttempted = originalMarkAttempted;
  }

  // Case 2: emit throws
  {
    const h = createHarness();
    const text = 'Forced emit error text';
    const { utt: _utt, adm } = issueAdmittedUtterance(h, { runId: 'run-2', op: 'post', text });

    const gate = h.admissions.gateFor('run-2', 'bot-1');
    const policy: RunPolicy = { character: { requireAdmission: true, gate } };
    let attemptedEmitted = false;
    const emit = (type: string, payload: unknown) => {
      if (type === 'PUBLISH_ATTEMPTED') {
        attemptedEmitted = true;
        throw new Error('Forced emit error');
      }
      h.store.recordEvent({
        task_run_id: 'run-2',
        agent_id: 'bot-1',
        event_type: type,
        payload_json: JSON.stringify(payload),
        timestamp: Date.now(),
      });
    };

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.beginAction('act-2', 'model', 'click', Date.now());

    const decision = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish(text), emit });
    assert.ok(attemptedEmitted);
    assert.equal(decision.kind, 'abort');
    if (decision.kind === 'abort') {
      assert.equal(decision.refusal?.reason, 'internal');
    }

    const dbRows = h.store.getDatabase().prepare("SELECT * FROM execution_events WHERE task_run_id = 'run-2' AND event_type = 'PUBLISH_ATTEMPTED'").all();
    assert.equal(dbRows.length, 0);
    assert.equal(watch.all().length, 0);

    assert.equal(h.admissions.inspect(adm.id)?.state, 'invalid');
    assert.equal(h.admissions.inspect(adm.id)?.invalidReason, 'attempt-write-failed');
  }
});

test('every section 17.4 change is refused before dispatch with no attempt row', () => {
  const baseText = 'Standard approved post';

  const cases: Array<{
    name: string;
    setup: (h: ReturnType<typeof createHarness>, adm: ReturnType<typeof issueAdmittedUtterance>['adm']) => {
      req: PublishRequest;
      expectedDigestMatch: boolean;
    };
  }> = [
    {
      name: 'one character changed',
      setup: () => ({ req: publish('Standard approved post!'), expectedDigestMatch: false }),
    },
    {
      name: 'a space changed to a newline',
      setup: () => ({ req: publish('Standard\napproved post'), expectedDigestMatch: false }),
    },
    {
      name: 'a changed inReplyTo',
      setup: () => ({ req: publish(baseText, '2102311999999999999'), expectedDigestMatch: true }),
    },
    {
      name: 'a changed op',
      setup: () => ({ req: publish(baseText, '2102311000000000001'), expectedDigestMatch: true }),
    },
    {
      name: 'expired',
      setup: () => ({ req: publish(baseText), expectedDigestMatch: true }),
    },
    {
      name: 'already consumed',
      setup: (_h, adm) => {
        (adm as any).state = 'consumed';
        return { req: publish(baseText), expectedDigestMatch: true };
      },
    },
    {
      name: 'a new version',
      setup: (h) => {
        h.setVersion(2);
        return { req: publish(baseText), expectedDigestMatch: true };
      },
    },
    {
      name: 'a disabled character',
      setup: (h) => {
        h.setMode('off');
        return { req: publish(baseText), expectedDigestMatch: true };
      },
    },
    {
      name: 'takeover',
      setup: () => ({ req: publish(baseText), expectedDigestMatch: true }),
    },
    {
      name: 'cancellation',
      setup: (h) => {
        h.admissions.invalidateRun('run-c', 'cancelled');
        return { req: publish(baseText), expectedDigestMatch: true };
      },
    },
    {
      name: 'restart (a new admissions instance)',
      setup: (h) => {
        h.admissions = new CharacterAdmissions({
          store: h.store,
          journal: h.journal,
          activeVersion: () => ({ version: 1, mode: 'character' }),
        });
        return { req: publish(baseText), expectedDigestMatch: false };
      },
    },
    {
      name: 'look-alike Unicode (Cyrillic e instead of Latin e)',
      setup: () => ({ req: publish('Standard approvеd post'), expectedDigestMatch: false }),
    },
  ];

  for (const c of cases) {
    let nowTime = 1_000_000;
    const h = createHarness({ now: () => nowTime });
    const { utt, adm } = issueAdmittedUtterance(h, { runId: 'run-c', op: 'post', text: baseText });

    if (c.name === 'expired') {
      nowTime = adm.expiresAt + 1000;
    }

    const { req, expectedDigestMatch } = c.setup(h, adm);

    const gate = h.admissions.gateFor('run-c', 'bot-1');
    if (c.name === 'takeover') {
      gate.invalidate('takeover');
    }

    const events: Array<{ type: string; payload: any }> = [];
    const policy: RunPolicy = { character: { requireAdmission: true, gate } };
    const emit = (type: string, payload: unknown) => events.push({ type, payload });

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit, now: () => nowTime });
    watch.beginAction('act-c', 'model', 'click', nowTime);

    const decision = publishRouteDecision({ watch, probes: [fixtureProbe], req, emit });

    assert.equal(decision.kind, 'abort', `${c.name}: decision must be abort`);
    if (decision.kind === 'abort') {
      assert.equal(decision.refusal?.reason, 'character-unadmitted', `${c.name}: reason must be character-unadmitted`);
    }

    assert.equal(events.some(e => e.type === 'PUBLISH_ATTEMPTED'), false, `${c.name}: no PUBLISH_ATTEMPTED`);
    const pubRefused = events.find(e => e.type === 'PUBLISH_REFUSED');
    assert.ok(pubRefused, `${c.name}: must emit PUBLISH_REFUSED`);
    assert.equal(pubRefused.payload.reason, 'character-unadmitted');

    const charRefused = events.find(e => e.type === 'CHARACTER_REFUSED');
    assert.ok(charRefused, `${c.name}: must emit CHARACTER_REFUSED`);
    assert.equal(charRefused.payload.reason, 'character-unadmitted');
    assert.equal(charRefused.payload.textSha256, textSha256(JSON.parse(req.postData!).text));
    if (expectedDigestMatch) {
      assert.equal(charRefused.payload.utteranceId, utt.id, `${c.name}: utteranceId must match on digest hit`);
    } else {
      assert.equal(charRefused.payload.utteranceId, undefined, `${c.name}: utteranceId must be undefined on digest miss`);
    }

    assert.notEqual(h.journal.get('bot-1', utt.id)?.status, 'attempted', `${c.name}: utterance must not be attempted`);
  }
});

test('echo-only requests are refused as character-unverifiable', () => {
  // Case A: Noted fill echoed by click on unprobed route
  {
    const h = createHarness();
    issueAdmittedUtterance(h, { runId: 'run-1', op: 'post', text: 'Echoed text' });

    const events: Array<{ type: string; payload: any }> = [];
    const gate = h.admissions.gateFor('run-1', 'bot-1');
    const policy: RunPolicy = { character: { requireAdmission: true, gate } };
    const emit = (type: string, payload: unknown) => events.push({ type, payload });

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.noteFill('Echoed fill content');
    watch.beginAction('act-echo', 'model', 'click', Date.now());

    const req: PublishRequest = {
      method: 'POST',
      url: new URL(`${ORIGIN}/unprobed/submit`),
      postData: 'unprobed body with Echoed fill content inside',
    };

    const decision = publishRouteDecision({ watch, probes: [fixtureProbe], req, emit });
    assert.equal(decision.kind, 'abort');
    if (decision.kind === 'abort') {
      assert.equal(decision.refusal?.reason, 'character-unverifiable');
    }
    const charRefused = events.find(e => e.type === 'CHARACTER_REFUSED');
    assert.ok(charRefused);
    assert.equal(charRefused.payload.reason, 'character-unverifiable');
  }

  // Case B: Probed request with empty text
  {
    const h = createHarness();
    issueAdmittedUtterance(h, { runId: 'run-2', op: 'post', text: 'Some text' });

    const events: Array<{ type: string; payload: any }> = [];
    const gate = h.admissions.gateFor('run-2', 'bot-1');
    const policy: RunPolicy = { character: { requireAdmission: true, gate } };
    const emit = (type: string, payload: unknown) => events.push({ type, payload });

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.beginAction('act-empty', 'model', 'click', Date.now());

    const req = publish('   ');
    const decision = publishRouteDecision({ watch, probes: [fixtureProbe], req, emit });
    assert.equal(decision.kind, 'abort');
    if (decision.kind === 'abort') {
      assert.equal(decision.refusal?.reason, 'character-unverifiable');
    }
    const charRefused = events.find(e => e.type === 'CHARACTER_REFUSED');
    assert.ok(charRefused);
    assert.equal(charRefused.payload.reason, 'character-unverifiable');
  }
});

test('Stage 1 refusals keep their order and emit no CHARACTER_REFUSED', () => {
  // Budget refusal
  {
    const h = createHarness();
    issueAdmittedUtterance(h, { runId: 'run-1', op: 'post', text: 'Text 1' });

    const events: Array<{ type: string; payload: any }> = [];
    const gate = h.admissions.gateFor('run-1', 'bot-1');
    const policy: RunPolicy = { publishLimit: 1, character: { requireAdmission: true, gate } };
    const emit = (type: string, payload: unknown) => events.push({ type, payload });

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.beginAction('act-1', 'model', 'click', Date.now());

    const dec1 = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish('Text 1'), emit });
    assert.equal(dec1.kind, 'track');

    // Issue Text 2 for run-1 - it is now live
    const { adm: adm2 } = issueAdmittedUtterance(h, { runId: 'run-1', op: 'post', text: 'Text 2' });

    watch.beginAction('act-2', 'model', 'click', Date.now());
    const dec2 = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish('Text 2'), emit });
    assert.equal(dec2.kind, 'abort');
    if (dec2.kind === 'abort') {
      assert.equal(dec2.refusal?.reason, 'budget');
    }

    const pubRefused = events.filter(e => e.type === 'PUBLISH_REFUSED');
    assert.equal(pubRefused.length, 1);
    assert.equal(pubRefused[0].payload.reason, 'budget');
    assert.equal(events.some(e => e.type === 'CHARACTER_REFUSED'), false);
    assert.equal(h.admissions.inspect(adm2.id)?.state, 'live');
  }

  // Duplicate text refusal
  {
    const h = createHarness();
    const text = 'Duplicate post text';
    const { adm } = issueAdmittedUtterance(h, { runId: 'run-2', op: 'post', text });

    const events: Array<{ type: string; payload: any }> = [];
    const gate = h.admissions.gateFor('run-2', 'bot-1');
    const policy: RunPolicy = {
      publishLimit: 1,
      recent: { textHashes: new Set([textSha256(text)]), targets: new Set() },
      character: { requireAdmission: true, gate },
    };
    const emit = (type: string, payload: unknown) => events.push({ type, payload });

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.beginAction('act-dup', 'model', 'click', Date.now());

    const dec = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish(text), emit });
    assert.equal(dec.kind, 'abort');
    if (dec.kind === 'abort') {
      assert.equal(dec.refusal?.reason, 'duplicate-text');
    }

    assert.equal(events.some(e => e.type === 'CHARACTER_REFUSED'), false);
    assert.equal(h.admissions.inspect(adm.id)?.state, 'live');
  }

  // Duplicate target refusal
  {
    const h = createHarness();
    const targetUrl = 'https://x.com/status/123';
    const { adm } = issueAdmittedUtterance(h, { runId: 'run-3', op: 'reply', replyTo: targetUrl, text: 'Reply text' });

    const events: Array<{ type: string; payload: any }> = [];
    const gate = h.admissions.gateFor('run-3', 'bot-1');
    const policy: RunPolicy = {
      publishLimit: 1,
      recent: { textHashes: new Set(), targets: new Set([targetUrl]) },
      character: { requireAdmission: true, gate },
    };
    const emit = (type: string, payload: unknown) => events.push({ type, payload });

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.beginAction('act-tgt', 'model', 'click', Date.now());

    const req = publish('Reply text', targetUrl);
    const dec = publishRouteDecision({ watch, probes: [fixtureProbe], req, emit });
    assert.equal(dec.kind, 'abort');
    if (dec.kind === 'abort') {
      assert.equal(dec.refusal?.reason, 'duplicate-target');
    }

    assert.equal(events.some(e => e.type === 'CHARACTER_REFUSED'), false);
    assert.equal(h.admissions.inspect(adm.id)?.state, 'live');
  }
});

test('operator input and unknown request shapes keep Stage 1 behaviour', () => {
  const h = createHarness();
  const text = 'Operator text without admission';

  const events: Array<{ type: string; payload: any }> = [];
  const gate = h.admissions.gateFor('run-1', 'bot-1');
  const policy: RunPolicy = { character: { requireAdmission: true, gate } };
  const emit = (type: string, payload: unknown) => events.push({ type, payload });

  const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
  watch.noteOperatorInput(Date.now());

  const decOp = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish(text), emit });
  assert.equal(decOp.kind, 'track');
  assert.equal(events.some(e => e.type === 'CHARACTER_REFUSED'), false);

  const reqNonProbe: PublishRequest = {
    method: 'POST',
    url: new URL(`${ORIGIN}/other/path`),
    postData: 'random body',
  };
  const decNonProbe = publishRouteDecision({ watch, probes: [fixtureProbe], req: reqNonProbe, emit });
  assert.equal(decNonProbe.kind, 'continue');

  const reqGet: PublishRequest = {
    method: 'GET',
    url: new URL(`${ORIGIN}/publish`),
    postData: null,
  };
  const decGet = publishRouteDecision({ watch, probes: [fixtureProbe], req: reqGet, emit });
  assert.equal(decGet.kind, 'continue');

  const reqOtherOrigin: PublishRequest = {
    method: 'POST',
    url: new URL('https://other-origin.invalid/publish'),
    postData: 'some data',
  };
  const decOther = publishRouteDecision({ watch, probes: [fixtureProbe], req: reqOtherOrigin, emit });
  assert.equal(decOther.kind, 'continue');
});

test('owner-chat and mission policies link a match and never refuse a miss', () => {
  // Matching admission links and commits attempt
  {
    const h = createHarness();
    const text = 'Optional admission matching text';
    const { utt, adm } = issueAdmittedUtterance(h, { runId: 'run-match', op: 'post', text });

    const events: Array<{ type: string; payload: any }> = [];
    const gate = h.admissions.gateFor('run-match', 'bot-1');
    const policy: RunPolicy = { character: { requireAdmission: false, gate } };
    const emit = (type: string, payload: unknown) => events.push({ type, payload });

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.beginAction('act-match', 'model', 'click', Date.now());

    const dec = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish(text), emit });
    assert.equal(dec.kind, 'track');
    assert.equal(h.journal.get('bot-1', utt.id)?.status, 'attempted');
    assert.equal(h.admissions.inspect(adm.id)?.state, 'consumed');
    assert.equal(events.some(e => e.type === 'CHARACTER_REFUSED'), false);
  }

  // Non-matching text tracks without utterance and without CHARACTER_REFUSED
  {
    const h = createHarness();
    const events: Array<{ type: string; payload: any }> = [];
    const gate = h.admissions.gateFor('run-miss', 'bot-1');
    const policy: RunPolicy = { character: { requireAdmission: false, gate } };
    const emit = (type: string, payload: unknown) => events.push({ type, payload });

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.beginAction('act-miss', 'model', 'click', Date.now());

    const dec = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish('Unadmitted text'), emit });
    assert.equal(dec.kind, 'track');
    assert.equal(events.some(e => e.type === 'CHARACTER_REFUSED'), false);
    assert.equal(events.filter(e => e.type === 'PUBLISH_ATTEMPTED').length, 1);
  }

  // Unverifiable text tracks without utterance and without CHARACTER_REFUSED
  {
    const h = createHarness();
    const events: Array<{ type: string; payload: any }> = [];
    const gate = h.admissions.gateFor('run-unverifiable', 'bot-1');
    const policy: RunPolicy = { character: { requireAdmission: false, gate } };
    const emit = (type: string, payload: unknown) => events.push({ type, payload });

    const watch = new PublishWatch({ probes: [fixtureProbe], policy, emit });
    watch.beginAction('act-unv', 'model', 'click', Date.now());

    const dec = publishRouteDecision({ watch, probes: [fixtureProbe], req: publish('   '), emit });
    assert.equal(dec.kind, 'track');
    assert.equal(events.some(e => e.type === 'CHARACTER_REFUSED'), false);
  }
});

// Live on 2026-10-01: refused clicks came back as status "ok" with a plain click summary, the note on the side,
// and the model clicked Post twice more. A refusal is the click's result, not a footnote to it.
test('a refused post is the headline of the click result, never an ok click', () => {
  assert.deepEqual(publishObservation({ state: 'refused', reason: 'character-unadmitted' }), { status: 'warning', summary: CHARACTER_REFUSED_NOTE });
  const mismatch = publishObservation({ state: 'refused', reason: 'expected-mismatch' });
  assert.equal(mismatch.status, 'warning');
  assert.match(String(mismatch.summary), /Nothing was sent/);
  assert.deepEqual(publishObservation({ state: 'confirmed', postUrl: 'https://x.com/milo/status/1' }), {});
  assert.deepEqual(publishObservation(undefined), {});
});

test('the refusal note and held-back summary name the character reasons', () => {
  assert.equal(
    publishNote({ state: 'refused', reason: 'character-unadmitted' }),
    CHARACTER_REFUSED_NOTE
  );
  assert.equal(
    publishNote({ state: 'refused', reason: 'character-unverifiable' }),
    CHARACTER_REFUSED_NOTE
  );

  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'bot-1', name: 'Milo', model_id: 'gpt-4o', current_status: 'IDLE', budget_cap_usd: 10 });
  const now = Date.now();
  const routine = store.createRoutine({
    agentId: 'bot-1',
    name: 'Test Routine',
    cronExpression: '0 0 * * *',
    promptTemplate: 'Run',
    nextRunAt: now + 1000,
  });

  const run1 = store.createTaskRun({ routineId: routine.id, agentId: 'bot-1', taskName: 'routine-1' });
  store.recordEvent({ task_run_id: run1.id, agent_id: 'bot-1', event_type: 'PUBLISH_ATTEMPTED', payload_json: JSON.stringify({ publishId: 'pub-1', by: 'model' }), timestamp: now });
  store.recordEvent({ task_run_id: run1.id, agent_id: 'bot-1', event_type: 'PUBLISH_REFUSED', payload_json: JSON.stringify({ reason: 'character-unadmitted' }), timestamp: now + 1 });

  const run2 = store.createTaskRun({ routineId: routine.id, agentId: 'bot-1', taskName: 'routine-2' });
  store.recordEvent({ task_run_id: run2.id, agent_id: 'bot-1', event_type: 'PUBLISH_ATTEMPTED', payload_json: JSON.stringify({ publishId: 'pub-2', by: 'model' }), timestamp: now });
  store.recordEvent({ task_run_id: run2.id, agent_id: 'bot-1', event_type: 'PUBLISH_REFUSED', payload_json: JSON.stringify({ reason: 'internal' }), timestamp: now + 1 });
  store.recordEvent({ task_run_id: run2.id, agent_id: 'bot-1', event_type: 'PUBLISH_REFUSED', payload_json: JSON.stringify({ reason: 'character-unadmitted' }), timestamp: now + 2 });

  const run3 = store.createTaskRun({ routineId: routine.id, agentId: 'bot-1', taskName: 'routine-3' });
  store.recordEvent({ task_run_id: run3.id, agent_id: 'bot-1', event_type: 'PUBLISH_ATTEMPTED', payload_json: JSON.stringify({ publishId: 'pub-3', by: 'model' }), timestamp: now });
  store.recordEvent({ task_run_id: run3.id, agent_id: 'bot-1', event_type: 'PUBLISH_REFUSED', payload_json: JSON.stringify({ reason: 'expected-mismatch' }), timestamp: now + 1 });
  store.recordEvent({ task_run_id: run3.id, agent_id: 'bot-1', event_type: 'PUBLISH_REFUSED', payload_json: JSON.stringify({ reason: 'character-unadmitted' }), timestamp: now + 2 });

  const summary = publishSummary(store, [run1.id, run2.id, run3.id]);
  assert.equal(summary.get(run1.id)?.heldBack, 'character');
  assert.equal(summary.get(run2.id)?.heldBack, 'character');
  assert.equal(summary.get(run3.id)?.heldBack, 'mismatch');

  assert.equal(layerForEvent('CHARACTER_REFUSED'), null);
});
