/**
 * Provider connections (Settings → Providers) against a real local HTTP gateway fixture.
 *
 * The fixture speaks the FreeLLMAPI surface OpenAgents relies on: GET /v1/models with execution_status, and
 * POST /v1/chat/completions with X-Routed-Via / X-Fallback-* / X-Request-ID response headers. No real gateway,
 * account or key is contacted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger, isRateLimitExceededError, registerModelPricing } from '../src/kernel/cost-ledger.js';
import type { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { LiveLLMClient, ProviderCallError } from '../src/evals/llm-client.js';
import { FREELLMAPI_PRESET, ProviderConnectionService, ProviderSetupError, modelRoute, providerKey } from '../src/daemon/provider-connections.js';
import { MemorySecretStore, UnavailableSecretStore, WindowsDpapiSecretStore } from '../src/daemon/secret-store.js';
import { ChatError, ChatService } from '../src/daemon/chat.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { TaskScheduler } from '../src/daemon/scheduler.js';
import { ProviderRouter } from '../src/daemon/provider-router.js';
import { RunCapacity } from '../src/daemon/run-capacity.js';
import { MissionService } from '../src/daemon/missions.js';
import { DIRECT_WORK_CONTRACTS, findWorkContract, workTaskDefinition } from '../src/daemon/work-contract.js';
import { enqueueRoutine } from '../src/daemon/routine-dispatch.js';
import { OpenCodeExecutor } from '../src/daemon/opencode-executor.js';
import { usageSummary } from '../src/daemon/usage.js';
import { fixtureFetch, DaemonWsServer } from './helpers/daemon-client.js';

const KEY = 'fixture-gateway-key-0123456789';
const SLASH_MODEL = 'meta-llama/llama-4-scout:free';
const plan = { title: 'Release plan', tasks: [{ id: 'check', title: 'Check release', doneWhen: 'Release test report exists', priority: 1, dependsOn: [] }], limitations: ['No date was supplied.'] };
const WRITE_PLAN = JSON.stringify({ tool: 'write', path: 'plan.json', content: JSON.stringify(plan) });
const VERIFY = JSON.stringify({ tool: 'verify' });
const FINISH = JSON.stringify({ tool: 'finish' });
const forbidden = async () => { throw new Error('Plans must not request a Docker workspace.'); };
const noDocker = { createWorkspaceVolume: forbidden, stageWorkspaceFiles: forbidden, readWorkspaceFile: forbidden, executeTask: forbidden, destroyWorkspaceVolume: forbidden };

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: any; aborted: boolean }
interface Reply { status?: number; headers?: Record<string, string>; body?: unknown; hold?: boolean }

async function gateway(respond: (request: Seen) => Reply) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: text ? JSON.parse(text) : null, aborted: false };
    seen.push(entry);
    res.on('close', () => { if (!res.writableEnded) entry.aborted = true; });
    const reply = respond(entry);
    if (reply.hold) return;
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/v1`, origin: `http://127.0.0.1:${port}`, seen,
    completions: () => seen.filter(entry => entry.url === '/v1/chat/completions'),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const completion = (content: string, usage: unknown = { prompt_tokens: 11, completion_tokens: 7 }) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) });

class DeferredSecretStore extends MemorySecretStore {
  release: (() => void) | undefined;
  defer = true;
  override async unprotect(ciphertext: string) {
    if (this.defer) await new Promise<void>(resolve => { this.release = resolve; });
    return super.unprotect(ciphertext);
  }
}

for (const mutation of ['remove-key', 'rotate', 'disable', 'endpoint', 'remove', 'disable-enable'] as const) {
  test(`credential unlock rejects superseded settings: ${mutation}`, async () => {
    const secrets = new DeferredSecretStore();
    const h = profile(':memory:', secrets);
    const service = new ProviderConnectionService(h.store, secrets, async () => { throw new Error('Network forbidden'); });
    try {
      const original = { name: 'Fixture', baseUrl: 'http://127.0.0.1:3001/v1', apiKey: KEY };
      const connection = await service.save(original);
      const pending = service.resolveForRequest(connection.id);
      const rejected = assert.rejects(pending, ProviderSetupError);
      await waitFor(() => !!secrets.release, 'credential unlock');
      const saved = { id: connection.id, name: original.name, baseUrl: original.baseUrl };
      if (mutation === 'remove-key') service.removeKey(connection.id);
      if (mutation === 'rotate') await service.save({ ...saved, apiKey: `${KEY}-replacement` });
      if (mutation === 'disable' || mutation === 'disable-enable') await service.save({ ...saved, enabled: false });
      if (mutation === 'disable-enable') await service.save({ ...saved, enabled: true });
      if (mutation === 'endpoint') await service.save({ ...saved, baseUrl: 'http://127.0.0.1:3002/v1' });
      if (mutation === 'remove') service.remove(connection.id);
      secrets.defer = false;
      secrets.release!();
      await rejected;
      if (['remove-key', 'disable', 'remove'].includes(mutation)) {
        await assert.rejects(service.resolveForRequest(connection.id), ProviderSetupError);
      } else {
        const fresh = await service.resolveForRequest(connection.id);
        assert.equal(fresh.apiKey, mutation === 'rotate' ? `${KEY}-replacement` : KEY);
        assert.equal(fresh.baseUrl, mutation === 'endpoint' ? 'http://127.0.0.1:3002/v1' : original.baseUrl);
      }
    } finally { h.close(); }
  });
}

test('credential cache observes removal by another service instance', async () => {
  const h = profile();
  try {
    const connection = await h.connections.save({ name: 'Fixture', baseUrl: 'http://127.0.0.1:3001/v1', apiKey: KEY });
    await h.connections.resolveForRequest(connection.id);
    new ProviderConnectionService(h.store, h.secrets).removeKey(connection.id);
    assert.equal(h.connections.get(connection.id)?.hasKey, false);
    await assert.rejects(h.connections.resolveForRequest(connection.id), ProviderSetupError);
  } finally { h.close(); }
});

test('credential resolution fences cached keys across synchronous removal', async () => {
  const h = profile();
  try {
    const connection = await h.connections.save({ name: 'Fixture', baseUrl: 'http://127.0.0.1:3001/v1', apiKey: KEY });
    await h.connections.resolveForRequest(connection.id);
    const pending = h.connections.resolveForRequest(connection.id);
    const rejected = assert.rejects(pending, ProviderSetupError);
    h.connections.removeKey(connection.id);
    await rejected;
  } finally { h.close(); }
});

test('a superseded connection probe cannot mark a replacement endpoint connected', async () => {
  const h = profile();
  let complete!: (response: Response) => void;
  const service = new ProviderConnectionService(h.store, h.secrets, async () => new Promise<Response>(resolve => { complete = resolve; }));
  try {
    const first = await service.save({ name: 'First', baseUrl: 'http://127.0.0.1:3001/v1', apiKey: KEY });
    const pending = service.test(first.id);
    await waitFor(() => !!complete, 'probe started');
    await service.save({ id: first.id, name: 'Replacement', baseUrl: 'http://127.0.0.1:3002/v1' });
    complete(new Response(JSON.stringify(catalog(['old-model', 'ready']))));
    const result = await pending;
    assert.equal(result.status, 'untested');
    assert.equal(result.catalog.models.length, 0);
    assert.equal(result.name, 'Replacement');
  } finally { h.close(); }
});

test('verified work through an unpriced gateway keeps its chat cost unknown', async () => {
  const steps = [WRITE_PLAN, VERIFY, FINISH];
  const gw = await gateway(() => ({ headers: routed('fixture/plan-model'), body: completion(steps.shift()!) }));
  const h = profile();
  let chat: ChatService | undefined;
  try {
    const connection = await h.connections.save({ name: 'Gateway', baseUrl: gw.url, apiKey: KEY });
    h.store.createAgent({ id: 'work-cost', name: 'Work', model_id: 'plan-model', budget_cap_usd: 1, current_status: 'IDLE', connection_id: connection.id });
    const llm = new LiveLLMClient({ connections: h.connections });
    const runtime = new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker, artifacts: new ArtifactStore(h.store) });
    chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: llm, workRuntime: runtime });
    const result = await chat.send(chat.createThread('work-cost').id, 'Plan the release', 'work-cost-request', 'action-plan');
    assert.equal(result.work?.outcome, 'COMPLETED');
    assert.equal(result.reply.cost_usd, null);
  } finally { await chat?.stop(); await gw.close(); h.close(); }
});
const routed = (via: string, extra: Record<string, string> = {}) => ({ 'X-Routed-Via': via, 'X-Request-ID': 'req-fixture', ...extra });
const catalog = (...models: Array<[string, string?]>) => ({ object: 'list', data: models.map(([id, status]) => ({ id, object: 'model', ...(status ? { execution_status: status } : {}) })) });
const reservations = (store: AgentStore) => store.getDatabase().prepare(`SELECT agent_id, model_id, pricing_state, status, actual_cost_usd, input_tokens, output_tokens,
  usage_source, served_model, routing_mode, connection_id FROM cost_reservations ORDER BY rowid`).all().map(row => ({ ...row })) as any[];

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 1500; i++) { if (check()) return; await delay(10); }
  assert.fail(`Timed out waiting for ${label}`);
}

function profile(dbPath = ':memory:', secrets = new MemorySecretStore()) {
  const store = new AgentStore(dbPath);
  const ledger = new CostLedger(store.getDatabase());
  const connections = new ProviderConnectionService(store, secrets);
  const events: Array<{ type: string; payload: any }> = [];
  store.setEventSink(event => events.push({ type: event.event_type, payload: JSON.parse(event.payload_json) }));
  return { store, ledger, connections, secrets, events, close() { ledger.close(); store.close(); } };
}

test('connection settings survive restart without exposing the key, failed saves keep the previous configuration and incomplete setup never reports connected', async () => {
  const gw = await gateway(req => req.url === '/v1/models' ? { body: catalog(['llama-3.3-70b', 'ready'], ['auto', 'ready']) } : { status: 404 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagents-providers-'));
  const db = path.join(dir, 'profile.db');
  try {
    let h = profile(db);
    const incomplete = await h.connections.save({ name: 'No key yet', baseUrl: gw.url });
    assert.equal(incomplete.status, 'incomplete');
    assert.equal((await h.connections.test(incomplete.id)).status, 'incomplete');
    assert.equal(gw.seen.length, 0, 'an incomplete connection is never probed');

    const saved = await h.connections.save({ name: 'FreeLLMAPI', preset: 'freellmapi', baseUrl: `${gw.url}/`, apiKey: KEY });
    assert.equal(saved.baseUrl, gw.url);
    assert.equal(saved.status, 'untested', 'saving never claims a working connection');
    assert.equal(saved.hasKey, true);
    assert.equal(gw.seen.length, 0, 'saving runs no request');
    const tested = await h.connections.test(saved.id);
    assert.equal(tested.status, 'connected');
    assert.equal(gw.seen[0].url, '/v1/models');
    assert.equal(gw.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.doesNotMatch(JSON.stringify(h.connections.list()), new RegExp(KEY));
    const stored = h.store.getDatabase().prepare('SELECT ciphertext FROM provider_secrets WHERE connection_id = ?').get(saved.id) as { ciphertext: string };
    assert.ok(!stored.ciphertext.includes(KEY), 'only protected ciphertext is stored');

    await assert.rejects(h.connections.save({ id: saved.id, name: 'FreeLLMAPI', baseUrl: 'ftp://127.0.0.1/v1', apiKey: 'replacement-key' }), ProviderSetupError);
    await assert.rejects(h.connections.save({ id: saved.id, name: 'FreeLLMAPI', baseUrl: 'http://user:pass@127.0.0.1:3001/v1' }), /key field/);
    await assert.rejects(h.connections.save({ id: saved.id, name: ' ', baseUrl: gw.url }), (error: any) => error?.name === 'ZodError');
    const failing = new ProviderConnectionService(h.store, new MemorySecretStore({ failProtect: true }));
    await assert.rejects(failing.save({ id: saved.id, name: 'Renamed', baseUrl: gw.url, apiKey: 'replacement-key' }), /Fixture protect failure/);
    const unavailable = new ProviderConnectionService(h.store, new UnavailableSecretStore('No protected storage on this fixture.'));
    await assert.rejects(unavailable.save({ id: saved.id, name: 'Renamed', baseUrl: gw.url, apiKey: 'replacement-key' }), (error: any) => error.status === 409 && /No protected storage/.test(error.message));
    const unchanged = h.connections.get(saved.id)!;
    assert.deepEqual([unchanged.name, unchanged.status, unchanged.baseUrl, unchanged.hasKey], ['FreeLLMAPI', 'connected', gw.url, true]);
    assert.equal((await h.connections.resolveForRequest(saved.id)).apiKey, KEY);

    h.close();
    h = profile(db, new MemorySecretStore());
    const reopened = h.connections.get(saved.id)!;
    assert.deepEqual([reopened.status, reopened.hasKey, reopened.catalog.models.length], ['connected', true, 2]);
    assert.equal((await h.connections.resolveForRequest(saved.id)).apiKey, KEY, 'the key unlocks again after restart');

    await h.connections.save({ id: saved.id, name: 'FreeLLMAPI', baseUrl: gw.url, apiKey: 'second-key-fixture' });
    assert.equal((await h.connections.resolveForRequest(saved.id)).apiKey, 'second-key-fixture');
    assert.equal(h.connections.get(saved.id)!.status, 'untested', 'a replaced key must be tested again');
    const keyless = h.connections.removeKey(saved.id);
    assert.deepEqual([keyless.hasKey, keyless.status], [false, 'incomplete']);
    await assert.rejects(h.connections.resolveForRequest(saved.id), /No gateway key/);

    h.store.createAgent({ id: 'gw-bot', name: 'Gateway bot', model_id: 'llama-3.3-70b', budget_cap_usd: 10, current_status: 'IDLE', connection_id: saved.id, routing_mode: 'pinned' });
    assert.throws(() => h.connections.remove(saved.id), (error: any) => error.status === 409 && /gw-bot/.test(error.message));
    h.store.updateAgent('gw-bot', { connection_id: null });
    assert.equal(h.store.getAgent('gw-bot')!.connection_id, undefined);
    assert.deepEqual(h.connections.remove(saved.id), { removed: true });
    assert.equal(h.connections.get(saved.id), null);
    h.close();
  } finally {
    await gw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the providers HTTP API never returns a key, rejects invalid settings without echoing them and requires daemon credentials', async () => {
  const h = profile();
  const port = 4197;
  const server = new DaemonWsServer(port, () => ({ agents: h.store.listAgents(), taskRuns: [], routines: [], executor: 'builtin' }), {
    approvals: () => [], mcpStatus: () => [], getRunEvents: () => [], getRunWorkspace: async () => ({ available: false, reason: 'test' }), readRunFile: async () => ({ available: false, reason: 'test' }),
  });
  server.setProviderApi({
    list: async () => ({ connections: h.connections.list(), secretStorage: await h.connections.availability(), preset: FREELLMAPI_PRESET }),
    save: body => h.connections.save(body), test: id => h.connections.test(id), refreshModels: id => h.connections.refreshModels(id),
    models: id => h.connections.models(id), removeKey: id => h.connections.removeKey(id), remove: id => h.connections.remove(id),
  });
  await server.start();
  try {
    const call = (route: string, init: RequestInit = {}) => fixtureFetch(`http://127.0.0.1:${port}${route}`, init);
    const post = (route: string, body: unknown) => call(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const created = await post('/api/providers', { name: 'FreeLLMAPI', preset: 'freellmapi', baseUrl: 'http://127.0.0.1:3001/v1', apiKey: KEY });
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    assert.doesNotMatch(createdText, new RegExp(KEY));
    const id = JSON.parse(createdText).connection.id;
    const listed = await call('/api/providers');
    const listedText = await listed.text();
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(listedText, new RegExp(KEY));
    assert.match(listedText, /"hasKey":true/);
    assert.equal(JSON.parse(listedText).preset.baseUrl, 'http://127.0.0.1:3001/v1');

    const invalid = await post('/api/providers', { name: 'Gateway', baseUrl: 'http://127.0.0.1:3001/v1', apiKey: KEY, unexpected: 'field' });
    const invalidText = await invalid.text();
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(invalidText, new RegExp(KEY));
    const credentialsInUrl = await post('/api/providers', { name: 'Gateway', baseUrl: `http://user:${KEY}@127.0.0.1:3001/v1` });
    assert.equal(credentialsInUrl.status, 400);
    assert.doesNotMatch(await credentialsInUrl.text(), new RegExp(KEY));
    assert.equal((await call(`/api/providers/${id}/unknown`, { method: 'POST' })).status, 404);
    assert.equal((await call('/api/providers/missing-connection', { method: 'DELETE' })).status, 404);
    const keyRemoved = await call(`/api/providers/${id}/key`, { method: 'DELETE' });
    assert.equal((await keyRemoved.json() as any).connection.hasKey, false);
    const raw = await fetch(`http://127.0.0.1:${port}/api/providers`);
    assert.ok([401, 403].includes(raw.status), `unauthenticated read answered ${raw.status}`);
  } finally {
    await server.close();
    h.close();
  }
});

test('a gateway call sends the exact URL, key, wire model and messages, adds no retry layer and carries cancellation and deadlines through the hop', async () => {
  type Mode = 'ok' | 'hold' | '429' | '503' | '401';
  let mode = 'ok' as Mode;
  const gw = await gateway(() => {
    if (mode === 'hold') return { hold: true };
    if (mode === '429') return { status: 429, body: { error: { type: 'rate_limit_error', message: 'upstream detail sk-private-detail-abcdef' } } };
    if (mode === '503') return { status: 503, body: { error: { type: 'no_providers_configured', message: 'none' } } };
    if (mode === '401') return { status: 401, body: { error: { type: 'authentication_error', message: 'bad key' } } };
    return { headers: routed(`openrouter/${SLASH_MODEL}`), body: completion('hello') };
  });
  const h = profile();
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'openrouter-fixture-must-not-be-used';
  try {
    const connection = await h.connections.save({ name: 'FreeLLMAPI', baseUrl: gw.url, apiKey: KEY });
    const client = new LiveLLMClient({ connections: h.connections, retryBaseDelayMs: 0 });
    const request = {
      modelId: SLASH_MODEL, systemPrompt: 'System fixture', userPrompt: 'Second',
      messages: [{ role: 'user' as const, content: 'First' }, { role: 'assistant' as const, content: 'Reply' }, { role: 'user' as const, content: 'Second' }],
      connection: { id: connection.id, routingMode: 'pinned' as const },
    };
    const response = await client.generateCode(request);
    assert.equal(response.content, 'hello');
    assert.equal(response.attemptCount, 1);
    assert.deepEqual(response.served, { connectionId: connection.id, routingMode: 'pinned', requestedModel: SLASH_MODEL, routedVia: `openrouter/${SLASH_MODEL}`,
      matchesRequested: true, fallbackAttempts: null, fallbackTrail: null, requestId: 'req-fixture', usageSource: 'gateway-reported' });
    const sent = gw.completions()[0];
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`, 'the connection key, not another provider variable');
    assert.equal(sent.headers['x-freellm-compress'], 'off');
    for (const header of ['x-session-id', 'idempotency-key', 'http-referer', 'x-title', 'x-freellm-cache']) assert.equal(sent.headers[header], undefined, header);
    assert.equal(sent.body.model, SLASH_MODEL);
    assert.deepEqual(sent.body.messages, [{ role: 'system', content: 'System fixture' }, { role: 'user', content: 'First' }, { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Second' }]);
    assert.equal(sent.body.stream, false);

    // What must never be retried: a rate limit, where the gateway has already exhausted
    // its own fallbacks so waiting changes nothing, and a rejected key, where repeating
    // only delays the message that tells the operator what to fix.
    const failures: Array<[Mode, (error: any) => boolean]> = [
      ['429', error => isRateLimitExceededError(error) && error.attempts === 1 && /rate_limit_error/.test(error.message) && !/sk-private/.test(error.message)],
      ['401', error => error instanceof ProviderCallError && /replace it in Settings/.test(error.message) && !/bad key/.test(error.message)],
    ];
    for (const [status, check] of failures) {
      mode = status;
      const before = gw.completions().length;
      await assert.rejects(client.generateCode(request), check);
      assert.equal(gw.completions().length, before + 1, `HTTP ${status} is not retried by OpenAgents`);
    }

    // A 503 is the gateway reporting that its own upstream is unavailable: the reply never
    // began, nothing was generated and nothing was charged, so it is retried. Routines
    // were dying permanently on exactly this, and on its sibling 502.
    mode = '503';
    const beforeTransient = gw.completions().length;
    await assert.rejects(client.generateCode(request),
      error => error instanceof ProviderCallError && error.details.status === 503 && /no_providers_configured/.test(error.message));
    assert.equal(gw.completions().length, beforeTransient + 3, 'a transient upstream failure is retried, and bounded at three attempts');

    // Six requests so far: the successful one, 429, 401, and the 503 retried three times.
    const held = gw.completions().length;
    assert.equal(held, 6, 'the retried 503 accounts for three of these');
    mode = 'hold';
    const controller = new AbortController();
    const pending = client.generateCode({ ...request, signal: controller.signal });
    await waitFor(() => gw.completions().length === held + 1, 'held request');
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof ProviderCallError && error.code === 'CANCELLED');
    await waitFor(() => gw.completions()[held].aborted, 'gateway disconnect');

    const deadline = new LiveLLMClient({ connections: h.connections, requestTimeoutMs: 80 });
    await assert.rejects(deadline.generateCode(request), (error: unknown) => error instanceof ProviderCallError && error.code === 'TIMEOUT');
    await waitFor(() => gw.completions()[held + 1]?.aborted === true, 'deadline disconnect');
    assert.equal(gw.completions().length, held + 2);
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
    await gw.close();
    h.close();
  }
});

test('two connections serving the same model ID keep their own endpoint, key and cooldown', async () => {
  const a = await gateway(() => ({ headers: routed('groq/llama-3.3-70b'), body: completion('from A') }));
  const b = await gateway(() => ({ headers: routed('cerebras/llama-3.3-70b'), body: completion('from B') }));
  const h = profile();
  try {
    const ca = await h.connections.save({ name: 'Gateway A', baseUrl: a.url, apiKey: 'key-a-fixture' });
    const cb = await h.connections.save({ name: 'Gateway B', baseUrl: b.url, apiKey: 'key-b-fixture' });
    h.store.createAgent({ id: 'bot-a', name: 'A', model_id: 'llama-3.3-70b', budget_cap_usd: 10, current_status: 'IDLE', connection_id: ca.id, routing_mode: 'pinned' });
    h.store.createAgent({ id: 'bot-b', name: 'B', model_id: 'llama-3.3-70b', budget_cap_usd: 10, current_status: 'IDLE', connection_id: cb.id });
    assert.equal(h.store.getAgent('bot-b')!.routing_mode, 'pinned', 'a connection without an explicit mode is pinned');
    const client = new LiveLLMClient({ connections: h.connections });
    for (const [bot, gw, key, reply] of [['bot-a', a, 'key-a-fixture', 'from A'], ['bot-b', b, 'key-b-fixture', 'from B']] as const) {
      const route = modelRoute(h.store, h.store.getAgent(bot)!);
      const response = await client.generateCode({ modelId: 'llama-3.3-70b', systemPrompt: 's', userPrompt: 'u', connection: route.connection });
      assert.equal(response.content, reply);
      assert.equal(gw.completions().at(-1)!.headers.authorization, `Bearer ${key}`);
    }
    assert.deepEqual([a.completions().length, b.completions().length], [1, 1]);

    const router = new ProviderRouter();
    const keyA = providerKey(h.store.getAgent('bot-a')!), keyB = providerKey(h.store.getAgent('bot-b')!);
    assert.notEqual(keyA, keyB);
    router.recordError(keyA, 429, '{}');
    assert.equal(router.canSchedule(keyA).allowed, false);
    assert.equal(router.canSchedule(keyB).allowed, true);
    assert.equal(router.canSchedule('llama-3.3-70b').allowed, true, 'an ordinary provider model with the same ID is unaffected');
  } finally {
    await a.close(); await b.close(); h.close();
  }
});

test('testing distinguishes invalid keys, malformed catalogs, unusable and exhausted pools, unreachable gateways and stale catalogs', async () => {
  let reply: Reply = { body: {} };
  const gw = await gateway(() => reply);
  let now = 1_000_000;
  const h = profile();
  const service = new ProviderConnectionService(h.store, h.secrets, undefined, () => now);
  try {
    const id = (await service.save({ name: 'Gateway', baseUrl: gw.url, apiKey: KEY })).id;
    const outcome = async (next: Reply) => { reply = next; return service.refreshModels(id); };
    assert.equal((await outcome({ status: 401, body: { error: { type: 'authentication_error' } } })).status, 'invalid_credentials');
    assert.equal((await outcome({ body: { models: [] } })).status, 'invalid_catalog');
    assert.equal((await outcome({ body: 'not json' })).status, 'invalid_catalog');
    const unusable = await outcome({ body: catalog(['gemini-2.5-pro', 'needsKey'], ['auto', 'ready'], ['auto:fast', 'ready']) });
    assert.equal(unusable.status, 'no_usable_models', 'ready routing aliases are not evidence of a usable key');
    assert.deepEqual(unusable.catalog.models.map(m => [m.id, m.usable, m.virtual]), [['gemini-2.5-pro', false, false], ['auto', true, true], ['auto:fast', true, true]]);
    assert.equal((await outcome({ body: catalog(['a', 'exhausted'], ['b', 'exhausted']) })).status, 'exhausted');
    const connected = await outcome({ body: { data: [{ id: SLASH_MODEL, execution_status: 'ready', supports_tools: true }, { id: SLASH_MODEL }, { id: 7 }, { id: 'no-status' }] } });
    assert.equal(connected.status, 'connected');
    assert.deepEqual(connected.catalog.models.map(m => [m.id, m.usable, m.supportsTools]), [[SLASH_MODEL, true, true], ['no-status', null, null]]);

    const requests = gw.seen.length;
    reply = { body: catalog([SLASH_MODEL, 'exhausted']) };
    now += 60_000;
    assert.equal((await service.models(id)).status, 'connected');
    assert.equal(gw.seen.length, requests, 'a fresh catalog is served from its cache');
    now += 5 * 60_000;
    assert.equal((await service.models(id)).status, 'exhausted');
    assert.equal(gw.seen.length, requests + 1, 'a stale catalog is fetched again');

    await service.save({ id, name: 'Gateway', baseUrl: gw.url, enabled: false });
    assert.equal((await service.test(id)).status, 'disabled');
    await assert.rejects(service.resolveForRequest(id), /disabled/);
    assert.equal(gw.seen.length, requests + 1, 'a disabled connection is not probed');

    await gw.close();
    await service.save({ id, name: 'Gateway', baseUrl: gw.url, enabled: true });
    const unreachable = await service.test(id);
    assert.equal(unreachable.status, 'unreachable');
    assert.doesNotMatch(unreachable.statusMessage, new RegExp(KEY));
  } finally {
    await gw.close();
    h.close();
  }
});

test('pinned mode discards answers from a different model and keeps unreported or body-named identity; automatic mode keeps requested and served identity with fallback history', async () => {
  const replies: Reply[] = [];
  const gw = await gateway(() => replies.shift() ?? { status: 500, body: { error: { type: 'fixture_exhausted' } } });
  const h = profile();
  try {
    const c = await h.connections.save({ name: 'FreeLLMAPI', baseUrl: gw.url, apiKey: KEY });
    h.store.createAgent({ id: 'pinned-bot', name: 'Pinned', model_id: 'llama-3.3-70b', budget_cap_usd: 10, current_status: 'IDLE', connection_id: c.id, routing_mode: 'pinned' });
    h.store.createAgent({ id: 'auto-bot', name: 'Auto', model_id: 'auto', budget_cap_usd: 10, current_status: 'IDLE', connection_id: c.id, routing_mode: 'auto' });
    const chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: new LiveLLMClient({ connections: h.connections }) });

    const pinned = chat.createThread('pinned-bot');
    replies.push({ headers: routed('groq/qwen-3-32b'), body: completion('{"tool":"finish"}') });
    await assert.rejects(chat.send(pinned.id, 'Hello', 'p1'), (error: unknown) => error instanceof ChatError && /answered with groq\/qwen-3-32b instead of the chosen model llama-3.3-70b/.test(error.message));
    assert.equal(h.store.getMessages(pinned.id).filter(m => m.role === 'assistant').length, 0, 'refused answers are never stored');
    // A provider that names no model is not evidence of a substitution; the
    // answer is kept and its identity recorded as unverified.
    replies.push({ body: completion('unverifiable answer') });
    assert.equal((await chat.send(pinned.id, 'Hello again', 'p2')).reply.content, 'unverifiable answer');
    replies.push({ headers: routed('groq/llama-3.3-70b'), body: completion('Pinned answer') });
    assert.equal((await chat.send(pinned.id, 'Third', 'p3')).reply.content, 'Pinned answer');
    // OpenRouter-style providers name the served model in the body, including dated variants.
    replies.push({ body: { ...completion('Body-named answer'), model: 'llama-3.3-70b-versatile' } });
    assert.equal((await chat.send(pinned.id, 'Fourth', 'p4')).reply.content, 'Body-named answer');
    replies.push({ body: { ...completion('Substituted answer'), model: 'mistral-small' } });
    await assert.rejects(chat.send(pinned.id, 'Fifth', 'p5'), /answered with mistral-small instead of the chosen model llama-3.3-70b/);
    assert.equal(h.store.getMessages(pinned.id).filter(m => m.role === 'assistant').length, 3, 'only substituted answers are refused');
    const pinnedRows = reservations(h.store).filter(row => row.agent_id === 'pinned-bot');
    assert.deepEqual(pinnedRows.map(row => [row.status, row.served_model, row.input_tokens, row.actual_cost_usd]), [
      ['RECONCILED', 'groq/qwen-3-32b', 11, null], ['RECONCILED', null, 11, null], ['RECONCILED', 'groq/llama-3.3-70b', 11, null],
      ['RECONCILED', 'llama-3.3-70b-versatile', 11, null], ['RECONCILED', 'mistral-small', 11, null]]);
    assert.deepEqual(h.events.filter(e => e.type === 'PROVIDER_SERVED' && e.payload.routingMode === 'pinned').map(e => [e.payload.routedVia, e.payload.accepted]),
      [['groq/qwen-3-32b', false], [null, true], ['groq/llama-3.3-70b', true], ['llama-3.3-70b-versatile', true], ['mistral-small', false]]);

    const auto = chat.createThread('auto-bot');
    replies.push({ headers: routed('groq/llama-3.3-70b', { 'X-Fallback-Attempts': '0' }), body: completion('first served') });
    replies.push({ headers: routed('cerebras/qwen-3-32b', { 'X-Fallback-Attempts': '2',
      'X-Fallback-Trail': 'groq/llama-3.3-70b:429 > mistral/small:503 sk-abcdefghijklmnopqrstuv > cerebras/qwen-3-32b:ok' }), body: completion('second served') });
    assert.equal((await chat.send(auto.id, 'One', 'a1')).reply.content, 'first served');
    assert.equal((await chat.send(auto.id, 'Two', 'a2')).reply.content, 'second served');
    const served = h.events.filter(e => e.type === 'PROVIDER_SERVED' && e.payload.routingMode === 'auto').map(e => e.payload);
    assert.deepEqual(served.map(s => [s.requestedModel, s.routedVia, s.matchesRequested, s.fallbackAttempts, s.accepted]),
      [['auto', 'groq/llama-3.3-70b', false, 0, true], ['auto', 'cerebras/qwen-3-32b', false, 2, true]]);
    assert.match(served[1].fallbackTrail, /mistral\/small:503 \[redacted\] > cerebras/);
    assert.deepEqual(reservations(h.store).filter(row => row.agent_id === 'auto-bot').map(row => [row.model_id, row.served_model, row.routing_mode]),
      [['auto', 'groq/llama-3.3-70b', 'auto'], ['auto', 'cerebras/qwen-3-32b', 'auto']]);
    assert.equal(gw.completions().length, 7, 'one gateway call per OpenAgents turn');
  } finally {
    await gw.close();
    h.close();
  }
});

test('gateway usage is kept with unknown cost, bounded by per-connection admission, never replayed and never counted when nothing was sent', async () => {
  let usage: unknown = { prompt_tokens: 100, completion_tokens: 20 };
  const gw = await gateway(() => ({ headers: routed('groq/llama-3.3-70b'), body: completion('answer', usage) }));
  const h = profile();
  try {
    const c = await h.connections.save({ name: 'FreeLLMAPI', baseUrl: gw.url, apiKey: KEY, limits: { requestsPerDay: 3, tokensPerDay: 1_000_000 } });
    h.store.createAgent({ id: 'gw-bot', name: 'Gateway bot', model_id: 'llama-3.3-70b', budget_cap_usd: 10, current_status: 'IDLE', connection_id: c.id, routing_mode: 'pinned' });
    const chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: new LiveLLMClient({ connections: h.connections }) });
    const thread = chat.createThread('gw-bot');

    const first = await chat.send(thread.id, 'Hello', 'req-1');
    assert.equal(first.reply.cost_usd, null, 'an unknown price is stored as unknown, not zero');
    const replay = await chat.send(thread.id, 'Hello', 'req-1');
    assert.equal(replay.reply.id, first.reply.id);
    assert.equal(gw.completions().length, 1, 'a replayed request makes no second gateway call');
    assert.deepEqual(reservations(h.store)[0], { agent_id: 'gw-bot', model_id: 'llama-3.3-70b', pricing_state: 'unknown', status: 'RECONCILED', actual_cost_usd: null,
      input_tokens: 100, output_tokens: 20, usage_source: 'gateway-reported', served_model: 'groq/llama-3.3-70b', routing_mode: 'pinned', connection_id: c.id });

    usage = null;
    await chat.send(thread.id, 'No usage reported', 'req-2');
    assert.equal(reservations(h.store)[1].status, 'PENDING', 'a call without reported usage keeps its dispatched estimate');
    h.store.getDatabase().prepare("UPDATE cost_reservations SET expires_at = 0 WHERE status = 'PENDING'").run();
    h.ledger.sweepStaleReservations();
    assert.deepEqual([reservations(h.store)[1].status, reservations(h.store)[1].actual_cost_usd], ['UNRECONCILED_ASSUMED_SPENT', null]);

    const summary = usageSummary(h.store.getDatabase());
    const agent = summary.agents.find(a => a.agentId === 'gw-bot')!;
    assert.equal(agent.spentUsd, 0);
    assert.equal(agent.unpricedCallCount, 2);
    assert.ok(agent.unpricedTokens > 120, 'the unreported call counts its estimate');
    assert.equal(summary.connections.length, 1, 'the shared pool is listed once');
    assert.equal(summary.connections[0].requestsLast24h, 2);
    assert.equal(summary.connections[0].gatewayQuota.available, false);

    usage = { prompt_tokens: 1, completion_tokens: 1 };
    await chat.send(thread.id, 'Third', 'req-3');
    await assert.rejects(chat.send(thread.id, 'Fourth', 'req-4'), (error: unknown) => error instanceof ChatError && /3 of 3 requests/.test(error.message));
    assert.equal(gw.completions().length, 3, 'admission refuses before any request is sent');

    await h.connections.save({ id: c.id, name: 'FreeLLMAPI', baseUrl: gw.url, enabled: false, limits: { requestsPerDay: 100 } });
    await assert.rejects(chat.send(chat.createThread('gw-bot').id, 'While disabled', 'req-5'), /disabled/);
    assert.equal(gw.completions().length, 3);
    assert.equal(reservations(h.store).at(-1)!.status, 'EXPIRED_UNDISPATCHED', 'a request that never left OpenAgents is not counted');
  } finally {
    await gw.close();
    h.close();
  }
});

test('one connection-backed bot runs chat, direct work, a routine and a mission through its gateway while an ordinary bot keeps its provider, and alternate executors refuse it', async () => {
  const replies: string[] = [];
  const gw = await gateway(request => {
    const content = replies.shift();
    return content === undefined ? { status: 500, body: { error: { type: 'fixture_exhausted' } } } : { headers: routed(`fixture/${request.body?.model}`), body: completion(content) };
  });
  const h = profile();
  const plainCalls: Array<{ host: string; auth: string | null; model: string }> = [];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'openrouter-fixture-key';
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(gw.origin)) return originalFetch(input, init);
    plainCalls.push({ host: new URL(url).host, auth: new Headers(init?.headers).get('authorization'), model: JSON.parse(String(init?.body)).model });
    return new Response(JSON.stringify(completion('plain provider answer')), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  registerModelPricing('fixture/plain-model', { inputPerMillion: 1, outputPerMillion: 1 });
  let scheduler: TaskScheduler | undefined, missions: MissionService | undefined;
  try {
    const c = await h.connections.save({ name: 'FreeLLMAPI', baseUrl: gw.url, apiKey: KEY });
    h.store.createAgent({ id: 'gw-bot', name: 'Gateway bot', model_id: SLASH_MODEL, budget_cap_usd: 10, current_status: 'IDLE', connection_id: c.id, routing_mode: 'pinned' });
    h.store.createAgent({ id: 'plain-bot', name: 'Plain bot', model_id: 'fixture/plain-model', budget_cap_usd: 10, current_status: 'IDLE' });
    const llm = new LiveLLMClient({ connections: h.connections });
    const capacity = new RunCapacity(2);
    const runtime = new WorkRuntime({ store: h.store, ledger: h.ledger, llm, sandbox: noDocker as unknown as DockerSandbox, artifacts: new ArtifactStore(h.store), contracts: DIRECT_WORK_CONTRACTS });
    const chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: llm, workRuntime: runtime, capacity });

    replies.push('Gateway chat answer');
    assert.equal((await chat.send(chat.createThread('gw-bot').id, 'Hello', 'chat-1')).reply.content, 'Gateway chat answer');
    assert.equal((await chat.send(chat.createThread('plain-bot').id, 'Hello', 'chat-2')).reply.content, 'plain provider answer');

    replies.push(WRITE_PLAN, VERIFY, FINISH);
    const direct = await chat.send(chat.createThread('gw-bot').id, 'Plan the release.', 'work-1', 'action-plan');
    assert.equal(direct.work?.outcome, 'COMPLETED', direct.work?.report);

    missions = new MissionService(h.store, DIRECT_WORK_CONTRACTS, 1);
    const missionRef = missions;
    scheduler = new TaskScheduler({ agentStore: h.store, ledger: h.ledger, sandbox: noDocker as unknown as DockerSandbox, providerRouter: new ProviderRouter(), llmClient: llm,
      workRuntime: runtime, capacity, maxConcurrency: 1, cadenceMs: 10, executor: 'builtin', canRun: id => missionRef.canRun(id), workProducer: missions });
    const routine = h.store.createRoutine({ agentId: 'gw-bot', name: 'Release plan', cronExpression: '0 3 * * *', promptTemplate: 'Plan the release.', taskName: 'work:action-plan', enabled: false, nextRunAt: Date.now() + 86_400_000 });
    replies.push(WRITE_PLAN, VERIFY, FINISH);
    const { run: routineRun } = enqueueRoutine(h.store, routine.id, { source: 'manual', maxQueueDepth: 10, definition: workTaskDefinition(findWorkContract('action-plan')!, 'Plan the release.') });
    scheduler.start();
    await waitFor(() => ['COMPLETED', 'FAILED', 'ABORTED', 'CRASHED'].includes(h.store.getTaskRun(routineRun.id)!.status), 'routine run');
    assert.equal(h.store.getTaskRun(routineRun.id)!.status, 'COMPLETED', JSON.stringify(h.store.getTaskRun(routineRun.id)));

    replies.push(WRITE_PLAN, VERIFY, JSON.stringify({ tool: 'finish', mission: { state: 'complete', reason: 'The release plan is delivered.' } }));
    const mission = missions.create({ agentId: 'gw-bot', objective: 'Plan the release.', contractId: 'action-plan', maxRuns: 1, intervalMs: 60_000 });
    await missions.start();
    const missionRun = () => h.store.getDatabase().prepare('SELECT id, status FROM task_runs WHERE task_name = ?').get(`mission:${mission.id}`) as { id: string; status: string } | undefined;
    await waitFor(() => ['COMPLETED', 'FAILED', 'ABORTED', 'CRASHED'].includes(missionRun()?.status ?? ''), 'mission run');
    assert.equal(missionRun()!.status, 'COMPLETED', JSON.stringify(h.store.getTaskRun(missionRun()!.id)));

    const legacy = h.store.createTaskRun({ agentId: 'gw-bot', taskName: 'legacy-refusal' });
    scheduler.registerTaskDefinition('legacy-refusal', { initialFiles: { 'index.js': '' }, testCommand: 'node index.js' });
    await waitFor(() => h.store.getTaskRun(legacy.id)!.status === 'FAILED', 'legacy refusal');
    assert.match(JSON.stringify(h.store.getTaskRun(legacy.id)), /built-in coding loop is not wired for provider connections/);
    const opencode = new OpenCodeExecutor({ agentStore: h.store, ledger: h.ledger, sandbox: noDocker as unknown as DockerSandbox });
    await assert.rejects(opencode.executeTask({ agent: h.store.getAgent('gw-bot')!, taskRun: h.store.createTaskRun({ agentId: 'gw-bot', taskName: 'opencode-refusal' }), initialFiles: {}, testCommand: 'true' }),
      /OpenCode executor is not wired for provider connections/);

    assert.equal(gw.completions().length, 10, 'chat 1 + direct work 3 + routine 3 + mission 3');
    assert.ok(gw.completions().every(entry => entry.headers.authorization === `Bearer ${KEY}` && entry.body.model === SLASH_MODEL));
    assert.deepEqual(plainCalls, [{ host: 'openrouter.ai', auth: 'Bearer openrouter-fixture-key', model: 'fixture/plain-model' }], 'the ordinary bot kept its inferred provider');
    const rows = reservations(h.store);
    assert.ok(rows.filter(row => row.agent_id === 'plain-bot').every(row => row.connection_id === null && row.pricing_state === 'known'));
    assert.ok(rows.filter(row => row.agent_id === 'gw-bot').every(row => row.connection_id === c.id && row.pricing_state === 'unknown'));
    assert.equal(h.store.getAgent('plain-bot')!.connection_id, undefined, 'the ordinary bot was not migrated');
  } finally {
    await scheduler?.stop();
    await missions?.stop();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
    await gw.close();
    h.close();
  }
});

test('Windows DPAPI protects and unlocks a key for this user, with the value passed on stdin rather than the command line', { skip: process.platform !== 'win32' }, async () => {
  const store = new WindowsDpapiSecretStore();
  const availability = await store.availability();
  assert.equal(availability.available, true, availability.reason);
  const ciphertext = await store.protect(KEY);
  assert.ok(!ciphertext.includes(KEY));
  assert.ok(Buffer.from(ciphertext, 'base64').length > 100, 'a DPAPI blob, not an encoding of the key');
  assert.equal(await store.unprotect(ciphertext), KEY);
  await assert.rejects(store.unprotect(Buffer.from('not protected data').toString('base64')), /DPAPI unprotect failed/);
});
