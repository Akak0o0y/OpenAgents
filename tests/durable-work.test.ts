import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import type { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { ArtifactStore, VERIFIED_WORK_CATEGORY } from '../src/daemon/artifacts.js';
import { WorkRuntime, type WorkRuntimeOptions } from '../src/daemon/work-runtime.js';
import { ChatService } from '../src/daemon/chat.js';
import { MissionService, MISSION_RESUME } from '../src/daemon/missions.js';
import { MemoryService } from '../src/daemon/memory.js';
import { TaskScheduler, type TaskDefinition } from '../src/daemon/scheduler.js';
import { ProviderRouter } from '../src/daemon/provider-router.js';
import { RunCapacity } from '../src/daemon/run-capacity.js';
import { RetentionService } from '../src/daemon/retention.js';
import { DIRECT_WORK_CONTRACTS, findWorkContract } from '../src/daemon/work-contract.js';
import { checkDeliverable } from '../src/daemon/deliverable-checks.js';
import { VerifiedWorkStore, checkedWorkSummary, contractSha256, readVerifiedWork } from '../src/daemon/work-checkpoints.js';
import { readWorkResult, saveWorkResult } from '../src/daemon/work-results.js';
import type { McpRegistry } from '../src/daemon/mcp-registry.js';
import type { ApprovalGate } from '../src/daemon/control-plane.js';
import { ProviderCallError, type LLMRequest } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';
const plan = { title: 'Release plan', tasks: [{ id: 'check', title: 'Check release', doneWhen: 'Release test report exists', priority: 1, dependsOn: [] }], limitations: ['No date was supplied.'] };
const writePlan = (value: unknown = plan) => ({ tool: 'write', path: 'plan.json', content: JSON.stringify(value) });
const checkedPlan = checkDeliverable('plan', JSON.stringify(plan), []);
const continueDecision = { tool: 'finish', mission: { state: 'continue', reason: 'Plan delivered; report remains.', nextRequest: 'Report the supplied statement.', nextContractId: 'evidence-brief' } };
const overloaded = () => { throw new ProviderCallError('HTTP_ERROR', 'Upstream error from Nvidia: Service temporarily overloaded', { status: 502 }); };
const forbidden = async () => { throw new Error('Plans must not request a Docker workspace.'); };
const noDocker = { createWorkspaceVolume: forbidden, stageWorkspaceFiles: forbidden, readWorkspaceFile: forbidden, executeTask: forbidden, destroyWorkspaceVolume: forbidden };

/** Actions are consumed in order; a function step can observe state, change it or throw like a provider. */
function scripted(steps: unknown[]) {
  const requests: LLMRequest[] = [];
  const llm = { async generateCode(req: LLMRequest) {
    requests.push(req);
    const step = steps.shift();
    assert.ok(step !== undefined, 'No scripted extra model call');
    const action = typeof step === 'function' ? await (step as () => unknown)() : step;
    return { content: JSON.stringify(action), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
  } };
  return { llm, requests };
}
function profile(db = ':memory:') {
  const store = new AgentStore(db);
  const ledger = new CostLedger(store.getDatabase());
  if (!store.getAgent('alpha')) store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const events: Array<{ type: string; payload: any }> = [];
  store.setEventSink(event => events.push({ type: event.event_type, payload: JSON.parse(event.payload_json) }));
  return { store, ledger, events, close() { ledger.close(); store.close(); } };
}
const count = (store: AgentStore, sql: string, ...args: string[]) => Number((store.getDatabase().prepare(sql).get(...args) as { n: number }).n);
const startRun = (store: AgentStore, taskName: string, agentId = 'alpha') => { const run = store.createTaskRun({ agentId, taskName }); store.startTaskRun(run.id, MODEL); return run; };

test('direct requests keep exact checked bytes after a provider failure, budget stop or cancellation, without another model call', async () => {
  for (const stop of ['provider', 'budget', 'cancel'] as const) {
    const h = profile();
    const capacity = new RunCapacity(1);
    let chat!: ChatService, threadId = '';
    const { llm, requests } = scripted([writePlan(),
      () => { if (stop === 'budget') h.store.updateAgent('alpha', { budget_cap_usd: 0 }); return { tool: 'verify' }; },
      () => { if (stop === 'cancel') { assert.equal(chat.abortRequest(threadId, 'request'), true); throw new Error('The caller cancelled the request.'); } return overloaded(); }]);
    const runtime = new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker, artifacts: new ArtifactStore(h.store) });
    chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: llm, workRuntime: runtime, capacity });
    threadId = chat.createThread('alpha').id;
    try {
      const result = await chat.send(threadId, 'Plan the release.', 'request', 'action-plan');
      const work = result.work!, expected = stop === 'cancel' ? 'ABORTED' : 'FAILED';
      assert.equal(work.outcome, expected, stop);
      assert.equal(h.store.getTaskRun(result.taskRunId)?.status, expected);
      assert.equal(new ArtifactStore(h.store).list(result.taskRunId).length, 0, 'no delivery is published');
      assert.equal(work.checkedWork?.available, true);
      assert.equal(work.checkedWork?.revision, 1);
      assert.deepEqual(work.checkedWork?.files.map(f => f.path).sort(), ['plan.json', 'plan.md']);
      assert.deepEqual(readVerifiedWork(h.store, result.taskRunId)?.files, checkedPlan, 'the exact checked bytes are recoverable');
      assert.match(work.report, /retained for inspection\. It is not a completed delivery\./, 'direct requests have no resume operation');
      const calls = stop === 'budget' ? 2 : 3;
      assert.equal(requests.length, calls, 'no further provider request is made');
      assert.deepEqual(await chat.send(threadId, 'Plan the release.', 'request', 'action-plan'), result, 'the committed response replays');
      assert.deepEqual(await chat.send(threadId, 'Plan the release.', 'request', 'action-plan'), result, 'and replays again');
      assert.equal(requests.length, calls);
      assert.equal(capacity.used, 0);
      assert.equal(h.events.filter(e => e.type === 'TASK_COMPLETED' || e.type === 'ARTIFACT_CREATED').length, 0);
    } finally { await chat.stop(); h.close(); }
  }
});

