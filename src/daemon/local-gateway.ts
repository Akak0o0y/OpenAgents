/**
 * FreeLLMAPI, started and kept running by OpenAgents.
 *
 * FreeLLMAPI is a separate local gateway that pools free model quotas behind an
 * OpenAI-compatible API. Before this, using it meant opening a terminal,
 * starting it by hand every time, and living with its default port 3001 - a
 * port half the development tools on a machine also want. Now:
 *
 *   FOUND       its folder is detected in the usual places (or set once in
 *               Settings → Providers), by its package name, not a guess.
 *   STARTED     when OpenAgents starts and a FreeLLMAPI connection exists. It
 *               runs from source through its own `tsx`, exactly as its
 *               developers run it, so nothing is built or written into the
 *               folder. A compiled `server/dist` is used when present.
 *   LOOPBACK    bound to 127.0.0.1. Its own default listens on every interface,
 *               which would put its dashboard and pooled keys on the local
 *               network.
 *   PORT        41790 by default - below the range Windows hands out for
 *               outgoing connections, clear of common development ports - and
 *               moved to a verified free port when that one is taken. The
 *               OpenAgents connection's address follows it.
 *   SUPERVISED  restarted after a crash, a few times, then reported plainly.
 *               Stopped when the daemon stops.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const LOCAL_GATEWAY_DEFAULT_PORT = 41790;
const FALLBACK_MIN = 20000;
const FALLBACK_MAX = 48999;
const BOOT_TIMEOUT_MS = 90_000;
const RESTART_DELAYS_MS = [2_000, 10_000, 30_000];
const LOG_LINES = 200;

export type LocalGatewayState = 'not-found' | 'stopped' | 'starting' | 'running' | 'failed';

export interface LocalGatewayConfig {
  /** FreeLLMAPI's folder; null means "use the detected one". */
  directory: string | null;
  port: number;
  autoStart: boolean;
}

export interface LocalGatewayStatus {
  state: LocalGatewayState;
  directory: string | null;
  detected: string | null;
  port: number;
  baseUrl: string;
  dashboardUrl: string;
  autoStart: boolean;
  message: string;
  pid: number | null;
  log: string[];
}

/** Whether a folder is a FreeLLMAPI checkout, by its package name. */
export function isFreeLlmApi(directory: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    return manifest?.name === '@freellmapi/monorepo' && fs.existsSync(path.join(directory, 'server'));
  } catch {
    return false;
  }
}

export function detectFreeLlmApi(home = os.homedir()): string | null {
  const parents = ['Desktop', '', 'Documents', 'Downloads', 'Projects', 'projects', 'src', path.join('source', 'repos'), 'code'];
  for (const parent of parents) {
    for (const name of ['freellmapi', 'FreeLLMAPI', 'free-llm-api']) {
      const candidate = path.join(home, parent, name);
      if (isFreeLlmApi(candidate)) return candidate;
    }
  }
  return null;
}

