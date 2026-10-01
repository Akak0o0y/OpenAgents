/**
 * The bot's browser, in a Docker container.
 *
 * The owner wants a bot to reach the whole public internet from its own
 * sandbox, not from this computer. Chromium runs inside a container built from
 * Microsoft's Playwright image; the daemon drives it over Playwright's remote
 * protocol exactly as it drives a local browser, so every rule in
 * browser-tools.ts - form approvals, account autonomy, redaction, per-bot saved
 * sign-ins - applies unchanged.
 *
 * WHAT THE CONTAINER GIVES
 *   - Chromium never runs on this computer: no access to its files, processes or
 *     the person's own browser profile.
 *   - Its network goes through an egress proxy INSIDE the container that allows
 *     any public address on any port, and refuses private networks, this
 *     computer and the container itself (so a page cannot reach the Playwright
 *     server beside it).
 *   - No capabilities, no privilege escalation, bounded memory and processes.
 *
 * HOW THE DAEMON REACHES IT
 *   The Playwright server listens on a port published to 127.0.0.1 only, under
 *   a random path chosen at each start; a connection that does not know the path
 *   is refused. `--unsafe` lets the daemon pass Chromium arguments (the WebRTC
 *   policy), which is why the path matters.
 *
 * FIRST USE
 *   The Playwright image is about 2 GB. It is downloaded once, in the
 *   background, when Docker is running; until it is ready the browser runs on
 *   this computer with the same network policy (see BrowserTools).
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import { dockerArgv, resolveDockerHost, type DockerHost } from '../kernel/docker-host.js';

export type BrowserSandboxState = 'idle' | 'preparing' | 'downloading' | 'starting' | 'ready' | 'error';

export interface BrowserSandboxStatus {
  state: BrowserSandboxState;
  /** One sentence for a person. */
  message: string;
  image: string;
}

export interface DockerRun {
  (args: string[], options?: { input?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** The Playwright server must match the client library exactly. */
export const PLAYWRIGHT_VERSION: string = createRequire(import.meta.url)('playwright-core/package.json').version;

const SERVER_PORT = 3000;
export const SANDBOX_PROXY = 'http://127.0.0.1:3128';

/**
 * Runs inside the container. Plain Node, no packages: an HTTP proxy that
 * resolves each destination once, refuses anything that is not a public IPv4
 * address, and connects to the checked address itself (so DNS cannot change
 * between the check and the connection).
 */
export const EGRESS_SCRIPT = `import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
const blocked = (ip) => { const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113); };
async function destination(hostname) {
  const host = hostname.replace(/^\\[|\\]$/g, '');
  const found = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, family: 4 });
  if (!found.length || found.some((entry) => entry.family !== 4 || blocked(entry.address))) throw new Error('blocked');
  return found[0].address;
}
const refuse = 'Blocked by the OpenAgents browser network policy: only public internet addresses are reachable.';
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url);
    if (url.protocol !== 'http:' || url.username || url.password) throw new Error('unsupported');
    const address = await destination(url.hostname);
    const headers = { ...req.headers, host: url.host };
    delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const out = http.request({ host: address, port: Number(url.port || 80), path: url.pathname + url.search, method: req.method, headers }, (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(res);
    });
    out.setTimeout(60000, () => out.destroy());
    out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once('close', () => out.destroy());
    req.pipe(out);
  } catch { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end(refuse); }
});
server.on('connect', async (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  try {
    const url = new URL('https://' + req.url);
    const address = await destination(url.hostname);
    const upstream = net.connect({ host: address, port: Number(url.port || 443) });
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
  } catch { socket.end('HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n'); }
});
server.listen(3128, '127.0.0.1');
`;

export function sandboxDockerfile(version = PLAYWRIGHT_VERSION): string {
  const script = Buffer.from(EGRESS_SCRIPT, 'utf8').toString('base64');
  return [
    `FROM mcr.microsoft.com/playwright:v${version}-noble`,
    `RUN npm install -g playwright-core@${version} && mkdir -p /opt/openhours && echo ${script} | base64 -d > /opt/openhours/egress.mjs`,
    'USER pwuser',
    'WORKDIR /home/pwuser',
    `CMD ["sh", "-c", "node /opt/openhours/egress.mjs & exec playwright-core run-server --port ${SERVER_PORT} --host 0.0.0.0 --path \\"$OPENHOURS_BROWSER_PATH\\" --unsafe"]`,
    '',
  ].join('\n');
}

/** The image name carries a hash of its recipe, so a changed recipe is rebuilt rather than reused. */
export function sandboxImage(version = PLAYWRIGHT_VERSION): string {
  return `openhours-browser:${version}-${createHash('sha256').update(sandboxDockerfile(version)).digest('hex').slice(0, 10)}`;
}

export function dockerRunner(host: DockerHost): DockerRun {
  return (args, options = {}) => new Promise((resolve) => {
    if (options.signal?.aborted) { resolve({ exitCode: 1, stdout: '', stderr: 'Cancelled' }); return; }
    const argv = dockerArgv(args, host);
    const child = spawn(argv.command, argv.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
    const abort = () => { child.kill('SIGKILL'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('close', () => options.signal?.removeEventListener('abort', abort));
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-64_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-64_000); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout: stdout.replace(/\0/g, '').trim(), stderr: stderr.replace(/\0/g, '').trim() }); });
    child.stdin.end(options.input ?? '');
  });
}

const RETRY_MS = [30_000, 120_000, 600_000];

export class BrowserSandbox {
  private state: BrowserSandboxState = 'idle';
  private message = 'Waiting for Docker.';
  private endpointUrl: string | null = null;
  private preparing: Promise<void> | null = null;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly run: DockerRun;
  private readonly container: string;
  readonly image: string;

