/**
 * How this machine talks to Docker.
 *
 * Every Docker call used to be hardcoded as `wsl.exe -d Ubuntu-22.04 docker`,
 * and paths were rewritten with a Windows-only `toWslPath`. That is fine on the
 * machine it was written on and fatal for an open-source repo: a contributor on
 * Linux or macOS could not run a single test.
 *
 * The whole platform assumption now lives here, in one resolver, so the sandbox
 * never mentions an operating system again.
 *
 * Windows uses Docker Desktop's native CLI, without a user-managed Linux
 * distribution or WSL integration switch. An explicit WSL distro remains
 * supported for operators who choose that transport.
 */

import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface DockerHost {
  /** Executable to spawn. */
  command: string;
  /** Arguments that must precede the docker subcommand. */
  prefixArgs: string[];
  /**
   * Translate an absolute host path into one the docker CLI will understand.
   * Identity everywhere except Windows-through-WSL.
   */
  hostPath(p: string): string;
  /** Human-readable, for boot logs and failure messages. */
  describe(): string;
  /** Which branch was taken, for tests and diagnostics. */
  kind: 'wsl' | 'native';
  /** The WSL distribution Docker runs in; set only for the WSL transport. */
  distro?: string;
}

/**
 * `C:\Users\me\tmp` -> `/mnt/c/Users/me/tmp`.
 *
 * A path that is already POSIX-shaped passes through untouched, so this is safe
 * to apply twice.
 */
export function toWslPath(hostPath: string): string {
  const drive = hostPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!drive) return hostPath.replace(/\\/g, '/');
  return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
}

export const DEFAULT_WSL_DISTRO = 'Ubuntu-22.04';

/**
 * Resolve the Docker invocation for this machine.
 *
 * Precedence:
 *   1. OPENHOURS_DOCKER_CMD  - an explicit executable (`podman`, a full path,
 *      or `docker.exe` on Windows if the user prefers Docker Desktop directly).
 *      Chosen explicitly, so it is treated as native: no path rewriting.
 *   2. OPENHOURS_WSL_DISTRO on Windows - explicitly selected WSL transport.
 *   3. win32 - Docker Desktop's native CLI, discovered even before PATH refresh.
 *   4. everything else       - `docker` on PATH.
 */
export function resolveDockerHost(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = fs.existsSync
): DockerHost {
  const override = env.OPENHOURS_DOCKER_CMD?.trim();
  if (override) {
    return {
      command: override,
      prefixArgs: [],
      hostPath: (p) => p,
      kind: 'native',
      describe: () => `${override} (OPENAGENTS_DOCKER_CMD)`,
    };
  }

  if (platform === 'win32' && env.OPENHOURS_WSL_DISTRO?.trim()) {
    const distro = env.OPENHOURS_WSL_DISTRO?.trim() || DEFAULT_WSL_DISTRO;
    return {
      command: 'wsl.exe',
      // --exec bypasses WSL's default shell: Docker arguments must stay data,
      // including workspace paths containing quotes, $(), or semicolons.
      prefixArgs: ['-d', distro, '--exec', 'docker'],
      hostPath: toWslPath,
      kind: 'wsl',
      distro,
      describe: () => `wsl.exe -d ${distro} --exec docker`,
    };
  }

  if (platform === 'win32') {
    // Resolve on every call: a first-run installation can finish after daemon
    // startup, and the current process does not inherit the updated PATH.
    const roots = [
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'DockerDesktop'),
      ...[env.ProgramW6432, env.ProgramFiles].filter(Boolean).map(root => path.win32.join(root!, 'Docker', 'Docker')),
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Docker', 'Docker'),
    ].filter((root): root is string => Boolean(root));
    const command = () => roots.map(root => path.win32.join(root, 'resources', 'bin', 'docker.exe')).find(exists) ?? 'docker.exe';
    return { get command() { return command(); }, prefixArgs: [], hostPath: p => p, kind: 'native', describe: command };
  }

  return {
    command: 'docker',
    prefixArgs: [],
    hostPath: (p) => p,
    kind: 'native',
    describe: () => 'docker',
  };
}

/**
 * Keep the WSL distribution running while the daemon uses Docker through it.
 *
 * WSL stops a distribution shortly after its last `wsl.exe` client exits, and the services
 * inside it do not count. The daemon reaches containers over published ports, not through
 * wsl.exe, so between Docker commands the distribution idled out and took Docker and every bot
 * desktop down mid-run: containers exited 255 about twenty seconds after the last command.
 *
 * The hold is `cat` reading a pipe from this process. When the daemon exits, even by crashing,
 * the pipe closes, cat ends and WSL may idle again. No WSL setting is changed.
 */
export function holdWslDistro(host: DockerHost, options: {
  spawn?: typeof spawnProcess; retryMs?: number; maxRetryMs?: number; onLog?: (line: string) => void;
} = {}): { stop(): void } {
  const distro = host.distro;
  if (host.kind !== 'wsl' || !distro) return { stop() {} };
  const spawn = options.spawn ?? spawnProcess, base = options.retryMs ?? 5_000, max = options.maxRetryMs ?? 300_000;
  let child: ChildProcess | null = null, timer: NodeJS.Timeout | null = null, stopped = false, delay = base, warned = false;
  const start = () => {
    timer = null;
    if (stopped) return;
    const startedAt = Date.now();
    const current = spawn(host.command, ['-d', distro, '--exec', 'cat'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child = current;
    let ended = false;
    const end = () => {
      if (ended || child !== current) return;
      ended = true; child = null;
      if (stopped) return;
      // A hold that lasted a while is a normal WSL shutdown; one that fails at once backs off.
      const wait = Date.now() - startedAt > 60_000 ? (delay = base) : delay;
      delay = Math.min(delay * 2, max);
      if (!warned) { warned = true; options.onLog?.(`[Docker] The WSL hold on ${distro} ended; starting it again so Docker stays up.`); }
      timer = setTimeout(start, wait);
      timer.unref?.();
    };
    current.on('exit', end);
    current.on('error', end);
    current.unref?.();
  };
  start();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const current = child; child = null;
      if (current) { current.stdin?.end(); current.kill(); }
    },
  };
}

/**
 * Build a full argv for a docker command.
 *
 * Exported so tests and scripts stop shelling `wsl.exe` themselves - four test
 * files did, which meant the suite was as Windows-locked as the code it tested.
 */
export function dockerArgv(
  args: string[],
  host: DockerHost = resolveDockerHost()
): { command: string; args: string[] } {
  return { command: host.command, args: [...host.prefixArgs, ...args] };
}
