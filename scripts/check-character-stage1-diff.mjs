#!/usr/bin/env node
/**
 * Character layer Stage 1 protected-diff check.
 * Verifies that protected Stage 1 files change only within strict allowlists
 * and line-addition caps against the base commit.
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

export const ZERO_DIFF_FILES = [
  'src/daemon/publish-policy.ts',
  'src/daemon/publish-probes.ts',
  'tests/publish-honesty.test.ts',
  'tests/publish-policy.test.ts',
  'tests/browser-publish.test.ts',
  'tests/external-effects.test.ts',
  'tests/publish-probes.test.ts',
  'tests/helpers/x-fixture.ts',
  'tests/character-off-parity.test.ts',
  'tests/fixtures/character/baseline/',
];

export const LIMITED_FILES = {
  'src/daemon/browser-publish.ts': {
    maxAdded: 40,
    removableLines: [
      "export interface RunPolicy { publishLimit?: 1; recent?: { textHashes: ReadonlySet<string>; targets: ReadonlySet<string> } }",
      "export type PublishRefusalReason = 'budget' | 'duplicate-text' | 'duplicate-target' | 'expected-mismatch';",
      "  | { kind: 'refuse'; reason: PublishRefusalReason; by: PublishRecord['by']; actionId?: string; probe: string; op: string }",
      "  | { kind: 'track'; record: PublishRecord; attempted: PublishAttempted };",
      "    return { kind: 'track', record: copy(record), attempted };",
      "    emit('PUBLISH_ATTEMPTED', admitted.attempted);",
    ],
  },
  'src/daemon/browser-tools.ts': {
    maxAdded: 2,
    removableLines: [],
  },
  'src/daemon/external-effects.ts': {
    maxAdded: 6,
    removableLines: [
      "  heldBack: 'budget' | 'duplicate' | 'mismatch' | 'internal' | null;",
      "const HELD_BACK_ORDER: readonly HeldBack[] = ['budget', 'duplicate', 'mismatch', 'internal'];",
    ],
  },
  'tests/helpers/flow-harness.ts': {
    maxAdded: 12,
    removableLines: [
      "    return { content: JSON.stringify(action), inputTokens: 1, outputTokens: 1, attemptCount: 1 };",
      "  const runtime = new WorkRuntime({ store, ledger, artifacts, approvals, llm, sandbox, browser, publishPolicy: publishEnabled ? publishPolicy : undefined });",
    ],
  },
};

// Known Phase 1 Task 4 replacement in tests/character-off-parity.test.ts when comparing to uncommitted base d9d3cff
const OFF_PARITY_PHASE1_REMOVED = new Set([
  ' * Test-only stand-in for Phase 1\'s two character tables (spec §8.2), holding an enabled version followed by',
  ' * an off one. Nothing reads these rows yet; Task 4 replaces this seed with a real CharacterStore save.',
  'function seedLatestOff(store: AgentStore): void {',
  '  const db = store.getDatabase();',
  '  db.exec(`CREATE TABLE IF NOT EXISTS bot_character_versions (',
  '      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, version INTEGER NOT NULL, schema_version TEXT NOT NULL,',
  '      mode TEXT NOT NULL, document_json TEXT NOT NULL, settings_json TEXT NOT NULL, document_sha256 TEXT NOT NULL, card_sha256 TEXT NOT NULL,',
  '      compiler_version TEXT NOT NULL, mapping_version TEXT NOT NULL, origin TEXT NOT NULL, approval_id TEXT, proposal_id TEXT, note TEXT,',
  '      created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, version));',
  '    CREATE TABLE IF NOT EXISTS bot_character_sources (',
  '      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, kind TEXT NOT NULL, text TEXT NOT NULL,',
  '      text_sha256 TEXT NOT NULL, meta_json TEXT, created_at INTEGER NOT NULL);',
  '    CREATE INDEX IF NOT EXISTS bot_character_sources_kind ON bot_character_sources(agent_id, kind);`);',
  '  const sample = \'Milo writes short, checked sentences.\';',
  '  db.prepare(\'INSERT INTO bot_character_sources (id, agent_id, kind, text, text_sha256, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)\')',
  '    .run(\'src-seed-1\', AGENT_ID, \'sample\', sample, lfSha256(sample), \'{}\', FIXED_TIME);',
  '  const insert = db.prepare(`INSERT INTO bot_character_versions (agent_id, version, schema_version, mode, document_json, settings_json, document_sha256,',
  '    card_sha256, compiler_version, mapping_version, origin, approval_id, proposal_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`);',
  '  for (const [version, mode] of [[1, \'character\'], [2, \'off\']] as const) {',
  '    const document = JSON.stringify({ schema: \'openhours.character/1\', identity: { name: \'Milo\', oneLine: \'A careful release assistant.\' }, samples: [\'src-seed-1\'] });',
  '    insert.run(AGENT_ID, version, \'openhours.character/1\', mode, document, \'{}\', lfSha256(document), lfSha256(\'\'), \'seed\', \'seed\', \'studio\',',
  '      \'Task 1 test-only seed\', FIXED_TIME + version);',
  '  }',
  '  const latest = db.prepare(\'SELECT mode FROM bot_character_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1\').get(AGENT_ID) as { mode: string };',
]);

/**
 * Check a diff string for a specific file.
 * Returns { ok: boolean, error?: string, addedCount: number, removedMatches: string[] }
 */
