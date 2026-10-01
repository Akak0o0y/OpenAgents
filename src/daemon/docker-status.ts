/**
 * Is Docker usable right now, in words a person can act on?
 *
 * The daemon used to find out by failing: the boot-time orphan sweep threw and
 * the process exited before any interface could say why. For someone who just
 * installed the app, that looked like "OpenAgents does not open". Docker is
 * needed for sandboxed work, not for talking to a bot, so its absence is now a
 * status to report rather than a reason to refuse to start.
 *
 * On Windows the sandbox reaches Docker through a WSL distro (see
 * kernel/docker-host.ts). "Docker is not available" therefore has several
 * different fixes depending on which layer is missing, and each one gets its
 * own state so the interface can offer the right one:
 *
 *   running        nothing to do
 *   stopped        Docker exists but its engine does not answer - start it
 *   not-installed  there is no docker command at all - install it
 *   wsl-missing    WSL, or the distro the sandbox uses, is not there
 *   unknown        it did not answer in time, or failed in an unrecognised way
 */

import { spawn } from 'node:child_process';
import { dockerArgv, resolveDockerHost, type DockerHost } from '../kernel/docker-host.js';

export type DockerState = 'running' | 'stopped' | 'not-installed' | 'wsl-missing' | 'unknown';

export interface DockerStatus {
  state: DockerState;
  /** The engine's version, when it answered. */
  version: string | null;
  /** One sentence for a person, naming the fix. */
  message: string;
  /** The CLI's own output, trimmed, for diagnostics. Never shown as the message. */
  detail: string | null;
  /** How Docker is reached, e.g. `wsl.exe -d Ubuntu-22.04 docker`. */
  via: string;
  checkedAt: number;
}

export interface DockerProbeOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: { code?: string; message: string } | null;
  timedOut?: boolean;
}

type HostFacts = Pick<DockerHost, 'kind' | 'describe' | 'prefixArgs'>;

/**
 * wsl.exe writes its own messages as UTF-16LE. Read as UTF-8 they arrive with a
 * NUL between every character, and no pattern would ever match them.
 */
export function cleanCliText(text: string): string {
  return text.replace(/\0/g, '').replace(/\r/g, '').trim();
}

function distroOf(host: HostFacts): string | null {
  if (host.kind !== 'wsl') return null;
  const flag = host.prefixArgs.indexOf('-d');
  return flag >= 0 ? host.prefixArgs[flag + 1] ?? null : null;
}

export function classifyDockerProbe(output: DockerProbeOutput, host: HostFacts, now = Date.now()): DockerStatus {
  const stdout = cleanCliText(output.stdout);
  const stderr = cleanCliText(output.stderr);
  const text = `${stderr}\n${stdout}\n${output.spawnError?.message ?? ''}`.toLowerCase();
  const distro = distroOf(host);
  const base = { via: host.describe(), checkedAt: now, detail: (stderr || stdout || output.spawnError?.message || '').slice(0, 600) || null };

  if (output.exitCode === 0 && stdout) {
    const version = stdout.split('\n')[0].trim();
    return { ...base, state: 'running', version, message: `Docker ${version} is running.` };
  }

  if (output.timedOut) {
    return { ...base, state: 'unknown', version: null, message: 'Docker did not answer in time. It may still be starting.' };
  }

  // The launcher itself is missing: no WSL on Windows, no docker elsewhere.
  if (output.spawnError?.code === 'ENOENT') {
    return host.kind === 'wsl'
      ? { ...base, state: 'wsl-missing', version: null, message: 'Windows Subsystem for Linux is not installed. OpenAgents reaches Docker through it.' }
      : { ...base, state: 'not-installed', version: null, message: 'Docker is not installed. Chat works without it; tasks that run code need it.' };
  }

  if (
    host.kind === 'wsl' &&
    (text.includes('no distribution with the supplied name') ||
      text.includes('wsl_e_distro_not_found') ||
      text.includes('has no installed distributions') ||
      text.includes('windows subsystem for linux is not installed') ||
      text.includes('wsl_e_wsl_optional_component_required'))
  ) {
    return { ...base, state: 'wsl-missing', version: null, message: `The ${distro ?? 'WSL'} distro is not installed. OpenAgents reaches Docker through it.` };
  }

  // Docker Desktop's WSL integration: with Desktop stopped (or the integration
  // switched off) the distro's docker is a dangling link, and this is the text.
  if (text.includes('could not be found in this wsl 2 distro')) {
    return {
      ...base,
      state: 'stopped',
      version: null,
      message: `Docker is not reachable from ${distro ?? 'WSL'}. Start Docker Desktop, and check that WSL integration is on for ${distro ?? 'this distro'}.`,
    };
  }

  if (
    text.includes('cannot connect to the docker daemon') ||
    text.includes('error during connect') ||
    text.includes('is the docker daemon running') ||
    text.includes('dockerdesktoplinuxengine') ||
    text.includes('docker desktop is not running')
  ) {
    return { ...base, state: 'stopped', version: null, message: 'Docker is installed but not running. Start Docker Desktop to run tasks that need a sandbox.' };
  }

  if (output.exitCode === 127 || text.includes('command not found') || text.includes('not recognized as an internal or external command')) {
    return {
      ...base,
      state: 'not-installed',
      version: null,
      message: distro
        ? `Docker is not installed in ${distro}. Install Docker Desktop and turn on WSL integration for ${distro}.`
        : 'Docker is not installed. Chat works without it; tasks that run code need it.',
    };
  }

  if (
    host.kind === 'wsl' &&
    (text.includes('catastrophic failure') || text.includes('wsl/service/e_unexpected') || text.includes('0x8000ffff'))
  ) {
    return {
      ...base,
      state: 'stopped',
      version: null,
      message: 'WSL could not start Docker. Check the configured distro and Docker Desktop; no WSL restart was attempted.',
    };
  }

  const firstLine = (stderr || stdout).split('\n')[0]?.trim();
  return { ...base, state: 'unknown', version: null, message: firstLine ? `Docker could not be checked: ${firstLine}` : 'Docker could not be checked.' };
}

