import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-home-'));
process.env.HOME = home;
// The modules read HOME when they resolve a path, so it is set before they load.
const { validateExecInput, validateAppInput, executeExec, launchApp, resolveInHome } = await import('../../docker/bot-desktop/exec.mjs');
const { validateFileInput, executeFile } = await import('../../docker/bot-desktop/files.mjs');

/** A stand-in child process. Real shell behaviour runs in the container, under
 *  scripts/verify-bot-desktop.mjs; these tests pin the logic around it. */
function childSpawn({ stdout = '', stderr = '', code = 0, closeAfterMs = 0 }, seen = []) {
  return (file, args, options) => {
    seen.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdout = Readable.from([stdout]);
    child.stderr = Readable.from([stderr]);
    child.kill = () => { child.killed = true; };
    child.unref = () => { child.unrefd = true; };
    setTimeout(() => child.emit('close', code, null), closeAfterMs);
    return child;
  };
}

test('the shell stays inside the bot home and refuses unbounded work', () => {
  for (const input of [
    { command: '' },
    { command: 'ls', cwd: '../..' },
    { command: 'ls', cwd: '/etc' },
    { command: 'ls', timeoutMs: 999 },
    { command: 'ls', timeoutMs: 600000 },
    { command: 'ls\0rm' },
  ]) assert.throws(() => validateExecInput(input), `expected ${JSON.stringify(input)} to be refused`);
  validateExecInput({ command: 'ls -la', cwd: 'Downloads', timeoutMs: 5000 });
  assert.equal(resolveInHome('Downloads'), path.join(home, 'Downloads'));
  assert.throws(() => resolveInHome('../escape'), /outside the bot home/);
});

test('a command reports its real exit status and never inherits the daemon environment', async () => {
  process.env.OPENHOURS_SECRET_PROBE = 'must-not-reach-the-child';
  const seen = [];
  const failure = await executeExec({ command: 'build.sh' }, childSpawn({ stdout: 'out', stderr: 'err', code: 3 }, seen));
  assert.equal(failure.exitCode, 3, 'a failing command must not be reported as success');
  assert.equal(failure.stdout, 'out');
  assert.equal(failure.stderr, 'err');
  assert.equal(failure.timedOut, false);
  const env = seen[0].options.env;
  assert.equal(env.OPENHOURS_SECRET_PROBE, undefined, 'the daemon environment must not reach a command the model composed');
  assert.equal(env.HOME, home);
  // npm and pip must reach the network through the same egress proxy Chrome uses;
  // without these they hang and the only alternative is unfiltered egress.
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3128');
  assert.equal(env.https_proxy, 'http://127.0.0.1:3128');
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  // Installs land in the bot's own home: this user is not root and must not become root.
  assert.equal(env.NPM_CONFIG_PREFIX, `${home}/.npm-global`);
  assert.ok(env.PATH.startsWith(`${home}/.local/bin:`), `pip --user binaries must be reachable, got ${env.PATH}`);
  assert.match(env.PATH, /\.npm-global\/bin/);
  assert.deepEqual(seen[0].args, ['-lc', 'build.sh']);
  assert.equal(seen[0].options.cwd, path.resolve(home));
  delete process.env.OPENHOURS_SECRET_PROBE;
});

test('a command that outlives its timeout is stopped and says so', async () => {
  const result = await executeExec({ command: 'sleep 30', timeoutMs: 1000 }, childSpawn({ closeAfterMs: 1400 }));
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null, 'a stopped command has no exit status to report');
  assert.match(result.note, /was not undone/, 'the caller must be told work may already have happened');
});

test('file operations are confined, and a directory is not removed by accident', async () => {
  for (const input of [
    { operation: 'read', path: '../../etc/passwd' },
    { operation: 'read', path: '/etc/passwd' },
    { operation: 'sudo', path: 'x' },
    { operation: 'remove', path: '.' },
    { operation: 'write', path: 'a.txt', content: 'x', encoding: 'rot13' },
  ]) assert.throws(() => validateFileInput(input), `expected ${JSON.stringify(input)} to be refused`);

  await executeFile({ operation: 'write', path: 'notes/hello.txt', content: 'plain text' });
  const read = await executeFile({ operation: 'read', path: 'notes/hello.txt' });
  assert.equal(read.content, 'plain text');
  assert.equal(read.encoding, 'utf8');

  await executeFile({ operation: 'write', path: 'notes/blob.bin', content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' });
  const binary = await executeFile({ operation: 'read', path: 'notes/blob.bin' });
  assert.equal(binary.encoding, 'base64', 'binary content must not be returned as broken text');

  const listed = await executeFile({ operation: 'list', path: 'notes' });
  assert.deepEqual(listed.entries.map(entry => entry.name).sort(), ['blob.bin', 'hello.txt']);

  await assert.rejects(executeFile({ operation: 'remove', path: 'notes' }), /recursive/);
  await executeFile({ operation: 'remove', path: 'notes', recursive: true });
  await assert.rejects(executeFile({ operation: 'list', path: 'notes' }));
});

test('only known applications launch, and only safe targets open', async () => {
  for (const input of [
    {}, { app: 'gimp' }, { open: 'https://user:pass@example.com' }, { open: '../../../etc' },
  ]) assert.throws(() => validateAppInput(input), `expected ${JSON.stringify(input)} to be refused`);
  const seen = [];
  await launchApp({ app: 'files', open: 'Downloads' }, childSpawn({}, seen));
  assert.equal(seen[0].file, 'thunar');
  assert.deepEqual(seen[0].args, [path.join(home, 'Downloads')]);
  await launchApp({ open: 'https://example.com' }, childSpawn({}, seen));
  assert.equal(seen[1].file, '/usr/bin/xdg-open');
  assert.deepEqual(seen[1].args, ['https://example.com']);
});

test.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
