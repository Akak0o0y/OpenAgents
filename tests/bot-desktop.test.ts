import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { toWslPath } from '../src/kernel/docker-host.js';
import { BotDesktop, desktopAssetsDir, desktopBuildFailure } from '../src/daemon/bot-desktop.js';
import { BrowserTools } from '../src/daemon/browser-tools.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';
import type { DockerRun } from '../src/daemon/browser-sandbox.js';

function fixture(options: { imageMissing?: boolean; foreign?: boolean; autoProvision?: boolean; buildFails?: boolean; engineMissing?: boolean; wsl?: boolean; identityKey?: (id: string) => string } = {}) {
  const calls: string[][] = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-desktop-unit-'));
  let container: any;
  let imageMissing = options.imageMissing;
  const resources = new Map<string, any>();
  const run: DockerRun = async args => {
    calls.push(args);
    const ok = (data: unknown) => ({ exitCode: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
    const missing = { exitCode: 1, stdout: '', stderr: 'missing' };
    if (args[0] === 'image') return imageMissing ? missing : ok([{ Id: args[2] === 'openhours-bot-desktop:' + 'b'.repeat(24) ? 'sha256:old-recipe' : 'sha256:fixture' }]);
    if (args[0] === 'info') return options.engineMissing ? missing : ok('linux/x86_64');
    if (args[0] === 'build') { if (options.buildFails) return missing; imageMissing = false; return ok('built'); }
    if (['volume', 'network'].includes(args[0])) {
      const name = args.at(-1)!;
      if (args[1] === 'inspect') return resources.has(name) ? ok([resources.get(name)]) : missing;
      const labels = Object.fromEntries(args.flatMap((a, i) => a === '--label' ? [args[i + 1].split('=')] : []));
      resources.set(name, { Labels: labels }); return ok(name);
    }
    if (args[0] === 'inspect') return options.foreign ? ok([{ Config: { Labels: { 'openhours.desktop.owner': 'someone-else' } } }]) : container ? ok([container]) : missing;
    if (args[0] === 'run') {
      const val = (key: string) => args[args.indexOf(key) + 1];
      container = { Id: 'a'.repeat(64), Image: 'sha256:fixture', Config: { Image: args.at(-1), Hostname: val('--hostname'), User: 'bot', Labels: Object.fromEntries(args.flatMap((a, i) => a === '--label' ? [args[i+1].split('=')] : [])) },
        State: { Running: true }, HostConfig: { CapDrop: ['ALL'], Privileged: false, PortBindings: { '6090/tcp': [{ HostIp: '127.0.0.1' }] } },
        NetworkSettings: { Networks: { [val('--network')]: {} } },
        Mounts: args.flatMap((a, i) => { if (a !== '--mount') return []; const fields = Object.fromEntries(args[i+1].split(',').map(p => p.split('='))); return [{ Type: fields.type, Name: fields.type === 'volume' ? fields.source : undefined, Source: fields.source, Destination: fields.target, RW: !('readonly' in fields) }]; }) };
      return ok('container-id');
    }
    if (args[0] === 'port') return ok('127.0.0.1:54321');
    if (args[0] === 'stop') { container.State.Running = false; return ok('stopped'); }
    if (args[0] === 'start') { container.State.Running = true; return ok('started'); }
    if (args[0] === 'rm') { container = undefined; return ok('removed container only'); }
    throw new Error('Unexpected Docker operation ' + args[0]);
  };
  const desktop = new BotDesktop({ ownerId: dir, stateDir: dir, assetsDir: desktopAssetsDir(), run, autoProvision: options.autoProvision, identityKey: options.identityKey,
    host: { command: 'docker', prefixArgs: options.wsl ? ['-d', 'FixtureDistro', '--exec', 'docker'] : [], kind: options.wsl ? 'wsl' : 'native', hostPath: options.wsl ? toWslPath : p => p, describe: () => 'fixture' }, probe: async () => true });
  return { desktop, calls, container: () => container };
}

test('desktop startup deduplicates and resumes its owned home without deletion', async () => {
  const { desktop, calls } = fixture();
  const first = desktop.prepare('alpha'); assert.equal(first, desktop.prepare('alpha'));
  const endpoint = await first;
  assert.equal(endpoint.password.length, 8); assert.equal(endpoint.token.length, 64);
  assert.equal(desktop.status('alpha').state, 'ready');
  assert.equal(calls.filter(c => c[0] === 'run').length, 1);
  await desktop.stopAgent('alpha'); assert.equal(desktop.endpoint('alpha'), null);
  const restarted = await desktop.prepare('alpha'); assert.equal(restarted.token, endpoint.token);
  assert.equal(calls.filter(c => c[0] === 'run').length, 1);
  assert.equal(calls.filter(c => c[0] === 'start').length, 1);
  await desktop.stop();
  assert.equal(calls.some(c => c.includes('rm')), false, 'Normal lifecycle never deletes bot homes');
  await assert.rejects(desktop.prepare('alpha'), /stopped/);
});

test('desktop identity is separated by both bot and installation and path-like IDs are not paths', () => {
  const a = fixture().desktop, b = fixture().desktop;
  assert.notEqual(a.identity('alpha').volume, a.identity('beta').volume);
  assert.notEqual(a.identity('alpha').volume, b.identity('alpha').volume);
  assert.match(a.identity('../../personal-chrome').name, /^oh-desktop-[a-f0-9]+-[a-f0-9]+$/);
});

test('upgrades an obsolete owned recipe container without deleting its home, network or secrets', async () => {
  const { desktop, container, calls } = fixture();
  const first = await desktop.prepare('alpha');
  const identity = desktop.identity('alpha');
  container().Config.Image = 'openhours-bot-desktop:' + 'b'.repeat(24);
  container().Image = 'sha256:old-recipe';
  container().Config.Hostname = '4486f1888508';
  const upgraded = await desktop.prepare('alpha');
  assert.deepEqual(upgraded, first);
  assert.deepEqual(desktop.identity('alpha'), identity);
  assert.deepEqual(calls.find(c => c[0] === 'rm'), ['rm', 'a'.repeat(64)]);
  assert.equal(calls.filter(c => c[0] === 'run').length, 2);
  const replacement = calls.filter(c => c[0] === 'run')[1];
  assert.equal(replacement[replacement.indexOf('--hostname') + 1], '4486f1888508', 'legacy Chrome computer identity survives replacement');
  assert.equal(calls.some(c => ['volume', 'network'].includes(c[0]) && c[1] === 'rm'), false);
  await desktop.stop();
});

test('upgrade refuses unsafe mounts, non-managed images and a changed digest under the same recipe tag', async () => {
  for (const change of ['mount', 'image', 'digest']) {
    const { desktop, container, calls } = fixture();
    await desktop.prepare('alpha');
    if (change === 'mount') { container().Config.Image = 'openhours-bot-desktop:' + 'b'.repeat(24); container().Mounts[0].Name = 'someone-elses-home'; }
    if (change === 'image') container().Config.Image = 'foreign-browser:latest';
    if (change === 'digest') container().Image = 'sha256:unexpected';
    await assert.rejects(desktop.prepare('alpha'), /does not match/);
    assert.equal(calls.some(c => c[0] === 'rm'), false);
    await desktop.stop();
  }
});

test('missing image fails closed without installing or launching a host browser', async () => {
  const { desktop, calls } = fixture({ imageMissing: true });
  await assert.rejects(desktop.prepare('alpha'), /No personal or testing browser/);
  assert.equal(desktop.status('alpha').state, 'error'); assert.equal(desktop.endpoint('alpha'), null);
  assert.deepEqual(calls.map(c => c[0]), ['image']);
});

test('retirement stops the owned desktop before deletion and refuses startup until it finishes', async () => {
  let key = 'legacy-alpha';
  const { desktop, container, calls } = fixture({ identityKey: () => key });
  await desktop.prepare('alpha');
  const old = desktop.identity('alpha');
  let removed = false;
  const retirement = desktop.retireAgent('alpha', () => { assert.equal(container().State.Running, false); removed = true; key = 'new-incarnation'; });
  await assert.rejects(desktop.prepare('alpha'), /being retired/);
  await retirement;
  assert.equal(removed, true);
  assert.equal(desktop.endpoint('alpha'), null);
  assert.notEqual(desktop.identity('alpha').volume, old.volume);
  assert.equal(calls.some(c => c.includes('rm')), false, 'retirement preserves every home');
  await desktop.stop();
});

test('failed retirement does not delete the bot or permit profile reassignment', async () => {
  const options = { engineMissing: false };
  const { desktop, calls } = fixture(options);
  await desktop.prepare('alpha');
  options.engineMissing = true;
  let removed = false;
  await assert.rejects(desktop.retireAgent('alpha', () => { removed = true; }), /info failed/);
  assert.equal(removed, false);
  assert.equal(calls.some(c => c[0] === 'rm'), false);
  options.engineMissing = false;
  await assert.rejects(desktop.retireAgent('alpha', () => { throw new Error('New work arrived'); }), /New work arrived/);
  await desktop.prepare('alpha');
  assert.equal(desktop.status('alpha').state, 'ready', 'failed deletion clears the retirement gate');
  await desktop.stop();
});

test('foreign resources cannot be started, stopped, or deleted', async () => {
  const { desktop, calls } = fixture({ foreign: true });
  await assert.rejects(desktop.prepare('alpha'), /another installation/);
  await assert.rejects(desktop.stopAgent('alpha'), /another installation/);
  assert.equal(calls.some(c => ['run', 'start', 'stop', 'rm'].includes(c[0])), false);
});

test('unsafe or replaced container configuration is not reused', async () => {
  const { desktop, container } = fixture(); await desktop.prepare('alpha');
  container().HostConfig.Privileged = true;
  await assert.rejects(desktop.prepare('alpha'), /does not match/);
  assert.equal(desktop.endpoint('alpha'), null);
});

test('Docker Desktop translated bind mounts restart without relaxing source or read-only checks', async () => {
  for (const native of [false, true]) {
    const { desktop, container, calls } = fixture();
    await desktop.prepare('alpha'); await desktop.stopAgent('alpha');
    const info = container();
    info.HostConfig.Mounts = info.Mounts.filter((m: any) => m.Type === 'bind').map((m: any) => ({
      Type: 'bind', Target: m.Destination, ReadOnly: true,
      Source: native ? m.Source.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_: string, drive: string) => `/run/desktop/mnt/host/${drive.toLowerCase()}/`) : m.Source,
    }));
    for (const mount of info.Mounts) if (mount.Type === 'bind') mount.Source = '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu-22.04/opaque';
    await desktop.prepare('alpha');
    assert.equal(calls.filter(c => c[0] === 'start').length, 1);
    info.HostConfig.Mounts[0].Source += '-wrong-profile';
    await assert.rejects(desktop.prepare('alpha'), /does not match/);
    info.HostConfig.Mounts[0].Source = info.HostConfig.Mounts[0].Source.replace('-wrong-profile', '');
    info.Mounts.find((m: any) => m.Type === 'bind').RW = true;
    await assert.rejects(desktop.prepare('alpha'), /does not match/);
    await desktop.stop();
  }
});

