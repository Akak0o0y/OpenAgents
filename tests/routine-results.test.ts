import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { WorkRuntime, type WorkRuntimeOptions } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { ROUTINE_ASK_CONTRACT, ROUTINE_ASK_TASK } from '../src/daemon/work-contract.js';
import { GoalResults } from '../src/daemon/goal-results.js';
import type { ILLMClient, LLMRequest } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';

class ScriptedLLM implements ILLMClient {
  constructor(private actions: unknown[]) {}
  async generateCode(_request: LLMRequest) {
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
  } finally {
    ledger.close();
    store.close();
  }
});
