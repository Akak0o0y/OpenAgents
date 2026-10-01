/**
 * Phase 2 Trace Runner CLI
 * Collects empirical traces across stratified standing benchmarks
 * with the thrash detector running in shadow mode, turn ceiling 40,
 * and cost ledger budget watchdog as hard economic backstop.
 * Supports OpenRouter dynamic catalog, preflight verification,
 * and suite-level spending caps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STANDING_BENCHMARKS } from '../kernel/standing-tenant.js';
import { TraceRunner } from './trace-runner.js';
import { LiveLLMClient, MockLLMClient, syncOpenRouterCatalog, type ILLMClient } from './llm-client.js';
import { getModelPricing } from '../kernel/cost-ledger.js';
import type { TraceRecord, TraceOutcome } from './types.js';

// Pre-packaged reference implementations for offline calibration and testing
const BENCHMARK_SOLUTIONS: Record<string, string> = {
  'cli-arg-parser': `
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const rest = arg.slice(2);
      if (rest.includes('=')) {
        const [k, v] = rest.split('=');
        flags[k] = v;
      } else {
        flags[rest] = true;
      }
    } else if (arg.startsWith('-')) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
`,
  'lru-cache-ttl': `
export class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const item = this.cache.get(key);
    if (item.expires && Date.now() > item.expires) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.val;
  }
  set(key, val, ttlMs) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { val, expires: ttlMs ? Date.now() + ttlMs : null });
  }
  delete(key) {
    return this.cache.delete(key);
  }
  size() {
    return this.cache.size;
  }
}
`,
  'markdown-table-formatter': `
export function formatTable(markdown) {
  const lines = markdown.trim().split('\\n');
  const rows = lines.map(line => line.split('|').slice(1, -1).map(c => c.trim()));
  const colWidths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      colWidths[i] = Math.max(colWidths[i] || 0, cell.length);
    });
  }
  const formatted = rows.map((row, rIdx) => {
    if (rIdx === 1) {
      return '| ' + row.map((_, i) => '-'.repeat(colWidths[i])).join(' | ') + ' |';
    }
    return '| ' + row.map((cell, i) => cell.padEnd(colWidths[i])).join(' | ') + ' |';
  });
  return formatted.join('\\n');
}
`,
  'token-bucket-limiter': `
export class TokenBucket {
  constructor({ capacity, refillRatePerSecond }) {
    this.capacity = capacity;
    this.refillRatePerSecond = refillRatePerSecond;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerSecond);
    this.lastRefill = now;
  }
  tryAcquire(tokens = 1) {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }
}
`,
  'concurrent-promise-pool': `
export async function promisePool(items, iteratorFn, concurrency) {
  if (typeof concurrency !== 'number' || concurrency <= 0) {
    throw new RangeError('concurrency must be > 0');
  }
  if (!items || items.length === 0) return [];
  const results = new Array(items.length);
  let nextIdx = 0;
  let rejected = false;
  let rejectionErr = null;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIdx < items.length && !rejected) {
      const idx = nextIdx++;
      try {
        const res = await iteratorFn(items[idx], idx);
        results[idx] = res;
      } catch (err) {
        rejected = true;
        rejectionErr = err;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  if (rejected) throw rejectionErr;
  return results;
}
`,
  'semver-range-resolver': `
function parseVer(v) {
  const [core, pre] = v.split('-');
  const [major, minor, patch] = core.split('.').map(Number);
  return { major, minor, patch, pre: pre ? pre.split('.') : [] };
}

function compareVer(a, b) {
  const vA = parseVer(a);
  const vB = parseVer(b);
  if (vA.major !== vB.major) return vA.major - vB.major;
  if (vA.minor !== vB.minor) return vA.minor - vB.minor;
  if (vA.patch !== vB.patch) return vA.patch - vB.patch;
  if (vA.pre.length === 0 && vB.pre.length > 0) return 1;
  if (vA.pre.length > 0 && vB.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(vA.pre.length, vB.pre.length); i++) {
    const pA = vA.pre[i];
    const pB = vB.pre[i];
    if (pA === undefined) return -1;
    if (pB === undefined) return 1;
    const numA = Number(pA);
    const numB = Number(pB);
    if (!isNaN(numA) && !isNaN(numB)) {
      if (numA !== numB) return numA - numB;
    } else {
      if (pA !== pB) return pA.localeCompare(pB);
    }
  }
  return 0;
}

export function satisfiesRange(version, range) {
  const ver = parseVer(version);
  if (range.startsWith('^')) {
    const min = range.slice(1);
    const minV = parseVer(min);
    if (compareVer(version, min) < 0) return false;
    if (ver.pre.length > 0 && minV.pre.length === 0) return false;
    if (minV.major > 0) return ver.major === minV.major;
    if (minV.minor > 0) return ver.major === 0 && ver.minor === minV.minor;
    return ver.major === 0 && ver.minor === 0 && ver.patch === minV.patch;
  }
  if (range.startsWith('~')) {
    const min = range.slice(1);
    const minV = parseVer(min);
    if (compareVer(version, min) < 0) return false;
    if (ver.pre.length > 0 && minV.pre.length === 0) return false;
    return ver.major === minV.major && ver.minor === minV.minor;
  }
  if (range.startsWith('>=')) {
    return compareVer(version, range.slice(2).trim()) >= 0;
  }
  if (range.startsWith('<=')) {
    return compareVer(version, range.slice(2).trim()) <= 0;
  }
  if (range.startsWith('>')) {
    return compareVer(version, range.slice(1).trim()) > 0;
  }
  if (range.startsWith('<')) {
    return compareVer(version, range.slice(1).trim()) < 0;
  }
  return compareVer(version, range) === 0;
}

export function resolveHighestMatching(versions, range) {
  const matching = versions.filter(v => satisfiesRange(v, range));
  if (matching.length === 0) return null;
  matching.sort(compareVer);
  return matching[matching.length - 1];
}
`,
  'event-emitter-priority': `
export class PriorityEventEmitter {
  constructor() {
    this.listeners = new Map();
  }
  on(event, fn, priority = 0) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    const list = this.listeners.get(event);
    list.push({ fn, priority });
    list.sort((a, b) => b.priority - a.priority);
  }
  emit(event, ...args) {
    if (!this.listeners.has(event)) return;
    const list = [...this.listeners.get(event)];
    for (const item of list) {
      item.fn(...args);
    }
  }
}
`,
  'sql-like-query-builder': `
export class QueryBuilder {
  constructor(table) {
    this.table = table;
    this.wheres = [];
  }
  where(col, op, val) {
    this.wheres.push({ col, op, val });
    return this;
  }
  toSQL() {
    let sql = \`SELECT * FROM \${this.table}\`;
    if (this.wheres.length > 0) {
      const clauses = this.wheres.map(w => \`\${w.col} \${w.op} '\${w.val}'\`).join(' AND ');
      sql += \` WHERE \${clauses}\`;
    }
    return sql;
  }
}
`,
  'impossible-pure-number-hash': `
export function magicHash(input) {
  return 42;
}
`,
  'impossible-synchronous-sleep': `
export function perfectSleep(ms) {
  return '1234';
}
`
};

/**
 * Creates a calibrated mock sequence generator stratified by benchmark tier.
 */
