// Running commands and launching applications on the bot's own computer.
//
// This is the container the bot owns, never the host: there is no host filesystem
// here, the process runs as the unprivileged `bot` user under the image's seccomp
// profile, and all network egress still goes through the proxy. A command that
// fails returns its real exit status - nothing here turns a failure into success.
import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_COMMAND = 8000;
const MAX_OUTPUT = 200000;
const MIN_TIMEOUT = 1000;
const MAX_TIMEOUT = 300000;
const DEFAULT_TIMEOUT = 60000;

/** Applications the desktop ships, launchable by name rather than by path. */
export const APPS = {
  files: ['thunar', []],
  terminal: ['xfce4-terminal', []],
  editor: ['mousepad', []],
  images: ['ristretto', []],
  archives: ['xarchiver', []],
  chrome: ['/usr/local/bin/openhours-chrome', []],
};

const home = () => process.env.HOME ?? '/home/bot';

/** Confine a path to the bot's home, following the same rule as the file tools. */
export function resolveInHome(candidate) {
  const target = path.resolve(home(), candidate ?? '.');
  const root = path.resolve(home());
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Paths outside the bot home directory are not reachable.');
  }
  return target;
}

export function validateExecInput(input) {
  if (!input || typeof input.command !== 'string' || !input.command.trim()) throw new Error('Supply a command to run.');
  if (input.command.length > MAX_COMMAND) throw new Error(`Commands are limited to ${MAX_COMMAND} characters.`);
  if (input.command.includes('\0')) throw new Error('A command may not contain a null byte.');
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT;
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) {
    throw new Error(`Supply a timeout between ${MIN_TIMEOUT} and ${MAX_TIMEOUT} milliseconds.`);
  }
  resolveInHome(input.cwd);
}

export function validateAppInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Supply an application to launch or a path to open.');
  if (input.app !== undefined && !Object.hasOwn(APPS, input.app)) {
    throw new Error(`Unknown application. Available: ${Object.keys(APPS).join(', ')}.`);
  }
  if (input.open !== undefined) {
    if (typeof input.open !== 'string' || !input.open.trim()) throw new Error('Supply a path or URL to open.');
    if (/^https?:\/\//.test(input.open)) {
      const url = new URL(input.open);
      if (url.username || url.password) throw new Error('A URL may not carry credentials.');
    } else resolveInHome(input.open);
  }
  if (input.app === undefined && input.open === undefined) throw new Error('Supply an application to launch or a path to open.');
}

/** The child inherits only what a desktop program needs, so nothing the daemon
 * placed in this container's environment - proxy credentials included - leaks
 * into a command the model composed. */
export function childEnv() {
  const proxy = process.env.OPENHOURS_EGRESS_PROXY ?? 'http://127.0.0.1:3128';
  return {
    HOME: home(),
    USER: 'bot',
    LOGNAME: 'bot',
    SHELL: '/bin/bash',
    // pip --user and the npm prefix below install into the bot's own home, the only
    // writable place: this user is not root and must not become root to add a tool.
    PATH: `${home()}/.local/bin:${home()}/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    NPM_CONFIG_PREFIX: `${home()}/.npm-global`,
    // npm and pip reach the network the way Chrome does. Without these they hang and then
    // fail, and the only alternative would be opening unfiltered egress from this container.
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    DISPLAY: process.env.DISPLAY ?? ':1',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '/tmp/openhours-runtime',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
  };
}

export async function executeExec(input, spawnFn = spawn) {
  validateExecInput(input);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
  const child = spawnFn('/bin/bash', ['-lc', input.command], {
    cwd: resolveInHome(input.cwd),
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '', stderr = '', truncated = false;
  const collect = (stream, append) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      const room = MAX_OUTPUT - (stdout.length + stderr.length);
      if (room <= 0) { truncated = true; return; }
      if (chunk.length > room) { truncated = true; chunk = chunk.slice(0, room); }
      append(chunk);
    });
  };
  collect(child.stdout, chunk => { stdout += chunk; });
  collect(child.stderr, chunk => { stderr += chunk; });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Kill the whole process group: a shell that spawned children would otherwise
    // keep them running with nothing left to report their outcome.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, timeoutMs);
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    return {
      exitCode: timedOut ? null : code,
      signal: signal ?? undefined,
      stdout, stderr, truncated, timedOut,
      // Said plainly, because a timed-out command may have already changed something.
      note: timedOut ? `The command was still running after ${timeoutMs} ms and was stopped. Any work it had already done was not undone.` : undefined,
    };
  } finally { clearTimeout(timer); }
}

export async function launchApp(input, spawnFn = spawn) {
  validateAppInput(input);
  const [file, args] = input.app ? APPS[input.app] : ['/usr/bin/xdg-open', []];
  const target = input.open === undefined ? []
    : [/^https?:\/\//.test(input.open) ? input.open : resolveInHome(input.open)];
  const child = spawnFn(file, [...args, ...target], {
    cwd: home(), env: childEnv(), stdio: 'ignore', detached: true,
  });
  child.unref();
  return { launched: input.app ?? 'xdg-open', opened: target[0] };
}
