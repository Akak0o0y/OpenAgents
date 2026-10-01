import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureWslDocker } from '../src/wsl-docker.mjs';

test('starts only the fixed Docker service in the selected distro, then verifies the engine', async () => {
  const calls = []; let probes = 0;
  const result = await ensureWslDocker({ distro: 'Ubuntu-22.04',
    run: async args => { calls.push(args); return { code: 0, stdout: calls.length === 1 ? 'loaded\n' : '', stderr: '' }; },
    probe: async () => ({ state: ++probes === 1 ? 'stopped' : 'running' }), sleep: async () => {} });
  assert.equal(result.state, 'running');
  assert.deepEqual(calls[1], ['-d', 'Ubuntu-22.04', '--user', 'root', '--exec', 'systemctl', 'start', 'docker.service']);
  assert.equal(probes, 2);
});

test('Docker Desktop integration without a local service is not treated as a local engine', async () => {
  const result = await ensureWslDocker({ distro: 'Ubuntu', run: async () => ({ code: 0, stdout: 'not-found' }), probe: () => { throw new Error('must not probe'); } });
  assert.equal(result, null);
});

test('failed startup returns the real service error, not a false running result', async () => {
  let calls = 0;
  const result = await ensureWslDocker({ distro: 'Ubuntu', run: async () => ++calls === 1 ? { code: 0, stdout: 'loaded' } : { code: 1, stderr: 'Job failed' }, probe: async () => ({ state: 'stopped' }) });
  assert.equal(result.state, 'setup-failed');
  assert.equal(result.detail, 'Job failed');
});
