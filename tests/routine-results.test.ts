import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { WorkRuntime, type WorkRuntimeOptions } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { ROUTINE_ASK_CONTRACT, ROUTINE_ASK_TASK } from '../src/daemon/work-contract.js';
import { GoalResults } from '../src/daemon/goal-results.js';
import { readWorkResult, saveWorkResult } from '../src/daemon/work-results.js';
import { PublishPolicy } from '../src/daemon/publish-policy.js';
import { xCreateTweet } from '../src/daemon/publish-probes.js';
import type { ILLMClient, LLMRequest } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';

class ScriptedLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(private actions: unknown[]) {}
  async generateCode(request: LLMRequest) {
    this.requests.push(request);
    const action = this.actions.shift() ?? { tool: 'block', reason: 'Fixture has no further actions.' };
    return { content: JSON.stringify(action), inputTokens: 100, outputTokens: 100, attemptCount: 1 };
  }
}

type Sandbox = WorkRuntimeOptions['sandbox'];
class MemorySandbox implements Sandbox {
  files = new Map<string, Record<string, string>>();
  async createWorkspaceVolume(id: string) { this.files.set(id, {}); return id; }
  async stageWorkspaceFiles(id: string, files: Record<string, string>) { Object.assign(this.files.get(id)!, files); }
  async readWorkspaceFile(id: string, file: string) { if (!(file in this.files.get(id)!)) throw new Error('Missing file'); return { content: this.files.get(id)![file], truncated: false }; }
  async executeTask() { return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }; }
  async destroyWorkspaceVolume(id: string) { this.files.delete(id); }
}

const ownerResult = { id: 'post', kind: 'publication', description: 'Publish one honest post', required: true, target: 'https://x.com',
  acceptance: { receipt: 'published', contains: [], verifier: 'stage1/1' }, dependencies: [] };
const modelResult = { id: 'result-1', kind: 'custom', description: 'A checklist the model inferred', required: true, target: 'owner',
  acceptance: { receipt: 'custom', contains: [], verifier: 'unconfigured' }, dependencies: [] };

// A routine run starts with the owner's result checklist already recorded. The prompt still asks the model to
// declare results, and the refusal it got ("Result manifest changed. Reload before amending.") read like a
// failure: the model gave up and reported a blocker from an earlier run instead of doing the work.
test('declaring results on a routine run keeps the owner checklist and says so, instead of failing', async () => {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  try {
    store.createAgent({ id: 'milo', name: 'Milo', model_id: MODEL, budget_cap_usd: 100, current_status: 'IDLE' });
    const routine = store.createRoutine({ agentId: 'milo', name: 'honest-tweet', cronExpression: '*/15 * * * *', promptTemplate: 'Post one honest tweet.', nextRunAt: Date.now() });
    new GoalResults(store).saveRoutine('milo', routine.id, [ownerResult]);
    const llm = new ScriptedLLM([{ tool: 'declare_results', requirements: [modelResult] }, { tool: 'block', reason: 'Fixture stops here.' }]);
    const runtime = new WorkRuntime({ store, ledger, llm, sandbox: new MemorySandbox(), artifacts: new ArtifactStore(store) });
    const run = store.createTaskRun({ agentId: 'milo', taskName: ROUTINE_ASK_TASK, routineId: routine.id });
    store.startTaskRun(run.id, MODEL);
    await runtime.execute({ taskRunId: run.id, contract: ROUTINE_ASK_CONTRACT, request: 'Post one honest tweet.',
      scheduled: { routineId: routine.id }, conversation: true, signal: new AbortController().signal });
    const call = store.getTaskEvents(run.id).map(event => ({ type: event.event_type, payload: JSON.parse(event.payload_json ?? '{}') }))
      .find(event => event.type === 'TOOL_CALL' && event.payload.tool === 'declare_results');
    assert.ok(call, 'the declaration was handled');
    assert.notEqual(call.payload.status, 'error', call.payload.summary);
    assert.match(call.payload.summary, /already has its result checklist/);
    const manifest = new GoalResults(store).manifest('milo', run.id)!;
    assert.deepEqual([manifest.revision, manifest.requirements.map(requirement => requirement.id)], [1, ['post']], 'the owner checklist is unchanged');
    assert.match(JSON.stringify(llm.requests[0].messages), /A required publication needs confirmation/);
  } finally {
    ledger.close();
    store.close();
  }
});

