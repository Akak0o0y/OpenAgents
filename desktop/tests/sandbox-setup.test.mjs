import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SandboxSetup, downloadInstaller, supportedWindows, wslIsCurrent } from '../src/sandbox-setup.mjs';
import { preserveDockerTransport } from '../src/docker-transport.mjs';

const healthy = { state: 'running', message: 'Docker is running.', version: '29' };
const missing = { state: 'not-installed', message: 'Missing' };
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-setup-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], statuses = [];
  let installed = false;
  const facts = { build: 26200, server: false, ram: 16 * 1024 ** 3, virtualization: true, boot: 'boot-1' };
  const dependencies = {
    facts: async () => facts,
    run: async () => ({ code: 0, stdout: 'WSL version: 2.6.0' }),
    wsl: async () => { calls.push('wsl'); return { code: 0 }; },
    download: async () => { calls.push('download'); return 'installer.exe'; },
    verify: async () => { calls.push('verify'); },
    install: async () => { calls.push('install'); installed = true; return { code: 0 }; },
    find: () => installed ? 'docker.exe' : null,
    ensure: async () => { calls.push('start'); return { status: healthy }; },
    ensureWsl: async () => null,
    ...overrides,
  };
  const options = { directory, probe: async () => missing, onStatus: status => statuses.push(status), platform: 'win32', arch: 'x64', dependencies };
  return { options, setup: new SandboxSetup(options), calls, statuses, facts };
}
// CI's macOS runners are arm64: reading the host's architecture blocked every fixture as "not an x64 computer".
test('the computer architecture comes from the setup options, not the machine running the setup code', async t => {
  const f = fixture(t);
  assert.equal((await new SandboxSetup({ ...f.options, arch: 'arm64' }).run()).state, 'setup-blocked');
  assert.deepEqual(f.calls, []);
});
test('missing Docker is downloaded, verified, installed and started without a terminal', async t => {
  const f = fixture(t);
  assert.equal((await f.setup.run()).state, 'running');
  assert.deepEqual(f.calls, ['download', 'verify', 'install', 'start']);
  assert.ok(f.statuses.some(s => s.state === 'installing'));
  assert.deepEqual(f.setup.saved, {});
});
test('untrusted installer never executes and failure is durable until retry', async t => {
  const f = fixture(t, { verify: async () => { throw new Error('Invalid signature'); } });
  assert.equal((await f.setup.run()).state, 'setup-failed');
  assert.ok(!f.calls.includes('install'));
  await new SandboxSetup(f.options).run();
  assert.deepEqual(f.calls, ['download']);
});
test('no Docker installation or elevation when automatic setup is disabled', async t => {
  const f = fixture(t);
  assert.equal((await f.setup.run({ automatic: false })).state, 'not-installed');
  assert.deepEqual(f.calls, []);
});
test('a running engine does not install, download or change anything', async t => {
  const f = fixture(t);
  const setup = new SandboxSetup({ ...f.options, probe: async () => healthy });
  assert.equal((await setup.run()).state, 'running');
  assert.deepEqual(f.calls, []);
});
test('a saved custom transport starts Docker Desktop automatically', async t => {
  const f = fixture(t, { find: () => 'Docker Desktop.exe' });
  const setup = new SandboxSetup({ ...f.options, env: { OPENHOURS_WSL_DISTRO: 'Ubuntu-22.04' } });
  assert.equal((await setup.run()).state, 'running');
  assert.deepEqual(f.calls, ['start']);
});
test('a saved custom transport is not replaced when its engine cannot start', async t => {
  const f = fixture(t, { find: () => null });
  const setup = new SandboxSetup({ ...f.options, env: { OPENHOURS_WSL_DISTRO: 'Ubuntu-22.04' } });
  const status = await setup.run();
  assert.equal(status.state, 'setup-blocked');
  assert.match(status.message, /keep checking automatically/);
  assert.deepEqual(f.calls, []);
});
test('WSL reboot persists, does not repeat elevation, and resumes after a new boot', async t => {
  let ready = false;
  const f = fixture(t, { run: async () => ({ code: ready ? 0 : 1, stdout: ready ? '2.6.0' : '' }), wsl: async () => ({ code: 3010 }) });
  assert.equal((await f.setup.run()).state, 'restart-required');
  assert.equal((await new SandboxSetup(f.options).run({ retry: true })).state, 'restart-required');
  assert.deepEqual(f.calls, []);
  f.facts.boot = 'boot-2'; ready = true;
  assert.equal((await new SandboxSetup(f.options).run()).state, 'running');
});
test('cancelled Windows permission pauses setup without retrying prompts on relaunch', async t => {
  let requests = 0;
  const f = fixture(t, { run: async () => ({ code: 1, stdout: '' }), wsl: async () => { requests++; return { code: 1223 }; } });
  assert.equal((await f.setup.run()).state, 'setup-paused');
  await new SandboxSetup(f.options).run();
  assert.equal(requests, 1);
  await new SandboxSetup(f.options).run({ retry: true });
  assert.equal(requests, 2);
});
test('parallel setup requests share one installation', async t => {
  const f = fixture(t);
  await Promise.all([f.setup.run(), f.setup.run(), f.setup.run({ retry: true })]);
  assert.equal(f.calls.filter(c => c === 'install').length, 1);
});
test('download failure and insufficient hardware stay actionable without installing', async t => {
  const f = fixture(t, { download: async () => { throw new Error('Offline'); } });
  assert.match((await f.setup.run()).message, /Offline/);
  assert.deepEqual(f.calls, []);
  f.facts.virtualization = false;
  assert.match((await f.setup.run({ retry: true })).message, /firmware/);
  assert.equal(supportedWindows({ ...f.facts, ram: 4 * 1024 ** 3 }), 'The local sandbox needs at least 8 GB of memory. Chat is available on this computer.');
});
test('WSL version minimum is checked numerically', () => {
  assert.equal(wslIsCurrent({ code: 0, stdout: 'WSL: 2.1.4' }), false);
  assert.equal(wslIsCurrent({ code: 0, stdout: 'WSL: 2.1.5' }), true);
  assert.equal(wslIsCurrent({ code: 0, stdout: 'WSL: 2.10.0' }), true);
  assert.equal(wslIsCurrent({ code: 1, stdout: '2.6.0' }), false);
});
test('installed WSL with the VM feature disabled still prepares Windows', async t => {
  const f = fixture(t);
  f.facts.vmpEnabled = false;
  assert.equal((await f.setup.run()).state, 'running');
  assert.equal(f.calls[0], 'wsl');
});
test('download rejects untrusted redirects and partial bytes, and removes partial files', async t => {
  const f = fixture(t);
  await assert.rejects(downloadInstaller(f.options.directory, () => {}, async () => new Response(null, { status: 302, headers: { location: 'https://example.com/installer.exe' } })), /trusted/);
  await assert.rejects(downloadInstaller(f.options.directory, () => {}, async () => new Response('small', { headers: { 'content-length': '5000' } })), /incomplete/);
  assert.equal(fs.existsSync(path.join(f.options.directory, 'Docker-Desktop-Installer.exe.partial')), false);
});
test('existing profile keeps its Docker engine across the upgrade; fresh profiles use native', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); const env = {};
  await preserveDockerTransport({ directory: f.options.directory, previousVersion: undefined, probeLegacy: async () => healthy, probeNative: async () => healthy, env });
  assert.equal(env.OPENHOURS_WSL_DISTRO, undefined);
  fs.writeFileSync(path.join(f.options.directory, 'openhours.db'), 'fixture');
  await preserveDockerTransport({ directory: f.options.directory, previousVersion: '0.3.6', probeLegacy: async () => healthy, probeNative: async () => missing, env });
  assert.equal(env.OPENHOURS_WSL_DISTRO, 'Ubuntu-22.04');
  const next = {};
  await preserveDockerTransport({ directory: f.options.directory, previousVersion: '0.3.7', probeLegacy: async () => healthy, probeNative: async () => missing, env: next });
  assert.equal(next.OPENHOURS_WSL_DISTRO, 'Ubuntu-22.04');
});

