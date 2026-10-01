/**
 * Cross-platform Docker resolution.
 *
 * The repo was unrunnable outside Windows: every Docker call shelled
 * `wsl.exe -d Ubuntu-22.04 docker` and paths were rewritten with a Windows-only
 * translator. For an open-source project that is not a rough edge, it is a wall
 * a contributor hits before their first test.
 *
 * These are pure - the platform is a parameter, so Linux and macOS behaviour is
 * verified from a Windows machine and vice versa.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_WSL_DISTRO,
  dockerArgv,
  holdWslDistro,
  resolveDockerHost,
  toWslPath,
} from '../src/kernel/docker-host.js';

describe('resolveDockerHost', () => {
  it('calls docker DIRECTLY on Linux', () => {
    const host = resolveDockerHost({}, 'linux');
    assert.equal(host.command, 'docker');
    assert.deepEqual(host.prefixArgs, []);
    assert.equal(host.kind, 'native');
  });

  it('calls docker directly on macOS', () => {
    assert.equal(resolveDockerHost({}, 'darwin').command, 'docker');
  });

  it('uses native Docker on Windows without requiring a specific Linux distro', () => {
    const host = resolveDockerHost({}, 'win32', () => false);
    assert.equal(host.command, 'docker.exe');
    assert.deepEqual(host.prefixArgs, []);
    assert.equal(host.kind, 'native');
  });

  it('discovers a new per-user Docker installation without a PATH refresh', () => {
    const cli = String.raw`C:\Users\me\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`;
    const host = resolveDockerHost({ LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` }, 'win32', file => file === cli);
    assert.equal(host.command, cli);
    assert.equal(host.hostPath(String.raw`C:\work with spaces`), String.raw`C:\work with spaces`);
  });

  it('honours a custom WSL distro', () => {
    const host = resolveDockerHost({ OPENHOURS_WSL_DISTRO: 'Ubuntu-24.04' }, 'win32');
    assert.deepEqual(host.prefixArgs, ['-d', 'Ubuntu-24.04', '--exec', 'docker']);
  });

  it('lets an explicit command override every platform rule', () => {
    // Someone on Windows using Docker Desktop directly, or anyone on podman.
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const host = resolveDockerHost({ OPENHOURS_DOCKER_CMD: 'podman' }, platform);
      assert.equal(host.command, 'podman');
      assert.deepEqual(host.prefixArgs, []);
      assert.equal(host.kind, 'native', 'an explicit command means no path rewriting');
    }
  });

  it('ignores a blank override rather than spawning an empty command', () => {
    const host = resolveDockerHost({ OPENHOURS_DOCKER_CMD: '   ' }, 'linux');
    assert.equal(host.command, 'docker');
  });
});

describe('path translation', () => {
  it('maps a Windows drive path onto its WSL mount', () => {
    assert.equal(toWslPath(String.raw`C:\Users\me\tmp`), '/mnt/c/Users/me/tmp');
    assert.equal(toWslPath('D:/data/x'), '/mnt/d/data/x');
  });

  it('is idempotent, so applying it twice cannot corrupt a path', () => {
    const once = toWslPath(String.raw`C:\Users\me\tmp`);
    assert.equal(toWslPath(once), once);
  });

  it('NEGATIVE CONTROL: leaves a POSIX path completely alone on Linux', () => {
    // The bug this prevents: rewriting /home/me into /mnt/... on a machine where
    // /mnt means nothing, silently breaking every mount.
    const host = resolveDockerHost({}, 'linux');
    assert.equal(host.hostPath('/home/me/project'), '/home/me/project');
    assert.equal(host.hostPath('/tmp/agent-stage-123'), '/tmp/agent-stage-123');
  });

  it('a native host never rewrites paths, even Windows-shaped ones', () => {
    const host = resolveDockerHost({ OPENHOURS_DOCKER_CMD: 'docker.exe' }, 'win32');
    assert.equal(host.hostPath(String.raw`C:\Users\me`), String.raw`C:\Users\me`);
  });
});

describe('dockerArgv', () => {
  it('produces a runnable argv on Linux', () => {
    const { command, args } = dockerArgv(['volume', 'ls', '-q'], resolveDockerHost({}, 'linux'));
    assert.equal(command, 'docker');
    assert.deepEqual(args, ['volume', 'ls', '-q']);
  });

  it('produces a runnable argv on Windows', () => {
    const { command, args } = dockerArgv(['volume', 'ls', '-q'], resolveDockerHost({}, 'win32'));
    assert.equal(command, 'docker.exe');
    assert.deepEqual(args, ['volume', 'ls', '-q']);
  });

  it('does not mutate the caller array', () => {
    const args = ['ps', '-a'];
    dockerArgv(args, resolveDockerHost({}, 'win32'));
    assert.deepEqual(args, ['ps', '-a']);
  });
});

describe('holdWslDistro', () => {
  // WSL stops an idle distribution even while Docker runs inside it; the daemon reaches
  // containers over published ports, so bot desktops died mid-run (exit 255) on 2026-09-30.
  const fakeSpawn = () => {
    const calls: Array<{ command: string; args: string[]; options: any; child: any }> = [];
    const spawn = (command: string, args: string[], options: any) => {
      const child: any = new EventEmitter();
      child.stdin = { ended: false, end() { this.ended = true; } };
      child.killed = false;
      child.kill = () => { child.killed = true; return true; };
      child.unref = () => {};
      calls.push({ command, args, options, child });
      return child;
    };
    return { calls, spawn };
  };
  const wsl = () => resolveDockerHost({ OPENHOURS_WSL_DISTRO: 'Ubuntu-22.04' }, 'win32');

  it('does nothing when Docker is reached natively', () => {
    const { calls, spawn } = fakeSpawn();
    holdWslDistro(resolveDockerHost({}, 'linux'), { spawn: spawn as never }).stop();
    assert.equal(calls.length, 0);
  });

  it('holds the distribution with a process that ends when the daemon goes away', () => {
    const { calls, spawn } = fakeSpawn();
    const hold = holdWslDistro(wsl(), { spawn: spawn as never });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'wsl.exe');
    assert.deepEqual(calls[0].args, ['-d', 'Ubuntu-22.04', '--exec', 'cat']);
    // cat reads this process's pipe, so it sees end-of-file the moment the daemon exits.
    assert.deepEqual(calls[0].options.stdio, ['pipe', 'ignore', 'ignore']);
    assert.equal(calls[0].options.windowsHide, true);
    hold.stop();
    assert.equal(calls[0].child.stdin.ended, true);
    assert.equal(calls[0].child.killed, true);
  });

  it('holds again after WSL ends the hold, and never after stop', async () => {
    const { calls, spawn } = fakeSpawn();
    const hold = holdWslDistro(wsl(), { spawn: spawn as never, retryMs: 5 });
    calls[0].child.emit('exit', 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, 2, 'restarted after an unexpected exit');
    hold.stop();
    calls[1].child.emit('exit', null);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, 2, 'no restart after stop');
  });
});
