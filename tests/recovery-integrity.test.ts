import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { ArtifactStore, VERIFIED_WORK_CATEGORY } from '../src/daemon/artifacts.js';
import { WorkRuntime, type WorkRuntimeOptions } from '../src/daemon/work-runtime.js';
import { MissionService, MISSION_RESUME } from '../src/daemon/missions.js';
import { MemoryService } from '../src/daemon/memory.js';
import { TaskScheduler, type TaskDefinition } from '../src/daemon/scheduler.js';
import { ProviderRouter } from '../src/daemon/provider-router.js';
import { RetentionService } from '../src/daemon/retention.js';
import { DIRECT_WORK_CONTRACTS, findWorkContract, type WorkContract } from '../src/daemon/work-contract.js';
import { checkDeliverable, evidenceSource, type EvidenceSource } from '../src/daemon/deliverable-checks.js';
import { VerifiedWorkStore, contractSha256, manifestOf, readVerifiedWork, reusableCheckedWork } from '../src/daemon/work-checkpoints.js';
import { INTERNAL_DATA_CATEGORIES, publicAgentDataApi } from '../src/daemon/internal-data.js';
import { readWorkResult } from '../src/daemon/work-results.js';
import { fixtureFetch, DaemonWsServer } from './helpers/daemon-client.js';
import type { McpRegistry } from '../src/daemon/mcp-registry.js';
import type { ApprovalGate } from '../src/daemon/control-plane.js';
import { ProviderCallError, type LLMRequest } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const codeContract = findWorkContract('cli-arg-parser')!, planContract = findWorkContract('action-plan')!, reportContract = findWorkContract('evidence-brief')!;
const parser = `
export function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      flags[key] = rest.length ? rest.join('=') : key === 'verbose' ? true : argv[i+1] && !argv[i+1].startsWith('-') ? argv[++i] : true;
    } else if (arg === '-v') flags.v = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

`;
const brokenParser = 'export function parseArgs() { return { flags: {}, positional: [] }; }\n';
const plan = { title: 'Release plan', tasks: [{ id: 'check', title: 'Check release', doneWhen: 'Release test report exists', priority: 1, dependsOn: [] }], limitations: ['No date was supplied.'] };
const planFiles = checkDeliverable('plan', JSON.stringify(plan), []);
const reportOf = (...evidence: Array<{ sourceId: string; quote: string }>) => ({ title: 'Agreement', findings: evidence.map((e, i) => ({ claim: `Finding ${i + 1}`, evidence: [e] })), limitations: ['Supplied or tool material; not independently verified.'] });
const overloaded = () => { throw new ProviderCallError('HTTP_ERROR', 'Upstream error from Nvidia: Service temporarily overloaded', { status: 502 }); };
const continueDecision = { tool: 'finish', mission: { state: 'continue', reason: 'Plan delivered; report remains.', nextRequest: 'Report the supplied statement.', nextContractId: 'evidence-brief' } };
const forbidden = async () => { throw new Error('This contract must not request a Docker workspace.'); };
const noDocker = { createWorkspaceVolume: forbidden, stageWorkspaceFiles: forbidden, readWorkspaceFile: forbidden, executeTask: forbidden, destroyWorkspaceVolume: forbidden };
const signal = () => new AbortController().signal;