/** Ask the engine for its version. Never throws; every failure is a status. */
export function probeDocker(host: DockerHost = resolveDockerHost(), timeoutMs = 15_000, spawnProcess: typeof spawn = spawn): Promise<DockerStatus> {
  const argv = dockerArgv(['version', '--format', '{{.Server.Version}}'], host);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (output: DockerProbeOutput) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(classifyDockerProbe(output, host));
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnProcess(argv.command, argv.args, { windowsHide: true });
    } catch (error: any) {
      finish({ exitCode: null, stdout, stderr, spawnError: { code: error?.code, message: String(error?.message ?? error) } });
      return;
    }

    // A cold WSL distro takes seconds to boot before docker even runs, so the
    // timeout is generous; a hung CLI still cannot hold the check forever.
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (data) => { stdout = (stdout + data).slice(-64_000); });
    child.stderr?.on('data', (data) => { stderr = (stderr + data).slice(-64_000); });
    child.on('error', (error: NodeJS.ErrnoException) => finish({ exitCode: null, stdout, stderr, spawnError: { code: error.code, message: error.message } }));
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr }));
  });
}

/**
 * Docker's status, kept current.
 *
 * Checked often while Docker is down, because that is when it is about to
 * change - someone is starting it - and rarely while it is up. The timer never
 * keeps the process alive on its own.
 */
export class DockerMonitor {
  private status: DockerStatus | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<DockerStatus> | null = null;
  private stopped = true;
  private readonly listeners = new Set<(next: DockerStatus, previous: DockerStatus | null) => void>();
  private readonly probe: () => Promise<DockerStatus>;
  private readonly upIntervalMs: number;
  private readonly downIntervalMs: number;

  constructor(options: { probe?: () => Promise<DockerStatus>; upIntervalMs?: number; downIntervalMs?: number } = {}) {
    this.probe = options.probe ?? (() => probeDocker());
    this.upIntervalMs = options.upIntervalMs ?? 60_000;
    this.downIntervalMs = options.downIntervalMs ?? 10_000;
  }

  current(): DockerStatus | null {
    return this.status;
  }

  onChange(listener: (next: DockerStatus, previous: DockerStatus | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Check now. Concurrent callers share one probe. */
  refresh(): Promise<DockerStatus> {
    if (!this.inflight) {
      this.inflight = this.probe()
        .then((next) => {
          const previous = this.status;
          this.status = next;
          if (!previous || previous.state !== next.state || previous.version !== next.version) {
            for (const listener of this.listeners) {
              try { listener(next, previous); } catch (error) { console.error('[Docker] status listener failed:', error); }
            }
          }
          return next;
        })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      const next = await this.refresh();
      if (this.stopped) return;
      this.timer = setTimeout(loop, next.state === 'running' ? this.upIntervalMs : this.downIntervalMs);
      this.timer.unref();
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
