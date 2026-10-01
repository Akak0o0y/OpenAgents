import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CharacterJournal } from '../src/daemon/character-journal.js';
import { CharacterStore } from '../src/daemon/character-store.js';
import {
  CharacterAdmissions,
  exactSha256,
  ADMISSION_TTL_MS,
  CHARACTER_REFUSED_NOTE,
  type CharacterAdmission,
} from '../src/daemon/character-admission.js';
import { textSha256 } from '../src/daemon/publish-probes.js';
import { createDefaultCharacterDocument, createDefaultCharacterSettings } from '../src/daemon/character-schema.js';

test('the exact digest canonicalises only NFC CRLF and outer whitespace', () => {
  // NFC and NFD are equal
  const nfc = 'café'.normalize('NFC');
  const nfd = 'café'.normalize('NFD');
  assert.equal(exactSha256(nfc), exactSha256(nfd));

  // CRLF and LF are equal
  assert.equal(exactSha256('line1\r\nline2'), exactSha256('line1\nline2'));

  // A lone CR differs
  assert.notEqual(exactSha256('line1\rline2'), exactSha256('line1\nline2'));

  // Outer spaces, tabs and NBSP are trimmed
  const padded = ' \t\u00A0Hello world\u00A0\t \n';
  assert.equal(exactSha256(padded), exactSha256('Hello world'));

  // An interior space and a newline differ
  assert.notEqual(exactSha256('a b'), exactSha256('a\nb'));

  // Cyrillic "е" (U+0435) and Latin "e" (U+0065) differ
  assert.notEqual(exactSha256('\u0435'), exactSha256('e'));

  // Full-width "Ａ" (U+FF21) and "A" (U+0041) differ in NFC
  assert.notEqual(exactSha256('\uFF21'), exactSha256('A'));

  // Stage 1's textSha256 still collides for "a b" and "a\nb", proving independence
  assert.equal(textSha256('a b'), textSha256('a\nb'));
  assert.notEqual(exactSha256('a b'), exactSha256('a\nb'));
});

function recordTestCandidate(
  journal: CharacterJournal,
  params: {
    agentId: string;
    utteranceId: string;
    attempt: number;
    text: string;
    version: number;
  }
) {
  return journal.recordCandidate({
    agentId: params.agentId,
    utteranceId: params.utteranceId,
    attempt: params.attempt,
    text: params.text,
    exactSha256: exactSha256(params.text),
    textSha256: textSha256(params.text),
    version: params.version,
    selection: {},
    evidence: [],
    rules: { hardFailed: false, hard: [], advisory: [] },
  });
}

function createTestHarness(initialNow = 1_000_000) {
  let currentTime = initialNow;
  const store = new AgentStore(':memory:');
  const db = store.getDatabase();
  const journal = new CharacterJournal({ store, now: () => currentTime });

  // Create test agent
  store.createAgent({
    id: 'bot-1',
    name: 'Milo',
    model_id: 'gpt-4o',
    current_status: 'IDLE',
    budget_cap_usd: 10,
  });

  const scheduledTimers = new Map<number, () => void>();
  let nextTimerId = 1;

  const timers = {
    set(fn: () => void, ms: number) {
      const id = nextTimerId++;
      scheduledTimers.set(id, fn);
      return id;
    },
    clear(handle: unknown) {
      if (typeof handle === 'number') {
        scheduledTimers.delete(handle);
      }
    },
  };

  let activeMode: 'off' | 'voice' | 'character' = 'character';
  let activeVersion = 1;

  const admissions = new CharacterAdmissions({
    store,
    journal,
    activeVersion: (agentId) => (agentId === 'bot-1' ? { version: activeVersion, mode: activeMode } : null),
    now: () => currentTime,
    timers,
  });

  return {
    store,
    db,
    journal,
    admissions,
    getTime: () => currentTime,
    setTime: (t: number) => {
      currentTime = t;
    },
    advanceTime: (ms: number) => {
      currentTime += ms;
    },
    fireTimers: () => {
      for (const [id, fn] of [...scheduledTimers.entries()]) {
        scheduledTimers.delete(id);
        fn();
      }
    },
    setActive: (v: number, m: 'off' | 'voice' | 'character') => {
      activeVersion = v;
      activeMode = m;
    },
  };
}