test('a later write, an interrupted shell command or an interrupted MCP action invalidates persisted checks before dispatch', async () => {
  {
    const h = profile();
    const { llm } = scripted([writePlan(), { tool: 'verify' }, writePlan({ ...plan, title: 'Changed plan' }), { tool: 'finish' }, overloaded]);
    const run = startRun(h.store, 'stale-write');
    try {
      const result = await new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker, artifacts: new ArtifactStore(h.store) })
        .execute({ taskRunId: run.id, contract: findWorkContract('action-plan')!, request: 'Plan the release.', signal: new AbortController().signal });
      assert.equal(result.outcome, 'FAILED');
      assert.equal(result.artifacts.length, 0);
      assert.equal(result.checkedWork?.available, false);
      assert.match(result.checkedWork!.reason!, /Invalidated by write/);
      const record = readVerifiedWork(h.store, run.id)!;
      assert.equal(record.state, 'invalidated');
      assert.equal(record.files, undefined, 'stale bytes are not retained');
      assert.ok(h.store.getTaskEvents(run.id).some(e => e.event_type === 'TOOL_CALL' && /Completion refused/.test(e.payload_json)), 'stale checks cannot finalize');
    } finally { h.close(); }
  }
  {
    const h = profile();
    const contract = findWorkContract('cli-arg-parser')!;
    const good = 'export function parseArgs(argv) { return { flags: {}, positional: argv }; }\n';
    const volumes = new Map<string, Record<string, string>>();
    let runId = '', stateAtDispatch: string | undefined;
    const sandbox: WorkRuntimeOptions['sandbox'] = {
      async createWorkspaceVolume(id) { volumes.set(id, {}); return id; },
      async stageWorkspaceFiles(id, files) { Object.assign(volumes.get(id)!, files); },
      async readWorkspaceFile(id, file) { return { content: volumes.get(id)![file], truncated: false }; },
      async executeTask(id, command) {
        if (command === contract.testCommand) return { exitCode: volumes.get(id)!['src/index.js'] === good ? 0 : 1, stdout: 'Fixture checks', stderr: '', durationMs: 1, timedOut: false };
        stateAtDispatch = readVerifiedWork(h.store, runId)?.state;
        throw new Error('The shell command was interrupted.');
      },
      async destroyWorkspaceVolume(id) { volumes.delete(id); },
    };
    const { llm } = scripted([{ tool: 'write', path: 'src/index.js', content: good }, { tool: 'verify' }, { tool: 'run', command: 'node src/index.js' }, { tool: 'finish' }, { tool: 'block', reason: 'Stopped after the interrupted command.' }]);
    const run = startRun(h.store, 'stale-run'); runId = run.id;
    try {
      const result = await new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox, artifacts: new ArtifactStore(h.store) })
        .execute({ taskRunId: run.id, contract, request: 'Implement the parser.', signal: new AbortController().signal });
      assert.equal(stateAtDispatch, 'invalidated', 'invalidation is durable before the shell command is dispatched');
      assert.equal(result.outcome, 'FAILED');
      assert.equal(result.artifacts.length, 0);
      assert.equal(result.checkedWork?.available, false);
      assert.ok(h.store.getTaskEvents(run.id).some(e => e.event_type === 'TOOL_CALL' && /Completion refused/.test(e.payload_json)));
    } finally { h.close(); }
  }
  {
    const h = profile();
    let runId = '', stateAtDispatch: string | undefined;
    const mcp = { toolsForAgent: () => [{ server: 'tickets', name: 'create', description: 'Create a ticket', inputSchema: {} }], endRun() {},
      async call() { stateAtDispatch = readVerifiedWork(h.store, runId)?.state; throw new Error('Connection lost during the call.'); } } as unknown as McpRegistry;
    const approvals = { async request() { return { status: 'APPROVED' }; } } as unknown as ApprovalGate;
    const { llm } = scripted([writePlan(), { tool: 'verify' }, { tool: 'mcp', server: 'tickets', name: 'create', args: { title: 'Release' } }]);
    const run = startRun(h.store, 'stale-mcp'); runId = run.id;
    try {
      const result = await new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker, artifacts: new ArtifactStore(h.store), mcp, approvals })
        .execute({ taskRunId: run.id, contract: findWorkContract('action-plan')!, request: 'Plan and file a ticket.', signal: new AbortController().signal });
      assert.equal(stateAtDispatch, 'invalidated', 'invalidation is durable before the external action is dispatched');
      assert.equal(result.outcome, 'FAILED');
      assert.match(result.report, /External action outcome is uncertain/);
      assert.equal(result.checkedWork?.available, false);
      const events = h.store.getTaskEvents(run.id);
      assert.equal(events.filter(e => e.event_type === 'EXTERNAL_ACTION_STARTED').length, 1);
      assert.equal(events.filter(e => e.event_type === 'EXTERNAL_ACTION_FINISHED').length, 0, 'the uncertain effect is left for operator reconciliation');
    } finally { h.close(); }
  }
});