  constructor(private readonly options: {
    /** Distinguishes installations sharing one Docker engine (for example the app and a development checkout). */
    ownerId: string;
    run?: DockerRun;
    host?: DockerHost;
    /** How long the server may take to answer after the container starts. */
    readyTimeoutMs?: number;
    probe?: (url: string) => Promise<boolean>;
  }) {
    this.run = options.run ?? dockerRunner(options.host ?? resolveDockerHost());
    this.container = `openhours-browser-${createHash('sha256').update(options.ownerId).digest('hex').slice(0, 12)}`;
    this.image = sandboxImage();
  }

  status(): BrowserSandboxStatus {
    return { state: this.state, message: this.message, image: this.image };
  }

  /** Where to connect, when the sandbox is ready. */
  endpoint(): { wsEndpoint: string; proxy: string } | null {
    return this.state === 'ready' && this.endpointUrl ? { wsEndpoint: this.endpointUrl, proxy: SANDBOX_PROXY } : null;
  }

  /** Build the image if needed and start the container. Safe to call repeatedly; concurrent calls share one attempt. */
  prepare(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.state === 'ready') return Promise.resolve();
    this.preparing ??= this.attempt().finally(() => { this.preparing = null; });
    return this.preparing;
  }

  /** A connection failed: forget the endpoint and try again shortly. */
  markBroken(reason: string): void {
    if (this.state !== 'ready') return;
    this.endpointUrl = null;
    this.fail(`The sandboxed browser stopped answering (${reason.split('\n')[0].slice(0, 160)}). Restarting it.`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.preparing?.catch(() => {});
    if (this.state !== 'idle') await this.run(['rm', '-f', this.container], { timeoutMs: 30_000 }).catch(() => undefined);
    this.state = 'idle';
    this.endpointUrl = null;
    this.message = 'Stopped.';
  }

  private fail(message: string) {
    this.state = 'error';
    this.message = message;
    this.endpointUrl = null;
    if (this.stopped) return;
    const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)];
    this.failures++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.retry = null; void this.prepare(); }, delay);
    this.retry.unref?.();
  }

  private async attempt(): Promise<void> {
    try {
      this.state = 'preparing';
      this.message = 'Preparing the sandboxed browser.';
      const inspected = await this.run(['image', 'inspect', '--format', '{{.Id}}', this.image], { timeoutMs: 60_000 });
      if (this.stopped) return;
      if (inspected.exitCode !== 0) {
        this.state = 'downloading';
        this.message = 'Downloading the sandboxed browser (about 2 GB, once). The browser runs on this computer until it is ready.';
        const built = await this.run(['build', '--pull', '-t', this.image, '-'], { input: sandboxDockerfile(), timeoutMs: 45 * 60_000 });
        if (this.stopped) return;
        if (built.exitCode !== 0) throw new Error(`The sandboxed browser could not be downloaded: ${lastLine(built.stderr || built.stdout)}`);
      }
      this.state = 'starting';
      this.message = 'Starting the sandboxed browser.';
      const path = `/${randomBytes(18).toString('hex')}`;
      await this.run(['rm', '-f', this.container], { timeoutMs: 30_000 });
      const started = await this.run(['run', '-d', '--rm', '--name', this.container, '--label', 'openhours-browser=1', '--init',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g', '--pids-limit', '1024', '--shm-size', '1g',
        '-p', `127.0.0.1::${SERVER_PORT}`, '-e', `OPENHOURS_BROWSER_PATH=${path}`, this.image], { timeoutMs: 120_000 });
      if (this.stopped) return;
      if (started.exitCode !== 0) throw new Error(`The sandboxed browser did not start: ${lastLine(started.stderr || started.stdout)}`);
      const published = await this.run(['port', this.container, `${SERVER_PORT}/tcp`], { timeoutMs: 30_000 });
      const port = published.stdout.split('\n').map((line) => line.match(/:(\d+)\s*$/)?.[1]).find(Boolean);
      if (published.exitCode !== 0 || !port) throw new Error('The sandboxed browser started without a reachable port.');
      const base = `http://127.0.0.1:${port}`;
      const probe = this.options.probe ?? answers;
      const deadline = Date.now() + (this.options.readyTimeoutMs ?? 90_000);
      while (!(await probe(base))) {
        if (this.stopped) return;
        if (Date.now() > deadline) throw new Error('The sandboxed browser did not answer in time.');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      this.endpointUrl = `ws://127.0.0.1:${port}${path}`;
      this.state = 'ready';
      this.failures = 0;
      this.message = 'The browser runs in a Docker sandbox with access to the public internet.';
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 240) ?? 'no output';
}

/** The Playwright server answers any plain request with "Running". */
function answers(base: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(base, { timeout: 2000 }, (response) => { response.resume(); resolve(response.statusCode === 200); });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}
