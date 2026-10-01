import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { WebResearch, publicAddress } from '../src/daemon/web-research.js';
import { ChatService } from '../src/daemon/chat.js';
import { RunCapacity } from '../src/daemon/run-capacity.js';
import type { LLMRequest } from '../src/evals/llm-client.js';

async function site() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:9/private' }); res.end(); return; }
    if (req.url === '/large') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('x'.repeat(2 * 1024 * 1024)); return; }
    if (req.url === '/wait') return;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Release evidence</title><script>do not capture this</script><h1>Version 3 fixes the export bug.</h1><a href="/details">Read details</a>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, seen, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('research uses real HTTP with bounded content, pinned network policy, redirect checks and cancellation', async () => {
  const fixture = await site();
  try {
    const web = new WebResearch({ previewOrigins: [fixture.origin] });
    const page = await web.read(fixture.origin, new AbortController().signal);
    assert.equal(page.title, 'Release evidence');
    assert.match(page.text, /Version 3 fixes the export bug/);
    assert.doesNotMatch(page.text, /do not capture/);
    assert.equal(page.links[0].url, `${fixture.origin}/details`);
    await assert.rejects(new WebResearch().read(fixture.origin, new AbortController().signal), /ports|private/);
    await assert.rejects(web.read(`${fixture.origin}/redirect`, new AbortController().signal), /ports|private/);
    await assert.rejects(web.read(`${fixture.origin}/large`, new AbortController().signal), /1 MiB/);
    await assert.rejects(web.read(`${fixture.origin}/wait`, AbortSignal.timeout(60)), /abort/i);
    await assert.rejects(web.read('file:///etc/passwd', new AbortController().signal), /http/);
    for (const address of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::ffff:127.0.0.1', '198.18.0.1']) assert.equal(publicAddress(address), false, address);
    assert.equal(publicAddress('8.8.8.8'), true);
  } finally { await fixture.close(); }
});

test('ordinary chat researches through the shared runtime, corrects false quotes, and replays without another request', async () => {
  const fixture = await site();
  const store = new AgentStore(':memory:'); const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'research', name: 'Research', model_id: 'claude-haiku-4-5', budget_cap_usd: 1, current_status: 'IDLE' });
  const requests: LLMRequest[] = [];
  const actions = [
    `I will read the page first.\n${JSON.stringify({ tool: 'web_read', url: fixture.origin })}`,
    { tool: 'web_read', url: fixture.origin },
    { tool: 'answer', text: 'False finding', citations: [{ sourceId: 'source-1', quote: 'An invented quotation which is absent' }] },
    { tool: 'source', id: 'source-1' },
    { tool: 'answer', text: 'Version 3 fixes the export bug.', citations: [{ sourceId: 'source-1', quote: 'Version 3 fixes the export bug.' }] },
  ];
  const llm = { generateCode: async (req: LLMRequest) => { requests.push({ ...req, messages: structuredClone(req.messages) }); const next = actions.shift(); return { content: typeof next === 'string' ? next : JSON.stringify(next), inputTokens: 1, outputTokens: 1, attemptCount: 1 }; } };
  const forbidden = async (): Promise<never> => { throw new Error('Research must not use Docker'); };
  const artifacts = new ArtifactStore(store);
  const runtime = new WorkRuntime({ store, ledger, llm, artifacts, web: new WebResearch({ previewOrigins: [fixture.origin] }), sandbox: { createWorkspaceVolume: forbidden, stageWorkspaceFiles: forbidden, readWorkspaceFile: forbidden, executeTask: forbidden, destroyWorkspaceVolume: forbidden } });
  const capacity = new RunCapacity(1);
  const chat = new ChatService({ agentStore: store, ledger, llmClient: llm, workRuntime: runtime, agenticChat: true, capacity });
  try {
    const thread = chat.createThread('research');
    const result = await chat.send(thread.id, 'Read the release page and tell me what changed', 'research-request');
    assert.equal(result.work?.outcome, 'COMPLETED');
    assert.match(result.reply.content, /Version 3 fixes/);
    assert.match(result.reply.content, /Sources:\n- \[[^\]]+\]\(http:\/\/127\.0\.0\.1:\d+\/?\)/);
    assert.doesNotMatch(result.reply.content, /\[source-\d+\]/, 'sources are named by their page, not an internal ID');
    assert.equal(requests.length, 5);
    // A JSON action wrapped in a sentence runs and the sentence is ignored (see parseStructuredAction).
    assert.equal(fixture.seen.length, 2);
    assert.match(requests[1].messages!.at(-1)!.content, /"status":"ok"/);
    assert.match(requests[3].messages!.at(-1)!.content, /does not match captured/);
    assert.ok(artifacts.list(result.taskRunId).some(a => a.path === 'sources.json'));
    assert.deepEqual(await chat.send(thread.id, 'Read the release page and tell me what changed', 'research-request'), result);
    assert.equal(fixture.seen.length, 2, 'the replay fetched nothing');
    assert.equal(capacity.used, 0);
    assert.match(requests[0].systemPrompt, /Runtime capabilities/);
  } finally { await chat.stop(); ledger.close(); store.close(); await fixture.close(); }
});
