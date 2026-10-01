/**
 * Phase 2 Trace Harness Verification Suite
 * Tests TraceRunner mechanics, shadow thrash evaluation, pre-dispatch budget watchdog,
 * categorical outcomes, and statistical reporting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TraceRunner } from '../src/evals/trace-runner.js';
import {
  MockLLMClient,
  syncOpenRouterCatalog,
  validateOpenRouterCatalogShape,
  type ILLMClient,
  type LLMRequest,
  type LLMResponse,
} from '../src/evals/llm-client.js';
import { STANDING_BENCHMARKS } from '../src/kernel/standing-tenant.js';

test('TraceRunner: executes turns, tracks shadow thrash, and captures false-positives', async () => {
  const cliTask = STANDING_BENCHMARKS.find(b => b.id === 'cli-arg-parser')!;
  assert.ok(cliTask);

  // Script sequence:
  // Turn 1: Syntax error
  // Turn 2: Runtime error (missing export)
  // Turn 3: Runtime error (missing export -> 2nd time)
  // Turn 4: Runtime error (missing export -> 3rd time: shadow thrash trips!)
  // Turn 5: Clean working implementation (passes tests!)
  const workingCode = `
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
`;

  const mockClient = new MockLLMClient({
    'cli-arg-parser': [
      'export function bad() {}', // Turn 1: missing parseArgs
      'export function bad() {}', // Turn 2: missing parseArgs
      'export function bad() {}', // Turn 3: missing parseArgs
      'export function bad() {}', // Turn 4: missing parseArgs (thrash detected!)
      workingCode,                // Turn 5: working implementation
    ]
  });

  const runner = new TraceRunner(mockClient);

  try {
    const trace = await runner.runTrace(cliTask, 1, {
      maxTurns: 10,
      budgetCapUsd: 1.00,
    });

    // Verify that shadow mode did NOT abort on Turn 4
    assert.equal(trace.totalTurns, 5);
    assert.equal(trace.turnsToSuccess, 5);
    // Shadow thrash must have fired at turn 4
    assert.ok(trace.shadowThrashFiredAtTurn !== undefined);
    assert.equal(trace.shadowThrashDetected, true);
    // Pure terminal outcome is PASSED
    assert.equal(trace.outcome, 'PASSED');
    assert.ok(trace.totalCostUsd > 0);

    // Verify statistical report
    const report = runner.computeReport(1, [trace]);
    assert.equal(report.totalTracesExecuted, 1);
    assert.equal(report.passedCount, 1);
    assert.equal(report.censoredCount, 0);
    assert.equal(report.outcomesDistribution.PASSED, 1);
    assert.equal(report.shadowThrash.totalFlagged, 1);
    assert.equal(report.shadowThrash.falsePositives, 1);
    assert.equal(report.shadowThrash.truePositives, 0);
    assert.equal(report.shadowThrash.falsePositiveRate, 1.0);
    assert.equal(report.shadowThrash.flaggedByTerminalOutcome.PASSED, 1);
    assert.equal(report.turnsToSuccess.p50, 5);
    assert.equal(report.turnsToSuccess.p90, 5);
  } finally {
    runner.close();
  }
});

test('TraceRunner: budget watchdog triggers HIT_BUDGET_CAP before turn dispatch', async () => {
  const cliTask = STANDING_BENCHMARKS.find(b => b.id === 'cli-arg-parser')!;

  const mockClient = new MockLLMClient({
    'cli-arg-parser': ['export function bad() {}']
  });

  const runner = new TraceRunner(mockClient);

  try {
    // Set an impossibly small budget cap ($0.0001) so turn 1 triggers budget cap
    const trace = await runner.runTrace(cliTask, 1, {
      budgetCapUsd: 0.00001,
    });

    assert.equal(trace.outcome, 'HIT_BUDGET_CAP');
    assert.equal(trace.totalTurns, 0);
  } finally {
    runner.close();
  }
});

test('Negative Control: TraceRunner.runPreflight refuses MockLLMClient unconditionally', async () => {
  const mockClient = new MockLLMClient();
  const runner = new TraceRunner(mockClient);

  try {
    await assert.rejects(
      async () => runner.runPreflight('claude-haiku-4-5'),
      /Pre-flight capability check refused MockLLMClient: live model capability verification required/
    );
  } finally {
    runner.close();
  }
});

test('Negative Control: TraceRunner.runPreflight rejects weak model with PRE-FLIGHT FAILED verdict', async () => {
  class WeakStubClient implements ILLMClient {
    async generateCode(_req: LLMRequest): Promise<LLMResponse> {
      return {
        content: '```javascript\nexport function failingStub() { throw new Error("not implemented"); }\n```',
        inputTokens: 100,
        outputTokens: 50,
        attemptCount: 1,
      };
    }
  }

  const weakClient = new WeakStubClient();
  const runner = new TraceRunner(weakClient);

  try {
    // Run preflight with maxTurns: 1 on easy benchmarks
    const result = await runner.runPreflight('claude-haiku-4-5', { maxTurns: 1 });

    assert.equal(result.passed, false);
    assert.equal(result.allPassedUnderTwoTurns, false);
    assert.ok(result.verdict.includes('PRE-FLIGHT FAILED'));
    assert.equal(result.traces.length, 4);
    assert.ok(result.traces.every(t => t.outcome !== 'PASSED'));
  } finally {
    runner.close();
  }
});

test('Negative Control: validateOpenRouterCatalogShape rejects synthetic or malformed catalog schemas', () => {
  // 1. Missing data array
  assert.throws(
    () => validateOpenRouterCatalogShape({}),
    /OpenRouter catalog response must contain a "data" array/
  );

  // 2. Missing id
  assert.throws(
    () => validateOpenRouterCatalogShape({
      data: [{ pricing: { prompt: '0.0001', completion: '0.0002' } }]
    }),
    /missing or non-string "id"/
  );

  // 3. Numeric pricing instead of string (tell of synthetic fake entries)
  assert.throws(
    () => validateOpenRouterCatalogShape({
      data: [{ id: 'synthetic/model', pricing: { prompt: 0.0000001, completion: 0.0000002 } }]
    }),
    /pricing\.prompt must be a string/
  );

  // 4. Missing pricing object
  assert.throws(
    () => validateOpenRouterCatalogShape({
      data: [{ id: 'synthetic/model' }]
    }),
    /missing "pricing" object/
  );

  // 5. Genuine OpenRouter schema passes
  const valid = validateOpenRouterCatalogShape({
    data: [{
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      pricing: { prompt: '0', completion: '0' }
    }]
  });
  assert.equal(valid.length, 1);
  assert.equal(valid[0].id, 'meta-llama/llama-3.3-70b-instruct:free');
});

test('Negative Control: syncOpenRouterCatalog refuses and unlinks cache lacking genuine HTTP provenance', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cacheDir = path.resolve(process.cwd(), 'evals', 'cache');
  const cachePath = path.join(cacheDir, 'openrouter-models.json');

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Write a fabricated cache without HTTP provenance
  const fabricated = {
    data: [{
      id: 'fake/fabricated-model',
      pricing: { prompt: '0', completion: '0' }
    }]
  };
  fs.writeFileSync(cachePath, JSON.stringify(fabricated, null, 2), 'utf-8');

  // Calling syncOpenRouterCatalog must reject the unverified cache and perform a live fetch
  const syncResult = await syncOpenRouterCatalog();
  assert.equal(syncResult.loadedFrom, 'network');
  assert.ok(syncResult.provenance !== undefined);
  assert.equal(syncResult.provenance.httpStatus, 200);
  assert.ok(syncResult.provenance.headers.date.length > 0);

  // The newly written cache must now carry genuine provenance
  const reloaded = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  assert.equal(reloaded.provenance.httpStatus, 200);
  assert.equal(reloaded.provenance.sourceUrl, 'https://openrouter.ai/api/v1/models');
});
