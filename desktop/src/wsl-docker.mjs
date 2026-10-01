import { execFile } from 'node:child_process';
import path from 'node:path';

const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
export function runWsl(args, timeout = 30_000) {
  return new Promise(resolve => {
    execFile(wsl, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? -1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** A local service, not the Docker Desktop integration shim inside a distro. */
export async function hasWslDockerEngine(distro, run = runWsl) {
  if (!distro) return false;
  const result = await run(['-d', distro, '--exec', 'systemctl', 'show', 'docker.service', '-p', 'LoadState', '--value']);
  return result.code === 0 && result.stdout.trim() === 'loaded';
}

/** Start the existing service only; never install, replace or migrate its data. */
export async function ensureWslDocker({ distro, probe, onStatus = () => {}, run = runWsl,
  waitMs = 90_000, pollMs = 2_000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!await hasWslDockerEngine(distro, run)) return null;
  onStatus({ state: 'starting', message: `Starting the existing Docker workspace in ${distro}…` });
  // WSL can start a fixed system service as root without a password prompt.
  // No shell string or renderer-provided command is executed here.
  const result = await run(['-d', distro, '--user', 'root', '--exec', 'systemctl', 'start', 'docker.service'], waitMs);
  let status = await probe();
  const deadline = now() + waitMs;
  while (result.code === 0 && status.state !== 'running' && now() < deadline) {
    await sleep(pollMs);
    status = await probe();
  }
  if (status.state === 'running') return status;
  return { ...status, state: 'setup-failed', message: `The saved Docker service in ${distro} did not start. OpenAgents will retry automatically.`,
    detail: result.code === 0 ? status.detail : result.stderr.trim().slice(0, 500) || `Service start exited with ${result.code}.` };
}
