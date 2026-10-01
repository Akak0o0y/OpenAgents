import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { BrowserTools } from '../src/daemon/browser-tools.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';
import { availableTools } from '../src/daemon/tool-schemas.js';
import type { LLMRequest } from '../src/evals/llm-client.js';
import http from 'node:http';
import { once } from 'node:events';
import type { BotDesktop } from '../src/daemon/bot-desktop.js';
import { parseCatalog } from '../src/daemon/provider-connections.js';
import { ApprovalGate } from '../src/daemon/control-plane.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6eUAAAAASUVORK5CYII=';
for (const native of [true, false]) test(`desktop screenshots reach model image blocks in ${native ? 'native' : 'JSON'} tool mode`, async () => {
  const store = new AgentStore(':memory:'), artifacts = new ArtifactStore(store), ledger = new CostLedger(store.getDatabase());
  const model = native ? 'claude-haiku-4-5' : 'gemini-2.5-flash';
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: model, current_status: 'IDLE', budget_cap_usd: 10 });
  const run = store.createTaskRun({ agentId: 'alpha', taskName: 'computer-fixture' }); store.startTaskRun(run.id, model);
  const browser = new BrowserTools({ store, artifacts, secrets: new MemorySecretStore() });
  const status = browser.status.bind(browser);
  browser.status = id => ({ ...status(id), computerEnabled: true });
  let dispatched = 0;
  browser.computerCall = async () => { dispatched++; return { width: 1440, height: 900, image: { mime: 'image/png', data: PNG } }; };
  const requests: LLMRequest[] = [];
  const llm = { async generateCode(request: LLMRequest) {
    requests.push(structuredClone({ ...request, signal: undefined, onStream: undefined, onProviderEvent: undefined }));
    const action = requests.length <= 2 ? { tool: 'computer', action: 'screenshot' } : { tool: 'answer', text: 'Inspected the screen.', citations: [] };
    if (native) return { content: '', toolCalls: [{ id: `call-${requests.length}`, name: action.tool, arguments: JSON.stringify(Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'tool'))) }], inputTokens: 1, outputTokens: 1, attemptCount: 1 };
    return { content: JSON.stringify(action), inputTokens: 1, outputTokens: 1, attemptCount: 1 };
  } };
  try {
    const runtime = new WorkRuntime({ store, artifacts, ledger, llm, browser, sandbox: new DockerSandbox(), visionModels: [model] });
    const result = await runtime.execute({ taskRunId: run.id, contract: CONVERSATION_CONTRACT, conversation: true, request: 'Inspect your own desktop twice.', signal: new AbortController().signal });
    assert.equal(result.outcome, 'COMPLETED', result.report);
    assert.equal(dispatched, 2);
    for (const request of requests.slice(1)) {
      assert.equal(request.messages!.flatMap(message => message.images ?? []).length, 1, 'only latest screen is retained');
      assert.equal(request.messages!.flatMap(message => message.images ?? [])[0].data, PNG);
      assert.ok(!request.messages!.some(message => message.content.includes(PNG)), 'base64 never becomes text');
    }
    assert.ok(!JSON.stringify(store.getTaskEvents(run.id)).includes(PNG), 'screen bytes never enter tool logs');
    if (native) assert.ok(requests[0].tools?.some(tool => tool.name === 'computer'));
  } finally { await browser.stop(); ledger.close(); store.close(); }
});

test('native computer tool is not advertised without confirmed visual desktop support', () => {
  assert.equal(availableTools({ browserEnabled: true }).some(tool => tool.name === 'computer'), false);
  assert.equal(availableTools({ browserEnabled: true, computerEnabled: true }).some(tool => tool.name === 'computer'), true);
});

test('provider image modalities enable vision only when actually reported', () => {
  const models = parseCatalog({ data: [
    { id: 'vision', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'text', architecture: { input_modalities: ['text'] } },
    { id: 'unknown' },
    { id: 'disabled', supports_vision: false, architecture: { input_modalities: ['image'] } },
  ] });
  assert.deepEqual(models.map(model => model.supportsVision), [true, false, null, false]);
});

test('native adapter enforces bot ownership, approval, fresh observations and uncertain-action records', async () => {
  let calls = 0, responseStatus = 200;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    calls++; res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ width: 1440, height: 900, image: { mime: 'image/png', data: PNG } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const store = new AgentStore(':memory:'), artifacts = new ArtifactStore(store), approvals = new ApprovalGate(store);
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'claude-haiku-4-5', current_status: 'IDLE', budget_cap_usd: 1 });
  const run = store.createTaskRun({ agentId: 'alpha', taskName: 'native-adapter' }); store.startTaskRun(run.id, 'claude-haiku-4-5');
  const desktop = { endpoint: (agentId: string) => { assert.equal(agentId, 'alpha'); return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'fixture-token' }; } } as unknown as BotDesktop;
  const browser = new BrowserTools({ store, artifacts, approvals, desktop, secrets: new MemorySecretStore() });
  // Isolate the daemon/gateway contract without launching any user's desktop.
  const session: any = { agentId: 'alpha', runId: run.id, writes: new Set<string>() };
  (browser as any).open = async () => session;
  const signal = new AbortController().signal;
  const call = (input: object, bot = 'alpha') => browser.computerCall(bot, run.id, { tool: 'computer', ...input } as any, signal);
  let approve = false;
  const timer = setInterval(() => { for (const pending of store.listApprovals({ pendingOnly: true })) approvals.decide(pending.id, approve ? 'APPROVED' : 'DENIED', 'Fixture'); }, 10);
  const intents = () => store.getTaskEvents(run.id).filter(event => event.event_type === 'EXTERNAL_ACTION_STARTED');
  try {
    await assert.rejects(call({ action: 'screenshot' }, 'beta'), /belonging/);
    await assert.rejects(call({ action: 'click', x: 10, y: 10 }), /fresh computer screenshot/);
    assert.equal(calls, 0);
    await call({ action: 'screenshot' });
    await assert.rejects(call({ action: 'click', x: 10, y: 10 }), /not approved/);
    assert.equal(calls, 1); assert.equal(intents().length, 0);
    approve = true;
    await call({ action: 'screenshot' });
    await assert.rejects(call({ action: 'click', x: 2000, y: 10 }), /outside/);
    await call({ action: 'click', x: 10, y: 10 });
    assert.equal(intents().length, 1);
    responseStatus = 409;
    await assert.rejects(call({ action: 'key', key: 'Return' }), /not dispatched/);
    assert.equal(store.getTaskEvents(run.id).filter(event => event.event_type === 'EXTERNAL_ACTION_FINISHED').length, 2);
    responseStatus = 200; await call({ action: 'screenshot' }); responseStatus = 502;
    await assert.rejects(call({ action: 'click', x: 10, y: 10 }), /outcome is uncertain/);
    assert.equal(intents().length, 3);
    assert.equal(store.getTaskEvents(run.id).filter(event => event.event_type === 'EXTERNAL_ACTION_FINISHED').length, 2, 'uncertain intent remains open');
    await assert.rejects(call({ action: 'click', x: 10, y: 10 }), /fresh computer screenshot/);
    assert.equal(session.actionDone, undefined, 'lease is released on every path');
  } finally { clearInterval(timer); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
