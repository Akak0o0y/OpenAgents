/**
 * Daemon lifecycle, owned by the desktop shell.
 *
 * The app does NOT assume it is the only thing that runs the daemon. An
 * operator very often has one running already - from `npm run daemon`, or from
 * a second window - and killing it on quit because this app happened to open
 * second would take their work with it.
 *
 * So: probe first. If a healthy daemon answers on the port, attach to it and
 * remember that we did not start it. Only a daemon this process spawned is a
 * daemon this process stops.
 *
 * WHAT A PERSON NEVER HAS TO DO. Everything below exists so that someone who
 * installed the app never opens a terminal:
 *
 *   PORT       In the installed app (`portPolicy: 'auto'`) a port that is taken
 *              or reserved is replaced by a verified free one, and the choice is
 *              remembered. Development and an explicit OPENHOURS_PORT keep the
 *              strict behaviour - there the port is somebody's deliberate choice.
 *   CRASHES    A daemon this app started that exits unexpectedly is restarted
 *              after 1s, 3s, 10s, 30s, then 60s. More than five exits in ten
 *              minutes is a daemon that cannot run, and restarting it forever
 *              would hide that; it stops and says so.
 *   HANGS      A daemon that is alive but no longer answering is found by a
 *              watchdog and restarted the same way.
 *   ORPHANS    The daemon is given this process's PID and exits when it is gone,
 *              so a crashed shell does not leave it holding the profile.
 *   LEFTOVERS  A startup guard left by an interrupted start is removed once its
 *              process is confirmed gone (see backup.mjs).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canBind, choosePort } from './ports.mjs';
import { clearStaleStartupClaim } from './backup.mjs';

const HEALTH_TIMEOUT_MS = 1500;
/**
 * Generous on purpose. The boot sweep asks Docker for leftovers first, and on a
 * cold WSL distro that alone can take most of a minute on a slow disk.
 */
const BOOT_TIMEOUT_MS = 90_000;
export const RESTART_DELAYS_MS = Object.freeze([1_000, 3_000, 10_000, 30_000, 60_000]);
export const CRASH_WINDOW_MS = 10 * 60_000;
export const MAX_CRASHES = 5;
const WATCHDOG_INTERVAL_MS = 10_000;
const WATCHDOG_MISSES = 3;
const BOOT_LOG_LINES = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Is something already serving the daemon's health endpoint? */
export async function probe(port, credentials, requiredBrowserRuntime) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    if (!credentials) return null;
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal, headers: { Authorization: `Bearer ${credentials.token}` } });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.service === 'openhours-daemon' && body.profileId === credentials.profileId && body.apiVersion === credentials.apiVersion && (!requiredBrowserRuntime || body.browserRuntime === requiredBrowserRuntime) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Plain words for the failures a person can do something about.
 *
 * Read from the daemon's own output for the attempt that failed. Anything not
 * recognised returns null and the raw exit reason stands - a guessed
 * explanation is worse than none.
 */
export function explainFailure(lines) {
  const text = lines.join('\n');
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Invalid file descriptor to ICU data|ERR_INVALID_PACKAGE_CONFIG/i.test(text)) {
    return 'Some OpenAgents application files are missing or damaged. Quit OpenAgents from its tray icon, then reopen the portable file to restore its bundled files, or reinstall the app. Your conversations are stored separately.';
  }
  if (/ENOSPC|no space left on device|SQLITE_FULL|database or disk is full/i.test(text)) {
    return 'The disk is full. Free some space; OpenAgents will keep trying.';
  }
  if (/SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i.test(text)) {
    return 'The OpenAgents database is damaged. Copies taken before each update are in the "backups" folder of the data folder.';
  }
  if (/already in use by a running daemon/i.test(text)) {
    return 'Another OpenAgents server is still using this profile. Close other copies of OpenAgents, or restart Windows.';
  }
  if (/Another startup is claiming this profile/i.test(text)) {
    return 'A previous start was interrupted before it finished.';
  }
  if (/EADDRINUSE|address already in use/i.test(text)) {
    return 'Its port was taken just as it started.';
  }
  if (/listen EACCES|EACCES: permission denied.*listen/i.test(text)) {
    return 'Windows refused its port.';
  }
  if (/(EPERM|EACCES|EBUSY)[^\n]*openhours\.db/i.test(text)) {
    return 'OpenAgents cannot write to its data folder. Check that it is not read-only or blocked by antivirus.';
  }
  return null;
}

