/**
 * Hardened Docker Sandbox Engine
 * Implements strict resource limits, network gating, volume isolation, path
 * traversal guards, and safe orphan cleanup.
 *
 * Three container classes, with different privileges:
 *   1. dependency builder - networked, no secrets
 *   2. executor           - --network none, no secrets, PRODUCES THE VERDICT
 *   3. agent container    - networked, and the ONLY class given a credential
 *
 * Platform independence: every Docker invocation goes through docker-host.ts,
 * so this file contains no operating-system assumptions.
 */

import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ExecutionResult } from './types.js';
import { dockerArgv, resolveDockerHost, type DockerHost } from './docker-host.js';

export interface RunCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  workDir?: string;
  env?: Record<string, string>;
  runtime?: 'node' | 'python';
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /**
   * Internal overrides used strictly for security evaluation negative controls.
   * Never used in production task dispatch.
   */
  _unhardenedOverrides?: {
    network?: string;
    pidsLimit?: number | null;
    capDrop?: string | null;
    readOnly?: boolean;
  };
}

export interface SearchWorkspaceParams {
  path?: string;
  depth?: number;
  pattern?: string;
  glob?: string;
  ignoreCase?: boolean;
}

export interface ShellSession {
  containerName: string;
  volumeName: string;
  runtime?: 'node' | 'python';
  lastWorkDir: string;
}

export interface AgentContainerOptions {
  signal?: AbortSignal;
  /** Image carrying the agent CLI. Never the plain executor image. */
  image: string;
  timeoutMs?: number;
  /**
   * Deliberate egress. Defaults to Docker's bridge network.
   * Swap in an allowlist bridge here to narrow egress without touching callers.
   */
  network?: string;
  /** Injected ONLY into this container class - never into executeTask(). */
  secrets?: Record<string, string>;
  env?: Record<string, string>;
  /** Must live on the mounted volume: the rootfs is read-only. */
  homeDir?: string;
}

export class DockerSandbox {
  private baseLabel = 'agent-platform=1';
  private readonly dockerHost: DockerHost;
  private readonly ownerId: string;
  private readonly ownerLabel: string;

  /** `dockerHost` is injectable so a test can assert the argv without Docker. */
  constructor(dockerHost: DockerHost = resolveDockerHost(), ownerId: string = randomUUID()) {
    this.dockerHost = dockerHost;
    this.ownerId = createHash('sha256').update(ownerId).digest('hex').slice(0, 16);
    this.ownerLabel = `openhours-owner=${this.ownerId}`;
  }

  /** How this process reaches Docker, for boot logs and diagnostics. */
  describeHost(): string {
    return this.dockerHost.describe();
  }

