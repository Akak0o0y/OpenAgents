import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { dockerRunner, EGRESS_SCRIPT, type DockerRun } from './browser-sandbox.js';
import { resolveDockerHost, type DockerHost } from '../kernel/docker-host.js';

export type DesktopState = { state: 'stopped' | 'starting' | 'ready' | 'error'; message: string };
export type DesktopEndpoint = { base: string; token: string; password: string };
const ownerLabel = 'openhours.desktop.owner', botLabel = 'openhours.desktop.bot';
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);
// Resolve from the compiled module, never the shell's/profile's working directory.
export const desktopAssetsDir = () => fileURLToPath(new URL('../../../docker/bot-desktop/', import.meta.url));
const recipeFiles = ['Dockerfile', 'start.sh', 'openhours-chrome', 'mimeapps.list', 'gateway.mjs', 'computer.mjs', 'observe.mjs', 'exec.mjs', 'files.mjs', 'recorder.mjs', 'jobs.mjs', 'display.mjs', 'seccomp.json'];

/** Classify build output without exposing registry credentials or host paths in chat. */
export function desktopBuildFailure(output: string): string {
  const prefix = 'Desktop build failed. ';
  if (/no space left on device|disk quota exceeded/i.test(output)) return prefix + 'Docker has run out of disk space. Free space in Docker, then choose Retry setup.';
  if (/mimeapps\.list references missing|bad interpreter|\/bin\/bash\^M/i.test(output)) return prefix + 'A bundled desktop script or application mapping is invalid. Install the latest OpenAgents build, then choose Retry setup.';
  if (/toomanyrequests|pull rate limit|429 Too Many Requests/i.test(output)) return prefix + 'The image registry is rate limiting downloads. Wait before choosing Retry setup.';
  if (/temporary failure resolving|could not resolve|no such host|network is unreachable|failed to fetch|TLS handshake timeout|i\/o timeout/i.test(output)) return prefix + 'Docker could not download a required image or package. Check Docker network access and DNS, then choose Retry setup.';
  if (/cannot connect to the docker daemon|error during connect|docker daemon is not running/i.test(output)) return prefix + 'The Docker engine became unavailable. Start Docker and choose Retry setup.';
  if (/unable to locate package|has no installation candidate/i.test(output)) return prefix + 'A required Linux package is unavailable from its repository. Update OpenAgents or retry when the repository is available.';
  return prefix + 'Docker could not finish the bundled desktop image. Check Docker build output for the failing step, then choose Retry setup. No bot desktop was started.';
}

/** Docker Desktop represents Windows drives by this internal Linux prefix. */
function sameBindSource(actual: string, expected: string, wslDistro?: string) {
  if (wslDistro && actual === `/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/${wslDistro}/${createHash('sha256').update(expected).digest('hex')}`) return true;
  const normalize = (value: string) => value.replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/^\/run\/desktop\/mnt\/host\/([a-z])\//, '/mnt/$1/');
  return normalize(actual) === normalize(expected);
}

function validSecretMount(info: any, file: string, expectedSource: string, host: DockerHost) {
  const destination = '/run/secrets/' + file;
  const effective = info.Mounts?.find((m: any) => m.Type === 'bind' && !m.RW && m.Destination === destination);
  if (!effective) return false;
  // WSL integration can rewrite both inspected sources to a SHA256 of the
  // original absolute path. Accept only the exact expected hash and selected
  // distro, never any arbitrary Docker-managed mount or another profile.
  const selectedDistro = host.kind === 'wsl' && host.prefixArgs[0] === '-d' ? host.prefixArgs[1] : undefined;
  const wslDistro = selectedDistro && info.Config?.Labels?.['desktop.docker.io/wsl-distro'] === selectedDistro ? selectedDistro : undefined;
  const declared = info.HostConfig?.Mounts?.find((m: any) => m.Target === destination);
  if (declared) return declared.Type === 'bind' && declared.ReadOnly === true &&
    typeof declared.Source === 'string' && sameBindSource(declared.Source, expectedSource, wslDistro);
  return typeof effective.Source === 'string' && sameBindSource(effective.Source, expectedSource, wslDistro);
}

/** One persistent home, network and real Chrome desktop per installation + bot.
 * No fallback to a host browser. Shutdown stops containers but preserves homes.
 * The bundled recipe prepares regular Chrome; no personal/testing-browser fallback.
 */
