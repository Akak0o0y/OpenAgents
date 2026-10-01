/**
 * Truthful capability and failure reporting.
 *
 * The runtime must tell a model what is not available yet (so it neither plans impossible steps nor refuses the parts it
 * can do), a conversation that fails after research must show what it gathered, and a routine must name a task that
 * can actually run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { ChatService } from '../src/daemon/chat.js';
import { routineBindingError } from '../src/daemon/routine-task.js';
import type { WebResearch, WebPage } from '../src/daemon/web-research.js';
import { ProviderCallError, type LLMRequest } from '../src/evals/llm-client.js';
import { availableTools, type ToolAvailabilityContext } from '../src/daemon/tool-schemas.js';

const MODEL = 'claude-haiku-4-5';
const forbidden = async () => { throw new Error('A conversation must not request a Docker workspace.'); };
const noDocker = { createWorkspaceVolume: forbidden, stageWorkspaceFiles: forbidden, readWorkspaceFile: forbidden, executeTask: forbidden, destroyWorkspaceVolume: forbidden };
const issuesPage: WebPage = { url: 'https://api.github.com/search/issues?q=is%3Aissue', title: 'GitHub issues: is:issue is:open', text: '[{"url":"https://github.com/example/project/issues/7","title":"Crash on empty input"}]', capturedAt: new Date().toISOString(), truncated: false, links: [] };
const web = { enabled: true, capabilities: () => ({ internet: 'fixture research', network: 'fixture' }), read: async () => issuesPage, search: async () => issuesPage, githubIssues: async () => issuesPage } as unknown as WebResearch;

function harness(steps: Array<unknown | (() => never)>) {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const requests: LLMRequest[] = [];
  const llm = { async generateCode(req: LLMRequest) {
    requests.push(req);
    const step = steps.shift();
    assert.ok(step !== undefined, 'no extra model call is scripted');
    if (typeof step === 'function') step();
    return { content: JSON.stringify(step), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
  } };
  const runtime = new WorkRuntime({ store, ledger, llm, web, sandbox: noDocker as never, artifacts: new ArtifactStore(store) });
  const chat = new ChatService({ agentStore: store, ledger, llmClient: llm, workRuntime: runtime, agenticChat: true });
  return { store, chat, requests, close: () => { ledger.close(); store.close(); } };
}

test('every model turn is told what is not available yet and to do the available parts instead of refusing', async () => {
  const h = harness([{ tool: 'answer', text: 'I can research issues and write a report, but I cannot push to GitHub yet.', citations: [] }]);
  try {
    const result = await h.chat.send(h.chat.createThread('alpha').id, 'Find a GitHub problem, fix it and push a repository.', 'honesty-1');
    assert.match(result.reply.content, /cannot push to GitHub yet/);
    const prompt = h.requests[0].systemPrompt;
    assert.match(prompt, /"notAvailableYet":\[/);
    assert.match(prompt, /cloning, editing or testing an external repository/);
    assert.match(prompt, /verified GitHub publication: creating repositories, pushing branches, opening pull requests or posting comments/);
    assert.doesNotMatch(prompt, /a conversation writes only report\.json/);
    assert.match(prompt, /You can create any deliverable requested/);
    assert.match(prompt, /say so in one sentence, do the parts that are available/);
  } finally { h.close(); }
});

test('a conversation that fails at the provider after research shows its plan and captured sources instead of only the error', async () => {
  const h = harness([
    { tool: 'plan', steps: ['Search GitHub for an open issue', 'Summarise it with a quotation'] },
    { tool: 'github_issues', query: 'is:issue is:open' },
    () => { throw new ProviderCallError('HTTP_ERROR', 'OPENROUTER returned a provider error (502) inside HTTP 200 for fixture-model. It was not retried because generation may have started.', { status: 502 }); },
  ]);
  try {
    const result = await h.chat.send(h.chat.createThread('alpha').id, 'Find one open GitHub issue and explain it.', 'failure-1');
    const reply = result.reply.content;
    assert.equal(result.work?.outcome, 'FAILED');
    assert.match(reply, /^I couldn't finish this answer: OPENROUTER returned a provider error \(502\)/);
    assert.match(reply, /Plan so far:\n1\. Search GitHub for an open issue\n2\. Summarise it with a quotation/);
    assert.match(reply, /Sources already captured \(unverified and not yet summarised\):\n- Web https:\/\/api\.github\.com\/search\/issues/);
    assert.match(reply, /The task did not finish\. Its recorded progress is retained\./);
    assert.doesNotMatch(reply, /nothing was published|Send your message again to retry/i);
    assert.doesNotMatch(reply, /User instruction and supplied material/, 'the request itself is not listed as a gathered source');
    assert.equal(h.requests.length, 3, 'the failure is not retried by the runtime');
  } finally { h.close(); }
});

test('a conversation that fails before gathering anything says so in plain words', async () => {
  const h = harness([() => { throw new ProviderCallError('HTTP_ERROR', 'Upstream 502 before any action.', { status: 502 }); }]);
  try {
    const result = await h.chat.send(h.chat.createThread('alpha').id, 'Hello', 'failure-2');
    assert.match(result.reply.content, /^I couldn't finish that\. /);
    assert.doesNotMatch(result.reply.content, /No verified deliverable|Blocked: Conversation/);
    assert.match(result.reply.content, /Upstream 502 before any action\./);
  } finally { h.close(); }
});

test('a routine must name a registered task that can run', () => {
  const tasks = [{ id: 'evidence-brief', name: 'Source-based report' }, { id: 'action-plan', name: 'Structured action plan' }];
  const registered = (name: string) => (name === 'work:evidence-brief' ? ({ initialFiles: {}, testCommand: '' } as never) : undefined);
  assert.match(routineBindingError(undefined, registered, tasks)!, /a prompt alone cannot run\. Choose one of: work:evidence-brief \(Source-based report\), work:action-plan \(Structured action plan\)\./);
  assert.match(routineBindingError('   ', registered, tasks)!, /a prompt alone cannot run/);
  assert.match(routineBindingError('work:missing', registered, tasks)!, /Routine task "work:missing" is not registered/);
  assert.equal(routineBindingError('work:evidence-brief', registered, tasks), null);
});

test('a contract whose executor rejects the shell never advertises one', () => {
  // work-runtime throws 'This contract has no shell tool.' unless the contract kind is code,
  // so offering run anywhere else invites the model to plan a step that cannot run.
  const offered = (ctx: ToolAvailabilityContext) => availableTools(ctx).map(tool => tool.name);
  assert.ok(offered({ shellEnabled: true }).includes('run'), 'a code contract keeps its shell');
  assert.ok(!offered({}).includes('run'), 'a contract without a shell must not offer run');
  assert.ok(offered({}).includes('write'), 'gating the shell does not remove the other tools');
});
