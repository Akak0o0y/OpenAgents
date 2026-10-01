// Disposable packaged upgrade check for Stage 1, honest posting (spec section 15, steps 2 and 3).
//
// It boots the OLD app's daemon on a new temporary profile, so the database is created by the old
// version, stores a memory note and a paused mission through its API, and stops it. It then writes
// live-shaped history into that disposable database with the old version's own AgentStore: a routine
// whose last post click finished (the gqw8h shape), a routine whose post click was never confirmed
// (the wveu4 shape), and a run of a routine that is deleted afterwards (the yf8vs shape). It boots
// the NEW package's daemon on the same profile and checks, through the authenticated system API,
// that the profile survived and what the owner sees on the first start after the upgrade.
//
// No model runs (mock model, no provider keys), FreeLLMAPI stays off (local-gateway.json autoStart
// false), no routine is due, no browser or bot desktop opens, nothing is sent anywhere, and the
// owner's profile is never opened. The disposable profile's bearer token is read into memory for
// these requests only and is never printed or written.
//
// Usage: node scripts/verify-publish-upgrade.mjs <old app directory> <new unpacked directory> <evidence JSON>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appExecutable } from './lib/app-executable.mjs';

const [oldDirectory, newDirectory, output] = process.argv.slice(2);
if (!oldDirectory || !newDirectory || !output || ![oldDirectory, newDirectory, output].every(p => path.isAbsolute(p))) {
  throw new Error('Pass absolute paths: the old app directory, the new unpacked directory and the evidence JSON file.');
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildIdentity } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'src', 'daemon', 'build-identity.js')).href);
const AGENT = 'agent-alpha';
const X = 'https://x.com';
const UNCERTAIN = 'Browser interaction outcome is uncertain. Inspect the page and action history; do not repeat the submission automatically.';
const NOTE = 'Synthetic upgrade note: it must survive replacing the application files.';
const appOf = directory => path.join(directory, 'resources', 'app');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stage1In = directory => fs.existsSync(path.join(appOf(directory), 'dist', 'src', 'daemon', 'publish-policy.js'));
const redact = text => String(text).replace(/[0-9a-f]{32,}/gi, '[redacted]');
if (stage1In(oldDirectory)) throw new Error('The old app already contains Stage 1; this check needs a pre-Stage 1 version as the old one.');
if (!stage1In(newDirectory)) throw new Error('The new app does not contain Stage 1 (dist/src/daemon/publish-policy.js). Build it with npm run app:dir first.');

// The same implementation files verify-packaged-profile.mjs compares, which every version has.
const implementationSha256 = app => createHash('sha256').update(
  ['daemon/missions.js', 'daemon/work-runtime.js', 'daemon/browser-tools.js', 'evals/llm-client.js']
    .map(relative => `${relative}:${sha256(path.join(app, 'dist', 'src', relative))}`).join('\n'),
).digest('hex');
const describe = directory => {
  const app = appOf(directory);
  const executable = appExecutable(directory);
  return { directory, executable, executableSha256: sha256(executable), version: JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version,
    buildIdentity: buildIdentity(app), implementationSha256: implementationSha256(app) };
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-publish-upgrade-'));
const dbPath = path.join(profile, 'state.db');
// Both daemons read this file (index.ts, LocalGatewayService): FreeLLMAPI is not started for the disposable profile.
fs.writeFileSync(path.join(profile, 'local-gateway.json'), JSON.stringify({ autoStart: false }) + '\n');
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
});
const evidence = {
  at: new Date().toISOString(),
  scope: 'Produced package, first start after an upgrade from an older unpacked app, on a disposable live-shaped profile. '
    + 'Daemons run with a mock model, no provider keys and FreeLLMAPI off; no routine is due; no browser, bot desktop or network write. Not the owner\'s profile, not an NSIS installation.',
  profile, port,
  old: describe(oldDirectory),
  new: describe(newDirectory),
  fixture: {},
  checks: [],
  passed: false,
};