test('an admission is single-use and a new one replaces the run\'s live admission', () => {
  const h = createTestHarness();
  const uttA = h.journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
  const candA = recordTestCandidate(h.journal, {
    agentId: 'bot-1',
    utteranceId: uttA.id,
    attempt: 1,
    text: 'Hello world',
    version: 1,
  });
  h.journal.admit(uttA.id, candA.id, 'passed');

  const admA = h.admissions.issue({
    runId: 'run-1',
    agentId: 'bot-1',
    utteranceId: uttA.id,
    candidateId: candA.id,
    op: 'post',
    replyTo: null,
    text: 'Hello world',
    version: 1,
  });

  const gate = h.admissions.gateFor('run-1', 'bot-1');

  // Reserve admission A
  const res1 = gate.reserve({ text: 'Hello world', op: 'post', inReplyTo: undefined });
  assert.equal(res1.kind, 'reserved');
  if (res1.kind === 'reserved') {
    // Commit attempt
    res1.reservation.commitAttempt('pub-1', () => {});
  }

  // After consume, second reserve returns none
  const res2 = gate.reserve({ text: 'Hello world', op: 'post', inReplyTo: undefined });
  assert.equal(res2.kind, 'none');
  if (res2.kind === 'none') {
    assert.equal(res2.utteranceId, uttA.id);
  }

  // Issue admission B in a new utterance for the same run
  const uttB = h.journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
  const candB = recordTestCandidate(h.journal, {
    agentId: 'bot-1',
    utteranceId: uttB.id,
    attempt: 1,
    text: 'Second post',
    version: 1,
  });
  h.journal.admit(uttB.id, candB.id, 'passed');

  // Create live admission C first to test replacement
  const admC = h.admissions.issue({
    runId: 'run-1',
    agentId: 'bot-1',
    utteranceId: uttB.id,
    candidateId: candB.id,
    op: 'post',
    replyTo: null,
    text: 'Original live',
    version: 1,
  });
  assert.equal(h.admissions.inspect(admC.id)?.state, 'live');

  // Issue D for same run -> C becomes invalid (replaced) and utterance is expired
  const admD = h.admissions.issue({
    runId: 'run-1',
    agentId: 'bot-1',
    utteranceId: uttB.id,
    candidateId: candB.id,
    op: 'post',
    replyTo: null,
    text: 'New live',
    version: 1,
  });
  assert.equal(h.admissions.inspect(admC.id)?.state, 'invalid');
  assert.equal(h.admissions.inspect(admC.id)?.invalidReason, 'replaced');
  assert.equal(h.journal.get('bot-1', uttB.id)?.status, 'expired');
  assert.equal(h.journal.get('bot-1', uttB.id)?.statusReason, 'replaced');

  // Admissions of different runs never match each other
  const gateOtherRun = h.admissions.gateFor('run-2', 'bot-1');
  const resOther = gateOtherRun.reserve({ text: 'New live', op: 'post', inReplyTo: undefined });
  assert.equal(resOther.kind, 'none');
  assert.equal(resOther.utteranceId, undefined);
});

test('expiry after five minutes refuses and marks the utterance expired', () => {
  const h = createTestHarness(1_000_000);
  const utt = h.journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
  const cand = recordTestCandidate(h.journal, {
    agentId: 'bot-1',
    utteranceId: utt.id,
    attempt: 1,
    text: 'Expiring text',
    version: 1,
  });
  h.journal.admit(utt.id, cand.id, 'passed');

  const adm = h.admissions.issue({
    runId: 'run-1',
    agentId: 'bot-1',
    utteranceId: utt.id,
    candidateId: cand.id,
    op: 'post',
    replyTo: null,
    text: 'Expiring text',
    version: 1,
  });

  const gate = h.admissions.gateFor('run-1', 'bot-1');

  // now = expiresAt - 1 reserves
  h.setTime(adm.expiresAt - 1);
  assert.ok(h.admissions.liveFor('run-1'));

  // now = expiresAt gives none
  h.setTime(adm.expiresAt);
  const res = gate.reserve({ text: 'Expiring text', op: 'post', inReplyTo: undefined });
  assert.equal(res.kind, 'none');
  assert.equal(res.utteranceId, utt.id);

  // When timer fires, utterance is expired
  h.fireTimers();
  assert.equal(h.admissions.inspect(adm.id)?.state, 'invalid');
  assert.equal(h.admissions.inspect(adm.id)?.invalidReason, 'expired');
  assert.equal(h.journal.get('bot-1', utt.id)?.status, 'expired');
  assert.equal(h.journal.get('bot-1', utt.id)?.statusReason, 'expired');
});