test('a failed finalization transaction rolls back files, result, decision and status together and broadcasts no completion', async () => {
  {
    const h = profile();
    const now = Date.now();
    let injected = 0;
    const { llm, requests } = scripted([writePlan(), { tool: 'verify' }, continueDecision]);
    const capacity = new RunCapacity(1);
    const missions = new MissionService(h.store, DIRECT_WORK_CONTRACTS, 1, () => now);
    const runtime = new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker, artifacts: new ArtifactStore(h.store), contracts: DIRECT_WORK_CONTRACTS,
      onFinalizeStage: stage => { if (stage === 'artifacts-saved') { injected++; throw new Error('Injected finalization failure.'); } } });
    const scheduler = new TaskScheduler({ agentStore: h.store, ledger: h.ledger, sandbox: noDocker as unknown as DockerSandbox, providerRouter: new ProviderRouter(), llmClient: llm,
      workRuntime: runtime, capacity, maxConcurrency: 1, cadenceMs: 10, executor: 'builtin', canRun: id => missions.canRun(id), workProducer: missions });
    const id = missions.create({ agentId: 'alpha', objective: 'Plan the release, then report.', contractId: 'action-plan', maxRuns: 2, intervalMs: 60000 }).id;
    const row = () => missions.list().find(m => m.id === id)!;
    try {
      await missions.start(); scheduler.start();
      for (let i = 0; i < 500 && row().status !== 'WAITING'; i++) await delay(10);
      await scheduler.stop();
      assert.equal(row().status, 'WAITING');
      const runId = (h.store.getDatabase().prepare('SELECT id FROM task_runs WHERE task_name = ?').get(`mission:${id}`) as { id: string }).id;
      assert.equal(injected, 1);
      assert.equal(requests.length, 3, 'a rolled-back finalization offers the model no further action');
      assert.equal(h.store.getTaskRun(runId)?.status, 'FAILED');
      assert.equal(count(h.store, 'SELECT COUNT(*) AS n FROM run_artifacts WHERE task_run_id = ?', runId), 0);
      const saved = readWorkResult(h.store, runId)!;
      assert.equal(saved.outcome, 'FAILED');
      assert.equal(saved.mission, undefined, 'the accepted decision rolled back with the files');
      assert.match(saved.report, /Finalization was rolled back/);
      assert.equal(saved.checkedWork?.available, true, 'checked work survives the rollback');
      for (const type of ['ARTIFACT_CREATED', 'MISSION_DECISION', 'TASK_COMPLETED']) {
        assert.equal(h.events.filter(e => e.type === type).length, 0, `no ${type} was broadcast`);
        assert.equal(h.store.getTaskEvents(runId).filter(e => e.event_type === type).length, 0, `no ${type} was persisted`);
      }
      assert.deepEqual(h.events.filter(e => e.type === 'WORK_REPORT').map(e => e.payload.outcome), ['FAILED']);
      assert.equal(capacity.used, 0);
    } finally { await scheduler.stop(); await missions.stop(); h.close(); }
  }
  {
    const h = profile();
    const capacity = new RunCapacity(1);
    const { llm, requests } = scripted([writePlan(), { tool: 'verify' }, { tool: 'finish' }]);
    const runtime = new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker, artifacts: new ArtifactStore(h.store),
      onFinalizeStage: stage => { if (stage === 'caller-committed') throw new Error('Injected failure after the caller wrote its reply.'); } });
    const chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: llm, workRuntime: runtime, capacity });
    const thread = chat.createThread('alpha');
    try {
      const result = await chat.send(thread.id, 'Plan the release.', 'request', 'action-plan');
      assert.equal(result.work?.outcome, 'FAILED');
      assert.equal(requests.length, 3);
      assert.equal(h.store.getTaskRun(result.taskRunId)?.status, 'FAILED');
      assert.equal(count(h.store, 'SELECT COUNT(*) AS n FROM run_artifacts'), 0);
      const replies = h.store.getMessages(thread.id).filter(m => m.role === 'assistant');
      assert.equal(replies.length, 1, 'the rolled-back reply is not kept beside the failure reply');
      assert.match(replies[0].content, /Finalization was rolled back/);
      assert.equal(h.events.filter(e => e.type === 'TASK_COMPLETED' || e.type === 'ARTIFACT_CREATED').length, 0);
      assert.equal(readWorkResult(h.store, result.taskRunId)?.checkedWork?.available, true);
      assert.deepEqual(await chat.send(thread.id, 'Plan the release.', 'request', 'action-plan'), result);
      assert.equal(capacity.used, 0);
    } finally { await chat.stop(); h.close(); }
  }
});

