/**
 * CONCERNS #1: the goal producer could generate permanently unpassable tasks.
 *
 * The classifier tests are pure. The end-to-end ones stage real files in a real
 * container, because the whole point is that the test command is actually RUN
 * rather than inspected.
 *
 * The unloadable fixture is the exact import the producer emitted in the live
 * run that motivated this - not an invented example.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPreflight, runPreflight } from '../src/daemon/proposal-preflight.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { GoalDecompositionWorkProducer } from '../src/daemon/goal-producer.js';

const DOCKER_TIMEOUT = 420_000;

const PKG = JSON.stringify({ name: 'preflight-fixture', type: 'module' });

/** The real defect: node:test exports no `assert`. */
const UNLOADABLE = {
  name: 'clamp-number',
  testCommand: 'node --test test.js',
  files: {
    'package.json': PKG,
    'test.js': [
      "import { describe, it, assert } from 'node:test';",
      "import { clamp } from './src/index.js';",
      "describe('clamp', () => { it('clamps', () => { assert.equal(clamp(5, 0, 3), 3); }); });",
    ].join('\n'),
    'src/index.js': 'export function clamp() {}',
  },
};

const USABLE = {
  name: 'clamp-number',
  testCommand: 'node --test test.js',
  files: {
    'package.json': PKG,
    'test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { clamp } from './src/index.js';",
      "test('clamps', () => { assert.equal(clamp(5, 0, 3), 3); });",
    ].join('\n'),
    'src/index.js': 'export function clamp() { return 0; }',
  },
};

const ALREADY_PASSING = {
  ...USABLE,
  files: {
    ...USABLE.files,
    'src/index.js': 'export function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }',
  },
};

describe('classifyPreflight (pure)', () => {
  it('calls a broken import UNLOADABLE even though node reports it as a failing test', () => {
    // The trap: `node --test` runs each file in a subprocess and reports a file
    // that fails to LOAD as one failing test. Counting tests cannot tell this
    // apart from a genuine assertion failure, which is why the classifier keys
    // on load-error signatures instead.
    const res = classifyPreflight({
      exitCode: 1,
      stdout: 'tests 1\npass 0\nfail 1\n',
      stderr: "SyntaxError: The requested module 'node:test' does not provide an export named 'assert'",
    });
    assert.equal(res.verdict, 'UNLOADABLE');
    assert.match(res.reason, /no agent could ever pass it/);
  });

  it('calls a genuine assertion failure USABLE', () => {
    const res = classifyPreflight({
      exitCode: 1,
      stdout: 'tests 1\npass 0\nfail 1\nAssertionError: 0 !== 3',
      stderr: '',
    });
    assert.equal(res.verdict, 'USABLE');
  });

  it('calls a passing test ALREADY_PASSING, because there is nothing to do', () => {
    const res = classifyPreflight({ exitCode: 0, stdout: 'tests 1\npass 1\nfail 0', stderr: '' });
    assert.equal(res.verdict, 'ALREADY_PASSING');
    assert.match(res.reason, /free win/);
  });

  it('calls a timeout INCONCLUSIVE rather than guessing', () => {
    const res = classifyPreflight({ exitCode: 124, stdout: '', stderr: '', timedOut: true });
    assert.equal(res.verdict, 'INCONCLUSIVE');
  });

  it('catches every load-failure shape the producer can realistically emit', () => {
    const shapes = [
      "SyntaxError: Unexpected token '}'",
      'Error [ERR_MODULE_NOT_FOUND]: Cannot find module /workspace/src/index.js',
      "SyntaxError: The requested module 'node:assert' does not provide an export named 'equals'",
      'Error [ERR_REQUIRE_ESM]: require() of ES Module not supported',
      "Cannot find package 'lodash' imported from /workspace/test.js",
    ];
    for (const stderr of shapes) {
      assert.equal(
        classifyPreflight({ exitCode: 1, stdout: '', stderr }).verdict,
        'UNLOADABLE',
        `should reject: ${stderr}`
      );
    }
  });

  it('NEGATIVE CONTROL: a plain failing assertion is NOT mistaken for a load failure', () => {
    // Without this, a classifier that rejected everything would pass the tests
    // above while silently blocking every valid proposal.
    const res = classifyPreflight({
      exitCode: 1,
      stdout: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n0 !== 3',
      stderr: '',
    });
    assert.equal(res.verdict, 'USABLE');
  });
});

