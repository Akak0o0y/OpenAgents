import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CharacterStore } from '../src/daemon/character-store.js';
import { characterApi } from '../src/daemon/character-api.js';

function fixture() {
  const store = new AgentStore(':memory:');
  for (const id of ['a', 'b']) store.createAgent({ id, name: id, model_id: 'gpt-4o-mini', budget_cap_usd: 10, current_status: 'IDLE', system_prompt: 'You are a patient teacher. Keep every line of this Description.' });
  const characters = new CharacterStore(store);
  const api = characterApi({ store, characters });
  const call = (method: string, suffix = '', body?: unknown) => api(method, new URL('http://localhost/api/system/character' + suffix), body);
  return { store, characters, call };
}

test('exact character paths return defaults, bounded history and selected bot-owned versions', async t => {
  const { store, characters, call } = fixture(); t.after(() => store.close());
  const initial = await call('GET', '?agent=a');
  assert.equal(initial.status, 200);
  assert.equal((initial.body as any).version, 0);
  assert.equal((initial.body as any).settings.mode, 'off');
  assert.equal((initial.body as any).openProposal, null);
  characters.save('a', 0, { document: { notes: 'hidden note' } });
  const history = await call('GET', '?agent=a&versions=1&version=1');
  assert.equal((history.body as any).versions.length, 1);
  assert.equal((history.body as any).selected.document.notes, 'hidden note');
  assert.equal((await call('GET', '?agent=b&version=1')).status, 404);
  assert.equal((await call('GET', '?agent=a&versions=51')).status, 400);
  assert.equal((await call('GET', '?agent=a&versions=1.5')).status, 400);
  assert.equal((await call('GET', '-extra?agent=a')).status, 404);
  assert.equal((await call('POST', '?agent=a')).status, 405);
});

test('save merges hidden fields, enforces CAS, rejects forged server fields and wrong source ownership', async t => {
  const { store, characters, call } = fixture(); t.after(() => store.close());
  characters.save('a', 0, { document: { notes: 'keep me' } });
  const saved = await call('POST', '-save', { agentId: 'a', baseVersion: 1, document: { identity: { name: 'Milo' } } });
  assert.equal(saved.status, 200);
  assert.equal(characters.getLatestVersion('a')?.document.notes, 'keep me');
  assert.equal((await call('POST', '-save', { agentId: 'a', baseVersion: 1 })).status, 409);
  for (const document of [{ version: 9 }, { schema: 'forged' }, { personality: { mappingVersion: 'forged' } }]) {
    assert.equal((await call('POST', '-save', { agentId: 'a', baseVersion: 2, document })).status, 400);
  }
  assert.equal((await call('POST', '-save', { agentId: 'a', baseVersion: 2, document: { voice: { examples: [
    { id: 'bad', text: 'example', surface: 'chat', pinned: false, tags: [], origin: 'owner', sourceId: 'foreign-source' },
  ] } } })).status, 400);
  const reverted = await call('POST', '-revert', { agentId: 'a', baseVersion: 2, toVersion: 1 });
  assert.equal(reverted.status, 200);
  assert.equal(characters.getLatestVersion('a')?.version, 3);
});

test('compile validates ephemeral sources, returns deterministic inputs and never saves a draft', async t => {
  const { store, characters, call } = fixture(); t.after(() => store.close());
  const body = { agentId: 'a', surface: 'owner-chat', document: { notes: 'unsaved' },
    sources: [{ handle: 'draft:one', kind: 'sample', text: 'example' }], query: 'hello', seed: 'fixed', asOf: '2026-09-25T00:00:00.000Z' };
  const first = await call('POST', '-compile', body);
  const second = await call('POST', '-compile', body);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(characters.getLatestVersion('a'), null);
  assert.equal(characters.getSources('a').length, 0);
  assert.equal(store.listTaskRuns().length, 0);
  assert.equal((await call('POST', '-compile', { ...body, sources: [...body.sources, ...body.sources] })).status, 400);
  assert.equal((await call('POST', '-preview', { agentId: 'missing', situation: { type: 'post', about: 'test' } })).status, 404);
});
