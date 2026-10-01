// Test the distributed self-extractor, including the second-launch cleanup
// that an unpacked Electron invocation cannot exercise. Uses its own profile,
// TEMP and process tree; never stops a user's installed application.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dockerArgv, resolveDockerHost } from '../dist/src/kernel/docker-host.js';
import { EXECUTABLE_NAMES } from './lib/app-executable.mjs';

const executable = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-portable-launch-'));
const profile = path.join(root, 'profile');
const temp = path.join(root, 'temp');
fs.mkdirSync(profile); fs.mkdirSync(temp);
fs.writeFileSync(path.join(profile, 'desktop-settings.json'), JSON.stringify({ startDockerAutomatically: false, keepRunningInBackground: true, openAtLogin: false }));
fs.writeFileSync(path.join(profile, 'local-gateway.json'), JSON.stringify({ autoStart: false }));
const env = { ...process.env, TEMP: temp, TMP: temp, OPENHOURS_DATA_DIR: profile, OPENHOURS_LLM_MODE: 'mock' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'OH_DEV', 'OH_NODE', 'OPENHOURS_AUTO_SETUP', 'OPENHOURS_PORT', 'OPENHOURS_DB_PATH', 'OPENHOURS_CONFIG', 'OPENHOURS_ENV_FILE', 'OPENHOURS_MISSION', 'OPENHOURS_BACKLOG', 'NODE_OPTIONS']) delete env[key];
const launch = () => spawn(executable, ['--background'], { env, cwd: root, windowsHide: true, stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await sleep(300); }
  throw new Error(`Timed out: ${label}`);
}
async function health() {
  try {
    const { port } = JSON.parse(fs.readFileSync(path.join(profile, 'desktop-state.json'), 'utf8'));
    const { token } = JSON.parse(fs.readFileSync(path.join(profile, 'openhours.db.auth.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    return response.ok ? response.json() : null;
  } catch { return null; }
}
function findRuntime(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '7z-out') continue; // NSIS staging copy is not the running application's directory.
    const nested = path.join(dir, entry.name);
    if (EXECUTABLE_NAMES.some(name => fs.existsSync(path.join(nested, name)))) return nested;
    const found = findRuntime(nested); if (found) return found;
  }
  return null;
}
const result = { timestamp: new Date().toISOString(), executable, profile, passed: false };
const first = launch(); first.on('error', error => { result.launchError = error.message; });
let second;
try {
  result.initialHealth = await until(health, 120_000, 'initial portable startup');
  const runtime = /-portable\.exe$/i.test(executable) ? findRuntime(temp) : path.dirname(executable);
  if (!runtime) throw new Error('Could not find the portable extraction.');
  result.runtime = runtime;
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(runtime, 'resources/app/package.json'), 'utf8'));
  result.version = packageMetadata.releaseVersion ?? packageMetadata.version;
  const files = ['icudtl.dat', 'resources/app/node_modules/@fast-csv/format/package.json', 'resources/app/dist/src/daemon/index.js', 'resources/app/desktop/build/icon.ico', 'resources/app/docker/bot-desktop/LICENSE.seccomp'];
  const before = Object.fromEntries(files.map(file => [file, fs.existsSync(path.join(runtime, file))]));
  second = launch();
  await until(() => second.exitCode !== null || second.signalCode !== null, 120_000, 'second launch handed off');
  await sleep(1500);
  result.secondExit = second.exitCode;
  result.files = files.map(file => ({ file, before: before[file], after: fs.existsSync(path.join(runtime, file)) }));
  if (result.files.some(file => !file.before || !file.after)) throw new Error('Second launch removed files from the first portable runtime.');
  result.afterSecondLaunch = await until(health, 20_000, 'health after second launch');
  // Re-run real packaged capability workers after the second extractor exits.
  const check = spawn(process.execPath, [fileURLToPath(new URL('./verify-packaged-capabilities.mjs', import.meta.url)), runtime], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; check.stdout.on('data', data => { log += data; }); check.stderr.on('data', data => { log += data; });
  const [code] = await once(check, 'exit'); result.capabilityLog = log;
  if (code !== 0) throw new Error('Capability workers failed after the second portable launch.');
  result.passed = true;
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
  for (const child of [second, first]) {
    if (!child?.pid || child.exitCode !== null) continue;
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already exited */ }
  }
  if (result.initialHealth) {
    // Forced Windows process-tree cleanup cannot run the daemon's async stop
    // handlers. Remove only this disposable profile's browser container.
    const legacy = /^0\.3\.[0-6]$/.test(result.version ?? '');
    const host = resolveDockerHost(legacy ? { ...env, OPENHOURS_WSL_DISTRO: 'Ubuntu-22.04' } : env);
    const name = `openhours-browser-${createHash('sha256').update(path.join(profile, 'openhours.db')).digest('hex').slice(0, 12)}`;
    const argv = dockerArgv(['rm', '-f', name], host);
    try { execFileSync(argv.command, argv.args, { windowsHide: true, stdio: 'ignore', timeout: 30_000 }); result.testContainerCleaned = true; }
    catch { result.testContainerCleaned = false; }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