describe('runPreflight against a real container', () => {
  it('rejects the exact broken import the producer emitted live', { timeout: DOCKER_TIMEOUT }, async () => {
    const res = await runPreflight(new DockerSandbox(), UNLOADABLE as any, { timeoutMs: 90_000 });
    assert.equal(res.verdict, 'UNLOADABLE', `got ${res.verdict}: ${res.reason} | ${res.output}`);
  });

  it('accepts a proposal whose test loads and fails on an assertion', { timeout: DOCKER_TIMEOUT }, async () => {
    // The control that gives the rejection above its meaning: a good proposal
    // must still be accepted, and a fresh task SHOULD start red.
    const res = await runPreflight(new DockerSandbox(), USABLE as any, { timeoutMs: 90_000 });
    assert.equal(res.verdict, 'USABLE', `got ${res.verdict}: ${res.reason} | ${res.output}`);
  });

  it('rejects a proposal that already passes', { timeout: DOCKER_TIMEOUT }, async () => {
    const res = await runPreflight(new DockerSandbox(), ALREADY_PASSING as any, { timeoutMs: 90_000 });
    assert.equal(res.verdict, 'ALREADY_PASSING', `got ${res.verdict}: ${res.reason} | ${res.output}`);
  });

  it('leaves no volume behind, whatever the verdict', { timeout: DOCKER_TIMEOUT }, async () => {
    const sandbox = new DockerSandbox();
    await runPreflight(sandbox, UNLOADABLE as any, { timeoutMs: 90_000 });
    const sweep = await sandbox.orphanSweep({ forceAll: false });
    assert.equal(sweep.reapedVolumes, 0, 'pre-flight must clean up after itself');
  });
});

describe('the producer refuses an unpassable proposal', () => {
  function harness(proposalJson: string) {
    const store = new AgentStore(':memory:');
    const ledger = new CostLedger(':memory:');
    store.createAgent({
      id: 'agent-alpha',
      name: 'Alpha',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });
    const registered: string[] = [];
    const producer = new GoalDecompositionWorkProducer({
      mission: 'Build small, well-tested JavaScript utilities.',
      agentId: 'agent-alpha',
      llmClient: {
        async generateCode() {
          return { content: proposalJson, inputTokens: 10, outputTokens: 10, attemptCount: 1 };
        },
      } as any,
      modelId: 'claude-haiku-4-5',
      ledger,
      budgetCapUsd: 10,
      registerTaskDefinition: (name) => registered.push(name),
      minIntervalMs: 0,
      preflightTimeoutMs: 90_000,
    });
    return {
      store,
      ledger,
      producer,
      registered,
      close: () => {
        store.close();
        ledger.close();
      },
    };
  }

  it('does not register a task whose test cannot load', { timeout: DOCKER_TIMEOUT }, async () => {
    const h = harness(JSON.stringify(UNLOADABLE));
    try {
      await h.producer.start(); // produceNextTasks is a no-op until started
      const produced = await h.producer.produceNextTasks(h.store);
      assert.equal(produced, 0, 'an unpassable proposal must not become a task');
      assert.deepEqual(h.registered, [], 'nothing may reach the scheduler');
      assert.equal(h.store.listTaskRuns().length, 0, 'and no run may be queued');

      assert.match(h.producer.lastFailure ?? '', /rejected by pre-flight \(UNLOADABLE\)/);
    } finally {
      h.close();
    }
  });

  it(
    'NEGATIVE CONTROL: it DOES register a proposal that pre-flights cleanly',
    { timeout: DOCKER_TIMEOUT },
    async () => {
      // Proves the gate is selective. Without it, a producer that rejected
      // everything would satisfy the test above and quietly halt all work.
      const h = harness(JSON.stringify(USABLE));
      try {
        await h.producer.start();
        const produced = await h.producer.produceNextTasks(h.store);
        assert.equal(produced, 1, h.producer.lastFailure ?? 'expected the task to be accepted');
        assert.deepEqual(h.registered, ['clamp-number']);
        assert.equal(h.store.listTaskRuns().length, 1);
      } finally {
        h.close();
      }
    }
  );
});