test('WSL hashed mounts require the exact source digest and selected distro', async () => {
  const { desktop, container } = fixture({ wsl: true });
  await desktop.prepare('alpha'); await desktop.stopAgent('alpha');
  const info = container();
  info.Config.Labels['desktop.docker.io/wsl-distro'] = 'FixtureDistro';
  info.HostConfig.Mounts = info.Mounts.filter((m: any) => m.Type === 'bind').map((m: any) => {
    m.Source = '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/FixtureDistro/' + createHash('sha256').update(m.Source).digest('hex');
    return { Type: 'bind', Target: m.Destination, ReadOnly: true, Source: m.Source };
  });
  await desktop.prepare('alpha');
  info.Config.Labels['desktop.docker.io/wsl-distro'] = 'OtherDistro';
  await assert.rejects(desktop.prepare('alpha'), /does not match/);
  info.Config.Labels['desktop.docker.io/wsl-distro'] = 'FixtureDistro';
  info.HostConfig.Mounts[0].Source += '0';
  await assert.rejects(desktop.prepare('alpha'), /does not match/);
  await desktop.stop();
});

test('Linux desktop launch scripts and application mappings retain LF line endings', () => {
  for (const file of ['start.sh', 'openhours-chrome', 'mimeapps.list']) {
    assert.ok(!fs.readFileSync(path.join(desktopAssetsDir(), file), 'utf8').includes('\r'), file);
  }
});