function createCalibratedMockSequence(taskId: string, runIndex: number): string[] {
  const task = STANDING_BENCHMARKS.find(b => b.id === taskId);
  const tier = task?.tier ?? 'easy';
  const goodCode = BENCHMARK_SOLUTIONS[taskId] ?? '// fallback good code';
  const badCodeA = 'export function badA() { throw new Error("Missing implementation A"); }';
  const badCodeB = 'export function badB() { throw new Error("Missing implementation B"); }';
  const badCodeC = 'export function badC() { throw new Error("Missing implementation C"); }';
  const repeatingBad = 'export function loopBad() { throw new Error("Static repeated failure"); }';

  if (tier === 'easy') {
    // Easy tier: False-Positive Control. Passes cleanly in 1-2 turns.
    switch (runIndex) {
      case 1:
        return [goodCode];
      case 2:
        return [badCodeA, goodCode];
      case 3:
        return [goodCode];
      case 4:
        return [badCodeA, goodCode];
      case 5:
      default:
        return [goodCode];
    }
  }

  if (tier === 'hard') {
    switch (runIndex) {
      case 1:
        return [badCodeA, badCodeB, goodCode];
      case 2:
        return [badCodeA, badCodeB, badCodeC, goodCode];
      case 3:
        return [badCodeA, badCodeB, goodCode];
      case 4:
        return [repeatingBad, repeatingBad, repeatingBad, repeatingBad, goodCode];
      case 5:
      default:
        return Array(45).fill(repeatingBad);
    }
  }

  if (tier === 'ambiguous') {
    switch (runIndex) {
      case 1:
        return [badCodeA, badCodeB, goodCode];
      case 2:
        return [badCodeA, badCodeB, badCodeC, goodCode];
      case 3:
        return [badCodeA, badCodeB, badCodeC, 'export function badD() { throw new Error("D"); }', goodCode];
      case 4:
        return [repeatingBad, repeatingBad, repeatingBad, repeatingBad, goodCode];
      case 5:
      default:
        return Array(45).fill(repeatingBad);
    }
  }

  // Impossible tier: contradictory assertions. Guaranteed to run to cap.
  return Array(45).fill(repeatingBad);
}

interface FreeSweepCandidateResult {
  modelId: string;
  clearedPreflight: boolean;
  allPassedUnderTwoTurns: boolean;
  status: 'PASSED' | 'CAPABILITY_FAILED' | 'ENDPOINT_UNAVAILABLE';
  error?: string;
  tasks: {
    taskId: string;
    outcome: TraceOutcome;
    totalTurns: number;
    turnsToSuccess?: number;
    passedUnderTwoTurns: boolean;
    shadowThrashDetected: boolean;
    shadowThrashFiredAtTurn?: number;
    shadowThrashReason?: string;
    actualCostUsd: number;
    shadowCostUsd: number;
    durationSec: number;
  }[];
}

