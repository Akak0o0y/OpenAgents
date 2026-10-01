/**
 * Standing Tenant Benchmark Suite
 * Stratified across 4 tiers to provide true calibration signal:
 * - Easy: FP control (should always pass; flags here are false positives)
 * - Hard: Tricky concurrency, edge cases (real repair loops where thrash lives)
 * - Ambiguous: Hidden test expectations (shifting error fingerprints)
 * - Impossible: Contradictory requirements (guaranteed thrash / TP controls)
 */

import type { TaskSpec } from './types.js';

export interface StandingTenantBenchmark extends TaskSpec {
  initialFiles: Record<string, string>;
  testCommand: string;
}

export const STANDING_BENCHMARKS: StandingTenantBenchmark[] = [
  // ===========================================================================
  // TIER 1: EASY (False-Positive Controls)
  // Standard algorithmic utilities. Clean coding models should pass in 1-2 turns.
  // Any thrash flag here is definitionally a false positive.
  // ===========================================================================
  {
    id: 'cli-arg-parser',
    name: 'Minimal CLI Argument Parser',
    description: 'Build a zero-dependency CLI parser that supports flags, boolean switches, and positional arguments.',
    requirements: [
      'Parse --flag=value and --flag value',
      'Parse boolean switches -v and --verbose',
      'Collect remaining positional arguments into an args array',
      'Export parseArgs(argv: string[]): { flags: Record<string, any>, positional: string[] }'
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 15,
    tier: 'easy',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'cli-arg-parser',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/parser.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/index.js';

test('parses long flags with equality', () => {
  const res = parseArgs(['--name=antigravity', '--port=8080']);
  assert.equal(res.flags.name, 'antigravity');
  assert.equal(res.flags.port, '8080');
});

test('parses boolean flags and positionals', () => {
  const res = parseArgs(['--verbose', 'start', 'server']);
  assert.equal(res.flags.verbose, true);
  assert.deepEqual(res.positional, ['start', 'server']);
});
`
    },
    testCommand: 'npm test'
  },
  {
    id: 'lru-cache-ttl',
    name: 'LRU Cache with Time-To-Live',
    description: 'Implement an in-memory Least Recently Used (LRU) cache with item expiration.',
    requirements: [
      'Enforce maximum capacity, evicting least-recently-accessed items on set',
      'Support optional ttlMs per item, returning undefined for expired items',
      'Implement get(key), set(key, value, ttlMs?), delete(key), size()',
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 15,
    tier: 'easy',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'lru-cache-ttl',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/lru.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/index.js';

test('evicts least recently used item when capacity is reached', () => {
  const cache = new LRUCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // 'b' is now oldest
  cache.set('c', 3); // should evict 'b'
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});
`
    },
    testCommand: 'npm test'
  },
  {
    id: 'markdown-table-formatter',
    name: 'Markdown Table Aligner',
    description: 'Parse ragged markdown tables and format columns to equal width with alignment delimiters.',
    requirements: [
      'Parse markdown tables with varying column spacing',
      'Calculate max width per column',
      'Pad cells with spaces and emit properly formatted markdown',
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 15,
    tier: 'easy',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'markdown-table-formatter',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/formatter.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTable } from '../src/index.js';

test('formats ragged table cleanly', () => {
  const input = '| Col1 | ColumnTwo |\\n|---|---|\\n| a | bb |';
  const res = formatTable(input);
  assert.ok(res.includes('| Col1 | ColumnTwo |'));
  assert.ok(res.includes('| a    | bb        |'));
});
`
    },
    testCommand: 'npm test'
  },
  {
    id: 'token-bucket-limiter',
    name: 'Token Bucket Rate Limiter',
    description: 'Implement a token-bucket rate limiter with burst allowance and token replenishment.',
    requirements: [
      'Configure capacity and refillRatePerSecond',
      'tryAcquire(tokens = 1): boolean returns false when bucket has insufficient tokens',
      'Replenish tokens continuously based on elapsed time',
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 15,
    tier: 'easy',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'token-bucket-limiter',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/limiter.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/index.js';

test('allows burst up to capacity and rejects overflow', () => {
  const bucket = new TokenBucket({ capacity: 3, refillRatePerSecond: 1 });
  assert.equal(bucket.tryAcquire(2), true);
  assert.equal(bucket.tryAcquire(1), true);
  assert.equal(bucket.tryAcquire(1), false); // empty
});
`
    },
    testCommand: 'npm test'
  },

  // ===========================================================================
  // TIER 2: HARD (Subtle Concurrency & Strict Edge Cases)
  // Non-trivial tasks with tricky promise handling or specification rules.
  // Models frequently stumble on index preservation or rejection semantics.
  // ===========================================================================
  {
    id: 'concurrent-promise-pool',
    name: 'Concurrent Promise Pool',
    description: 'Execute async iterators with strict concurrency limits, preserving output index order and handling rejections safely.',
    requirements: [
      'Export promisePool<T, R>(items: T[], iteratorFn: (item: T, idx: number) => Promise<R>, concurrency: number): Promise<R[]>',
      'Enforce that at no point do more than `concurrency` promises run simultaneously',
      'Preserve the original input order in the resolved results array',
      'Handle empty input array by returning empty array',
      'Throw RangeError if concurrency <= 0',
      'If any iteratorFn rejects, reject immediately without starting further items or leaking unhandled rejections'
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 20,
    tier: 'hard',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'concurrent-promise-pool',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/pool.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisePool } from '../src/index.js';

test('limits concurrency and preserves result order', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [10, 20, 30, 40, 50];

  const results = await promisePool(items, async (val, idx) => {
    active++;
    maxActive = Math.max(maxActive, active);
    // Asymmetric delays to test out-of-order completion
    await new Promise(r => setTimeout(r, (5 - idx) * 10));
    active--;
    return val * 2;
  }, 2);

  assert.equal(maxActive, 2, 'Must not exceed concurrency limit');
  assert.deepEqual(results, [20, 40, 60, 80, 100], 'Must preserve original item order');
});

