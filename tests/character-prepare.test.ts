import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CharacterStore } from '../src/daemon/character-store.js';
import { CharacterJournal } from '../src/daemon/character-journal.js';
import { CharacterAdmissions, exactSha256 } from '../src/daemon/character-admission.js';
import { CharacterProjector } from '../src/daemon/character-projector.js';
import { createPreparePost, characterToolEvent, type PreparePostCall, type PreparePostRun } from '../src/daemon/character-prepare.js';

const review = { verdict: 'pass', scores: { voice: 5, fit: 4, consistency: 5 }, findings: [], extracted: { claims: [], stances: [], relations: [] } };
const usage = { logicalCalls: 1, wireAttempts: 1, inputTokens: 10, outputTokens: 5, cachedTokens: null, costUsd: 0.001 } as const;
function fixture(outputs: unknown[]) {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'a', name: 'Milo', model_id: 'gpt-4o', fallback_model_id: 'gpt-4o-mini', current_status: 'IDLE', budget_cap_usd: 10 });
  const character = new CharacterStore(store);
  character.save('a', 0, { settings: { mode: 'voice' }, document: { identity: { oneLine: 'A careful writer.' }, purpose: { statement: 'Explain clearly.' },
    voice: { examples: ['One clear example.', 'Another useful observation.', 'A third careful example.'].map((text, i) => ({ id: `ex-${i}`, text, surface: 'post', pinned: i < 2, tags: [], origin: 'owner' })) } } });
  const journal = new CharacterJournal({ store });
  const admissions = new CharacterAdmissions({ store, journal, activeVersion: id => character.getLatestVersion(id) });
  const projector = new CharacterProjector({ store, journal });
  const calls: PreparePostCall[] = [], events: Array<{ type: string; payload: unknown }> = [], charged: unknown[] = [];
  const service = createPreparePost({ store, character, journal, admissions, projector, call: async req => {
    calls.push(req); const value = outputs.shift(); if (value instanceof Error) throw value;
    return { content: JSON.stringify(value), usage: { ...usage } };
  } });
  const run: PreparePostRun = { runId: 'r', agentId: 'a', kind: 'owner-chat', signal: new AbortController().signal,
    seed: 'fixed', asOf: Date.now(), owner: { request: 'post this exact unique sentence', history: [] },
    evidence: { runId: 'r', kind: 'owner-chat', sources: [], captures: new Map(), restoredIds: new Set(), requestId: 'request', sourceLimit: 12 },
    emit: (type, payload) => events.push({ type, payload }), charge: u => charged.push(u) };
  return { store, character, journal, admissions, service, run, calls, events, charged };
}
test('preparation records immutable candidates, review provenance, charged usage and exact admission without event text', async t => {
  const text = 'A small clear thought.';
  const h = fixture([{ text, citedEvidenceIds: [] }, review]); t.after(() => h.store.close());
  const out = await h.service.prepare(h.run, { tool: 'prepare_post', op: 'post', about: 'A PRIVATE topic' });
  assert.equal(out.ok, true); assert.equal(out.text, text);
  const u = h.journal.get('a', String(out.utteranceId))!;
  assert.equal(u.status, 'admitted'); assert.equal(u.logicalCalls, 2);
  assert.equal(h.journal.candidates(u.id).length, 1);
  const r = h.journal.reviews(u.id)[0]; assert.equal(r.reviewerModel, 'gpt-4o-mini'); assert.equal(r.sameAsAuthor, false);
  assert.equal(r.candidateId, u.finalCandidateId);
  assert.equal(h.admissions.liveFor('r')?.exactSha256, exactSha256(text));
  assert.equal(h.calls.length, 2); assert.equal(h.charged.length, 2);
  assert.deepEqual(h.events.map(e => e.type), ['CHARACTER_COMPOSED', 'CHARACTER_REVIEWED', 'CHARACTER_ADMITTED']);
  const serialized = JSON.stringify([h.events, characterToolEvent('prepare_post', out)]);
  for (const secret of [text, 'A PRIVATE topic']) assert.ok(!serialized.includes(secret));
  assert.equal(h.calls[0].maxTokens, 512); assert.equal(h.calls[1].maxTokens, 768);
  h.admissions.invalidateRun('r', 'run-ended');
});
test('unknown citations reask once and cannot issue admission', async t => {
  const h = fixture([{ text: 'bad citation', citedEvidenceIds: ['forged'] }, { text: 'bad citation', citedEvidenceIds: ['forged'] }]); t.after(() => h.store.close());
  const out = await h.service.prepare(h.run, { tool: 'prepare_post', op: 'post', about: 'test' });
  assert.equal(out.held, 'compose-failed'); assert.equal(h.calls.length, 2); assert.equal(h.admissions.liveFor('r'), undefined);
});
test('owner exact path is rules-only and routine dictation or unbound replies never call a model', async t => {
  const h = fixture([]); t.after(() => h.store.close());
  const action = { tool: 'prepare_post' as const, op: 'post' as const, about: 'test', exact: 'exact unique sentence' };
  const out = await h.service.prepare(h.run, action); assert.equal(out.semantic, 'out-of-scope'); assert.equal(out.ok, true);
  h.admissions.invalidateRun('r', 'run-ended');
  const bad = await h.service.prepare({ ...h.run, runId: 'r2', kind: 'routine' }, action); assert.equal(bad.held, 'exact-not-owner');
  const reply = await h.service.prepare({ ...h.run, runId: 'r3' }, { tool: 'prepare_post', op: 'reply', about: 'test', replyTo: { url: 'https://x.com/u/status/123', sourceId: 'missing' } });
  assert.equal(reply.held, 'target-unbound'); assert.equal(h.calls.length, 0);
});
test('revision is reviewed separately and known failures never become an outage pass', async t => {
  const h = fixture([{ text: 'first thought', citedEvidenceIds: [] }, { ...review, findings: [{ code: 'NEVER_LINE', severity: 'block', reason: 'No' }] },
    { text: 'second thought', citedEvidenceIds: [] }, { ...review, scores: { ...review.scores, voice: 1 } }]); t.after(() => h.store.close());
  const out = await h.service.prepare(h.run, { tool: 'prepare_post', op: 'post', about: 'test' });
  assert.equal(out.ok, false); assert.equal(out.held, 'semantic-failed'); assert.equal(h.calls.length, 4);
  assert.equal(h.journal.candidates(String(out.utteranceId)).length, 2); assert.equal(h.journal.reviews(String(out.utteranceId)).length, 2);
});
const runContext = () => ({ logicalCalls: 0, preparations: 0, deadlineAt: Date.now() + 600_000, taskIdentity: null, currentCandidate: null, currentAdmission: null });
// Live on 2026-10-01: two drafts citing sources the run never captured spent the run's whole allowance
// without a single model call, and every later draft came back "Draft held." with nothing left to fix.
test('drafts held before any model call do not use up the run\'s two-draft allowance', async t => {
  const text = 'A small clear thought.';
  const h = fixture([{ text, citedEvidenceIds: [] }, review]); t.after(() => h.store.close());
  const context = runContext(), run = { ...h.run, context };
  for (const id of ['src-1', 'src-2']) assert.equal((await h.service.prepare(run, { tool: 'prepare_post', op: 'post', about: 'test', evidence: [id] })).held, 'evidence-missing');
  assert.deepEqual([h.calls.length, context.preparations], [0, 0], 'held drafts called no model and spent no allowance');
  const out = await h.service.prepare(run, { tool: 'prepare_post', op: 'post', about: 'A PRIVATE topic' });
  assert.equal(out.ok, true, String(out.summary)); assert.equal(out.text, text);
  assert.equal(context.preparations, 1);
  h.admissions.invalidateRun('r', 'run-ended');
});
test('a held draft says what to fix, or that the run has no drafts left and nothing was sent', async t => {
  const h = fixture([]); t.after(() => h.store.close());
  const missing = await h.service.prepare(h.run, { tool: 'prepare_post', op: 'post', about: 'test', evidence: ['src-9'] });
  assert.match(String(missing.summary), /src-9/);
  assert.match(String(missing.summary), /captured/);
  const spent = await h.service.prepare({ ...h.run, context: { ...runContext(), preparations: 2 } }, { tool: 'prepare_post', op: 'post', about: 'test' });
  assert.equal(spent.held, 'cap-reached');
  assert.match(String(spent.summary), /Nothing was (sent|posted)/);
  assert.match(String(spent.next_actions), /do not post/i);
});
