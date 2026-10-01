#!/usr/bin/env node
/**
 * Qualify a release candidate, and record the evidence against the exact build it qualified.
 *
 * WHY THIS EXISTS. Packaging previously ran no tests, and CI ran a subset, so a candidate could
 * be delivered on the strength of suites that never covered it. A display version is also reused
 * across builds, so "0.4.4 passed" does not identify what passed. This records the candidate's
 * build identity beside its suite results, and `publish-app.mjs` refuses to deliver a build whose
 * identity does not match a passing record.
 *
 * It does not claim completeness: Docker-backed and real bot-desktop qualification are reported by
 * name so a blocked engine is visible as missing evidence rather than silently skipped.
 *
 * Usage:
 *   node scripts/release-gate.mjs              # compile, then run the matrix
 *   node scripts/release-gate.mjs --no-build   # qualify what is already compiled
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainText, counts, failureNames } from './lib/suite-output.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const skipBuild = process.argv.includes('--no-build');

const SUITES = [
  { id: 'backend:kernel', args: ['run', 'test:kernel'] },
  { id: 'backend:daemon', args: ['run', 'test:daemon'] },
  { id: 'backend:browser', args: ['run', 'test:browser'] },
  { id: 'backend:completion', args: ['run', 'test:completion'] },
  { id: 'backend:expansion', args: ['run', 'test:expansion'] },
  { id: 'desktop', args: ['run', 'test:desktop'] },
  { id: 'frontend', args: ['--prefix', 'web', 'test', '--', '--run'] },
];


if (!skipBuild) {
  for (const args of [['run', 'build'], ['run', 'web:build']]) {
    const built = spawnSync(npm, args, { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
    if (built.status !== 0) {
      console.error(`Release gate stopped: \`npm ${args.join(' ')}\` failed.`);
      console.error(plainText(built.stderr || built.stdout || '').split('\n').slice(-20).join('\n'));
      process.exit(1);
    }
  }
}

const { buildIdentity } = await import(new URL('../dist/src/daemon/build-identity.js', import.meta.url));
const candidate = buildIdentity(repoRoot);
console.log(`Qualifying build ${candidate}`);

const suites = [];
for (const suite of SUITES) {
  process.stdout.write(`  ${suite.id} ... `);
  const run = spawnSync(npm, suite.args, { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  const text = plainText(`${run.stdout ?? ''}\n${run.stderr ?? ''}`);
  const tally = counts(text);
  const result = {
    id: suite.id,
    exitCode: run.status,
    ...tally,
    failures: [...new Set(failureNames(text))],
    ...(run.error ? { spawnError: String(run.error.message ?? run.error) } : {}),
  };
  suites.push(result);
  // An unreadable total is reported, never rendered as a silent pass.
  const tallyText = Number.isNaN(tally.pass) ? 'totals unreadable' : `${tally.pass} passed`;
  console.log(run.status === 0 ? `passed (${tallyText})` : `FAILED (${result.spawnError ?? (result.failures.length ? result.failures.length + ' tests' : 'see log')})`);
}

const failed = suites.filter(suite => suite.exitCode !== 0);
const unreadable = suites.filter(suite => suite.exitCode === 0 && Number.isNaN(suite.pass));
const record = {
  buildId: candidate,
  version: JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version,
  qualified: failed.length === 0 && unreadable.length === 0,
  completedAt: new Date().toISOString(),
  totalPassed: suites.reduce((sum, suite) => sum + (Number.isNaN(suite.pass) ? 0 : suite.pass), 0),
  suites,
  // Named rather than silently omitted: a blocked engine is missing evidence, not a pass.
  notQualifiedHere: ['real bot desktop (npm run test:bot-desktop)', 'packaged installer upgrade', 'daily-use soak'],
};
const evidence = path.join(repoRoot, 'docs', 'validation', 'release-gate.json');
fs.mkdirSync(path.dirname(evidence), { recursive: true });
fs.writeFileSync(evidence, `${JSON.stringify(record, null, 2)}\n`);

console.log(`\n${record.qualified ? 'Qualified' : 'NOT qualified'}: build ${candidate} (${record.version}), ${record.totalPassed} tests passed. Evidence: ${path.relative(repoRoot, evidence)}`);
for (const suite of failed) console.log(`  ${suite.id}: ${suite.failures.join('; ') || `exit ${suite.exitCode}`}`);
for (const suite of unreadable) console.log(`  ${suite.id}: exited 0 but reported no readable totals; evidence is incomplete.`);
process.exit(record.qualified ? 0 : 1);
