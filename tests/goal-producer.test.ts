import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startDaemon } from '../src/daemon/index.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import {
  GoalDecompositionWorkProducer,
  type ProducedTaskDefinition,
} from '../src/daemon/goal-producer.js';

// A model present in the STATIC pricing table, so these tests never require a
// live OpenRouter catalog sync.
const TEST_MODEL = 'claude-haiku-4-5';

const VALID_PROPOSAL = JSON.stringify({
  name: 'json-pointer-resolver',
  testCommand: 'node --test test.js',
  files: {
    'test.js': "import test from 'node:test';",
    'src/index.js': 'export function resolve() {}',
  },
});

class StubLLM {
  calls = 0;
  constructor(private readonly script: string[] | (() => string)) {}
  async generateCode(_req: unknown) {
    this.calls++;
    const content =
      typeof this.script === 'function'
        ? this.script()
        : this.script[Math.min(this.calls - 1, this.script.length - 1)] ?? '{}';
    return { content, inputTokens: 100, outputTokens: 200 };
  }
}

interface Harness {
  store: AgentStore;
  ledger: CostLedger;
  registered: Map<string, ProducedTaskDefinition>;
  llm: StubLLM;
  clock: { t: number };
}

function harness(script: string[] | (() => string)): Harness {
  const store = new AgentStore(':memory:');
  store.createAgent({
    id: 'agent-alpha',
    name: 'Alpha',
    model_id: TEST_MODEL,
    budget_cap_usd: 10,
    current_status: 'IDLE',
  });
  return {
    store,
    ledger: new CostLedger(':memory:'),
    registered: new Map(),
    llm: new StubLLM(script),
    clock: { t: Date.UTC(2026, 8, 4, 12, 0, 0) },
  };
}

function makeProducer(h: Harness, over: Record<string, unknown> = {}) {
  return new GoalDecompositionWorkProducer({
    mission: 'Build small, well-tested JavaScript utilities.',
    agentId: 'agent-alpha',
    // These tests cover parsing, quotas and budget guards. The pre-flight has
    // its own suite; opting out here is explicit, not a silent skip.
    skipPreflight: true,
    llmClient: h.llm as any,
    modelId: TEST_MODEL,
    ledger: h.ledger,
    budgetCapUsd: 5,
    registerTaskDefinition: (n, d) => h.registered.set(n, d),
    maxQueueDepth: 1,
    minIntervalMs: 0,
    maxProposalsPerDay: 20,
    now: () => h.clock.t,
    ...over,
  });
}

