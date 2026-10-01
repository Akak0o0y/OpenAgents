/**
 * The desktop app, for someone who will never open a terminal.
 *
 * Each test is a situation a real installation meets: a port somebody else
 * holds, a daemon that crashes, one that cannot run at all, Docker switched
 * off, a database opened by a different version, a log with a key in it.
 * Supervisor tests use real child processes and real sockets, because the
 * failure modes being guarded are exactly the ones a fake would not have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { canBind, choosePort, DESKTOP_DEFAULT_PORT, FALLBACK_RANGE } from '../src/ports.mjs';
import { DEFAULT_SETTINGS, sanitizeSettings, settingsStore, stateStore } from '../src/settings.mjs';
import { LogFile, diagnosticsReport, redact } from '../src/logs.mjs';
import { backupDatabase, clearStaleStartupClaim, compareVersions, versionTransition } from '../src/backup.mjs';
import { dockerDesktopCandidates, ensureDocker } from '../src/docker-desktop.mjs';
import { DaemonSupervisor, explainFailure } from '../src/daemon.mjs';

const temporary = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
/** A program holding a port: accepts connections and never answers them. */
const listen = (port = 0) => new Promise((resolve, reject) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.sockets = sockets;
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});
// close() waits for open connections, and health probes left some hanging on
// a server that never replies.
const close = (server) => new Promise((resolve) => {
  for (const socket of server.sockets ?? []) socket.destroy();
  server.close(resolve);
});
async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ ports ---

test('the default and fallback ports stay below the range Windows uses for outgoing connections', () => {
  assert.ok(DESKTOP_DEFAULT_PORT < 49152);
  assert.notEqual(DESKTOP_DEFAULT_PORT, 4001);
  assert.ok(FALLBACK_RANGE.max < 49152 && FALLBACK_RANGE.min > 1024);
});

test('a port another program listens on cannot be bound; a released one can', async () => {
  const server = await listen();
  const { port } = server.address();
  assert.equal(await canBind(port), false);
  await close(server);
  assert.equal(await canBind(port), true);
  assert.equal(await canBind(0.5), false);
});

test('port choice attaches to our daemon, keeps the remembered port, then replaces it inside the safe range', async () => {
  const never = async () => false;
  assert.deepEqual(await choosePort({ remembered: 30001, preferred: 41731, isOurs: async (p) => p === 41731, bindable: never }), { port: 41731, attach: true, replaced: false });
  assert.deepEqual(await choosePort({ remembered: 30001, preferred: 41731, isOurs: never, bindable: async () => true }), { port: 30001, attach: false, replaced: false });
  assert.deepEqual(await choosePort({ remembered: null, preferred: 41731, isOurs: never, bindable: async () => true }), { port: 41731, attach: false, replaced: false });

  const replaced = await choosePort({ remembered: 30001, preferred: 41731, isOurs: never, bindable: async (p) => p !== 30001 && p !== 41731, random: () => 0.5 });
  assert.equal(replaced.replaced, true);
  assert.ok(replaced.port >= FALLBACK_RANGE.min && replaced.port <= FALLBACK_RANGE.max);

  const assigned = await choosePort({ remembered: null, preferred: 41731, isOurs: never, bindable: never, assign: async () => 55555 });
  assert.deepEqual(assigned, { port: 55555, attach: false, replaced: true });
});

// --------------------------------------------------------------- settings ---

