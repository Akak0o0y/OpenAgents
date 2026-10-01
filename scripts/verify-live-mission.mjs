import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfigFile } from '../dist/src/daemon/config-file.js';
import { AgentStore } from '../dist/src/daemon/agent-store.js';
import { CostLedger } from '../dist/src/kernel/cost-ledger.js';
import { ArtifactStore } from '../dist/src/daemon/artifacts.js';
import { WorkRuntime } from '../dist/src/daemon/work-runtime.js';
import { MissionService } from '../dist/src/daemon/missions.js';
import { MemoryService } from '../dist/src/daemon/memory.js';
import { TaskScheduler } from '../dist/src/daemon/scheduler.js';
import { ProviderRouter } from '../dist/src/daemon/provider-router.js';
import { RunCapacity } from '../dist/src/daemon/run-capacity.js';
import { readWorkResult } from '../dist/src/daemon/work-results.js';
import { checkDeliverable } from '../dist/src/daemon/deliverable-checks.js';
import { DIRECT_WORK_CONTRACTS } from '../dist/src/daemon/work-contract.js';
import { LiveLLMClient, syncOpenRouterCatalog } from '../dist/src/evals/llm-client.js';

// Bounded live mission qualification through the daemon's own scheduler, mission service, runtime
// and SQLite profile. Synthetic material, exactly the configured model, no Docker or MCP.
// Only the injected mission clock is advanced; every decision comes from the model.
// Usage: node scripts/verify-live-mission.mjs <evidence.json> [delivery|blocker]
const [output, scenario = 'delivery'] = process.argv.slice(2);
if (!output || !['delivery', 'blocker'].includes(scenario)) throw new Error('Usage: verify-live-mission.mjs <evidence.json> [delivery|blocker]');
const outDir = path.dirname(path.resolve(output)), base = path.basename(output, '.json');
fs.mkdirSync(outDir, { recursive: true });
const sha = data => createHash('sha256').update(data).digest('hex');
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'src');
const config = loadConfigFile(), model = config?.config.agents[0]?.model;
if (!model) throw new Error('No configured model.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-live-mission-')), dbPath = path.join(root, 'state.db');
const evidence = { timestamp: new Date().toISOString(), scenario, model, configuredModels: [...new Set(config.config.agents.map(a => a.model))], configSource: config.source, profile: root,
  harnessSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
  moduleSha256: Object.fromEntries(['daemon/missions.js', 'daemon/work-runtime.js', 'daemon/memory.js', 'daemon/deliverable-checks.js', 'daemon/scheduler.js', 'evals/llm-client.js'].map(m => [m, sha(fs.readFileSync(path.join(dist, m)))])),
  reopens: [], runs: [], checks: [], forbiddenSandboxCalls: [], passed: false };
const save = () => fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
const check = (name, fn) => {
  try { const detail = fn(); evidence.checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) }); save(); }
  catch (error) { evidence.checks.push({ name, passed: false, error: String(error.message ?? error) }); save(); throw error; }
};
const sandbox = new Proxy({}, { get: (_, name) => name === 'then' ? undefined : async () => {
  evidence.forbiddenSandboxCalls.push(String(name)); throw new Error('Plan/report qualification must not use a Docker workspace.');
} });
const llm = new LiveLLMClient();
let now = Date.now(), store, ledger, memory, missions, scheduler;
// Harness-only diagnostics for failure classification. The product client deliberately hides upstream
// bodies; this records which upstream served each completion and bounded fields of any embedded error.
evidence.providerResponses = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init);
  if (!String(input).includes('/chat/completions')) return response;
  const entry = { at: new Date().toISOString(), httpStatus: response.status };
  evidence.providerResponses.push(entry);
  response.clone().text().then(text => {
    try {
      const body = JSON.parse(text), error = body.error, raw = error?.metadata?.raw;
      Object.assign(entry, { provider: body.provider, model: body.model, finishReason: body.choices?.[0]?.finish_reason,
        ...(error ? { errorCode: error.code, errorMessage: String(error.message ?? '').slice(0, 300), upstreamProvider: error.metadata?.provider_name,
          upstreamRaw: raw === undefined ? undefined : String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 600) } : {}) });
    } catch { entry.unparsedBytes = text.length; }
  }, error => { entry.bodyError = String(error?.name ?? error); });
  return response;
};