describe('GoalDecompositionWorkProducer', () => {
  it('proposes a task, registers its definition, and queues a run', async () => {
    const h = harness([VALID_PROPOSAL]);
    const p = makeProducer(h);
    await p.start();

    assert.equal(await p.produceNextTasks(h.store), 1);
    assert.ok(h.registered.has('json-pointer-resolver'), 'definition must be registered with the scheduler');
    assert.equal(h.registered.get('json-pointer-resolver')!.testCommand, 'node --test test.js');

    const runs = h.store.listTaskRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].task_name, 'json-pointer-resolver');
    assert.equal(p.lastFailure, null);
    h.store.close(); h.ledger.close();
  });

  it('GUARD 1: refuses to propose while work is already in flight', async () => {
    const h = harness([VALID_PROPOSAL]);
    const p = makeProducer(h);
    await p.start();

    h.store.createTaskRun({ agentId: 'agent-alpha', taskName: 'pre-existing' });
    assert.equal(await p.produceNextTasks(h.store), 0, 'queue is occupied - must not propose');
    assert.equal(h.llm.calls, 0, 'must not spend a request when the queue is full');
    h.store.close(); h.ledger.close();
  });

  it('GUARD 2: enforces the wall-clock interval between proposals', async () => {
    const h = harness(() =>
      JSON.stringify({
        name: 'task-' + Math.random().toString(36).slice(2, 8),
        testCommand: 'node --test test.js',
        files: { 'test.js': 'x' },
      })
    );
    const p = makeProducer(h, { minIntervalMs: 300_000 });
    await p.start();

    assert.equal(await p.produceNextTasks(h.store), 1, 'first proposal is allowed');
    // Retire the run so Guard 1 is not what blocks the second attempt.
    const r = h.store.listTaskRuns()[0];
    h.store.startTaskRun(r.id);
    h.store.finishTaskRun(r.id, 'COMPLETED');

    h.clock.t += 60_000; // 1 minute - inside the 5 minute floor
    assert.equal(await p.produceNextTasks(h.store), 0, 'too soon - interval guard must block');
    assert.equal(h.llm.calls, 1, 'blocked attempt must not reach the model');

    h.clock.t += 300_000; // now past the floor
    assert.equal(await p.produceNextTasks(h.store), 1, 'proposal resumes once the interval elapses');
    h.store.close(); h.ledger.close();
  });

  it('GUARD 3: a model returning garbage exhausts the daily ceiling instead of spinning', async () => {
    const h = harness(['this is not json at all']);
    const p = makeProducer(h, { maxProposalsPerDay: 3 });
    await p.start();

    for (let i = 0; i < 10; i++) await p.produceNextTasks(h.store);

    assert.equal(h.llm.calls, 3, 'failures must consume the daily budget, not be retried for free');
    assert.equal(p.proposalsUsedToday, 3);
    assert.equal(h.store.listTaskRuns().length, 0, 'no runs may be created from malformed proposals');
    assert.match(p.lastFailure ?? '', /not valid JSON/);
    h.store.close(); h.ledger.close();
  });

  it('GUARD 4: a breached budget blocks the proposal before any model call', async () => {
    const h = harness([VALID_PROPOSAL]);
    const p = makeProducer(h, { budgetCapUsd: 0.0000001 });
    await p.start();

    assert.equal(await p.produceNextTasks(h.store), 0);
    assert.equal(h.llm.calls, 0, 'budget check must precede the request');
    assert.match(p.lastFailure ?? '', /Budget exceeded/);
    h.store.close(); h.ledger.close();
  });

  it('rejects a proposal whose file path escapes the workspace', async () => {
    const h = harness([
      JSON.stringify({
        name: 'evil-task',
        testCommand: 'node --test test.js',
        files: { '../../../etc/passwd': 'pwned' },
      }),
    ]);
    const p = makeProducer(h);
    await p.start();

    assert.equal(await p.produceNextTasks(h.store), 0);
    assert.match(p.lastFailure ?? '', /escapes the workspace/);
    assert.equal(h.registered.size, 0, 'a traversal proposal must never be registered');
    h.store.close(); h.ledger.close();
  });

  it('rejects an unsafe task name', async () => {
    const h = harness([
      JSON.stringify({ name: '../../oops', testCommand: 'x', files: { 'a.js': 'b' } }),
    ]);
    const p = makeProducer(h);
    await p.start();

    assert.equal(await p.produceNextTasks(h.store), 0);
    assert.match(p.lastFailure ?? '', /not a safe kebab-case id/);
    h.store.close(); h.ledger.close();
  });

  it('rejects a repeat of an already attempted task', async () => {
    const h = harness([VALID_PROPOSAL, VALID_PROPOSAL]);
    const p = makeProducer(h);
    await p.start();

    assert.equal(await p.produceNextTasks(h.store), 1);
    const r = h.store.listTaskRuns()[0];
    h.store.startTaskRun(r.id);
    h.store.finishTaskRun(r.id, 'COMPLETED');

    assert.equal(await p.produceNextTasks(h.store), 0, 'duplicate name must be refused');
    assert.match(p.lastFailure ?? '', /Duplicate proposal rejected/);
    h.store.close(); h.ledger.close();
  });

  it('resets the daily ceiling on the UTC day boundary', async () => {
    const h = harness(['nonsense']);
    const p = makeProducer(h, { maxProposalsPerDay: 2 });
    await p.start();

    for (let i = 0; i < 5; i++) await p.produceNextTasks(h.store);
    assert.equal(p.proposalsUsedToday, 2, 'day one is capped');

    h.clock.t += 24 * 60 * 60 * 1000; // next UTC day
    await p.produceNextTasks(h.store);
    assert.equal(p.proposalsUsedToday, 1, 'counter must reset after the UTC boundary');
    h.store.close(); h.ledger.close();
  });

  it('requires a non-empty mission', () => {
    const h = harness([VALID_PROPOSAL]);
    assert.throws(() => makeProducer(h, { mission: '   ' }), /non-empty mission/);
    h.store.close(); h.ledger.close();
  });

  it('produces nothing before start() is called', async () => {
    const h = harness([VALID_PROPOSAL]);
    const p = makeProducer(h);
    assert.equal(await p.produceNextTasks(h.store), 0);
    assert.equal(h.llm.calls, 0);
    h.store.close(); h.ledger.close();
  });

  it('NEGATIVE CONTROL: with the guards opened up it generates work without bound', async () => {
    // Proves the guards above are what stop the loop, not some incidental limit.
    const h = harness(() =>
      JSON.stringify({
        name: 'gen-' + Math.random().toString(36).slice(2, 10),
        testCommand: 'node --test test.js',
        files: { 'test.js': 'x' },
      })
    );
    const p = makeProducer(h, {
      minIntervalMs: 0,
      maxProposalsPerDay: 1000,
      maxQueueDepth: 50, // Guard 1 lifted as well
    });
    await p.start();

    let produced = 0;
    for (let i = 0; i < 25; i++) produced += await p.produceNextTasks(h.store);

    assert.equal(produced, 25, 'unguarded, the producer keeps inventing work every single tick');
    assert.equal(h.store.listTaskRuns().length, 25);
    h.store.close(); h.ledger.close();
  });
});

