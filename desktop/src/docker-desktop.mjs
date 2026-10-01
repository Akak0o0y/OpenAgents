/**
 * Getting Docker running without asking the user to do it.
 *
 * The sandbox reaches Docker through Docker Desktop on Windows and macOS. When
 * it is installed but stopped - the normal state after a reboot, unless it was
 * set to start at sign-in - the app starts it, then waits for the engine to
 * answer. When it is not installed there is nothing to start, and the interface
 * links to the download instead.
 *
 * Docker Desktop is never started while it is already running: launching it
 * again opens its dashboard window over whatever the person was doing.
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/';
export const WSL_INSTALL_URL = 'https://learn.microsoft.com/windows/wsl/install';

/** Where Docker Desktop installs itself, per platform. */
export function dockerDesktopCandidates(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'Docker Desktop.exe'), ...[env.ProgramW6432, env.ProgramFiles, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]
      .filter(Boolean)
      .map((root) => path.join(root, 'Docker', 'Docker', 'Docker Desktop.exe'))].filter(Boolean);
  }
  if (platform === 'darwin') return ['/Applications/Docker.app'];
  return [];
}

export function findDockerDesktop({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  return dockerDesktopCandidates(env, platform).find((candidate) => exists(candidate)) ?? null;
}

/** Is Docker Desktop's own process already running? */
export function dockerDesktopRunning(platform = process.platform) {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      execFile('tasklist', ['/FI', 'IMAGENAME eq Docker Desktop.exe', '/NH'], { windowsHide: true }, (error, stdout) => {
        resolve(!error && /Docker Desktop\.exe/i.test(String(stdout)));
      });
    } else if (platform === 'darwin') {
      execFile('pgrep', ['-x', 'Docker Desktop'], (error) => resolve(!error));
    } else {
      resolve(false);
    }
  });
}

export function launchDockerDesktop(executable, platform = process.platform) {
  const child = platform === 'darwin'
    ? spawn('open', ['-a', executable], { detached: true, stdio: 'ignore' })
    : spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { /* reported through the status that never turns running */ });
  child.unref();
}

/** States in which starting Docker Desktop can be the fix. */
const STARTABLE = new Set(['stopped', 'not-installed', 'unknown']);

/**
 * Make sure Docker is running, starting Docker Desktop if that can help.
 *
 * Reports every status it sees through `onStatus`, so a startup screen can say
 * "Starting Docker Desktop…" and then "Docker is running" as it happens.
 *
 * @returns {Promise<{ status: object, started: boolean, installed: boolean }>}
 */
export async function ensureDocker({
  probe,
  onStatus = () => {},
  autoStart = true,
  find = findDockerDesktop,
  running = dockerDesktopRunning,
  launch = launchDockerDesktop,
  waitMs = 180_000,
  pollMs = 3_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  let status = await probe();
  onStatus(status);
  const executable = find();
  if (status.state === 'running' || !STARTABLE.has(status.state)) return { status, started: false, installed: Boolean(executable) };
  if (!executable || !autoStart) return { status, started: false, installed: Boolean(executable) };

  let started = false;
  if (!(await running())) {
    launch(executable);
    started = true;
    onStatus({ ...status, state: 'starting', message: 'Starting Docker Desktop…' });
  }
  // Docker Desktop that was already running may still be starting its engine,
  // so it is waited for either way.
  const deadline = now() + waitMs;
  while (now() < deadline) {
    await sleep(pollMs);
    status = await probe();
    if (status.state === 'running') break;
    onStatus({ ...status, state: 'starting', message: started ? 'Starting Docker Desktop…' : 'Waiting for Docker Desktop to finish starting…' });
  }
  onStatus(status);
  return { status, started, installed: true };
}