test('operator resume reuses valid checked work once; repeated resume never duplicates delivery or continuation', { timeout: 30000 }, async () => {
  const h = profile();
  let now = Date.now();
  const steps: unknown[] = [writePlan(), { tool: 'verify' }, overloaded];
  const { llm, requests } = scripted(steps);
  const capacity = new RunCapacity(1);
  const missions = new MissionService(h.store, DIRECT_WORK_CONTRACTS, 1, () => now);
  const runtime = new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker, artifacts: new ArtifactStore(h.store), contracts: DIRECT_WORK_CONTRACTS });
  const scheduler = new TaskScheduler({ agentStore: h.store, ledger: h.ledger, sandbox: noDocker as unknown as DockerSandbox, providerRouter: new ProviderRouter(), llmClient: llm,
    workRuntime: runtime, capacity, maxConcurrency: 1, cadenceMs: 10, executor: 'builtin', canRun: id => missions.canRun(id), workProducer: missions });
  const id = missions.create({ agentId: 'alpha', objective: 'Plan the release, then report the supplied statement.', contractId: 'action-plan', maxRuns: 3, intervalMs: 60000 }).id;
  const row = () => missions.list().find(m => m.id === id)!;
  const runs = () => h.store.getDatabase().prepare('SELECT id, status FROM task_runs WHERE task_name = ? ORDER BY rowid').all(`mission:${id}`) as { id: string; status: string }[];
  const settle = async (done: () => boolean) => { for (let i = 0; i < 1000 && !done(); i++) await delay(10); assert.ok(done(), `did not settle: ${row().status} ${row().reason}`); };
  try {
    await missions.start(); scheduler.start();
    await settle(() => row().status === 'WAITING');
    const [first] = runs();
    const checked = readWorkResult(h.store, first.id)!.checkedWork!;
    assert.equal(first.status, 'FAILED');
    assert.equal(checked.available, true);
    now += 3600000; await delay(150);
    assert.equal(requests.length, 3, 'checked work never triggers an automatic retry');
    assert.equal(runs().length, 1);

    steps.push(continueDecision);
    missions.control(id, 'ACTIVE'); missions.control(id, 'ACTIVE');
    await settle(() => runs().length === 2 && runs()[1].status === 'COMPLETED' && row().last_run_id === null);
    const second = runs()[1];
    assert.equal(requests.length, 4, 'the resumed attempt finished without re-verifying');
    assert.equal((h.store.getRunDefinition(second.id) as TaskDefinition).work?.prior?.runId, first.id);
    assert.match(requests[3].messages![0].content, /Prior checked work \(data\):.*Loaded and rechecked/);
    assert.deepEqual(new ArtifactStore(h.store).list(second.id).map(a => `${a.path}:${a.sha256}`).sort(), checked.files.map(f => `${f.path}:${f.sha256}`).sort(), 'the published files are the checked bytes');
    assert.ok(h.store.getTaskEvents(second.id).some(e => e.event_type === 'CHECKED_WORK_REUSED'));
    assert.equal(readVerifiedWork(h.store, first.id), null, 'the checked record moved to the resumed attempt');
    assert.equal(readVerifiedWork(h.store, second.id), null, 'publication removed the checked record');
    assert.equal(readWorkResult(h.store, first.id)?.checkedWork?.available, false);
    assert.equal(h.store.getAgentData('alpha', id, MISSION_RESUME), null);
    assert.equal(count(h.store, 'SELECT COUNT(*) AS n FROM run_artifacts'), 2);

    steps.push({ tool: 'block', reason: 'The statement to report was not supplied.', blocker: { kind: 'missing_input', detail: 'No statement was supplied.', resumeWhen: 'The operator supplies the statement.' } });
    missions.control(id, 'ACTIVE'); missions.control(id, 'ACTIVE');
    await settle(() => runs().length === 3 && row().status === 'WAITING');
    await delay(150);
    assert.equal(runs().length, 3, 'one continuation despite repeated resume');
    assert.equal((h.store.getRunDefinition(runs()[2].id) as TaskDefinition).work?.contract.id, 'evidence-brief');
    assert.equal((h.store.getRunDefinition(runs()[2].id) as TaskDefinition).work?.prior, undefined);
    assert.equal(count(h.store, "SELECT COUNT(*) AS n FROM task_runs WHERE status = 'COMPLETED'"), 1);
    assert.equal(count(h.store, 'SELECT COUNT(*) AS n FROM run_artifacts'), 2);
    assert.equal(capacity.used, 0);
  } finally { await scheduler.stop(); await missions.stop(); h.close(); }
});