  /**
   * Execute docker CLI commands over the local docker socket, with no TCP
   * listeners. HOW docker is reached is resolved once, per platform, in
   * docker-host.ts - this method knows nothing about any operating system.
   */
  private async runDockerCli(
    args: string[],
    timeoutMs = 60000,
    signal?: AbortSignal,
    onData?: (stream: 'stdout' | 'stderr', chunk: string) => void,
    trim = true,
    input?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    signal?.throwIfAborted();
    return new Promise((resolve) => {
      const argv = dockerArgv(args, this.dockerHost);
      const child = spawn(argv.command, argv.args, {
        windowsHide: true,
      });

      if (input !== undefined) {
        child.stdin.on('error', () => {});
        child.stdin.write(input);
        child.stdin.end();
      }

      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const onAbort = () => { child.kill('SIGKILL'); };
      signal?.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (data) => {
        const text = stdoutDecoder.write(data);
        stdout += text;
        if (text && onData) onData('stdout', text);
      });

      child.stderr.on('data', (data) => {
        const text = stderrDecoder.write(data);
        stderr += text;
        if (text && onData) onData('stderr', text);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const restStdout = stdoutDecoder.end();
        if (restStdout) {
          stdout += restStdout;
          if (onData) onData('stdout', restStdout);
        }
        const restStderr = stderrDecoder.end();
        if (restStderr) {
          stderr += restStderr;
          if (onData) onData('stderr', restStderr);
        }
        resolve({
          stdout: trim ? stdout.trim() : stdout,
          stderr: stderr.trim(),
          exitCode: signal?.aborted ? 130 : timedOut ? 124 : (code ?? 1),
          timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          exitCode: 1,
          timedOut: false,
        });
      });
    });
  }

  /**
   * Translate a host path into one the docker CLI understands.
   *
   * On Windows-through-WSL that means a drive letter becomes a /mnt mount;
   * on Linux and macOS it is the identity, because the CLI and the
   * filesystem already agree.
   */
  private toDockerPath(hostPath: string): string {
    return this.dockerHost.hostPath(hostPath);
  }

  /**
   * Sweep and reap orphaned containers or volumes.
   * - forceAll = true (daemon boot): reaps all containers carrying the platform label, and prunes unused platform volumes.
   * - forceAll = false (periodic runtime sweep): reaps ONLY exited containers.
   *   Volume prune is explicitly SKIPPED during periodic sweeps to prevent deleting newly-created or temporarily
   *   unattached volumes of active tasks.
   */
  async orphanSweep(options: { forceAll?: boolean; timeoutMs?: number } = {}): Promise<{ reapedContainers: number; reapedVolumes: number }> {
    const deadline = Date.now() + (options.timeoutMs ?? 60000);
    const cleanupCommand = async (args: string[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Docker workspace cleanup timed out.');
      const result = await this.runDockerCli(args, remaining);
      if (result.exitCode !== 0) throw new Error(result.timedOut ? 'Docker workspace cleanup timed out.' : `Docker workspace cleanup failed: ${result.stderr.slice(0, 500)}`);
      return result;
    };
    const psArgs = ['ps', '-aq', '--filter', `label=${this.baseLabel}`, '--filter', `label=${this.ownerLabel}`];
    if (!options.forceAll) {
      psArgs.push('--filter', 'status=exited');
    }

    const { stdout: containerIds } = await cleanupCommand(psArgs);

    let reapedContainers = 0;
    if (containerIds) {
      const ids = containerIds.split(/\s+/).filter(Boolean);
      if (ids.length > 0) {
        await cleanupCommand(['rm', '-f', ...ids]);
        reapedContainers = ids.length;
      }
    }

    let reapedVolumes = 0;
    // Volume prune is ONLY safe at boot, when no tasks are running.
    // IMPORTANT: `docker volume prune` skips NAMED volumes unless --all is given,
    // and every task-vol-* is named - so prune silently reaped nothing. Enumerate
    // and remove explicitly instead, which also yields an accurate count.
    if (options.forceAll) {
      const { stdout: volOut } = await cleanupCommand([
        'volume', 'ls', '--format', '{{.Name}}\t{{.Labels}}', '--filter', `label=${this.baseLabel}`, '--filter', `label=${this.ownerLabel}`
      ]);
      const vols = volOut.split('\n').filter(Boolean).map(line => {
        const [name, labels = ''] = line.split('\t');
        return labels.split(',').includes('openhours-retain=1') ? null : name.trim();
      }).filter((name): name is string => Boolean(name));
      if (vols.length > 0) {
        const rmRes = await cleanupCommand(['volume', 'rm', '-f', ...vols]);
        reapedVolumes = rmRes.stdout.split(/\s+/).filter(Boolean).length;
      }
    }

    return {
      reapedContainers,
      reapedVolumes,
    };
  }

  /**
   * Create an isolated Docker named volume for the task.
   * Named volumes persist across container exit so docker cp works without tmpfs races.
   */
  workspaceVolumeName(taskId: string): string { return `task-vol-${this.ownerId}-${taskId}`; }

  async createWorkspaceVolume(taskId: string): Promise<string> {
    const volumeName = this.workspaceVolumeName(taskId);
    const res = await this.runDockerCli([
      'volume', 'create',
      '--label', this.baseLabel,
      '--label', this.ownerLabel,
      '--label', `task-id=${taskId}`,
      ...(taskId.startsWith('task-') ? ['--label', 'openhours-retain=1'] : []),
      volumeName
    ]);

    if (res.exitCode !== 0) {
      throw new Error(`Failed to create task volume: ${res.stderr}`);
    }

    return volumeName;
  }

  /**
   * Stage files into the workspace volume from host via temporary staging directory and docker cp.
   * Strict path traversal validation ensures files cannot escape the staging directory onto the host.
   */
  async stageWorkspaceFiles(volumeName: string, files: Record<string, string | Buffer>): Promise<void> {
    const helperName = `stage-helper-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const tempDir = path.join(os.tmpdir(), `agent-stage-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
    const resolvedTempDir = path.resolve(tempDir);
    fs.mkdirSync(resolvedTempDir, { recursive: true });

    try {
      for (const [relPath, content] of Object.entries(files)) {
        // Reject absolute paths
        if (path.isAbsolute(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
          throw new Error(`Path escapes staging directory: ${relPath} (absolute paths prohibited)`);
        }

        const fullPath = path.resolve(resolvedTempDir, relPath);
        // Ensure resolved destination starts strictly inside the staging root
        if (!fullPath.startsWith(resolvedTempDir + path.sep)) {
          throw new Error(`Path escapes staging directory: ${relPath}`);
        }

        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf-8');
      }

      await this.runDockerCli([
        'create', '--name', helperName,
        '--label', this.baseLabel,
      '--label', this.ownerLabel,
        '--mount', `source=${volumeName},target=/workspace`,
        'alpine:latest'
      ]);

      const stagePath = this.toDockerPath(resolvedTempDir);
      const cpRes = await this.runDockerCli(['cp', `${stagePath}/.`, `${helperName}:/workspace/`]);
      if (cpRes.exitCode !== 0) {
        throw new Error(`Failed to stage files into volume: ${cpRes.stderr}`);
      }
    } finally {
      await this.runDockerCli(['rm', '-f', helperName]);
      fs.rmSync(resolvedTempDir, { recursive: true, force: true });
    }
  }

  /**
   * Container 1: Hardened Dependency Builder Container
   * Runs package installation with network egress, but inside an isolated, hardened container:
   * - --pids-limit 256 (prevents fork bombs while allowing parallel compiler threads)
   * - --cap-drop ALL (drops all Linux capabilities)
   * - --memory 1024m --memory-swap 1024m (prevents host swap bloat)
   * - --read-only rootfs with --tmpfs /tmp:rw,nosuid,size=256m
   * - -e HOME=/workspace, -e npm_config_cache=/workspace/.npm, -e PIP_CACHE_DIR=/workspace/.pip-cache
   * - pip installs explicitly to /workspace/site-packages via --target to prevent EROFS on read-only rootfs
   * - ZERO host credentials, ZERO access to Docker socket.
   *
   * Security & Capability Notes on Postinstall Scripts:
   * - npm lifecycle scripts succeed under --cap-drop ALL because npm runs as root-in-container against
   *   a root-owned volume and does not attempt privilege de-escalation. If --user is ever introduced
   *   or volume ownership changes, npm will attempt setuid/setgid, which will fail with EPERM
   *   without CAP_SETUID / CAP_SETGID.
   * - Known Image Limitation: node:20-slim does not ship build tools (gcc, g++, make, python3).
   *   Packages with prebuilt binary releases (e.g. esbuild) or pure JS postinstall scripts succeed,
   *   but packages requiring on-the-fly C++ compilation via node-gyp require a toolchain-enabled image.
   */
  async installDependencies(
    volumeName: string,
    manager: 'npm' | 'pip' = 'npm',
    options: { ignoreScripts?: boolean; timeoutMs?: number; signal?: AbortSignal; onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void } = {}
  ): Promise<ExecutionResult> {
    const containerName = `dep-builder-${Date.now()}`;
    const timeoutMs = options.timeoutMs ?? 180000;
    const start = Date.now();

    const installCmd = manager === 'npm'
      ? `cd /workspace && npm install ${options.ignoreScripts ? '--ignore-scripts' : ''}`
      : `cd /workspace && if [ -f requirements.txt ]; then pip install --target /workspace/site-packages -r requirements.txt; elif [ -f pyproject.toml ] || [ -f setup.py ]; then pip install --target /workspace/site-packages .; fi`;

    const image = manager === 'pip' ? 'python:3.11-slim' : 'node:20-slim';

    const dockerArgs = [
      'run', '--name', containerName,
      '--label', this.baseLabel,
      '--label', this.ownerLabel,
      '--pids-limit', '256',
      '--cap-drop', 'ALL',
      '--memory', '1024m',
      '--memory-swap', '1024m',
      '--cpus', '1.0',
      '--read-only',
      '--mount', `source=${volumeName},target=/workspace`,
      '--tmpfs', '/tmp:rw,nosuid,size=256m',
      '--security-opt', 'no-new-privileges',
      '-e', 'HOME=/workspace',
      '-e', 'npm_config_cache=/workspace/.npm',
      '-e', 'PIP_CACHE_DIR=/workspace/.pip-cache',
      '-e', 'PYTHONUSERBASE=/workspace/.local',
      image,
      'sh', '-c', installCmd
    ];

    try {
      const res = await this.runDockerCli(dockerArgs, timeoutMs, options.signal, options.onOutput);
      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        durationMs: Date.now() - start,
        timedOut: res.timedOut,
      };
    } finally {
      await this.runDockerCli(['rm', '-f', containerName]);
    }
  }

  /**
   * Container 3: Networked Agent Container
   *
   * Runs an agentic CLI (OpenCode) that MUST reach a model provider, so unlike the
   * executor this container has egress. Every other control stays on: --cap-drop ALL,
   * --security-opt no-new-privileges, --read-only rootfs, pid/memory/cpu ceilings.
   *
   * SECURITY POSTURE - read before reusing this for anything else:
   * - This is the ONLY container that receives credentials. executeTask() must never
   *   be handed secrets, because agent-authored code runs there.
   * - Egress here is real: commands the agent chooses to run CAN reach the network.
   *   That is a deliberate widening over the executor's --network none, and it is
   *   precisely why a PASS/FAIL verdict is never produced in this container. Tests
   *   are always re-run by executeTask() with no network at all.
   * - `network` is a parameter so an egress-allowlist bridge can be dropped in later
   *   without touching a single caller.
   *
   * Verified empirically: a read-only rootfs works provided HOME points at the mounted
   * volume - opencode writes its config, cache, and session state under $HOME.
   */
  async runAgentContainer(
    volumeName: string,
    command: string,
    options: AgentContainerOptions
  ): Promise<ExecutionResult> {
    const containerName = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const timeoutMs = options.timeoutMs ?? 600000;
    const homeDir = options.homeDir ?? '/workspace/.agent-home';
    const start = Date.now();

    const dockerArgs = [
      'run', '--name', containerName,
      '--label', this.baseLabel,
      '--label', this.ownerLabel,
      '--label', 'agent-container=1',
      // Higher than the executor's 100: an agent CLI forks a shell plus tool subprocesses.
      '--pids-limit', '512',
      '--memory', '2048m', '--memory-swap', '2048m',
      '--cpus', '1.0',
      '--read-only',
      '--mount', `source=${volumeName},target=/workspace`,
      '--tmpfs', '/tmp:rw,nosuid,size=256m',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--network', options.network ?? 'bridge',
      '-e', `HOME=${homeDir}`,
      '-e', 'NODE_ENV=production',
    ];

    for (const [k, v] of Object.entries(options.env ?? {})) {
      dockerArgs.push('-e', `${k}=${v}`);
    }
    // Secrets last so they cannot be shadowed by a caller-supplied env entry.
    for (const [k, v] of Object.entries(options.secrets ?? {})) {
      dockerArgs.push('-e', `${k}=${v}`);
    }

    dockerArgs.push(
      options.image,
      'sh', '-c', `mkdir -p "${homeDir}" && cd /workspace && ${command}`
    );

    try {
      const res = await this.runDockerCli(dockerArgs, timeoutMs, options.signal);
      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        durationMs: Date.now() - start,
        timedOut: res.timedOut,
      };
    } finally {
      await this.runDockerCli(['rm', '-f', containerName]);
    }
  }

  /**
   * Container 2: Hardened Execution Worker
   * Runs agent-authored code and test suites.
   * Strictly enforces:
   * - ZERO network egress (--network none)
   * - Strict PID limit to kill fork bombs (--pids-limit 100)
   * - Memory and swap limits (--memory 1024m --memory-swap 1024m)
   * - CPU throttling (--cpus 1.0)
   * - Read-only root filesystem (--read-only)
   * - Isolated /tmp tmpfs (--tmpfs /tmp:rw,noexec,nosuid,size=128m)
   * - Dropped capabilities (--cap-drop ALL)
   * - No privilege escalation (--security-opt no-new-privileges)
   * - Explicit HOME=/workspace (prevents EROFS crashes)
   * - Explicit PYTHONPATH=/workspace/site-packages (resolves Python dependencies installed into workspace)
   */
  async executeTask(
    volumeName: string,
    command: string,
    options: RunCommandOptions = {}
  ): Promise<ExecutionResult> {
    const containerName = `executor-${Date.now()}`;
    const timeoutMs = options.timeoutMs ?? 60000;
    const start = Date.now();

    const envArgs: string[] = [
      '-e', 'HOME=/workspace',
      '-e', 'npm_config_cache=/workspace/.npm',
      '-e', 'PIP_CACHE_DIR=/workspace/.pip-cache',
      '-e', 'PYTHONPATH=/workspace/site-packages',
      '-e', 'NODE_ENV=test',
    ];

    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        envArgs.push('-e', `${k}=${v}`);
      }
    }

    const overrides = options._unhardenedOverrides;

    const dockerArgs = [
      'run', '--name', containerName,
      '--label', this.baseLabel,
      '--label', this.ownerLabel,
    ];

    // PID limit
    if (overrides && overrides.pidsLimit === null) {
      // Unhardened negative control: no pid limit
    } else if (overrides && overrides.pidsLimit !== undefined) {
      dockerArgs.push('--pids-limit', String(overrides.pidsLimit));
    } else {
      dockerArgs.push('--pids-limit', '100');
    }

    dockerArgs.push('--memory', '1024m', '--memory-swap', '1024m', '--cpus', '1.0');

    // Read-only rootfs
    if (!overrides || overrides.readOnly !== false) {
      dockerArgs.push('--read-only');
    }

    dockerArgs.push(
      '--mount', `source=${volumeName},target=/workspace`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
      '--security-opt', 'no-new-privileges'
    );

    // Capabilities
    if (overrides && overrides.capDrop === null) {
      // Unhardened negative control: default capabilities retained
    } else {
      dockerArgs.push('--cap-drop', 'ALL');
    }

    // Network
    if (overrides && overrides.network !== undefined) {
      dockerArgs.push('--network', overrides.network);
    } else {
      dockerArgs.push('--network', 'none');
    }

    const runtime = options.runtime ?? 'node';
    const image = runtime === 'python' ? 'python:3.11-slim' : 'node:20-slim';

    dockerArgs.push(
      ...envArgs,
      image,
      'sh', '-c', `cd /workspace && ${command}`
    );

    try {
      const res = await this.runDockerCli(dockerArgs, timeoutMs, options.signal, options.onOutput);
      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        durationMs: Date.now() - start,
        timedOut: res.timedOut,
      };
    } finally {
      await this.runDockerCli(['rm', '-f', containerName]);
    }
  }

  /**
   * Extract files from the workspace volume directly to the host filesystem outside the container.
   * Path sanitization ensures containerPath cannot traverse or escape the workspace.
   */
  async extractArtifact(volumeName: string, containerPath: string, hostDestinationPath: string): Promise<boolean> {
    if (containerPath.includes('..') || path.isAbsolute(containerPath) || containerPath.startsWith('/')) {
      throw new Error(`Invalid container artifact path: ${containerPath}`);
    }

    const resolvedHostDest = path.resolve(hostDestinationPath);
    fs.mkdirSync(path.dirname(resolvedHostDest), { recursive: true });

    const helperName = `extract-helper-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    
    await this.runDockerCli([
      'create', '--name', helperName,
      '--label', this.baseLabel,
      '--label', this.ownerLabel,
      '--mount', `source=${volumeName},target=/workspace`,
      'alpine:latest'
    ]);

    try {
      const destPath = this.toDockerPath(resolvedHostDest);
      const res = await this.runDockerCli([
        'cp', `${helperName}:/workspace/${containerPath}`, destPath
      ]);
      return res.exitCode === 0;
    } finally {
      await this.runDockerCli(['rm', '-f', helperName]);
    }
  }

  /**
   * Does this volume still exist?
   *
   * Workspace volumes are reaped when a task finishes, so any read of a live
   * workspace is inherently a read of a RUNNING task. Callers use this to say
   * "the workspace is gone" rather than reporting an empty file list, which
   * would be indistinguishable from a task that produced nothing.
   */
  async workspaceVolumeExists(volumeName: string): Promise<boolean> {
    const res = await this.runDockerCli(['volume', 'inspect', volumeName]);
    return res.exitCode === 0;
  }

  /**
   * List the files in a live workspace volume, as paths relative to /workspace.
   *
   * Runs in the same posture as executeTask: no network, all capabilities
   * dropped, no secrets, volume mounted read-only. This is an operator read
   * path, never reachable by agent code, but it gets the containment of one
   * anyway.
   */
  async listWorkspaceFiles(volumeName: string, maxEntries = 2000): Promise<string[]> {
    const helperName = `list-helper-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const res = await this.runDockerCli([
      'run', '--rm', '--name', helperName,
      '--label', this.baseLabel,
      '--label', this.ownerLabel,
      '--network', 'none',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--read-only',
      '--mount', `source=${volumeName},target=/workspace,readonly`,
      'alpine:latest',
      'sh', '-c',
      // node_modules is excluded because a staged dependency tree is tens of
      // thousands of entries and none of it is the agent's work.
      `find /workspace -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | head -n ${maxEntries}`,
    ]);

    if (res.exitCode !== 0) {
      throw new Error(`Failed to list workspace ${volumeName}: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    }

    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^\/workspace\//, ''))
      .sort();
  }

  /**
   * Read one file out of a live workspace volume as UTF-8 text.
   *
   * Reuses extractArtifact's traversal guard: a relative, non-escaping path or
   * nothing. `maxBytes` is enforced INSIDE the container so a huge file never
   * crosses the boundary; the returned `truncated` flag says so plainly rather
   * than handing back a silently clipped file.
   */
  async readWorkspaceFile(
    volumeName: string,
    containerPath: string,
    maxBytes = 256 * 1024
  ): Promise<{ content: string; truncated: boolean }> {
    if (
      containerPath.includes('..') ||
      path.isAbsolute(containerPath) ||
      containerPath.startsWith('/') ||
      containerPath.startsWith('\\')
    ) {
      throw new Error(`Invalid container artifact path: ${containerPath}`);
    }
    // The path crosses an `sh -c` boundary, so anything that could end the
    // quoting is refused outright rather than escaped.
    if (/['"`$\\\n]/.test(containerPath)) {
      throw new Error(`Invalid container artifact path: ${containerPath}`);
    }

    const helperName = `read-helper-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const res = await this.runDockerCli([
      'run', '--rm', '--name', helperName,
      '--label', this.baseLabel,
      '--label', this.ownerLabel,
      '--network', 'none',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--read-only',
      '--mount', `source=${volumeName},target=/workspace,readonly`,
      'alpine:latest',
      'sh', '-c',
      `head -c ${maxBytes + 1} '/workspace/${containerPath}'`,
    ], 60000, undefined, undefined, false);

    if (res.exitCode !== 0) {
      throw new Error(`Failed to read ${containerPath}: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    }

    const truncated = Buffer.byteLength(res.stdout, 'utf-8') > maxBytes;
    return {
      content: truncated ? res.stdout.slice(0, maxBytes) : res.stdout,
      truncated,
    };
  }

  /** Binary-safe, bounded read from an offline, read-only workspace mount. */
  async readWorkspaceBytes(volumeName: string, file: string, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
    if (!/^[A-Za-z0-9_. /-]+$/.test(file) || file.startsWith('/') || file.split('/').some(p => p === '..' || p === '.')) throw new Error('Unsafe workspace path.');
    const res = await this.runDockerCli(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
      '--label', this.baseLabel, '--label', this.ownerLabel, '--mount', `source=${volumeName},target=/workspace,readonly`, 'alpine:latest',
      'sh', '-c', `test -f '/workspace/${file}' && test ! -L '/workspace/${file}' && head -c ${maxBytes + 1} '/workspace/${file}' | base64`], 60000, undefined, undefined, false);
    if (res.exitCode !== 0) throw new Error(`Cannot read workspace file ${file}.`);
    const bytes = Buffer.from(res.stdout.replace(/\s/g, ''), 'base64');
    if (bytes.length > maxBytes) throw new Error(`Workspace file ${file} exceeds its byte limit.`);
    return bytes;
  }

  /**
   * Search workspace files using an isolated read-only alpine container.
   * Modes:
   *   - 'list': directory contents up to depth (1..4, default 2)
   *   - 'glob': workspace files matching pattern (excluding node_modules and .git)
   *   - 'grep': workspace search for pattern with optional path, glob, ignoreCase
   * Output capped at 400 entries or 16 KiB.
   */
  async searchWorkspace(
    volumeName: string,
    mode: 'list' | 'glob' | 'grep',
    params: SearchWorkspaceParams = {}
  ): Promise<string> {
    if (params.path) {
      if (
        params.path.includes('..') ||
        path.isAbsolute(params.path) ||
        params.path.startsWith('/') ||
        params.path.startsWith('\\') ||
        /['"`$\\\n]/.test(params.path)
      ) {
        throw new Error(`Invalid search path: ${params.path}`);
      }
    }
    if (params.glob && /['"`$\\\n]/.test(params.glob)) {
      throw new Error(`Invalid glob pattern: ${params.glob}`);
    }

    const helperName = `search-helper-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    let script = '';

    if (mode === 'list') {
      const cleanPath = params.path ? params.path.replace(/^\/+/, '').replace(/\/+$/, '') : '';
      const depth = Math.min(Math.max(params.depth ?? 2, 1), 4);
      script = `
target="/workspace${cleanPath ? '/' + cleanPath : ''}"
if [ ! -d "$target" ]; then
  echo "Directory not found: ${cleanPath}" >&2
  exit 1
fi
cd "$target"
find . -maxdepth ${depth} \\( -name node_modules -o -name .git \\) -prune -o -print | while read -r p; do
  if [ "$p" = "." ]; then continue; fi
  p="\${p#./}"
  if [ -d "$p" ]; then echo "$p/"; else echo "$p"; fi
done
`;
    } else if (mode === 'glob') {
      script = `
cd /workspace
find . \\( -name node_modules -o -name .git \\) -prune -o -type f -print | sed 's|^\\./||'
`;
    } else if (mode === 'grep') {
      const cleanPath = params.path ? params.path.replace(/^\/+/, '').replace(/\/+$/, '') : '';
      const target = cleanPath ? `./${cleanPath}` : '.';
      const grepArgs = params.ignoreCase ? '-Hni' : '-Hn';
      const patB64 = Buffer.from(params.pattern || '', 'utf-8').toString('base64');
      const globFilter = params.glob ? `-name "${params.glob}"` : '';

      script = `
cd /workspace
if [ ! -e "${target}" ]; then
  echo "Path not found: ${cleanPath}" >&2
  exit 1
fi
echo "${patB64}" | base64 -d > /tmp/grep_pat
find "${target}" \\( -name node_modules -o -name .git \\) -prune -o -type f ${globFilter} -exec grep ${grepArgs} -f /tmp/grep_pat {} + 2>/dev/null | sed 's|^\\./||; s|^/workspace/||'
`;
    }

    const res = await this.runDockerCli([
      'run', '--rm', '-i', '--name', helperName,
      '--label', this.baseLabel,
      '--label', this.ownerLabel,
      '--network', 'none',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '--mount', `source=${volumeName},target=/workspace,readonly`,
      'alpine:latest',
      'sh'
    ], 60000, undefined, undefined, false, script);

    if (res.exitCode !== 0) {
      throw new Error(`Search failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    }

    let lines = res.stdout.split('\n').filter(Boolean);

    if (mode === 'glob' && params.pattern) {
      const pat = params.pattern;
      const escaped = pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/\*(?!\*)/g, '[^/]*')
        .replace(/\?/g, '[^/]');
      const reg = new RegExp(`^${escaped}$`);
      lines = lines.filter(f => reg.test(f) || reg.test(path.basename(f)));
    }

    lines.sort();

    let truncated = false;
    if (lines.length > 400) {
      lines = lines.slice(0, 400);
      truncated = true;
    }

    let output = lines.join('\n');
    const MAX_BYTES = 16 * 1024;
    if (Buffer.byteLength(output, 'utf-8') > MAX_BYTES) {
      let byteLen = 0;
      const truncatedLines: string[] = [];
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;
        if (byteLen + lineBytes > MAX_BYTES) {
          truncated = true;
          break;
        }
        truncatedLines.push(line);
        byteLen += lineBytes;
      }
      output = truncatedLines.join('\n');
    }

    if (truncated) {
      output += '\n... (truncated)';
    }

    return output;
  }

  /**
   * Container: Persistent Shell Worker
   * Keeps a container and working directory across steps. Shell variables/functions are not retained.
   */
  async startShell(
    volumeName: string,
    options: { runtime?: 'node' | 'python'; env?: Record<string, string> } = {}
  ): Promise<ShellSession> {
    const containerName = `shell-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const runtime = options.runtime ?? 'node';
    const image = runtime === 'python' ? 'python:3.11-slim' : 'node:20-slim';

    const envArgs: string[] = [
      '-e', 'HOME=/workspace',
      '-e', 'npm_config_cache=/workspace/.npm',
      '-e', 'PIP_CACHE_DIR=/workspace/.pip-cache',
      '-e', 'PYTHONPATH=/workspace/site-packages',
      '-e', 'NODE_ENV=test',
    ];

    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        envArgs.push('-e', `${k}=${v}`);
      }
    }

    const dockerArgs = [
      'run', '-d', '--name', containerName,
      '--label', this.baseLabel,
      '--label', this.ownerLabel,
      '--label', 'openhours-shell=1',
      '--pids-limit', '100',
      '--memory', '1024m', '--memory-swap', '1024m',
      '--cpus', '1.0',
      '--read-only',
      '--mount', `source=${volumeName},target=/workspace`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--network', 'none',
      '-w', '/workspace',
      ...envArgs,
      image,
      'sleep', 'infinity'
    ];

    const res = await this.runDockerCli(dockerArgs);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to start persistent shell: ${res.stderr}`);
    }

    return {
      containerName,
      volumeName,
      runtime,
      lastWorkDir: '/workspace'
    };
  }

  async execInShell(
    session: ShellSession,
    command: string,
    options: RunCommandOptions = {}
  ): Promise<ExecutionResult> {
    const timeoutMs = options.timeoutMs ?? 60000;
    const start = Date.now();

    const b64 = Buffer.from(command, 'utf-8').toString('base64');
    const statePath = `/tmp/__oh_${randomUUID()}`;
    // Source in this exec shell: piping into another sh loses that shell's cd.
    // The exit trap also records cwd when a command explicitly exits nonzero.
    // Send the quoted cwd through stdin too: WSL can reinterpret Docker argv quotes.
    const quotedCwd = "'" + session.lastWorkDir.replace(/'/g, "'\\''") + "'";
    const script = `cd ${quotedCwd} || exit $?\ntrap 'pwd -P > ${statePath}.cwd' 0\nprintf '%s' '${b64}' | base64 -d > ${statePath}.sh || exit $?\n. ${statePath}.sh\n`;

    const res = await this.runDockerCli([
      'exec', '-i', session.containerName, 'sh'
    ], timeoutMs, options.signal, options.onOutput, false, script);

    try {
      const pwdRes = await this.runDockerCli([
        'exec', session.containerName, 'cat', `${statePath}.cwd`
      ], 5000);
      if (pwdRes.exitCode === 0 && pwdRes.stdout.trim()) {
        session.lastWorkDir = pwdRes.stdout.replace(/\r?\n$/, '');
      }
    } catch {
      // Ignore if container exited
    } finally {
      await this.runDockerCli(['exec', session.containerName, 'rm', '-f', `${statePath}.sh`, `${statePath}.cwd`], 5000).catch(() => undefined);
    }

    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: Date.now() - start,
      timedOut: res.timedOut,
    };
  }

  async stopShell(sessionOrContainerName: ShellSession | string): Promise<void> {
    const name = typeof sessionOrContainerName === 'string' ? sessionOrContainerName : sessionOrContainerName.containerName;
    await this.runDockerCli(['rm', '-f', name]);
  }

  /**
   * Cleanup the task volume completely.
   */
  async destroyWorkspaceVolume(volumeName: string): Promise<void> {
    await this.runDockerCli(['volume', 'rm', '-f', volumeName]);
  }
}
