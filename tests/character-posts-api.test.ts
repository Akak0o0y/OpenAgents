import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CharacterStore } from '../src/daemon/character-store.js';
import { CharacterJournal } from '../src/daemon/character-journal.js';
import { characterApi } from '../src/daemon/character-api.js';
import { exactSha256 } from '../src/daemon/character-admission.js';
import { textSha256 } from '../src/daemon/publish-probes.js';

test('posts APIs enforce pagination, ownership, final-review metrics and CAS promotion', async t => {
  const store = new AgentStore(':memory:'); t.after(() => store.close());
  for (const id of ['a', 'b']) store.createAgent({ id, name: id, model_id: 'gpt-4o', budget_cap_usd: 10, current_status: 'IDLE' });
  const characters = new CharacterStore(store), journal = new CharacterJournal({ store, now: () => 1234 });
  characters.save('a', 0, { document: { notes: 'preserve' } });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const u = journal.createUtterance({ agentId: 'a', runId: 'r', op: 'post', version: 1 }); ids.push(u.id);
    const text = `Example ${i}`;
    const c = journal.recordCandidate({ agentId: 'a', utteranceId: u.id, attempt: 1, text, exactSha256: exactSha256(text), textSha256: textSha256(text), version: 1, selection: {}, evidence: [], rules: {} });
    journal.recordReview({ agentId: 'a', runId: 'r', utteranceId: u.id, candidateId: c.id, attempt: 1, callNo: 2,
      reviewerModel: 'gpt-4o', sameAsAuthor: true, rules: {}, verdict: 'pass', scores: { voice: 4, fit: 3, consistency: 5 },
      compilerVersion: '1', mappingVersion: '1', reviewerPromptVersion: '1', logicalCalls: 1, costUsd: null });
    journal.admit(u.id, c.id, i === 2 ? 'unchecked-unavailable' : 'passed');
    if (i < 2) { journal.markAttempted(u.id, `p${i}`, text, textSha256(text)); journal.project(u.id, { status: 'confirmed' }); }
  }
  const api = characterApi({ store, characters, journal });
  const get = (suffix: string) => api('GET', new URL('http://localhost/api/system/character-' + suffix));
  const page = await get('posts?agent=a&limit=2'); assert.equal(page.status, 200);
  const first = page.body as any; assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = (await get('posts?agent=a&limit=2&cursor=' + encodeURIComponent(first.nextCursor))).body as any;
  assert.equal(second.items.length, 1); assert.equal(new Set([...first.items, ...second.items].map(p => p.id)).size, 3);
  assert.equal((await get('posts?agent=a&limit=51')).status, 400);
  assert.equal((await get('posts?agent=a&cursor=garbage')).status, 400);
  assert.equal((await get(`post?agent=b&id=${ids[0]}`)).status, 404);
  const detail = (await get(`post?agent=a&id=${ids[0]}`)).body as any;
  assert.equal(detail.candidates[0].reviews.length, 1);
  const metrics = (await get('metrics?agent=a&version=1')).body as any;
  assert.equal(metrics.n, 2); assert.equal(metrics.mean.voice, 4); assert.equal(metrics.coverage.pending, 1);
  const promote = (baseVersion: number) => api('POST', new URL('http://localhost/api/system/character-promote'), { agentId: 'a', baseVersion, utteranceId: ids[0] });
  assert.equal((await promote(1)).status, 200); assert.equal((await promote(1)).status, 409);
  assert.equal(characters.getLatestVersion('a')?.document.voice.examples[0].origin, 'promoted');
  assert.equal(characters.getLatestVersion('a')?.document.notes, 'preserve');
});
