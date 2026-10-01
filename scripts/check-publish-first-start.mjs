// The produced package on a paused copy of the owner's profile (spec section 15, steps 2 and 3).
//
// It copies openhours.db with its -wal and -shm files into a new temporary folder, checks the copy
// and pauses it: no routine keeps a timetable, active missions are paused and queued runs are
// aborted, so nothing can run. The package's daemon then starts on the copy with a mock model, no
// provider keys, no config file and FreeLLMAPI off. The check reads what the owner will see on the
// first start through the authenticated system API, then presses "Checked — continue" on viral-life,
// in the copy only. The copy is deleted afterwards, whatever happened.
//
// Bot desktops are named from the database path (bot-desktop.ts identity), so the copy's can never be
// Milo's container or volume, and no browser opens because nothing runs. The owner's file is only
// read; the owner's .auth.json is never read. The output holds ids, routine names, times, origins
// and flags, and no event text, token or credential field.
//
// Usage: node scripts/check-publish-first-start.mjs <new unpacked dir> <openhours.db> <evidence JSON> [--no-boot]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appExecutable } from './lib/app-executable.mjs';

/** The real runs the release note talks about (spec section 16). */
export const RUNS = { gqw8h: 'run-1790064930008-gqw8h', wveu4: 'run-1790074518658-wveu4', yf8vs: 'run-1789974004374-yf8vs' };
const X = 'https://x.com';
export const utcMinute = at => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

/**
 * The release-note facts (spec 15, step 3) checked against what the package's API returned.
 * `facts.routines` holds the ids of the routines of gqw8h and wveu4, read from the copy.
 */
export function evaluateFirstStart(facts, first, acknowledged, after) {
  const honest = facts.routines.honest?.id;
  const viral = facts.routines.viral?.id;
  const policy = id => first.publishPolicies.find(p => p.routineId === id);
  const items = first.pendingEffects;
  const own = id => items.filter(item => item.routineId === id && !item.routineDeleted);
  const wveu4 = own(viral).find(item => item.runId === RUNS.wveu4);
  const yf8vs = items.find(item => item.runId === RUNS.yf8vs);
  const seeded = (id, run) => !!id && policy(id)?.required === true && policy(id)?.source === 'history' && policy(id)?.evidenceRunId === run;
  const list = rows => rows.map(item => `${item.runId} ${utcMinute(item.at)} UTC`).join(', ') || 'none';
  return [
    { fact: 'this profile had not been opened by a Stage 1 build before', holds: !facts.stage1AlreadyStarted,
      detail: facts.stage1AlreadyStarted ? 'the copy already had routine_publish_meta' : 'no routine_publish_meta before the start' },
    { fact: 'honest-tweet must post, seeded from history with run gqw8h as its evidence', holds: seeded(honest, RUNS.gqw8h),
      detail: JSON.stringify(policy(honest) ?? null) },
    { fact: 'viral-life must post, seeded from history with run wveu4 as its evidence', holds: seeded(viral, RUNS.wveu4),
      detail: JSON.stringify(policy(viral) ?? null) },
    { fact: 'viral-life waits on run wveu4 (22 Sep 2026, 10:56 UTC), marked from before the install',
      holds: !!wveu4 && wveu4.before === true && wveu4.origin === X && utcMinute(wveu4.at) === '2026-09-22 10:56',
      detail: `viral-life items: ${list(own(viral))}` },
    { fact: 'honest-tweet has no item of its own, so it keeps running', holds: !!honest && own(honest).length === 0,
      detail: `honest-tweet items: ${list(own(honest))}` },
    { fact: 'run yf8vs of the deleted "Milo life" (21 Sep 2026, 07:02 UTC) is listed on both routines and holds neither',
      holds: !!yf8vs && yf8vs.routineDeleted === true && yf8vs.routineName === 'Milo life' && yf8vs.before === true && yf8vs.origin === X
        && utcMinute(yf8vs.at) === '2026-09-21 07:02' && [honest, viral].every(id => policy(id)?.origin === yf8vs.origin),
      detail: yf8vs ? JSON.stringify({ runId: yf8vs.runId, routineName: yf8vs.routineName, routineDeleted: yf8vs.routineDeleted, before: yf8vs.before, at: utcMinute(yf8vs.at) }) : 'not listed' },
    { fact: '"Checked — continue" on viral-life marks wveu4 and yf8vs as checked',
      holds: acknowledged !== null && acknowledged >= 2 && !!after && !after.pendingEffects.some(item => item.runId === RUNS.wveu4 || item.runId === RUNS.yf8vs),
      detail: `acknowledged ${acknowledged}; left afterwards: ${after ? list(after.pendingEffects) : 'not read'}` },
  ];
}