test('run end cancellation takeover and version change invalidate unsent admissions', () => {
  const cases: Array<{ action: (h: ReturnType<typeof createTestHarness>, gate: ReturnType<typeof h.admissions.gateFor>) => void; expectedReason: string }> = [
    { action: (h) => h.admissions.invalidateRun('run-1', 'run-ended'), expectedReason: 'run-ended' },
    { action: (h) => h.admissions.invalidateRun('run-1', 'cancelled'), expectedReason: 'cancelled' },
    { action: (_h, gate) => gate.invalidate('takeover'), expectedReason: 'takeover' },
    { action: (h) => h.admissions.invalidateAgent('bot-1', 'version-changed'), expectedReason: 'version-changed' },
  ];

  for (const c of cases) {
    const h = createTestHarness();
    const utt = h.journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const cand = recordTestCandidate(h.journal, {
      agentId: 'bot-1',
      utteranceId: utt.id,
      attempt: 1,
      text: 'Test post',
      version: 1,
    });
    h.journal.admit(utt.id, cand.id, 'passed');

    const adm = h.admissions.issue({
      runId: 'run-1',
      agentId: 'bot-1',
      utteranceId: utt.id,
      candidateId: cand.id,
      op: 'post',
      replyTo: null,
      text: 'Test post',
      version: 1,
    });

    const gate = h.admissions.gateFor('run-1', 'bot-1');
    c.action(h, gate);

    const res = gate.reserve({ text: 'Test post', op: 'post', inReplyTo: undefined });
    assert.equal(res.kind, 'none');
    assert.equal(res.utteranceId, utt.id);

    assert.equal(h.admissions.inspect(adm.id)?.state, 'invalid');
    assert.equal(h.admissions.inspect(adm.id)?.invalidReason, c.expectedReason);
    assert.equal(h.journal.get('bot-1', utt.id)?.status, 'expired');
    assert.equal(h.journal.get('bot-1', utt.id)?.statusReason, c.expectedReason);
  }
});

function makeValidVoiceDoc(name: string) {
  const doc = createDefaultCharacterDocument(name);
  doc.identity.oneLine = `${name} assistant.`;
  doc.purpose.statement = 'Helping users.';
  doc.voice.examples = [
    { id: 'ex-1', text: 'Hello from test one.', surface: 'chat', pinned: false, tags: [], origin: 'owner' },
    { id: 'ex-2', text: 'Hello from test two.', surface: 'chat', pinned: false, tags: [], origin: 'owner' },
    { id: 'ex-3', text: 'Hello from test three.', surface: 'chat', pinned: false, tags: [], origin: 'owner' },
  ];
  return doc;
}

