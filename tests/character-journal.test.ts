import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import {
  CharacterJournal,
  CharacterJournalConflict,
  CHARACTER_QUOTA_BYTES,
  PREPARATION_RESERVE_BYTES,
  type UtteranceStatus,
} from '../src/daemon/character-journal.js';

function createTestAgent(store: AgentStore, id: string, name = 'Test Bot'): void {
  store.createAgent({
    id,
    name,
    model_id: 'test-model',
    budget_cap_usd: 100,
    current_status: 'IDLE',
  });
}

describe('character journal', () => {
  it('journal tables are bot-owned and cascade when the bot is deleted', () => {
    const store = new AgentStore(':memory:');
    createTestAgent(store, 'bot-1');
    createTestAgent(store, 'bot-2');

    const journal = new CharacterJournal({ store });

    // Seed bot-1 data
    const u1 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const c1 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u1.id,
      attempt: 1,
      text: 'Candidate 1',
      exactSha256: 'sha1',
      textSha256: 'sha2',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    journal.recordReview({
      agentId: 'bot-1',
      utteranceId: u1.id,
      candidateId: c1.id,
      runId: 'run-1',
      attempt: 1,
      callNo: 1,
      sameAsAuthor: true,
      rules: {},
      verdict: 'pass',
      compilerVersion: '1',
      mappingVersion: '1',
      reviewerPromptVersion: '1',
      logicalCalls: 1,
    });

    // Seed bot-2 data
    const u2 = journal.createUtterance({ agentId: 'bot-2', runId: 'run-2', op: 'post', version: 1 });
    const c2 = journal.recordCandidate({
      agentId: 'bot-2',
      utteranceId: u2.id,
      attempt: 1,
      text: 'Candidate 2',
      exactSha256: 'sha3',
      textSha256: 'sha4',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    journal.recordReview({
      agentId: 'bot-2',
      utteranceId: u2.id,
      candidateId: c2.id,
      runId: 'run-2',
      attempt: 1,
      callNo: 1,
      sameAsAuthor: true,
      rules: {},
      verdict: 'pass',
      compilerVersion: '1',
      mappingVersion: '1',
      reviewerPromptVersion: '1',
      logicalCalls: 1,
    });

    // Verify both exist
    assert.ok(journal.get('bot-1', u1.id));
    assert.ok(journal.get('bot-2', u2.id));
    assert.equal(journal.candidates(u1.id).length, 1);
    assert.equal(journal.candidates(u2.id).length, 1);
    assert.equal(journal.reviews(u1.id).length, 1);
    assert.equal(journal.reviews(u2.id).length, 1);

    // Delete bot-1
    store.deleteAgent('bot-1');

    // bot-1 tables are cascade deleted
    assert.equal(journal.get('bot-1', u1.id), null);
    assert.equal(journal.candidates(u1.id).length, 0);
    assert.equal(journal.reviews(u1.id).length, 0);

    // bot-2 rows remain intact
    assert.ok(journal.get('bot-2', u2.id));
    assert.equal(journal.candidates(u2.id).length, 1);
    assert.equal(journal.reviews(u2.id).length, 1);
  });

  it('utterance status moves only along the allowed transitions', () => {
    const store = new AgentStore(':memory:');
    createTestAgent(store, 'bot-1');
    const journal = new CharacterJournal({ store });

    // Table of allowed and disallowed moves:
    // draft -> held (hold)
    // draft -> admitted (admit)
    // admitted -> expired (expire)
    // admitted -> refused (markRefused)
    // admitted -> attempted (markAttempted)
    // attempted -> confirmed (project)
    // attempted -> rejected (project)
    // attempted -> uncertain (project)
    // uncertain -> confirmed (project)
    // uncertain -> rejected (project)
    // uncertain -> uncertain (project)

    // 1. draft -> held
    const u1 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    assert.equal(u1.status, 'draft');
    assert.equal(journal.hold(u1.id, 'rules-failed', 'failed'), true);
    assert.equal(journal.get('bot-1', u1.id)?.status, 'held');
    // from held, cannot hold or admit or expire
    assert.equal(journal.hold(u1.id, 'budget', 'failed'), false);
    assert.equal(journal.admit(u1.id, 'c-dummy', 'passed'), false);
    assert.equal(journal.expire(u1.id, 'expired'), false);

    // 2. draft -> admitted -> expired
    const u2 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const c2 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u2.id,
      attempt: 1,
      text: 'Candidate 2',
      exactSha256: 'e1',
      textSha256: 't1',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    assert.equal(journal.admit(u2.id, c2.id, 'passed'), true);
    assert.equal(journal.get('bot-1', u2.id)?.status, 'admitted');
    // from admitted, cannot hold or admit again
    assert.equal(journal.hold(u2.id, 'budget', 'failed'), false);
    assert.equal(journal.admit(u2.id, c2.id, 'passed'), false);
    // expire
    assert.equal(journal.expire(u2.id, 'expired'), true);
    assert.equal(journal.get('bot-1', u2.id)?.status, 'expired');
    // from expired, cannot expire or markAttempted
    assert.equal(journal.expire(u2.id, 'expired'), false);
    assert.throws(() => journal.markAttempted(u2.id, 'pub-2', 'Text', 'h2'), CharacterJournalConflict);

    // 3. draft -> admitted -> refused
    const u3 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const c3 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u3.id,
      attempt: 1,
      text: 'Candidate 3',
      exactSha256: 'e2',
      textSha256: 't2',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    assert.equal(journal.admit(u3.id, c3.id, 'passed'), true);
    assert.equal(journal.markRefused(u3.id, 'attempt-write-failed'), true);
    assert.equal(journal.get('bot-1', u3.id)?.status, 'refused');
    assert.equal(journal.markRefused(u3.id, 'attempt-write-failed'), false);

    // 4. draft -> admitted -> attempted -> confirmed
    const u4 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const c4 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u4.id,
      attempt: 1,
      text: 'Candidate 4',
      exactSha256: 'e3',
      textSha256: 't3',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    assert.equal(journal.admit(u4.id, c4.id, 'passed'), true);
    journal.markAttempted(u4.id, 'pub-4', 'Admitted text', 't3');
    assert.equal(journal.get('bot-1', u4.id)?.status, 'attempted');
    // Attempted cannot be admitted or expired
    assert.equal(journal.admit(u4.id, c4.id, 'passed'), false);
    assert.equal(journal.expire(u4.id, 'expired'), false);
    // Project to confirmed
    assert.equal(journal.project(u4.id, { status: 'confirmed', postUrl: 'https://x.com/post/1' }), true);
    assert.equal(journal.get('bot-1', u4.id)?.status, 'confirmed');
    // Confirmed is terminal
    assert.equal(journal.project(u4.id, { status: 'rejected' }), false);

    // 5. attempted -> uncertain -> confirmed
    const u5 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const c5 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u5.id,
      attempt: 1,
      text: 'Candidate 5',
      exactSha256: 'e4',
      textSha256: 't4',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    journal.admit(u5.id, c5.id, 'passed');
    journal.markAttempted(u5.id, 'pub-5', 'Admitted 5', 't4');
    assert.equal(journal.project(u5.id, { status: 'uncertain' }), true);
    assert.equal(journal.get('bot-1', u5.id)?.status, 'uncertain');
    // Setting acknowledgedAt while uncertain
    assert.equal(journal.project(u5.id, { status: 'uncertain', acknowledgedAt: 12345 }), true);
    const u5Row = journal.get('bot-1', u5.id);
    assert.equal(u5Row?.status, 'uncertain');
    assert.equal(u5Row?.acknowledgedAt, 12345);
    // Finally confirmed
    assert.equal(journal.project(u5.id, { status: 'confirmed', postUrl: 'https://x.com/post/5' }), true);
    assert.equal(journal.get('bot-1', u5.id)?.status, 'confirmed');
  });

  it('candidates and reviews are immutable and bound to their utterance', () => {
    const store = new AgentStore(':memory:');
    createTestAgent(store, 'bot-1');
    const journal = new CharacterJournal({ store });

    const u1 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const u2 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });

    const c1 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u1.id,
      attempt: 1,
      text: 'Candidate 1',
      exactSha256: 'e1',
      textSha256: 't1',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });

    // Duplicate attempt for same utterance throws
    assert.throws(() => {
      journal.recordCandidate({
        agentId: 'bot-1',
        utteranceId: u1.id,
        attempt: 1,
        text: 'Duplicate attempt 1',
        exactSha256: 'e1',
        textSha256: 't1',
        version: 1,
        selection: {},
        evidence: [],
        rules: {},
      });
    });

    // Attempt 2 succeeds
    const c1Attempt2 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u1.id,
      attempt: 2,
      text: 'Candidate 1 revised',
      exactSha256: 'e2',
      textSha256: 't2',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    assert.equal(c1Attempt2.attempt, 2);

    // Record review bound to candidate
    const rev = journal.recordReview({
      agentId: 'bot-1',
      utteranceId: u1.id,
      candidateId: c1.id,
      runId: 'run-1',
      attempt: 1,
      callNo: 1,
      sameAsAuthor: true,
      rules: {},
      verdict: 'revise',
      compilerVersion: '1',
      mappingVersion: '1',
      reviewerPromptVersion: '1',
      logicalCalls: 1,
    });
    assert.equal(rev.verdict, 'revise');

    // A review whose candidate belongs to another utterance is rejected
    assert.throws(() => {
      journal.recordReview({
        agentId: 'bot-1',
        utteranceId: u2.id, // u2
        candidateId: c1.id, // belongs to u1
        runId: 'run-1',
        attempt: 1,
        callNo: 1,
        sameAsAuthor: true,
        rules: {},
        verdict: 'pass',
        compilerVersion: '1',
        mappingVersion: '1',
        reviewerPromptVersion: '1',
        logicalCalls: 1,
      });
    }, CharacterJournalConflict);
  });

  it('the final candidate is the only one that counts for an admitted utterance', () => {
    const store = new AgentStore(':memory:');
    createTestAgent(store, 'bot-1');
    const journal = new CharacterJournal({ store });

    const u1 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const u2 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });

    const c1 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u1.id,
      attempt: 1,
      text: 'Candidate 1 attempt 1',
      exactSha256: 'e1',
      textSha256: 't1',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });

    const c1Attempt2 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u1.id,
      attempt: 2,
      text: 'Candidate 1 attempt 2',
      exactSha256: 'e2',
      textSha256: 't2',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });

    // admit with another utterance's candidate fails
    const c2 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u2.id,
      attempt: 1,
      text: 'Candidate for u2',
      exactSha256: 'e3',
      textSha256: 't3',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    assert.equal(journal.admit(u1.id, c2.id, 'passed'), false);

    // admit with attempt 2 sets final_candidate_id
    assert.equal(journal.admit(u1.id, c1Attempt2.id, 'passed'), true);
    const loaded = journal.get('bot-1', u1.id);
    assert.equal(loaded?.status, 'admitted');
    assert.equal(loaded?.finalCandidateId, c1Attempt2.id);
  });

  it('logical bytes count every character table\'s text columns per bot', () => {
    const store = new AgentStore(':memory:');
    createTestAgent(store, 'bot-1');
    const journal = new CharacterJournal({ store });

    const arabicText = 'مرحبا بالعالم 🌟'; // Unicode text
    const arabicBytes = Buffer.byteLength(arabicText, 'utf8');

    const u = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const c = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u.id,
      attempt: 1,
      text: arabicText,
      exactSha256: 'e1',
      textSha256: 't1',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });

    const bytes = journal.logicalBytes('bot-1');
    assert.ok(bytes >= arabicBytes, `Expected bytes >= ${arabicBytes}, got ${bytes}`);

    // Another bot has 0 bytes
    createTestAgent(store, 'bot-2');
    assert.equal(journal.logicalBytes('bot-2'), 0);
  });

  it('quota is exceeded only above 250 MiB including the preparation reserve', () => {
    const store = new AgentStore(':memory:');
    createTestAgent(store, 'bot-1');

    // Default quota is 250 MiB
    const defaultJournal = new CharacterJournal({ store });
    assert.equal(defaultJournal.quotaBytes, CHARACTER_QUOTA_BYTES);
    assert.equal(defaultJournal.quotaBytes, 262144000);
    assert.equal(defaultJournal.hasRoom('bot-1'), true);

    // Test exact boundary with custom small quota
    const smallQuota = 64 * 1024 + 100; // 64 KiB reserve + 100 bytes
    const customJournal = new CharacterJournal({ store, quotaBytes: smallQuota });
    assert.equal(customJournal.hasRoom('bot-1'), true); // 0 bytes used <= 100

    // Add utterance and candidate that pushes over 100 bytes
    const u = customJournal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    customJournal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u.id,
      attempt: 1,
      text: 'A'.repeat(500),
      exactSha256: 'e1',
      textSha256: 't1',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });

    // Now logical bytes > 500, so 500 + 64 KiB > smallQuota
    assert.equal(customJournal.hasRoom('bot-1'), false);
  });

  it('publish_id is unique and a second attempt on the same publish id fails', () => {
    const store = new AgentStore(':memory:');
    createTestAgent(store, 'bot-1');
    const journal = new CharacterJournal({ store });

    const u1 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const c1 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u1.id,
      attempt: 1,
      text: 'Candidate 1',
      exactSha256: 'e1',
      textSha256: 't1',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    journal.admit(u1.id, c1.id, 'passed');
    journal.markAttempted(u1.id, 'pub-shared', 'Text 1', 't1');

    const u2 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-2', op: 'post', version: 1 });
    const c2 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u2.id,
      attempt: 1,
      text: 'Candidate 2',
      exactSha256: 'e2',
      textSha256: 't2',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    journal.admit(u2.id, c2.id, 'passed');

    // A second attempt with the same publish_id throws due to UNIQUE constraint
    assert.throws(() => {
      journal.markAttempted(u2.id, 'pub-shared', 'Text 2', 't2');
    });
  });

  it('bots never read each other\'s journal rows', () => {
    const store = new AgentStore(':memory:');
    createTestAgent(store, 'bot-1');
    createTestAgent(store, 'bot-2');
    const journal = new CharacterJournal({ store });

    const u1 = journal.createUtterance({ agentId: 'bot-1', runId: 'run-1', op: 'post', version: 1 });
    const c1 = journal.recordCandidate({
      agentId: 'bot-1',
      utteranceId: u1.id,
      attempt: 1,
      text: 'Unique Text for Bot 1',
      exactSha256: 'e1',
      textSha256: 'hash-bot-1',
      version: 1,
      selection: {},
      evidence: [],
      rules: {},
    });
    journal.admit(u1.id, c1.id, 'passed');
    journal.markAttempted(u1.id, 'pub-1', 'Unique Text for Bot 1', 'hash-bot-1');
    journal.project(u1.id, { status: 'confirmed', postUrl: 'https://x.com/post/1' });

    // bot-2 cannot get bot-1's utterance
    assert.equal(journal.get('bot-2', u1.id), null);

    // unresolved is bot-scoped
    const u2 = journal.createUtterance({ agentId: 'bot-2', runId: 'run-2', op: 'post', version: 1 });
    assert.equal(journal.unresolved('bot-1').length, 0); // u1 is confirmed
    assert.equal(journal.unresolved('bot-2').length, 1);
    assert.equal(journal.unresolved('bot-2')[0].id, u2.id);

    // confirmedTexts is bot-scoped
    assert.equal(journal.confirmedTexts('bot-1', 10).length, 1);
    assert.equal(journal.confirmedTexts('bot-2', 10).length, 0);

    // isConfirmedDuplicate is bot-scoped
    assert.equal(journal.isConfirmedDuplicate('bot-1', 'hash-bot-1'), true);
    assert.equal(journal.isConfirmedDuplicate('bot-2', 'hash-bot-1'), false);
  });
});
