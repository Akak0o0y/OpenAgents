import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { AgentLoop } from '../src/daemon/agent-loop.js';
import { TaskScheduler } from '../src/daemon/scheduler.js';
import { ProviderRouter } from '../src/daemon/provider-router.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { routineTaskDefinition } from '../src/daemon/routine-task.js';
import { classifyPreflight } from '../src/daemon/proposal-preflight.js';
import { OpenCodeExecutor } from '../src/daemon/opencode-executor.js';
import type { ILLMClient, LLMRequest } from '../src/evals/llm-client.js';

function fixture() {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  const agent = store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'claude-haiku-4-5', budget_cap_usd: 10, current_status: 'IDLE', system_prompt: 'ROLE_SENTINEL' });
  const run = store.createTaskRun({ agentId: agent.id, taskName: 'regression' });
  return { store, ledger, agent, run, close: () => { ledger.close(); store.close(); } };
}

test('manual pause/disable survives completion and crash; another running task keeps BUSY', () => {
  const h = fixture();
  try {
    h.store.startTaskRun(h.run.id);
    const second = h.store.createTaskRun({ agentId: h.agent.id, taskName: 'second' });
    h.store.startTaskRun(second.id);
    h.store.finishTaskRun(h.run.id, 'COMPLETED');
    assert.equal(h.store.getAgent(h.agent.id)?.current_status, 'BUSY');
    h.store.updateAgentStatus(h.agent.id, 'PAUSED');
    h.store.finishTaskRun(second.id, 'FAILED');
    assert.equal(h.store.getAgent(h.agent.id)?.current_status, 'PAUSED');
    const third = h.store.createTaskRun({ agentId: h.agent.id, taskName: 'third' });
    h.store.startTaskRun(third.id);
    h.store.updateAgentStatus(h.agent.id, 'DISABLED');
    h.store.markInFlightAsCrashed('fixture crash');
    assert.equal(h.store.getAgent(h.agent.id)?.current_status, 'DISABLED');
  } finally { h.close(); }
});

test('routine definitions snapshot current prompts and status follows the latest run', () => {
  const h = fixture();
  try {
    const routine = h.store.createRoutine({ agentId: h.agent.id, name: 'routine', cronExpression: '0 9 * * *', promptTemplate: 'original', nextRunAt: Date.now() });
    const definition = routineTaskDefinition(routine);
    assert.match(definition.unsupportedReason!, /verification/);
    h.store.setRunDefinition(h.run.id, definition);
    h.store.updateRoutine(routine.id, { prompt_template: 'revised' });
    const next = h.store.createTaskRun({ agentId: h.agent.id, taskName: 'routine' });
    h.store.setRunDefinition(next.id, routineTaskDefinition(h.store.getRoutine(routine.id)!));
    assert.equal((h.store.getRunDefinition(h.run.id) as any).initialFiles['PROMPT.md'], 'original');
    assert.equal((h.store.getRunDefinition(next.id) as any).initialFiles['PROMPT.md'], 'revised');
    h.store.recordRoutineRun(routine.id, h.run.id, 'QUEUED', Date.now());
    h.store.recordRoutineRun(routine.id, next.id, 'QUEUED', Date.now());
    h.store.startTaskRun(h.run.id); h.store.finishTaskRun(h.run.id, 'FAILED');
    assert.equal(h.store.getRoutine(routine.id)?.last_run_status, 'QUEUED');
    h.store.startTaskRun(next.id);
    assert.equal(h.store.getRoutine(routine.id)?.last_run_status, 'RUNNING');
    h.store.finishTaskRun(next.id, 'COMPLETED');
    assert.equal(h.store.getRoutine(routine.id)?.last_run_status, 'COMPLETED');
    assert.equal(h.store.listRoutineRuns(routine.id).length, 2);
  } finally { h.close(); }
});

test('builtin sees requirements, cannot rewrite its verifier, and retains its deliverable', async () => {
  const h = fixture(); const staged: Record<string, string>[] = []; let destroyed = false; let request: LLMRequest | undefined;
  const sandbox = { createWorkspaceVolume: async () => 'fixture-volume', stageWorkspaceFiles: async (_v: string, files: Record<string, string>) => { staged.push({ ...files }); },
    executeTask: async () => ({ exitCode: staged.at(-1)!['test.js'] === 'TRUSTED_ASSERTION' ? 1 : 0, stdout: 'AssertionError', stderr: '', timedOut: false }),
    destroyWorkspaceVolume: async () => { destroyed = true; } } as unknown as DockerSandbox;
  const llm: ILLMClient = { generateCode: async req => { request = req; return { content: '```javascript:test.js\nprocess.exit(0)\n```', inputTokens: 1, outputTokens: 1, attemptCount: 1 }; } };
  try {
    const loop = new AgentLoop({ agentStore: h.store, ledger: h.ledger, sandbox, providerRouter: new ProviderRouter(), llmClient: llm });
    const result = await loop.executeTask({ agent: h.agent, taskRun: h.run, initialFiles: { 'PROMPT.md': 'REQUIREMENT_SENTINEL', 'test.js': 'TRUSTED_ASSERTION' }, testCommand: 'node test.js', maxTurns: 1, protectedFiles: [] });
    assert.match(request!.messages!.map(m => m.content).join('\n'), /REQUIREMENT_SENTINEL/);
    assert.equal(staged.at(-1)!['test.js'], 'TRUSTED_ASSERTION');
    assert.equal(result.outcome, 'FAILED'); assert.equal(destroyed, false);
    assert.ok(h.store.getAgentData(h.agent.id, h.run.id, 'workspaces'));
  } finally { h.close(); }
});