test('a studio save or disable invalidates the bot\'s admissions through the store hook', () => {
  const store = new AgentStore(':memory:');
  const journal = new CharacterJournal({ store });

  store.createAgent({ id: 'bot-1', name: 'Milo', model_id: 'gpt-4o', current_status: 'IDLE', budget_cap_usd: 10 });
  store.createAgent({ id: 'bot-2', name: 'Other', model_id: 'gpt-4o', current_status: 'IDLE', budget_cap_usd: 10 });

  let admissions!: CharacterAdmissions;
  const charStore = new CharacterStore(store, {
    onVersionSaved: (agentId) => admissions.invalidateAgent(agentId, 'version-changed'),
  });

  admissions = new CharacterAdmissions({
    store,
    journal,
    activeVersion: (agentId) => {
      const v = charStore.getLatest(agentId);
      return v ? { version: v.version, mode: v.mode } : null;
    },
  });

  // Seed bot-1 version 1
  charStore.save('bot-1', 0, {
    document: makeValidVoiceDoc('Milo'),
    settings: { ...createDefaultCharacterSettings(), mode: 'voice' },
  });

  // Seed bot-2 version 1
  charStore.save('bot-2', 0, {
    document: makeValidVoiceDoc('Other'),
    settings: { ...createDefaultCharacterSettings(), mode: 'voice' },
  });

  // Issue admission for bot-1 and bot-2
  const utt1 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
  const cand1 = recordTestCandidate(journal, {
    agentId: 'bot-1',
    utteranceId: utt1.id,
    attempt: 1,
    text: 'Bot 1 post',
    version: 1,
  });
  journal.admit(utt1.id, cand1.id, 'passed');
  const adm1 = admissions.issue({
    runId: 'run-1',
    agentId: 'bot-1',
    utteranceId: utt1.id,
    candidateId: cand1.id,
    op: 'post',
    replyTo: null,
    text: 'Bot 1 post',
    version: 1,
  });

  const utt2 = journal.createUtterance({ agentId: 'bot-2', runId: 'run-2', op: 'post', version: 1 });
  const cand2 = recordTestCandidate(journal, {
    agentId: 'bot-2',
    utteranceId: utt2.id,
    attempt: 1,
    text: 'Bot 2 post',
    version: 1,
  });
  journal.admit(utt2.id, cand2.id, 'passed');
  const adm2 = admissions.issue({
    runId: 'run-2',
    agentId: 'bot-2',
    utteranceId: utt2.id,
    candidateId: cand2.id,
    op: 'post',
    replyTo: null,
    text: 'Bot 2 post',
    version: 1,
  });

  // Saving a new version for bot-1 invalidates bot-1's admissions
  charStore.save('bot-1', 1, {
    settings: { mode: 'character' },
  });

  assert.equal(admissions.inspect(adm1.id)?.state, 'invalid');
  assert.equal(admissions.inspect(adm1.id)?.invalidReason, 'version-changed');
  assert.equal(journal.get('bot-1', utt1.id)?.status, 'expired');
  assert.equal(journal.get('bot-1', utt1.id)?.statusReason, 'version-changed');

  // Bot-2's admissions stay live!
  assert.equal(admissions.inspect(adm2.id)?.state, 'live');

  // Disabling bot-2 (mode: off) invalidates bot-2's admissions
  charStore.save('bot-2', 1, {
    settings: { mode: 'off' },
  });
  assert.equal(admissions.inspect(adm2.id)?.state, 'invalid');
  assert.equal(admissions.inspect(adm2.id)?.invalidReason, 'version-changed');
  assert.equal(journal.get('bot-2', utt2.id)?.status, 'expired');
});

test('a new admissions instance holds nothing, as after a restart', () => {
  const h = createTestHarness();
  const utt = h.journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
  const cand = recordTestCandidate(h.journal, {
    agentId: 'bot-1',
    utteranceId: utt.id,
    attempt: 1,
    text: 'Pre-restart post',
    version: 1,
  });
  h.journal.admit(utt.id, cand.id, 'passed');

  h.admissions.issue({
    runId: 'run-1',
    agentId: 'bot-1',
    utteranceId: utt.id,
    candidateId: cand.id,
    op: 'post',
    replyTo: null,
    text: 'Pre-restart post',
    version: 1,
  });

  // Create a new admissions instance on the same store and journal
  const restartedAdmissions = new CharacterAdmissions({
    store: h.store,
    journal: h.journal,
    activeVersion: () => ({ version: 1, mode: 'character' }),
  });

  const gate = restartedAdmissions.gateFor('run-1', 'bot-1');
  const res = gate.reserve({ text: 'Pre-restart post', op: 'post', inReplyTo: undefined });
  assert.equal(res.kind, 'none');
  assert.equal(res.utteranceId, undefined);
});