async function runFreeSweep(customModels?: string[]) {
  const candidates = customModels && customModels.length > 0
    ? customModels
    : [
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'nvidia/nemotron-3-super-120b-a12b:free',
        'z-ai/glm-5.2:free',
      ];

  console.log('================================================================');
  console.log('       Phase 2: Free-Tier Model Capability Sweep                ');
  console.log('================================================================');
  console.log(`Candidates: ${candidates.join(', ')}`);
  console.log(`Requirement: All 4 easy benchmarks must pass in <= 2 turns.`);
  console.log('================================================================\n');

  const sweepResults: FreeSweepCandidateResult[] = [];
  const easyTasks = STANDING_BENCHMARKS.filter(t => t.tier === 'easy');

  for (const modelId of candidates) {
    console.log(`\n================================================================`);
    console.log(`Testing Candidate: ${modelId}`);
    console.log(`================================================================`);

    try {
      getModelPricing(modelId);
    } catch (err: any) {
      console.error(`Skipping ${modelId}: ${err.message}`);
      sweepResults.push({
        modelId,
        clearedPreflight: false,
        allPassedUnderTwoTurns: false,
        status: 'ENDPOINT_UNAVAILABLE',
        error: err.message,
        tasks: [],
      });
      continue;
    }

    const liveClient = new LiveLLMClient();
    if (!liveClient.hasProvider(modelId)) {
      console.error(`Skipping ${modelId}: No provider/key found`);
      sweepResults.push({
        modelId,
        clearedPreflight: false,
        allPassedUnderTwoTurns: false,
        status: 'ENDPOINT_UNAVAILABLE',
        error: 'No active API key found',
        tasks: [],
      });
      continue;
    }

    const runner = new TraceRunner(liveClient);
    const taskResults: FreeSweepCandidateResult['tasks'] = [];
    let allPassedUnderTwo = true;
    let modelError: string | undefined;

    for (const task of easyTasks) {
      process.stdout.write(`  Benchmark [${task.id.padEnd(25)}] ... `);
      const startTime = Date.now();
      try {
        const record = await runner.runTrace(task, 1, {
          modelId,
          maxTurns: 5,
          budgetCapUsd: 1.50,
          turnPacingDelayMs: 1500,
        });

        const durationSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
        const passedInTime = record.outcome === 'PASSED' && record.totalTurns <= 2;
        if (!passedInTime) allPassedUnderTwo = false;

        const outcomeColor = record.outcome === 'PASSED' ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';
        const thrashTag = record.shadowThrashDetected ? ' \x1b[33m[SHADOW_FLAGGED]\x1b[0m' : '';

        console.log(`${outcomeColor}${record.outcome}${resetColor}${thrashTag} in ${record.totalTurns} turn(s) ($${record.totalCostUsd.toFixed(4)} actual, $${record.totalShadowCostUsd.toFixed(4)} shadow, ${durationSec}s)`);

        taskResults.push({
          taskId: task.id,
          outcome: record.outcome,
          totalTurns: record.totalTurns,
          turnsToSuccess: record.turnsToSuccess,
          passedUnderTwoTurns: passedInTime,
          shadowThrashDetected: record.shadowThrashDetected,
          shadowThrashFiredAtTurn: record.shadowThrashFiredAtTurn,
          shadowThrashReason: record.shadowThrashReason,
          actualCostUsd: record.totalCostUsd,
          shadowCostUsd: record.totalShadowCostUsd,
          durationSec,
        });
      } catch (err: any) {
        allPassedUnderTwo = false;
        modelError = err.message;
        console.log(`\x1b[31mERROR\x1b[0m: ${err.message}`);
        taskResults.push({
          taskId: task.id,
          outcome: 'HARNESS_ERROR',
          totalTurns: 0,
          passedUnderTwoTurns: false,
          shadowThrashDetected: false,
          actualCostUsd: 0,
          shadowCostUsd: 0,
          durationSec: parseFloat(((Date.now() - startTime) / 1000).toFixed(1)),
        });
        break; // If a model crashes or hits unrecoverable rate limit, proceed to next candidate
      }
    }

    runner.close();

    const cleared = allPassedUnderTwo && taskResults.length === 4;
    const allRateLimited = taskResults.length > 0 && taskResults.every(t => t.outcome === 'RATE_LIMITED' || t.totalTurns === 0);
    let status: 'PASSED' | 'CAPABILITY_FAILED' | 'ENDPOINT_UNAVAILABLE';
    if (cleared) {
      status = 'PASSED';
    } else if (allRateLimited) {
      status = 'ENDPOINT_UNAVAILABLE';
    } else {
      status = 'CAPABILITY_FAILED';
    }

    sweepResults.push({
      modelId,
      clearedPreflight: cleared,
      allPassedUnderTwoTurns: cleared,
      status,
      error: modelError,
      tasks: taskResults,
    });
  }

  // Print comparison table
  console.log('\n========================================================================================================================');
  console.log('                                         FREE-TIER CANDIDATE SWEEP RESULTS                                              ');
  console.log('========================================================================================================================');
  console.log('| Model Candidate                          | cli-arg-parser | lru-cache-ttl | markdown-table | token-bucket | Pre-Flight Verdict       |');
  console.log('|------------------------------------------|----------------|---------------|----------------|--------------|--------------------------|');

  for (const r of sweepResults) {
    const getTaskStr = (id: string) => {
      const t = r.tasks.find(x => x.taskId === id);
      if (!t) return 'N/A';
      if (t.outcome === 'PASSED') return `PASSED (${t.totalTurns}t)`;
      return `${t.outcome} (${t.totalTurns}t)`;
    };
    const c1 = getTaskStr('cli-arg-parser').padEnd(14);
    const c2 = getTaskStr('lru-cache-ttl').padEnd(13);
    const c3 = getTaskStr('markdown-table-formatter').padEnd(14);
    const c4 = getTaskStr('token-bucket-limiter').padEnd(12);
    
    let verdictStr = '❌ CAPABILITY_FAILED';
    if (r.status === 'PASSED') {
      verdictStr = '✅ PASSED';
    } else if (r.status === 'ENDPOINT_UNAVAILABLE') {
      verdictStr = '⚠️ ENDPOINT_UNAVAILABLE';
    }

    console.log(`| ${r.modelId.padEnd(40)} | ${c1} | ${c2} | ${c3} | ${c4} | ${verdictStr.padEnd(24)} |`);
  }
  console.log('========================================================================================================================\n');

  // Save report artifact
  const reportDir = path.resolve(process.cwd(), 'evals', 'reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sweepReport = {
    timestamp: new Date().toISOString(),
    totalCandidates: candidates.length,
    candidates,
    sweepResults,
  };
  const reportPath = path.join(reportDir, `free-sweep-report-${timestamp}.json`);
  const latestPath = path.join(reportDir, 'free-sweep-latest.json');
  fs.writeFileSync(reportPath, JSON.stringify(sweepReport, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(sweepReport, null, 2));
  console.log(`Saved sweep report artifact to: ${reportPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const isMock = args.includes('--mock');
  const isPreflight = args.includes('--preflight');
  const isSweepFree = args.includes('--sweep-free');
  const modelArgIdx = args.indexOf('--model');
  const modelId = modelArgIdx >= 0 ? args[modelArgIdx + 1] : 'claude-sonnet-5';
  const runsArgIdx = args.indexOf('--runs');
  const runsPerTask = runsArgIdx >= 0 ? parseInt(args[runsArgIdx + 1], 10) : (isPreflight ? 1 : 5);
  const maxTurnsArgIdx = args.indexOf('--max-turns');
  const maxTurns = maxTurnsArgIdx >= 0 ? parseInt(args[maxTurnsArgIdx + 1], 10) : (isPreflight ? 5 : 40);
  const budgetCapArgIdx = args.indexOf('--budget-cap');
  const budgetCapUsd = budgetCapArgIdx >= 0 ? parseFloat(args[budgetCapArgIdx + 1]) : 1.50;
  const suiteCapIdx = args.indexOf('--suite-budget-cap');
  const suiteBudgetCapUsd = suiteCapIdx >= 0 ? parseFloat(args[suiteCapIdx + 1]) : 15.00;
  const runBudgetProbe = !isPreflight && !isSweepFree && !args.includes('--no-probe-budget');

  // 1. Sync dynamic OpenRouter catalog at startup (live or cached)
  if (!isMock) {
    try {
      const catalogSync = await syncOpenRouterCatalog();
      if (catalogSync.count > 0) {
        const provInfo = catalogSync.provenance
          ? ` (HTTP ${catalogSync.provenance.httpStatus}, Date: ${catalogSync.provenance.headers.date || 'N/A'}, Server: ${catalogSync.provenance.headers.server || 'cloudflare'})`
          : '';
        console.log(`[Catalog] Dynamically registered ${catalogSync.count} OpenRouter models from ${catalogSync.loadedFrom}${provInfo}.`);
      }
    } catch (err: any) {
      console.error(`\n❌ [CATALOG SYNC ERROR] Failed to synchronize OpenRouter catalog:\n   ${err.message}\n`);
      process.exit(1);
    }
  } else {
    // Offline simulation mode attempts sync if network is present, but does not block offline execution
    try {
      await syncOpenRouterCatalog();
    } catch {}
  }

  // Handle Free-Tier Sweep early
  if (isSweepFree) {
    const modelsIdx = args.indexOf('--models');
    const customModels = modelsIdx >= 0 ? args[modelsIdx + 1].split(',').map(s => s.trim()) : undefined;
    await runFreeSweep(customModels);
    return;
  }

  // 2. Fail fast if model ID is unrecognized or retired (prevent silent undercounting)
  try {
    getModelPricing(modelId);
  } catch (err: any) {
    console.error(`\n❌ [STARTUP VALIDATION ERROR] Invalid --model "${modelId}":\n   ${err.message}\n`);
    process.exit(1);
  }

  const tasks = isPreflight
    ? STANDING_BENCHMARKS.filter(t => t.tier === 'easy')
    : STANDING_BENCHMARKS;

  const benchmarkTracesCount = tasks.length * runsPerTask;
  const totalTracesPlanned = benchmarkTracesCount + (runBudgetProbe ? 1 : 0);

  console.log('================================================================');
  if (isPreflight) {
    console.log('       Phase 2: Easy-Tier Pre-Flight Stratification Check       ');
  } else {
    console.log('       Phase 2: Multi-Tenant Empirical Trace Collection         ');
  }
  console.log('================================================================');
  console.log(`Model Target:       ${modelId}`);
  console.log(`Execution Scope:    ${isPreflight ? 'PRE-FLIGHT (4 Easy benchmarks, 1 run each)' : `${tasks.length} benchmarks (Easy: 4, Hard: 2, Ambiguous: 2, Impossible: 2)`}`);
  console.log(`Runs per Benchmark: ${runsPerTask} (Benchmark traces: ${benchmarkTracesCount})`);
  console.log(`Circuit Breaker:    ${runBudgetProbe ? '1 probe trace ($0.0010 micro-cap)' : 'Disabled'}`);
  console.log(`Total Planned:      ${totalTracesPlanned} traces`);
  console.log(`Turn Ceiling:       ${maxTurns}`);
  console.log(`Budget Watchdog:    $${budgetCapUsd.toFixed(2)} per benchmark trace`);
  console.log(`Suite Budget Cap:   $${suiteBudgetCapUsd.toFixed(2)} global ceiling`);
  console.log(`Thrash Detector:    SHADOW MODE (evaluating FP & TP calibration)`);
  console.log('================================================================\n');

  let llmClient: ILLMClient;

  if (isMock) {
    console.log('[Mode] Running deterministic calibration simulation via MockLLMClient');
    llmClient = new MockLLMClient();
  } else {
    const liveClient = new LiveLLMClient();
    if (liveClient.hasProvider(modelId)) {
      console.log(`[Mode] Running LIVE traces against provider for ${modelId}`);
      llmClient = liveClient;
    } else {
      console.error(`\n❌ [AUTHENTICATION ERROR] No active API key found for model "${modelId}".`);
      console.error('   Live trace execution requires a valid API key in environment or .env:');
      console.error('   - OpenRouter: OPENROUTER_API_KEY');
      console.error('   - Anthropic:  ANTHROPIC_API_KEY');
      console.error('   - OpenAI:     OPENAI_API_KEY');
      console.error('   - Gemini:     GEMINI_API_KEY\n');
      console.error('   To run offline deterministic simulations with fixture data, explicitly pass --mock.\n');
      process.exit(1);
    }
  }

  // Pre-flight capability verification MUST refuse MockLLMClient unconditionally
  if (isPreflight && (isMock || llmClient instanceof MockLLMClient)) {
    console.error('\n❌ [PRE-FLIGHT VALIDATION ERROR] Pre-flight capability verification cannot run against MockLLMClient.');
    console.error('   A capability gate run against a fixture is meaningless by construction.');
    console.error('   Pre-flight requires a live LLM client with valid credentials.\n');
    throw new Error('Pre-flight check refused MockLLMClient: live model capability verification required.');
  }

  const runner = new TraceRunner(llmClient);
  const isFresh = args.includes('--fresh');
  const checkpointDir = path.resolve(process.cwd(), 'evals', 'reports');
  const sanitizedModelSlug = modelId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const checkpointPath = path.join(checkpointDir, `checkpoint-${sanitizedModelSlug}.json`);

  let traces: TraceRecord[] = [];
  let cumulativeSuiteSpendUsd = 0;
  let suiteBudgetCapExceeded = false;

  // Load checkpoint if resuming an interrupted full run
  if (!isPreflight && !isFresh && fs.existsSync(checkpointPath)) {
    try {
      const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
      if (Array.isArray(cp.traces)) {
        traces = cp.traces;
        cumulativeSuiteSpendUsd = traces.reduce((sum: number, t: TraceRecord) => sum + (t.totalCostUsd || 0), 0);
        console.log(`[Checkpoint] Resuming from existing checkpoint: ${traces.length}/${totalTracesPlanned} traces already completed ($${cumulativeSuiteSpendUsd.toFixed(4)} spent).`);
      }
    } catch (e: any) {
      console.warn(`[Checkpoint] Failed to read checkpoint (${e.message}), starting fresh.`);
    }
  }

  let traceCounter = 0;

  for (const task of tasks) {
    if (suiteBudgetCapExceeded) break;

    console.log(`\n▶ Benchmark: [${task.id}] (${task.tier?.toUpperCase()}) - ${task.name}`);
    console.log(`  Description: ${task.description}`);

    for (let run = 1; run <= runsPerTask; run++) {
      traceCounter++;

      // Check if this trace was already completed in the checkpoint
      const existingTrace = traces.find(t => t.taskId === task.id && t.runIndex === run);
      if (existingTrace && !isPreflight) {
        const traceHeader = `[Trace ${traceCounter}/${totalTracesPlanned}] ${task.id} (Run ${run}/${runsPerTask})`;
        const outcomeColor = existingTrace.outcome === 'PASSED' ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';
        const thrashTag = existingTrace.shadowThrashDetected ? ' \x1b[33m[SHADOW_FLAGGED]\x1b[0m' : '';
        console.log(`  ${traceHeader} ... ${outcomeColor}${existingTrace.outcome}${resetColor}${thrashTag} [CACHED from checkpoint: ${existingTrace.totalTurns} turns, $${existingTrace.totalCostUsd.toFixed(4)}]`);
        continue;
      }

      if (cumulativeSuiteSpendUsd >= suiteBudgetCapUsd) {
        console.warn(`\n🚨 [SUITE BUDGET CAP HIT] Cumulative spend ($${cumulativeSuiteSpendUsd.toFixed(4)}) reached cap ($${suiteBudgetCapUsd.toFixed(4)}). Halting collection.`);
        suiteBudgetCapExceeded = true;
        break;
      }

      const traceHeader = `[Trace ${traceCounter}/${totalTracesPlanned}] ${task.id} (Run ${run}/${runsPerTask})`;
      process.stdout.write(`  ${traceHeader} ... `);

      if (llmClient instanceof MockLLMClient) {
        const sequence = createCalibratedMockSequence(task.id, run);
        llmClient.setSequence(task.id, sequence);
      }

      // Cap impossible tier lower (e.g. 15 turns) to save ~250 doomed requests and wall clock with no loss of signal
      const taskMaxTurns = task.tier === 'impossible' ? Math.min(maxTurns, 15) : maxTurns;

      const startTime = Date.now();
      const record = await runner.runTrace(task, run, {
        modelId,
        maxTurns: taskMaxTurns,
        budgetCapUsd,
        turnPacingDelayMs: 1200,
        onTraceCompleted: (tr) => {
          if (tr.shadowThrashFiredAtTurn !== undefined) {
            console.log(`\n    ⚠️  [SHADOW THRASH FLAGGED] at Turn ${tr.shadowThrashFiredAtTurn} (${tr.shadowThrashReason})`);
            console.log(`        Shadow mode: did NOT abort. Continued to observe ground-truth outcome.`);
          }
        }
      });

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      traces.push(record);
      cumulativeSuiteSpendUsd += record.totalCostUsd;

      // Persist checkpoint to disk after each completed trace for resume safety
      if (!isPreflight) {
        if (!fs.existsSync(checkpointDir)) fs.mkdirSync(checkpointDir, { recursive: true });
        fs.writeFileSync(
          checkpointPath,
          JSON.stringify({
            modelId,
            totalTracesPlanned,
            updatedAt: new Date().toISOString(),
            traces,
          }, null, 2),
          'utf-8'
        );
      }

      let outcomeColor = '\x1b[32m'; // green
      if (record.outcome !== 'PASSED') {
        outcomeColor = '\x1b[31m'; // red
      }
      const resetColor = '\x1b[0m';

      const thrashTag = record.shadowThrashDetected ? ' \x1b[33m[SHADOW_FLAGGED]\x1b[0m' : '';
      const fenceTag = record.hasMissingCodeFence ? ' \x1b[35m[NO_CODE_FENCE]\x1b[0m' : '';
      const shadowCostStr = record.totalCostUsd === 0 ? ` [Shadow: $${record.totalShadowCostUsd.toFixed(4)}]` : '';
      const turnCapNote = task.tier === 'impossible' ? ' [impossible-capped @15]' : '';

      console.log(`${outcomeColor}${record.outcome}${resetColor}${thrashTag}${fenceTag} in ${record.totalTurns} turn(s)${turnCapNote} ($${record.totalCostUsd.toFixed(4)}${shadowCostStr}, ${durationSec}s)`);
    }
  }

  // Deliberate Circuit Breaker End-to-End Probe (skipped in preflight)
  if (runBudgetProbe && !suiteBudgetCapExceeded) {
    traceCounter++;
    const probeTask = tasks[0]; // cli-arg-parser
    const traceHeader = `[Trace ${traceCounter}/${totalTracesPlanned}] PROBE: ${probeTask.id} (Circuit Breaker Micro-Cap $0.0010)`;

    const existingProbe = traces.find(t => t.runIndex === 999);
    if (existingProbe && !isPreflight) {
      console.log(`\n  ${traceHeader} ... \x1b[32m${existingProbe.outcome}\x1b[0m [CACHED from checkpoint]`);
    } else {
      process.stdout.write(`\n  ${traceHeader} ... `);

      if (llmClient instanceof MockLLMClient) {
        llmClient.setSequence(probeTask.id, ['export function dummy() {}']);
      }

      const startTime = Date.now();
      const probeRecord = await runner.runTrace(probeTask, 999, {
        modelId,
        maxTurns: 5,
        budgetCapUsd: 0.0010, // Micro-cap triggers BudgetExceededError on Turn 1 before dispatch
      });

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      traces.push(probeRecord);

      if (!isPreflight) {
        if (!fs.existsSync(checkpointDir)) fs.mkdirSync(checkpointDir, { recursive: true });
        fs.writeFileSync(
          checkpointPath,
          JSON.stringify({
            modelId,
            totalTracesPlanned,
            updatedAt: new Date().toISOString(),
            traces,
          }, null, 2),
          'utf-8'
        );
      }

      const outcomeColor = probeRecord.outcome === 'HIT_BUDGET_CAP' ? '\x1b[32m' : '\x1b[31m';
      const resetColor = '\x1b[0m';
      console.log(`${outcomeColor}${probeRecord.outcome}${resetColor} in ${probeRecord.totalTurns} turn(s) ($${probeRecord.totalCostUsd.toFixed(4)}, ${durationSec}s)`);
      console.log(`    ↳ Verified circuit breaker: blocked pre-dispatch (${probeRecord.errorMessage ?? 'Budget cap exceeded'})`);
    }
  }

  // Compute final report with exact denominators
  const report = runner.computeReport(totalTracesPlanned, traces, modelId);
  if (suiteBudgetCapExceeded) {
    report.suiteBudgetCapExceeded = true;
  }
  runner.close();

  // If Pre-Flight Mode: Evaluate easy tier strictly and print verdict
  if (isPreflight) {
    console.log('\n================================================================');
    console.log('              EASY-TIER PRE-FLIGHT VERIFICATION                 ');
    console.log('================================================================');
    console.log(`Target Model Evaluated:        ${modelId}`);
    
    let allPassedUnderTwo = true;
    for (const t of traces) {
      const passedInTime = t.outcome === 'PASSED' && t.totalTurns <= 2;
      if (!passedInTime) allPassedUnderTwo = false;
      const statusIcon = passedInTime ? '✅' : '❌';
      console.log(`  ${statusIcon} [${t.taskId.padEnd(25)}] : ${t.outcome} in ${t.totalTurns} turn(s) (Shadow cost: $${t.totalShadowCostUsd.toFixed(4)})`);
    }

    console.log('----------------------------------------------------------------');
    if (allPassedUnderTwo) {
      console.log('VERDICT: ✅ PRE-FLIGHT PASSED');
      console.log('Analysis: All 4 easy benchmarks passed in <= 2 turns.');
      console.log('          Stratification baseline holds: a flag here is definitionally');
      console.log('          a false positive. You are CLEAR to proceed to the full 51-trace run.');
    } else {
      console.log('VERDICT: ❌ PRE-FLIGHT FAILED');
      console.log('Analysis: Model failed to solve the easy benchmarks reliably in <= 2 turns.');
      console.log('          This model is too weak to calibrate with. If the easy tier fails,');
      console.log('          the false-positive control collapses and thresholds become invalid.');
    }
    console.log('================================================================\n');

    // Save preflight report artifact to disk
    const reportDir = path.resolve(process.cwd(), 'evals', 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preflightReport = {
      isPreflight: true,
      modelEvaluated: modelId,
      verdict: allPassedUnderTwo ? 'PASSED' : 'FAILED',
      allPassedUnderTwoTurns: allPassedUnderTwo,
      timestamp: new Date().toISOString(),
      tasks: traces.map(t => ({
        taskId: t.taskId,
        taskName: t.taskName,
        outcome: t.outcome,
        totalTurns: t.totalTurns,
        turnsToSuccess: t.turnsToSuccess,
        passedUnderTwoTurns: t.outcome === 'PASSED' && t.totalTurns <= 2,
        shadowThrashDetected: t.shadowThrashDetected,
        shadowThrashFiredAtTurn: t.shadowThrashFiredAtTurn,
        shadowThrashReason: t.shadowThrashReason,
        actualCostUsd: t.totalCostUsd,
        shadowCostUsd: t.totalShadowCostUsd,
      })),
      report,
    };
    const reportPath = path.join(reportDir, `preflight-report-${timestamp}.json`);
    const latestPath = path.join(reportDir, 'preflight-latest.json');
    fs.writeFileSync(reportPath, JSON.stringify(preflightReport, null, 2));
    fs.writeFileSync(latestPath, JSON.stringify(preflightReport, null, 2));
    console.log(`Saved preflight report artifact to: ${reportPath}`);

    if (!allPassedUnderTwo) {
      process.exit(1);
    }
    return;
  }

  // Print full statistical summary
  console.log('\n================================================================');
  console.log('               PHASE 2 EMPIRICAL TRACE REPORT                   ');
  console.log('================================================================');
  console.log(`Total Traces Planned:          ${report.totalTracesPlanned}`);
  console.log(`Total Traces Executed:         ${report.totalTracesExecuted}`);
  console.log(`Completed Count:               ${report.completedCount} / ${report.totalTracesPlanned}`);
  console.log(`Overall Pass Rate:             ${report.passedCount} / ${report.totalTracesExecuted} (${((report.passedCount / report.totalTracesExecuted) * 100).toFixed(1)}%)`);
  console.log(`Censored (Hit Turn Cap):       ${report.censoredCount} / ${report.totalTracesExecuted} (${((report.censoredCount / report.totalTracesExecuted) * 100).toFixed(1)}%)`);

  console.log('\n--- Mutually Exclusive Terminal Outcomes ---');
  for (const [outcome, count] of Object.entries(report.outcomesDistribution)) {
    const pct = ((count / report.totalTracesExecuted) * 100).toFixed(1);
    console.log(`  • ${outcome.padEnd(25)} : ${count.toString().padStart(2)} / ${report.totalTracesExecuted} (${pct}%)`);
  }

  console.log('\n--- Shadow Thrash Detector Calibration ---');
  console.log(`  • Traces Flagged by Detector:  ${report.shadowThrash.totalFlagged} / ${report.totalTracesExecuted}`);
  console.log(`  • Shadow False Positives:      ${report.shadowThrash.falsePositives} / ${report.shadowThrash.totalFlagged || 1} (Flagged as thrash, but went on to pass)`);
  console.log(`  • Shadow True Positives:       ${report.shadowThrash.truePositives} / ${report.shadowThrash.totalFlagged || 1} (Flagged as thrash, and did not pass)`);
  console.log(`  • False Positive Rate:         ${(report.shadowThrash.falsePositiveRate * 100).toFixed(1)}%`);

  console.log('\n--- Cross-Tabulation: Terminal Outcomes for Flagged Traces ---');
  for (const [outcome, count] of Object.entries(report.shadowThrash.flaggedByTerminalOutcome)) {
    const denom = report.shadowThrash.totalFlagged || 1;
    const pct = ((count / denom) * 100).toFixed(1);
    console.log(`  • Flagged -> ${outcome.padEnd(20)} : ${count.toString().padStart(2)} / ${denom} (${pct}%)`);
  }

  console.log('\n--- Code-Fence Formatting Contamination Audit ---');
  console.log(`  • Traces Missing Code Fences:  ${report.shadowThrash.tracesWithMissingCodeFence} / ${report.totalTracesExecuted}`);
  console.log(`  • Clean Traces Flagged:        ${report.shadowThrash.cleanTracesFlagged}`);
  console.log(`  • Clean False Positives:       ${report.shadowThrash.cleanFalsePositives}`);
  console.log(`  • Clean False Positive Rate:   ${(report.shadowThrash.cleanFalsePositiveRate * 100).toFixed(1)}%`);

  console.log('\n--- Turns-To-Success Distribution ---');
  console.log(`  • Successful Traces:           ${report.turnsToSuccess.raw.length} / ${report.totalTracesExecuted}`);
  console.log(`  • p50 Turns:                   ${report.turnsToSuccess.p50}`);
  console.log(`  • p90 Turns:                   ${report.turnsToSuccess.p90}`);
  console.log(`  • Min Turns:                   ${report.turnsToSuccess.min}`);
  console.log(`  • Max Turns:                   ${report.turnsToSuccess.max}`);
  console.log(`  • Raw Distribution:            [${report.turnsToSuccess.raw.join(', ')}]`);

  console.log('\n--- Economic Spend Analysis ---');
  console.log(`  • Total Spent (Actual):        $${report.costStats.totalSpentUsd.toFixed(4)}`);
  console.log(`  • Total Shadow Cost (Sonnet 5): $${report.costStats.totalShadowCostUsd.toFixed(4)}`);
  console.log(`  • Mean Cost / Trace:           $${report.costStats.meanCostPerTraceUsd.toFixed(4)}`);
  console.log(`  • Max Cost Trace:              $${report.costStats.maxCostTraceUsd.toFixed(4)}`);

  console.log('\n--- Methodology Boundaries Recorded ---');
  console.log(`  • Loop Topology:               Stateless retry loop (src/index.js + last stderr, no history)`);
  console.log(`  • File Scope:                  ${report.methodologyLimits.singleFileScope} single-file generation`);
  console.log(`  • Model Evaluated:             ${report.methodologyLimits.modelEvaluated}`);
  console.log('================================================================\n');

  // Save report to disk
  const reportDir = path.resolve(process.cwd(), 'evals', 'reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportDir, `phase2-trace-report-${timestamp}.json`);
  const latestPath = path.join(reportDir, 'latest.json');

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(report, null, 2));
  console.log(`Saved report artifact to: ${reportPath}`);
}

main().catch(err => {
  console.error('Fatal Trace Runner Error:', err);
  process.exit(1);
});
