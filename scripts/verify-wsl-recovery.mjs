/** Opt-in real stopped-engine check. Refuses to stop an engine with containers. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWsl, hasWslDockerEngine } from '../desktop/src/wsl-docker.mjs';
import { SandboxSetup } from '../desktop/src/sandbox-setup.mjs';
import { preserveDockerTransport } from '../desktop/src/docker-transport.mjs';
import { probeDocker } from '../dist/src/daemon/docker-status.js';
import { resolveDockerHost } from '../dist/src/kernel/docker-host.js';

assert.ok(process.argv.includes('--restart-idle-engine'), 'Explicit --restart-idle-engine is required.');
const distro = process.env.OPENHOURS_WSL_DISTRO;
assert.ok(distro, 'Select the actual saved WSL transport.');
assert.equal(await hasWslDockerEngine(distro), true);
const docker = args => runWsl(['-d', distro, '--exec', 'docker', ...args]);
const running = await docker(['ps', '-q']);
assert.equal(running.code, 0);
assert.equal(running.stdout.trim(), '', 'Refusing to stop an engine with running containers.');
const identity = await docker(['info', '--format', '{{.ID}}']);
assert.equal(identity.code, 0);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-wsl-recovery-'));
fs.writeFileSync(path.join(directory, 'desktop-docker.json'), JSON.stringify({ legacyWsl: true }));
const env = {};
const host = resolveDockerHost({ ...process.env, OPENHOURS_WSL_DISTRO: distro });
const probe = () => probeDocker(host, 5000, true);
const statuses = [];
try {
  const stopped = await runWsl(['-d', distro, '--user', 'root', '--exec', 'systemctl', 'stop', 'docker.service', 'docker.socket']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.notEqual((await probe()).state, 'running');
  await preserveDockerTransport({ directory, previousVersion: '0.3.9', env, probeLegacy: probe,
    probeNative: () => { throw new Error('Must not switch away from the existing local service.'); } });
  assert.equal(env.OPENHOURS_WSL_DISTRO, distro);
  const started = Date.now();
  const setup = new SandboxSetup({ directory, env, probe, onStatus: s => statuses.push({ state: s.state, message: s.message }),
    dependencies: { ensure: () => { throw new Error('Must not start the unrelated Docker Desktop engine.'); } } });
  assert.equal((await setup.run()).state, 'running');
  assert.equal((await docker(['info', '--format', '{{.ID}}'])).stdout.trim(), identity.stdout.trim());
  const work = await docker(['run', '--rm', 'alpine:3.20', 'sh', '-c', 'printf recovery-ok']);
  assert.equal(work.code, 0, work.stderr);
  assert.equal(work.stdout, 'recovery-ok');
  console.log(JSON.stringify({ status: 'PASS', at: new Date().toISOString(), elapsedMs: Date.now() - started, checks: [
    'no running containers before stopping', 'engine proved stopped', 'saved WSL transport retained',
    'production automatic setup started the existing service', 'same engine identity preserved', 'new container executed after recovery'], statuses }, null, 2));
} finally {
  // Never leave the user's engine stopped, even if a check fails.
  const restored = await runWsl(['-d', distro, '--user', 'root', '--exec', 'systemctl', 'start', 'docker.service']);
  assert.equal(restored.code, 0, restored.stderr);
}
