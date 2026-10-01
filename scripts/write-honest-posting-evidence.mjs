#!/usr/bin/env node
/**
 * Stage 1 (honest posting) validation evidence, spec section 11.10.
 *
 * WHY A SCRIPT. Every number in the evidence comes from a command this script ran, or from the
 * suites.json it saved when it ran them (--reuse-suites), so nothing is typed by hand and nothing
 * that did not run can appear as passing. `npm test` is run as its seven constituent scripts,
 * because `npm test` chains them with && and stops at the first failure, which would hide the
 * counts of every later suite.
 *
 * It never starts the daemon, never opens the owner's profile and never prints a token or key.
 * With --db it copies that database together with its -wal and -shm files into a temporary folder,
 * opens the copy read-only for the S1-1 to S1-4 queries (spec 2.3), and deletes the copy.
 *
 * Usage:
 *   node scripts/write-honest-posting-evidence.mjs [--date=YYYY-MM-DD] [--db=<openhours.db>] [--reuse-suites]
 *   node scripts/write-honest-posting-evidence.mjs --check [--date=YYYY-MM-DD]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { plainText, counts, failureNames, NODE_TOTAL } from './lib/suite-output.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const day = option('date') ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('--date must be YYYY-MM-DD.');
const outDir = path.join(repoRoot, 'docs', 'validation', `${day}-honest-posting`);
const evidencePath = path.join(outDir, 'evidence.md');
const rel = file => path.relative(repoRoot, file).split(path.sep).join('/');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const ASSUMPTION = '(assumed X response shape)';
const ASSUMPTION_FILES = ['tests/publish-probes.test.ts', 'tests/browser-publish.test.ts', 'tests/browser-tools.test.ts', 'tests/publish-honesty.test.ts'];

// build and web:build first, so the build identity the suites run against is the one task 17 packages.
const SUITES = [
  { id: 'build', args: ['run', 'build'], totals: false },
  { id: 'web build', args: ['run', 'web:build'], totals: false },
  { id: 'npm test: kernel', args: ['run', 'test:kernel'] },
  { id: 'npm test: security', args: ['run', 'test:security'] },
  { id: 'npm test: evals', args: ['run', 'test:evals'] },
  { id: 'npm test: daemon', args: ['run', 'test:daemon'] },
  { id: 'npm test: browser', args: ['run', 'test:browser'] },
  { id: 'npm test: completion', args: ['run', 'test:completion'] },
  { id: 'npm test: expansion', args: ['run', 'test:expansion'] },
  { id: 'web', args: ['--prefix', 'web', 'test'] },
  { id: 'desktop', args: ['run', 'test:desktop'] },
];
const REQUIRED_HEADINGS = ['## Scope', '## Build identity', '## Commands and suite counts', '## Assumption tests', '## Bot-desktop verifier',
  '## Stage 1 success criteria on a database copy', '## Release checks', '## Not established'];
const OVERCLAIMS = [/\bis ready for daily use\b/i, /\bdaily-use ready\b/i, /\bworks in (?:all|every) browsers?\b/i, /\buniversally compatible\b/i];

// --------------------------------------------------------------------------------- S1 queries ---
// Each ? is the Stage 1 install marker (routine_publish_meta 'installed_at', in ms).
const S1_1_MEASURED = `SELECT COUNT(*) AS n FROM task_runs t
  JOIN routine_publish_policy p ON p.routine_id = t.routine_id AND p.required = 1
  WHERE t.status = 'COMPLETED' AND t.started_at >= ?`;
const S1_1 = `SELECT t.id AS run, t.routine_id AS routine FROM task_runs t
  JOIN routine_publish_policy p ON p.routine_id = t.routine_id AND p.required = 1
  WHERE t.status = 'COMPLETED' AND t.started_at >= ?
    AND NOT EXISTS (SELECT 1 FROM execution_events e WHERE e.task_run_id = t.id AND (
      (e.event_type = 'PUBLISH_OBSERVED' AND json_extract(e.payload_json, '$.outcome') = 'confirmed')
      OR (e.event_type = 'PUBLISH_RECONCILED' AND json_extract(e.payload_json, '$.verdict') = 'present')))
  ORDER BY t.started_at`;
const S1_2_MEASURED = `SELECT COUNT(DISTINCT a.task_run_id) AS n FROM execution_events a
  JOIN task_runs t ON t.id = a.task_run_id AND t.routine_id IS NOT NULL
  WHERE a.event_type = 'PUBLISH_ATTEMPTED' AND a.timestamp >= ?`;
const S1_2 = `SELECT a.task_run_id AS run, COUNT(*) AS attempts FROM execution_events a
  JOIN task_runs t ON t.id = a.task_run_id AND t.routine_id IS NOT NULL
  WHERE a.event_type = 'PUBLISH_ATTEMPTED' AND a.timestamp >= ?
    AND json_extract(a.payload_json, '$.by') IN ('model', 'flow', 'page')
    AND NOT EXISTS (SELECT 1 FROM execution_events o WHERE o.task_run_id = a.task_run_id AND o.event_type = 'PUBLISH_OBSERVED'
      AND json_extract(o.payload_json, '$.publishId') = json_extract(a.payload_json, '$.publishId')
      AND json_extract(o.payload_json, '$.outcome') = 'rejected')
  GROUP BY a.task_run_id HAVING COUNT(*) > 1`;
const S1_3_TRIGGERS = `SELECT e.task_run_id AS run, e.timestamp AS at, t.routine_id AS routine FROM execution_events e
  JOIN task_runs t ON t.id = e.task_run_id
  WHERE e.event_type = 'ROUTINE_TRIGGERED' AND json_extract(e.payload_json, '$.source') = 'schedule'
    AND e.timestamp >= ? AND t.routine_id IS NOT NULL
  ORDER BY e.id`;
const S1_3_WINDOW = `SELECT t.id AS run FROM task_runs t
  WHERE t.routine_id = ? AND t.id <> ?
    AND EXISTS (SELECT 1 FROM execution_events e WHERE e.task_run_id = t.id
      AND e.event_type IN ('EXTERNAL_ACTION_STARTED', 'PUBLISH_ATTEMPTED') AND e.timestamp < ?)
  ORDER BY t.rowid DESC LIMIT 20`;
const S1_3_EVENTS = `SELECT event_type, payload_json FROM execution_events
  WHERE task_run_id = ? AND timestamp < ?
    AND event_type IN ('EXTERNAL_ACTION_STARTED', 'EXTERNAL_ACTION_FINISHED', 'PUBLISH_ATTEMPTED', 'PUBLISH_OBSERVED', 'PUBLISH_RECONCILED', 'EXTERNAL_ACTION_ACKNOWLEDGED')
  ORDER BY id`;
const S1_4_MEASURED = `SELECT COUNT(*) AS n FROM execution_events WHERE event_type = 'PUBLISH_ATTEMPTED' AND timestamp >= ?`;
const S1_4 = `WITH attempts AS (
    SELECT e.id, e.agent_id, e.task_run_id, e.timestamp,
      json_extract(e.payload_json, '$.textSha256') AS text_hash,
      json_extract(e.payload_json, '$.inReplyTo') AS target,
      COALESCE(json_extract(e.payload_json, '$.by'), '') AS author,
      (SELECT t.routine_id FROM task_runs t WHERE t.id = e.task_run_id) AS routine_id
    FROM execution_events e WHERE e.event_type = 'PUBLISH_ATTEMPTED' AND e.timestamp >= ?)
  SELECT a.task_run_id AS earlierRun, b.task_run_id AS laterRun,
    CASE WHEN a.text_hash IS NOT NULL AND a.text_hash = b.text_hash THEN 'text' ELSE 'target' END AS shared,
    b.routine_id IS NOT NULL AS laterInRoutineRun
  FROM attempts a JOIN attempts b ON b.agent_id = a.agent_id AND b.id > a.id AND b.timestamp - a.timestamp <= 604800000
  WHERE b.author <> 'operator'
    AND ((a.text_hash IS NOT NULL AND a.text_hash = b.text_hash) OR (a.target IS NOT NULL AND a.target = b.target))
  ORDER BY b.id`;

if (args.includes('--check')) {
  checkEvidence();
} else {
  await writeEvidence();
}

// ------------------------------------------------------------------------------------ writing ---
async function writeEvidence() {
  fs.mkdirSync(outDir, { recursive: true });
  const suitesPath = path.join(outDir, 'suites.json');
  let suites;
  if (args.includes('--reuse-suites')) {
    if (!fs.existsSync(suitesPath)) throw new Error(`--reuse-suites needs ${rel(suitesPath)}; run once without it first.`);
    suites = JSON.parse(fs.readFileSync(suitesPath, 'utf8'));
  } else {
    console.log('Running the suites. This takes 20 to 30 minutes.');
    const results = runSuites();
    suites = { recordedAt: new Date().toISOString(), buildIdentity: currentIdentity(), suites: results };
    fs.writeFileSync(suitesPath, JSON.stringify(suites, null, 2) + '\n');
  }
  const db = option('db');
  const criteria = db ? stage1Criteria(db) : null;
  if (criteria) fs.writeFileSync(path.join(outDir, 'criteria.json'), JSON.stringify(criteria, null, 2) + '\n');
  const read = name => readJson(path.join(outDir, name));
  const context = {
    generatedAt: new Date().toISOString(),
    reused: args.includes('--reuse-suites'),
    suites,
    identity: currentIdentity(),
    version: JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version,
    head: git(['rev-parse', '--short', 'HEAD']),
    dirty: (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length,
    assumptions: assumptionTests(),
    verifier: read('bot-desktop.json'),
    db,
    criteria,
    release: {
      released: read('released-package.json'),
      install: read('identity.json'),
      parity: read('parity.json'),
      gate: readJson(path.join(repoRoot, 'docs', 'validation', 'release-gate.json')),
      packageVerifier: read('bot-desktop-package.json'),
      upgradeReleased: read('publish-upgrade-released.json'),
      upgradeShortcut: read('publish-upgrade-shortcut.json'),
      firstStart: read('first-start-copy.json'),
      note: fs.existsSync(path.join(outDir, 'release-note.md')),
    },
  };
  fs.writeFileSync(evidencePath, render(context));
  console.log(`Evidence: ${rel(evidencePath)}`);
  checkEvidence();
}

function runSuites() {
  const results = [];
  for (const suite of SUITES) {
    process.stdout.write(`  ${suite.id} ... `);
    const started = Date.now();
    const run = spawnSync(npm, suite.args, { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 });
    const text = plainText(`${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    const totals = suite.totals === false ? null : counts(text);
    const result = {
      id: suite.id,
      command: `npm ${suite.args.join(' ')}`,
      exitCode: run.status,
      pass: totals && !Number.isNaN(totals.pass) ? totals.pass : null,
      fail: totals && !Number.isNaN(totals.fail) ? totals.fail : null,
      skipped: suite.totals === false ? null : skippedIn(text),
      durationMs: Date.now() - started,
      failures: suite.totals === false ? [] : failureNames(text),
      ...(run.error ? { spawnError: String(run.error.message ?? run.error) } : {}),
    };
    results.push(result);
    console.log(result.exitCode === 0 ? `exit 0 (${result.pass ?? 'n/a'} passed)` : `exit ${result.exitCode} (${result.fail ?? 'unreadable'} failed)`);
    if (suite.totals === false && run.status !== 0) break;
  }
  return results;
}

function skippedIn(text) {
  let value = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const prefix = `${NODE_TOTAL} skipped `;
    if (trimmed.startsWith(prefix) && /^[0-9]+$/.test(trimmed.slice(prefix.length).trim())) value = Number(trimmed.slice(prefix.length).trim());
  }
  if (value !== null) return value;
  const vitest = /Tests[^\n]*?([0-9]+) skipped/.exec(text);
  return vitest ? Number(vitest[1]) : 0;
}

function currentIdentity() {
  const identityFile = path.join(repoRoot, 'dist', 'src', 'daemon', 'build-identity.js');
  if (!fs.existsSync(identityFile)) return null;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify(new URL('../dist/src/daemon/build-identity.js', import.meta.url).href)}).then(m => process.stdout.write(m.buildIdentity(${JSON.stringify(repoRoot)})))`],
    { encoding: 'utf8' });
  return run.status === 0 && /^[0-9a-f]{16}$/.test(run.stdout) ? run.stdout : null;
}

function git(gitArgs) {
  const run = spawnSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function assumptionTests() {
  const found = [];
  for (const file of ASSUMPTION_FILES) {
    const full = path.join(repoRoot, file);
    if (!fs.existsSync(full)) { found.push({ file, title: null }); continue; }
    const source = fs.readFileSync(full, 'utf8');
    for (const match of source.matchAll(/\b(?:test|it)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const title = match[2].replace(/\\(.)/g, '$1');
      if (title.includes(ASSUMPTION)) found.push({ file, title });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------- S1 measurement ---
function stage1Criteria(dbPath) {
  const source = path.resolve(dbPath);
  if (!fs.existsSync(source)) return { source, error: `No database at ${source}.` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-s1-criteria-'));
  const copy = path.join(dir, 'openhours.db');
  try {
    // The database, its WAL and its shared-memory index are copied together, so the copy is one state.
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, copy + suffix);
    const copiedAt = new Date().toISOString();
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      let installed = null;
      try {
        const row = db.prepare("SELECT value FROM routine_publish_meta WHERE key = 'installed_at'").get();
        installed = row ? Number(row.value) : null;
      } catch (error) {
        if (!/no such table/i.test(String(error?.message))) throw error;
      }
      if (installed === null) return { source, copiedAt, installed: null };
      const all = (sql, ...params) => db.prepare(sql).all(...params).map(row => ({ ...row }));
      const pairs = all(S1_4, installed).map(pair => ({ ...pair, laterInRoutineRun: pair.laterInRoutineRun === 1 }));
      return {
        source, copiedAt, installed: new Date(installed).toISOString(),
        s1: { measured: Number(all(S1_1_MEASURED, installed)[0].n), violations: all(S1_1, installed) },
        s2: { measured: Number(all(S1_2_MEASURED, installed)[0].n), violations: all(S1_2, installed) },
        s3: scheduleTriggersWhilePending(db, installed),
        s4: { measured: Number(all(S1_4_MEASURED, installed)[0].n), violations: pairs.filter(pair => pair.laterInRoutineRun), outsideRoutineRuns: pairs.filter(pair => !pair.laterInRoutineRun) },
      };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function scheduleTriggersWhilePending(db, installed) {
  const triggers = db.prepare(S1_3_TRIGGERS).all(installed);
  const window = db.prepare(S1_3_WINDOW);
  const events = db.prepare(S1_3_EVENTS);
  const violations = [];
  for (const trigger of triggers) {
    for (const { run } of window.all(trigger.routine, trigger.run, trigger.at)) {
      const keys = unresolvedKeys(events.all(run, trigger.at));
      if (keys.length) violations.push({ triggeredRun: trigger.run, routine: trigger.routine, pendingRun: run, items: keys.length });
    }
  }
  return { measured: triggers.length, violations };
}

/** Spec 6.7 replayed over one run's events up to a moment: the keys of the items still unconfirmed then. */
function unresolvedKeys(rows) {
  const parse = json => { try { const value = JSON.parse(json ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
  const keyOf = p => String(p.actionId ?? p.callId ?? 'external');
  const open = new Map();
  const attempts = new Map();
  const proven = new Set();
  const acknowledged = new Set();
  for (const row of rows) {
    const p = parse(row.payload_json);
    if (row.event_type === 'EXTERNAL_ACTION_STARTED') open.set(keyOf(p), p);
    else if (row.event_type === 'EXTERNAL_ACTION_FINISHED') open.delete(keyOf(p));
    else if (row.event_type === 'PUBLISH_ATTEMPTED' && p.publishId) attempts.set(p.publishId, p.actionId);
    else if (row.event_type === 'PUBLISH_OBSERVED' && (p.outcome === 'confirmed' || p.outcome === 'rejected')) proven.add(p.publishId);
    else if (row.event_type === 'PUBLISH_RECONCILED' && p.verdict === 'present') proven.add(p.publishId);
    else if (row.event_type === 'EXTERNAL_ACTION_ACKNOWLEDGED' && p.key) acknowledged.add(p.key);
  }
  const provenActions = new Set([...attempts].filter(([publishId, actionId]) => proven.has(publishId) && actionId).map(([, actionId]) => actionId));
  const keys = [];
  for (const [key, p] of open) {
    const submits = (p.transport === 'browser' && ['click', 'double_click', 'press'].includes(p.action)) || p.transport === 'computer';
    if (submits && !provenActions.has(key) && !acknowledged.has(key)) keys.push(key);
  }
  for (const [publishId] of attempts) if (!proven.has(publishId) && !acknowledged.has(publishId)) keys.push(publishId);
  return keys;
}

// ---------------------------------------------------------------------------------- rendering ---
function render(c) {
  const out = [];
  const add = (...lines) => out.push(...lines);
  const suites = c.suites.suites;
  const bad = suites.filter(s => s.exitCode !== 0 || (s.fail ?? 0) > 0);
  const skipped = suites.filter(s => (s.skipped ?? 0) > 0);
  const unreadable = suites.filter(s => s.pass === null && s.exitCode === 0 && SUITES.find(d => d.id === s.id)?.totals !== false);
  const missingSuites = SUITES.filter(s => !suites.some(r => r.id === s.id));
  const cell = value => value === null || value === undefined ? 'unreadable' : String(value);
  const seconds = ms => `${Math.round(ms / 1000)} s`;
  const r = c.release;
  const install = r.install;

  add('# Stage 1, honest posting: validation evidence', '',
    `Date: ${day} (UTC). Generated by \`scripts/write-honest-posting-evidence.mjs\` at ${c.generatedAt}`
      + (c.reused ? `, from the suite results recorded at ${c.suites.recordedAt}` : '') + '. Every count below comes from a command the script ran.', '');

  add('## Scope', '',
    '- Stage 1, "Honest posting", of `docs/superpowers/specs/2026-09-23-learned-flows-design.md` (sections 4.1 and 6): publish probes, PublishWatch, the publish policy, the pending gate, the completion gate on all four COMPLETED routes, the page check, the failure close-out and deferred teardown, the system and runs APIs, and the Posting UI.',
    '- Not Stage 2: this build has no learned steps, recorder, compiler, compose or player.',
    '- No test touched a real social account and nothing was sent to X. The fixture suites use a local X-shaped site on 127.0.0.1 and local managed Chromium. The only external request was the bot-desktop verifier\'s owner-approved POST of a dummy text to https://httpbin.org/anything, and only when it ran without --no-echo.',
    '- Root `npm test` is not the complete desktop-product qualification matrix. The real bot desktop, the packaged app and its upgrade path are recorded separately below, and only as far as they actually ran.',
    '- This evidence claims neither daily-use readiness nor compatibility with every browser.', '');

  add('## Build identity', '',
    '| Item | Value |', '|---|---|',
    `| Build identity (\`buildIdentity()\` of this source tree) | \`${c.identity ?? 'unavailable'}\` |`,
    `| Build identity when the suites ran | \`${c.suites.buildIdentity ?? 'unavailable'}\`${c.suites.buildIdentity === c.identity ? ' (the same build)' : ' (DIFFERENT: the suites did not run against this build)'} |`,
    `| Display version (\`package.json\`) | ${c.version}. It is reused across builds, so it does not identify this build. |`,
    `| Active executable for the suites | \`${process.execPath}\` (Node ${process.version}) |`,
    `| Profile for the suites | None of the owner's. The suites use in-memory stores and temporary folders.${c.db ? ` The S1 queries read a temporary read-only copy of \`${c.db}\`.` : ' The S1 queries did not run (no --db).'} |`,
    `| Owner's app: what the launchers open | ${install ? install.launchers.map(l => `${l.via}: \`${l.target}\` (${l.displayVersion ?? 'unknown version'}, build \`${l.buildIdentity ?? 'unavailable'}\`)`).join('; ') || 'no launcher found' : 'recorded by task 17 (`identity.json`), not yet run'} |`,
    `| Owner's profile | ${install ? `\`${install.profile.directory}\`, last run by version ${install.profile.lastVersion ?? 'unknown'} (\`desktop-state.json\`); the database was not opened for this row` : 'recorded by task 17 (`identity.json`), not yet run'} |`,
    `| Source | git \`${c.head ?? 'unknown'}\` with ${c.dirty} uncommitted entries |`, '');

  add('## Commands and suite counts', '',
    '`npm test` (`package.json:20`) is `npm run build` followed by the seven `npm test:` rows below, which it chains with `&&`. They are run one by one here so that every suite\'s count is recorded even when an earlier one fails. `npm run web:build` runs first so the build identity above includes the interface.', '',
    '| Suite | Command | Exit | Passed | Failed | Skipped | Duration |', '|---|---|---|---|---|---|---|');
  for (const s of suites) {
    add(SUITES.find(d => d.id === s.id)?.totals === false
      ? `| ${s.id} | \`${s.command}\` | ${s.exitCode} | n/a | n/a | n/a | ${seconds(s.durationMs)} |`
      : `| ${s.id} | \`${s.command}\` | ${s.exitCode} | ${cell(s.pass)} | ${cell(s.fail)} | ${cell(s.skipped)} | ${seconds(s.durationMs)} |`);
  }
  for (const s of missingSuites) add(`| ${s.id} | \`npm ${s.args.join(' ')}\` | not run | not run | not run | not run | not run |`);
  add('', 'The bot-desktop verifier (`npm run test:flow-desktop -- --stage=1`) is reported in its own section below.', '');
  if (bad.length) {
    add('Failing tests:', '');
    for (const s of bad) add(`- ${s.id}: ${s.failures.length ? s.failures.join('; ') : `exit ${s.exitCode}${s.spawnError ? `, ${s.spawnError}` : ''}`}`);
    add('');
  }

  const byFile = new Map();
  for (const a of c.assumptions) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a.title]);
  add('## Assumption tests', '',
    `These ${c.assumptions.filter(a => a.title).length} tests carry "${ASSUMPTION}" in their titles (spec 11.1). They prove the code against the assumed X CreateTweet request and response shapes and the inferred not-created allowlist, not X's real behaviour.`, '');
  for (const [file, titles] of byFile) {
    add(`- \`${file}\`:`);
    for (const title of titles) add(title === null ? '  - (file not found)' : `  - ${title}`);
  }
  add('');

  add('## Bot-desktop verifier', '');
  const verifierFile = rel(path.join(outDir, 'bot-desktop.json'));
  if (!c.verifier) add(`Not run for ${day}: \`${verifierFile}\` does not exist. Listed under "Not established".`, '');
  else {
    add(`\`${verifierFile}\` (run at ${c.verifier.at}): passed \`${c.verifier.passed}\`, bodyCapture \`${c.verifier.bodyCapture}\`, image \`${c.verifier.image}\`, build identity \`${c.verifier.buildIdentity}\`${c.verifier.buildIdentity === c.identity ? ' (this build)' : ' (a DIFFERENT build: run the verifier again after the fresh build)'}.`, '',
      '| Check | Passed | Detail |', '|---|---|---|');
    for (const check of c.verifier.checks) add(`| ${check.name} | ${check.passed} | ${String(check.detail).replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
    if (c.verifier.cleanupWarnings?.length) add('', `Cleanup warnings: ${c.verifier.cleanupWarnings.join('; ')}`);
    if (c.verifier.error) add('', `Verifier error: ${String(c.verifier.error).split('\n')[0]}`);
    add('');
  }

  add('## Stage 1 success criteria on a database copy (S1-1 to S1-4)', '',
    'S1-5 is proven by fixture case H1 and the verifier\'s `attempt-before-send`; S1-6 by fixture cases H13 and H14; S1-7 is this document. The four criteria below are measured over events recorded after the Stage 1 install marker. S1-1 uses the must-post switches as they are now.', '');
  if (!c.criteria) add('Not run: no `--db` was given.', '');
  else if (c.criteria.error) add(`Not run: ${c.criteria.error}`, '');
  else if (c.criteria.installed === null) {
    add(`Source: a read-only copy of \`${c.criteria.source}\` taken at ${c.criteria.copiedAt}. The copy has no Stage 1 install marker (\`routine_publish_meta\`), so Stage 1 has not run on this database yet and S1-1 to S1-4 have nothing to measure. Run this script again with \`--db\` after the owner's first scheduled runs on the new version.`, '');
  } else {
    const list = rows => rows.length ? rows.map(row => `\`${JSON.stringify(row)}\``).join(', ') : 'none';
    add(`Source: a read-only copy of \`${c.criteria.source}\` taken at ${c.criteria.copiedAt}. Stage 1 install marker: ${c.criteria.installed}.`, '',
      '| Criterion | Measured since the install | Violations |', '|---|---|---|',
      `| S1-1: no COMPLETED run of a must-post routine without a confirmed or present post | ${c.criteria.s1.measured} COMPLETED runs of must-post routines | ${list(c.criteria.s1.violations)} |`,
      `| S1-2: at most one non-rejected PUBLISH_ATTEMPTED by model, flow or page per routine run | ${c.criteria.s2.measured} routine runs with an attempt | ${list(c.criteria.s2.violations)} |`,
      `| S1-3: no scheduled trigger while the routine had a pending item | ${c.criteria.s3.measured} scheduled triggers | ${list(c.criteria.s3.violations)} |`,
      `| S1-4: no shared text or target within 7 days, unless the later attempt is the operator's | ${c.criteria.s4.measured} attempts | ${list(c.criteria.s4.violations)} |`, '',
      `Shared text or target where the later attempt is outside a routine run (such runs have no budget or dedupe): ${list(c.criteria.s4.outsideRoutineRuns)}.`, '');
  }
  add('The queries (each `?` is the install marker in ms; S1-3 replays spec 6.7 in `scripts/write-honest-posting-evidence.mjs` over the gate\'s 20-run window):', '',
    '```sql', `-- S1-1\n${S1_1};`, `-- S1-2\n${S1_2};`, `-- S1-3 triggers, window and events\n${S1_3_TRIGGERS};\n${S1_3_WINDOW};\n${S1_3_EVENTS};`, `-- S1-4\n${S1_4};`, '```', '');

  const row = (name, value) => add(`| ${name} | ${value} |`);
  const shortcutSame = !!install?.shortcutMatchesReleased;
  add('## Release checks (spec 15, step 2)', '', 'Recorded only when task 17 ran them. Publication or copying of installers is a separate delivery action that needs the owner\'s go-ahead.', '',
    '| Check | Result |', '|---|---|');
  row('Released package preserved before packaging (`released-package.json`)', r.released ? (r.released.preserved ? `${r.released.version}, build \`${r.released.buildIdentity}\`, equal to the release gate record of that release; copy at \`${r.released.directory}\`` : `not preserved: ${r.released.reason}`) : 'not run');
  row('Package build identity (`identity.json`)', install ? `source \`${install.source.buildIdentity}\`, package \`${install.package.buildIdentity}\`${install.source.buildIdentity === install.package.buildIdentity ? ' (equal)' : ' (DIFFERENT)'}; package executable sha256 \`${String(install.package.executableSha256).slice(0, 16)}…\`` : 'not run');
  row('`scripts/verify-release-parity.mjs`', r.parity ? `passed \`${r.parity.passed}\`${r.parity.checkedFiles ? `, ${r.parity.checkedFiles} files, implementation sha256 \`${r.parity.implementationSha256}\`` : r.parity.error ? `: ${r.parity.error}` : ''}` : 'not run');
  row('Release gate (`docs/validation/release-gate.json`)', r.gate ? `build \`${r.gate.buildId}\` (${r.gate.version}), qualified \`${r.gate.qualified}\`${r.gate.buildId === c.identity ? ' (this build)' : ' (a different build)'}` : 'not run');
  row('Bot-desktop verifier on the package (`bot-desktop-package.json`)', r.packageVerifier ? `passed \`${r.packageVerifier.passed}\`, bodyCapture \`${r.packageVerifier.bodyCapture}\`, build \`${r.packageVerifier.buildIdentity}\`` : 'not run');
  const upgrade = u => `passed \`${u.passed}\`; old \`${u.old?.directory}\` ${u.old?.version} (\`${u.old?.buildIdentity}\`), new ${u.new?.version} (\`${u.new?.buildIdentity}\`), disposable profile \`${u.profile}\``;
  row('Upgrade from the released package, disposable profile (`publish-upgrade-released.json`)', r.upgradeReleased ? upgrade(r.upgradeReleased) : 'not run');
  row('Upgrade from what the shortcuts open, disposable profile (`publish-upgrade-shortcut.json`)', r.upgradeShortcut ? upgrade(r.upgradeShortcut) : shortcutSame ? 'the shortcuts open the released package, covered by the row above' : 'not run');
  row('Produced package on a paused copy of the live profile (`first-start-copy.json`)', r.firstStart ? `${r.firstStart.expectations.filter(e => e.holds).length} of ${r.firstStart.expectations.length} release-note facts hold; package build \`${r.firstStart.app?.buildIdentity}\`` : 'not run');
  row('Owner release note (`release-note.md`)', r.note ? 'written' : 'not written');
  add('');

  const item7 = [];
  for (const s of bad) item7.push(`${s.id} did not pass (exit ${s.exitCode}${s.fail ? `, ${s.fail} failing` : ''}${s.failures.length ? `: ${s.failures.join('; ')}` : ''})`);
  for (const s of skipped) item7.push(`${s.id} skipped ${s.skipped} tests`);
  for (const s of unreadable) item7.push(`${s.id} exited 0 but its totals were unreadable`);
  for (const s of missingSuites) item7.push(`${s.id} did not run`);
  if (!c.verifier) item7.push('the bot-desktop verifier did not run for this date');
  else for (const check of c.verifier.checks.filter(check => !check.passed)) item7.push(`verifier check ${check.name} failed: ${check.detail}`);
  if (!c.criteria || c.criteria.error) item7.push('the S1-1 to S1-4 queries did not run');
  else if (c.criteria.installed === null) item7.push('S1-1 to S1-4 had nothing to measure, because Stage 1 has not run on the copied database yet');
  const releaseRuns = [['preserving the released package', r.released?.preserved], ['a package whose build identity equals the source', install && install.source.buildIdentity === install.package.buildIdentity], ['release parity', r.parity?.passed], ['the release gate for this build', r.gate?.buildId === c.identity && r.gate?.qualified],
    ['the bot-desktop verifier on the package', r.packageVerifier?.passed], ['the upgrade from the released package', r.upgradeReleased?.passed],
    ['the upgrade from what the shortcuts open', r.upgradeShortcut?.passed || shortcutSame], ['the produced package on a paused copy of the live profile', r.firstStart?.passed]];
  for (const [name, ok] of releaseRuns) if (!ok) item7.push(`${name}: not run or not passing`);
  if (c.suites.buildIdentity !== c.identity) item7.push('the suites ran against a different build identity than the current one');
  const body = c.verifier?.bodyCapture;
  add('## Not established', '',
    '1. X\'s real composer behaviour under programmatic input, including whether `insertText` enables Reply. Only the fixture\'s contenteditable composer was driven.',
    `2. X's real CreateTweet request and response shapes and error codes. The not-created allowlist (88, 186, 187, 226, 344, 385, 433) is inferred, and the ${c.assumptions.filter(a => a.title).length} assumption tests above prove the code against the assumed shape only.`,
    '3. X\'s service worker on bot-desktop Chrome. The verifier\'s `new-tab-routed` check shows that a later tab\'s POST reaches the route handler, but its fixture registers no service worker, so the bypass itself was not exercised.',
    '4. Real X latency on the bot\'s egress. The 5 s verdict wait, the 20 s settle cap and the page-check windows were exercised only against local timings.',
    body === 'real'
      ? '5. Body capture through the gateway for X\'s own responses. The verifier read a real response body through the gateway `/cdp` (bodyCapture `real`, from httpbin.org), so the mechanism works on Linux Chrome, but no X response body has been read that way.'
      : `5. Body capture through the gateway. ${body === 'synthetic' ? 'The verifier ran with --no-echo (bodyCapture `synthetic`), so the only body it read was fulfilled inside Chrome.' : body === 'failed' ? 'The verifier\'s echo did not return a readable matching body (bodyCapture `failed`); see the body-capture detail above.' : 'The verifier did not run for this date.'}`,
    '6. That X resolves `/i/status/<id>`, the post URL used when the account link cannot be read.',
    `7. Cases not run or not passing on this machine: ${item7.length ? item7.join('; ') : 'none. Every suite above passed with 0 skipped, and the verifier, the S1 queries and the release checks ran'}.`, '',
    'Also not established:', '',
    '- Live X behaviour is observed only through the owner\'s normal scheduled runs (`PUBLISH_OBSERVED` shape and `errorCodes`, `PUBLISH_RECONCILED`), never as a test side effect.',
    '- The local managed-Chromium fixture suites establish nothing about Linux Chrome or CDP. Only the verifier ran on Linux Chrome.',
    '- The NSIS installer and the portable exe were not run, and nothing was installed over the owner\'s copy. That is a delivery action.',
    '- The owner\'s real first start on the new version. The paused-copy check predicts it from a copy; the live database can move on before the upgrade (spec risk 22).',
    '- The release note (`release-note.md` in this folder, task 17) must tell the owner that viral-life waits on run wveu4 until "Checked — continue" and that yf8vs of the deleted "Milo life" is listed and holds nothing.', '');
  return out.join('\n');
}

