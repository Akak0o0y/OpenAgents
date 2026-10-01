import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LEGACY_PROFILE_FOLDER } from '../desktop/src/legacy-profile.mjs';

// Windows delivery lifecycle qualification for the per-user NSIS package.
//
// INSTALL MODE CHANGES THE CURRENT WINDOWS ACCOUNT. It installs, upgrades and uninstalls OpenAgents,
// writes the HKCU uninstall entry and uses the default %APPDATA%\OpenHours profile. Run it only in a
// disposable Windows VM or dedicated test account; preflight refuses when any OpenAgents installation,
// profile, shortcut, process or port 4001 listener exists. See docs/windows-lifecycle-qualification.md.
//
//   --preflight --evidence <file.json>
//       Read-only environment check. Safe anywhere.
//   --self-test <unpacked-dir> --evidence <file.json>
//       Rehearses seeding and verification against an unpacked package with a temporary profile and port.
//       No installer, registry, window or default profile. Not an installation qualification.
//   --old-installer <A-setup.exe> --new-installer <B-setup.exe> --confirm-disposable-machine <COMPUTERNAME> --evidence <file.json>
//       Install A, seed state, upgrade to B, restart, uninstall (profile kept), reinstall B, final uninstall.
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const evidencePath = option('evidence');
if (!evidencePath) throw new Error('Pass --evidence <file.json>. See docs/windows-lifecycle-qualification.md.');
const mode = args.includes('--preflight') ? 'preflight' : option('self-test') ? 'self-test' : 'install';

// The installed app's default port (desktop/src/ports.mjs). The app would move
// to another port if this one were taken; preflight refuses instead, so the
// harness knows where to look.
const PRODUCT = 'OpenAgents', DEFAULT_PORT = 41731;
const NOTE = 'Synthetic lifecycle note must survive install, upgrade, restart and uninstall.';
const ARTIFACT_TEXT = 'Synthetic lifecycle artifact must remain downloadable with identical bytes.';
const CONFIG = { agents: [{ id: 'lifecycle-bot', name: 'Lifecycle qualification bot', model: 'deepseek/deepseek-v4.1-flash', budgetUsd: 1 }],
  routines: [{ id: 'lifecycle-config-routine', agentId: 'lifecycle-bot', name: 'Config routine', schedule: '0 9 * * 1', prompt: 'Synthetic configured routine.', enabled: false }] };
const PRESERVED_FILES = ['openhours.db.auth.json', 'openhours.config.json'];
const installDir = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', PRODUCT);
const defaultProfile = path.join(process.env.APPDATA ?? '', LEGACY_PROFILE_FOLDER);

const sha256 = data => createHash('sha256').update(data).digest('hex');
const sha256File = file => fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
const evidence = { timestamp: new Date().toISOString(), mode, harnessSha256: sha256File(fileURLToPath(import.meta.url)),
  machine: { computerName: os.hostname(), user: os.userInfo().username, release: os.release(), node: process.version },
  scope: { preflight: 'Read-only environment eligibility check.',
    'self-test': 'Packaged daemon seeding/verification rehearsal on a temporary profile. Not an installer, upgrade, window or uninstall qualification.',
    install: 'Silent per-user NSIS install, versioned upgrade, window launch and WM_CLOSE shutdown, restart, uninstall with profile retention and reinstall. Native dialogs and interactive prompts are manual checks.' }[mode],
  steps: [], passed: false };
const save = () => { fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2)); };
async function step(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); evidence.steps.push({ name, passed: true, durationMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) }); save(); }
  catch (error) { evidence.steps.push({ name, passed: false, durationMs: Date.now() - started, error: String(error.message ?? error) }); save(); throw error; }
}
async function waitFor(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await delay(500);
  }
}

