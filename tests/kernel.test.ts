/**
 * Comprehensive Phase 1 Kernel Verification Suite
 * Tests Cost Ledger (reservations, WAL persistence, dispatched vs undispatched sweeps, budget watchdog),
 * Thrash Detector (fingerprinting & stagnation),
 * Benchmark Definitions,
 * Hardened Dependency Builder (npm with postinstall, pip with --target),
 * Docker Sandbox Lifecycle, and Host Path Traversal Protection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  CostLedger,
  BudgetExceededError,
  isBudgetExceededError,
  RateLimitExceededError,
  isRateLimitExceededError,
  getModelPricing,
  registerModelPricing,
  registerManyModelPricing,
  clearDynamicPricing,
  getRegisteredModels,
} from '../src/kernel/cost-ledger.js';
import { ThrashDetector } from '../src/kernel/thrash-detector.js';
import { STANDING_BENCHMARKS } from '../src/kernel/standing-tenant.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';

test('CostLedger: on-disk WAL persistence, pre-dispatch reservation, reconcile, and crash sweeps', () => {
  const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-ledger-test-'));
  const dbPath = path.join(tmpDbDir, 'ledger.sqlite');

  try {
    const ledger = new CostLedger(dbPath);

    // 1. Reserve $ before dispatch
    const res = ledger.reserve('task-1', 'agent-alpha', 'claude-sonnet-5', 20000, 10);
    assert.equal(res.status, 'PENDING');
    assert.equal(res.dispatchedAt, null);
    assert.ok(res.estimatedCostUsd > 0);

    // Active spend reflects pending reservation
    const initialSpend = ledger.getAgentSpend('agent-alpha');
    assert.ok(initialSpend.totalUsd > 0);
    assert.equal(initialSpend.pendingReservationsUsd, res.estimatedCostUsd);

    // 2. Mark dispatched immediately before API call
    ledger.markDispatched(res.id);

    // 3. Reconcile with actual token usage
    const rec = ledger.reconcile(res.id, 5000, 2000);
    assert.ok(rec.actualCostUsd > 0);

    const postSpend = ledger.getAgentSpend('agent-alpha');
    assert.equal(postSpend.pendingReservationsUsd, 0);
    assert.equal(postSpend.totalUsd, rec.actualCostUsd);

    // 4. Stale reservation sweep: Case A - crash BEFORE dispatch (never sent to provider)
    const crashedUndispatched = ledger.reserve('task-crash-1', 'agent-alpha', 'claude-sonnet-5', 20000, -10); // already expired

    // 5. Stale reservation sweep: Case B - crash AFTER dispatch (sent to provider, provider charged us)
    const crashedDispatched = ledger.reserve('task-crash-2', 'agent-alpha', 'claude-sonnet-5', 20000, -10); // already expired
    ledger.markDispatched(crashedDispatched.id);

    // Run sweep
    const sweep = ledger.sweepStaleReservations();
    assert.equal(sweep.expiredUndispatchedCount, 1);
    assert.ok(sweep.reclaimedUsd > 0);
    assert.equal(sweep.assumedSpentCount, 1);
    assert.ok(sweep.assumedSpentUsd > 0);

    // Total spend: includes reconciled actuals + assumed spent from crashed dispatched reservation.
    const finalSpend = ledger.getAgentSpend('agent-alpha');
    assert.equal(finalSpend.pendingReservationsUsd, 0);
    assert.equal(finalSpend.assumedSpentUsd, crashedDispatched.estimatedCostUsd);
    assert.equal(finalSpend.totalUsd, rec.actualCostUsd + crashedDispatched.estimatedCostUsd);

    ledger.close();
  } finally {
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  }
});

test('CostLedger: pre-dispatch budget watchdog blocks over-budget tasks', () => {
  const ledger = new CostLedger(':memory:');

  const budgetCap = 0.10;

  // 1. Initial check: allowed
  const check1 = ledger.checkBudget('agent-strict', budgetCap, 5000, 'claude-haiku-4-5');
  assert.equal(check1.allowed, true);

  // 2. Reserve with budget check
  const res = ledger.reserveWithBudgetCheck('task-b1', 'agent-strict', 'claude-haiku-4-5', budgetCap, 10000);
  assert.equal(res.status, 'PENDING');

  // 3. Try to reserve another turn with large model (claude-opus-5) that exceeds remaining budget
  assert.throws(
    () => ledger.reserveWithBudgetCheck('task-b2', 'agent-strict', 'claude-opus-5', budgetCap, 50000),
    (err: unknown) => {
      assert.ok(isBudgetExceededError(err));
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.code, 'BUDGET_EXCEEDED');
      return true;
    }
  );

  ledger.close();
});

test('CostLedger: getModelPricing validates model registry and throws loudly on unknown/retired models', () => {
  // Valid registered models must return rates
  const sonnetRate = getModelPricing('claude-sonnet-5');
  assert.equal(sonnetRate.inputPerMillion, 3.00);
  assert.equal(sonnetRate.outputPerMillion, 15.00);

  const haikuRate = getModelPricing('claude-haiku-4-5');
  assert.equal(haikuRate.inputPerMillion, 0.80);
  assert.equal(haikuRate.outputPerMillion, 4.00);

  const opusRate = getModelPricing('claude-opus-5');
  assert.equal(opusRate.inputPerMillion, 15.00);

  const fableRate = getModelPricing('claude-fable-5-1');
  assert.equal(fableRate.inputPerMillion, 3.00);

  // Retired or unknown models must throw immediately - never silently fall back to Haiku rates
  assert.throws(() => getModelPricing('claude-3-5-sonnet'), /Unknown modelId "claude-3-5-sonnet"/);
  assert.throws(() => getModelPricing('claude-3-5-haiku'), /Unknown modelId "claude-3-5-haiku"/);
  assert.throws(() => getModelPricing('unknown-random-model'), /Unknown modelId "unknown-random-model"/);
});

test('CostLedger: dynamic model pricing registration and shadow cost tracking', () => {
  clearDynamicPricing();

  // 1. Dynamic registration of OpenRouter free and paid models
  registerModelPricing('meta-llama/llama-3.3-70b-instruct:free', { inputPerMillion: 0, outputPerMillion: 0 });
  registerModelPricing('anthropic/claude-3.5-sonnet:beta', { inputPerMillion: 3.5, outputPerMillion: 16.0 });

  const freeRate = getModelPricing('meta-llama/llama-3.3-70b-instruct:free');
  assert.equal(freeRate.inputPerMillion, 0);
  assert.equal(freeRate.outputPerMillion, 0);

  const registered = getRegisteredModels();
  assert.ok(registered.includes('meta-llama/llama-3.3-70b-instruct:free'));
  assert.ok(registered.includes('claude-sonnet-5'));

  // 2. Ledger reservation and reconciliation with shadow cost computation
  const ledger = new CostLedger(':memory:');
  const res = ledger.reserve('task-shadow', 'agent-shadow', 'meta-llama/llama-3.3-70b-instruct:free', 10000);
  assert.equal(res.estimatedCostUsd, 0);

  ledger.markDispatched(res.id);
  // Reconcile: 2,000 input tokens, 1,000 output tokens
  // Actual cost: $0.00
  // Shadow cost under Sonnet 5 ($3.00/M in, $15.00/M out):
  // (2000 * 3.0)/1M + (1000 * 15.0)/1M = 0.006 + 0.015 = $0.0210
  const reconciled = ledger.reconcile(res.id, 2000, 1000);
  assert.equal(reconciled.actualCostUsd, 0);
  assert.ok(Math.abs(reconciled.shadowCostUsd - 0.021) < 0.0001);

  const spend = ledger.getAgentSpend('agent-shadow');
  assert.equal(spend.totalUsd, 0);
  assert.ok(Math.abs(spend.totalShadowUsd - 0.021) < 0.0001);

  ledger.close();
  clearDynamicPricing();
});

test('CostLedger: RateLimitExceededError discrimination', () => {
  const err = new RateLimitExceededError('429 Too Many Requests', { status: 429, attempts: 4 });
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(err.status, 429);
  assert.equal(err.attempts, 4);
  assert.equal(isRateLimitExceededError(err), true);

  const otherErr = new Error('Random error');
  assert.equal(isRateLimitExceededError(otherErr), false);
});

test('ThrashDetector: normalized error fingerprinting and loop detection', () => {
  const detector = new ThrashDetector(3, 3);

  const err1 = 'Error: Cannot find module at index.js:42:15 timestamp 2026-09-04 14:00:00';
  const err2 = 'Error: Cannot find module at index.js:99:20 timestamp 2026-09-04 14:00:05';
  
  const fp1 = detector.normalizeError(err1);
  const fp2 = detector.normalizeError(err2);
  assert.ok(fp1 !== null);
  assert.equal(fp1, fp2, 'Different line numbers and timestamps must produce identical error fingerprint');

  // Feed 3 consecutive turns with identical error
  const state1 = detector.recordTurn(1, err1, { 'index.js': 'content v1' });
  assert.equal(state1.isThrashing, false);

  const state2 = detector.recordTurn(2, err2, { 'index.js': 'content v2' });
  assert.equal(state2.isThrashing, false);

  const state3 = detector.recordTurn(3, err1, { 'index.js': 'content v3' });
  assert.equal(state3.isThrashing, true);
  assert.ok(state3.reason?.includes('Repeated identical error fingerprint'));
});

test('ThrashDetector: workspace diff stagnation detection', () => {
  const detector = new ThrashDetector(3, 3);

  const files = { 'index.js': 'console.log("hello");' };

  detector.recordTurn(1, '', files);
  detector.recordTurn(2, '', files);
  const state = detector.recordTurn(3, '', files);
  const state4 = detector.recordTurn(4, '', files);

  assert.equal(state4.isThrashing, true);
  assert.ok(state4.reason?.includes('stagnation'));
});

test('StandingBenchmarks: integrity of stratified benchmark suite (10 benchmarks across 4 tiers)', () => {
  assert.equal(STANDING_BENCHMARKS.length, 10);

  const tiers = new Set(STANDING_BENCHMARKS.map(b => b.tier));
  assert.deepEqual(Array.from(tiers).sort(), ['ambiguous', 'easy', 'hard', 'impossible']);

  const countsByTier: Record<string, number> = {};
  for (const bench of STANDING_BENCHMARKS) {
    countsByTier[bench.tier ?? 'unknown'] = (countsByTier[bench.tier ?? 'unknown'] || 0) + 1;
    assert.ok(bench.id.length > 0);
    assert.ok(bench.requirements.length >= 2);
    assert.ok(bench.initialFiles['package.json']);
    assert.ok(bench.testCommand.length > 0);
    assert.ok(bench.budgetCapUsd > 0);
    assert.ok(bench.maxTurns > 0);
  }

  assert.equal(countsByTier['easy'], 4);
  assert.equal(countsByTier['hard'], 2);
  assert.equal(countsByTier['ambiguous'], 2);
  assert.equal(countsByTier['impossible'], 2);
});

test('DockerSandbox: path traversal rejection guards the host', async () => {
  const sandbox = new DockerSandbox();
  const taskId = `sec-traversal-${Date.now()}`;
  const volumeName = await sandbox.createWorkspaceVolume(taskId);

  try {
    // Attempt relative directory traversal
    await assert.rejects(
      async () => sandbox.stageWorkspaceFiles(volumeName, { '../../../../evil.txt': 'exploit' }),
      /Path escapes staging directory/
    );

    // Attempt absolute path escape
    await assert.rejects(
      async () => sandbox.stageWorkspaceFiles(volumeName, { 'C:\\evil.txt': 'exploit' }),
      /Path escapes staging directory/
    );
  } finally {
    await sandbox.destroyWorkspaceVolume(volumeName);
  }
});

test('DockerSandbox: installDependencies installs npm package and runs postinstall under hardened builder', async () => {
  const sandbox = new DockerSandbox();
  const taskId = `dep-npm-${Date.now()}`;
  const volumeName = await sandbox.createWorkspaceVolume(taskId);

  try {
    // Stage a package.json with a real package ('is-number') and an explicit postinstall script
    await sandbox.stageWorkspaceFiles(volumeName, {
      'package.json': JSON.stringify({
        name: 'test-pkg',
        version: '1.0.0',
        dependencies: {
          'is-number': '^7.0.0'
        },
        scripts: {
          postinstall: 'node -e "import(\'node:fs\').then(fs => fs.writeFileSync(\'postinstall.txt\', \'POSTINSTALL_RAN\'))"'
        }
      }, null, 2)
    });

    const installRes = await sandbox.installDependencies(volumeName, 'npm');
    assert.equal(installRes.exitCode, 0, `npm install failed: ${installRes.stderr}`);
    assert.equal(installRes.timedOut, false);

    // Verify in execution container: node_modules exists AND postinstall script was executed
    const verifyRes = await sandbox.executeTask(volumeName, 'node -e "import(\'node:fs\').then(fs => { if (fs.existsSync(\'node_modules/is-number\') && fs.readFileSync(\'postinstall.txt\', \'utf8\').includes(\'POSTINSTALL_RAN\')) process.exit(0); else process.exit(1); })"');
    assert.equal(verifyRes.exitCode, 0, `Verification failed. stdout: ${verifyRes.stdout}, stderr: ${verifyRes.stderr}`);
  } finally {
    await sandbox.destroyWorkspaceVolume(volumeName);
  }
});

test('DockerSandbox: installDependencies installs pip package to /workspace/site-packages under hardened builder', async () => {
  const sandbox = new DockerSandbox();
  const taskId = `dep-pip-${Date.now()}`;
  const volumeName = await sandbox.createWorkspaceVolume(taskId);

  try {
    await sandbox.stageWorkspaceFiles(volumeName, {
      'requirements.txt': 'six==1.17.0\n'
    });

    const installRes = await sandbox.installDependencies(volumeName, 'pip');
    assert.equal(installRes.exitCode, 0, `pip install failed: ${installRes.stderr}`);
    assert.equal(installRes.timedOut, false);

    // Verify in python execution container: six is importable via PYTHONPATH=/workspace/site-packages
    const verifyRes = await sandbox.executeTask(volumeName, 'python3 -c "import six; print(\'VERIFIED_SIX:\', six.__version__)"', {
      runtime: 'python'
    });
    assert.equal(verifyRes.exitCode, 0, `Python verification failed: ${verifyRes.stderr}`);
    assert.ok(verifyRes.stdout.includes('VERIFIED_SIX: 1.17.0'));
  } finally {
    await sandbox.destroyWorkspaceVolume(volumeName);
  }
});

test('DockerSandbox: execution, volume lifecycle, and artifact extraction', async () => {
  const sandbox = new DockerSandbox();
  const taskId = `test-${Date.now()}`;

  // 1. Sweep exited orphans (forceAll: false should never prune active/unattached volumes)
  const sweep = await sandbox.orphanSweep({ forceAll: false });
  assert.ok(typeof sweep.reapedContainers === 'number');
  assert.equal(sweep.reapedVolumes, 0, 'Periodic sweep must not prune volumes');

  // 2. Create task volume
  const volumeName = await sandbox.createWorkspaceVolume(taskId);
  assert.ok(volumeName.startsWith('task-vol-'));

  try {
    // 3. Stage valid files
    await sandbox.stageWorkspaceFiles(volumeName, {
      'index.js': 'export function add(a, b) { return a + b; }',
      'test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './index.js';

test('adds numbers correctly in hardened container', () => {
  assert.equal(add(2, 3), 5);
});
`
    });

    // 4. Execute test in hardened container (--network none, --read-only, --cap-drop ALL, HOME=/workspace)
    const execRes = await sandbox.executeTask(volumeName, 'node --test test.js');
    assert.equal(execRes.exitCode, 0, `Execution failed with stderr: ${execRes.stderr}`);
    assert.ok(execRes.stdout.includes('adds numbers correctly') || execRes.stdout.includes('tests 1'));

    // 5. Write an artifact inside container and extract to host
    await sandbox.executeTask(volumeName, 'node -e "import(\'node:fs\').then(fs => fs.writeFileSync(\'output.json\', JSON.stringify({ status: \'verified\' })))"');
    
    const hostDest = path.join(os.tmpdir(), `extracted_output_${Date.now()}.json`);
    try {
      const extracted = await sandbox.extractArtifact(volumeName, 'output.json', hostDest);
      assert.equal(extracted, true);

      // Verify file content on host
      const content = JSON.parse(fs.readFileSync(hostDest, 'utf-8'));
      assert.equal(content.status, 'verified');
    } finally {
      if (fs.existsSync(hostDest)) {
        fs.unlinkSync(hostDest);
      }
    }

    // 6. Operator read path: list and read the live workspace in memory, with no
    // host filesystem write (which is why this exists alongside extractArtifact).
    assert.equal(await sandbox.workspaceVolumeExists(volumeName), true);

    const files = await sandbox.listWorkspaceFiles(volumeName);
    assert.ok(files.includes('index.js'), `expected index.js in ${files.join(', ')}`);
    assert.ok(files.includes('test.js'));
    assert.ok(!files.some(f => f.startsWith('/')), 'paths must be relative to /workspace');

    const read = await sandbox.readWorkspaceFile(volumeName, 'index.js');
    assert.equal(read.truncated, false);
    assert.ok(read.content.includes('export function add'));

    // The cap is enforced inside the container, and the flag says so plainly
    // rather than handing back a silently clipped file.
    const clipped = await sandbox.readWorkspaceFile(volumeName, 'index.js', 10);
    assert.equal(clipped.truncated, true);
    assert.equal(clipped.content.length, 10);

    await assert.rejects(
      async () => sandbox.readWorkspaceFile(volumeName, 'does-not-exist.js'),
      /Failed to read/
    );
  } finally {
    // 7. Destroy task volume cleanly
    await sandbox.destroyWorkspaceVolume(volumeName);
  }

  // A reaped volume must report gone, not empty: the read API turns this into
  // "the workspace was reaped", which an empty file list could never say.
  assert.equal(await sandbox.workspaceVolumeExists(volumeName), false);
});