// ----------------------------------------------------------------------------------- checking ---
function checkEvidence() {
  if (!fs.existsSync(evidencePath)) {
    console.error(`No evidence at ${rel(evidencePath)}.`);
    process.exitCode = 1;
    return;
  }
  const text = fs.readFileSync(evidencePath, 'utf8');
  const problems = [];
  for (const heading of REQUIRED_HEADINGS) if (!text.includes(`\n${heading}`)) problems.push(`missing heading "${heading}"`);
  const notEstablished = text.includes('\n## Not established') ? text.slice(text.indexOf('\n## Not established')) : '';
  for (let item = 1; item <= 7; item += 1) if (!new RegExp(`^${item}\\. `, 'm').test(notEstablished)) problems.push(`"Not established" item ${item} is missing`);
  for (const suite of SUITES) if (!text.includes(`| ${suite.id} | \``)) problems.push(`no row for suite "${suite.id}"`);
  if (!/\| Build identity \(`buildIdentity\(\)` of this source tree\) \| `[0-9a-f]{16}` \|/.test(text)) problems.push('no 16-hex build identity for this source tree');
  if (!text.includes('bot-desktop.json')) problems.push('the verifier JSON path is not named');
  for (const claim of OVERCLAIMS) if (claim.test(text)) problems.push(`overclaim matching ${claim}`);
  if (problems.length) {
    console.error(`Evidence incomplete (${rel(evidencePath)}):\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(`evidence complete: ${rel(evidencePath)}`);
  }
}