function open(label) {
  store = new AgentStore(dbPath); ledger = new CostLedger(store.getDatabase());
  const sweptRunning = store.markInFlightAsCrashed('Qualification reopen sweep: previous handle closed.');
  memory = new MemoryService(store);
  const artifacts = new ArtifactStore(store), providerRouter = new ProviderRouter(model);
  missions = new MissionService(store, DIRECT_WORK_CONTRACTS, 1, () => now);
  const workRuntime = new WorkRuntime({ store, ledger, llm, sandbox, artifacts, memory, providerRouter, contracts: DIRECT_WORK_CONTRACTS });
  scheduler = new TaskScheduler({ agentStore: store, ledger, sandbox, providerRouter, llmClient: llm, workRuntime, capacity: new RunCapacity(1), maxConcurrency: 1,
    cadenceMs: 250, executor: 'builtin', canRun: id => missions.canRun(id), workProducer: missions });
  evidence.reopens.push({ label, at: new Date().toISOString(), sweptRunning }); save();
}
async function close() {
  await scheduler?.stop(); await missions?.stop(); ledger?.close(); store?.close();
  scheduler = missions = ledger = store = memory = undefined;
}
const missionRuns = id => store.getDatabase().prepare('SELECT id, status FROM task_runs WHERE task_name = ? ORDER BY rowid').all(`mission:${id}`);
const missionRow = id => missions.list().find(m => m.id === id);

/** Lets the real scheduler admit and run exactly one mission step, then settles the decision. */
async function executeStep(missionId, expectedRuns) {
  await missions.start(); scheduler.start();
  const deadline = Date.now() + 260_000;
  for (;;) {
    const runs = missionRuns(missionId);
    if (runs.length > expectedRuns) throw new Error(`Duplicate mission run: ${runs.length} runs, expected ${expectedRuns}.`);
    if (runs.length === expectedRuns && !['QUEUED', 'RUNNING'].includes(runs.at(-1).status) && scheduler.getActiveTaskCount() === 0) break;
    if (Date.now() > deadline) throw new Error('Probe deadline reached while waiting for the scheduled mission run.');
    await delay(250);
  }
  await scheduler.stop(); await missions.produceNextTasks(store); await missions.stop();
  return missionRuns(missionId).at(-1).id;
}

