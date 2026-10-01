import fs from 'node:fs';
import { AgentStore } from '../../dist/src/daemon/agent-store.js';
import { CostLedger } from '../../dist/src/kernel/cost-ledger.js';
import { ArtifactStore } from '../../dist/src/daemon/artifacts.js';
import { WorkRuntime } from '../../dist/src/daemon/work-runtime.js';
import { MissionService } from '../../dist/src/daemon/missions.js';
import { TaskScheduler } from '../../dist/src/daemon/scheduler.js';
import { ProviderRouter } from '../../dist/src/daemon/provider-router.js';
import { ChatService } from '../../dist/src/daemon/chat.js';
import { DIRECT_WORK_CONTRACTS } from '../../dist/src/daemon/work-contract.js';

// Runs one checked plan to finalization through the scheduler (mission) or chat (direct request)
// and terminates this process with SIGKILL at the named finalization boundary.
const [dbPath, mode, boundary, marker] = process.argv.slice(2);
const store = new AgentStore(dbPath);
const ledger = new CostLedger(store.getDatabase());
if (!store.getAgent('alpha')) store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'claude-haiku-4-5', budget_cap_usd: 10, current_status: 'IDLE' });
const plan = { title: 'Release plan', tasks: [{ id: 'check', title: 'Check release', doneWhen: 'Release test report exists', priority: 1, dependsOn: [] }], limitations: ['No date was supplied.'] };
const actions = [{ tool: 'write', path: 'plan.json', content: JSON.stringify(plan) }, { tool: 'verify' },
  mode === 'mission'
    ? { tool: 'finish', mission: { state: 'continue', reason: 'Plan delivered; report remains.', nextRequest: 'Report the supplied statement.', nextContractId: 'evidence-brief' } }
    : { tool: 'finish' }];
const llm = { async generateCode() { const action = actions.shift(); if (!action) throw new Error('No scripted action.'); return { content: JSON.stringify(action), inputTokens: 10, outputTokens: 10, attemptCount: 1 }; } };
const forbidden = async () => { throw new Error('A plan must not request a Docker workspace.'); };
const sandbox = { createWorkspaceVolume: forbidden, stageWorkspaceFiles: forbidden, readWorkspaceFile: forbidden, executeTask: forbidden, destroyWorkspaceVolume: forbidden };
const onFinalizeStage = stage => { if (stage === boundary) { fs.writeFileSync(marker, stage); process.kill(process.pid, 'SIGKILL'); } };
const workRuntime = new WorkRuntime({ store, ledger, llm, sandbox, artifacts: new ArtifactStore(store), contracts: DIRECT_WORK_CONTRACTS, onFinalizeStage });

if (mode === 'code-recheck') {
  // Resumes sealed checked code and terminates while its fixed contract checks are running again.
  const { VerifiedWorkStore, contractSha256 } = await import('../../dist/src/daemon/work-checkpoints.js');
  const contract = DIRECT_WORK_CONTRACTS.find(c => c.id === 'cli-arg-parser');
  const files = { ...contract.initialFiles, 'src/index.js': 'export function parseArgs(argv) { return { flags: {}, positional: argv }; }\n' };
  const start = name => { const run = store.createTaskRun({ agentId: 'alpha', taskName: name }); store.startTaskRun(run.id, 'claude-haiku-4-5'); return run; };
  const artifacts = new ArtifactStore(store), prior = start('checked-code');
  new VerifiedWorkStore(store, artifacts).save({ state: 'verified', runId: prior.id, contractId: contract.id, contractSha256: contractSha256(contract), kind: 'code', revision: 1, verifiedAt: new Date().toISOString(), files });
  store.finishTaskRun(prior.id, 'FAILED', 'Provider stopped after verification.');
  const resumed = start('resumed-code');
  fs.writeFileSync(`${marker}.id`, JSON.stringify({ prior: prior.id, resumed: resumed.id }));
  const volumes = new Map();
  const codeSandbox = {
    async createWorkspaceVolume(id) { volumes.set(id, {}); return id; },
    async stageWorkspaceFiles(id, staged) { Object.assign(volumes.get(id), staged); },
    async readWorkspaceFile(id, file) { return { content: volumes.get(id)[file], truncated: false }; },
    async executeTask(_id, command) { if (command === contract.testCommand && boundary === 'recheck') { fs.writeFileSync(marker, 'recheck'); process.kill(process.pid, 'SIGKILL'); } return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }; },
    async destroyWorkspaceVolume(id) { volumes.delete(id); },
  };
  await new WorkRuntime({ store, ledger, llm: { async generateCode() { return { content: JSON.stringify({ tool: 'finish' }), inputTokens: 1, outputTokens: 1, attemptCount: 1 }; } }, sandbox: codeSandbox, artifacts })
    .execute({ taskRunId: resumed.id, contract, request: 'Continue the parser.', prior: { runId: prior.id }, signal: new AbortController().signal });
} else if (mode === 'mission') {
  const missions = new MissionService(store, DIRECT_WORK_CONTRACTS, 1);
  const mission = missions.create({ agentId: 'alpha', objective: 'Plan the release, then report the supplied statement.', contractId: 'action-plan', maxRuns: 3, intervalMs: 60000 });
  fs.writeFileSync(`${marker}.id`, mission.id);
  await missions.start();
  new TaskScheduler({ agentStore: store, ledger, sandbox, providerRouter: new ProviderRouter(), llmClient: llm, workRuntime, maxConcurrency: 1, cadenceMs: 10,
    executor: 'builtin', canRun: id => missions.canRun(id), workProducer: missions }).start();
} else {
  const chat = new ChatService({ agentStore: store, ledger, llmClient: llm, workRuntime });
  const thread = chat.createThread('alpha');
  fs.writeFileSync(`${marker}.id`, thread.id);
  await chat.send(thread.id, 'Plan the release.', 'crash-request', 'action-plan');
}
// Reaching this point means the boundary was never crossed.
await new Promise(resolve => setTimeout(resolve, 5000));
fs.writeFileSync(`${marker}.survived`, 'no kill');
process.exit(0);
