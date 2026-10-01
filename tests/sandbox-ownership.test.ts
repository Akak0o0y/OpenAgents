import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { dockerArgv } from '../src/kernel/docker-host.js';

test('Docker sweep only removes its own temporary resources and preserves retained work', { timeout: 60_000 }, async () => {
  const a = new DockerSandbox(); const b = new DockerSandbox();
  const own = await a.createWorkspaceVolume('ownership-temporary');
  const other = await b.createWorkspaceVolume('ownership-other');
  const retained = await a.createWorkspaceVolume('task-retained');
  try {
    await a.orphanSweep({ forceAll: true });
    assert.equal(await a.workspaceVolumeExists(own), false);
    assert.equal(await b.workspaceVolumeExists(other), true);
    assert.equal(await a.workspaceVolumeExists(retained), true);
  } finally {
    await a.destroyWorkspaceVolume(own); await a.destroyWorkspaceVolume(retained); await b.destroyWorkspaceVolume(other);
  }
});

test('aborting an active Docker command stops its container and retains the workspace', { timeout: 60_000 }, async () => {
  const owner = randomUUID(); const sandbox = new DockerSandbox(undefined, owner);
  const label = `label=openhours-owner=${createHash('sha256').update(owner).digest('hex').slice(0, 16)}`;
  const list = () => { const argv = dockerArgv(['ps', '-aq', '--filter', label]); return execFileSync(argv.command, argv.args, { encoding: 'utf8', timeout: 10_000 }).trim(); };
  const volume = await sandbox.createWorkspaceVolume('task-cancellation'); const controller = new AbortController();
  const pending = sandbox.executeTask(volume, 'sleep 120', { signal: controller.signal, timeoutMs: 150_000 });
  try {
    const deadline = Date.now() + 15_000;
    while (!list() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(list(), 'negative control: the container must actually be running');
    const start = Date.now(); controller.abort();
    const result = await pending;
    assert.equal(result.exitCode, 130);
    assert.ok(Date.now() - start < 15_000, 'cancellation must not wait for the command timeout');
    assert.equal(list(), '', 'no container may survive cancellation');
    assert.equal(await sandbox.workspaceVolumeExists(volume), true);
  } finally { controller.abort(); await pending; await sandbox.destroyWorkspaceVolume(volume); }
});
