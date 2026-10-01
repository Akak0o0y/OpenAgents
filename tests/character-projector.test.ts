import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CharacterJournal } from '../src/daemon/character-journal.js';
import {
  CharacterProjector,
  deriveOutcome,
} from '../src/daemon/character-projector.js';
import { layerForEvent } from '../src/kernel/agent-layers.js';
import { acknowledgeRoutine, pendingForRoutine } from '../src/daemon/external-effects.js';
import { PublishPolicy } from '../src/daemon/publish-policy.js';
import { type PublishProbe } from '../src/daemon/publish-probes.js';

const ORIGIN = 'https://x.com';
const PROBE_ID = 'x.com/create-tweet';

const probe: PublishProbe = {
  id: PROBE_ID,
  origins: [ORIGIN],
  notCreatedCodes: new Set([187]),
  account: { role: 'link', name: 'Profile' },
  match() {
    return { probe: PROBE_ID, op: 'post', text: 'hello' };
  },
  classify() {
    return { outcome: 'confirmed', postId: '123', shape: [] };
  },
  postPath: (acc, id) => `/${acc}/status/${id}`,
  profilePaths: (acc) => [`/${acc}`],
};

function setupHarness(opts?: { now?: () => number }) {
  const store = new AgentStore(':memory:');
  const agent = store.createAgent({
    id: 'bot-1',
    name: 'Milo',
    model_id: 'gpt-4o',
    current_status: 'IDLE',
    budget_cap_usd: 10,
  });
  const journal = new CharacterJournal({ store, now: opts?.now });
  const projector = new CharacterProjector({ store, journal, now: opts?.now });
  return { store, agent, journal, projector };
}

function addCandidate(journal: CharacterJournal, agentId: string, utteranceId: string, text: string, attempt = 1) {
  return journal.recordCandidate({
    agentId,
    utteranceId,
    attempt,
    text,
    exactSha256: 'a'.repeat(64),
    textSha256: 'b'.repeat(64),
    version: 1,
    selection: { voice: '', audience: '', topic: '' } as any,
    evidence: [],
    rules: { hardRulesPassed: true, softRulesPassed: true } as any,
  });
}

