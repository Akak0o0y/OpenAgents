/**
 * The bot's browser in a Docker sandbox.
 *
 * The owner asked that a bot reach the whole internet "from his sandbox". These
 * pin down the parts that do not need a 2 GB image to check: the image is built
 * once from Microsoft's Playwright image with the matching server, the container
 * is locked down and reachable only from this computer under a secret path, a
 * failure is said in words and retried, and the egress policy that runs inside
 * the container refuses private networks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BrowserSandbox, EGRESS_SCRIPT, PLAYWRIGHT_VERSION, sandboxDockerfile, sandboxImage, type DockerRun } from '../src/daemon/browser-sandbox.js';

function fakeDocker(options: { imagePresent?: boolean; buildFails?: string } = {}) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  let imagePresent = options.imagePresent ?? false;
  let starts = 0;
  const run: DockerRun = async (args, runOptions) => {
    calls.push({ args, input: runOptions?.input });
    if (args[0] === 'image') return { exitCode: imagePresent ? 0 : 1, stdout: '', stderr: 'Error: No such image' };
    if (args[0] === 'build') {
      if (options.buildFails) return { exitCode: 1, stdout: '', stderr: `#1 load metadata\n${options.buildFails}` };
      imagePresent = true;
      return { exitCode: 0, stdout: 'built', stderr: '' };
    }
    if (args[0] === 'run') { starts++; return { exitCode: 0, stdout: 'container-id', stderr: '' }; }
    if (args[0] === 'port') return { exitCode: 0, stdout: `127.0.0.1:${49000 + starts}`, stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('the sandbox image is built once, the container is locked down on loopback under a secret path, and a broken sandbox restarts', async () => {
  const docker = fakeDocker();
  const sandbox = new BrowserSandbox({ ownerId: 'C:/profile/openhours.db', run: docker.run, probe: async () => true });
  try {
    assert.equal(sandbox.endpoint(), null, 'nothing to connect to before it is prepared');
    await Promise.all([sandbox.prepare(), sandbox.prepare()]);
    assert.equal(sandbox.status().state, 'ready', sandbox.status().message);
    assert.equal(docker.calls.filter((call) => call.args[0] === 'build').length, 1, 'concurrent prepares share one attempt');

    const build = docker.calls.find((call) => call.args[0] === 'build')!;
    assert.deepEqual(build.args, ['build', '--pull', '-t', sandboxImage(), '-']);
    assert.match(build.input!, new RegExp(`^FROM mcr\\.microsoft\\.com/playwright:v${PLAYWRIGHT_VERSION.replace(/\./g, '\\.')}-noble`));
    assert.match(build.input!, new RegExp(`npm install -g playwright-core@${PLAYWRIGHT_VERSION.replace(/\./g, '\\.')}`), 'the server matches the client exactly');
    assert.match(build.input!, /USER pwuser/);
    assert.match(sandboxImage(), new RegExp(`^openhours-browser:${PLAYWRIGHT_VERSION.replace(/\./g, '\\.')}-[0-9a-f]{10}$`));

    const started = docker.calls.find((call) => call.args[0] === 'run')!.args;
    for (const flag of ['--rm', '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '--pids-limit', '127.0.0.1::3000']) {
      assert.ok(started.includes(flag), `${flag} is set`);
    }
    assert.ok(!started.includes('--privileged') && !started.some((arg) => arg.startsWith('0.0.0.0')), 'never privileged, never published beyond this computer');
    const first = sandbox.endpoint()!;
    assert.match(first.wsEndpoint, /^ws:\/\/127\.0\.0\.1:49001\/[0-9a-f]{36}$/);
    assert.ok(started.includes(`OPENHOURS_BROWSER_PATH=${new URL(first.wsEndpoint).pathname}`));
    assert.equal(first.proxy, 'http://127.0.0.1:3128');

    sandbox.markBroken('socket hang up');
    assert.equal(sandbox.endpoint(), null);
    assert.equal(sandbox.status().state, 'error');
    assert.match(sandbox.status().message, /stopped answering \(socket hang up\)/);
    await sandbox.prepare();
    assert.equal(docker.calls.filter((call) => call.args[0] === 'build').length, 1, 'the image is not downloaded again');
    const second = sandbox.endpoint()!;
    assert.notEqual(new URL(second.wsEndpoint).pathname, new URL(first.wsEndpoint).pathname, 'each start has a new secret path');
  } finally {
    await sandbox.stop();
  }
  assert.deepEqual(docker.calls.at(-1)!.args.slice(0, 2), ['rm', '-f']);
  assert.match(docker.calls.at(-1)!.args[2], /^openhours-browser-[0-9a-f]{12}$/);
  assert.equal(sandbox.endpoint(), null);
});

test('a failed download is said in words, and a present image is not rebuilt', async () => {
  const failing = fakeDocker({ buildFails: 'ERROR: failed to resolve source metadata: TLS handshake timeout' });
  const broken = new BrowserSandbox({ ownerId: 'a', run: failing.run, probe: async () => true });
  try {
    await broken.prepare();
    assert.equal(broken.status().state, 'error');
    assert.equal(broken.status().message, 'The sandboxed browser could not be downloaded: ERROR: failed to resolve source metadata: TLS handshake timeout');
    assert.equal(failing.calls.some((call) => call.args[0] === 'run'), false, 'nothing is started without an image');
  } finally {
    await broken.stop();
  }

  const present = fakeDocker({ imagePresent: true });
  const quick = new BrowserSandbox({ ownerId: 'b', run: present.run, probe: async () => true });
  try {
    await quick.prepare();
    assert.equal(quick.status().state, 'ready');
    assert.equal(present.calls.some((call) => call.args[0] === 'build'), false);
  } finally {
    await quick.stop();
  }
  assert.equal(sandboxDockerfile(), sandboxDockerfile(), 'the recipe is stable, so its image name is too');
});

test('the egress policy inside the container refuses this computer, private networks and cloud metadata', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-egress-'));
  const script = path.join(dir, 'egress.mjs');
  // Same script, on a free port instead of the container's fixed one.
  fs.writeFileSync(script, EGRESS_SCRIPT.replace("server.listen(3128, '127.0.0.1');", "server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));"));
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.on('data', (chunk) => { const found = String(chunk).match(/PORT (\d+)/); if (found) resolve(Number(found[1])); });
      child.once('exit', () => reject(new Error('egress script exited')));
    });
    const viaProxy = (target: string) => new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: target, headers: { host: new URL(target).host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); })
        .on('error', () => resolve(0));
    });
    const tunnel = (target: string) => new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      socket.once('data', (chunk) => { resolve(String(chunk).split('\r\n')[0]); socket.destroy(); });
      socket.on('error', () => resolve('error'));
    });
    assert.equal(await viaProxy('http://127.0.0.1:3000/'), 403, 'not the Playwright server beside it');
    assert.equal(await viaProxy('http://10.0.0.1/'), 403);
    assert.equal(await viaProxy('http://192.168.1.1/admin'), 403);
    assert.equal(await viaProxy('http://169.254.169.254/latest/meta-data/'), 403);
    assert.equal(await viaProxy('http://localhost:8080/'), 403, 'a name resolving to this computer is refused too');
    assert.equal(await tunnel('172.17.0.1:2375'), 'HTTP/1.1 403 Forbidden', 'not the Docker host');
    assert.equal(await tunnel('127.0.0.1:443'), 'HTTP/1.1 403 Forbidden');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