/** How to run it: compiled server when present, otherwise its own tsx on the source. */
export function launchPlan(directory: string, node = process.env.OPENHOURS_NODE || 'node'): { command: string; args: string[] } | { error: string } {
  const compiled = path.join(directory, 'server', 'dist', 'index.js');
  if (fs.existsSync(compiled)) return { command: node, args: [compiled] };
  const tsx = path.join(directory, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const source = path.join(directory, 'server', 'src', 'index.ts');
  if (fs.existsSync(tsx) && fs.existsSync(source)) return { command: node, args: [tsx, source] };
  return { error: `FreeLLMAPI at ${directory} has no dependencies installed. Run "npm install" in that folder once.` };
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

export class LocalGatewayService {
  private config: LocalGatewayConfig;
  private child: ChildProcess | null = null;
  private state: LocalGatewayState = 'stopped';
  private message = '';
  private log: string[] = [];
  private stopping = false;
  private crashes = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private starting: Promise<LocalGatewayStatus> | null = null;
  private readonly detected: string | null;

  constructor(private readonly options: {
    /** JSON file holding this installation's gateway settings. */
    configPath: string;
    onLog?: (line: string) => void;
    /** The gateway now answers at this base URL; loopback connections should follow. */
    onAddress?: (baseUrl: string) => void;
    detect?: () => string | null;
    plan?: typeof launchPlan;
  }) {
    this.detected = (options.detect ?? detectFreeLlmApi)();
    this.config = this.readConfig();
    if (!this.directory()) {
      this.state = 'not-found';
      this.message = 'FreeLLMAPI was not found on this computer. Choose its folder to let OpenAgents run it.';
    }
  }

  private readConfig(): LocalGatewayConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.configPath, 'utf8'));
      return {
        directory: typeof raw?.directory === 'string' && raw.directory.trim() ? raw.directory : null,
        port: Number.isInteger(raw?.port) && raw.port > 1024 && raw.port < 65536 ? raw.port : LOCAL_GATEWAY_DEFAULT_PORT,
        autoStart: typeof raw?.autoStart === 'boolean' ? raw.autoStart : true,
      };
    } catch {
      return { directory: null, port: LOCAL_GATEWAY_DEFAULT_PORT, autoStart: true };
    }
  }

  private saveConfig(): void {
    try {
      fs.mkdirSync(path.dirname(this.options.configPath), { recursive: true });
      const temporary = `${this.options.configPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.config, null, 2));
      fs.renameSync(temporary, this.options.configPath);
    } catch (error) {
      this.note(`Could not save the gateway settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private directory(): string | null {
    return this.config.directory ?? this.detected;
  }

  private note(line: string): void {
    this.log.push(line);
    if (this.log.length > LOG_LINES) this.log.shift();
    this.options.onLog?.(`[FreeLLMAPI] ${line}`);
  }

  status(): LocalGatewayStatus {
    const port = this.config.port;
    return {
      state: this.state, directory: this.directory(), detected: this.detected, port,
      baseUrl: `http://127.0.0.1:${port}/v1`, dashboardUrl: `http://127.0.0.1:${port}/`,
      autoStart: this.config.autoStart, message: this.message, pid: this.child?.pid ?? null, log: this.log.slice(-40),
    };
  }

  /** Change the folder, port preference or autostart. A running gateway restarts on a new folder. */
  async configure(patch: Partial<LocalGatewayConfig>): Promise<LocalGatewayStatus> {
    if (patch.directory !== undefined) {
      const directory = patch.directory?.trim() || null;
      if (directory && !isFreeLlmApi(directory)) throw new Error(`${directory} is not a FreeLLMAPI folder (no @freellmapi/monorepo package.json).`);
      this.config.directory = directory;
    }
    if (patch.port !== undefined) {
      if (!Number.isInteger(patch.port) || patch.port <= 1024 || patch.port >= 49152) throw new Error('Choose a port between 1025 and 49151.');
      this.config.port = patch.port;
    }
    if (patch.autoStart !== undefined) this.config.autoStart = Boolean(patch.autoStart);
    this.saveConfig();
    if (!this.directory()) {
      this.state = 'not-found';
      this.message = 'FreeLLMAPI was not found on this computer. Choose its folder to let OpenAgents run it.';
    } else if (this.state === 'not-found') {
      this.state = 'stopped';
      this.message = '';
    }
    if ((patch.directory !== undefined || patch.port !== undefined) && this.child) return this.restart();
    return this.status();
  }

  /** At boot: start when autostart is on, a folder is known, and something uses a FreeLLMAPI connection. */
  /**
   * Start with OpenAgents when starting with the app is on (the default) and a
   * FreeLLMAPI folder is known. The app itself starts it even before a FreeLLMAPI
   * connection exists - the owner asked for it to simply run - while any other
   * daemon (a development run, a test) waits for a connection, so finding a
   * folder on disk never launches a server nobody asked for.
   */
  startIfWanted(hasConnection: boolean, withApp = false): void {
    if (this.config.autoStart && this.directory() && (hasConnection || withApp)) void this.start();
  }

  start(): Promise<LocalGatewayStatus> {
    if (!this.starting) this.starting = this.startOnce().finally(() => { this.starting = null; });
    return this.starting;
  }

  async restart(): Promise<LocalGatewayStatus> {
    await this.stop();
    this.crashes = 0;
    return this.start();
  }

  private async startOnce(): Promise<LocalGatewayStatus> {
    if (this.child) return this.status();
    this.stopping = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const directory = this.directory();
    if (!directory) {
      this.state = 'not-found';
      return this.status();
    }
    const plan = (this.options.plan ?? launchPlan)(directory);
    if ('error' in plan) {
      this.state = 'failed';
      this.message = plan.error;
      return this.status();
    }

    // Our own gateway may already be answering - a previous daemon left it
    // running. Using it beats failing on the port it holds.
    if (await answers(this.config.port) && !(await canBind(this.config.port))) {
      this.state = 'running';
      this.message = `FreeLLMAPI is already answering on port ${this.config.port}.`;
      this.options.onAddress?.(this.status().baseUrl);
      return this.status();
    }
    if (!(await canBind(this.config.port))) {
      const previous = this.config.port;
      let replacement: number | null = null;
      for (let attempt = 0; attempt < 24 && replacement === null; attempt++) {
        const candidate = FALLBACK_MIN + Math.floor(Math.random() * (FALLBACK_MAX - FALLBACK_MIN));
        if (await canBind(candidate)) replacement = candidate;
      }
      if (replacement === null) {
        this.state = 'failed';
        this.message = `Port ${previous} is taken and no free port was found.`;
        return this.status();
      }
      this.config.port = replacement;
      this.saveConfig();
      this.note(`Port ${previous} is taken on this computer; using ${replacement}.`);
    }

    this.state = 'starting';
    this.message = `Starting FreeLLMAPI on port ${this.config.port}…`;
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(this.config.port), HOST: '127.0.0.1', NODE_ENV: 'production' };
    // The daemon may itself run as Electron-in-Node-mode; FreeLLMAPI needs a real Node.
    delete env.ELECTRON_RUN_AS_NODE;
    let child: ChildProcess;
    try {
      child = spawn(plan.command, plan.args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      this.state = 'failed';
      this.message = `FreeLLMAPI could not start: ${error instanceof Error ? error.message : String(error)}`;
      return this.status();
    }
    this.child = child;
    const relay = (stream: NodeJS.ReadableStream | null) => {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => { for (const line of chunk.split('\n')) if (line.trim()) this.note(line.replace(/\r$/, '').slice(0, 400)); });
    };
    relay(child.stdout);
    relay(child.stderr);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = null;
      this.state = 'failed';
      this.message = error.code === 'ENOENT'
        ? 'Node.js is needed to run FreeLLMAPI and was not found. Install Node.js 20 to 24 from nodejs.org, then start it again.'
        : `FreeLLMAPI could not start: ${error.message}`;
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) { this.state = 'stopped'; this.message = 'Stopped.'; return; }
      const delay = RESTART_DELAYS_MS[this.crashes];
      this.crashes += 1;
      if (delay === undefined) {
        this.state = 'failed';
        this.message = `FreeLLMAPI keeps stopping (last exit ${signal ?? code}). Check its log below.`;
        return;
      }
      this.state = 'starting';
      this.message = `FreeLLMAPI stopped (exit ${signal ?? code}); restarting in ${Math.round(delay / 1000)}s.`;
      this.restartTimer = setTimeout(() => { if (!this.stopping) void this.start(); }, delay);
      this.restartTimer.unref();
    });

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline && this.child === child) {
      if (await answers(this.config.port)) {
        this.state = 'running';
        this.crashes = 0;
        this.message = `Running on port ${this.config.port}.`;
        this.options.onAddress?.(this.status().baseUrl);
        return this.status();
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (this.child === child) {
      this.state = 'failed';
      this.message = `FreeLLMAPI did not answer on port ${this.config.port} within ${BOOT_TIMEOUT_MS / 1000}s.`;
      this.stopping = true;
      child.kill();
    }
    return this.status();
  }

  async stop(): Promise<LocalGatewayStatus> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 4000);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.kill();
      });
    }
    this.child = null;
    if (this.state !== 'not-found') { this.state = 'stopped'; this.message = child ? 'Stopped.' : this.message; }
    return this.status();
  }
}