test('reserve checks the active version and mode at the moment of the request', () => {
  const h = createTestHarness();
  const utt = h.journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
  const cand = recordTestCandidate(h.journal, {
    agentId: 'bot-1',
    utteranceId: utt.id,
    attempt: 1,
    text: 'Check version text',
    version: 1,
  });
  h.journal.admit(utt.id, cand.id, 'passed');

  h.admissions.issue({
    runId: 'run-1',
    agentId: 'bot-1',
    utteranceId: utt.id,
    candidateId: cand.id,
    op: 'post',
    replyTo: null,
    text: 'Check version text',
    version: 1,
  });

  const gate = h.admissions.gateFor('run-1', 'bot-1');

  // Version bumped to 2 without calling the hook
  h.setActive(2, 'character');
  const resVersionChanged = gate.reserve({ text: 'Check version text', op: 'post', inReplyTo: undefined });
  assert.equal(resVersionChanged.kind, 'none');
  assert.equal(resVersionChanged.utteranceId, utt.id);

  // Set mode to off
  h.setActive(1, 'off');
  const resOff = gate.reserve({ text: 'Check version text', op: 'post', inReplyTo: undefined });
  assert.equal(resOff.kind, 'none');
  assert.equal(resOff.utteranceId, utt.id);
});

test('commitAttempt consumes only after the SQL commit and invalidates on failure', () => {
  const h = createTestHarness();
  const utt = h.journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
  const cand = recordTestCandidate(h.journal, {
    agentId: 'bot-1',
    utteranceId: utt.id,
    attempt: 1,
    text: 'Attempt text',
    version: 1,
  });
  h.journal.admit(utt.id, cand.id, 'passed');

  const adm = h.admissions.issue({
    runId: 'run-1',
    agentId: 'bot-1',
    utteranceId: utt.id,
    candidateId: cand.id,
    op: 'post',
    replyTo: null,
    text: 'Attempt text',
    version: 1,
  });

  const gate = h.admissions.gateFor('run-1', 'bot-1');
  const reserved = gate.reserve({ text: 'Attempt text', op: 'post', inReplyTo: undefined });
  assert.equal(reserved.kind, 'reserved');

  if (reserved.kind === 'reserved') {
    let checkedInsideTransaction = false;
    const returnVal = reserved.reservation.commitAttempt('pub-1', () => {
      // Inside transaction
      checkedInsideTransaction = true;
      assert.equal(h.admissions.inspect(adm.id)?.state, 'consuming');
    });

    assert.equal(returnVal, undefined); // Never a promise
    assert.ok(checkedInsideTransaction);
    assert.equal(h.admissions.inspect(adm.id)?.state, 'consumed');
    assert.equal(h.admissions.inspect(adm.id)?.consumedByPublishId, 'pub-1');
    assert.equal(h.journal.get('bot-1', utt.id)?.status, 'attempted');
    assert.equal(h.journal.get('bot-1', utt.id)?.publishId, 'pub-1');
    assert.equal(h.journal.get('bot-1', utt.id)?.text, 'Attempt text');
  }

  // Second test: throwing writeAttempted leaves admission invalid and utterance refused
  const utt2 = h.journal.createUtterance({ agentId: 'bot-1', runId: 'run-2', op: 'post', version: 1 });
  const cand2 = recordTestCandidate(h.journal, {
    agentId: 'bot-1',
    utteranceId: utt2.id,
    attempt: 1,
    text: 'Failing attempt',
    version: 1,
  });
  h.journal.admit(utt2.id, cand2.id, 'passed');

  const adm2 = h.admissions.issue({
    runId: 'run-2',
    agentId: 'bot-1',
    utteranceId: utt2.id,
    candidateId: cand2.id,
    op: 'post',
    replyTo: null,
    text: 'Failing attempt',
    version: 1,
  });

  const gate2 = h.admissions.gateFor('run-2', 'bot-1');
  const reserved2 = gate2.reserve({ text: 'Failing attempt', op: 'post', inReplyTo: undefined });
  assert.equal(reserved2.kind, 'reserved');

  if (reserved2.kind === 'reserved') {
    assert.throws(
      () => {
        reserved2.reservation.commitAttempt('pub-2', () => {
          throw new Error('Forced write error');
        });
      },
      /Forced write error/
    );

    assert.equal(h.admissions.inspect(adm2.id)?.state, 'invalid');
    assert.equal(h.admissions.inspect(adm2.id)?.invalidReason, 'attempt-write-failed');
    assert.equal(h.journal.get('bot-1', utt2.id)?.status, 'refused');
    assert.equal(h.journal.get('bot-1', utt2.id)?.statusReason, 'attempt-write-failed');
  }
});