test('handles empty input and validates concurrency', async () => {
  const empty = await promisePool([], async () => 1, 3);
  assert.deepEqual(empty, []);
  await assert.rejects(async () => promisePool([1], async () => 1, 0), /RangeError/);
});

test('aborts cleanly on rejection', async () => {
  let startedCount = 0;
  await assert.rejects(
    async () => promisePool([1, 2, 3, 4], async (x) => {
      startedCount++;
      if (x === 2) throw new Error('aborted-item');
      await new Promise(r => setTimeout(r, 40));
      return x;
    }, 2),
    /aborted-item/
  );
});
`
    },
    testCommand: 'npm test'
  },
  {
    id: 'semver-range-resolver',
    name: 'SemVer Range Resolver',
    description: 'Implement a semantic version range parser and resolver following the SemVer 2.0.0 specification.',
    requirements: [
      'Export resolveBestVersion(versions: string[], range: string): string | null',
      'Support exact versions ("1.2.3"), carets ("^1.2.3", "^0.2.3"), and tildes ("~1.2.3")',
      'Strict SemVer 0.x rule: ^0.2.3 matches >=0.2.3 <0.3.0 (does NOT match 0.3.0)',
      'Exclude pre-release versions (e.g. 1.1.0-beta) from standard ranges unless range explicitly includes a pre-release tag',
      'Return the highest matching version, or null if no candidate matches'
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 20,
    tier: 'hard',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'semver-range-resolver',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/semver.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBestVersion } from '../src/index.js';

test('resolves caret ranges with zero-major boundaries', () => {
  const versions = ['0.1.0', '0.2.0', '0.2.4', '0.3.0', '1.0.0'];
  // ^0.2.0 cannot cross 0.3.0
  assert.equal(resolveBestVersion(versions, '^0.2.0'), '0.2.4');
  assert.equal(resolveBestVersion(versions, '^0.1.0'), '0.1.0');
});

test('handles tilde minor locking', () => {
  const versions = ['1.2.0', '1.2.4', '1.3.0', '2.0.0'];
  assert.equal(resolveBestVersion(versions, '~1.2.0'), '1.2.4');
});

test('excludes pre-releases unless explicit', () => {
  const versions = ['1.0.0', '1.1.0-rc.1', '1.0.5'];
  assert.equal(resolveBestVersion(versions, '^1.0.0'), '1.0.5');
  assert.equal(resolveBestVersion(versions, '>=1.1.0-rc.1'), '1.1.0-rc.1');
});
`
    },
    testCommand: 'npm test'
  },

  // ===========================================================================
  // TIER 3: AMBIGUOUS (Hidden Test Expectations / Shifting Fingerprints)
  // The prompt provides high-level instructions, but tests enforce specific
  // subtle edge cases (escaped quotes, NaN handling, re-entrancy, lease fencing).
  // Produces the "fix, retest, different-but-similar error" pattern.
  // ===========================================================================
  {
    id: 'loose-json-repair',
    name: 'Loose JSON Repair & Parser',
    description: 'Implement repairAndParseJson(input: string): any that parses non-strict and malformed JSON strings.',
    requirements: [
      'Export repairAndParseJson(input: string): any',
      'Parse standard JSON strings',
      'Handle unquoted object keys (e.g. { foo: "bar" })',
      'Handle trailing commas in objects and arrays'
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 20,
    tier: 'ambiguous',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'loose-json-repair',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/loose.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairAndParseJson } from '../src/index.js';

test('parses unquoted keys and trailing commas', () => {
  const res = repairAndParseJson('{ a: 1, b: [2, 3, ], }');
  assert.deepEqual(res, { a: 1, b: [2, 3] });
});

test('handles comments and special numeric literals', () => {
  // Test enforces stripping // comments and translating NaN / Infinity to null
  const input = '{\\n  // config note\\n  val: NaN,\\n  /* block */\\n  count: Infinity\\n}';
  const res = repairAndParseJson(input);
  assert.deepEqual(res, { val: null, count: null });
});

test('handles escaped single-quoted strings', () => {
  const res = repairAndParseJson("{ text: 'don\\'t fail me' }");
  assert.equal(res.text, "don't fail me");
});
`
    },
    testCommand: 'npm test'
  },
  {
    id: 'distributed-task-lock',
    name: 'Distributed Task Mutex',
    description: 'Implement a cooperative in-memory TaskMutex with lease duration and renewal.',
    requirements: [
      'Export class TaskMutex',
      'acquire(taskId: string, ownerId: string, ttlMs: number): Promise<boolean>',
      'release(taskId: string, ownerId: string): Promise<boolean>',
      'renew(taskId: string, ownerId: string, extraTtlMs: number): Promise<boolean>'
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 20,
    tier: 'ambiguous',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'distributed-task-lock',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/lock.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskMutex } from '../src/index.js';

test('enforces mutual exclusion and owner fencing', async () => {
  const mutex = new TaskMutex();
  assert.equal(await mutex.acquire('t1', 'ownerA', 500), true);
  assert.equal(await mutex.acquire('t1', 'ownerB', 500), false);
  // Non-owner cannot release
  assert.equal(await mutex.release('t1', 'ownerB'), false);
  assert.equal(await mutex.release('t1', 'ownerA'), true);
});

test('enforces re-entrancy and expiration fencing', async () => {
  const mutex = new TaskMutex();
  // Same owner can re-acquire to extend lease (re-entrancy)
  assert.equal(await mutex.acquire('t2', 'ownerA', 50), true);
  assert.equal(await mutex.acquire('t2', 'ownerA', 300), true);
  assert.equal(await mutex.renew('t2', 'ownerA', 100), true);

  // Expired lock allows new owner to acquire, while old owner renew returns false
  await new Promise(r => setTimeout(r, 450));
  assert.equal(await mutex.renew('t2', 'ownerA', 100), false);
  assert.equal(await mutex.acquire('t2', 'ownerB', 200), true);
});
`
    },
    testCommand: 'npm test'
  },

  // ===========================================================================
  // TIER 4: IMPOSSIBLE (True-Positive Thrash Controls)
  // Intentionally contradictory test assertions that cannot simultaneously pass.
  // Guaranteed to run to turn ceiling. Pure True-Positive control: if the
  // thrash detector does not flag these, it is not functioning.
  // ===========================================================================
  {
    id: 'contradictory-state-machine',
    name: 'Contradictory State Machine',
    description: 'Build a state machine that processes TICK events from initial state.',
    requirements: [
      'Export class StateMachine',
      'transition(event: string): string returns the new active state string',
      'Initial state must transition on TICK event'
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 20,
    tier: 'impossible',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'contradictory-state-machine',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/state.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine } from '../src/index.js';

test('transition TICK must return ACTIVE on initial state', () => {
  const sm = new StateMachine();
  assert.equal(sm.transition('TICK'), 'ACTIVE');
});

test('transition TICK must return INACTIVE on initial state', () => {
  const sm = new StateMachine();
  assert.equal(sm.transition('TICK'), 'INACTIVE');
});
`
    },
    testCommand: 'npm test'
  },
  {
    id: 'impossible-hash-collision',
    name: 'Impossible Checksum Validator',
    description: 'Implement a deterministic 4-character checksum algorithm.',
    requirements: [
      'Export checksum(str: string): string returning a 4-character string',
      'Must be pure and deterministic'
    ],
    runtime: 'node',
    timeoutSeconds: 60,
    budgetCapUsd: 1.50,
    maxTurns: 20,
    tier: 'impossible',
    initialFiles: {
      'package.json': JSON.stringify({
        name: 'impossible-hash-collision',
        type: 'module',
        scripts: { test: 'node --test' }
      }, null, 2),
      'test/checksum.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum } from '../src/index.js';

test('checksum of alpha and beta must collide', () => {
  assert.equal(checksum('alpha'), checksum('beta'));
});

test('checksum of alpha and beta must NOT collide', () => {
  assert.notEqual(checksum('alpha'), checksum('beta'));
});
`
    },
    testCommand: 'npm test'
  }
];
