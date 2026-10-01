import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/daemon/agent-loop.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ProviderRouter } from '../src/daemon/provider-router.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { MockLLMClient } from '../src/evals/llm-client.js';

test('AgentLoop: multi-turn conversational loop, event streaming, and completion', async () => {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(':memory:');
  const providerRouter = new ProviderRouter();

  // Stands in for the WS broadcaster. The store is the single fan-out point, so
  // what lands here is exactly what a connected operator would see.
  const broadcast: string[] = [];
  store.setEventSink((e) => broadcast.push(e.event_type));

  const agent = store.createAgent({
    id: 'test-agent',
    name: 'Test Agent',
    model_id: 'claude-haiku-4-5',
    budget_cap_usd: 5.00,
    current_status: 'IDLE',
  });

  const taskRun = store.createTaskRun({
    agentId: agent.id,
    taskName: 'test-cli-parser',
  });

  // Mock responses:
  // Turn 1: Emit invalid code that fails tests
  // Turn 2: Emit working code that passes tests
  const mockResponses = {
    default: [
      'export function parseArgs() { return {}; }',
      'export function parseArgs(args) {\n  const res = {};\n  for (const a of args) {\n    if (a === "--verbose") res.verbose = true;\n  }\n  return res;\n}',
    ],
  };

  const mockClient = new MockLLMClient(mockResponses);

  const loop = new AgentLoop({
    agentStore: store,
    ledger,
    providerRouter,
    llmClient: mockClient,
  });

  const initialFiles = {
    'package.json': JSON.stringify({
      name: 'test-pkg',
      type: 'module',
      scripts: { test: 'node --test' },
    }, null, 2),
    'test/cli.test.js': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/index.js';

test('parses verbose flag', () => {
  const res = parseArgs(['--verbose']);
  assert.equal(res.verbose, true);
});
`,
  };

  const result = await loop.executeTask({
    agent,
    taskRun,
    initialFiles,
    testCommand: 'npm test',
    maxTurns: 5,
  });

  assert.equal(result.outcome, 'COMPLETED');
  assert.equal(result.turnsTaken, 2);

  // Verify store state
  const finishedRun = store.getTaskRun(taskRun.id);
  assert.equal(finishedRun?.status, 'COMPLETED');
  assert.equal(finishedRun?.turns_taken, 2);

  // Verify events recorded in store
  const events = store.getTaskEvents(taskRun.id);
  assert.ok(events.some(e => e.event_type === 'TASK_STARTED'));
  assert.ok(events.some(e => e.event_type === 'TURN_COMPLETED'));
  assert.ok(events.some(e => e.event_type === 'TASK_COMPLETED'));

  // Every committed event reaches the sink exactly once, in order. Two code
  // paths used to publish the same lifecycle event, so this is the transport
  // half of the duplicate-event fix.
  assert.deepEqual(broadcast, events.map(e => e.event_type));

  // Regression: the store and the loop both used to emit these, so one task
  // produced two TASK_STARTED and two terminal rows - one of each with an empty
  // payload - inflating every metric built on execution_events.
  const types = events.map(e => e.event_type);
  assert.equal(types.filter(t => t === 'TASK_STARTED').length, 1,
    `exactly one TASK_STARTED per run; got ${types.join(', ')}`);
  assert.equal(types.filter(t => t.startsWith('TASK_') && t !== 'TASK_STARTED').length, 1,
    `exactly one terminal event per run; got ${types.join(', ')}`);

  // The loop's detail survived the merge into the store-owned event, and the
  // taxonomy stamped the layer on the way in.
  const started = events.find(e => e.event_type === 'TASK_STARTED')!;
  assert.equal(JSON.parse(started.payload_json).executor, 'builtin');
  assert.equal(started.layer, 1);
  assert.equal(events.find(e => e.event_type === 'TASK_COMPLETED')!.layer, 12);

  store.close();
  ledger.close();
});

test('AgentLoop: AbortSignal (kill command) immediately halts task and records ABORTED', async () => {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(':memory:');
  const providerRouter = new ProviderRouter();

  const agent = store.createAgent({
    id: 'test-agent-kill',
    name: 'Killable Agent',
    model_id: 'claude-haiku-4-5',
    budget_cap_usd: 5.00,
    current_status: 'IDLE',
  });

  const taskRun = store.createTaskRun({
    agentId: agent.id,
    taskName: 'long-running-task',
  });

  const abortController = new AbortController();

  // Abort immediately before execution starts or during turn 1
  abortController.abort();

  const mockClient = new MockLLMClient({
    default: ['console.log("never runs");'],
  });

  const loop = new AgentLoop({
    agentStore: store,
    ledger,
    providerRouter,
    llmClient: mockClient,
  });

  const result = await loop.executeTask({
    agent,
    taskRun,
    initialFiles: {
      'package.json': JSON.stringify({ name: 'pkg', type: 'module' }),
    },
    testCommand: 'npm test',
    abortSignal: abortController.signal,
    maxTurns: 10,
  });

  assert.equal(result.outcome, 'ABORTED');

  // Verify store recorded ABORTED
  const run = store.getTaskRun(taskRun.id);
  assert.equal(run?.status, 'ABORTED');
  assert.ok(run?.error_message?.includes('Operator terminated'));

  // Verify agent returned to IDLE
  assert.equal(store.getAgent(agent.id)?.current_status, 'IDLE');

  store.close();
  ledger.close();
});