export class BotDesktop {
  private run: DockerRun;
  private host: DockerHost;
  private owner: string;
  private states = new Map<string, DesktopState>();
  private endpoints = new Map<string, DesktopEndpoint>();
  private pending = new Map<string, Promise<DesktopEndpoint>>();
  private retiring = new Set<string>();
  private stopped = false;
  private provisioning?: Promise<void>;
  private setupAbort = new AbortController();
  private imageState: DesktopState = { state: 'stopped', message: 'The bot desktop will be prepared automatically on first use.' };
  readonly image: string;
  constructor(private options: { ownerId: string; stateDir: string; assetsDir: string; host?: DockerHost; run?: DockerRun; image?: string; autoProvision?: boolean; readyTimeoutMs?: number; probe?: (endpoint: DesktopEndpoint) => Promise<boolean>; identityKey?: (agentId: string) => string }) {
    this.host = options.host ?? resolveDockerHost();
    this.run = options.run ?? dockerRunner(this.host);
    this.owner = hash(options.ownerId);
    this.image = options.image ?? `openhours-bot-desktop:${hash(recipeFiles.map(file => fs.readFileSync(path.join(options.assetsDir, file), 'utf8').replace(/\r\n/g, '\n')).join('\n'))}`;
  }
  provisionStatus() { return { ...this.imageState }; }
  cancelSetup() { this.setupAbort.abort(); }
  ensureImage(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Desktop service is stopped.'));
    if (this.provisioning) return this.provisioning;
    this.imageState = { state: 'starting', message: 'Preparing the bot desktop and regular Chrome. First setup may take several minutes.' };
    this.provisioning = this.prepareImage().then(() => {
      this.imageState = { state: 'ready', message: 'Bot desktop software is ready. Each bot keeps its own Chrome profile.' };
    }).catch(error => {
      this.imageState = { state: 'error', message: error instanceof Error ? error.message : 'Desktop setup failed.' };
      throw error;
    }).finally(() => { this.provisioning = undefined; });
    return this.provisioning;
  }
  private async prepareImage() {
    if (!(await this.run(['image', 'inspect', this.image])).exitCode) return;
    if (!this.options.autoProvision) throw new Error('The bot desktop image is not installed. No personal or testing browser was opened.');
    const engine = await this.run(['info', '--format', '{{.OSType}}/{{.Architecture}}'], { timeoutMs: 15000 });
    if (engine.exitCode) throw new Error('Docker is not ready. Wait for workspace setup or choose Retry setup. No testing browser was opened.');
    if (!/^linux\/(x86_64|amd64)$/.test(engine.stdout.trim())) throw new Error('Bot Chrome requires an x64 Linux Docker engine. No host browser was opened.');
    for (const file of recipeFiles) if (!fs.existsSync(path.join(this.options.assetsDir, file))) throw new Error('Bundled bot desktop files are missing. Reinstall OpenAgents; bot data is preserved.');
    // Only the app's bundled directory is the build context, never user files.
    const build = await this.run(['build', '--tag', this.image, this.host.hostPath(path.resolve(this.options.assetsDir))], { timeoutMs: 20 * 60_000, signal: this.setupAbort.signal });
    if (this.setupAbort.signal.aborted) throw new Error('Desktop setup was cancelled. No bot desktop was started.');
    if (build.exitCode) throw new Error(desktopBuildFailure(build.stderr + '\n' + build.stdout));
    if (this.stopped) throw new Error('Desktop setup stopped. Its cached image can be reused next time.');
    await this.checked(['image', 'inspect', this.image]);
  }
  identity(agentId: string) {
    const bot = hash(this.options.identityKey?.(agentId) ?? agentId), name = `oh-desktop-${this.owner}-${bot}`;
    return { bot, name, volume: name + '-home', network: name + '-net' };
  }
  status(agentId: string): DesktopState { return this.states.get(agentId) ?? { state: 'stopped', message: 'This bot’s desktop is stopped. Its files and Chrome profile are kept.' }; }
  endpoint(agentId: string) { return this.endpoints.get(agentId) ?? null; }
  async beginHumanLogin(agentId: string, url: string) {
    const endpoint = await this.prepare(agentId);
    const response = await fetch(endpoint.base + '/human/start', { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('The bot’s human sign-in browser could not start. Retry sign-in.');
    return endpoint;
  }
  async finishHumanLogin(agentId: string) {
    const endpoint = this.endpoint(agentId);
    if (!endpoint) throw new Error('The sign-in desktop is no longer available.');
    const response = await fetch(endpoint.base + '/human/stop', { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Chrome could not save and close cleanly. Keep the sign-in window open and retry.');
    await this.stopAgent(agentId);
  }
  prepare(agentId: string): Promise<DesktopEndpoint> {
    if (this.retiring.has(agentId)) return Promise.reject(new Error('This bot’s desktop is being retired.'));
    if (this.stopped) return Promise.reject(new Error('Desktop service is stopped.'));
    const existing = this.pending.get(agentId); if (existing) return existing;
    const pending = this.start(agentId).catch(error => {
      this.endpoints.delete(agentId);
      this.states.set(agentId, { state: 'error', message: error instanceof Error ? error.message : 'Desktop could not start.' });
      throw error;
    }).finally(() => this.pending.delete(agentId));
    this.pending.set(agentId, pending); return pending;
  }
  private async checked(args: string[], timeoutMs = 60000) {
    const result = await this.run(args, { timeoutMs });
    // Do not return Docker output: it can include mounts and secret-bearing arguments.
    if (result.exitCode !== 0) throw new Error(`Desktop ${args[0]} failed. Check Docker availability and free disk space.`);
    return result.stdout;
  }
  private assertOwned(info: any, agentId: string, container = false) {
    const labels = container ? info.Config?.Labels : info.Labels;
    if (labels?.[ownerLabel] !== this.owner || labels?.[botLabel] !== this.identity(agentId).bot) throw new Error('A desktop resource belongs to another installation; it was left untouched.');
  }
  private async resource(kind: 'volume' | 'network', name: string, agentId: string) {
    const found = await this.run([kind, 'inspect', name]);
    if (found.exitCode === 0) { this.assertOwned(JSON.parse(found.stdout)[0], agentId); return; }
    await this.checked([kind, 'create', '--label', `${ownerLabel}=${this.owner}`, '--label', `${botLabel}=${this.identity(agentId).bot}`, name]);
  }
  private async start(agentId: string): Promise<DesktopEndpoint> {
    this.states.set(agentId, { state: 'starting', message: 'Starting this bot’s desktop and Chrome.' });
    const id = this.identity(agentId);
    await this.ensureImage();
    if (this.stopped) throw new Error('Desktop startup was cancelled.');
    const image = await this.run(['image', 'inspect', this.image]);
    if (image.exitCode) throw new Error('The prepared desktop image disappeared. Retry setup.');
    const dir = path.resolve(this.options.stateDir, this.owner, id.bot);
    if (dir.includes(',')) throw new Error('Desktop storage paths cannot contain commas.');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const secret = (name: string, value: string) => {
      const file = path.join(dir, name);
      try { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
      return fs.readFileSync(file, 'utf8').trim();
    };
    const token = secret('desktop-token', randomBytes(32).toString('hex'));
    const password = secret('desktop-password', randomBytes(6).toString('base64'));
    if (!/^[a-f0-9]{64}$/.test(token) || password.length !== 8) throw new Error('Desktop secrets are invalid; existing data was preserved.');
    fs.writeFileSync(path.join(dir, 'egress.mjs'), EGRESS_SCRIPT, { mode: 0o600 });
    await this.resource('volume', id.volume, agentId);
    await this.resource('network', id.network, agentId);
    const inspected = await this.run(['inspect', id.name]);
    let createContainer = inspected.exitCode !== 0;
    let desktopHostname = id.name;
    if (inspected.exitCode === 0) {
      const info = JSON.parse(inspected.stdout)[0]; this.assertOwned(info, agentId, true);
      // Chrome's persistent singleton names the computer. A replacement Docker
      // ID must not make the same bot home appear to belong to another machine.
      if (typeof info.Config?.Hostname === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(info.Config.Hostname)) desktopHostname = info.Config.Hostname;
      const binding = info.HostConfig?.PortBindings?.['6090/tcp'];
      if (info.HostConfig?.Privileged || info.Config?.User !== 'bot' || binding?.length !== 1 || binding[0].HostIp !== '127.0.0.1'
        || JSON.stringify(info.HostConfig.CapDrop) !== '["ALL"]' || Object.keys(info.NetworkSettings?.Networks ?? {}).join() !== id.network
        || info.Mounts?.length !== 4 || !info.Mounts.some((m: any) => m.Type === 'volume' && m.Name === id.volume && m.Destination === '/home/bot')
        || ['desktop-token', 'desktop-password', 'egress.mjs'].some(file => !validSecretMount(info, file, this.host.hostPath(path.join(dir, file)), this.host))) throw new Error('The existing desktop configuration or image does not match; it was left untouched.');
      const imageMatches = info.Image === JSON.parse(image.stdout)[0].Id && info.Config.Image === this.image;
      if (!imageMatches) {
        // Replace only a known older recipe, never a silently changed image at
        // the current tag or a custom/foreign image. Ownership and mounts above
        // remain mandatory, including for stopped containers.
        if (this.options.image || info.Config.Image === this.image || !/^openhours-bot-desktop:[a-f0-9]{24}$/.test(info.Config.Image) || !/^[a-f0-9]{64}$/.test(info.Id ?? '')) {
          throw new Error('The existing desktop configuration or image does not match; it was left untouched.');
        }
        const previousImage = await this.run(['image', 'inspect', info.Config.Image]);
        if (previousImage.exitCode || JSON.parse(previousImage.stdout)[0]?.Id !== info.Image) throw new Error('The existing desktop image does not match its recipe; it was left untouched.');
        this.endpoints.delete(agentId);
        this.states.set(agentId, { state: 'starting', message: 'Updating this bot’s desktop software. Its files and Chrome profile are kept.' });
        if (info.State.Running) await this.checked(['stop', '--time', '20', info.Id], 30000);
        // Use the inspected immutable ID and never -v: only the obsolete
        // container is removed, not a replacement with the same name or home.
        await this.checked(['rm', info.Id]);
        createContainer = true;
      } else if (!info.State.Running) await this.checked(['start', id.name], 120000);
    }
    if (createContainer) {
      // The container defaults to UTC, so a bot reading a timestamp, reading a clock on a
      // page, or acting on "this morning" was working in a different day from its owner.
      // The name is validated because it becomes a container argument.
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
      const timezone = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(zone) ? zone : 'UTC';
      await this.checked(['run', '--pull=never', '-d', '--name', id.name,
        '--hostname', desktopHostname,
        '--env', `TZ=${timezone}`,
        '--label', `${ownerLabel}=${this.owner}`, '--label', `${botLabel}=${id.bot}`,
        '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--security-opt', `seccomp=${this.host.hostPath(path.resolve(this.options.assetsDir, 'seccomp.json'))}`,
        '--memory', '2g', '--pids-limit', '512', '--shm-size', '512m', '--network', id.network,
        '--mount', `type=volume,source=${id.volume},target=/home/bot`,
        ...['desktop-token', 'desktop-password', 'egress.mjs'].flatMap(file => ['--mount', `type=bind,source=${this.host.hostPath(path.join(dir, file))},target=/run/secrets/${file},readonly`]),
        '-p', '127.0.0.1::6090', this.image], 120000);
    }
    const port = (await this.checked(['port', id.name, '6090/tcp'])).match(/^127\.0\.0\.1:(\d+)\s*$/)?.[1];
    if (!port) throw new Error('Desktop did not publish a loopback-only gateway.');
    const endpoint = { base: `http://127.0.0.1:${port}`, token, password };
    const probe = this.options.probe ?? (async (ep: DesktopEndpoint) => {
      try { return (await fetch(ep.base + '/health', { headers: { Authorization: 'Bearer ' + ep.token }, signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
    });
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 90000);
    while (!await probe(endpoint)) {
      if (this.stopped) throw new Error('Desktop startup was cancelled.');
      if (Date.now() >= deadline) throw new Error('Chrome or the desktop viewer did not become ready in time. Your bot’s files were preserved.');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    this.endpoints.set(agentId, endpoint);
    this.states.set(agentId, { state: 'ready', message: 'Bot-owned Linux desktop with regular Chrome.' });
    return endpoint;
  }
  async stopAgent(agentId: string) {
    await this.pending.get(agentId)?.catch(() => {});
    const id = this.identity(agentId), found = await this.run(['inspect', id.name]);
    if (!found.exitCode) {
      this.assertOwned(JSON.parse(found.stdout)[0], agentId, true);
      await this.checked(['stop', '--time', '20', id.name], 30000);
    }
    this.endpoints.delete(agentId);
    this.states.set(agentId, { state: 'stopped', message: 'Desktop stopped. Files and Chrome profile are kept.' });
  }
  /** Stop before the caller's synchronous deletion transaction. Deleting a bot
   * deletes the computer it owned: the home volume holds its Chrome profile,
   * logins and files, and no other bot may ever inherit them. The store still
   * retires the identity so a recreated bot starts clean. */
  async retireAgent<T>(agentId: string, remove: () => T): Promise<T> {
    if (this.retiring.has(agentId)) throw new Error('This bot is already being retired.');
    this.retiring.add(agentId);
    try {
      await this.pending.get(agentId)?.catch(() => {});
      const id = this.identity(agentId);
      const dir = path.resolve(this.options.stateDir, this.owner, id.bot);
      if (fs.existsSync(dir) || this.states.has(agentId)) {
        // An unavailable engine is not evidence that the old container stopped.
        await this.checked(['info', '--format', '{{.OSType}}'], 15000);
        await this.stopAgent(agentId);
      }
      const result = remove();
      // Ownership is re-checked against the labels before anything is destroyed, so a
      // volume or network this profile does not own is left alone rather than removed.
      for (const [kind, name] of [['volume', id.volume], ['network', id.network]] as const) {
        const found = await this.run([kind, 'inspect', name]);
        if (found.exitCode !== 0) continue;
        try { this.assertOwned(JSON.parse(found.stdout)[0], agentId); } catch { continue; }
        await this.run([kind, 'rm', name], { timeoutMs: 30000 });
      }
      this.endpoints.delete(agentId); this.states.delete(agentId);
      return result;
    } finally { this.retiring.delete(agentId); }
  }
  async stop() {
    this.stopped = true;
    this.setupAbort.abort();
    await this.provisioning?.catch(() => {});
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.states.keys()].map(id => this.stopAgent(id)));
  }
}
