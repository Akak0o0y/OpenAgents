/**
 * Records the character layer's Off parity baseline (Phase 1 Task 1). Test-only; never run by npm test.
 *
 *   node dist/tests/helpers/capture-character-baseline.js
 *       Capture and compare with the committed baseline. Writes nothing; exits 1 on any difference.
 *
 *   node dist/tests/helpers/capture-character-baseline.js --write tests/fixtures/character/baseline
 *       Write the baseline. The first write requires src/ and web/src/ to be clean at HEAD and records
 *       HEAD plus LF-normalized hashes of every tracked src/ file. A later write refuses unless every
 *       recorded source file still has its recorded hash, so the baseline can only ever be captured
 *       from pre-feature source. Either way it captures twice and refuses if the captures differ.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  BASELINE_CASE_COUNT, BASELINE_DIR, BASELINE_SCHEMA, MANIFEST_FILE, REPO_ROOT, SOURCE_HASH_ALGORITHM, VOLATILE_FIELDS,
  captureOffBaseline, caseFileName, compareBaseline, formatDifferences, readBaseline, serializeFixture,
  sourceHashMismatches, sourceHashes, trackedSourceFiles, type BaselineManifest,
} from './character-harness.js';

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function refuse(message: string): never {
  console.error(`Refused: ${message}`);
  process.exit(1);
}

async function check(): Promise<void> {
  const { cases } = readBaseline(BASELINE_DIR);
  const differences = compareBaseline(cases, await captureOffBaseline());
  if (differences.length) {
    console.error(`Off parity differs from the baseline in ${new Set(differences.map(d => d.caseId)).size} case(s):\n${formatDifferences(differences, 40)}`);
    process.exit(1);
  }
  console.log(`Off parity matches the baseline: ${cases.length} cases.`);
}

async function write(dir: string): Promise<void> {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BaselineManifest : undefined;
  let baselineCommit: string;
  let sources: Record<string, string>;
  if (existing) {
    if (existing.schema !== BASELINE_SCHEMA) refuse(`${manifestPath} has schema ${String(existing.schema)}, not ${BASELINE_SCHEMA}.`);
    const changed = sourceHashMismatches(existing.sources);
    if (changed.length) refuse(`captured source files differ from the baseline (LF-normalized SHA-256): ${changed.join(', ')}. The Off baseline is only ever recorded from pre-feature source.`);
    ({ baselineCommit, sources } = existing);
  } else {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) refuse(`${dir} has files but no ${MANIFEST_FILE}; remove them or restore the manifest first.`);
    const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', 'src', 'web/src']);
    if (dirty) refuse(`src/ or web/src/ has changes, so HEAD is not the captured source:\n${dirty}`);
    baselineCommit = git(['rev-parse', 'HEAD']);
    sources = sourceHashes(trackedSourceFiles());
  }

  const first = await captureOffBaseline();
  const second = await captureOffBaseline();
  const unstable = compareBaseline(first, second);
  if (unstable.length) refuse(`two captures of unchanged source differ, so a field is volatile but not on the allowlist:\n${formatDifferences(unstable, 40)}`);
  if (first.length !== BASELINE_CASE_COUNT) refuse(`captured ${first.length} cases, but the matrix defines ${BASELINE_CASE_COUNT}.`);

  const files = new Set([MANIFEST_FILE, ...first.map(record => caseFileName(record.id))]);
  const stale = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => !files.has(name)) : [];
  if (stale.length) refuse(`${dir} holds files that are not part of this baseline: ${stale.join(', ')}.`);

  fs.mkdirSync(dir, { recursive: true });
  for (const record of first) fs.writeFileSync(path.join(dir, caseFileName(record.id)), serializeFixture(record), 'utf8');
  const manifest: BaselineManifest = {
    schema: BASELINE_SCHEMA,
    baselineCommit,
    sourceHashAlgorithm: SOURCE_HASH_ALGORITHM,
    sources,
    normalization: VOLATILE_FIELDS,
    caseCount: first.length,
    cases: first.map(record => ({ id: record.id, file: caseFileName(record.id) })),
  };
  fs.writeFileSync(manifestPath, serializeFixture(manifest), 'utf8');
  console.log(`Wrote ${first.length} Off parity cases and ${MANIFEST_FILE} to ${path.relative(REPO_ROOT, dir) || dir} (baseline commit ${baselineCommit}, ${Object.keys(sources).length} source hashes).`);
}

const args = process.argv.slice(2);
if (args.length === 0) await check();
else if (args[0] === '--write' && args.length === 2) await write(path.resolve(process.cwd(), args[1]));
else refuse('usage: capture-character-baseline.js [--write <baseline directory>]');
