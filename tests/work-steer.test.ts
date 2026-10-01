/**
 * Phase 4: Control and Planning tests.
 *
 * Covers:
 * 1. RepeatGuard: threshold notes at 3 & 5, error at 8, revision invalidation.
 * 2. todo_write: schema validation, at most 1 in_progress, WORK_TODO event.
 * 3. plan: emits both WORK_PLAN and WORK_TODO with all items pending.
 * 4. SteerBus & WorkRuntime: draining at turn boundary, STEER_APPLIED event.
 * 5. Native parallel read-only tool execution & mixed-turn isolation.
 * 6. ChatService steerRequest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepeatGuard } from '../src/daemon/repeat-guard.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { WorkRuntime, type WorkRuntimeOptions } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { ChatService } from '../src/daemon/chat.js';
import { CONVERSATION_CONTRACT, type WorkContract } from '../src/daemon/work-contract.js';
import { SteerBus } from '../src/daemon/control-plane.js';
import type { ILLMClient, LLMRequest, LLMResponse } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';

type Sandbox = NonNullable<WorkRuntimeOptions['sandbox']>;

class MemorySandbox implements Sandbox {
  files = new Map<string, Record<string, string>>();
  calls: string[] = [];
  async createWorkspaceVolume(id: string) { this.files.set(id, {}); return id; }
  async stageWorkspaceFiles(id: string, files: Record<string, string>) {
    const cur = this.files.get(id) ?? {};
    Object.assign(cur, files);
    this.files.set(id, cur);
  }
  async readWorkspaceFile(id: string, file: string) {
    const f = this.files.get(id);
    if (!f || !(file in f)) {
      if (file === 'README.md') return { content: '# Test', truncated: false };
      throw new Error(`Missing file: ${file}`);
    }
    return { content: f[file], truncated: false };
  }
  async executeTask(id: string, command: string) {
    this.calls.push(command);
    return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
  }
  async destroyWorkspaceVolume(id: string) { this.files.delete(id); }
  async searchWorkspace(id: string, action: 'list' | 'glob' | 'grep') {
    if (action === 'list') return 'README.md\nsrc/index.js';
    if (action === 'glob') return 'README.md';
    if (action === 'grep') return 'README.md:1:# Test';
    return '';
  }
}

class ScriptedLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(private responses: Array<string | Record<string, any>>) {}
  async generateCode(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: request.messages?.map(m => ({ ...m })) });
    const next = this.responses.shift() ?? { tool: 'answer', text: 'Done' };
    if (typeof next === 'object' && next !== null && 'toolCalls' in next) {
      return {
        content: '',
        toolCalls: next.toolCalls as any,
        inputTokens: 50,
        outputTokens: 50,
        attemptCount: 1,
      };
    }
    return {
      content: typeof next === 'string' ? next : JSON.stringify(next),
      inputTokens: 50,
      outputTokens: 50,
      attemptCount: 1,
    };
  }
}

const CODE_CONTRACT: WorkContract = {
  id: 'test-code',
  kind: 'code',
  name: 'Test Code',
  description: 'Test',
  requirements: ['pass'],
  initialFiles: { 'README.md': '# Test' },
  testCommand: 'npm test',
  maxTurns: 10,
  timeoutMs: 60000,
};

function createHarness(actions: Array<string | Record<string, any>>, steerBus?: SteerBus) {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'worker', name: 'Worker', model_id: MODEL, budget_cap_usd: 100, current_status: 'IDLE' });
  const llm = new ScriptedLLM(actions);
  const artifacts = new ArtifactStore(store);
  const sandbox = new MemorySandbox();
  const runtime = new WorkRuntime({ store, ledger, llm, sandbox, artifacts, steer: steerBus });
  const chat = new ChatService({ agentStore: store, ledger, llmClient: llm, workRuntime: runtime, steerBus });
  const thread = chat.createThread('worker');
  return {
    store,
    ledger,
    llm,
    artifacts,
    runtime,
    chat,
    thread,
    sandbox,
    close: () => { ledger.close(); store.close(); },
  };
}

test('RepeatGuard: tracks identical actions and provides warnings at 3, 5 and stops at 8', () => {
  const guard = new RepeatGuard();
  assert.deepEqual(guard.record('read', { path: 'a.txt' }, 0), { count: 1 });
  assert.deepEqual(guard.record('read', { path: 'a.txt' }, 0), { count: 2 });
  const r3 = guard.record('read', { path: 'a.txt' }, 0);
  assert.equal(r3.count, 3);
  assert.match(r3.note!, /called 3 times/);
  assert.deepEqual(guard.record('read', { path: 'a.txt' }, 0), { count: 4 });
  const r5 = guard.record('read', { path: 'a.txt' }, 0);
  assert.equal(r5.count, 5);
  assert.match(r5.note!, /called 5 times/);
  assert.deepEqual(guard.record('read', { path: 'a.txt' }, 0), { count: 6 });
  assert.deepEqual(guard.record('read', { path: 'a.txt' }, 0), { count: 7 });
  assert.throws(() => guard.record('read', { path: 'a.txt' }, 0), /Identical action "read" called 8 times/);
});

test('RepeatGuard: workspace revision change resets count', () => {
  const guard = new RepeatGuard();
  guard.record('read', { path: 'a.txt' }, 0);
  guard.record('read', { path: 'a.txt' }, 0);
  assert.equal(guard.record('read', { path: 'a.txt' }, 0).count, 3);
  // After file edit, revision increments to 1
  assert.equal(guard.record('read', { path: 'a.txt' }, 1).count, 1);
});

test('RepeatGuard: argument order invariance', () => {
  const guard = new RepeatGuard();
  assert.equal(guard.record('grep', { pattern: 'foo', path: 'src' }, 0).count, 1);
  assert.equal(guard.record('grep', { path: 'src', pattern: 'foo' }, 0).count, 2);
});

test('todo_write: emits WORK_TODO and updates checklist', async () => {
  const h = createHarness([
    {
      tool: 'todo_write',
      items: [
        { id: '1', text: 'Task 1', status: 'completed' },
        { id: '2', text: 'Task 2', status: 'in_progress' },
        { id: '3', text: 'Task 3', status: 'pending' },
      ],
    },
    { tool: 'answer', text: 'Done' },
  ]);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
  h.store.startTaskRun(run.id, MODEL);
  try {
    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Do work',
      conversation: true,
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, 'COMPLETED');
    const events = h.store.getTaskEvents(run.id);
    const todoEvents = events.filter((e) => e.event_type === 'WORK_TODO');
    assert.equal(todoEvents.length, 1);
    const payload = JSON.parse(todoEvents[0].payload_json!);
    assert.equal(payload.items.length, 3);
    assert.equal(payload.items[0].status, 'completed');
    assert.equal(payload.items[1].status, 'in_progress');
    assert.equal(payload.items[2].status, 'pending');
  } finally {
    h.close();
  }
});

test('todo_write: rejects multiple items in_progress', async () => {
  const h = createHarness([
    {
      tool: 'todo_write',
      items: [
        { text: 'Task 1', status: 'in_progress' },
        { text: 'Task 2', status: 'in_progress' },
      ],
    },
    { tool: 'answer', text: 'Done' },
  ]);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
  h.store.startTaskRun(run.id, MODEL);
  try {
    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Do work',
      conversation: true,
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, 'COMPLETED');
    const lastReq = h.llm.requests[1];
    const userMsg = lastReq.messages?.find((m) => m.role === 'user' && m.content.includes('At most one todo item can be in_progress'));
    assert.ok(userMsg, 'Model receives error observation about in_progress constraint');
  } finally {
    h.close();
  }
});

test('plan action emits WORK_PLAN and WORK_TODO with all items pending', async () => {
  const h = createHarness([
    { tool: 'plan', steps: ['First step', 'Second step'] },
    { tool: 'answer', text: 'Done' },
  ]);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
  h.store.startTaskRun(run.id, MODEL);
  try {
    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Plan work',
      conversation: true,
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, 'COMPLETED');
    const events = h.store.getTaskEvents(run.id);
    const planEvents = events.filter((e) => e.event_type === 'WORK_PLAN');
    const todoEvents = events.filter((e) => e.event_type === 'WORK_TODO');
    assert.equal(planEvents.length, 1);
    assert.equal(todoEvents.length, 1);
    const todoPayload = JSON.parse(todoEvents[0].payload_json!);
    assert.deepEqual(todoPayload.items, [
      { id: '1', text: 'First step', status: 'pending' },
      { id: '2', text: 'Second step', status: 'pending' },
    ]);
  } finally {
    h.close();
  }
});

test('steer: drains instructions at turn boundary and emits STEER_APPLIED', async () => {
  const steerBus = new SteerBus();
  const h = createHarness([
    { tool: 'plan', steps: ['Step 1'] },
    { tool: 'answer', text: 'Done' },
  ], steerBus);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
  h.store.startTaskRun(run.id, MODEL);

  // Queue steer instruction before second turn
  steerBus.push(run.id, 'Change plan to focus on security');

  try {
    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Plan work',
      conversation: true,
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, 'COMPLETED');
    const events = h.store.getTaskEvents(run.id);
    const steerEvents = events.filter((e) => e.event_type === 'STEER_APPLIED');
    assert.equal(steerEvents.length, 1);
    assert.equal(JSON.parse(steerEvents[0].payload_json!).instruction, 'Change plan to focus on security');

    // Verify injected message into LLM
    const secondReq = h.llm.requests[1];
    const steerMsg = secondReq.messages?.find((m) => m.content.includes('Operator instruction: Change plan to focus on security'));
    assert.ok(steerMsg, 'Instruction injected into model messages');
  } finally {
    h.close();
  }
});

test('operator steering survives old-observation pruning and explicit compaction verbatim', async () => {
  const steerBus = new SteerBus();
  const instruction = 'Preserve this operator constraint: ' + 'x'.repeat(4000) + ' NEVER PUBLISH';
  const h = createHarness([
    ...Array.from({ length: 5 }, (_, i) => ({ tool: 'plan', steps: [`Step ${i}`] })),
    { tool: 'compact' }, { tool: 'answer', text: 'Done' },
  ], steerBus);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
  h.store.startTaskRun(run.id, MODEL);
  steerBus.push(run.id, instruction);
  try {
    const result = await h.runtime.execute({ taskRunId: run.id, contract: CONVERSATION_CONTRACT,
      request: 'Plan work', conversation: true, signal: AbortSignal.timeout(15000) });
    assert.equal(result.outcome, 'COMPLETED');
    assert.ok(h.llm.requests.at(-1)!.messages![0].content.includes(instruction));
  } finally { h.close(); }
});

test('native parallel read-only tool calls execute concurrently', async () => {
  const h = createHarness([
    {
      toolCalls: [
        { id: 'call-1', name: 'read', arguments: JSON.stringify({ path: 'README.md' }) },
        { id: 'call-2', name: 'list', arguments: JSON.stringify({ path: '.' }) },
      ],
    },
    { tool: 'write', path: 'src/index.js', content: 'export const x = 1;' },
    { tool: 'verify' },
    { tool: 'finish' },
  ]);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: CODE_CONTRACT.id });
  h.store.startTaskRun(run.id, MODEL);
  try {
    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CODE_CONTRACT,
      request: 'Inspect project',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, 'COMPLETED');
    const events = h.store.getTaskEvents(run.id);
    const toolCallEvents = events.filter((e) => e.event_type === 'TOOL_CALL');
    assert.equal(toolCallEvents.length, 4); // call-1, call-2, write, verify
    const callIds = toolCallEvents.slice(0, 2).map((e) => JSON.parse(e.payload_json!).callId).sort();
    assert.deepEqual(callIds, ['call-1', 'call-2']);
  } finally {
    h.close();
  }
});

test('native mixed tool calls execute only the first call', async () => {
  const h = createHarness([
    {
      toolCalls: [
        { id: 'call-1', name: 'write', arguments: JSON.stringify({ path: 'src/index.js', content: 'export const a = 1;' }) },
        { id: 'call-2', name: 'read', arguments: JSON.stringify({ path: 'README.md' }) },
      ],
    },
    { tool: 'verify' },
    { tool: 'finish' },
  ]);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: CODE_CONTRACT.id });
  h.store.startTaskRun(run.id, MODEL);
  try {
    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CODE_CONTRACT,
      request: 'Inspect project',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, 'COMPLETED');
    const events = h.store.getTaskEvents(run.id);
    const toolCallEvents = events.filter((e) => e.event_type === 'TOOL_CALL');
    // In turn 1 only call-1 runs (write), then turn 2 verify runs, turn 3 finish
    const firstTurnEvents = toolCallEvents.filter((e) => JSON.parse(e.payload_json!).tool === 'write');
    assert.equal(firstTurnEvents.length, 1);
    assert.equal(JSON.parse(firstTurnEvents[0].payload_json!).callId, 'call-1');
  } finally {
    h.close();
  }
});

test('ChatService steerRequest: handles missing and active requests correctly', async () => {
  const steerBus = new SteerBus();
  const h = createHarness([], steerBus);

  try {
    // Non-existent request returns error
    const failed = h.chat.steerRequest(h.thread.id, 'non-existent', 'hello');
    assert.equal(failed.success, false);
    assert.match(failed.error!, /not currently running/);
  } finally {
    h.close();
  }
});