function ps(script) {
  const wrapped = `$ErrorActionPreference = 'Stop'; try { ${script} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }; exit 0`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapped], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (result.status !== 0) throw new Error(`PowerShell failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const psJson = script => { const out = ps(`${script} | ConvertTo-Json -Compress -Depth 4`); return out ? JSON.parse(out) : null; };
const quote = text => `'${String(text).replace(/'/g, "''")}'`;
const uninstallEntries = () => list(psJson(`@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '${PRODUCT}*' } | Select-Object PSChildName,PSPath,DisplayName,DisplayVersion,QuietUninstallString)`));
const openAgentsProcesses = () => list(psJson(`@(Get-Process -Name ${PRODUCT} -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle)`));
let desktopDir;
const shortcutPaths = () => [path.join(desktopDir, `${PRODUCT}.lnk`), path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT}.lnk`)];
const version = text => { const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '')); return match ? match.slice(1, 4).map(Number) : null; };
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

function portInUse(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => settle(true)); socket.once('error', () => settle(false)); socket.setTimeout(1500, () => settle(true));
  });
}
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}
function dockerVersion() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function preflight() {
  if (process.platform !== 'win32') return { findings: { platform: process.platform }, refusals: ['Windows is required.'] };
  desktopDir = ps("[Environment]::GetFolderPath('Desktop')");
  const findings = { platform: process.platform,
    elevated: ps('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)') === 'True',
    uninstallEntries: uninstallEntries().map(e => ({ key: e.PSChildName, hive: /HKEY_CURRENT_USER/.test(e.PSPath) ? 'HKCU' : 'HKLM', name: e.DisplayName, version: e.DisplayVersion })),
    installDir, installDirExists: fs.existsSync(installDir), defaultProfile, defaultProfileExists: fs.existsSync(defaultProfile),
    shortcuts: shortcutPaths().map(file => ({ file, exists: fs.existsSync(file) })), runningProcessIds: openAgentsProcesses().map(p => p.Id),
    port4001InUse: await portInUse(DEFAULT_PORT), docker: dockerVersion() };
  const refusals = [];
  if (findings.uninstallEntries.length) refusals.push('An OpenAgents installation is registered on this machine or account.');
  if (findings.installDirExists) refusals.push(`${installDir} already exists.`);
  if (findings.defaultProfileExists) refusals.push(`${defaultProfile} already exists and may be a real user profile.`);
  if (findings.shortcuts.some(s => s.exists)) refusals.push('OpenAgents shortcuts already exist.');
  if (findings.runningProcessIds.length) refusals.push('OpenAgents is running.');
  if (findings.port4001InUse) refusals.push(`Port ${DEFAULT_PORT} is in use.`);
  if (!findings.docker) refusals.push('Docker is unavailable. The daemon starts without it, but this qualification covers sandboxed work and needs it running.');
  if (findings.elevated) refusals.push('Run from the ordinary test account without elevation so the per-user installer path is exercised.');
  return { findings, refusals };
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, OPENHOURS_LLM_MODE: 'mock', OPENHOURS_EXECUTOR: 'builtin', ...extra };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'OPENHOURS_DATA_DIR', 'OPENHOURS_DB_PATH', 'OPENHOURS_CONFIG', 'OPENHOURS_PORT', 'OPENHOURS_MISSION', 'OPENHOURS_BACKLOG',
    'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENCODE_API_KEY']) if (!(key in extra)) delete env[key];
  return env;
}
const profileIdentity = dbPath => sha256(path.resolve(dbPath).toLowerCase());
const readCredentials = dbPath => { const file = `${path.resolve(dbPath)}.auth.json`; return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; };
const fingerprint = ctx => ({ database: fs.existsSync(ctx.dbPath), lockFile: fs.existsSync(`${ctx.dbPath}.lock`), windowState: fs.existsSync(path.join(ctx.profileDir, 'window-state.json')),
  files: Object.fromEntries(PRESERVED_FILES.map(file => [file, sha256File(path.join(ctx.profileDir, file))])) });

async function awaitServing(ctx, child, expectWindow) {
  let spawnError; child.on('error', error => { spawnError = error; });
  const served = await waitFor(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`${path.basename(ctx.exe)} exited with ${child.exitCode} before serving.${child.log ? ` Log: ${child.log.slice(-2000)}` : ''}`);
    const credentials = readCredentials(ctx.dbPath);
    if (!credentials) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/health`, { headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(1500) });
      return res.ok ? { credentials, health: await res.json() } : null;
    } catch { return null; }
  }, 120_000, 'the daemon to serve /health');
  const window = expectWindow ? await waitFor(() => list(psJson(`@(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,MainWindowTitle)`))[0], 60_000, 'a visible OpenAgents window') : null;
  return { child, ...served, window };
}
/** The installed application exactly as a user starts it: Electron window plus supervised daemon. */
const launchWindow = ctx => {
  // Closing the window keeps OpenAgents running in the tray by default. The
  // WM_CLOSE step qualifies shutdown, so this profile opts out of that first,
  // exactly as a person would in Settings.
  fs.mkdirSync(ctx.profileDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.profileDir, 'desktop-settings.json'), JSON.stringify({ keepRunningInBackground: false, openAtLogin: false, startDockerAutomatically: false }));
  return awaitServing(ctx, spawn(ctx.exe, [], { cwd: path.dirname(ctx.exe), env: cleanEnv(), stdio: 'ignore' }), true);
};
function launchDaemon(ctx) {
  const env = cleanEnv({ ELECTRON_RUN_AS_NODE: '1', OPENHOURS_PORT: String(ctx.port), OPENHOURS_DB_PATH: ctx.dbPath, OPENHOURS_CONFIG: path.join(ctx.profileDir, 'openhours.config.json') });
  const child = spawn(ctx.exe, [path.join(ctx.appDir, 'dist', 'src', 'daemon', 'index.js')], { cwd: ctx.profileDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.log = ''; const collect = data => { child.log = (child.log + data).slice(-16_000); }; child.stdout.on('data', collect); child.stderr.on('data', collect);
  return awaitServing(ctx, child, false);
}
/** WM_CLOSE, as the title-bar button sends; the shell must stop the daemon it started. */
async function closeWindow(ctx, app) {
  const sent = spawnSync('taskkill', ['/PID', String(app.child.pid)], { encoding: 'utf8', windowsHide: true });
  await waitFor(() => app.child.exitCode !== null, 45_000, 'the main process to exit after WM_CLOSE');
  await waitFor(async () => !(await portInUse(ctx.port)), 30_000, 'the daemon port to be released');
  await waitFor(() => openAgentsProcesses().length === 0, 30_000, 'all OpenAgents processes to exit');
  return { taskkillExit: sent.status, exitCode: app.child.exitCode, ...fingerprint(ctx) };
}
async function stopDaemon(ctx, app) {
  app.child.kill();
  await waitFor(() => app.child.exitCode !== null || app.child.signalCode !== null, 15_000, 'the daemon to exit');
  await waitFor(async () => !(await portInUse(ctx.port)), 15_000, 'the daemon port to be released');
  return fingerprint(ctx);
}
async function api(ctx, credentials, route, body) {
  const res = await fetch(`http://127.0.0.1:${ctx.port}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
  assert.equal(res.status, 200, `${route} returned ${res.status}`);
  return res;
}

/** Runs a script on the package's own Node runtime while the app is stopped. */
function packagedNode(ctx, script, input = {}) {
  const file = path.join(os.tmpdir(), `oh-lifecycle-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(file, `import { pathToFileURL } from 'node:url';\nconst { appDir, dbPath, input } = JSON.parse(process.env.OH_LIFECYCLE);\n` +
    `const load = name => import(pathToFileURL(appDir + '/dist/src/daemon/' + name).href);\n${script}`);
  try {
    const result = spawnSync(ctx.exe, [file], { env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1', OH_LIFECYCLE: JSON.stringify({ appDir: ctx.appDir, dbPath: ctx.dbPath, input }) }), encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    if (result.status !== 0) throw new Error(`Packaged Node script failed (${result.status}): ${(result.stderr || result.stdout).slice(-2000)}`);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  } finally { fs.rmSync(file, { force: true }); }
}
const SEED_STORE = `
const { AgentStore } = await load('agent-store.js'); const { ArtifactStore } = await load('artifacts.js'); const { saveWorkResult } = await load('work-results.js');
const { MissionService } = await load('missions.js'); const { DIRECT_WORK_CONTRACTS } = await load('work-contract.js');
const store = new AgentStore(dbPath);
try {
  const missions = new MissionService(store, DIRECT_WORK_CONTRACTS, 1);
  const mission = missions.create({ agentId: 'lifecycle-bot', objective: 'Synthetic paused lifecycle mission.', contractId: 'action-plan', maxRuns: 2, intervalMs: 60000 });
  missions.control(mission.id, 'PAUSED');
  const routine = store.createRoutine({ agentId: 'lifecycle-bot', name: 'Operator routine', cronExpression: '0 9 * * 1', timezone: 'UTC', promptTemplate: 'Synthetic operator routine.', enabled: false, catchUpPolicy: 'skip', nextRunAt: Date.now() + 7 * 86400000 });
  const run = store.createTaskRun({ agentId: 'lifecycle-bot', taskName: 'lifecycle-artifact' }); store.startTaskRun(run.id);
  const artifacts = new ArtifactStore(store).save(run.id, { 'lifecycle.txt': input.artifactText });
  saveWorkResult(store, run.id, { outcome: 'COMPLETED', report: 'Synthetic lifecycle artifact.', artifacts, turns: 0, inputTokens: 0, outputTokens: 0, actualCostUsd: 0, shadowCostUsd: 0 });
  store.finishTaskRun(run.id, 'COMPLETED');
  store.updateAgentStatus('lifecycle-bot', 'PAUSED');
  console.log(JSON.stringify({ missionId: mission.id, routineId: routine.id, runId: run.id, artifactId: artifacts[0].id, artifactSha256: artifacts[0].sha256 }));
} finally { store.close(); }`;
const INSPECT_STORE = `
const { AgentStore } = await load('agent-store.js');
const store = new AgentStore(dbPath);
try {
  const db = store.getDatabase(), own = row => row.agent_id === 'lifecycle-bot';
  console.log(JSON.stringify({ agentStatus: store.getAgent('lifecycle-bot')?.current_status ?? null,
    routines: db.prepare('SELECT * FROM routines').all().filter(own).map(r => ({ id: r.id, name: r.name })),
    missions: db.prepare('SELECT id, agent_id, status FROM missions').all().filter(own).map(m => ({ id: m.id, status: m.status })),
    memory: db.prepare('SELECT agent_id, key, text FROM bot_memory').all().filter(own).map(n => ({ key: n.key, text: n.text })),
    artifacts: db.prepare('SELECT agent_id, task_run_id, path, sha256 FROM run_artifacts').all().filter(own).map(a => ({ runId: a.task_run_id, path: a.path, sha256: a.sha256 })) }));
} finally { store.close(); }`;

async function verifyServing(ctx, label, app, expected) {
  await step(`${label}: authenticated profile and preserved state over HTTP`, async () => {
    assert.equal(app.health.service, 'openhours-daemon'); assert.equal(app.health.profileId, profileIdentity(ctx.dbPath));
    if (expected.token) assert.equal(app.credentials.token, expected.token, 'local credentials preserved');
    assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/api/system?agent=lifecycle-bot`, { signal: AbortSignal.timeout(5000) })).status, 401);
    const routines = (await (await api(ctx, app.credentials, '/api/routines?agent=lifecycle-bot')).json()).routines;
    assert.ok(routines.some(r => r.name === 'Config routine'), 'configured routine loaded from the preserved config');
    const detail = { profileId: app.health.profileId, window: app.window, routines: routines.map(r => r.name) };
    if (!expected.seed) return detail;
    const system = await (await api(ctx, app.credentials, '/api/system?agent=lifecycle-bot')).json();
    assert.equal(system.memory.find(note => note.key === 'lifecycle-note')?.text, NOTE);
    assert.equal(system.missions.find(m => m.id === expected.seed.missionId)?.status, 'PAUSED');
    assert.ok(routines.some(r => r.id === expected.seed.routineId), 'operator routine preserved');
    const runPath = `/api/runs/${encodeURIComponent(expected.seed.runId)}`;
    const download = await api(ctx, app.credentials, `${runPath}/artifacts/${encodeURIComponent(expected.seed.artifactId)}`);
    assert.equal(sha256(Buffer.from(await download.arrayBuffer())), expected.seed.artifactSha256); assert.equal(download.headers.get('x-content-sha256'), expected.seed.artifactSha256);
    assert.equal((await (await api(ctx, app.credentials, `${runPath}/result`)).json()).result.outcome, 'COMPLETED');
    return detail;
  });
}
async function verifyStored(ctx, label, seed, baseline) {
  await step(`${label}: stored state and profile files after shutdown`, async () => {
    const state = packagedNode(ctx, INSPECT_STORE);
    assert.equal(state.agentStatus, 'PAUSED', 'paused bot stays paused');
    assert.equal(state.missions.find(m => m.id === seed.missionId)?.status, 'PAUSED', 'paused mission stays paused');
    assert.equal(state.memory.find(note => note.key === 'lifecycle-note')?.text, NOTE);
    assert.ok(state.routines.some(r => r.id === seed.routineId)); assert.ok(state.artifacts.some(a => a.runId === seed.runId && a.sha256 === seed.artifactSha256));
    const files = fingerprint(ctx);
    for (const file of PRESERVED_FILES) assert.equal(files.files[file], baseline.files[file], `${file} unchanged`);
    return { agentStatus: state.agentStatus, missions: state.missions, routines: state.routines.length, artifacts: state.artifacts.length, profile: files };
  });
}

async function selfTest(directory) {
  const dir = path.resolve(directory), profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-lifecycle-selftest-'));
  const ctx = { appDir: path.join(dir, 'resources', 'app'), exe: path.join(dir, `${PRODUCT}.exe`), profileDir, dbPath: path.join(profileDir, 'openhours.db'), port: await freePort() };
  assert.ok(fs.existsSync(ctx.exe) && fs.existsSync(ctx.appDir), 'unpacked package directory');
  evidence.package = { directory: dir, exeSha256: sha256File(ctx.exe), version: JSON.parse(fs.readFileSync(path.join(ctx.appDir, 'package.json'), 'utf8')).version,
    missionsModuleSha256: sha256File(path.join(ctx.appDir, 'dist', 'src', 'daemon', 'missions.js')), profileDir, port: ctx.port };
  fs.writeFileSync(path.join(profileDir, 'openhours.config.json'), JSON.stringify(CONFIG, null, 2));
  let app, seed, baseline, token;
  try {
    await step('first packaged daemon boot and HTTP seeding', async () => {
      app = await launchDaemon(ctx); token = app.credentials.token;
      await api(ctx, app.credentials, '/api/system/memory', { agentId: 'lifecycle-bot', key: 'lifecycle-note', text: NOTE });
      return { profileId: app.health.profileId };
    });
    await verifyServing(ctx, 'first boot', app, {});
    await step('stop daemon', async () => { const detail = await stopDaemon(ctx, app); app = undefined; return detail; });
    await step('seed store state with the packaged runtime', async () => { seed = packagedNode(ctx, SEED_STORE, { artifactText: ARTIFACT_TEXT }); baseline = fingerprint(ctx); return { seed, baseline }; });
    for (const label of ['seeded boot', 'restart']) {
      await step(`${label}: daemon boot`, async () => { app = await launchDaemon(ctx); return { profileId: app.health.profileId }; });
      await verifyServing(ctx, label, app, { seed, token });
      await step(`${label}: stop daemon`, async () => { const detail = await stopDaemon(ctx, app); app = undefined; return detail; });
      await verifyStored(ctx, label, seed, baseline);
    }
  } finally { if (app?.child.exitCode === null) app.child.kill(); }
}

async function installLifecycle(ctx) {
  const info = file => {
    const resolved = path.resolve(file);
    const meta = psJson(`Get-Item -LiteralPath ${quote(resolved)} | Select-Object @{n='productVersion';e={$_.VersionInfo.ProductVersion}},@{n='fileVersion';e={$_.VersionInfo.FileVersion}}`);
    const signature = psJson(`Get-AuthenticodeSignature -LiteralPath ${quote(resolved)} | Select-Object @{n='status';e={[string]$_.Status}},@{n='signer';e={if ($_.SignerCertificate) { $_.SignerCertificate.Subject } else { $null }}}`);
    return { file: resolved, bytes: fs.statSync(resolved).size, sha256: sha256File(resolved), productVersion: meta?.productVersion, fileVersion: meta?.fileVersion, signature };
  };
  const installers = { old: info(option('old-installer')), new: info(option('new-installer')) };
  evidence.installers = installers;
  const oldVersion = version(installers.old.productVersion), newVersion = version(installers.new.productVersion);
  assert.ok(oldVersion && newVersion && newer(newVersion, oldVersion), `The new installer (${installers.new.productVersion}) must be a higher version than the old (${installers.old.productVersion}).`);
  let app, seed, baseline, token, shortcutsAfterInstall = [];

  const install = (label, installer) => step(`${label}: silent per-user install of ${installer.productVersion}`, async () => {
    const expected = version(installer.productVersion).join('.'), before = uninstallEntries().map(e => e.DisplayVersion), started = Date.now();
    const result = spawnSync(installer.file, ['/S', '/currentuser'], { windowsHide: true, timeout: 600_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'installer exit code');
    const entry = await waitFor(() => uninstallEntries().find(e => version(e.DisplayVersion)?.join('.') === expected), 120_000, `a registered ${expected} installation`);
    await waitFor(() => fs.existsSync(ctx.exe) && fs.existsSync(path.join(installDir, `Uninstall ${PRODUCT}.exe`)), 60_000, 'the installed executable and uninstaller');
    assert.equal(uninstallEntries().length, 1, 'exactly one registered OpenAgents installation'); assert.match(entry.PSPath, /HKEY_CURRENT_USER/, 'per-user registration');
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.appDir, 'package.json'), 'utf8')).version, expected, 'installed application version');
    shortcutsAfterInstall = shortcutPaths().filter(file => fs.existsSync(file));
    return { exitCode: result.status, durationMs: Date.now() - started, previousVersions: before, registryKey: entry.PSChildName, displayVersion: entry.DisplayVersion,
      exeSha256: sha256File(ctx.exe), missionsModuleSha256: sha256File(path.join(ctx.appDir, 'dist', 'src', 'daemon', 'missions.js')), shortcuts: shortcutsAfterInstall };
  });
  const uninstall = label => step(`${label}: silent uninstall removes the application and keeps the profile`, async () => {
    const result = spawnSync(path.join(installDir, `Uninstall ${PRODUCT}.exe`), ['/S', '/currentuser'], { windowsHide: true, timeout: 600_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'uninstaller exit code');
    await waitFor(() => uninstallEntries().length === 0, 120_000, 'the uninstall registration to be removed');
    await waitFor(() => !fs.existsSync(ctx.exe), 120_000, 'the installed executable to be removed');
    const profile = fingerprint(ctx), remainingShortcuts = shortcutsAfterInstall.filter(file => fs.existsSync(file));
    assert.deepEqual(remainingShortcuts, [], 'shortcuts created by the installer are removed');
    assert.ok(profile.database, 'database kept (deleteAppDataOnUninstall: false)');
    for (const file of PRESERVED_FILES) assert.equal(profile.files[file], baseline.files[file], `${file} kept unchanged`);
    return { exitCode: result.status, remainingInstallFiles: fs.existsSync(installDir) ? fs.readdirSync(installDir) : [], profile };
  });
  const session = async (label, check) => {
    await step(`${label}: launch opens a window and starts the daemon`, async () => { app = await launchWindow(ctx); return { pid: app.child.pid, window: app.window, profileId: app.health.profileId }; });
    await check();
    await step(`${label}: WM_CLOSE stops the window and its daemon`, async () => { const detail = await closeWindow(ctx, app); app = undefined; return detail; });
  };

  try {
    fs.mkdirSync(ctx.profileDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.profileDir, 'openhours.config.json'), JSON.stringify(CONFIG, null, 2));
    await install('old', installers.old);
    await session('old first launch', async () => {
      await verifyServing(ctx, 'old first launch', app, {}); token = app.credentials.token;
      await step('old first launch: seed memory over HTTP', async () => { await api(ctx, app.credentials, '/api/system/memory', { agentId: 'lifecycle-bot', key: 'lifecycle-note', text: NOTE }); });
    });
    await step('old: seed mission, routine, artifact and paused bot with the installed runtime', async () => { seed = packagedNode(ctx, SEED_STORE, { artifactText: ARTIFACT_TEXT }); baseline = fingerprint(ctx); return { seed, baseline }; });
    await session('old seeded launch', () => verifyServing(ctx, 'old seeded launch', app, { seed, token }));
    await verifyStored(ctx, 'old seeded launch', seed, baseline);
    await install('upgrade', installers.new);
    for (const label of ['upgraded launch', 'restart']) {
      await session(label, () => verifyServing(ctx, label, app, { seed, token }));
      await verifyStored(ctx, label, seed, baseline);
    }
    await uninstall('uninstall');
    await install('reinstall', installers.new);
    await session('reinstalled launch', () => verifyServing(ctx, 'reinstalled launch', app, { seed, token }));
    await verifyStored(ctx, 'reinstalled launch', seed, baseline);
    await uninstall('final uninstall');
  } finally {
    const remaining = openAgentsProcesses();
    if (remaining.length) { spawnSync('taskkill', ['/IM', `${PRODUCT}.exe`, '/T', '/F'], { windowsHide: true }); evidence.forcedCleanup = remaining.map(p => p.Id); }
  }
}

try {
  evidence.preflight = await preflight();
  if (mode === 'preflight') {
    evidence.eligibleForInstallMode = evidence.preflight.refusals.length === 0;
    evidence.passed = evidence.eligibleForInstallMode;
  } else if (mode === 'self-test') {
    await selfTest(option('self-test'));
    evidence.passed = evidence.steps.length > 0 && evidence.steps.every(s => s.passed);
  } else {
    const refusals = [...evidence.preflight.refusals];
    if (option('confirm-disposable-machine') !== os.hostname()) refusals.push('Pass --confirm-disposable-machine with this computer name to confirm a disposable VM or dedicated test account.');
    for (const name of ['old-installer', 'new-installer']) if (!option(name) || !fs.existsSync(option(name))) refusals.push(`--${name} must name an existing installer.`);
    if (refusals.length) evidence.refused = refusals;
    else {
      evidence.manualChecks = [
        { id: 'M1-save-dialog', result: 'NOT_RUN', instruction: 'Download lifecycle.txt from the seeded run in the installed app. Cancel creates no file; Save writes bytes whose SHA-256 matches the recorded artifact.' },
        { id: 'M2-window-controls', result: 'NOT_RUN', instruction: 'Minimize, maximize, restore, resize and close with the title-bar button; relaunch restores geometry; a second launch focuses the first window.' },
        { id: 'M3-interactive-install', result: 'NOT_RUN', instruction: 'Run the new installer interactively while the app is open; record the close-app prompt and the unsigned publisher or SmartScreen text.' },
        { id: 'M4-update-channel', result: 'NOT_RUN', instruction: 'Help > Check for updates reports that no update channel is configured.' },
      ];
      await installLifecycle({ appDir: path.join(installDir, 'resources', 'app'), exe: path.join(installDir, `${PRODUCT}.exe`), profileDir: defaultProfile, dbPath: path.join(defaultProfile, 'openhours.db'), port: DEFAULT_PORT });
      evidence.passed = evidence.steps.length > 0 && evidence.steps.every(s => s.passed) && !evidence.forcedCleanup;
    }
  }
} catch (error) { evidence.error = String(error.message ?? error); evidence.passed = false; }
finally {
  save();
  console.log(JSON.stringify({ mode, passed: evidence.passed, refused: mode === 'self-test' ? undefined : evidence.refused ?? evidence.preflight?.refusals, error: evidence.error, steps: evidence.steps.map(s => `${s.passed ? 'PASS' : 'FAIL'} ${s.name}`) }, null, 2));
  process.exitCode = evidence.passed ? 0 : 1;
}