describe('Mission wiring: the daemon decomposes a mission into runnable work', () => {
  it('registers an invented task definition and queues it (deferred schedulerRef works)', async () => {
    const dbPath = path.join(process.cwd(), 'temp-mission.db');
    const wipe = () => {
      for (const ext of ['', '-wal', '-shm']) {
        const f = dbPath + ext;
        if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch { /* busy */ } }
      }
    };
    wipe();

    // A REALISTIC proposal: the test loads and fails on an assertion, which is
    // what a fresh task should do. The previous fixture was `process.exit(0)`,
    // which the pre-flight now correctly rejects as ALREADY_PASSING - a task
    // that is complete before an agent touches it. That rejection is the
    // feature working, so the fixture was fixed rather than the gate weakened.
    const proposal = JSON.stringify({
      name: 'mission-invented-task',
      testCommand: 'node --test test.js',
      files: {
        'package.json': JSON.stringify({ name: 'mission-invented-task', type: 'module' }),
        'test.js': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { add } from './src/index.js';",
          "test('adds', () => { assert.equal(add(1, 2), 3); });",
        ].join(String.fromCharCode(10)),
        'src/index.js': 'export function add() { return 0; }',
      },
    });

    const daemon = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
      dbPath,
      wsPort: 4055,
      cadenceMs: 100,
      maxConcurrency: 1,
      llmClient: new StubLLM([proposal]) as any,
      mission: 'Build small, well-tested JavaScript utilities.',
    });

    try {
      const deadline = Date.now() + 60_000;
      let run: any = null;
      while (Date.now() < deadline) {
        run = daemon.store.listTaskRuns().find((r) => r.task_name === 'mission-invented-task');
        if (run) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.ok(run, 'the daemon must invent and queue a task from the mission alone');
      // If registration had failed, the scheduler marks the run FAILED with this exact reason.
      assert.ok(
        !(run.status === 'FAILED' && String(run.error_message || '').includes('No task definition')),
        'invented definition must reach the scheduler: ' + String(run.error_message)
      );
    } finally {
      await daemon.shutdown();
      wipe();
    }
  });
});