test('changed contracts, another bot and altered retained bytes never reuse checked work without verification', async () => {
  const h = profile();
  const contract = findWorkContract('action-plan')!;
  const signal = () => new AbortController().signal;
  const runtime = (steps: unknown[]) => { const s = scripted(steps); return { ...s, runtime: new WorkRuntime({ store: h.store, ledger: h.ledger, llm: s.llm, sandbox: noDocker, artifacts: new ArtifactStore(h.store) }) }; };
  try {
    const prior = startRun(h.store, 'prior');
    await runtime([writePlan(), { tool: 'verify' }, overloaded]).runtime.execute({ taskRunId: prior.id, contract, request: 'Plan the release.', signal: signal() });
    assert.equal(readVerifiedWork(h.store, prior.id)?.state, 'verified');

    const changed = { ...contract, requirements: [...contract.requirements, 'Name an owner for every task.'] };
    const resumed = runtime([{ tool: 'finish' }, writePlan(), { tool: 'verify' }, { tool: 'finish' }]);
    const run = startRun(h.store, 'changed-contract');
    const result = await resumed.runtime.execute({ taskRunId: run.id, contract: changed, request: 'Plan the release.', prior: { runId: prior.id }, signal: signal() });
    assert.match(resumed.requests[0].messages![0].content, /Not reused\..*contract changed after verification/);
    assert.ok(h.store.getTaskEvents(run.id).some(e => e.event_type === 'TOOL_CALL' && /Completion refused/.test(e.payload_json)));
    assert.equal(result.outcome, 'COMPLETED');
    assert.equal(h.store.getTaskEvents(run.id).filter(e => e.event_type === 'WORK_VERIFIED').length, 1, 'completion required fresh verification');
    assert.equal(readVerifiedWork(h.store, prior.id)?.state, 'verified', 'unused prior work is left in place');

    h.store.createAgent({ id: 'beta', name: 'Beta', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
    const foreign = runtime([{ tool: 'block', reason: 'Nothing to reuse.' }]);
    await foreign.runtime.execute({ taskRunId: startRun(h.store, 'foreign', 'beta').id, contract, request: 'Plan the release.', prior: { runId: prior.id }, signal: signal() });
    assert.match(foreign.requests[0].messages![0].content, /Not reused\..*No checked work is retained/);

    const record = readVerifiedWork(h.store, prior.id)!;
    h.store.setAgentData({ agentId: 'alpha', taskRunId: prior.id, category: VERIFIED_WORK_CATEGORY, key: prior.id, data: { ...record, files: { ...record.files, 'plan.md': 'altered' } } });
    const altered = runtime([{ tool: 'block', reason: 'Nothing to reuse.' }]);
    await altered.runtime.execute({ taskRunId: startRun(h.store, 'altered').id, contract, request: 'Plan the release.', prior: { runId: prior.id }, signal: signal() });
    assert.match(altered.requests[0].messages![0].content, /Not reused\..*do not match their verified manifest/);
  } finally { h.close(); }
});

test('hard termination at finalization boundaries leaves no delivery or one coherent delivery, never a duplicate', { timeout: 180000 }, async () => {
  const fixture = path.resolve('tests/fixtures/finalization-crash-child.mjs');
  for (const mode of ['mission', 'direct'] as const) for (const boundary of ['artifacts-saved', 'caller-committed', 'committed'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-finalize-crash-')), db = path.join(root, 'state.db'), marker = path.join(root, 'marker');
    const child = spawn(process.execPath, [fixture, db, mode, boundary, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    const label = `${mode} killed at ${boundary}`;
    assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : log, boundary, `${label}: the child must be terminated at the boundary`);
    assert.equal(fs.existsSync(`${marker}.survived`), false);
    const committed = boundary === 'committed';
    const store = new AgentStore(db), ledger = new CostLedger(store.getDatabase());
    try {
      store.markInFlightAsCrashed('Reopened after hard termination.');
      const [run] = store.getDatabase().prepare('SELECT id, status FROM task_runs ORDER BY rowid').all() as { id: string; status: string }[];
      const result = readWorkResult(store, run.id);
      if (committed) {
        assert.equal(run.status, 'COMPLETED', label);
        assert.equal(count(store, 'SELECT COUNT(*) AS n FROM run_artifacts'), 2);
        assert.equal(result?.outcome, 'COMPLETED');
        assert.equal(store.getTaskEvents(run.id).filter(e => e.event_type === 'TASK_COMPLETED').length, 1);
        assert.equal(readVerifiedWork(store, run.id), null);
      } else {
        assert.equal(run.status, 'CRASHED', label);
        assert.equal(count(store, 'SELECT COUNT(*) AS n FROM run_artifacts'), 0, `${label}: no orphaned published files`);
        assert.equal(result, null, `${label}: no saved result`);
        assert.equal(store.getTaskEvents(run.id).filter(e => ['TASK_COMPLETED', 'ARTIFACT_CREATED', 'MISSION_DECISION'].includes(e.event_type)).length, 0);
        assert.equal(readVerifiedWork(store, run.id)?.state, 'verified', `${label}: checked work survives`);
      }
      const id = fs.readFileSync(`${marker}.id`, 'utf8');
      if (mode === 'mission') {
        let now = Date.now();
        const missions = new MissionService(store, DIRECT_WORK_CONTRACTS, 1, () => now);
        await missions.start();
        await missions.produceNextTasks(store); await missions.produceNextTasks(store);
        now += 120000;
        assert.equal(await missions.produceNextTasks(store), 1, label);
        assert.equal(await missions.produceNextTasks(store), 0, label);
        const all = store.getDatabase().prepare('SELECT id FROM task_runs ORDER BY rowid').all() as { id: string }[];
        assert.equal(all.length, 2, `${label}: exactly one next attempt or continuation`);
        assert.equal((store.getRunDefinition(all[1].id) as TaskDefinition).work?.contract.id, committed ? 'evidence-brief' : 'action-plan');
        assert.equal(missions.list().find(m => m.id === id)?.runs, 2);
        await missions.stop();
      } else {
        const refuse = { async generateCode(): Promise<never> { throw new Error('Replay must not call the model.'); } };
        const chat = new ChatService({ agentStore: store, ledger, llmClient: refuse, workRuntime: new WorkRuntime({ store, ledger, llm: refuse, sandbox: noDocker, artifacts: new ArtifactStore(store) }) });
        try {
          if (committed) {
            const replay = await chat.send(id, 'Plan the release.', 'crash-request', 'action-plan');
            assert.equal(replay.work?.outcome, 'COMPLETED');
            assert.equal(replay.taskRunId, run.id);
            assert.deepEqual(await chat.send(id, 'Plan the release.', 'crash-request', 'action-plan'), replay);
          } else {
            await assert.rejects(chat.send(id, 'Plan the release.', 'crash-request', 'action-plan'), /interrupted with an unknown provider outcome/);
          }
          assert.equal(count(store, 'SELECT COUNT(*) AS n FROM run_artifacts'), committed ? 2 : 0);
          assert.equal(count(store, 'SELECT COUNT(*) AS n FROM task_runs'), 1, `${label}: replay creates no run`);
        } finally { await chat.stop(); }
      }
    } finally { ledger.close(); store.close(); }
  }
});

test('checked work counts toward storage caps and retention keeps resumable or held work while cleaning the rest', async () => {
  const h = profile();
  try {
    new MemoryService(h.store); new MissionService(h.store, DIRECT_WORK_CONTRACTS, 1);
    const contract = findWorkContract('action-plan')!;
    const record = (runId: string, revision = 1) => ({ state: 'verified' as const, runId, contractId: contract.id, contractSha256: contractSha256(contract), kind: 'plan' as const,
      revision, verifiedAt: new Date(0).toISOString(), files: checkedPlan });
    const a = startRun(h.store, 'a');
    const roomy = new ArtifactStore(h.store);
    assert.equal(new VerifiedWorkStore(h.store, roomy).save(record(a.id)).available, true);
    const used = roomy.storedBytes();
    assert.ok(used > 0, 'checked work is counted');
    const tight = new ArtifactStore(h.store, used + 10);
    assert.throws(() => tight.save(a.id, { 'extra.txt': 'x'.repeat(64) }), /storage limit/, 'published files cannot bypass the space checked work occupies');
    const b = startRun(h.store, 'b');
    const refused = new VerifiedWorkStore(h.store, tight).save(record(b.id));
    assert.equal(refused.available, false);
    assert.match(refused.reason!, /not retained: Installation artifact storage limit/);
    assert.equal(readVerifiedWork(h.store, b.id), null);
    const replaced = new VerifiedWorkStore(h.store, tight).save(record(a.id, 2));
    assert.equal(replaced.available, true, 'replacing a record releases its own bytes');

    const c = startRun(h.store, 'c'), held = startRun(h.store, 'held');
    new VerifiedWorkStore(h.store, roomy).save(record(c.id));
    new VerifiedWorkStore(h.store, roomy).save(record(held.id));
    for (const run of [a, b, c, held]) h.store.finishTaskRun(run.id, 'FAILED', 'Provider failed after verification.');
    saveWorkResult(h.store, a.id, { outcome: 'FAILED', report: 'Stopped.', artifacts: [], checkedWork: replaced, turns: 3, inputTokens: 1, outputTokens: 1, actualCostUsd: 0, shadowCostUsd: 0 });
    h.store.setAgentData({ agentId: 'alpha', taskRunId: held.id, category: 'retention', key: 'hold', data: { note: 'Keep for review' } });
    h.store.setAgentData({ agentId: 'alpha', taskRunId: c.id, category: MISSION_RESUME, key: 'mission-under-review', data: { runId: c.id } });
    h.store.getDatabase().prepare('UPDATE task_runs SET completed_at = ?').run(Date.now() - 40 * 86400000);
    const retention = new RetentionService(h.store, { workspaceVolumeName: id => id, destroyWorkspaceVolume: async () => {} });
    const { candidates } = await retention.clean(30);
    assert.ok(candidates.includes(a.id));
    assert.ok(!candidates.includes(c.id), 'work offered to a resumed mission is kept');
    assert.ok(!candidates.includes(held.id), 'holds are respected');
    assert.equal(readWorkResult(h.store, a.id)?.checkedWork?.available, true);
    await retention.clean(30, false);
    assert.equal(readVerifiedWork(h.store, a.id), null, 'cleanup removes unreferenced checked work');
    assert.equal(readWorkResult(h.store, a.id)?.checkedWork?.available, false, 'the saved result reports the removal');
    assert.equal(readVerifiedWork(h.store, c.id)?.state, 'verified');
    assert.equal(readVerifiedWork(h.store, held.id)?.state, 'verified');
  } finally { h.close(); }
});