function formatDelay(ms) {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

export class DaemonSupervisor {
  /**
   * @param {object} options
   * @param {string} options.appRoot   Directory holding dist/ - the repo in
   *                                   development, resources/app in an installed app.
   * @param {string} [options.dataDir] Writable per-user directory for the
   *                                   database and config. Omitted in tests.
   * @param {string} [options.envFile] Explicit development credential file.
   *                                   Installed builds leave this unset and
   *                                   use the encrypted provider settings.
   * @param {number} options.port      The preferred port.
   * @param {'fixed' | 'auto'} [options.portPolicy] `auto` replaces a port that
   *                                   cannot be used; `fixed` fails instead.
   * @param {number | null} [options.rememberedPort] The port chosen last time.
   * @param {(port: number) => void} [options.onPortChosen]
   * @param {(line: string) => void} options.onLog
   * @param {(state: object) => void} options.onState
   */
  constructor({
    appRoot,
    dataDir,
    envFile,
    port,
    portPolicy = 'fixed',
    rememberedPort = null,
    onPortChosen,
    onLog,
    onState,
    restartDelays = RESTART_DELAYS_MS,
    maxCrashes = MAX_CRASHES,
    bootTimeoutMs = BOOT_TIMEOUT_MS,
    watchdogMs = WATCHDOG_INTERVAL_MS,
    requiredBrowserRuntime,
  }) {
    this.appRoot = appRoot;
    this.requiredBrowserRuntime = requiredBrowserRuntime;
    this.dataDir = dataDir ?? null;
    this.envFile = envFile ?? null;
    this.preferredPort = port;
    this.portPolicy = portPolicy;
    this.rememberedPort = rememberedPort;
    this.port = portPolicy === 'auto' && rememberedPort ? rememberedPort : port;
    this.onPortChosen = onPortChosen ?? (() => {});
    this.onLog = onLog ?? (() => {});
    this.onState = onState ?? (() => {});
    this.restartDelays = restartDelays;
    this.maxCrashes = maxCrashes;
    this.bootTimeoutMs = bootTimeoutMs;
    this.watchdogMs = watchdogMs;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** True only when this process started the daemon. */
    this.owned = false;
    this.stopping = false;
    this.restarts = 0;
    this.crashTimes = [];
    this.bootLog = [];
    this.state = { status: 'stopped', port: this.port, owned: false, detail: null, restarts: 0 };
  }

  #set(status, detail = null) {
    this.state = { status, port: this.port, owned: this.owned, detail, restarts: this.restarts };
    this.onState(this.state);
  }

  #log(line) {
    this.bootLog.push(line);
    if (this.bootLog.length > BOOT_LOG_LINES) this.bootLog.shift();
    this.onLog(line);
  }

  #dbPath() {
    return path.join(this.dataDir ?? path.join(this.appRoot, 'data'), 'openhours.db');
  }

  /**
   * Attach to a running daemon, or start one.
   *
   * Returns the state rather than throwing: a shell that cannot start its
   * daemon must still open and say so, not fail to launch.
   */
  start() {
    if (!this.starting) this.starting = this.#startOnce().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** A person asked for it: forget the crash history and start clean. */
  async restart() {
    await this.stop();
    this.stopping = false;
    this.crashTimes = [];
    return this.start();
  }

  async #startOnce() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.#set('checking');
    const dbPath = this.#dbPath();
    try {
      const { loadLocalCredentials } = await import(pathToFileURL(path.join(this.appRoot, 'dist/src/daemon/local-auth.js')).href);
      this.credentials = loadLocalCredentials(dbPath);
    } catch (error) { this.#set('failed', `Could not load this profile's credentials: ${error.message}`); return this.state; }

    // A display version can be reused across builds, so the running implementation is
    // identified by content as well as by capability token.
    let expectedBuildId;
    try {
      const identity = await import(pathToFileURL(path.join(this.appRoot, 'dist/src/daemon/build-identity.js')).href);
      expectedBuildId = identity.buildIdentity(this.appRoot);
    } catch { expectedBuildId = undefined; }
    this.buildId = expectedBuildId;

    if (this.requiredBrowserRuntime || expectedBuildId) {
      const existing = await probe(this.rememberedPort ?? this.preferredPort, this.credentials);
      if (existing && this.requiredBrowserRuntime && existing.browserRuntime !== this.requiredBrowserRuntime) {
        this.#set('failed', 'An older OpenAgents server is still using this profile. Quit the older app from its tray icon, then reopen this version to use the bot-owned Chrome desktop.');
        return this.state;
      }
      if (existing && expectedBuildId && existing.buildId && existing.buildId !== expectedBuildId) {
        this.#set('failed', `A different OpenAgents build (${existing.buildId}) is already serving this profile; this app is ${expectedBuildId}. Quit the running OpenAgents from its tray icon, then reopen this one.`);
        return this.state;
      }
    }

    if (this.portPolicy === 'auto') {
      const unavailable = this.rememberedPort ?? this.preferredPort;
      const choice = await choosePort({
        remembered: this.rememberedPort,
        preferred: this.preferredPort,
        isOurs: async (port) => Boolean(await probe(port, this.credentials, this.requiredBrowserRuntime)),
      });
      this.port = choice.port;
      if (choice.attach) return this.#attached();
      if (choice.replaced) this.#log(`Port ${unavailable} cannot be used on this computer; using ${choice.port}.`);
    } else {
      if (await probe(this.port, this.credentials, this.requiredBrowserRuntime)) return this.#attached();
      // A real bind, not a connect: a port Windows has reserved accepts no
      // connections and still cannot be listened on.
      if (!(await canBind(this.port))) {
        this.#set('failed', `Port ${this.port} is occupied by a different or incompatible service. Choose another OPENAGENTS_PORT for this profile.`);
        return this.state;
      }
    }
    this.rememberedPort = this.port;
    this.onPortChosen(this.port);

    if (clearStaleStartupClaim(dbPath)) this.#log('Removed a startup guard left behind by an interrupted start.');
    return this.#spawn();
  }

  #attached() {
    this.owned = false;
    this.#set('attached', `Attached to a daemon already running on port ${this.port}.`);
    this.#watch();
    return this.state;
  }

  async #spawn() {
    const entry = path.join(this.appRoot, 'dist', 'src', 'daemon', 'index.js');
    this.bootLog = [];
    this.#set('starting', this.restarts > 0 ? `Restart ${this.restarts}.` : null);

    // THE DAEMON RUNS ON ELECTRON'S OWN NODE.
    //
    // `ELECTRON_RUN_AS_NODE=1` turns the Electron binary into a plain Node
    // interpreter, and that is what makes this application standalone: the
    // machine it is installed on needs no Node.js of its own, because one is
    // already inside the app. `process.execPath` is that binary - in
    // development the local Electron, in an installed app the shipped .exe.
    //
    // The same variable is the one the launcher has to CLEAR before starting
    // the window, for exactly this reason: set, it means "be Node", and the
    // window never opens. Here that is precisely what is wanted.
    const env = { ...process.env };
    env.ELECTRON_RUN_AS_NODE = '1';
    env.OPENHOURS_PORT = String(this.port);
    // The daemon exits by itself when this process is gone. See index.ts.
    env.OPENHOURS_PARENT_PID = String(process.pid);
    // Absolute, and outside the installation: an installed app's own directory
    // is read-only on a normal Windows account, and a database written beside
    // the binary would be lost on the next update anyway.
    if (this.dataDir) {
      env.OPENHOURS_DB_PATH = path.join(this.dataDir, 'openhours.db');
      // Only when it EXISTS. Naming a config file explicitly is a promise that
      // it is there, and the daemon rightly treats a missing one as fatal
      // rather than silently running something the operator did not ask for.
      // A fresh install has no config, and should boot on the built-in
      // defaults - so the variable is left unset and the daemon's own lookup
      // (which tolerates absence) runs against the data directory instead.
      const config = path.join(this.dataDir, 'openhours.config.json');
      const { existsSync } = await import('node:fs');
      if (existsSync(config)) env.OPENHOURS_CONFIG = config;
    }
    if (this.envFile) env.OPENHOURS_ENV_FILE = this.envFile;

    let child;
    try {
      child = spawn(process.env.OH_NODE ?? process.execPath, [entry], {
        // The data directory, not the install directory - the daemon resolves
        // anything relative against this.
        cwd: this.dataDir ?? this.appRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      this.#set('failed', `Could not start the daemon process: ${cause?.message ?? cause}`);
      return this.state;
    }
    this.child = child;
    this.owned = true;
    this.pendingReason = null;

    // A spawn that fails asynchronously - a bad path, a binary blocked by
    // antivirus - emits 'error' and may never emit 'exit'. It is not a crash
    // to retry: the same binary will be blocked the same way.
    child.on('error', (cause) => {
      if (this.child !== child) return;
      this.child = null;
      this.owned = false;
      this.#set('failed', `Could not start the daemon process: ${cause?.message ?? cause}`);
    });

    const relay = (stream, tag) => {
      stream.setEncoding('utf-8');
      stream.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) this.#log(`${tag}${line.replace(/\r$/, '')}`);
        }
      });
    };
    relay(child.stdout, '');
    relay(child.stderr, '! ');

    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.owned = false;
      clearInterval(this.watchdog);
      if (this.stopping) return;
      const reason = this.pendingReason ?? `The daemon exited (${signal ?? `code ${code}`}).`;
      this.pendingReason = null;
      this.#crashed(reason);
    });

    // Wait for it to answer, rather than assuming a spawned process is a
    // serving process. A daemon that refuses to boot - a bad config, a port
    // clash, a missing credential - must be reported, not shown as running.
    const deadline = Date.now() + this.bootTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child !== child) return this.state;
      if (await probe(this.port, this.credentials, this.requiredBrowserRuntime)) {
        if (this.child !== child) return this.state;
        this.#set('running', `Started a daemon on port ${this.port}.`);
        this.#watch();
        return this.state;
      }
      await sleep(400);
    }
    // Alive but never answered: a hang, handled as a crash so it is retried.
    if (this.child === child) {
      this.pendingReason = `The daemon did not answer on port ${this.port} within ${formatDelay(this.bootTimeoutMs)}.`;
      child.kill();
    }
    return this.state;
  }

  #crashed(reason) {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((at) => now - at < CRASH_WINDOW_MS);
    this.crashTimes.push(now);
    const explained = explainFailure(this.bootLog);
    const why = explained ? `${reason} ${explained}` : reason;
    if (/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Invalid file descriptor to ICU data|ERR_INVALID_PACKAGE_CONFIG/i.test(this.bootLog.join('\n'))) {
      this.#set('failed', why);
      return;
    }
    if (this.crashTimes.length > this.maxCrashes) {
      this.#set('failed', `${why} It stopped ${this.crashTimes.length} times in ${CRASH_WINDOW_MS / 60_000} minutes, so it will not be restarted automatically.`);
      return;
    }
    const delay = this.restartDelays[Math.min(this.crashTimes.length - 1, this.restartDelays.length - 1)];
    this.restarts += 1;
    this.#set('restarting', `${why} Restarting in ${formatDelay(delay)}.`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const again = () => { if (!this.stopping) void this.start(); };
      // A daemon that dies during boot dies while the start that spawned it is
      // still waiting for it. start() would hand back that same finishing
      // attempt instead of a new one, and the restart would silently never
      // happen - so wait for it to settle first.
      if (this.starting) this.starting.then(again, again);
      else again();
    }, delay);
  }

  #watch() {
    clearInterval(this.watchdog);
    let misses = 0;
    this.watchdog = setInterval(async () => {
      if (this.stopping || this.watching) return;
      if (this.state.status !== 'running' && this.state.status !== 'attached') return;
      this.watching = true;
      try {
        if (await probe(this.port, this.credentials, this.requiredBrowserRuntime)) {
          misses = 0;
          return;
        }
        misses += 1;
        if (misses >= WATCHDOG_MISSES) {
          misses = 0;
          this.#unresponsive('The daemon stopped answering.');
        }
      } finally {
        this.watching = false;
      }
    }, this.watchdogMs);
    this.watchdog.unref?.();
  }

  #unresponsive(reason) {
    clearInterval(this.watchdog);
    if (this.owned && this.child) {
      this.pendingReason = reason;
      // The exit handler treats this as a crash and restarts it.
      this.child.kill();
      return;
    }
    // A daemon this app only attached to is not ours to kill; start our own.
    this.#log(`${reason} It was not started by this app, so a new one is being started.`);
    void this.start();
  }

  /**
   * Check now instead of at the next watchdog tick - after the computer wakes
   * from sleep, when "is it still there?" is exactly the question.
   */
  async checkNow() {
    if (this.stopping || (this.state.status !== 'running' && this.state.status !== 'attached')) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await probe(this.port, this.credentials, this.requiredBrowserRuntime)) return;
      // The network stack can take a moment to come back after resume.
      await sleep(2000);
    }
    if (this.state.status === 'running' || this.state.status === 'attached') this.#unresponsive('The daemon did not answer after the computer woke up.');
  }

  /** Stop only what we started. */
  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    clearInterval(this.watchdog);
    const child = this.child;
    if (!child || !this.owned) {
      this.#set('stopped', this.state.status === 'attached' ? 'Left the existing daemon running.' : null);
      return;
    }
    this.child = null;
    await new Promise((resolve) => {
      // SIGTERM does not exist on Windows in the POSIX sense; kill() maps to
      // TerminateProcess there, but a graceful daemon may still be finishing a
      // shutdown, so allow a moment before forcing.
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 4000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.owned = false;
    this.#set('stopped', 'Stopped the daemon this app started.');
  }
}
