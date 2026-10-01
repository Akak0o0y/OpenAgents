/**
 * Sub-agent delegation tests:
 *   - Parent delegates subtask to child and receives completed child report
 *   - Context isolation: child receives clean, isolated context
 *   - Depth limit: depth 2 (child) cannot delegate further
 *   - Target agent routing and status validation
 *   - Cancellation propagation: aborting parent aborts child
 *   - Child failure is captured gracefully without crashing parent
 *   - Token and cost rollup from child to parent
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { WorkRuntime, type WorkRuntimeOptions } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';
import { availableTools } from '../src/daemon/tool-schemas.js';
import { RunCapacity } from '../src/daemon/run-capacity.js';
import type { ILLMClient, LLMRequest, LLMResponse } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';

class ScriptedLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(private actions: (unknown | ((req: LLMRequest) => unknown))[]) {}
  async generateCode(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: request.messages?.map(m => ({ ...m })) });
    const next = this.actions.shift() ?? { tool: 'answer', text: 'Default fallback answer', citations: [] };
    const action = typeof next === 'function' ? next(request) : next;
    return {
      content: typeof action === 'string' ? action : JSON.stringify(action),
      inputTokens: 100,
      outputTokens: 50,
      attemptCount: 1,
    };
  }
}

type Sandbox = WorkRuntimeOptions['sandbox'];
class MemorySandbox implements Sandbox {
  files = new Map<string, Record<string, string>>();
  calls: string[] = [];
  async createWorkspaceVolume(id: string) { this.files.set(id, {}); return id; }
  async stageWorkspaceFiles(id: string, files: Record<string, string>) { Object.assign(this.files.get(id)!, files); }
  async readWorkspaceFile(id: string, file: string) {
    if (!(file in this.files.get(id)!)) throw new Error('Missing file');
    return { content: this.files.get(id)![file], truncated: false };
  }
  async executeTask(id: string, command: string) {
    this.calls.push(command);
    return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
  }
  async destroyWorkspaceVolume(id: string) { this.files.delete(id); }
}

function createHarness(
  actions: (unknown | ((req: LLMRequest) => unknown))[],
  extraAgents?: { id: string; name: string; status?: 'IDLE' | 'PAUSED' | 'DISABLED'; systemPrompt?: string }[],
  options: Partial<WorkRuntimeOptions> = {}
) {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  const artifacts = new ArtifactStore(store);
  const sandbox = new MemorySandbox();

  store.createAgent({
    id: 'parent-agent',
    name: 'Parent Agent',
    model_id: MODEL,
    budget_cap_usd: 100,
    current_status: 'IDLE',
    system_prompt: 'You are the coordinator bot.',
  });

  if (extraAgents) {
    for (const a of extraAgents) {
      store.createAgent({
        id: a.id,
        name: a.name,
        model_id: MODEL,
        budget_cap_usd: 100,
        current_status: a.status ?? 'IDLE',
        system_prompt: a.systemPrompt ?? null,
      });
    }
  }

  const llm = new ScriptedLLM(actions);
  const runtime = new WorkRuntime({
    store,
    ledger,
    llm,
    sandbox,
    artifacts,
    ...options,
  });

  return { store, ledger, artifacts, sandbox, llm, runtime };
}

describe('sub-agent delegation', () => {
  it('denies cross-bot authority by default before creating a child', async () => {
    const h = createHarness([
      { tool: 'delegate', taskName: 'forbidden', instruction: 'Use another bot', targetAgentId: 'other-bot' },
      (req: LLMRequest) => {
        assert.match(req.messages!.at(-1)!.content, /not permitted/);
        return { tool: 'answer', text: 'Completed directly', citations: [] };
      },
    ], [{ id: 'other-bot', name: 'Other' }]);
    const run = h.store.createTaskRun({ agentId: 'parent-agent', taskName: 'authority' });
    h.store.startTaskRun(run.id, MODEL);
    await h.runtime.execute({ taskRunId: run.id, contract: CONVERSATION_CONTRACT, request: 'Test', conversation: true, signal: new AbortController().signal });
    assert.equal(h.store.listTaskRuns('other-bot').length, 0);
    h.store.close();
  });

  it('synchronous children borrow one occupied slot without admitting unrelated work', () => {
    const capacity = new RunCapacity(1);
    const release = capacity.acquire('parent')!;
    const child = capacity.acquireChild('parent', 'child')!;
    assert.equal(typeof child, 'function');
    assert.equal(capacity.used, 1);
    assert.equal(capacity.acquire('unrelated'), null);
    assert.equal(capacity.acquireChild('parent', 'second'), null);
    child(); child();
    assert.equal(capacity.used, 1);
    release();
    assert.equal(capacity.used, 0);
  });

  it('charges cross-bot reservations to both budgets without double billing the ledger', () => {
    const store = new AgentStore(':memory:');
    const ledger = new CostLedger(store.getDatabase());
    const reservation = ledger.reserveWithBudgetCheck('child', 'specialist', MODEL, 100, 1000, undefined, undefined, { agentId: 'parent', budgetCapUsd: 100 });
    assert(ledger.getAgentSpend('parent').totalUsd > 0);
    assert.equal(ledger.getAgentSpend('parent').totalUsd, ledger.getAgentSpend('specialist').totalUsd);
    assert.throws(() => ledger.reserveWithBudgetCheck('child2', 'specialist', MODEL, 100, 1000, undefined, undefined, { agentId: 'parent', budgetCapUsd: 0.000001 }), /budget/i);
    ledger.markDispatched(reservation.id);
    ledger.reconcile(reservation.id, 100, 30);
    assert.equal(ledger.getAgentSpend('parent').totalUsd, ledger.getAgentSpend('specialist').totalUsd);
    assert.equal((store.getDatabase().prepare('SELECT COUNT(*) AS n FROM cost_reservations').get() as {n:number}).n, 1);
    store.close();
  });

  it('parent delegates subtask to child and receives completed child report in observation', async () => {
    const h = createHarness([
      { tool: 'delegate', taskName: 'sum-numbers', instruction: 'Compute 10 + 25' },
      { tool: 'answer', text: 'The sum is 35.', citations: [] },
      (req: LLMRequest) => {
        const lastMsg = req.messages?.[req.messages.length - 1];
        assert(lastMsg && (lastMsg.role === 'tool' || lastMsg.role === 'user'));
        const obs = JSON.parse(lastMsg.content);
        assert.equal(obs.status, 'ok');
        assert.equal(obs.outcome, 'COMPLETED');
        assert(obs.summary.includes('The sum is 35.'));
        return { tool: 'answer', text: `Parent got answer: ${obs.summary}`, citations: [] };
      },
    ]);

    const run = h.store.createTaskRun({ agentId: 'parent-agent', taskName: 'parent-task' });
    h.store.startTaskRun(run.id, MODEL);

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Calculate 10 + 25 using a subagent.',
      conversation: true,
      signal: new AbortController().signal,
      commit: (res) => h.store.finishTaskRun(run.id, res.outcome, res.report),
    });

    assert.equal(result.outcome, 'COMPLETED');
    assert(result.report.includes('The sum is 35.'));

    const parentEvents = h.store.getTaskEvents(run.id);
    const delegatedEv = parentEvents.find(e => e.event_type === 'SUBAGENT_DELEGATED');
    assert(delegatedEv, 'Must emit SUBAGENT_DELEGATED');
    const delegatedPayload = JSON.parse(delegatedEv.payload_json);
    assert.equal(delegatedPayload.taskName, 'sum-numbers');
    assert.equal(delegatedPayload.targetAgentId, 'parent-agent');
    assert.equal(delegatedPayload.depth, 2);

    const completedEv = parentEvents.find(e => e.event_type === 'SUBAGENT_COMPLETED');
    assert(completedEv, 'Must emit SUBAGENT_COMPLETED');
    const completedPayload = JSON.parse(completedEv.payload_json);
    assert.equal(completedPayload.outcome, 'COMPLETED');

    const childRunId = delegatedPayload.childRunId;
    const childRun = h.store.getTaskRun(childRunId);
    assert(childRun, 'Child task run must exist');
    assert.equal(childRun.status, 'COMPLETED');
    assert.equal(childRun.task_name, 'subtask:sum-numbers');

    const delegationData = h.store.getAgentData('parent-agent', childRunId, 'delegation');
    assert(delegationData, 'Delegation record must be saved in agent_data');
    const parsedData = JSON.parse(delegationData.data_json);
    assert.equal(parsedData.parentRunId, run.id);
    assert.equal(parsedData.depth, 2);
  });

  it('context isolation: child only receives its instruction, not parent conversation history', async () => {
    let childFirstMessage: string | undefined;

    const h = createHarness([
      { tool: 'delegate', taskName: 'isolated-task', instruction: 'Secret subagent prompt 98765' },
      (req: LLMRequest) => {
        childFirstMessage = req.messages?.[0]?.content;
        return { tool: 'answer', text: 'Isolated report', citations: [] };
      },
      { tool: 'answer', text: 'All done', citations: [] },
    ]);

    const run = h.store.createTaskRun({ agentId: 'parent-agent', taskName: 'isolated-parent' });
    h.store.startTaskRun(run.id, MODEL);

    await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Top-secret-parent-prompt-12345',
      history: [{ role: 'user', content: 'Past parent conversation that must not leak' }],
      conversation: true,
      signal: new AbortController().signal,
      commit: (res) => h.store.finishTaskRun(run.id, res.outcome, res.report),
    });

    assert(childFirstMessage, 'Child must have received a prompt');
    assert(childFirstMessage.includes('Secret subagent prompt 98765'), 'Child must receive its instruction');
    assert(!childFirstMessage.includes('Top-secret-parent-prompt-12345'), 'Parent request must not leak to child');
    assert(!childFirstMessage.includes('Past parent conversation that must not leak'), 'Parent history must not leak to child');
  });

  it('depth limit: depth 2 child cannot delegate further', async () => {
    let childErrorObservation: any;

    const h = createHarness([
      { tool: 'delegate', taskName: 'level-1-child', instruction: 'Perform child subtask' },
      { tool: 'delegate', taskName: 'level-2-grandchild', instruction: 'Forbidden nested delegation' },
      (req: LLMRequest) => {
        const lastMsg = req.messages?.[req.messages.length - 1];
        childErrorObservation = JSON.parse(lastMsg?.content ?? '{}');
        return { tool: 'answer', text: 'Child recovered and completed directly', citations: [] };
      },
      { tool: 'answer', text: 'Parent finished', citations: [] },
    ]);

    const run = h.store.createTaskRun({ agentId: 'parent-agent', taskName: 'depth-test' });
    h.store.startTaskRun(run.id, MODEL);

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Test depth bounding',
      conversation: true,
      signal: new AbortController().signal,
      commit: (res) => h.store.finishTaskRun(run.id, res.outcome, res.report),
    });

    assert.equal(result.outcome, 'COMPLETED');
    assert(childErrorObservation, 'Child should have received error observation');
    assert.equal(childErrorObservation.status, 'error');
    assert(
      childErrorObservation.summary.includes('Delegation depth limit reached'),
      `Expected depth limit message, got: ${childErrorObservation.summary}`
    );

    const tools = availableTools({ canDelegate: false });
    assert(!tools.some(t => t.name === 'delegate'), 'delegate tool must be omitted when canDelegate is false');
  });

  it('target agent routing and status validation', async () => {
    const h = createHarness([
      { tool: 'delegate', taskName: 'specialist-work', instruction: 'Specialist instruction', targetAgentId: 'specialist-bot' },
      { tool: 'answer', text: 'Specialist output report', citations: [] },
      { tool: 'delegate', taskName: 'missing-work', instruction: 'Missing bot', targetAgentId: 'ghost-bot' },
      (req: LLMRequest) => {
        const lastMsg = req.messages?.[req.messages.length - 1];
        const obs = JSON.parse(lastMsg?.content ?? '{}');
        assert.equal(obs.status, 'error');
        assert(obs.summary.includes('Target agent "ghost-bot" does not exist.'));
        return { tool: 'delegate', taskName: 'paused-work', instruction: 'Paused bot', targetAgentId: 'paused-bot' };
      },
      (req: LLMRequest) => {
        const lastMsg = req.messages?.[req.messages.length - 1];
        const obs = JSON.parse(lastMsg?.content ?? '{}');
        assert.equal(obs.status, 'error');
        assert(obs.summary.includes('is paused or disabled'));
        return { tool: 'answer', text: 'Done validating target agents', citations: [] };
      },
    ], [
      { id: 'specialist-bot', name: 'Specialist Bot', systemPrompt: 'I specialize in math.' },
      { id: 'paused-bot', name: 'Paused Bot', status: 'PAUSED' },
    ], { delegationAllowlist: { 'parent-agent': ['specialist-bot'] } });

    const run = h.store.createTaskRun({ agentId: 'parent-agent', taskName: 'target-agent-test' });
    h.store.startTaskRun(run.id, MODEL);

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Validate target agent routing',
      conversation: true,
      signal: new AbortController().signal,
      commit: (res) => h.store.finishTaskRun(run.id, res.outcome, res.report),
    });

    assert.equal(result.outcome, 'COMPLETED');
    const runs = h.store.listTaskRuns('specialist-bot');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].task_name, 'subtask:specialist-work');
    assert.equal(runs[0].status, 'COMPLETED');
  });

  it('cancellation propagation: aborting parent aborts child run', async () => {
    const parentController = new AbortController();

    const h = createHarness([
      { tool: 'delegate', taskName: 'long-subtask', instruction: 'Do long work' },
      () => {
        parentController.abort(new Error('Parent operator clicked Stop'));
        return { tool: 'answer', text: 'This should not finalize normally', citations: [] };
      },
    ]);

    const run = h.store.createTaskRun({ agentId: 'parent-agent', taskName: 'cancel-test' });
    h.store.startTaskRun(run.id, MODEL);

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Test abort propagation',
      conversation: true,
      signal: parentController.signal,
      commit: (res) => h.store.finishTaskRun(run.id, res.outcome, res.report),
    });

    assert.equal(result.outcome, 'ABORTED');
  });

  it('child failure is handled gracefully without crashing parent', async () => {
    let parentReceivedError = false;

    const h = createHarness([
      { tool: 'delegate', taskName: 'failing-task', instruction: 'Fails immediately' },
      { tool: 'block', reason: 'Subagent cannot proceed' },
      (req: LLMRequest) => {
        const lastMsg = req.messages?.[req.messages.length - 1];
        const obs = JSON.parse(lastMsg?.content ?? '{}');
        assert.equal(obs.status, 'error');
        assert.equal(obs.outcome, 'FAILED');
        parentReceivedError = true;
        return { tool: 'answer', text: 'Handled child failure gracefully', citations: [] };
      },
    ]);

    const run = h.store.createTaskRun({ agentId: 'parent-agent', taskName: 'error-handling-test' });
    h.store.startTaskRun(run.id, MODEL);

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Test resilient child failure handling',
      conversation: true,
      signal: new AbortController().signal,
      commit: (res) => h.store.finishTaskRun(run.id, res.outcome, res.report),
    });

    assert.equal(result.outcome, 'COMPLETED');
    assert(parentReceivedError, 'Parent must have received error observation');

    const parentEvents = h.store.getTaskEvents(run.id);
    const delegatedEv = parentEvents.find(e => e.event_type === 'SUBAGENT_DELEGATED')!;
    const childRunId = JSON.parse(delegatedEv.payload_json).childRunId;
    const childRun = h.store.getTaskRun(childRunId);
    assert.equal(childRun?.status, 'FAILED');
  });

  it('token and cost rollup from child to parent', async () => {
    const h = createHarness([
      { tool: 'delegate', taskName: 'cost-task', instruction: 'Run subtask' },
      { tool: 'answer', text: 'Subtask answer', citations: [] },
      { tool: 'answer', text: 'Parent final answer', citations: [] },
    ]);

    const run = h.store.createTaskRun({ agentId: 'parent-agent', taskName: 'cost-test' });
    h.store.startTaskRun(run.id, MODEL);

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Test token rollup',
      conversation: true,
      signal: new AbortController().signal,
      commit: (res) => h.store.finishTaskRun(run.id, res.outcome, res.report),
    });

    assert.equal(result.outcome, 'COMPLETED');
    assert(result.inputTokens >= 300, `Expected inputTokens >= 300, got ${result.inputTokens}`);
    assert(result.outputTokens >= 150, `Expected outputTokens >= 150, got ${result.outputTokens}`);
  });
});
