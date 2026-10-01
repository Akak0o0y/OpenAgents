import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';

test('text edits persist with stable download IDs and reject stale saves', () => {
  const store = new AgentStore(':memory:');
  try {
    store.createAgent({ id: 'editor', name: 'Editor', model_id: 'test', budget_cap_usd: 1, current_status: 'IDLE' });
    const run = store.createTaskRun({ agentId: 'editor', taskName: 'chat:test' });
    const files = new ArtifactStore(store);
    const artifact = files.save(run.id, { 'report.html': '<h1>Original</h1>' })[0];
    assert.throws(() => files.edit(run.id, 'report.html', 'x', '<h1>Original</h1>'), /finish/);
    store.startTaskRun(run.id, 'test');
    store.finishTaskRun(run.id, 'COMPLETED', 'Original verification');
    files.edit(run.id, 'report.html', '<h1>Edited</h1>', '<h1>Original</h1>');
    assert.equal(files.read(run.id, artifact.id)?.content, '<h1>Edited</h1>');
    assert.equal(files.list(run.id)[0].id, artifact.id);
    assert.notEqual(files.list(run.id)[0].sha256, artifact.sha256);
    assert.throws(() => files.edit(run.id, 'report.html', 'stale overwrite', '<h1>Original</h1>'), /changed/);
    assert.throws(() => files.edit(run.id, '../report.html', 'bad', ''), /relative/);
    assert.throws(() => files.edit(run.id, 'report.html', 'x'.repeat(256 * 1024 + 1), '<h1>Edited</h1>'), /256 KiB/);
    assert.throws(() => new ArtifactStore(store, 10).edit(run.id, 'report.html', 'x'.repeat(20), '<h1>Edited</h1>'), /storage limit/);
    files.saveBinary(run.id, { 'photo.png': Buffer.from([1, 2]) });
    assert.throws(() => files.edit(run.id, 'photo.png', 'oops', 'AQI='), /Binary/);
    files.saveEvidence(run.id, 'evidence.png', Buffer.from([1, 2]));
    assert.throws(() => files.edit(run.id, 'evidence.png', 'oops', 'AQI='), /evidence/);
    assert.equal(files.read(run.id, artifact.id)?.content, '<h1>Edited</h1>');
  } finally { store.close(); }
});
