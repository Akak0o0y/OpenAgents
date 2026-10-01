/**
 * Docker status, as a person needs to hear it.
 *
 * The fixtures are the CLI's real wording on Windows. What matters is that
 * each layer that can be missing - WSL, the distro, Docker Desktop, the engine
 * - lands in the state whose fix is the right one, and that nothing that is
 * not a version string is ever reported as running.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { classifyDockerProbe, cleanCliText, DockerMonitor, probeDocker, type DockerStatus } from '../src/daemon/docker-status.js';

const wsl = { kind: 'wsl' as const, prefixArgs: ['-d', 'Ubuntu-22.04', 'docker'], describe: () => 'wsl.exe -d Ubuntu-22.04 docker' };
const native = { kind: 'native' as const, prefixArgs: [] as string[], describe: () => 'docker' };
/** How wsl.exe's own UTF-16LE messages look when read as UTF-8. */
const utf16 = (text: string) => text.split('').join('\0');

test('a catastrophic WSL diagnostic never claims automatic recovery', () => {
  const status = classifyDockerProbe({ exitCode: 1, stdout: '', stderr: 'Catastrophic failure Wsl/Service/E_UNEXPECTED' }, wsl);
  assert.equal(status.state, 'stopped');
  assert.doesNotMatch(status.message, /recovering|restarting/);
  assert.match(status.message, /no WSL restart was attempted/);
});

test('a passive WSL probe spawns only Docker version, never a shutdown or recovery process', async () => {
  const calls: Array<[string, string[]]> = [];
  const spawnFixture = ((command: string, args: string[]) => {
    calls.push([command, args]);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    queueMicrotask(() => {
      child.stderr.write('Catastrophic failure Wsl/Service/E_UNEXPECTED');
      child.emit('close', 1);
    });
    return child;
  }) as unknown as typeof spawn;
  const status = await probeDocker({ ...wsl, command: 'wsl.exe', hostPath: value => value }, 1000, spawnFixture);
  assert.deepEqual(calls, [['wsl.exe', ['-d', 'Ubuntu-22.04', 'docker', 'version', '--format', '{{.Server.Version}}']]]);
  assert.equal(status.state, 'stopped');
  assert.match(status.message, /no WSL restart was attempted/);
});

test('a hung Docker probe kills only its own child and returns a bounded status', async () => {
  const signals: string[] = [];
  const spawnFixture = (() => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: (signal: string) => { signals.push(signal); return true; } })) as unknown as typeof spawn;
  const status = await probeDocker({ ...wsl, command: 'wsl.exe', hostPath: value => value }, 5, spawnFixture);
  assert.deepEqual(signals, ['SIGKILL']);
  assert.equal(status.state, 'unknown');
});

test('a version on stdout is running, and only that is', () => {
  const up = classifyDockerProbe({ exitCode: 0, stdout: '28.3.2\n', stderr: '' }, wsl, 1);
  assert.equal(up.state, 'running');
  assert.equal(up.version, '28.3.2');
  assert.equal(up.checkedAt, 1);
  assert.equal(up.via, 'wsl.exe -d Ubuntu-22.04 docker');

  assert.notEqual(classifyDockerProbe({ exitCode: 0, stdout: '', stderr: '' }, native).state, 'running');
  assert.equal(classifyDockerProbe({ exitCode: null, stdout: '28.3.2', stderr: '', timedOut: true }, native).state, 'unknown');
});

test('wsl.exe messages are recognised through their UTF-16 encoding', () => {
  assert.equal(cleanCliText(utf16('There is no distribution with the supplied name.\r\n')), 'There is no distribution with the supplied name.');
  const status = classifyDockerProbe({ exitCode: -1, stdout: utf16('There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'), stderr: '' }, wsl);
  assert.equal(status.state, 'wsl-missing');
  assert.match(status.message, /Ubuntu-22\.04/);
});

test('Docker Desktop stopped behind WSL integration is stopped, not missing', () => {
  const status = classifyDockerProbe({
    exitCode: 1,
    stdout: '',
    stderr: "The command 'docker' could not be found in this WSL 2 distro.\nWe recommend to activate the WSL integration in Docker Desktop settings.",
  }, wsl);
  assert.equal(status.state, 'stopped');
  assert.match(status.message, /Start Docker Desktop/);
  assert.match(status.message, /Ubuntu-22\.04/);
});

test('an engine that does not answer is stopped', () => {
  const pipe = 'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.';
  assert.equal(classifyDockerProbe({ exitCode: 1, stdout: '', stderr: pipe }, native).state, 'stopped');
  const socket = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
  assert.equal(classifyDockerProbe({ exitCode: 1, stdout: '', stderr: socket }, wsl).state, 'stopped');
});

test('a missing launcher or command is named for the layer that is missing', () => {
  const enoent = { code: 'ENOENT', message: 'spawn wsl.exe ENOENT' };
  assert.equal(classifyDockerProbe({ exitCode: null, stdout: '', stderr: '', spawnError: enoent }, wsl).state, 'wsl-missing');
  assert.equal(classifyDockerProbe({ exitCode: null, stdout: '', stderr: '', spawnError: { ...enoent, message: 'spawn docker ENOENT' } }, native).state, 'not-installed');

  const inDistro = classifyDockerProbe({ exitCode: 127, stdout: '', stderr: 'bash: line 1: docker: command not found' }, wsl);
  assert.equal(inDistro.state, 'not-installed');
  assert.match(inDistro.message, /Ubuntu-22\.04/);
});

test('an unrecognised failure is unknown and keeps the raw text out of the message headline', () => {
  const status = classifyDockerProbe({ exitCode: 1, stdout: '', stderr: 'something unexpected\nwith a second line' }, native);
  assert.equal(status.state, 'unknown');
  assert.equal(status.message, 'Docker could not be checked: something unexpected');
  assert.match(status.detail ?? '', /second line/);
});

test('the monitor shares one probe between callers and reports only changes', async () => {
  const states: DockerStatus['state'][] = ['stopped', 'stopped', 'running'];
  let probes = 0;
  const monitor = new DockerMonitor({
    probe: async () => {
      const state = states[Math.min(probes++, states.length - 1)];
      return { state, version: state === 'running' ? '28.0.0' : null, message: state, detail: null, via: 'docker', checkedAt: probes };
    },
  });
  const seen: string[] = [];
  monitor.onChange((next, previous) => seen.push(`${previous?.state ?? 'none'}->${next.state}`));

  const [a, b] = await Promise.all([monitor.refresh(), monitor.refresh()]);
  assert.equal(a, b);
  assert.equal(probes, 1);
  await monitor.refresh();
  await monitor.refresh();
  assert.deepEqual(seen, ['none->stopped', 'stopped->running']);
  assert.equal(monitor.current()?.state, 'running');
});