test('a desktop restarted after an unclean stop clears the stale display lock before X starts', () => {
  // Seen live on 2026-09-30: Docker in WSL died mid-run, `docker start` reused the container,
  // and Xtigervnc refused display :1 ("Server is already active") so the desktop exited in a second.
  const script = fs.readFileSync(path.join(desktopAssetsDir(), 'start.sh'), 'utf8');
  const clear = script.indexOf('rm -f /tmp/.X1-lock /tmp/.X11-unix/X1');
  assert.ok(clear > 0, 'start.sh removes the display lock and socket an unclean stop leaves behind');
  assert.ok(clear < script.indexOf('Xtigervnc :1'), 'they are removed before the X server starts');
});

test('desktop build failures identify actionable categories without echoing credentials', () => {
  const credential = 'https://private-user:private-password@registry.example';
  for (const [output, expected] of [
    ['no space left on device', /disk space/],
    ['Temporary failure resolving archive.ubuntu.com', /network access and DNS/],
    ['mimeapps.list references missing .desktop files: thunar.desktop', /application mapping/],
    ['toomanyrequests: pull rate limit', /rate limiting/],
    ['Cannot connect to the Docker daemon', /engine became unavailable/],
    ['Unable to locate package example', /Linux package is unavailable/],
    ['unknown failure', /failing step/],
  ] as const) {
    const message = desktopBuildFailure(output + ' ' + credential);
    assert.match(message, expected);
    assert.ok(!message.includes(credential));
    assert.ok(!message.includes('private-password'));
  }
});

