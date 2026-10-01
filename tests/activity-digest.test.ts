import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { RoutineWorkProducer } from '../src/daemon/routine-producer.js';
import { ACTIVITY_DIGEST_TASK } from '../src/daemon/activity-digest.js';
import { findWorkContract, workTaskDefinition, type WorkContract } from '../src/daemon/work-contract.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import type { LLMRequest } from '../src/evals/llm-client.js';

const NOW = Date.UTC(2026, 8, 14, 5, 0);
const MODEL = 'claude-haiku-4-5';

test('activity digest routine captures bounded local work and delivers a report with the snapshot provenance', async () => {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const routine = store.createRoutine({ id: 'morning', agentId: 'alpha', name: 'Morning digest', cronExpression: '0 8 * * *', timezone: 'Asia/Riyadh',
    promptTemplate: 'Summarise what changed overnight and list anything that needs a decision.', taskName: ACTIVITY_DIGEST_TASK, nextRunAt: NOW });
  const artifacts = new ArtifactStore(store);
  const finished = store.createTaskRun({ id: 'finished', agentId: 'alpha', taskName: 'release-check' });
  store.startTaskRun(finished.id, MODEL);
  artifacts.save(finished.id, { 'release-report.md': 'Release checks passed.' });
  store.finishTaskRun(finished.id, 'COMPLETED');
  store.getDatabase().prepare('UPDATE task_runs SET started_at=?,completed_at=?,actual_cost_usd=? WHERE id=?').run(NOW - 3600_000, NOW - 3500_000, 0.02, finished.id);
  const active = store.createTaskRun({ id: 'active', agentId: 'alpha', taskName: 'review-change' });
  store.startTaskRun(active.id, MODEL);
  store.getDatabase().prepare('UPDATE task_runs SET started_at=? WHERE id=?').run(NOW - 1800_000, active.id);
  store.createApproval({ id: 'approval', taskRunId: active.id, agentId: 'alpha', kind: 'mcp-call', payload: { secret: 'must-not-enter-digest' } });

  const contract = findWorkContract('activity-digest')!;
  const producer = new RoutineWorkProducer({ maxQueueDepth: 5, now: () => NOW, getTaskDefinition: name => name === ACTIVITY_DIGEST_TASK ? workTaskDefinition(contract, contract.description) : undefined });
  try {
    await producer.start();
    assert.equal(await producer.produceNextTasks(store), 1);
    const digestRun = store.listRoutineRuns(routine.id)[0];
    const definition = store.getRunDefinition(digestRun.id) as { work: { contract: WorkContract; request: string; sourceOrigin?: string } };
    assert.equal(definition.work.contract.id, 'activity-digest');
    assert.match(definition.work.sourceOrigin!, /^Configured routine instruction plus local OpenAgents activity snapshot generated from SQLite/);
    assert.match(definition.work.request, /"completed":1/);
    assert.match(definition.work.request, /"pendingApprovals":1/);
    assert.match(definition.work.request, /"artifacts":\["release-report\.md"\]/);
    assert.doesNotMatch(definition.work.request, /must-not-enter-digest/, 'approval payloads are excluded from the digest source');

    const report = { title: 'Morning activity digest', findings: [
      { claim: 'One completed run is recorded.', evidence: [{ sourceId: 'request', quote: '"completed":1' }] },
      { claim: 'One operator approval is pending.', evidence: [{ sourceId: 'request', quote: '"pendingApprovals":1' }] },
    ], limitations: ['The source covers local OpenAgents metadata only; it did not inspect Git or external services.'] };
    const steps: unknown[] = [{ tool: 'write', path: 'report.json', content: JSON.stringify(report) }, { tool: 'verify' }, { tool: 'finish' }];
    const llm = { async generateCode(_request: LLMRequest) { const action = steps.shift(); assert.ok(action); return { content: JSON.stringify(action), inputTokens: 10, outputTokens: 10, attemptCount: 1 }; } };
    const forbidden = async () => { throw new Error('Activity reports must not create a Docker workspace.'); };
    const runtime = new WorkRuntime({ store, ledger, llm, artifacts, sandbox: { createWorkspaceVolume: forbidden } as never });
    store.startTaskRun(digestRun.id, MODEL);
    const result = await runtime.execute({ taskRunId: digestRun.id, contract: definition.work.contract, request: definition.work.request,
      sourceOrigin: definition.work.sourceOrigin, signal: new AbortController().signal });
    assert.equal(result.outcome, 'COMPLETED', result.report);
    const sourcesArtifact = result.artifacts.find(artifact => artifact.path === 'sources.json')!;
    const sources = JSON.parse(artifacts.read(digestRun.id, sourcesArtifact.id)!.content);
    assert.match(sources[0].origin, /^Configured routine instruction plus local OpenAgents activity snapshot generated from SQLite/);
    assert.equal(steps.length, 0);
  } finally { await producer.stop(); ledger.close(); store.close(); }
});