test('an old timed-out WSL guess falls back to native Docker and repairs itself when native answers', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); const file = path.join(f.options.directory, 'desktop-docker.json');
  fs.writeFileSync(file, JSON.stringify({ legacyWsl: true }));
  const env = {};
  await preserveDockerTransport({
    directory: f.options.directory,
    previousVersion: '0.3.9',
    inspectLegacy: async () => false,
    probeLegacy: async () => ({ ...missing, state: 'unknown' }),
    probeNative: async () => healthy,
    env,
  });
  assert.equal(env.OPENHOURS_WSL_DISTRO, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { legacyWsl: false });
});

test('a saved WSL timeout does not force the failing transport during a Docker cold start', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); const file = path.join(f.options.directory, 'desktop-docker.json');
  fs.writeFileSync(file, JSON.stringify({ legacyWsl: true }));
  const env = {};
  await preserveDockerTransport({
    directory: f.options.directory,
    previousVersion: '0.3.9',
    inspectLegacy: async () => false,
    probeLegacy: async () => ({ ...missing, state: 'unknown' }),
    probeNative: async () => ({ ...missing, state: 'unknown' }),
    env,
  });
  assert.equal(env.OPENHOURS_WSL_DISTRO, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { legacyWsl: true });
});

test('a stopped local WSL service retains its engine and starts it instead of Docker Desktop', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t, { ensureWsl: async ({ distro }) => { assert.equal(distro, 'Ubuntu-22.04'); f.calls.push('start-wsl'); return healthy; } });
  fs.writeFileSync(path.join(f.options.directory, 'desktop-docker.json'), JSON.stringify({ legacyWsl: true }));
  const env = {};
  await preserveDockerTransport({ directory: f.options.directory, previousVersion: '0.3.9', env,
    probeLegacy: async () => ({ state: 'stopped' }), probeNative: async () => healthy, inspectLegacy: async () => true });
  assert.equal(env.OPENHOURS_WSL_DISTRO, 'Ubuntu-22.04');
  assert.equal((await new SandboxSetup({ ...f.options, env }).run()).state, 'running');
  assert.deepEqual(f.calls, ['start-wsl']);
});

test('a failed local WSL service never switches engines or claims Desktop started', async t => {
  const f = fixture(t, { ensureWsl: async () => ({ state: 'setup-failed', message: 'Local service failed' }) });
  const setup = new SandboxSetup({ ...f.options, env: { OPENHOURS_WSL_DISTRO: 'Ubuntu-22.04' } });
  assert.equal((await setup.run()).message, 'Local service failed');
  assert.deepEqual(f.calls, []);
});
