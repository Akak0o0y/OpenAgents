import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfigFile } from '../dist/src/daemon/config-file.js';
import { WebResearch } from '../dist/src/daemon/web-research.js';
import { AgentStore } from '../dist/src/daemon/agent-store.js';
import { CostLedger } from '../dist/src/kernel/cost-ledger.js';
import { ArtifactStore } from '../dist/src/daemon/artifacts.js';
import { WorkRuntime } from '../dist/src/daemon/work-runtime.js';
import { ChatService } from '../dist/src/daemon/chat.js';
import { LiveLLMClient, syncOpenRouterCatalog } from '../dist/src/evals/llm-client.js';

// Opt-in public reads. The optional model probe uses only the already-configured free model,
// standard application credential resolution and an isolated profile; it never changes a bot.
const output = path.resolve(process.argv[2] ?? 'docs/validation/2026-09-14-codex-continuation/live-research.json');
const evidence = { capturedAt: new Date().toISOString(), publicReads: [], modelProbe: { status: 'NOT_REQUESTED' } };
const web = new WebResearch();
for (const [name, read] of [
  ['github-issues', signal => web.githubIssues('repo:microsoft/playwright is:issue is:open', signal)],
  ['web-search', signal => web.search('Playwright browser documentation', signal)],
]) {
  try { const page = await read(AbortSignal.timeout(25000)); evidence.publicReads.push({ name, status: 'PASS', ...page, sha256: createHash('sha256').update(page.text).digest('hex') }); }
  catch (error) { evidence.publicReads.push({ name, status: 'UNAVAILABLE', error: error.message }); }
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
if (process.argv.includes('--model')) {
  const selected = loadConfigFile()?.config.agents[0];
  if (!selected || selected.connectionId || !selected.model.endsWith(':free')) evidence.modelProbe = { status: 'NOT_RUN', reason: 'This probe requires the first configured bot to use an existing free direct model.' };
  else {
    const llm = new LiveLLMClient({ requestTimeoutMs: 45000 });
    if (!llm.hasProvider(selected.model)) evidence.modelProbe = { status: 'NOT_RUN', model: selected.model, reason: 'The application provider credential is unavailable.' };
    else {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-live-research-'));
      const store = new AgentStore(path.join(root, 'state.db')), ledger = new CostLedger(store.getDatabase()), artifacts = new ArtifactStore(store);
      const forbidden = async () => { throw new Error('This read-only probe cannot start a code sandbox.'); };
      const runtime = new WorkRuntime({ store, ledger, llm, web, artifacts, sandbox: { createWorkspaceVolume: forbidden, stageWorkspaceFiles: forbidden, readWorkspaceFile: forbidden, executeTask: forbidden, destroyWorkspaceVolume: forbidden } });
      const chat = new ChatService({ agentStore: store, ledger, llmClient: llm, workRuntime: runtime, agenticChat: true });
      try {
        await syncOpenRouterCatalog();
        store.createAgent({ id: 'probe', name: 'Public research qualification', model_id: selected.model, budget_cap_usd: 0.1, current_status: 'IDLE' });
        const result = await chat.send(chat.createThread('probe').id, 'Use GitHub issue search to find one currently open issue in microsoft/playwright, read its issue page, and explain the reported problem with an exact captured quotation and source link. Do not create, comment, publish, or start ongoing work. This is one bounded research request.', 'live-research');
        const events = store.getTaskEvents(result.taskRunId);
        const tools = events.filter(e => e.event_type === 'WORK_ACTION').map(e => JSON.parse(e.payload_json).tool);
        evidence.modelProbe = { status: result.work?.outcome === 'COMPLETED' && tools.includes('github_issues') && tools.includes('web_read') && result.work.artifacts.some(a => a.path === 'sources.json') ? 'PASS' : 'NOT_QUALIFIED',
          model: selected.model, profile: root, taskRunId: result.taskRunId, tools, result: result.work,
          sources: artifacts.list(result.taskRunId).filter(a => a.path === 'sources.json').map(a => JSON.parse(artifacts.read(result.taskRunId, a.id).content)),
          providerEvents: events.filter(e => ['PROVIDER_CALL', 'PROVIDER_ERROR'].includes(e.event_type)).map(e => JSON.parse(e.payload_json)) };
      } catch (error) { evidence.modelProbe = { status: 'NOT_QUALIFIED', model: selected.model, profile: root, error: error.message }; }
      finally { await chat.stop(); ledger.close(); store.close(); }
    }
  }
}
fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ publicReads: evidence.publicReads.map(({ name, status }) => ({ name, status })), modelProbe: evidence.modelProbe.status, output }));