async function main() {
  const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const noBoot = process.argv.includes('--no-boot');
  const [newDirectory, source, output] = args;
  if (!newDirectory || !source || !output || ![newDirectory, source, output].every(p => path.isAbsolute(p))) {
    throw new Error('Pass absolute paths: the new unpacked directory, the openhours.db to copy and the evidence JSON file.');
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { buildIdentity } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'src', 'daemon', 'build-identity.js')).href);
  const app = path.join(newDirectory, 'resources', 'app');
  if (!fs.existsSync(path.join(app, 'dist', 'src', 'daemon', 'publish-policy.js'))) throw new Error('The new app does not contain Stage 1 (dist/src/daemon/publish-policy.js). Build it with npm run app:dir first.');
  if (!fs.existsSync(source)) throw new Error(`No database at ${source}.`);
  const sourceStat = fs.statSync(source);
  const report = {
    at: new Date().toISOString(),
    scope: 'The produced package\'s daemon on a paused temporary copy of the owner\'s database: mock model, no provider keys, no config, FreeLLMAPI off, no timetable, no active mission, no queued run. '
      + '"Checked — continue" was pressed on the copy only. The copy was deleted afterwards.',
    source: { path: source, bytes: sourceStat.size, modified: sourceStat.mtime.toISOString() },
    app: { directory: newDirectory, executable: appExecutable(newDirectory), buildIdentity: buildIdentity(app), displayVersion: JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version },
    booted: false,
    copy: {},
    facts: {},
    expectations: [],
    passed: false,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-first-start-copy-'));
  const copy = path.join(dir, 'openhours.db');
  let child;
  const stop = async () => {
    // A process ended by a signal has exitCode null and signalCode set (always so on Windows).
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const running = child;
    await new Promise(resolve => {
      const timer = setTimeout(() => { running.kill('SIGKILL'); resolve(); }, 7000);
      running.once('exit', () => { clearTimeout(timer); resolve(); });
      running.kill('SIGTERM');
    });
  };
  try {
    // The database, its WAL and its shared-memory index are copied together, so the copy is one state.
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, copy + suffix);
    const db = new DatabaseSync(copy);
    try {
      const quick = db.prepare('PRAGMA quick_check').get();
      if (Object.values(quick ?? {})[0] !== 'ok') throw new Error(`The copy is not consistent (quick_check: ${JSON.stringify(quick)}). Copy again, ideally while OpenAgents is closed.`);
      const stage1AlreadyStarted = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'routine_publish_meta'").get();
      const runs = Object.fromEntries(Object.entries(RUNS).map(([key, id]) => [key, db.prepare('SELECT id, agent_id AS agentId, routine_id AS routineId, status, started_at AS startedAt FROM task_runs WHERE id = ?').get(id) ?? null]));
      const routineOf = run => run?.routineId ? db.prepare('SELECT id, name, agent_id AS agentId FROM routines WHERE id = ?').get(run.routineId) ?? null : null;
      const routines = { honest: routineOf(runs.gqw8h), viral: routineOf(runs.wveu4), deleted: runs.yf8vs?.routineId ? { id: runs.yf8vs.routineId, exists: !!routineOf(runs.yf8vs) } : null };
      report.facts = { stage1AlreadyStarted, runs: Object.fromEntries(Object.entries(runs).map(([key, run]) => [key, run && { ...run }])), routines: JSON.parse(JSON.stringify(routines)) };
      // Pause the copy so nothing can run on it.
      const now = Date.now();
      report.copy.timetablesPaused = Number(db.prepare('UPDATE routines SET schedule_enabled = 0 WHERE schedule_enabled = 1').run().changes);
      try { report.copy.missionsPaused = Number(db.prepare("UPDATE missions SET status = 'PAUSED' WHERE status IN ('ACTIVE', 'WAITING')").run().changes); }
      catch (error) { if (!/no such table/i.test(String(error?.message))) throw error; report.copy.missionsPaused = 0; }
      report.copy.queuedRunsAborted = Number(db.prepare("UPDATE task_runs SET status = 'ABORTED', error_message = 'Paused copy for the Stage 1 first-start check.', completed_at = ? WHERE status = 'QUEUED'").run(now).changes);
    } finally {
      db.close();
    }
    fs.writeFileSync(path.join(dir, 'local-gateway.json'), JSON.stringify({ autoStart: false }) + '\n');
    const agentId = report.facts.runs.wveu4?.agentId ?? report.facts.runs.gqw8h?.agentId;
    if (!agentId) throw new Error('Neither wveu4 nor gqw8h is in this database, so there is no first start to check.');
    report.facts.agentId = agentId;
    if (noBoot) {
      console.log('--no-boot: the copy was made, checked and paused; the package was not started.');
      return report;
    }

    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
    });
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENHOURS_CONFIG: 'none', OPENHOURS_LLM_MODE: 'mock', OPENHOURS_EXECUTOR: 'builtin', OPENHOURS_PORT: String(port), OPENHOURS_DB_PATH: copy };
    for (const key of ['OPENHOURS_MISSION', 'OPENHOURS_BACKLOG', 'OPENHOURS_AUTO_SETUP', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENCODE_API_KEY']) delete env[key];
    let log = '';
    child = spawn(report.app.executable, [path.join(app, 'dist', 'src', 'daemon', 'index.js')], { env, cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { log = (log + String(data)).slice(-16_000); });
    child.stderr.on('data', data => { log = (log + String(data)).slice(-16_000); });
    let headers;
    const deadline = Date.now() + 90_000;
    while (!headers) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`The package's daemon exited with ${child.exitCode ?? child.signalCode}: ${log.replace(/[0-9a-f]{32,}/gi, '[redacted]').slice(-800)}`);
      if (Date.now() > deadline) throw new Error('The package\'s daemon did not answer /health within 90 s.');
      const authFile = `${copy}.auth.json`;
      if (fs.existsSync(authFile)) {
        const candidate = { Authorization: `Bearer ${JSON.parse(fs.readFileSync(authFile, 'utf8')).token}` };
        const ok = await fetch(`http://127.0.0.1:${port}/health`, { headers: candidate, signal: AbortSignal.timeout(1000) }).then(res => res.ok).catch(() => false);
        if (ok) headers = candidate;
      }
      if (!headers) await new Promise(resolve => setTimeout(resolve, 250));
    }
    report.booted = true;
    const api = async (route, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { ...headers, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
      const json = await res.json();
      if (res.status !== 200) throw new Error(`${route} answered ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
      return json;
    };
    const pick = state => ({ pendingEffects: state.pendingEffects ?? [], publishPolicies: state.publishPolicies ?? [] });
    const first = pick(await api(`/api/system?agent=${encodeURIComponent(agentId)}`));
    report.first = first;
    let acknowledged = null;
    let after = null;
    if (report.facts.routines.viral) {
      acknowledged = (await api('/api/system/routine-acknowledge', { agentId, routineId: report.facts.routines.viral.id })).acknowledged;
      after = pick(await api(`/api/system?agent=${encodeURIComponent(agentId)}`));
    }
    report.acknowledged = acknowledged;
    report.after = after;
    report.expectations = evaluateFirstStart(report.facts, first, acknowledged, after);
    report.passed = report.expectations.every(e => e.holds);
    return report;
  } catch (error) {
    report.error = String(error?.message ?? error).slice(0, 2000);
    return report;
  } finally {
    await stop();
    // The copy holds the owner's data, so it never outlives the check.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* reported below */ }
    report.copyDeleted = !fs.existsSync(dir);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    for (const e of report.expectations) console.log(`${e.holds ? 'HOLDS' : 'DIFFERS'}: ${e.fact} (${e.detail})`);
    if (report.error) console.error(`Error: ${report.error}`);
    console.log(report.copyDeleted ? 'The temporary copy was deleted.' : `WARNING: the copy at ${dir} could not be deleted. Delete it by hand: it holds the owner's data.`);
    process.exitCode = report.copyDeleted && !report.error && (report.passed || noBoot) ? 0 : 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