export function checkFileDiff(filePath, diffText, options = {}) {
  // Strip \r
  const cleanDiff = diffText.replace(/\r/g, '');
  const lines = cleanDiff.split('\n');

  let addedCount = 0;
  const removedLines = [];

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff --git') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+')) {
      addedCount++;
    } else if (line.startsWith('-')) {
      removedLines.push(line.slice(1));
    }
  }

  // If this is a zero-diff file
  const isZeroDiff = ZERO_DIFF_FILES.some(z => filePath === z || (z.endsWith('/') && filePath.startsWith(z)));
  if (isZeroDiff) {
    // If it's character-off-parity and options allow Phase 1 seed change
    if (filePath === 'tests/character-off-parity.test.ts' && options.allowPhase1ParitySeed) {
      const nonPhase1Removed = removedLines.filter(l => !OFF_PARITY_PHASE1_REMOVED.has(l));
      if (nonPhase1Removed.length === 0 && addedCount <= 35) {
        return { ok: true, addedCount, removedMatches: ['Phase 1 Task 4 seedLatestOff update'] };
      }
    }

    if (addedCount > 0 || removedLines.length > 0) {
      return {
        ok: false,
        error: `Zero-diff file modified: ${filePath} (+${addedCount}, -${removedLines.length})`,
        addedCount,
        removedMatches: [],
      };
    }
    return { ok: true, addedCount: 0, removedMatches: [] };
  }

  // Limited file
  const rules = LIMITED_FILES[filePath];
  if (!rules) {
    // Not a protected file
    return { ok: true, addedCount, removedMatches: [] };
  }

  if (addedCount > rules.maxAdded) {
    return {
      ok: false,
      error: `File ${filePath} exceeded max added lines: ${addedCount} > ${rules.maxAdded}`,
      addedCount,
      removedMatches: [],
    };
  }

  const allowedSet = new Set(rules.removableLines);
  const seenRemoved = new Set();
  const matchedRemovals = [];

  for (const removed of removedLines) {
    if (!allowedSet.has(removed)) {
      return {
        ok: false,
        error: `Non-allowlisted line removed in ${filePath}: "${removed}"`,
        addedCount,
        removedMatches: matchedRemovals,
      };
    }
    if (seenRemoved.has(removed)) {
      return {
        ok: false,
        error: `Allowlisted line removed twice in ${filePath}: "${removed}"`,
        addedCount,
        removedMatches: matchedRemovals,
      };
    }
    seenRemoved.add(removed);
    matchedRemovals.push(removed);
  }

  return {
    ok: true,
    addedCount,
    removedMatches: matchedRemovals,
  };
}

/**
 * Self-test suite verifying the 6 canned conditions.
 */