describe('character outcome projector', () => {
  it('outcome projection follows the P2-C4 table', () => {
    // 1. attempted | PUBLISH_OBSERVED confirmed | – | confirmed, with postUrl
    assert.deepEqual(
      deriveOutcome(
        { status: 'attempted', acknowledgedAt: null },
        [{ type: 'PUBLISH_OBSERVED', payload: { outcome: 'confirmed', postUrl: 'https://x.com/post/1' }, at: 100 }],
        false
      ),
      { status: 'confirmed', postUrl: 'https://x.com/post/1', acknowledgedAt: null }
    );

    // 2. attempted | PUBLISH_OBSERVED rejected | – | rejected
    assert.deepEqual(
      deriveOutcome(
        { status: 'attempted', acknowledgedAt: null },
        [{ type: 'PUBLISH_OBSERVED', payload: { outcome: 'rejected' }, at: 100 }],
        false
      ),
      { status: 'rejected', postUrl: null, acknowledgedAt: null }
    );

    // 3. attempted | PUBLISH_OBSERVED unobserved | – | uncertain
    assert.deepEqual(
      deriveOutcome(
        { status: 'attempted', acknowledgedAt: null },
        [{ type: 'PUBLISH_OBSERVED', payload: { outcome: 'unobserved' }, at: 100 }],
        false
      ),
      { status: 'uncertain', postUrl: null, acknowledgedAt: null }
    );

    // 4. attempted | none | yes | uncertain
    assert.deepEqual(
      deriveOutcome(
        { status: 'attempted', acknowledgedAt: null },
        [],
        true
      ),
      { status: 'uncertain', postUrl: null, acknowledgedAt: null }
    );

    // 5. attempted | none | no | attempted
    assert.deepEqual(
      deriveOutcome(
        { status: 'attempted', acknowledgedAt: null },
        [],
        false
      ),
      { status: 'attempted', postUrl: null, acknowledgedAt: null }
    );

    // 6. uncertain | PUBLISH_RECONCILED present | – | confirmed
    assert.deepEqual(
      deriveOutcome(
        { status: 'uncertain', acknowledgedAt: null },
        [{ type: 'PUBLISH_RECONCILED', payload: { verdict: 'present', postUrl: 'https://x.com/post/2' }, at: 200 }],
        true
      ),
      { status: 'confirmed', postUrl: 'https://x.com/post/2', acknowledgedAt: null }
    );

    // 7. uncertain | late PUBLISH_OBSERVED confirmed | – | confirmed
    assert.deepEqual(
      deriveOutcome(
        { status: 'uncertain', acknowledgedAt: null },
        [{ type: 'PUBLISH_OBSERVED', payload: { outcome: 'confirmed', postUrl: 'https://x.com/post/3' }, at: 200 }],
        false
      ),
      { status: 'confirmed', postUrl: 'https://x.com/post/3', acknowledgedAt: null }
    );

    // 8. uncertain | PUBLISH_RECONCILED not-found | – | uncertain (C4)
    assert.deepEqual(
      deriveOutcome(
        { status: 'uncertain', acknowledgedAt: null },
        [{ type: 'PUBLISH_RECONCILED', payload: { verdict: 'not-found' }, at: 200 }],
        true
      ),
      { status: 'uncertain', postUrl: null, acknowledgedAt: null }
    );

    // 9. uncertain or attempted | EXTERNAL_ACTION_ACKNOWLEDGED {key: publishId} | yes | uncertain, with acknowledgedAt set
    assert.deepEqual(
      deriveOutcome(
        { status: 'uncertain', acknowledgedAt: null },
        [{ type: 'EXTERNAL_ACTION_ACKNOWLEDGED', payload: { key: 'pub-1', at: 350 }, at: 350 }],
        true
      ),
      { status: 'uncertain', postUrl: null, acknowledgedAt: 350 }
    );
    assert.deepEqual(
      deriveOutcome(
        { status: 'attempted', acknowledgedAt: null },
        [{ type: 'EXTERNAL_ACTION_ACKNOWLEDGED', payload: { key: 'pub-1', at: 350 }, at: 350 }],
        true
      ),
      { status: 'uncertain', postUrl: null, acknowledgedAt: 350 }
    );

    // 10. attempted | observed rejected, then reconciled present | – | confirmed (confirmed wins)
    assert.deepEqual(
      deriveOutcome(
        { status: 'attempted', acknowledgedAt: null },
        [
          { type: 'PUBLISH_OBSERVED', payload: { outcome: 'rejected' }, at: 100 },
          { type: 'PUBLISH_RECONCILED', payload: { verdict: 'present', postUrl: 'https://x.com/post/4' }, at: 200 },
        ],
        false
      ),
      { status: 'confirmed', postUrl: 'https://x.com/post/4', acknowledgedAt: null }
    );

    // 11. confirmed or rejected | any signal | – | unchanged (terminal)
    assert.deepEqual(
      deriveOutcome(
        { status: 'confirmed', acknowledgedAt: null },
        [{ type: 'PUBLISH_OBSERVED', payload: { outcome: 'rejected' }, at: 300 }],
        false
      ),
      { status: 'confirmed', postUrl: null, acknowledgedAt: null }
    );
    assert.deepEqual(
      deriveOutcome(
        { status: 'rejected', acknowledgedAt: null },
        [{ type: 'PUBLISH_OBSERVED', payload: { outcome: 'confirmed', postUrl: 'https://x.com/post/5' }, at: 300 }],
        false
      ),
      { status: 'rejected', postUrl: null, acknowledgedAt: null }
    );
  });

  it('projection is idempotent and replays never change a terminal status', () => {
    const { store, journal, projector } = setupHarness();
    const runId = 'run-1';
    store.createTaskRun({ id: runId, agentId: 'bot-1', taskName: 'test' });
    projector.watchRun(runId);

    const utt = journal.createUtterance({ agentId: 'bot-1', runId, op: 'post', version: 1 });
    const cand = addCandidate(journal, 'bot-1', utt.id, 'hello');
    journal.admit(utt.id, cand.id, 'passed');
    journal.markAttempted(utt.id, 'pub-1', 'hello', 'b'.repeat(64));

    // Listen / track emitted events
    const postedEvents: any[] = [];
    store.setEventSink((event) => {
      if (event.event_type === 'CHARACTER_POSTED') {
        postedEvents.push(event);
      }
      projector.onEvent(event);
    });

    const observedEvent = {
      task_run_id: runId,
      agent_id: 'bot-1',
      event_type: 'PUBLISH_OBSERVED',
      payload_json: JSON.stringify({ publishId: 'pub-1', outcome: 'confirmed', postUrl: 'https://x.com/post/1' }),
      timestamp: 1000,
    };

    // First emission
    store.recordEvent(observedEvent);
    assert.equal(journal.get('bot-1', utt.id)?.status, 'confirmed');
    assert.equal(journal.get('bot-1', utt.id)?.postUrl, 'https://x.com/post/1');
    assert.equal(postedEvents.length, 1);
    assert.equal(JSON.parse(postedEvents[0].payload_json).status, 'confirmed');

    // Replay of the exact same event
    projector.onEvent(observedEvent);
    assert.equal(postedEvents.length, 1, 'Replay must not emit a second CHARACTER_POSTED');
    assert.equal(journal.get('bot-1', utt.id)?.status, 'confirmed');

    // Replay of a rejection signal on confirmed status
    projector.onEvent({
      task_run_id: runId,
      agent_id: 'bot-1',
      event_type: 'PUBLISH_OBSERVED',
      payload_json: JSON.stringify({ publishId: 'pub-1', outcome: 'rejected' }),
      timestamp: 1100,
    });
    assert.equal(postedEvents.length, 1, 'Replay of rejection must not change terminal status');
    assert.equal(journal.get('bot-1', utt.id)?.status, 'confirmed');
  });

  it('the run end marks unproven attempts uncertain and late proof still confirms', () => {
    const { store, journal, projector } = setupHarness();
    const runId = 'run-2';
    store.createTaskRun({ id: runId, agentId: 'bot-1', taskName: 'test' });
    projector.watchRun(runId);

    const postedEvents: any[] = [];
    store.setEventSink((event) => {
      if (event.event_type === 'CHARACTER_POSTED') {
        postedEvents.push(event);
      }
      projector.onEvent(event);
    });

    // 1. Draft leftover in run-2
    const draftUtt = journal.createUtterance({ agentId: 'bot-1', runId, op: 'post', version: 1 });

    // 2. Attempted utterance in run-2
    const attemptUtt = journal.createUtterance({ agentId: 'bot-1', runId, op: 'post', version: 1 });
    const cand = addCandidate(journal, 'bot-1', attemptUtt.id, 'post 2');
    journal.admit(attemptUtt.id, cand.id, 'passed');
    journal.markAttempted(attemptUtt.id, 'pub-2', 'post 2', 'b'.repeat(64));

    // Record the attempt event
    store.recordEvent({
      task_run_id: runId,
      agent_id: 'bot-1',
      event_type: 'PUBLISH_ATTEMPTED',
      payload_json: JSON.stringify({ publishId: 'pub-2' }),
      timestamp: 2000,
    });

    // Run ends without proof -> settleRun
    projector.settleRun(runId);

    // Draft leftover becomes held with status_reason = interrupted
    assert.equal(journal.get('bot-1', draftUtt.id)?.status, 'held');
    assert.equal(journal.get('bot-1', draftUtt.id)?.statusReason, 'interrupted');

    // Attempted without proof becomes uncertain
    assert.equal(journal.get('bot-1', attemptUtt.id)?.status, 'uncertain');
    assert.equal(postedEvents.length, 1);
    assert.equal(JSON.parse(postedEvents[0].payload_json).status, 'uncertain');

    // Late confirmed proof arrives
    store.recordEvent({
      task_run_id: runId,
      agent_id: 'bot-1',
      event_type: 'PUBLISH_OBSERVED',
      payload_json: JSON.stringify({ publishId: 'pub-2', outcome: 'confirmed', postUrl: 'https://x.com/late-proof' }),
      timestamp: 2500,
    });

    assert.equal(journal.get('bot-1', attemptUtt.id)?.status, 'confirmed');
    assert.equal(journal.get('bot-1', attemptUtt.id)?.postUrl, 'https://x.com/late-proof');
    assert.equal(postedEvents.length, 2);
    assert.equal(JSON.parse(postedEvents[1].payload_json).status, 'confirmed');
  });

  it('daemon start expires stale admissions and repairs attempts from Stage 1 events', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-projector-daemon-start-'));
    let store: AgentStore | undefined;
    try {
      const dbPath = path.join(tmpDir, 'daemon.db');
      store = new AgentStore(dbPath);
      new PublishPolicy(store, [probe]);

      store.createAgent({
        id: 'bot-1',
        name: 'Milo',
        model_id: 'gpt-4o',
        current_status: 'IDLE',
        budget_cap_usd: 10,
      });

      const routine = store.createRoutine({
        agentId: 'bot-1',
        name: 'Daily Tweet',
        taskName: 'work:tweet',
        promptTemplate: 'Write tweet',
        cronExpression: '0 12 * * *',
        nextRunAt: Date.now() + 86_400_000,
      });

      const run = store.createTaskRun({
        id: 'run-prev',
        agentId: 'bot-1',
        taskName: 'work:tweet',
        routineId: routine.id,
      });
      store.startTaskRun(run.id);

      const journal = new CharacterJournal({ store });
      const projector = new CharacterProjector({ store, journal });
      projector.watchRun(run.id);

      // Draft utterance
      const draftUtt = journal.createUtterance({ agentId: 'bot-1', runId: run.id, op: 'post', version: 1 });

      // Admitted utterance
      const admittedUtt = journal.createUtterance({ agentId: 'bot-1', runId: run.id, op: 'post', version: 1 });
      const candAdmitted = addCandidate(journal, 'bot-1', admittedUtt.id, 'admitted text');
      journal.admit(admittedUtt.id, candAdmitted.id, 'passed');

      // Attempted utterance
      const attemptedUtt = journal.createUtterance({ agentId: 'bot-1', runId: run.id, op: 'post', version: 1 });
      const candAttempted = addCandidate(journal, 'bot-1', attemptedUtt.id, 'attempted text');
      journal.admit(attemptedUtt.id, candAttempted.id, 'passed');
      journal.markAttempted(attemptedUtt.id, 'pub-boot', 'attempted text', 'b'.repeat(64));

      store.recordEvent({
        task_run_id: run.id,
        agent_id: 'bot-1',
        event_type: 'PUBLISH_ATTEMPTED',
        payload_json: JSON.stringify({ publishId: 'pub-boot', origin: ORIGIN }),
        timestamp: 1000,
      });

      // Simulate crash and boot sweep
      store.markInFlightAsCrashed('previous daemon terminated abruptly');

      // Hook up event sink
      store.setEventSink((e) => projector.onEvent(e));

      // Daemon start: repairAll
      const res = projector.repairAll();
      assert.equal(res.expired, 1, 'Admitted became expired(restart)');
      assert.equal(res.held, 1, 'Draft became held(interrupted)');
      assert.equal(res.projected, 1, 'Attempted became uncertain');

      assert.equal(journal.get('bot-1', admittedUtt.id)?.status, 'expired');
      assert.equal(journal.get('bot-1', admittedUtt.id)?.statusReason, 'restart');

      assert.equal(journal.get('bot-1', draftUtt.id)?.status, 'held');
      assert.equal(journal.get('bot-1', draftUtt.id)?.statusReason, 'interrupted');

      assert.equal(journal.get('bot-1', attemptedUtt.id)?.status, 'uncertain');

      // A routine with a pending item stays held (pendingForRoutine)
      const pendingBefore = pendingForRoutine(store, routine.id);
      assert.equal(pendingBefore.length, 1);
      assert.equal(pendingBefore[0].key, 'pub-boot');

      // acknowledgeRoutine sets acknowledged_at and nothing else
      const ackCount = acknowledgeRoutine(store, 'bot-1', routine.id, 5000);
      assert.equal(ackCount, 1);

      const afterAck = journal.get('bot-1', attemptedUtt.id);
      assert.equal(afterAck?.status, 'uncertain', 'Status must stay uncertain after acknowledgement');
      assert.equal(afterAck?.acknowledgedAt, 5000, 'acknowledged_at must be set');

      const pendingAfter = pendingForRoutine(store, routine.id);
      assert.equal(pendingAfter.length, 0, 'Routine is no longer held after acknowledgement');
    } finally {
      store?.close();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('acknowledgement sets acknowledged_at and never confirms or rejects', () => {
    const { store, journal, projector } = setupHarness();
    new PublishPolicy(store, [probe]);

    const routine = store.createRoutine({
      agentId: 'bot-1',
      name: 'Routine',
      taskName: 'work:tweet',
      promptTemplate: 'Write tweet',
      cronExpression: '0 12 * * *',
      nextRunAt: Date.now() + 86_400_000,
    });

    const run = store.createTaskRun({
      id: 'run-ack',
      agentId: 'bot-1',
      taskName: 'work:tweet',
      routineId: routine.id,
    });
    store.startTaskRun(run.id);
    projector.watchRun(run.id);

    const utt = journal.createUtterance({ agentId: 'bot-1', runId: run.id, op: 'post', version: 1 });
    const cand = addCandidate(journal, 'bot-1', utt.id, 'text');
    journal.admit(utt.id, cand.id, 'passed');
    journal.markAttempted(utt.id, 'pub-ack-test', 'text', 'b'.repeat(64));

    store.recordEvent({
      task_run_id: run.id,
      agent_id: 'bot-1',
      event_type: 'PUBLISH_ATTEMPTED',
      payload_json: JSON.stringify({ publishId: 'pub-ack-test', origin: ORIGIN }),
      timestamp: 1000,
    });

    store.setEventSink((e) => projector.onEvent(e));
    projector.settleRun(run.id);
    assert.equal(journal.get('bot-1', utt.id)?.status, 'uncertain');

    store.finishTaskRun(run.id, 'COMPLETED');

    acknowledgeRoutine(store, 'bot-1', routine.id, 9999);

    const updated = journal.get('bot-1', utt.id);
    assert.equal(updated?.status, 'uncertain');
    assert.equal(updated?.acknowledgedAt, 9999);
  });

  it('a deleted or unknown row is never recreated', () => {
    const { store, journal, projector } = setupHarness();
    const runId = 'run-del';
    store.createTaskRun({ id: runId, agentId: 'bot-1', taskName: 'test' });
    projector.watchRun(runId);

    // Call onEvent with unknown publishId
    projector.onEvent({
      task_run_id: runId,
      agent_id: 'bot-1',
      event_type: 'PUBLISH_OBSERVED',
      payload_json: JSON.stringify({ publishId: 'pub-unknown-xyz', outcome: 'confirmed', postUrl: 'https://x.com/post/999' }),
      timestamp: 1000,
    });

    assert.equal(journal.byPublishId('pub-unknown-xyz'), null);

    // Create and delete an utterance
    const utt = journal.createUtterance({ agentId: 'bot-1', runId, op: 'post', version: 1 });
    const cand = addCandidate(journal, 'bot-1', utt.id, 'to delete');
    journal.admit(utt.id, cand.id, 'passed');
    journal.markAttempted(utt.id, 'pub-del-1', 'to delete', 'b'.repeat(64));
    store.getDatabase().prepare('DELETE FROM bot_character_utterances WHERE id = ?').run(utt.id);

    assert.equal(journal.byPublishId('pub-del-1'), null);

    // onEvent for deleted row
    projector.onEvent({
      task_run_id: runId,
      agent_id: 'bot-1',
      event_type: 'PUBLISH_OBSERVED',
      payload_json: JSON.stringify({ publishId: 'pub-del-1', outcome: 'confirmed', postUrl: 'https://x.com/post/del' }),
      timestamp: 2000,
    });

    assert.equal(journal.byPublishId('pub-del-1'), null, 'Deleted row must never be recreated');
  });

  it('a projection that fails in the sink changes no outcome and is repaired at the next run start', () => {
    const { store, journal, projector } = setupHarness();
    const runId = 'run-fail';
    store.createTaskRun({ id: runId, agentId: 'bot-1', taskName: 'test' });
    projector.watchRun(runId);

    const utt = journal.createUtterance({ agentId: 'bot-1', runId, op: 'post', version: 1 });
    const cand = addCandidate(journal, 'bot-1', utt.id, 'text');
    journal.admit(utt.id, cand.id, 'passed');
    journal.markAttempted(utt.id, 'pub-fail', 'text', 'b'.repeat(64));

    let broadcastCalled = false;
    store.setEventSink((event) => {
      broadcastCalled = true;
      try {
        projector.onEvent(event);
      } catch {
        // swallowed as in index.ts
      }
    });

    // Make journal.project throw on first call
    const originalProject = journal.project.bind(journal);
    let thrown = false;
    journal.project = (...args: [string, any]) => {
      if (!thrown) {
        thrown = true;
        throw new Error('Simulated journal.project failure in sink');
      }
      return originalProject(...args);
    };

    // Emit event through store
    store.recordEvent({
      task_run_id: runId,
      agent_id: 'bot-1',
      event_type: 'PUBLISH_OBSERVED',
      payload_json: JSON.stringify({ publishId: 'pub-fail', outcome: 'confirmed', postUrl: 'https://x.com/post/fail' }),
      timestamp: 1000,
    });

    assert.equal(broadcastCalled, true, 'Sink broadcasted the event');
    assert.equal(journal.get('bot-1', utt.id)?.status, 'attempted', 'Utterance stays attempted on sink failure');

    // Next run start: repairAgent
    journal.project = originalProject;
    projector.repairAgent('bot-1');

    assert.equal(journal.get('bot-1', utt.id)?.status, 'confirmed');
    assert.equal(journal.get('bot-1', utt.id)?.postUrl, 'https://x.com/post/fail');
  });

  it('Off bots cost the projector no database work per publish event', () => {
    const { store, projector } = setupHarness();
    const unwatchedRunId = 'run-off-bot';

    let prepareCallCount = 0;
    const db = store.getDatabase();
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      prepareCallCount++;
      return originalPrepare(sql);
    }) as any;

    try {
      projector.onEvent({
        task_run_id: unwatchedRunId,
        agent_id: 'bot-1',
        event_type: 'PUBLISH_OBSERVED',
        payload_json: JSON.stringify({ publishId: 'pub-off', outcome: 'confirmed' }),
        timestamp: 1000,
      });

      assert.equal(prepareCallCount, 0, 'Unwatched run must trigger zero calls to db.prepare');
    } finally {
      db.prepare = originalPrepare;
    }
  });

  it('CHARACTER_POSTED carries ids and status only', () => {
    assert.equal(layerForEvent('CHARACTER_POSTED'), 7);

    const { store, journal, projector } = setupHarness();
    const runId = 'run-layer';
    store.createTaskRun({ id: runId, agentId: 'bot-1', taskName: 'test' });
    projector.watchRun(runId);

    const utt = journal.createUtterance({ agentId: 'bot-1', runId, op: 'post', version: 1 });
    const cand = addCandidate(journal, 'bot-1', utt.id, 'secret post text');
    journal.admit(utt.id, cand.id, 'passed');
    journal.markAttempted(utt.id, 'pub-layer', 'secret post text', 'b'.repeat(64));

    store.setEventSink((e) => projector.onEvent(e));

    store.recordEvent({
      task_run_id: runId,
      agent_id: 'bot-1',
      event_type: 'PUBLISH_OBSERVED',
      payload_json: JSON.stringify({ publishId: 'pub-layer', outcome: 'confirmed', postUrl: 'https://x.com/post/layer' }),
      timestamp: 1000,
    });

    const events = store.getTaskEvents(runId);
    const postedEvent = events.find((e) => e.event_type === 'CHARACTER_POSTED');
    assert.ok(postedEvent, 'CHARACTER_POSTED event must be recorded');
    assert.equal(postedEvent.layer, 7);

    const payload = JSON.parse(postedEvent.payload_json);
    assert.deepEqual(Object.keys(payload).sort(), ['publishId', 'status', 'utteranceId'].sort());
    assert.equal(payload.utteranceId, utt.id);
    assert.equal(payload.publishId, 'pub-layer');
    assert.equal(payload.status, 'confirmed');

    // Never contain post text or postUrl
    assert.equal(postedEvent.payload_json.includes('secret post text'), false);
    assert.equal(postedEvent.payload_json.includes('https://x.com'), false);
  });
});