/** Steps run in order; a function step receives the request so it can inspect observations and context. */
function scripted(steps: unknown[]) {
  const requests: LLMRequest[] = [];
  const llm = { async generateCode(req: LLMRequest) {
    if (req.systemPrompt.includes('execution history summarizer')) {
      return { content: 'The report restored the original agreement and renewal-note source snapshots, then updated report.json. Source IDs remain in the runtime checkpoint.', inputTokens: 10, outputTokens: 10, attemptCount: 1 };
    }
    requests.push(req);
    const step = steps.shift();
    assert.ok(step !== undefined, 'No scripted extra model call');
    const action = typeof step === 'function' ? await (step as (r: LLMRequest) => unknown)(req) : step;
    return { content: JSON.stringify(action), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
  } };
  return { llm, requests };
}
function profile(db = ':memory:') {
  const store = new AgentStore(db);
  const ledger = new CostLedger(store.getDatabase());
  if (!store.getAgent('alpha')) store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  new MemoryService(store); new MissionService(store, DIRECT_WORK_CONTRACTS, 1);
  return { store, ledger, close() { ledger.close(); store.close(); } };
}
const startRun = (store: AgentStore, taskName: string, agentId = 'alpha') => { const run = store.createTaskRun({ agentId, taskName }); store.startTaskRun(run.id, MODEL); return run; };
const seal = (store: AgentStore, runId: string, contract: WorkContract, files: Record<string, string>) =>
  new VerifiedWorkStore(store, new ArtifactStore(store)).save({ state: 'verified', runId, contractId: contract.id, contractSha256: contractSha256(contract), kind: contract.kind ?? 'code', revision: 1, verifiedAt: new Date(0).toISOString(), files });
const tamper = (store: AgentStore, runId: string, change: (record: any) => any) => {
  const record = readVerifiedWork(store, runId)!, run = store.getTaskRun(runId)!;
  store.setAgentData({ agentId: run.agent_id, taskRunId: runId, category: VERIFIED_WORK_CATEGORY, key: runId, data: change(structuredClone(record)) });
};
const reasonOf = (outcome: ReturnType<typeof reusableCheckedWork>) => 'reason' in outcome ? outcome.reason : 'reused';
const count = (store: AgentStore, sql: string, ...args: string[]) => Number((store.getDatabase().prepare(sql).get(...args) as { n: number }).n);
function codeSandbox(passes: (files: Record<string, string>) => boolean, throwOnCheck = false) {
  const volumes = new Map<string, Record<string, string>>(), commands: string[] = [];
  const sandbox: WorkRuntimeOptions['sandbox'] = {
    async createWorkspaceVolume(id) { volumes.set(id, {}); return id; },
    async stageWorkspaceFiles(id, files) { Object.assign(volumes.get(id)!, files); },
    async readWorkspaceFile(id, file) { const content = volumes.get(id)![file]; if (content === undefined) throw new Error('Missing file'); return { content, truncated: false }; },
    async executeTask(id, command) {
      commands.push(command);
      if (throwOnCheck && command === codeContract.testCommand) throw new Error('The verification container could not start.');
      return { exitCode: passes(volumes.get(id)!) ? 0 : 1, stdout: 'Fixture checks', stderr: '', durationMs: 1, timedOut: false };
    },
    async destroyWorkspaceVolume(id) { volumes.delete(id); },
  };
  return { sandbox, commands };
}

test('the public data API refuses runtime-owned categories while ordinary bot data and holds stay editable', async () => {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const port = 4193;
  const server = new DaemonWsServer(port, () => ({ agents: store.listAgents(), taskRuns: store.listTaskRuns(), routines: store.listRoutines(), executor: 'builtin' }), {
    getRunEvents: id => store.getTaskEvents(id), getRunWorkspace: async () => ({ available: false, reason: 'test' }), readRunFile: async () => ({ available: false, reason: 'test' }),
    approvals: () => [], mcpStatus: () => [], ...publicAgentDataApi(store),
  });
  await server.start();
  try {
    const run = startRun(store, 'protected');
    const post = (body: unknown) => fixtureFetch(`http://127.0.0.1:${port}/api/data`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const original = store.setAgentData({ agentId: 'alpha', taskRunId: run.id, category: VERIFIED_WORK_CATEGORY, key: run.id, data: { state: 'unverified' } });
    for (const category of INTERNAL_DATA_CATEGORIES) {
      const response = await post({ agentId: 'alpha', key: run.id, category, data: { state: 'verified', forged: true } });
      assert.equal(response.status, 403, `POST ${category}`);
      const internal = store.setAgentData({ agentId: 'alpha', taskRunId: run.id, category, key: `delete-${category}`, data: { owned: 'runtime' } });
      const removed = await fixtureFetch(`http://127.0.0.1:${port}/api/data/${encodeURIComponent(internal.id)}`, { method: 'DELETE' });
      assert.equal(removed.status, 403, `DELETE ${category}`);
      assert.ok(store.getAgentDataById(internal.id), `${category} record survives`);
    }
    assert.deepEqual(JSON.parse(store.getAgentDataById(original.id)!.data_json), { state: 'unverified' }, 'no forged checked work was written');
    const created = await post({ agentId: 'alpha', key: 'notes', category: 'general', data: { text: 'ordinary' } });
    assert.equal(created.status, 200);
    const hold = await post({ agentId: 'alpha', key: 'hold', category: 'retention', data: { note: 'Keep for review' } });
    assert.equal(hold.status, 200, 'operator retention holds stay editable');
    const edited = await post({ agentId: 'alpha', key: 'notes', data: { text: 'edited' } });
    assert.equal(edited.status, 200, 'the default category is ordinary');
    const record = (await edited.json() as { record: { id: string } }).record;
    const deleted = await fixtureFetch(`http://127.0.0.1:${port}/api/data/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json() as { success: boolean }).success, true);
  } finally { await server.close(); store.close(); }
});

test('sealed checked work refuses altered code, fixtures, paths, metadata, rewritten plans and reports, old formats and other bots', () => {
  const h = profile();
  try {
    const good = { ...codeContract.initialFiles, 'src/index.js': parser };
    const fresh = (contract: WorkContract, files: Record<string, string>) => { const run = startRun(h.store, 'checked'); seal(h.store, run.id, contract, files); return run.id; };
    assert.equal(reasonOf(reusableCheckedWork(h.store, fresh(codeContract, good), 'alpha', codeContract)), 'reused', 'an intact sealed code record passes validation');
    assert.equal(reasonOf(reusableCheckedWork(h.store, fresh(planContract, planFiles), 'alpha', planContract)), 'reused');
    const source = evidenceSource('source-2', 'MCP fixture', 'The agreement expires in December.');
    const reportFiles = checkDeliverable('report', JSON.stringify(reportOf({ sourceId: source.id, quote: source.text })), [source]);
    const forged = evidenceSource('source-2', 'MCP fixture', 'The agreement never expires at all.');
    const forgedFiles = checkDeliverable('report', JSON.stringify(reportOf({ sourceId: forged.id, quote: forged.text })), [forged]);
    const rewrittenPlan = checkDeliverable('plan', JSON.stringify({ ...plan, title: 'Rewritten plan' }), []);
    const fixture = Object.keys(codeContract.initialFiles).find(file => file !== 'REQUIREMENTS.md')!;
    const cases: Array<[string, WorkContract, string, RegExp]> = [];
    let id = fresh(codeContract, good);
    tamper(h.store, id, r => ({ ...r, files: { ...r.files, 'src/index.js': 'throw new Error("changed after verification");' } }));
    cases.push(['altered code bytes', codeContract, id, /do not match their verified manifest/]);
    cases.push(['altered fixture sealed by a runtime writer', codeContract, fresh(codeContract, { ...good, [fixture]: 'export {};' }), /do not match their verified manifest, fixtures/]);
    cases.push(['non-deliverable path', codeContract, fresh(codeContract, { ...good, 'package-lock.json': '{}' }), /do not match/]);
    id = fresh(codeContract, good);
    tamper(h.store, id, r => { const files = { ...r.files }; delete files['src/index.js']; return { ...r, files }; });
    cases.push(['removed path', codeContract, id, /do not match/]);
    id = fresh(planContract, planFiles);
    tamper(h.store, id, r => ({ ...r, manifest: r.manifest.map((entry: any) => ({ ...entry, bytes: entry.bytes + 1 })) }));
    cases.push(['corrupt manifest metadata', planContract, id, /integrity seal/]);
    id = fresh(planContract, planFiles);
    tamper(h.store, id, r => ({ ...r, files: rewrittenPlan, manifest: manifestOf(rewrittenPlan) }));
    cases.push(['internally consistent plan rewrite', planContract, id, /integrity seal/]);
    id = fresh(reportContract, reportFiles);
    tamper(h.store, id, r => ({ ...r, files: forgedFiles, manifest: manifestOf(forgedFiles) }));
    cases.push(['internally consistent report rewrite', reportContract, id, /integrity seal/]);
    id = fresh(planContract, planFiles);
    new VerifiedWorkStore(h.store, new ArtifactStore(h.store)).markUnverified(id, 'Fixture');
    tamper(h.store, id, r => ({ ...r, state: 'verified' }));
    cases.push(['unverified promoted to verified', planContract, id, /integrity seal/]);
    id = fresh(planContract, planFiles);
    tamper(h.store, id, r => { const { seal: _s, manifest: _m, agentId: _a, version: _v, ...legacy } = r; return legacy; });
    cases.push(['legacy record without a version', planContract, id, /unsupported format \(legacy\)/]);
    id = fresh(planContract, planFiles);
    tamper(h.store, id, r => ({ ...r, version: 3 }));
    cases.push(['unsupported version', planContract, id, /unsupported format \(3\)/]);
    cases.push(['changed contract', { ...planContract, requirements: [...planContract.requirements, 'Name an owner.'] }, fresh(planContract, planFiles), /contract changed/]);
    for (const [label, contract, runId, pattern] of cases) assert.match(reasonOf(reusableCheckedWork(h.store, runId, 'alpha', contract)), pattern, label);

    h.store.createAgent({ id: 'beta', name: 'Beta', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
    const alphaRecord = readVerifiedWork(h.store, fresh(planContract, planFiles))!;
    const betaRun = startRun(h.store, 'beta-run', 'beta');
    h.store.setAgentData({ agentId: 'beta', taskRunId: betaRun.id, category: VERIFIED_WORK_CATEGORY, key: betaRun.id, data: alphaRecord });
    assert.match(reasonOf(reusableCheckedWork(h.store, betaRun.id, 'beta', planContract)), /another run or bot/, 'a copied record cannot move to another bot');
    assert.match(reasonOf(reusableCheckedWork(h.store, betaRun.id, 'alpha', planContract)), /No checked work is retained/, 'a bot cannot claim another bot\'s run');
  } finally { h.close(); }
});

test('resumed code becomes finish-eligible only after its fixed checks pass again in a fresh workspace', async () => {
  const resume = async (priorCode: string, passes: (files: Record<string, string>) => boolean, steps: unknown[], throwOnCheck = false) => {
    const h = profile();
    const prior = startRun(h.store, 'prior');
    seal(h.store, prior.id, codeContract, { ...codeContract.initialFiles, 'src/index.js': priorCode });
    h.store.finishTaskRun(prior.id, 'FAILED', 'Provider stopped after verification.');
    const { sandbox, commands } = codeSandbox(passes, throwOnCheck);
    const { llm, requests } = scripted(steps);
    const artifacts = new ArtifactStore(h.store);
    const run = startRun(h.store, 'resumed');
    const result = await new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox, artifacts }).execute({ taskRunId: run.id, contract: codeContract, request: 'Continue the parser.', prior: { runId: prior.id }, signal: signal() });
    const events = h.store.getTaskEvents(run.id).map(e => ({ type: e.event_type, payload: JSON.parse(e.payload_json) }));
    return { h, prior, run, result, commands, requests, artifacts, events };
  };
  {
    const x = await resume(brokenParser, files => files['src/index.js'] === parser, [{ tool: 'finish' }, { tool: 'block', reason: 'The retained code no longer passes its checks.' }]);
    try {
      assert.equal(x.result.outcome, 'FAILED');
      assert.equal(x.artifacts.list(x.run.id).length, 0);
      assert.equal(x.commands.filter(c => c === codeContract.testCommand).length, 1, 'the fixed checks ran again before any finish');
      assert.equal(x.events.filter(e => e.type === 'WORK_VERIFIED' && e.payload.recheck && !e.payload.passed).length, 1);
      assert.ok(x.events.some(e => e.type === 'TOOL_CALL' && /Completion refused/.test(String(e.payload.summary))), 'failing resumed code cannot finish');
      assert.equal(readVerifiedWork(x.h.store, x.run.id)?.state, 'unverified', 'bytes remain only as unverified material');
      assert.equal(readVerifiedWork(x.h.store, x.prior.id), null, 'the old revision is no longer reusable');
      assert.equal(x.result.checkedWork?.available, false);
      assert.match(x.requests[0].messages![0].content, /fixed contract checks run again before finish is allowed/);
      assert.match(x.requests[0].messages![0].content, /failed its fixed contract checks again/);
    } finally { x.h.close(); }
  }
  {
    const x = await resume(parser, () => true, [{ tool: 'finish' }, { tool: 'block', reason: 'Checks could not run.' }], true);
    try {
      assert.equal(x.result.outcome, 'FAILED');
      assert.ok(x.events.some(e => e.type === 'TOOL_CALL' && /Completion refused/.test(String(e.payload.summary))), 'a throwing recheck cannot leave finish eligibility');
      const record = readVerifiedWork(x.h.store, x.run.id)!;
      assert.equal(record.state, 'unverified');
      assert.match(record.note!, /could not run again: The verification container could not start/);
    } finally { x.h.close(); }
  }
  {
    const x = await resume(parser, files => files['src/index.js'] === parser, [{ tool: 'finish' }]);
    try {
      assert.equal(x.result.outcome, 'COMPLETED');
      assert.equal(x.commands.filter(c => c === codeContract.testCommand).length, 1);
      assert.equal(x.artifacts.list(x.run.id).find(a => a.path === 'src/index.js')?.sha256, sha256(parser));
      const reused = x.events.find(e => e.type === 'CHECKED_WORK_REUSED')!;
      assert.equal(reused.payload.provenance.runId, x.prior.id, 'original verification provenance is kept');
      assert.equal(reused.payload.state, 'unverified');
      assert.equal(x.events.filter(e => e.type === 'WORK_VERIFIED' && e.payload.recheck && e.payload.passed && e.payload.revision === 1).length, 1, 'the new attempt earns its own revision');
    } finally { x.h.close(); }
  }
});

test('real Docker: resumed code passes its fixed checks again; failing or changed code is refused', { timeout: 300_000 }, async () => {
  const h = profile();
  const sandbox = new DockerSandbox(), artifacts = new ArtifactStore(h.store), volumes: string[] = [];
  const runtime = (steps: unknown[]) => new WorkRuntime({ store: h.store, ledger: h.ledger, llm: scripted(steps).llm, sandbox, artifacts });
  try {
    const original = startRun(h.store, 'docker-original'); volumes.push(original.id);
    await runtime([{ tool: 'write', path: 'src/index.js', content: parser }, { tool: 'verify' }, overloaded]).execute({ taskRunId: original.id, contract: codeContract, request: 'Implement the parser.', signal: signal() });
    h.store.finishTaskRun(original.id, 'FAILED', 'Provider stopped after verification.');
    assert.equal(readVerifiedWork(h.store, original.id)?.state, 'verified', 'the original Docker checks passed and were sealed');

    const resumed = startRun(h.store, 'docker-resumed'); volumes.push(resumed.id);
    const result = await runtime([{ tool: 'finish' }]).execute({ taskRunId: resumed.id, contract: codeContract, request: 'Finish the parser.', prior: { runId: original.id }, signal: signal() });
    assert.equal(result.outcome, 'COMPLETED', result.report);
    assert.ok(h.store.getTaskEvents(resumed.id).some(e => e.event_type === 'WORK_VERIFIED' && JSON.parse(e.payload_json).recheck && JSON.parse(e.payload_json).passed));
    assert.equal(artifacts.list(resumed.id).find(a => a.path === 'src/index.js')?.sha256, sha256(parser));

    const broken = startRun(h.store, 'docker-broken-prior');
    seal(h.store, broken.id, codeContract, { ...codeContract.initialFiles, 'src/index.js': brokenParser });
    h.store.finishTaskRun(broken.id, 'FAILED', 'Provider stopped after verification.');
    const refused = startRun(h.store, 'docker-refused'); volumes.push(refused.id);
    const refusal = await runtime([{ tool: 'finish' }, { tool: 'block', reason: 'The retained code fails its checks.' }]).execute({ taskRunId: refused.id, contract: codeContract, request: 'Finish.', prior: { runId: broken.id }, signal: signal() });
    assert.equal(refusal.outcome, 'FAILED');
    assert.equal(artifacts.list(refused.id).length, 0);
    assert.equal(readVerifiedWork(h.store, refused.id)?.state, 'unverified');
    assert.ok(h.store.getTaskEvents(refused.id).some(e => e.event_type === 'WORK_VERIFIED' && JSON.parse(e.payload_json).recheck && !JSON.parse(e.payload_json).passed));

    const changedPrior = startRun(h.store, 'docker-changed-prior');
    seal(h.store, changedPrior.id, codeContract, { ...codeContract.initialFiles, 'src/index.js': parser });
    tamper(h.store, changedPrior.id, r => ({ ...r, files: { ...r.files, 'src/index.js': brokenParser } }));
    const changed = startRun(h.store, 'docker-changed'); volumes.push(changed.id);
    const steps = scripted([{ tool: 'block', reason: 'Nothing verified to reuse.' }]);
    await new WorkRuntime({ store: h.store, ledger: h.ledger, llm: steps.llm, sandbox, artifacts }).execute({ taskRunId: changed.id, contract: codeContract, request: 'Finish.', prior: { runId: changedPrior.id }, signal: signal() });
    assert.match(steps.requests[0].messages![0].content, /Not reused\..*do not match their verified manifest/);
    assert.equal(h.store.getTaskEvents(changed.id).filter(e => e.event_type === 'WORK_VERIFIED').length, 0, 'changed bytes are refused before any check');
  } finally {
    for (const id of volumes) await sandbox.destroyWorkspaceVolume(sandbox.workspaceVolumeName(`task-${id}`)).catch(() => {});
    h.close();
  }
});

test('hard termination while resumed code is rechecked leaves nothing finish-eligible', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-recheck-crash-')), db = path.join(root, 'state.db'), marker = path.join(root, 'marker');
  const child = spawn(process.execPath, [path.resolve('tests/fixtures/finalization-crash-child.mjs'), db, 'code-recheck', 'recheck', marker], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : log, 'recheck', 'the child is killed during the recheck');
  const store = new AgentStore(db);
  try {
    store.markInFlightAsCrashed('Reopened after hard termination during recheck.');
    const ids = JSON.parse(fs.readFileSync(`${marker}.id`, 'utf8')) as { prior: string; resumed: string };
    assert.equal(store.getTaskRun(ids.resumed)?.status, 'CRASHED');
    assert.equal(readVerifiedWork(store, ids.prior), null, 'the old revision was consumed before the recheck');
    assert.equal(readVerifiedWork(store, ids.resumed)?.state, 'unverified', 'the interrupted recheck left unverified material only');
    assert.match(reasonOf(reusableCheckedWork(store, ids.resumed, 'alpha', codeContract)), /fixed contract checks must pass again before finish/, 'the interrupted recheck is not reusable');
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM run_artifacts'), 0);
  } finally { store.close(); }
});

test('a resume pin protects checked work through enqueue, reopen, delayed admission and retention until adoption releases it', { timeout: 30_000 }, async () => {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-resume-pin-')), 'state.db');
  let h = profile(db);
  const now = Date.now();
  const steps: unknown[] = [{ tool: 'write', path: 'plan.json', content: JSON.stringify(plan) }, { tool: 'verify' }, overloaded];
  const { llm, requests } = scripted(steps);
  const retention = () => new RetentionService(h.store, { workspaceVolumeName: id => id, destroyWorkspaceVolume: async () => {} });
  const open = () => {
    const missions = new MissionService(h.store, DIRECT_WORK_CONTRACTS, 1, () => now);
    const workRuntime = new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker, artifacts: new ArtifactStore(h.store), contracts: DIRECT_WORK_CONTRACTS });
    const scheduler = new TaskScheduler({ agentStore: h.store, ledger: h.ledger, sandbox: noDocker as unknown as DockerSandbox, providerRouter: new ProviderRouter(), llmClient: llm,
      workRuntime, maxConcurrency: 1, cadenceMs: 10, executor: 'builtin', canRun: id => missions.canRun(id), workProducer: missions });
    return { missions, scheduler };
  };
  let { missions, scheduler } = open();
  const id = missions.create({ agentId: 'alpha', objective: 'Plan the release, then report.', contractId: 'action-plan', maxRuns: 3, intervalMs: 60000 }).id;
  const row = () => missions.list().find(m => m.id === id)!;
  const runs = () => h.store.getDatabase().prepare('SELECT id, status FROM task_runs WHERE task_name = ? ORDER BY rowid').all(`mission:${id}`) as { id: string; status: string }[];
  const settle = async (done: () => boolean) => { for (let i = 0; i < 1000 && !done(); i++) await delay(10); assert.ok(done(), `did not settle: ${row().status} ${row().reason}`); };
  try {
    await missions.start(); scheduler.start();
    await settle(() => row().status === 'WAITING');
    await scheduler.stop();
    const [old] = runs();
    assert.match(readWorkResult(h.store, old.id)!.report, /retained for operator resume/, 'mission wording names the supported recovery');
    h.store.getDatabase().prepare('UPDATE task_runs SET completed_at = ? WHERE id = ?').run(now - 40 * 86400000, old.id);

    missions.control(id, 'ACTIVE'); missions.control(id, 'ACTIVE');
    assert.equal(retention().candidates(30, now).some(r => r.id === old.id), false, 'pinned by Resume');
    assert.equal(await missions.produceNextTasks(h.store), 1);
    assert.equal(await missions.produceNextTasks(h.store), 0);
    const queued = runs()[1];
    assert.equal(queued.status, 'QUEUED');
    assert.equal((h.store.getRunDefinition(queued.id) as TaskDefinition).work?.prior?.runId, old.id);
    const pin = h.store.getAgentData('alpha', id, MISSION_RESUME);
    assert.ok(pin, 'the resume pin survives enqueue');
    assert.equal(JSON.parse(pin.data_json).queuedRunId, queued.id);
    assert.equal(retention().candidates(30, now).some(r => r.id === old.id), false, 'still pinned while the resumed run is queued');

    await missions.stop(); h.close(); h = profile(db); ({ missions, scheduler } = open());
    const cleanup = await retention().clean(30, false, now);
    assert.equal(cleanup.cleaned.includes(old.id), false);
    assert.equal(readVerifiedWork(h.store, old.id)?.state, 'verified', 'retention after reopen keeps the pinned checkpoint');

    steps.push(continueDecision);
    await delay(150);
    await missions.start(); scheduler.start();
    await settle(() => runs()[1].status === 'COMPLETED' && row().last_run_id === null);
    await scheduler.stop();
    assert.equal(requests.length, 4);
    assert.equal(h.store.getAgentData('alpha', id, MISSION_RESUME), null, 'adoption released the pin');
    assert.equal(readVerifiedWork(h.store, old.id), null);
    assert.equal(count(h.store, 'SELECT COUNT(*) AS n FROM run_artifacts WHERE task_run_id = ?', runs()[1].id), 2);
    assert.equal(count(h.store, 'SELECT COUNT(*) AS n FROM run_artifacts'), 2, 'one artifact set');
    missions.control(id, 'ACTIVE'); missions.control(id, 'ACTIVE');
    assert.equal(await missions.produceNextTasks(h.store), 1);
    assert.equal(await missions.produceNextTasks(h.store), 0);
    assert.equal(runs().length, 3, 'one continuation');
    assert.equal((h.store.getRunDefinition(runs()[2].id) as TaskDefinition).work?.prior, undefined);
    assert.equal(retention().candidates(30, now).some(r => r.id === old.id), true, 'once nothing references the old run, cleanup is eligible again');
  } finally { await scheduler.stop(); await missions.stop(); h.close(); }
});

test('retention revalidates each run after asynchronous workspace deletion, so protection added meanwhile wins', async () => {
  // Resume pins only a mission's current last run, which retention never selects. A protection can still arrive for a
  // selected run while its volume is being deleted (another pin, a hold, a new reference); that protection must win.
  const h = profile();
  const now = Date.now();
  const pinned = startRun(h.store, 'pinned-during-cleanup'), held = startRun(h.store, 'held-during-cleanup'), plain = startRun(h.store, 'unprotected');
  for (const run of [pinned, held, plain]) { seal(h.store, run.id, planContract, planFiles); h.store.finishTaskRun(run.id, 'FAILED', 'Provider stopped after verification.'); }
  h.store.getDatabase().prepare('UPDATE task_runs SET completed_at = ?').run(now - 40 * 86400000);
  let release!: () => void, started = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const retention = new RetentionService(h.store, { workspaceVolumeName: id => id, destroyWorkspaceVolume: async () => { started++; await gate; } });
  try {
    const cleaning = retention.clean(30, false, now);
    for (let i = 0; i < 200 && started === 0; i++) await delay(5);
    assert.equal(started, 1, 'cleanup is suspended inside asynchronous workspace deletion');
    h.store.setAgentData({ agentId: 'alpha', taskRunId: pinned.id, category: MISSION_RESUME, key: 'mission-resumed-during-cleanup', data: { runId: pinned.id } });
    h.store.setAgentData({ agentId: 'alpha', taskRunId: held.id, category: 'retention', key: 'hold', data: { note: 'Keep for review' } });
    release();
    const outcome = await cleaning;
    assert.deepEqual(outcome.cleaned, [plain.id]);
    assert.deepEqual([...outcome.skipped].sort(), [pinned.id, held.id].sort());
    assert.equal(readVerifiedWork(h.store, pinned.id)?.state, 'verified');
    assert.equal(readVerifiedWork(h.store, held.id)?.state, 'verified');
    assert.equal(readVerifiedWork(h.store, plain.id), null);
  } finally { release(); h.close(); }
});

test('a resumed report restores captured MCP and memory sources with original bytes through reread, edit, compaction and reverification', async () => {
  const h = profile();
  const memory = new MemoryService(h.store), artifacts = new ArtifactStore(h.store);
  memory.save('alpha', { key: 'renewal', text: 'Renewal requires sixty days of notice.' }, 'operator');
  let mcpCalls = 0;
  const mcp = { toolsForAgent: () => [{ server: 'contracts', name: 'read', description: 'Read the agreement', inputSchema: {} }], endRun() {},
    async call() { mcpCalls++; return { text: 'The original agreement expires in December.', isError: false }; } } as unknown as McpRegistry;
  const approvals = { async request() { return { status: 'APPROVED' }; } } as unknown as ApprovalGate;
  const objective = 'Report the agreement renewal terms using the contracts tool and the renewal note.';
  const runtime = (llm: { generateCode(req: LLMRequest): Promise<any> }) => new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker, artifacts, mcp, approvals, memory, contracts: DIRECT_WORK_CONTRACTS });
  let mcpId = '', memoryId = '';
  try {
    const firstRun = startRun(h.store, 'report-original');
    const first = scripted([
      (req: LLMRequest) => { memoryId = /"sourceId":"(memory-[a-f0-9]{24})"/.exec(req.messages![0].content)![1]; return { tool: 'mcp', server: 'contracts', name: 'read', args: {} }; },
      (req: LLMRequest) => { mcpId = JSON.parse(req.userPrompt).source.id; return { tool: 'write', path: 'report.json', content: JSON.stringify(reportOf({ sourceId: mcpId, quote: 'The original agreement expires in December.' }, { sourceId: memoryId, quote: 'Renewal requires sixty days of notice.' })) }; },
      { tool: 'verify' }, overloaded]);
    const firstResult = await runtime(first.llm).execute({ taskRunId: firstRun.id, contract: reportContract, request: 'Draft the renewal report.', mission: true, objective, signal: signal() });
    h.store.finishTaskRun(firstRun.id, 'FAILED', firstResult.report);
    assert.match(firstResult.report, /retained for operator resume/);
    const originalSources = JSON.parse(readVerifiedWork(h.store, firstRun.id)!.files!['sources.json']) as EvidenceSource[];
    const originalOf = (sourceId: string) => originalSources.find(s => s.id === sourceId)!;
    assert.ok(originalOf(mcpId) && originalOf(memoryId));

    memory.save('alpha', { key: 'renewal', text: 'Renewal now requires ninety days of notice.' }, 'operator');
    const resumedRun = startRun(h.store, 'report-resumed');
    const observed = (req: LLMRequest) => JSON.parse(req.userPrompt).source?.text;
    const resumed = scripted([
      (req: LLMRequest) => {
        const context = req.messages![0].content;
        assert.match(context, /"restoredSourceIds":\[[^\]]*"request"/);
        assert.match(context, /"currentRequestSourceId":"current-request"/);
        assert.match(context, /"currentObjectiveSourceId":"current-objective"/);
        return { tool: 'source', id: mcpId };
      },
      (req: LLMRequest) => { assert.equal(observed(req), 'The original agreement expires in December.'); return { tool: 'source', id: memoryId }; },
      (req: LLMRequest) => { assert.equal(observed(req), 'Renewal requires sixty days of notice.', 'the original note snapshot, not the changed note'); return { tool: 'source', id: 'request' }; },
      (req: LLMRequest) => { assert.match(observed(req), /Draft the renewal report\./, 'the original request binding is kept'); return { tool: 'source', id: 'current-request' }; },
      (req: LLMRequest) => {
        assert.match(observed(req), /Continue the renewal report after the provider failure\./);
        return { tool: 'write', path: 'report.json', content: JSON.stringify(reportOf({ sourceId: mcpId, quote: 'The original agreement expires in December.' },
          { sourceId: memoryId, quote: 'Renewal requires sixty days of notice.' }, { sourceId: 'current-objective', quote: 'Report the agreement renewal terms' })) };
      },
      { tool: 'compact' },
      (req: LLMRequest) => { assert.match(req.messages![1].content, /Runtime checkpoint/); return { tool: 'source', id: mcpId }; },
      (req: LLMRequest) => { assert.equal(observed(req), 'The original agreement expires in December.', 'restored sources survive compaction'); return { tool: 'verify' }; },
      { tool: 'finish', mission: { state: 'complete', reason: 'The renewal report is delivered with its original evidence.' } },
    ]);
    const result = await runtime(resumed.llm).execute({ taskRunId: resumedRun.id, contract: reportContract, request: 'Continue the renewal report after the provider failure.', mission: true, objective, prior: { runId: firstRun.id }, signal: signal() });
    assert.equal(result.outcome, 'COMPLETED', result.report);
    assert.equal(mcpCalls, 1, 'restoration replays no external call');
    const delivered = JSON.parse(artifacts.read(resumedRun.id, result.artifacts.find(a => a.path === 'sources.json')!.id)!.content) as EvidenceSource[];
    for (const restoredId of [mcpId, memoryId, 'request', 'objective']) assert.deepEqual(delivered.find(s => s.id === restoredId), originalOf(restoredId), `${restoredId} keeps its original bytes and provenance`);
    assert.match(delivered.find(s => s.id === 'current-request')!.text, /Continue the renewal report/);
    assert.match(delivered.find(s => s.id === 'current-request')!.origin, /model-generated/);
    assert.ok(delivered.some(s => s.id.startsWith('memory-') && s.id !== memoryId && s.text === 'Renewal now requires ninety days of notice.'), 'the changed note is a separate current snapshot');

    h.store.createAgent({ id: 'beta', name: 'Beta', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
    const foreignOriginal = startRun(h.store, 'foreign-original');
    const source = evidenceSource('source-9', 'MCP fixture', 'The foreign agreement renews annually.');
    seal(h.store, foreignOriginal.id, reportContract, checkDeliverable('report', JSON.stringify(reportOf({ sourceId: source.id, quote: source.text })), [source]));
    const foreign = scripted([{ tool: 'source', id: 'source-9' }, { tool: 'block', reason: 'Nothing to reuse.', blocker: { kind: 'missing_input', detail: 'No evidence.', resumeWhen: 'Evidence is supplied.' } }]);
    const betaRun = startRun(h.store, 'beta-resume', 'beta');
    await runtime(foreign.llm).execute({ taskRunId: betaRun.id, contract: reportContract, request: 'Continue.', mission: true, objective, prior: { runId: foreignOriginal.id }, signal: signal() });
    assert.ok(h.store.getTaskEvents(betaRun.id).some(e => e.event_type === 'TOOL_CALL' && /Unknown captured source ID/.test(e.payload_json)), 'another bot\'s sources are never restored');

    for (const [total, reused] of [[10, true], [11, false]] as const) {
      const many = Array.from({ length: total }, (_, i) => evidenceSource(`source-${i}`, 'MCP fixture', `Captured statement number ${i} at the source cap boundary.`));
      const prior = startRun(h.store, `cap-${total}`);
      seal(h.store, prior.id, reportContract, checkDeliverable('report', JSON.stringify(reportOf({ sourceId: 'source-0', quote: many[0].text })), many));
      const probe = scripted([{ tool: 'block', reason: 'Boundary probe.', blocker: { kind: 'missing_input', detail: 'Probe only.', resumeWhen: 'Never.' } }]);
      await runtime(probe.llm).execute({ taskRunId: startRun(h.store, `cap-resume-${total}`).id, contract: reportContract, request: 'Continue.', mission: true, objective, prior: { runId: prior.id }, signal: signal() });
      assert.match(probe.requests[0].messages![0].content, reused ? /Loaded and rechecked/ : /Not reused\..*exceed the 12-source limit/, `${total} restored sources plus request and objective`);
    }
  } finally { h.close(); }
});

test('store transactions defer broadcasts only for transactions they own and refuse to join raw ones', () => {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const run = store.createTaskRun({ agentId: 'alpha', taskName: 'transaction-boundary' });
  const seen: string[] = [];
  store.setEventSink(event => seen.push(event.event_type));
  const record = (type: string) => store.recordEvent({ task_run_id: run.id, agent_id: 'alpha', event_type: type, payload_json: '{}', timestamp: Date.now() });
  try {
    store.transaction(() => { record('OUTER'); store.transaction(() => record('NESTED')); assert.deepEqual(seen, [], 'nothing is published before the outer commit'); });
    assert.deepEqual(seen, ['OUTER', 'NESTED']);
    assert.throws(() => store.transaction(() => { record('ROLLED_BACK'); throw new Error('Injected rollback.'); }), /Injected rollback/);
    assert.equal(seen.includes('ROLLED_BACK'), false);
    assert.equal(store.getTaskEvents(run.id).some(e => e.event_type === 'ROLLED_BACK'), false);
    const db = store.getDatabase();
    db.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => store.transaction(() => record('RAW_JOIN')), /did not open/); } finally { db.exec('ROLLBACK'); }
    assert.equal(seen.includes('RAW_JOIN'), false);
  } finally { store.close(); }
});