test('first-use provisioning builds only the bundled recipe once and uses an immutable recipe tag', async () => {
  const { desktop, calls } = fixture({ imageMissing: true, autoProvision: true });
  const a = desktop.ensureImage(), b = desktop.ensureImage(); assert.equal(a, b);
  await a;
  assert.equal(desktop.provisionStatus().state, 'ready');
  assert.match(desktop.image, /^openhours-bot-desktop:[a-f0-9]{24}$/);
  assert.deepEqual(calls.find(c => c[0] === 'build'), ['build', '--tag', desktop.image, path.resolve(desktopAssetsDir())]);
  await desktop.ensureImage();
  assert.equal(calls.filter(c => c[0] === 'build').length, 1);
  await desktop.stop();
});

test('failed image provisioning is actionable and never launches any browser', async () => {
  for (const options of [{ engineMissing: true }, { buildFails: true }]) {
    const { desktop, calls } = fixture({ imageMissing: true, autoProvision: true, ...options });
    await assert.rejects(desktop.ensureImage(), /Docker|Desktop build failed/);
    assert.equal(desktop.provisionStatus().state, 'error');
    assert.equal(calls.some(c => ['run', 'start'].includes(c[0])), false);
    await desktop.stop();
  }
});

test('operator sign-in reports preparation without starting a host Chrome or creating a run', async () => {
  const { desktop } = fixture({ imageMissing: true, autoProvision: true, engineMissing: true });
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'test', budget_cap_usd: 0, current_status: 'IDLE' });
  const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), desktop });
  try {
    assert.deepEqual(await browser.beginLogin('alpha', 'https://x.com'), { opened: false, preparing: true, desktop: true });
    await desktop.ensureImage().catch(() => {});
    assert.equal(browser.status('alpha').sessions.length, 0);
    assert.equal(browser.status('alpha').desktopSetup?.state, 'error');
    assert.equal(browser.status('alpha').isolation, 'sandbox');
    const run = store.createTaskRun({ agentId: 'alpha', taskName: 'connection-fixture' });
    store.setAgentData({ agentId: 'alpha', taskRunId: run.id, category: 'browser-connection', key: 'x.com', data: { site: 'x.com', verified: true, updatedAt: Date.now() } });
    assert.deepEqual(browser.connections('alpha'), [], 'Old exported sessions must not appear signed in inside the new Chrome profile');
  } finally { await browser.stop(); await desktop.stop(); store.close(); }
});

test('desktop assets resolve independently of profile cwd and the production daemon cannot select the legacy browser', () => {
  const previous = process.cwd(), unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-desktop-cwd-'));
  try { process.chdir(unrelated); assert.ok(fs.existsSync(path.join(desktopAssetsDir(), 'Dockerfile'))); }
  finally { process.chdir(previous); }
  const daemon = fs.readFileSync(path.resolve('src/daemon/index.ts'), 'utf8');
  assert.doesNotMatch(daemon, /OPENHOURS_BOT_DESKTOP|new BrowserSandbox/);
  assert.match(daemon, /assetsDir: desktopAssetsDir\(\), autoProvision: true/);
  const packaging = fs.readFileSync(path.resolve('desktop/electron-builder.yml'), 'utf8');
  for (const asset of ['Dockerfile', 'start.sh', 'gateway.mjs', 'computer.mjs', 'seccomp.json']) assert.ok(packaging.includes('docker/bot-desktop/' + asset));
});
