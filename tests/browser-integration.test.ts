import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { BrowserTools } from '../src/daemon/browser-tools.js';
import { WebResearch } from '../src/daemon/web-research.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';
import { ApprovalGate } from '../src/daemon/control-plane.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { ChatService } from '../src/daemon/chat.js';
import { MissionService } from '../src/daemon/missions.js';
import { RunCapacity } from '../src/daemon/run-capacity.js';
import { TaskScheduler } from '../src/daemon/scheduler.js';
import { ProviderRouter } from '../src/daemon/provider-router.js';
import { RoutineWorkProducer } from '../src/daemon/routine-producer.js';
import { DIRECT_WORK_CONTRACTS, findWorkContract, workTaskDefinition } from '../src/daemon/work-contract.js';
import { readWorkResult } from '../src/daemon/work-results.js';
import type { LLMRequest } from '../src/evals/llm-client.js';

const issue = (n: number) => `https://github.com/openagents-fixture/not-real/issues/${n}`;
async function fixtureSite() {
  const state = { posts: 0, reads: 0 };
  const server = http.createServer((req, res) => {
    state.reads++;
    if (req.method === 'POST') state.posts++;
    if (req.url === '/download') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="result.txt"' }); res.end('verified download bytes'); return; }
    if (req.url === '/hang' && req.method === 'POST') return;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<title>Controlled task</title><h1>Fixture evidence is available.</h1><p>${issue(1)} needs a parser correction.</p><p>${issue(2)} needs a validation correction.</p><form method="post"><label>Note<input name="note"></label><button>Submit note</button></form><a href="/download">Download result</a>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
const report = (sourceId: string) => ({ tool: 'write', path: 'report.json', content: JSON.stringify({ title: 'Observed fixture', findings: [{ claim: 'The fixture supplies evidence.', evidence: [{ sourceId, quote: 'Fixture evidence is available.' }] }], limitations: ['Controlled fixture only. No repository fix or publication was performed.'] }) });
async function until(done: () => boolean) { for (let i = 0; i < 1000 && !done(); i++) await delay(10); assert.ok(done(), 'Execution did not settle.'); }
function harness(origin: string, actions: unknown[], db = ':memory:', now = Date.now) {
  const store = new AgentStore(db), ledger = new CostLedger(store.getDatabase()), artifacts = new ArtifactStore(store), approvals = new ApprovalGate(store), capacity = new RunCapacity(1);
  if (!store.getAgent('alpha')) store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'claude-haiku-4-5', budget_cap_usd: 10, current_status: 'IDLE' });
  const requests: LLMRequest[] = [];
  const llm = { async generateCode(req: LLMRequest) { requests.push({ ...req, messages: structuredClone(req.messages) }); const action = actions.shift(); assert.ok(action, 'Unexpected model turn'); return { content: JSON.stringify(action), inputTokens: 1, outputTokens: 1, attemptCount: 1 }; } };
  const sandbox = new DockerSandbox(); sandbox.createWorkspaceVolume = async () => { throw new Error('Research must not start Docker.'); };
  const browser = new BrowserTools({ store, artifacts, approvals, secrets: new MemorySecretStore(), previewOrigins: [origin] });
  const missions = new MissionService(store, DIRECT_WORK_CONTRACTS, 2, now);
  const runtime = new WorkRuntime({ store, ledger, artifacts, approvals, llm, sandbox, browser, missions, contracts: DIRECT_WORK_CONTRACTS, web: new WebResearch({ previewOrigins: [origin] }) });
  const chat = new ChatService({ agentStore: store, ledger, llmClient: llm, workRuntime: runtime, agenticChat: true, capacity });
  const scheduler = (producer: MissionService | RoutineWorkProducer) => new TaskScheduler({ agentStore: store, ledger, llmClient: llm, sandbox, workRuntime: runtime, capacity, providerRouter: new ProviderRouter(), maxConcurrency: 1, cadenceMs: 10, executor: 'builtin', canRun: id => missions.canRun(id), workProducer: producer });
  return { store, ledger, artifacts, approvals, capacity, browser, missions, runtime, chat, requests, scheduler,
    async close() { await chat.stop(); await browser.stop(); await missions.stop(); ledger.close(); store.close(); } };
}

test('normal chat drives real browser forms and retains binary evidence without image-model claims or replay', { timeout: 60000 }, async () => {
  const site = await fixtureSite();
  const actions = [{ tool: 'browser', action: 'navigate', url: site.origin }, { tool: 'browser', action: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'Fixture submission' },
    { tool: 'browser', action: 'click', target: { role: 'button', name: 'Submit note' } }, { tool: 'browser', action: 'screenshot' },
    { tool: 'browser', action: 'download', target: { role: 'link', name: 'Download result' } },
    { tool: 'answer', text: 'Submitted the fixture note and saved its evidence.', citations: [{ sourceId: 'source-1', quote: 'Fixture evidence is available.' }] }];
  const h = harness(site.origin, actions);
  const decide = setInterval(() => { for (const row of h.store.listApprovals({ pendingOnly: true })) h.approvals.decide(row.id, 'APPROVED', 'Controlled fixture grant'); }, 10);
  try {
    const thread = h.chat.createThread('alpha');
    const result = await h.chat.send(thread.id, 'Fill and submit the fixture note, capture and download its evidence.', 'browser-request');
    assert.equal(result.work?.outcome, 'COMPLETED', result.work?.report);
    assert.equal(site.state.posts, 1); assert.equal(actions.length, 0);
    assert.equal(h.store.listApprovals({}).length, 1, 'one origin/run grant covers subsequent matching interactions');
    const captured = h.artifacts.list(result.taskRunId, true);
    const download = captured.find(a => a.path.endsWith('result.txt'))!;
    assert.equal(download.sha256, createHash('sha256').update('verified download bytes').digest('hex'));
    const jpg = captured.find(a => a.path.endsWith('.jpg'))!;
    const bytes = Buffer.from(h.artifacts.read(result.taskRunId, jpg.id)!.content, 'base64');
    assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8'); assert.equal(createHash('sha256').update(bytes).digest('hex'), jpg.sha256);
    assert.match(result.reply.content, /Browser captures:/);
    assert.match(h.requests[0].systemPrompt, /accessibility text, not images/);
    const reads = site.state.reads;
    assert.deepEqual(await h.chat.send(thread.id, 'Fill and submit the fixture note, capture and download its evidence.', 'browser-request'), result);
    assert.equal(site.state.reads, reads); assert.equal(site.state.posts, 1);
    assert.equal(h.browser.status().active, 0); assert.equal(h.capacity.used, 0);
  } finally { clearInterval(decide); await h.close(); await site.close(); }
});

test('browser tasks continue beyond the citation budget and recover from missing targets', { timeout: 60000 }, async () => {
  const site = await fixtureSite();
  const actions: unknown[] = [
    ...Array.from({ length: 14 }, (_, index) => ({ tool: 'browser', action: 'navigate', url: `${site.origin}/?step=${index}` })),
    { tool: 'browser', action: 'click', target: { role: 'link', name: 'Stale missing link' } },
    { tool: 'browser', action: 'snapshot' },
    { tool: 'answer', text: 'Inspected the workflow and recovered from the stale control.', citations: [] },
  ];
  const h = harness(site.origin, actions);
  try {
    const result = await h.chat.send(h.chat.createThread('alpha').id, 'Inspect the multi-page workflow.', 'long-browser-fixture');
    assert.equal(result.work?.outcome, 'COMPLETED', result.work?.report);
    assert.equal(actions.length, 0);
    assert.equal(h.store.getTaskEvents(result.taskRunId).filter(event => event.event_type === 'EXTERNAL_ACTION_STARTED').length, 0);
    assert.ok(h.requests.some(request => JSON.stringify(request.messages).includes('no interaction was dispatched')));
  } finally { await h.close(); await site.close(); }
});

test('a due routine executes a real browser inspection through the shared scheduler and saves checked sources', { timeout: 30000 }, async () => {
  const site = await fixtureSite();
  const actions = [{ tool: 'browser', action: 'navigate', url: site.origin }, report('source-1'), { tool: 'verify' }, { tool: 'finish' }];
  const h = harness(site.origin, actions); const producer = new RoutineWorkProducer({ maxQueueDepth: 2, getTaskDefinition: () => workTaskDefinition(findWorkContract('evidence-brief')!, '') }); const scheduler = h.scheduler(producer);
  const routine = h.store.createRoutine({ agentId: 'alpha', name: 'Browser report', cronExpression: '0 9 * * *', promptTemplate: `Inspect ${site.origin} and report its evidence.`, taskName: 'work:evidence-brief', nextRunAt: Date.now() - 10 });
  try {
    await producer.start(); scheduler.start();
    await until(() => h.store.getRoutine(routine.id)?.last_run_status === 'COMPLETED' && h.capacity.used === 0);
    const runId = (h.store.getDatabase().prepare('SELECT id FROM task_runs WHERE routine_id=? ORDER BY rowid DESC LIMIT 1').get(routine.id) as {id: string}).id;
    const result = readWorkResult(h.store, runId)!; assert.equal(result.outcome, 'COMPLETED');
    const sources = h.artifacts.read(runId, result.artifacts.find(a => a.path === 'sources.json')!.id)!.content;
    assert.match(sources, /Browser http/); assert.match(sources, /Fixture evidence is available/);
    assert.equal(actions.length, 0); assert.equal(h.browser.status().active, 0);
  } finally { await scheduler.stop(); await producer.stop(); await h.close(); await site.close(); }
});

test('chat creates one bounded mission; two distinct issues and their evidence survive pause and database reopen', { timeout: 60000 }, async () => {
  const site = await fixtureSite(); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-browser-mission-')); const db = path.join(root, 'state.db'); let now = Date.now();
  const start = { tool: 'start_mission', objective: 'Prepare evidence for two distinct fixture issues.', contractId: 'evidence-brief', maxRuns: 2, intervalMs: 60000 };
  const actions: unknown[] = [start, { tool: 'mission_items' }, { tool: 'web_read', url: site.origin }, { tool: 'track_issue', url: issue(1), disposition: 'selected', reason: 'First fixture candidate' }, report('source-2'), { tool: 'verify' }, { tool: 'finish', mission: { state: 'continue', reason: 'First issue report prepared; second remains.', nextRequest: 'Prepare a report for another distinct fixture issue.' } }];
  let h = harness(site.origin, actions, db, () => now); let scheduler = h.scheduler(h.missions);
  let decide: ReturnType<typeof setInterval> | undefined = setInterval(() => { for (const row of h.store.listApprovals({ pendingOnly: true })) h.approvals.decide(row.id, 'APPROVED', 'Fixture mission scope'); }, 10);
  try {
    const thread = h.chat.createThread('alpha'); const sent = await h.chat.send(thread.id, start.objective, 'mission-request');
    assert.equal(sent.work?.outcome, 'COMPLETED'); assert.match(sent.reply.content, /objective has not been completed/);
    assert.deepEqual(await h.chat.send(thread.id, start.objective, 'mission-request'), sent); assert.equal(h.missions.list().length, 1);
    clearInterval(decide); decide = undefined;
    const id = h.missions.list()[0].id;
    await h.missions.start(); scheduler.start();
    await until(() => h.missions.list()[0].runs === 1 && h.missions.list()[0].last_run_id === null && h.capacity.used === 0);
    h.missions.control(id, 'PAUSED'); await scheduler.stop(); await h.close();
    actions.push({ tool: 'mission_items' }, { tool: 'web_read', url: site.origin },
      { tool: 'track_issue', url: issue(1), disposition: 'selected', reason: 'Duplicate negative control' },
      { tool: 'track_issue', url: issue(2), disposition: 'selected', reason: 'Distinct second candidate' }, report('source-2'), { tool: 'verify' },
      { tool: 'finish', mission: { state: 'complete', reason: 'Two fixture issue reports are prepared; no code or publication was requested.' } });
    h = harness(site.origin, actions, db, () => now); scheduler = h.scheduler(h.missions); await h.missions.start(); now += 60000;
    assert.equal(await h.missions.produceNextTasks(h.store), 0, 'pause persists');
    h.missions.control(id, 'ACTIVE'); scheduler.start();
    await until(() => h.missions.list()[0].status === 'COMPLETED' && h.capacity.used === 0);
    const items = h.missions.itemsForRun(h.missions.list()[0].last_run_id!);
    assert.deepEqual(items.map(i => [i.url, i.state]), [[issue(1), 'prepared'], [issue(2), 'prepared']]);
    assert.ok(h.requests.some(req => req.messages!.some(m => m.content.includes('already handled or selected'))));
    assert.equal(actions.length, 0); assert.equal(h.missions.list()[0].runs, 2);
    assert.throws(() => h.missions.control(id, 'ACTIVE'), /run limit/);
    for (const item of items) { const result = readWorkResult(h.store, item.task_run_id)!; assert.ok(result.artifacts.some(a => a.path === 'sources.json')); assert.ok(h.artifacts.read(item.task_run_id, result.artifacts[0].id)); }
  } finally { if (decide) clearInterval(decide); await scheduler.stop(); await h.close(); await site.close(); }
});

test('cancelling a browser submission retains uncertain intent and closes its session without resubmitting', { timeout: 30000 }, async () => {
  const site = await fixtureSite();
  const actions = [{ tool: 'browser', action: 'navigate', url: `${site.origin}/hang` }, { tool: 'browser', action: 'screenshot' }, { tool: 'browser', action: 'click', target: { role: 'button', name: 'Submit note' } }];
  const h = harness(site.origin, actions); const decide = setInterval(() => { for (const row of h.store.listApprovals({ pendingOnly: true })) h.approvals.decide(row.id, 'APPROVED', 'Fixture grant'); }, 10);
  try {
    const thread = h.chat.createThread('alpha'); const pending = h.chat.send(thread.id, 'Submit the fixture form.', 'cancel-request');
    await until(() => site.state.posts === 1); await h.chat.stop();
    const result = await pending; const events = h.store.getTaskEvents(result.taskRunId);
    assert.notEqual(result.work?.outcome, 'COMPLETED');
    assert.ok(events.some(e => e.event_type === 'EXTERNAL_ACTION_STARTED'));
    assert.equal(events.some(e => e.event_type === 'EXTERNAL_ACTION_FINISHED'), false);
    assert.ok(h.artifacts.list(result.taskRunId, true).some(a => a.path.endsWith('.jpg')));
    assert.equal(h.browser.status().active, 0); assert.equal(h.capacity.used, 0); assert.equal(site.state.posts, 1);
  } finally { clearInterval(decide); await h.close(); await site.close(); }
});

test('denied chat missions are not created and stopped missions cannot restart after database reopen', async () => {
  const site = await fixtureSite(); const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-stopped-mission-')), 'state.db');
  let h = harness(site.origin, [{ tool: 'start_mission', objective: 'Prepare fixture evidence.', contractId: 'evidence-brief', maxRuns: 2, intervalMs: 60000 }], db);
  const decide = setInterval(() => { for (const row of h.store.listApprovals({ pendingOnly: true })) h.approvals.decide(row.id, 'DENIED', 'Fixture refusal'); }, 10);
  try {
    const refused = await h.chat.send(h.chat.createThread('alpha').id, 'Prepare fixture evidence continuously.', 'denied-mission');
    assert.equal(refused.work?.outcome, 'FAILED'); assert.equal(h.missions.list().length, 0);
    clearInterval(decide);
    const mission = h.missions.create({ agentId: 'alpha', objective: 'A bounded fixture mission.', contractId: 'evidence-brief', maxRuns: 2, intervalMs: 60000 });
    await h.missions.start(); await h.missions.produceNextTasks(h.store);
    const runId = h.missions.list()[0].last_run_id!;
    assert.equal(h.missions.control(mission.id, 'STOPPED'), runId, 'control identifies the task the API must abort');
    assert.equal(h.missions.canRun(runId), false);
    const aborter = h.scheduler(h.missions);
    assert.equal(aborter.abortTask(runId), true, 'the real scheduler aborts a stopped mission while queued');
    await aborter.stop(); assert.equal(h.store.getTaskRun(runId)?.status, 'ABORTED');
    await h.close(); h = harness(site.origin, [], db); await h.missions.start();
    assert.equal(h.missions.list()[0].status, 'STOPPED'); assert.match(h.missions.list()[0].reason, /not marked complete/);
    assert.throws(() => h.missions.control(mission.id, 'ACTIVE'), /was stopped/);
    assert.equal(await h.missions.produceNextTasks(h.store), 0);
  } finally { clearInterval(decide); await h.close(); await site.close(); }
});