test('draft-only routine is told that no post is needed and inaccessible research can finish honestly', async () => {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  try {
    store.createAgent({ id: 'milo', name: 'Milo', model_id: MODEL, budget_cap_usd: 100, current_status: 'IDLE' });
    const routine = store.createRoutine({ agentId: 'milo', name: 'reply drafts', cronExpression: '0 * * * *', promptTemplate: 'Research and draft only. Never publish.', nextRunAt: Date.now() });
    const llm = new ScriptedLLM([{ tool: 'block', reason: 'Fixture stops here.' }]);
    const runtime = new WorkRuntime({ store, ledger, llm, sandbox: new MemorySandbox(), artifacts: new ArtifactStore(store) });
    const run = store.createTaskRun({ agentId: 'milo', taskName: ROUTINE_ASK_TASK, routineId: routine.id });
    store.startTaskRun(run.id, MODEL);
    await runtime.execute({ taskRunId: run.id, contract: ROUTINE_ASK_CONTRACT, request: routine.prompt_template,
      scheduled: { routineId: routine.id }, conversation: true, signal: new AbortController().signal });
    const prompt = JSON.stringify(llm.requests[0].messages);
    assert.match(prompt, /This routine has no required publication/);
    assert.match(prompt, /a truthful no-candidate result can complete the research/);
  } finally { ledger.close(); store.close(); }
});

// 2026-10-02: a draft-only routine failed every run with "Unresolved: Existing required publication (pending)".
// The requirement came from the routine's must-post switch, but nothing in the result said so, and the owner
// could not tell which setting to change.
test('a run held open by the must-post switch names that switch and how to turn it off', () => {
  const store = new AgentStore(':memory:');
  try {
    store.createAgent({ id: 'milo', name: 'Milo', model_id: MODEL, budget_cap_usd: 100, current_status: 'IDLE' });
    const routine = store.createRoutine({ agentId: 'milo', name: 'reply drafts', cronExpression: '0 * * * *', promptTemplate: 'Research and draft only. Never publish.', nextRunAt: Date.now() });
    new PublishPolicy(store, [xCreateTweet()]).set('milo', routine.id, true);
    const goals = new GoalResults(store);
    const expected = goals.routine('milo', routine.id);
    assert.match(expected[0]!.description, /must post on x\.com/);
    const run = store.createTaskRun({ agentId: 'milo', taskName: ROUTINE_ASK_TASK, routineId: routine.id });
    goals.define('milo', run.id, 0, expected, 'runtime', 'Snapshot of owner-defined routine results before execution.');
    saveWorkResult(store, run.id, { outcome: 'FAILED', report: 'Drafts saved; no post was made.', artifacts: [], turns: 1,
      inputTokens: 10, outputTokens: 10, actualCostUsd: 0, shadowCostUsd: 0 });
    const report = readWorkResult(store, run.id)!.report;
    assert.match(report, /“This routine must post on x\.com” switch/);
    assert.match(report, /turn that switch off/);
  } finally {
    store.close();
  }
});

test('removing a mistaken publication requirement does not leave an unresolved result label', () => {
  const store = new AgentStore(':memory:');
  try {
    store.createAgent({ id: 'milo', name: 'Milo', model_id: MODEL, budget_cap_usd: 100, current_status: 'IDLE' });
    const run = store.createTaskRun({ agentId: 'milo', taskName: ROUTINE_ASK_TASK });
    const goals = new GoalResults(store);
    goals.define('milo', run.id, 0, [ownerResult], 'owner', 'Initial result.');
    saveWorkResult(store, run.id, { outcome: 'FAILED', report: 'No post was made.', artifacts: [], turns: 1,
      inputTokens: 10, outputTokens: 10, actualCostUsd: 0, shadowCostUsd: 0 });
    assert.match(readWorkResult(store, run.id)!.report, /Unresolved: Publish one honest post/);

    goals.define('milo', run.id, 1, [], 'owner', 'This run requested reply drafts, not a publication.');
    assert.equal(goals.summary('milo', run.id).satisfaction, 'not-required');
    const revised = readWorkResult(store, run.id)!;
    assert.match(revised.report, /No required external result was declared for this run/);
    assert.doesNotMatch(revised.report, /Unresolved: Publish one honest post/);
  } finally {
    store.close();
  }
});
