import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { loadConfigFile } from '../dist/src/daemon/config-file.js';
import { AgentStore } from '../dist/src/daemon/agent-store.js';
import { CostLedger } from '../dist/src/kernel/cost-ledger.js';
import { ArtifactStore } from '../dist/src/daemon/artifacts.js';
import { WorkRuntime } from '../dist/src/daemon/work-runtime.js';
import { ChatService } from '../dist/src/daemon/chat.js';
import { BrowserTools } from '../dist/src/daemon/browser-tools.js';
import { MemorySecretStore } from '../dist/src/daemon/secret-store.js';
import { ApprovalGate } from '../dist/src/daemon/control-plane.js';
import { LiveLLMClient, syncOpenRouterCatalog } from '../dist/src/evals/llm-client.js';

// One live request, an isolated profile, and a synthetic local form. Only its exact
// origin is approved by this test operator. No real account or external write is used.
const output = path.resolve(process.argv[2] ?? 'docs/validation/2026-09-14-codex-continuation/live-browser.json');
const selected = loadConfigFile()?.config.agents[0];
if (!selected || selected.connectionId) throw new Error('This probe requires an existing direct provider configuration.');
const override = process.argv[3];
if (override) selected.model = override; // Probe-local copy only; never saved to configuration.
if (!selected.model.endsWith(':free') && !override) throw new Error('A paid probe requires an explicit model ID argument.');
const catalog = await (await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) })).json();
const entry = catalog.data.find(m => m.id === selected.model);
if (!entry || Number(entry.pricing.prompt) > 0.0000005 || Number(entry.pricing.completion) > 0.000003 || !Number.isFinite(Number(entry.pricing.prompt)) || !Number.isFinite(Number(entry.pricing.completion))) throw new Error('Model is absent or exceeds this probe\'s cheap-model price ceiling.');
const llm = new LiveLLMClient({ requestTimeoutMs: 45000 });
if (!llm.hasProvider(selected.model)) throw new Error('The application provider credential is unavailable.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-live-browser-'));
const evidence = { capturedAt: new Date().toISOString(), model: selected.model, pricing: entry.pricing, budgetCapUsd: 0.1, profile: root, status: 'NOT_QUALIFIED' };
const state = { posts: 0, note: '' }, downloadBytes = 'browser-download-v1\n';
const fixture = http.createServer(async (req, res) => {
  if (req.url === '/download') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="result.txt"' }); res.end(downloadBytes); return; }
  if (req.method === 'POST') { state.posts++; let data = ''; for await (const chunk of req) data += chunk; state.note = new URLSearchParams(data).get('note') ?? ''; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<title>OpenAgents controlled browser task</title><h1>Controlled form task.</h1>${state.posts ? `<p>Saved note: ${state.note.replace(/[<>&"]/g, '')}</p>` : ''}<form method="post"><label>Note<input name="note"></label><button>Save note</button></form><a href="/download">Download result</a>`);
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const origin = `http://127.0.0.1:${fixture.address().port}`;
const store = new AgentStore(path.join(root, 'state.db')), ledger = new CostLedger(store.getDatabase()), artifacts = new ArtifactStore(store), approvals = new ApprovalGate(store);
store.createAgent({ id: 'probe', name: 'Live controlled browser probe', model_id: selected.model, budget_cap_usd: 0.1, current_status: 'IDLE' });
const browser = new BrowserTools({ store, artifacts, approvals, secrets: new MemorySecretStore(), previewOrigins: [origin] });
const forbidden = async () => { throw new Error('The controlled browser probe cannot start a code sandbox.'); };
const runtime = new WorkRuntime({ store, ledger, artifacts, approvals, llm, browser, sandbox: { createWorkspaceVolume: forbidden, stageWorkspaceFiles: forbidden, readWorkspaceFile: forbidden, executeTask: forbidden, destroyWorkspaceVolume: forbidden } });
const chat = new ChatService({ agentStore: store, ledger, llmClient: llm, workRuntime: runtime, agenticChat: true });
const decide = setInterval(() => { for (const row of store.listApprovals({ pendingOnly: true })) { const payload = JSON.parse(row.payload_json); approvals.decide(row.id, row.kind === 'browser-interaction' && payload.origin === origin ? 'APPROVED' : 'DENIED', 'Exact synthetic fixture scope only'); } }, 25);
try {
  await syncOpenRouterCatalog();
  const result = await chat.send(chat.createThread('probe').id, `Use the managed browser to visit ${origin}. Fill Note with exactly OpenAgents live browser probe, click Save note once, inspect the saved result, take a screenshot, and download the file from Download result. Then answer concisely with a captured source quotation and the saved artifact links. You have permission to submit this synthetic local form for this test. Do not submit twice, create an ongoing mission, or use a real account.`, 'live-browser');
  const events = store.getTaskEvents(result.taskRunId), captured = artifacts.list(result.taskRunId, true);
  const files = captured.map(a => ({ ...a, rawHashMatches: createHash('sha256').update(Buffer.from(artifacts.read(result.taskRunId, a.id).content, artifacts.read(result.taskRunId, a.id).encoding === 'base64' ? 'base64' : 'utf8')).digest('hex') === a.sha256 }));
  const downloaded = files.find(a => a.path.endsWith('result.txt'));
  evidence.status = result.work?.outcome === 'COMPLETED' && state.posts === 1 && state.note === 'OpenAgents live browser probe' && downloaded?.sha256 === createHash('sha256').update(downloadBytes).digest('hex') && files.some(a => a.path.endsWith('.jpg') && a.rawHashMatches) ? 'PASS' : 'NOT_QUALIFIED';
  Object.assign(evidence, { state, taskRunId: result.taskRunId, result: result.work, artifacts: files, tools: events.filter(e => e.event_type === 'WORK_ACTION').map(e => JSON.parse(e.payload_json)),
    actionEvents: events.filter(e => e.event_type.startsWith('EXTERNAL_ACTION_')).map(e => ({ type: e.event_type, ...JSON.parse(e.payload_json) })),
    approvals: store.listApprovals({}).map(a => ({ kind: a.kind, status: a.status })),
    browserSlotsAfter: browser.status().active });
} catch (error) { evidence.error = error.message; }
finally {
  clearInterval(decide); await chat.stop(); await browser.stop(); ledger.close(); store.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ model: evidence.model, status: evidence.status, state, output }));
}