let child;
let log = '';
async function boot(directory) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENHOURS_CONFIG: 'none', OPENHOURS_LLM_MODE: 'mock', OPENHOURS_EXECUTOR: 'builtin', OPENHOURS_PORT: String(port), OPENHOURS_DB_PATH: dbPath };
  for (const key of ['OPENHOURS_MISSION', 'OPENHOURS_BACKLOG', 'OPENHOURS_AUTO_SETUP', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENCODE_API_KEY']) delete env[key];
  log = '';
  child = spawn(appExecutable(directory), [path.join(appOf(directory), 'dist', 'src', 'daemon', 'index.js')], { env, cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const collect = data => { log = (log + String(data)).slice(-32_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`The daemon of ${directory} exited with ${child.exitCode ?? child.signalCode}.`);
    const authFile = `${dbPath}.auth.json`;
    if (fs.existsSync(authFile)) {
      const headers = { Authorization: `Bearer ${JSON.parse(fs.readFileSync(authFile, 'utf8')).token}` };
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { headers, signal: AbortSignal.timeout(1000) });
        if (res.ok) return { headers, health: await res.json() };
      } catch { /* not listening yet */ }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`The daemon of ${directory} did not answer /health within 60 s.`);
}
async function stop() {
  // A process ended by a signal has exitCode null and signalCode set (always so on Windows).
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const running = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { running.kill('SIGKILL'); reject(new Error('The packaged daemon did not stop within 7 s.')); }, 7000);
    running.once('exit', () => { clearTimeout(timer); resolve(); });
    running.kill('SIGTERM');
  });
}
const api = async (headers, route, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { ...headers, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
  const json = await res.json();
  assert.equal(res.status, 200, `${route}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};
const check = async (name, fn) => {
  try {
    const detail = await fn();
    evidence.checks.push({ name, passed: true, detail });
    console.log(`PASS ${name}: ${detail}`);
  } catch (error) {
    const detail = String(error?.message ?? error).slice(0, 2000);
    evidence.checks.push({ name, passed: false, detail });
    console.log(`FAIL ${name}: ${detail}`);
  }
};

try {
  const first = await boot(oldDirectory);
  evidence.old.profileId = first.health.profileId;
  await api(first.headers, '/api/system/memory', { agentId: AGENT, key: 'upgrade-note', text: NOTE });
  const mission = (await api(first.headers, '/api/system/missions', { agentId: AGENT, objective: 'Synthetic paused upgrade review', contractId: 'action-plan', maxRuns: 2, intervalMs: 60_000 })).mission;
  await api(first.headers, '/api/system/mission-state', { id: mission.id, state: 'PAUSED' });
  await stop();

  // Live-shaped history, written by the old version's own store code while no daemon runs.
  const { AgentStore } = await import(pathToFileURL(path.join(appOf(oldDirectory), 'dist', 'src', 'daemon', 'agent-store.js')).href);
  const store = new AgentStore(dbPath);
  try {
    assert.ok(store.getAgent(AGENT), 'The old version seeds agent-alpha on a new profile.');
    const notDue = Date.now() + 30 * 86_400_000;
    const routine = name => store.createRoutine({ agentId: AGENT, name, cronExpression: '*/15 * * * *', promptTemplate: `Upgrade fixture ${name}. It is not due, so it never runs.`, nextRunAt: notDue });
    const pastRun = (r, status, steps) => {
      const run = store.createTaskRun({ agentId: AGENT, taskName: `routine-${r.id}`, routineId: r.id });
      // What enqueueRoutine records for a real occurrence; it also binds task_runs.routine_id.
      store.recordRoutineRun(r.id, run.id, 'QUEUED', notDue);
      const at = Date.now() - 3_600_000;
      store.recordEvent({ task_run_id: run.id, agent_id: AGENT, event_type: 'ROUTINE_TRIGGERED', payload_json: JSON.stringify({ routineId: r.id, routineName: r.name, source: 'schedule' }), timestamp: at });
      store.startTaskRun(run.id);
      steps.forEach(([type, payload], index) => store.recordEvent({ task_run_id: run.id, agent_id: AGENT, event_type: type, payload_json: JSON.stringify(payload), timestamp: at + (index + 1) * 1000 }));
      store.finishTaskRun(run.id, status, status === 'COMPLETED' ? undefined : UNCERTAIN);
      assert.equal(store.getTaskRun(run.id)?.routine_id, r.id, 'The fixture run is bound to its routine.');
      return run.id;
    };
    const started = (actionId, action) => ['EXTERNAL_ACTION_STARTED', { actionId, transport: 'browser', origin: X, action }];
    const finished = actionId => ['EXTERNAL_ACTION_FINISHED', { actionId, transport: 'browser' }];
    const honest = routine('honest-tweet (upgrade fixture)');
    const viral = routine('viral-life (upgrade fixture)');
    const milo = routine('Milo life');
    evidence.fixture = {
      honest: honest.id, viral: viral.id, milo: milo.id,
      gqw8h: pastRun(honest, 'COMPLETED', [started('g-fill', 'fill'), finished('g-fill'), started('g-click', 'click'), finished('g-click')]),
      wveu4: pastRun(viral, 'FAILED', [started('w-fill', 'fill'), finished('w-fill'), started('w-click', 'click')]),
      yf8vs: pastRun(milo, 'FAILED', [started('y-click', 'click')]),
    };
    assert.equal(store.deleteRoutine(milo.id), true, 'The Milo life fixture routine is deleted, as the real one was.');
  } finally {
    store.close();
  }
  const f = evidence.fixture;

  const second = await boot(newDirectory);
  evidence.new.profileId = second.health.profileId;
  const state = await api(second.headers, `/api/system?agent=${AGENT}`);
  await check('the profile, its memory note and its paused mission survive the upgrade', () => {
    assert.equal(second.health.profileId, evidence.old.profileId, 'The new version opened the same profile.');
    assert.equal(state.memory.find(note => note.key === 'upgrade-note')?.text, NOTE);
    assert.equal(state.missions.find(m => m.id === mission.id)?.status, 'PAUSED');
    assert.notEqual(evidence.old.implementationSha256, evidence.new.implementationSha256, 'The two boots ran different implementations.');
    return `profile ${second.health.profileId} kept its memory note and its PAUSED mission; the implementation changed from ${evidence.old.implementationSha256.slice(0, 12)}… to ${evidence.new.implementationSha256.slice(0, 12)}….`;
  });
  await check('both live routines must post, seeded from history', () => {
    assert.ok(Array.isArray(state.publishPolicies), 'GET /api/system has publishPolicies.');
    const byRoutine = new Map(state.publishPolicies.map(p => [p.routineId, p]));
    const honest = byRoutine.get(f.honest);
    const viral = byRoutine.get(f.viral);
    assert.deepEqual([honest?.required, honest?.source, honest?.evidenceRunId, honest?.origin], [true, 'history', f.gqw8h, X]);
    assert.deepEqual([viral?.required, viral?.source, viral?.evidenceRunId, viral?.origin], [true, 'history', f.wveu4, X]);
    assert.equal(byRoutine.has(f.milo), false, 'A deleted routine gets no policy row.');
    return `honest-tweet from ${f.gqw8h} and viral-life from ${f.wveu4}, both required from history on ${X}; the deleted routine has no row.`;
  });
  await check('the wveu4-shaped click holds viral-life and is marked from before the install', () => {
    assert.ok(Array.isArray(state.pendingEffects), 'GET /api/system has pendingEffects.');
    const own = state.pendingEffects.filter(item => item.routineId === f.viral && !item.routineDeleted);
    assert.equal(own.length, 1, JSON.stringify(own));
    assert.deepEqual([own[0].runId, own[0].kind, own[0].before, own[0].origin], [f.wveu4, 'action', true, X]);
    assert.ok(own[0].detail.startsWith(`Not started: run ${f.wveu4} at `), own[0].detail);
    assert.ok(own[0].detail.endsWith(' UTC submitted something on x.com whose result was never confirmed. Check the account, then choose “Checked — continue” on this routine.'), own[0].detail);
    assert.equal(state.pendingEffects.some(item => item.routineId === f.honest), false, 'honest-tweet has no item of its own, so it is not held.');
    return `viral-life is held by ${f.wveu4} (kind action, before: true); honest-tweet has no item of its own.`;
  });
  await check('the yf8vs-shaped click of the deleted routine is listed and holds nothing', () => {
    const deleted = state.pendingEffects.filter(item => item.routineDeleted);
    assert.equal(deleted.length, 1, JSON.stringify(deleted));
    assert.deepEqual([deleted[0].runId, deleted[0].routineId, deleted[0].routineName, deleted[0].before, deleted[0].origin], [f.yf8vs, f.milo, 'Milo life', true, X]);
    return `${f.yf8vs} of the deleted "Milo life" is listed with before: true.`;
  });
  await check('"Checked — continue" on viral-life clears both items', async () => {
    assert.deepEqual(await api(second.headers, '/api/system/routine-acknowledge', { agentId: AGENT, routineId: f.viral }), { acknowledged: 2 });
    const after = await api(second.headers, `/api/system?agent=${AGENT}`);
    assert.deepEqual(after.pendingEffects, []);
    return 'routine-acknowledge returned { acknowledged: 2 }, and pendingEffects is empty afterwards.';
  });
  await stop();
  evidence.passed = evidence.checks.length === 5 && evidence.checks.every(c => c.passed);
} catch (error) {
  evidence.error = redact(String(error?.message ?? error)).slice(0, 2000);
  evidence.log = redact(log).slice(-4000);
} finally {
  try { await stop(); } catch (error) { evidence.stopError = String(error?.message ?? error); evidence.passed = false; }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  // The disposable profile holds only synthetic data and a stopped daemon's token. It is removed after a
  // pass and kept after a failure for diagnosis.
  if (evidence.passed) fs.rmSync(profile, { recursive: true, force: true });
  process.exitCode = evidence.passed ? 0 : 1;
}