export function runSelfTest() {
  console.log('Running check-character-stage1-diff self-test...');

  // Test 1: An allowlisted removal plus additions under the cap -> passes
  const diff1 = `
--- a/src/daemon/browser-publish.ts
+++ b/src/daemon/browser-publish.ts
@@ -20,1 +20,3 @@
-export type PublishRefusalReason = 'budget' | 'duplicate-text' | 'duplicate-target' | 'expected-mismatch';
+export type PublishRefusalReason = 'budget' | 'duplicate-text';
+export type AdditionalReason = 'character-unadmitted';
+export type AnotherReason = 'character-unverifiable';
`;
  const res1 = checkFileDiff('src/daemon/browser-publish.ts', diff1);
  if (!res1.ok) {
    throw new Error(`Self-test 1 failed: expected pass, got error: ${res1.error}`);
  }

  // Test 2: A removed non-allowlisted line in a limited file -> fails, naming the line
  const nonAllowedLine = 'const arbitraryLine = 123;';
  const diff2 = `
--- a/src/daemon/browser-publish.ts
+++ b/src/daemon/browser-publish.ts
@@ -10,1 +10,1 @@
-${nonAllowedLine}
+const arbitraryLine = 456;
`;
  const res2 = checkFileDiff('src/daemon/browser-publish.ts', diff2);
  if (res2.ok || !res2.error.includes(nonAllowedLine)) {
    throw new Error(`Self-test 2 failed: expected failure naming "${nonAllowedLine}", got: ${JSON.stringify(res2)}`);
  }

  // Test 3: Any change to a zero-diff file -> fails
  const diff3 = `
--- a/src/daemon/publish-policy.ts
+++ b/src/daemon/publish-policy.ts
@@ -1,0 +1,1 @@
+// added line
`;
  const res3 = checkFileDiff('src/daemon/publish-policy.ts', diff3);
  if (res3.ok) {
    throw new Error('Self-test 3 failed: expected failure on zero-diff file, got pass');
  }

  // Test 4: Added lines beyond a file's cap -> fails
  const diff4 = `
--- a/src/daemon/browser-tools.ts
+++ b/src/daemon/browser-tools.ts
@@ -10,0 +10,3 @@
+// line 1
+// line 2
+// line 3
`;
  const res4 = checkFileDiff('src/daemon/browser-tools.ts', diff4);
  if (res4.ok || !res4.error.includes('exceeded max added lines')) {
    throw new Error(`Self-test 4 failed: expected max added failure, got: ${JSON.stringify(res4)}`);
  }

  // Test 5: The same allowlisted line removed twice -> fails
  const diff5 = `
--- a/src/daemon/browser-publish.ts
+++ b/src/daemon/browser-publish.ts
@@ -20,1 +20,1 @@
-export type PublishRefusalReason = 'budget' | 'duplicate-text' | 'duplicate-target' | 'expected-mismatch';
@@ -50,1 +50,1 @@
-export type PublishRefusalReason = 'budget' | 'duplicate-text' | 'duplicate-target' | 'expected-mismatch';
`;
  const res5 = checkFileDiff('src/daemon/browser-publish.ts', diff5);
  if (res5.ok || !res5.error.includes('removed twice')) {
    throw new Error(`Self-test 5 failed: expected removed twice failure, got: ${JSON.stringify(res5)}`);
  }

  // Test 6: CRLF inside the diff text -> ignored
  const diff6 = `\r\n--- a/src/daemon/browser-publish.ts\r\n+++ b/src/daemon/browser-publish.ts\r\n@@ -20,1 +20,1 @@\r\n-export type PublishRefusalReason = 'budget' | 'duplicate-text' | 'duplicate-target' | 'expected-mismatch';\r\n+export type PublishRefusalReason = 'budget';\r\n`;
  const res6 = checkFileDiff('src/daemon/browser-publish.ts', diff6);
  if (!res6.ok) {
    throw new Error(`Self-test 6 failed: CRLF should be ignored, got: ${res6.error}`);
  }

  console.log('All 6 self-test cases passed cleanly.');
}

/**
 * Main execution.
 */
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    runSelfTest();
    return;
  }

  const baseIndex = args.indexOf('--base');
  let baseCommit = null;
  if (baseIndex !== -1 && args[baseIndex + 1]) {
    baseCommit = args[baseIndex + 1];
  } else {
    for (const arg of args) {
      if (arg.startsWith('--base=')) {
        baseCommit = arg.slice(7);
      }
    }
  }

  if (!baseCommit) {
    console.error('Usage: node scripts/check-character-stage1-diff.mjs --base <BASE> | --self-test');
    process.exit(1);
  }

  console.log(`Checking Stage 1 protected files against base: ${baseCommit}`);

  const allFilesToCheck = [
    ...Object.keys(LIMITED_FILES),
    ...ZERO_DIFF_FILES,
  ];

  let anyViolation = false;

  for (const file of allFilesToCheck) {
    try {
      const diffOutput = execFileSync(
        'git',
        ['diff', '--no-color', '--unified=0', baseCommit, '--', file],
        { encoding: 'utf8' }
      );

      const check = checkFileDiff(file, diffOutput, { allowPhase1ParitySeed: true });
      if (!check.ok) {
        console.error(`[VIOLATION] ${file}: ${check.error}`);
        anyViolation = true;
      } else {
        if (!diffOutput.trim()) {
          console.log(`[CLEAN] ${file}: no changes`);
        } else {
          console.log(`[CLEAN] ${file}: +${check.addedCount} lines, ${check.removedMatches.length} allowlisted removals`);
          for (const match of check.removedMatches) {
            console.log(`   - removed: ${match.slice(0, 80)}...`);
          }
        }
      }
    } catch (err) {
      console.error(`[ERROR] git diff failed for ${file}:`, err.message);
      anyViolation = true;
    }
  }

  if (anyViolation) {
    console.error('\nStage 1 protected diff check FAILED.');
    process.exit(1);
  }

  console.log('\nAll Stage 1 protected files passed diff verification.');
}

// Only invoke main when run as CLI
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/check-character-stage1-diff.mjs')) {
  main();
}