test('setup failure and synchronous dispatch refusal retire their task and release scheduler slot', async () => {
  const h = fixture();
  const sandbox = { createWorkspaceVolume: async () => { throw new Error('fixture Docker unavailable'); } } as unknown as DockerSandbox;
  try {
    const loop = new AgentLoop({ agentStore: h.store, ledger: h.ledger, sandbox, providerRouter: new ProviderRouter() });
    const result = await loop.executeTask({ agent: h.agent, taskRun: h.run, initialFiles: {}, testCommand: 'true' });
    assert.equal(result.outcome, 'FAILED'); assert.equal(h.store.getTaskRun(h.run.id)?.status, 'FAILED');
    const refused = h.store.createTaskRun({ agentId: h.agent.id, taskName: 'unsupported' });
    const scheduler = new TaskScheduler({ agentStore: h.store, ledger: h.ledger, sandbox, providerRouter: new ProviderRouter(), executor: 'builtin', cadenceMs: 60_000,
      taskDefinitions: { unsupported: { initialFiles: {}, testCommand: '', unsupportedReason: 'No verifier' } } });
    try {
      scheduler.start(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.store.getTaskRun(refused.id)?.status, 'FAILED'); assert.equal(scheduler.getActiveTaskCount(), 0);
    } finally { await scheduler.stop(); }
  } finally { h.close(); }
});

test('abort reaches an in-flight model call and retires the run as ABORTED', async () => {
  const h = fixture(); const controller = new AbortController();
  const sandbox = { createWorkspaceVolume: async () => 'abort-volume', stageWorkspaceFiles: async () => {} } as unknown as DockerSandbox;
  const llm: ILLMClient = { generateCode: req => new Promise((_resolve, reject) => { assert.equal(req.signal, controller.signal); req.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); controller.abort(); }) };
  try {
    const loop = new AgentLoop({ agentStore: h.store, ledger: h.ledger, sandbox, providerRouter: new ProviderRouter(), llmClient: llm });
    const result = await loop.executeTask({ agent: h.agent, taskRun: h.run, initialFiles: {}, testCommand: 'true', abortSignal: controller.signal });
    assert.equal(result.outcome, 'ABORTED'); assert.equal(h.store.getTaskRun(h.run.id)?.status, 'ABORTED');
  } finally { h.close(); }
});

test('infrastructure exits and generic test crashes are inconclusive, actual assertion failures usable', () => {
  for (const [exitCode, stdout] of [[127, 'command not found'], [1, "failureType: 'testCodeFailure'\nTypeError: broken harness"], [137, 'Killed']] as const) {
    assert.equal(classifyPreflight({ exitCode, stdout, stderr: '' }).verdict, 'INCONCLUSIVE');
  }
  assert.equal(classifyPreflight({ exitCode: 1, stdout: 'ERR_ASSERTION', stderr: '' }).verdict, 'USABLE');
});

test('OpenCode prompt includes bot role and explicit protection cannot remove the verifier', () => {
  const h = fixture();
  try {
    const executor = new OpenCodeExecutor({ agentStore: h.store, ledger: h.ledger });
    const files = { 'test.js': '', 'package.json': '', 'src/index.js': '' };
    assert.deepEqual(executor.resolveProtectedFiles(files, []), ['test.js', 'package.json']);
    assert.match(executor.buildPrompt({ agent: h.agent, taskRun: h.run, initialFiles: files, testCommand: 'node test.js' }), /ROLE_SENTINEL/);
  } finally { h.close(); }
});


test('shutdown waits for an active producer tick and never starts its newly queued work', async () => {
  const h = fixture(); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const producer = { start: async () => {}, stop: async () => {}, produceNextTasks: async () => { await blocked; return 0; } };
  const scheduler = new TaskScheduler({ agentStore: h.store, ledger: h.ledger, providerRouter: new ProviderRouter(), executor: 'builtin', workProducer: producer,
    taskDefinitions: { regression: { initialFiles: {}, testCommand: 'true' } } });
  try {
    scheduler.start(); let stopped = false; const stop = scheduler.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    release(); await stop;
    assert.equal(h.store.getTaskRun(h.run.id)?.status, 'QUEUED'); assert.equal(scheduler.getActiveTaskCount(), 0);
  } finally { release(); await scheduler.stop(); h.close(); }
});