test('settings survive garbage, and state keeps only what it understands', () => {
  const dir = temporary('oh-settings-');
  try {
    assert.deepEqual(sanitizeSettings({ keepRunningInBackground: 'yes', openAtLogin: true, extra: 1 }), { ...DEFAULT_SETTINGS, openAtLogin: true });
    fs.writeFileSync(path.join(dir, 'desktop-settings.json'), '{ not json');
    assert.deepEqual(settingsStore(dir).read(), DEFAULT_SETTINGS);

    settingsStore(dir).update({ keepRunningInBackground: false });
    assert.equal(settingsStore(dir).read().keepRunningInBackground, false);

    const state = stateStore(dir);
    state.update({ port: 70000, lastVersion: '0.2.0', backgroundHintShown: true });
    assert.deepEqual(stateStore(dir).read(), { lastVersion: '0.2.0', backgroundHintShown: true });
    state.update({ port: 41731 });
    assert.equal(stateStore(dir).read().port, 41731);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- logs ---

test('secrets and the home folder never reach the log', () => {
  const token = 'a'.repeat(64);
  const line = `GET /health Authorization: Bearer abcdefghijklmnop key sk-or-v1-abcdefghijklmnopqrstuvwxyz api_key=supersecretvalue token ${token} C:\\Users\\someone\\AppData`;
  const out = redact(line, { secrets: ['my-custom-secret-1'], home: 'C:\\Users\\someone' });
  assert.doesNotMatch(out, /abcdefghijklmnop|supersecretvalue|sk-or-v1-abc|aaaaaaaa|someone/);
  assert.match(out, /Bearer \[redacted\]/);
  assert.match(out, /~\\AppData/);
  assert.equal(redact('value my-custom-secret-1 end', { secrets: ['my-custom-secret-1'], home: '' }), 'value [redacted] end');
});

test('the log file rotates and keeps a bounded history', () => {
  const dir = temporary('oh-logs-');
  try {
    const log = new LogFile(dir, { maxBytes: 400, keep: 2, flushMs: 1_000_000 });
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 5; i++) log.write(`round ${round} line ${i} ${'x'.repeat(20)}`, 'daemon');
      log.flush();
    }
    log.close();
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['openhours.1.log', 'openhours.2.log', 'openhours.log']);
    assert.match(fs.readFileSync(path.join(dir, 'openhours.log'), 'utf8'), /round 7 line 4/);
    assert.match(fs.readFileSync(path.join(dir, 'openhours.log'), 'utf8'), /\[daemon\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostics are redacted like the log', () => {
  const report = diagnosticsReport({
    appVersion: '0.2.0', packaged: true, versions: { electron: '44', chrome: '152', node: '24' }, platform: 'win32', osVersion: '10.0', arch: 'x64',
    dataDir: 'C:\\data', daemon: { status: 'running', port: 41731, owned: true, restarts: 2 },
    docker: { state: 'stopped', message: 'Docker is installed but not running.', via: 'wsl.exe -d Ubuntu-22.04 docker' },
    settings: DEFAULT_SETTINGS, log: ['Bearer abcdefghijklmnopqrstuvwxyz'],
  }, { secrets: [] });
  assert.match(report, /Server: running/);
  assert.match(report, /Restarts this session: 2/);
  assert.match(report, /Docker: stopped/);
  assert.doesNotMatch(report, /abcdefghijklmnopqrstuvwxyz/);
});

// ----------------------------------------------------------------- backup ---

test('versions are ordered and a profile opened by another version is backed up once, newest kept', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('x', '0.1.0'), null);
  assert.equal(versionTransition(undefined, '0.2.0'), 'first-run');
  assert.equal(versionTransition('0.2.0', '0.2.0'), 'same');
  assert.equal(versionTransition('0.1.0', '0.2.0'), 'upgrade');
  assert.equal(versionTransition('0.3.0', '0.2.0'), 'downgrade');
  assert.equal(versionTransition('0.3.9', '0.3.9.1'), 'upgrade');
  assert.equal(versionTransition('0.3.9.1', '0.3.9'), 'downgrade');

  const dir = temporary('oh-backup-');
  try {
    assert.equal(backupDatabase({ dataDir: dir, fromVersion: '0.1.0', toVersion: '0.2.0' }).status, 'skipped');
    fs.writeFileSync(path.join(dir, 'openhours.db'), 'db');
    fs.writeFileSync(path.join(dir, 'openhours.db-wal'), 'wal');
    assert.equal(backupDatabase({ dataDir: dir, fromVersion: '0.1.0', toVersion: '0.2.0', inUse: () => true }).status, 'skipped');

    const created = [];
    for (let i = 0; i < 5; i++) {
      const result = backupDatabase({ dataDir: dir, fromVersion: '0.1.0', toVersion: '0.2.0', keep: 3, now: new Date(Date.UTC(2026, 8, 15, 10, 0, i)), inUse: () => false });
      assert.equal(result.status, 'created');
      created.push(path.basename(result.file));
    }
    const kept = fs.readdirSync(path.join(dir, 'backups')).sort();
    assert.equal(kept.filter((name) => name.endsWith('.db')).length, 3);
    assert.ok(kept.includes(`${created[4]}-wal`));
    assert.ok(!kept.includes(created[0]));
    assert.equal(fs.readFileSync(path.join(dir, 'backups', created[4]), 'utf8'), 'db');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a startup guard is removed only when its process is gone', () => {
  const dir = temporary('oh-claim-');
  const db = path.join(dir, 'openhours.db');
  try {
    assert.equal(clearStaleStartupClaim(db), false);
    fs.writeFileSync(`${db}.lock.claim`, '4242');
    assert.equal(clearStaleStartupClaim(db, () => true), false);
    assert.ok(fs.existsSync(`${db}.lock.claim`));
    assert.equal(clearStaleStartupClaim(db, () => false), true);
    assert.ok(!fs.existsSync(`${db}.lock.claim`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- docker ---

function dockerFixture(states, { installed = true, desktopRunning = false } = {}) {
  let index = 0;
  let clock = 0;
  const launched = [];
  const seen = [];
  return {
    launched,
    seen,
    options: {
      probe: async () => ({ state: states[Math.min(index++, states.length - 1)], message: '', via: 'docker' }),
      onStatus: (status) => seen.push(status.state),
      find: () => (installed ? 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' : null),
      running: async () => desktopRunning,
      launch: (exe) => launched.push(exe),
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      waitMs: 60_000,
      pollMs: 3_000,
    },
  };
}

test('Docker Desktop is started once when stopped, and waited for until the engine answers', async () => {
  const fixture = dockerFixture(['stopped', 'stopped', 'running']);
  const result = await ensureDocker(fixture.options);
  assert.equal(result.status.state, 'running');
  assert.equal(result.started, true);
  assert.equal(fixture.launched.length, 1);
  assert.deepEqual(fixture.seen, ['stopped', 'starting', 'starting', 'running']);
});

test('Docker is left alone when it runs, when it is not installed, when autostart is off, and when Desktop is already starting', async () => {
  const running = dockerFixture(['running']);
  assert.equal((await ensureDocker(running.options)).started, false);

  const missing = dockerFixture(['not-installed'], { installed: false });
  const notInstalled = await ensureDocker(missing.options);
  assert.equal(notInstalled.installed, false);
  assert.equal(missing.launched.length, 0);

  const off = dockerFixture(['stopped']);
  assert.equal((await ensureDocker({ ...off.options, autoStart: false })).started, false);
  assert.equal(off.launched.length, 0);

  const alreadyStarting = dockerFixture(['stopped', 'running'], { desktopRunning: true });
  const waited = await ensureDocker(alreadyStarting.options);
  assert.equal(waited.status.state, 'running');
  assert.equal(alreadyStarting.launched.length, 0);

  const wsl = dockerFixture(['wsl-missing']);
  assert.equal((await ensureDocker(wsl.options)).started, false);
  assert.equal(wsl.launched.length, 0);
});

test('Docker Desktop is looked for where it installs', () => {
  const candidates = dockerDesktopCandidates({ ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32');
  assert.ok(candidates.some((candidate) => candidate.endsWith(path.join('Docker', 'Docker', 'Docker Desktop.exe'))));
  assert.deepEqual(dockerDesktopCandidates({}, 'linux'), []);
});

// ------------------------------------------------------------- supervisor ---

test('failures a person can act on are explained in plain words', () => {
  assert.match(explainFailure(['Error: ENOSPC: no space left on device, write']), /disk is full/);
  assert.match(explainFailure(['SqliteError: database disk image is malformed']), /damaged/);
  assert.match(explainFailure(['Error: This OpenAgents database profile is already in use by a running daemon.']), /Another OpenAgents server/);
  assert.equal(explainFailure(['something else entirely']), null);
});

function fakeAppRoot(daemonSource) {
  const root = temporary('oh-supervisor-');
  const moduleDir = path.join(root, 'dist', 'src', 'daemon');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(moduleDir, 'local-auth.js'), 'export const loadLocalCredentials = () => ({ token: "fixture-token", profileId: "fixture-profile", apiVersion: 1 });');
  fs.writeFileSync(path.join(moduleDir, 'index.js'), daemonSource);
  return root;
}

const HEALTHY_DAEMON = `
import http from 'node:http';
const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.headers.authorization === 'Bearer fixture-token') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ service: 'openhours-daemon', profileId: 'fixture-profile', apiVersion: 1, parent: process.env.OPENHOURS_PARENT_PID }));
    return;
  }
  res.writeHead(401); res.end();
});
server.listen(Number(process.env.OPENHOURS_PORT), '127.0.0.1');
`;

test('a crashed daemon is restarted on the port it had, and told who its parent is', { timeout: 30_000 }, async () => {
  const root = fakeAppRoot(HEALTHY_DAEMON);
  const held = await listen();
  const heldPort = held.address().port;
  const chosen = [];
  const statuses = [];
  const supervisor = new DaemonSupervisor({ appRoot: root, port: heldPort, portPolicy: 'auto', restartDelays: [50], watchdogMs: 60_000, onPortChosen: (p) => chosen.push(p), onState: (s) => statuses.push(s.status) });
  try {
    const first = await supervisor.start();
    assert.equal(first.status, 'running');
    assert.notEqual(first.port, heldPort, 'a port another program holds is replaced');

    supervisor.child.kill();
    await waitFor(() => supervisor.state.status === 'running' && supervisor.state.restarts === 1, 20_000, 'the restart');
    assert.ok(statuses.includes('restarting'));
    assert.equal(new Set(chosen).size, 1, 'the restart keeps the same port');
    assert.equal(supervisor.state.port, first.port);
  } finally {
    await supervisor.stop();
    await close(held);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a daemon that cannot run stops being restarted and says why', { timeout: 30_000 }, async () => {
  const root = fakeAppRoot(`console.error('Error: ENOSPC: no space left on device, write'); process.exit(3);`);
  const probeServer = await listen();
  const port = probeServer.address().port;
  await close(probeServer);
  const supervisor = new DaemonSupervisor({ appRoot: root, port, restartDelays: [20], maxCrashes: 2 });
  try {
    await supervisor.start();
    await waitFor(() => supervisor.state.status === 'failed', 20_000, 'the supervisor to give up');
    assert.match(supervisor.state.detail, /code 3/);
    assert.match(supervisor.state.detail, /disk is full/);
    assert.match(supervisor.state.detail, /will not be restarted automatically/);
    assert.equal(supervisor.state.restarts, 2);
    assert.equal(supervisor.child, null);
  } finally {
    await supervisor.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing application files stop immediately instead of entering a futile restart loop', { timeout: 20_000 }, async () => {
  const root = fakeAppRoot(`console.error("Error: Cannot find module '@fast-csv/format'"); process.exit(1);`);
  const held = await listen(); const port = held.address().port; await close(held);
  const supervisor = new DaemonSupervisor({ appRoot: root, port, restartDelays: [20] });
  try {
    await supervisor.start();
    await waitFor(() => supervisor.state.status === 'failed', 10_000, 'missing files diagnosis');
    assert.match(supervisor.state.detail, /reopen the portable/);
    assert.equal(supervisor.state.restarts, 0);
  } finally { await supervisor.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a daemon that stops answering is found by the watchdog and replaced', { timeout: 30_000 }, async () => {
  // Answers health until told to hang via a file, then stays alive but silent.
  const root = fakeAppRoot(HEALTHY_DAEMON.replace(
    "if (req.url === '/health'",
    "if (fs.existsSync(process.env.OH_HANG_FILE)) return;\n  if (req.url === '/health'",
  ).replace("import http from 'node:http';", "import http from 'node:http';\nimport fs from 'node:fs';"));
  const hangFile = path.join(root, 'hang');
  process.env.OH_HANG_FILE = hangFile;
  const probeServer = await listen();
  const port = probeServer.address().port;
  await close(probeServer);
  const supervisor = new DaemonSupervisor({ appRoot: root, port, restartDelays: [50], watchdogMs: 100 });
  try {
    assert.equal((await supervisor.start()).status, 'running');
    fs.writeFileSync(hangFile, '1');
    await waitFor(() => supervisor.state.status === 'restarting', 20_000, 'the watchdog');
    assert.match(supervisor.state.detail, /stopped answering/);
    fs.rmSync(hangFile);
    await waitFor(() => supervisor.state.status === 'running', 20_000, 'the replacement');
  } finally {
    delete process.env.OH_HANG_FILE;
    await supervisor.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