const clip = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text && text.length > 2000 ? `${text.slice(0, 2000)}…[${text.length} chars]` : text; };
function classify(d) {
  if (d.status === 'COMPLETED' && d.outcome === 'COMPLETED') return { class: 'delivered', decision: d.mission?.state ?? null };
  const toolErrors = d.toolCalls.filter(t => t.status === 'error').slice(-3).map(t => ({ turn: t.turn, tool: t.tool, summary: t.summary }));
  const rejectedDecisions = d.missionDecisions.filter(e => e.type === 'MISSION_DECISION_REJECTED').length;
  const lastProvider = d.providerCalls.at(-1);
  if (d.actions.filter(a => a.type === 'WORK_ACTION').at(-1)?.tool === 'block') return { class: 'model_block', rejectedDecisions };
  if (/time limit|turn limit/i.test(d.error ?? '')) return { class: 'limit_reached', lastProvider, rejectedDecisions, toolErrors };
  if (lastProvider?.phase === 'failed') return { class: ['OUTPUT_LIMIT', 'EMPTY_RESPONSE', 'INVALID_RESPONSE'].includes(lastProvider.code) ? 'provider_output_unusable' : 'provider_availability',
    code: lastProvider.code, status: lastProvider.status, turn: lastProvider.turn, rejectedDecisions };
  if (/three consecutive failed actions/.test(d.error ?? '')) return { class: 'action_failures_needs_inspection', note: 'Model behaviour or runtime defect; inspect toolErrors.', rejectedDecisions, toolErrors };
  return { class: 'needs_inspection', rejectedDecisions, toolErrors };
}
function digestRun(step, runId) {
  const run = store.getTaskRun(runId), result = readWorkResult(store, runId), work = store.getRunDefinition(runId)?.work;
  const events = store.getTaskEvents(runId).map(e => ({ type: e.event_type, turn: e.turn_number, ...JSON.parse(e.payload_json ?? '{}') }));
  const pick = (...types) => events.filter(e => types.includes(e.type));
  const d = { step, runId, status: run.status, error: run.error_message, durationMs: run.started_at && run.completed_at ? Number(run.completed_at) - Number(run.started_at) : null,
    contractId: work?.contract.id, request: work?.request, requestSha256: sha(work?.request ?? ''), objective: work?.objective,
    outcome: result?.outcome, turns: result?.turns, inputTokens: result?.inputTokens, outputTokens: result?.outputTokens, actualCostUsd: result?.actualCostUsd, shadowCostUsd: result?.shadowCostUsd,
    mission: result?.mission, report: result?.report, artifacts: result?.artifacts ?? [],
    providerCalls: pick('PROVIDER_CALL'), actions: pick('WORK_ACTION', 'WORK_PLAN', 'WORK_VERIFIED'),
    toolCalls: pick('TOOL_CALL').map(({ source, summary, ...e }) => ({ ...e, summary: clip(summary), ...(source ? { source: { ...source, text: clip(source.text) } } : {}) })),
    missionDecisions: pick('MISSION_DECISION', 'MISSION_DECISION_REJECTED'), memoryEvents: pick('MEMORY_RECALLED', 'MEMORY_WRITTEN'),
    artifactEvents: pick('ARTIFACT_CREATED').length, workReports: pick('WORK_REPORT') };
  d.classification = classify(d);
  return d;
}
function verifyArtifacts(d, expectedPaths) {
  const files = {};
  check(`step ${d.step} artifacts stored once, hash-verified and copied`, () => {
    const rows = store.getDatabase().prepare('SELECT path, content, bytes, sha256 FROM run_artifacts WHERE task_run_id = ? ORDER BY path').all(d.runId);
    assert.deepEqual(rows.map(r => r.path), expectedPaths);
    assert.equal(d.artifactEvents, rows.length, 'one ARTIFACT_CREATED event per stored file');
    assert.deepEqual(d.artifacts.map(a => `${a.path}:${a.sha256}`).sort(), rows.map(r => `${r.path}:${r.sha256}`).sort());
    const dir = path.join(outDir, 'samples', base, `${d.step}-${d.contractId}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const row of rows) {
      assert.equal(sha(row.content), row.sha256, `${row.path} content hash`); assert.equal(Buffer.byteLength(row.content), Number(row.bytes));
      fs.writeFileSync(path.join(dir, row.path), row.content); assert.equal(sha(fs.readFileSync(path.join(dir, row.path))), row.sha256, `${row.path} sample hash`);
      files[row.path] = row.content;
    }
    return rows.map(r => ({ path: r.path, sha256: r.sha256, sample: path.relative(outDir, path.join(dir, r.path)) }));
  });
  return files;
}
/** Re-runs the mechanical checks on stored files and records where each quotation came from. */
function recheckReport(files, objective) {
  const sources = JSON.parse(files['sources.json']), report = JSON.parse(files['report.json']);
  const citations = report.findings.flatMap((finding, index) => finding.evidence.map(e => {
    const source = sources.find(s => s.id === e.sourceId);
    const kind = source.id.startsWith('memory-') ? 'memory_snapshot' : source.id === 'objective' ? 'operator_objective'
      : source.id === 'request' ? (objective.includes(e.quote) ? 'request_operator_text' : 'request_model_generated_context') : 'other';
    return { finding: index, sourceId: e.sourceId, origin: source.origin, kind, quote: e.quote };
  }));
  check('report citations re-verified against captured source snapshots', () => {
    const again = checkDeliverable('report', files['report.json'], sources);
    assert.equal(again['report.md'], files['report.md']); assert.equal(again['sources.json'], files['sources.json']);
    for (const source of sources) assert.equal(sha(source.text), source.sha256, `source ${source.id} snapshot hash`);
    return { findings: report.findings.length, citations };
  });
  check('citation provenance is disclosed', () => {
    for (const c of citations) {
      if (c.kind === 'memory_snapshot') assert.match(c.origin, /unverified note\)$/);
      if (c.kind === 'operator_objective') assert.match(c.origin, /operator/i);
      if (c.kind === 'request_model_generated_context') assert.match(c.origin, /model-generated/, `Quote "${c.quote}" exists only in model-generated mission context, but its source is labelled "${c.origin}".`);
    }
    return { kinds: [...new Set(citations.map(c => c.kind))] };
  });
  return { sources, citations };
}

const NOTE = 'Synthetic release review: Initial testing is finished. Release approval is still pending. These supplied statements are the only evidence; do not infer release readiness.';
const DELIVERY_OBJECTIVE = 'Prepare two deliverables for a synthetic release review. First create a plan with observable completion conditions; after verifying it, continue with nextContractId evidence-brief and a concrete nextRequest. The second run must create a source report using these exact supplied statements: Initial testing is finished. Release approval is still pending. Treat them as supplied statements, not independent proof. Use the release-evidence memory note. Complete the mission only after both deliverables exist.';
const BLOCKER_OBJECTIVE = 'Write a source report for the vendor review. Quote the termination clause and the renewal date from the signed Northwind Services agreement attached by the operator, and explain what each means for renewal planning.';

async function delivery() {
  store.createAgent({ id: 'probe', name: 'Synthetic release reviewer', model_id: model, budget_cap_usd: 0.25, current_status: 'IDLE' });
  memory.save('probe', { key: 'release-evidence', text: NOTE }, 'operator');
  const id = missions.create({ agentId: 'probe', contractId: 'action-plan', maxRuns: 2, intervalMs: 60_000, objective: DELIVERY_OBJECTIVE }).id;

  const plan = digestRun(1, await executeStep(id, 1)); evidence.runs.push(plan); save();
  check('plan step delivered', () => { assert.equal(plan.status, 'COMPLETED', plan.error ?? ''); assert.equal(plan.outcome, 'COMPLETED'); return plan.classification; });
  check('model recorded a continuation to the report contract', () => {
    assert.equal(plan.mission?.state, 'continue'); assert.equal(plan.mission.nextContractId, 'evidence-brief');
    const decisions = plan.missionDecisions.filter(e => e.type === 'MISSION_DECISION');
    assert.equal(decisions.length, 1); const { type, turn, ...recorded } = decisions[0]; assert.deepEqual(recorded, plan.mission);
    return { decision: plan.mission, rejected: plan.missionDecisions.filter(e => e.type === 'MISSION_DECISION_REJECTED') };
  });
  const planFiles = verifyArtifacts(plan, ['plan.json', 'plan.md']);
  check('plan re-verified from stored files', () => {
    const again = checkDeliverable('plan', planFiles['plan.json'], []);
    assert.equal(again['plan.json'], planFiles['plan.json']); assert.equal(again['plan.md'], planFiles['plan.md']);
    return { tasks: JSON.parse(planFiles['plan.json']).tasks.length };
  });

  await close(); open('after plan decision');
  check('plan result, decision and memory persist across reopen', () => {
    const row = missionRow(id);
    assert.equal(row.status, 'ACTIVE'); assert.equal(row.runs, 1); assert.equal(row.last_run_id, null); assert.equal(JSON.parse(row.contract_json).id, 'evidence-brief');
    assert.equal(readWorkResult(store, plan.runId)?.mission?.state, 'continue'); assert.equal(readWorkResult(store, plan.runId)?.artifacts.length, 2);
    assert.ok(memory.list('probe').some(note => note.key === 'release-evidence' && note.text === NOTE)); assert.equal(missionRuns(id).length, 1);
    return { reason: row.reason };
  });
  now += 60_000; await missions.start(); const created = await missions.produceNextTasks(store); await missions.stop();
  const queued = missionRuns(id)[1]?.id;
  await close(); open('report step queued');
  check('queued report step survives reopen with the prior output embedded', () => {
    assert.equal(created, 1); assert.equal(missionRuns(id).length, 2); assert.equal(store.getTaskRun(queued)?.status, 'QUEUED');
    const work = store.getRunDefinition(queued).work, planSha = plan.artifacts.find(a => a.path === 'plan.json').sha256;
    assert.equal(work.contract.id, 'evidence-brief'); assert.equal(work.mission, true);
    assert.ok(work.request.includes(plan.mission.nextRequest), 'model next request carried forward');
    assert.ok(work.request.includes(planSha), 'prior plan hash embedded');
    return { requestSha256: sha(work.request), priorPlanSha256: planSha, priorPlanContentEmbedded: work.request.includes(JSON.stringify(planFiles['plan.json']).slice(1, -1)) };
  });
  await missions.start(); const duplicate = await missions.produceNextTasks(store); await missions.stop();
  check('no duplicate enqueue after reopen', () => { assert.equal(duplicate, 0); assert.equal(missionRuns(id).length, 2); });

  const report = digestRun(2, await executeStep(id, 2)); evidence.runs.push(report); save();
  check('report step delivered', () => { assert.equal(report.status, 'COMPLETED', report.error ?? ''); assert.equal(report.outcome, 'COMPLETED'); return report.classification; });
  check('model recorded completion', () => {
    assert.equal(report.mission?.state, 'complete');
    return { decision: report.mission, rejected: report.missionDecisions.filter(e => e.type === 'MISSION_DECISION_REJECTED') };
  });
  const reportFiles = verifyArtifacts(report, ['report.json', 'report.md', 'sources.json']);
  const { sources, citations } = recheckReport(reportFiles, missionRow(id).objective);
  check('memory note captured as an immutable, unverified snapshot', () => {
    const note = memory.list('probe').find(n => n.key === 'release-evidence');
    const expected = `memory-${sha(JSON.stringify([note.agent_id, note.key, note.updated_at, note.text])).slice(0, 24)}`;
    const snapshot = sources.find(s => s.id === expected);
    assert.ok(snapshot, `expected ${expected}`); assert.equal(snapshot.text, NOTE);
    assert.equal(snapshot.origin, 'Bot memory note release-evidence (operator; unverified note)');
    for (const s of sources.filter(s => s.id.startsWith('memory-'))) assert.match(s.origin, /unverified note\)$/);
    assert.ok(report.memoryEvents.some(e => e.type === 'MEMORY_RECALLED' && e.keys.includes('release-evidence')));
    return { sourceId: expected, cited: citations.some(c => c.sourceId === expected) };
  });

  await close(); open('after completion');
  await missions.start(); const after = await missions.produceNextTasks(store); await missions.stop();
  check('completed mission is final, with two runs and five files after reopen', () => {
    const row = missionRow(id), db = store.getDatabase();
    assert.equal(row.status, 'COMPLETED'); assert.equal(row.runs, 2); assert.equal(after, 0);
    const runs = db.prepare('SELECT id, status FROM task_runs ORDER BY rowid').all();
    assert.deepEqual(runs.map(r => r.id), [plan.runId, report.runId]); assert.ok(runs.every(r => r.status === 'COMPLETED'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_artifacts').get().n, 5);
    return { status: row.status, runs: row.runs, reason: row.reason };
  });
  check('no Docker workspace was requested', () => assert.deepEqual(evidence.forbiddenSandboxCalls, []));
}

async function blocker() {
  store.createAgent({ id: 'probe', name: 'Synthetic vendor reviewer', model_id: model, budget_cap_usd: 0.25, current_status: 'IDLE' });
  const id = missions.create({ agentId: 'probe', contractId: 'evidence-brief', maxRuns: 2, intervalMs: 60_000, objective: BLOCKER_OBJECTIVE }).id;
  const step = digestRun(1, await executeStep(id, 1)); evidence.runs.push(step); save();
  if (step.artifacts.length) recheckReport(verifyArtifacts(step, ['report.json', 'report.md', 'sources.json']), BLOCKER_OBJECTIVE);
  await close(); open('after blocker decision');
  now += 600_000; await missions.start(); const created = await missions.produceNextTasks(store); await missions.stop();
  await close(); open('blocked mission reopened');
  check('blocked mission stays waiting without further runs', () => {
    const row = missionRow(id);
    assert.equal(created, 0); assert.equal(row.status, 'WAITING'); assert.equal(missionRuns(id).length, 1);
    return { reason: row.reason, classification: step.classification };
  });
  check('blocker is structured with an actionable resumption condition', () => {
    assert.equal(step.mission?.state, 'wait', `Run ${step.outcome}; recorded decision ${step.mission?.state ?? 'none'} (${step.classification.class}).`);
    assert.ok(['missing_input', 'approval'].includes(step.mission.blocker?.kind)); assert.match(missionRow(id).reason, /Resume when: \S/);
    return step.mission.blocker;
  });
  check('no Docker workspace was requested', () => assert.deepEqual(evidence.forbiddenSandboxCalls, []));
}

try {
  if (!llm.hasProvider(model)) throw new Error('Configured provider credential absent.');
  await syncOpenRouterCatalog(); open('initial');
  await (scenario === 'delivery' ? delivery() : blocker());
  evidence.passed = evidence.checks.length > 0 && evidence.checks.every(c => c.passed);
  if (!evidence.passed) process.exitCode = 1;
} catch (error) { evidence.error = String(error.message ?? error); process.exitCode = 1; }
finally {
  try { await close(); } catch (error) { evidence.closeError = String(error); evidence.passed = false; process.exitCode = 1; }
  save();
  console.log(JSON.stringify({ scenario, passed: evidence.passed, error: evidence.error, runs: evidence.runs.map(r => ({ step: r.step, status: r.status, turns: r.turns, decision: r.mission?.state, class: r.classification.class })) }));
  console.log(`Evidence: ${output}`);
}
