import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '../src/daemon/index.js';
import type { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { CharacterStore } from '../src/daemon/character-store.js';
import { CharacterProposals } from '../src/daemon/character-proposals.js';
import { CharacterSetup, CharacterSetupError } from '../src/daemon/character-setup.js';
import { SETUP_MAX_TOKENS } from '../src/daemon/character-drafter.js';
import { RunCapacity } from '../src/daemon/run-capacity.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';
import { ProviderCallError, type ILLMClient, type LLMRequest, type LLMResponse } from '../src/evals/llm-client.js';

const MODEL = 'deepseek/deepseek-chat';

// A valid Character-mode draft: one-line identity, purpose and three drafted examples.
const DRAFT = JSON.stringify({
  changes: [
    { op: 'set', path: 'identity.oneLine', value: 'A curious Linux-minded tech person with his own life on X.' },
    { op: 'set', path: 'purpose.statement', value: 'Share useful observations about tech, open source and Linux.' },
    { op: 'add', collection: 'voice.examples', item: { text: 'Compiled the kernel again. It is a hobby now.', surface: 'post', pinned: false, tags: [] } },
    { op: 'add', collection: 'voice.examples', item: { text: 'Fair point, though simple tools earn their keep by staying simple.', surface: 'reply', pinned: false, tags: [] } },
    { op: 'add', collection: 'voice.examples', item: { text: 'Morning. Three things I want to try today, all in a terminal.', surface: 'chat', pinned: false, tags: [] } },
  ],
  assumptions: ['Tone taken from the owner brief.'],
});
const PREVIEWS = JSON.stringify(['post', 'reply', 'chat', 'unsupported-claim', 'empty-challenge'].map((id) => ({ id, text: `Preview for ${id}.` })));

const cutOff = () => new ProviderCallError('OUTPUT_LIMIT', `Model ${MODEL} reached its output token limit before completing the answer. No action was executed from this response.`,
  { usage: { inputTokens: 1100, outputTokens: SETUP_MAX_TOKENS }, finishReason: 'length' });

type Step = 'draft' | 'preview' | 'review';
const stepOf = (req: LLMRequest): Step => req.systemPrompt?.startsWith('Suggest a character draft') ? 'draft'
  : req.systemPrompt?.startsWith('Write five unsent previews') ? 'preview' : 'review';

/** Setup's own model: answers each step from a script, recording every request. */
class SetupLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(private readonly script: Partial<Record<Step, Array<string | Error>>>) {}
  async generateCode(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const next = this.script[stepOf(req)]?.shift() ?? '[]';
    if (next instanceof Error) throw next;
    return { content: next, inputTokens: 1100, outputTokens: 400, attemptCount: 1, usageKnown: true };
  }
}

/** The chat model: one scripted text action per turn. */
class ChatLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(private readonly turns: string[]) {}
  async generateCode(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...req, messages: req.messages?.map((m) => ({ ...m })) });
    return { content: this.turns.shift() ?? JSON.stringify({ tool: 'answer', text: 'Done.', citations: [] }), inputTokens: 100, outputTokens: 50, attemptCount: 1 };
  }
}

function profile(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-character-setup-'));
  const dbPath = path.join(dir, 'test.db');
  const store = new AgentStore(dbPath);
  const characters = new CharacterStore(store);
  const proposals = new CharacterProposals(store, characters);
  const ledger = new CostLedger(dbPath);
  // Windows keeps the SQLite files locked until the process exits; leave them to the OS temp cleanup.
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  store.createAgent({ id: 'milo', name: 'Milo', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE', system_prompt: null } as any);
  const parent = store.createTaskRun({ agentId: 'milo', taskName: 'chat' });
  store.startTaskRun(parent.id, MODEL);
  const setup = (llm: ILLMClient) => new CharacterSetup({ store, characters, proposals, capacity: new RunCapacity(2), ledger, llm });
  const propose = (llm: ILLMClient) => setup(llm).propose({ agentId: 'milo', parentRunId: parent.id, deadlineAt: Date.now() + 60_000, mode: 'character',
    request: 'Milo is a curious Linux-minded tech person with his own life on X. Never any 18+ content.', history: [], signal: new AbortController().signal });
  const count = (table: string) => (store.getDatabase().prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  const childRuns = () => store.listTaskRuns().filter((run) => run.id.startsWith('character-setup-'));
  return { store, characters, proposals, ledger, setup, propose, count, childRuns, parent };
}

test('a draft cut off by the output limit is retried once with room and a compact-JSON note', async (t) => {
  const p = profile(t);
  const llm = new SetupLLM({ draft: [cutOff(), DRAFT], preview: [PREVIEWS], review: ['[]'] });
  const result = await p.propose(llm);

  const drafts = llm.requests.filter((req) => stepOf(req) === 'draft');
  assert.equal(drafts.length, 2);
  assert.ok(llm.requests.every((req) => req.maxTokens === SETUP_MAX_TOKENS), 'every setup call uses the shared output limit');
  assert.ok(!drafts[0].userPrompt?.includes('validationFailure'));
  assert.match(drafts[1].userPrompt ?? '', /ran out of output room/);
  assert.equal(result.usage.logicalCalls, 4, 'two draft attempts, previews and review stay inside the four-call cap');
  assert.equal(p.count('bot_character_proposals'), 1);
  assert.equal(p.proposals.open('milo')?.approvalId, result.proposal.approvalId);
  const [child] = p.childRuns();
  assert.equal(child.status, 'COMPLETED');
  const measured = p.store.getTaskEvents(child.id).filter((e) => e.event_type === 'MODEL_MEASUREMENT').map((e) => JSON.parse(e.payload_json).status);
  assert.deepEqual(measured, ['failed', 'ok', 'ok', 'ok'], 'the child run now records each model call');
});

test('a draft that keeps running out of room fails with its cause recorded and no proposal', async (t) => {
  const p = profile(t);
  const llm = new SetupLLM({ draft: [cutOff(), cutOff()] });
  await assert.rejects(p.propose(llm), (error: unknown) => {
    assert.ok(error instanceof CharacterSetupError);
    assert.equal(error.code, 'OUTPUT_LIMIT');
    assert.ok(error.cause instanceof ProviderCallError, 'the typed provider error is kept');
    return true;
  });
  assert.equal(llm.requests.length, 2);
  assert.equal(p.count('bot_character_proposals'), 0);
  const [child] = p.childRuns();
  assert.equal(child.status, 'FAILED');
  assert.equal(child.error_message, 'Character setup did not complete: the model ran out of output room before finishing (OUTPUT_LIMIT).');
});

test('transport failures are not retried as if the answer were malformed', async (t) => {
  const p = profile(t);
  const llm = new SetupLLM({ draft: [new ProviderCallError('NETWORK', 'The provider could not be reached.'), DRAFT] });
  await assert.rejects(p.propose(llm), (error: unknown) => error instanceof CharacterSetupError && error.code === 'NETWORK');
  assert.equal(llm.requests.length, 1);
  assert.match(p.childRuns()[0].error_message ?? '', /could not be reached \(NETWORK\)/);
});

test('cut-off previews are shown as invalid instead of discarding a valid draft', async (t) => {
  const p = profile(t);
  const llm = new SetupLLM({ draft: [DRAFT], preview: [cutOff()], review: [cutOff()] });
  const result = await p.propose(llm);
  assert.equal(p.count('bot_character_proposals'), 1);
  const previews = p.proposals.get('milo', result.proposal.proposalId).previews as Array<{ status: string; text: string | null }>;
  assert.equal(previews.length, 5);
  assert.ok(previews.every((preview) => preview.status === 'invalid' && preview.text === null));
});

test('a failed setup tells the chat model no proposal exists and stops after two failures', async (t) => {
  const p = profile(t);
  const setupLlm = new SetupLLM({ draft: [cutOff(), cutOff(), cutOff(), cutOff()] });
  const propose = JSON.stringify({ tool: 'propose_character', step: 'propose', mode: 'character' });
  const chat = new ChatLLM([propose, propose, propose, JSON.stringify({ tool: 'answer', text: 'Setup failed; nothing changed.', citations: [] })]);
  const runtime = new WorkRuntime({ store: p.store, characterStore: p.characters, characterSetup: p.setup(setupLlm), ledger: p.ledger,
    artifacts: new ArtifactStore(p.store), sandbox: {} as any, llm: chat });
  const run = p.store.createTaskRun({ agentId: 'milo', taskName: 'conversation' });
  p.store.startTaskRun(run.id, MODEL);

  await runtime.execute({ taskRunId: run.id, contract: CONVERSATION_CONTRACT, request: 'Set up your character.', conversation: true, signal: new AbortController().signal });

  assert.equal(setupLlm.requests.length, 4, 'two setups with two draft attempts each; the third propose starts nothing');
  assert.equal(p.count('bot_character_proposals'), 0);
  // Text-protocol turns receive each tool observation as a user message flagged as an observation.
  const toolReplies = chat.requests.slice(1).map((req) => req.messages?.filter((m) => (m as { observation?: boolean }).observation).at(-1)?.content ?? '');
  assert.match(toolReplies[0], /Character setup failed: the model ran out of output room before finishing \(OUTPUT_LIMIT\)\./);
  assert.match(toolReplies[0], /No proposal or approval card was created and no settings changed/);
  assert.match(toolReplies[0], /"proposalCreated":false/);
  assert.match(toolReplies[0], /cannot change the character directly/);
  assert.match(toolReplies[2], /already failed twice in this request/);
  const calls = p.store.getTaskEvents(run.id).filter((e) => e.event_type === 'TOOL_CALL').map((e) => JSON.parse(e.payload_json));
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.summary, 'Character setup failed; no proposal exists.');
    assert.equal(call.failureCode, 'OUTPUT_LIMIT');
    assert.equal(call.proposalCreated, false);
  }
});

test('a running character setup run reports no workspace instead of a 404 the live-work panel logs as an error', { timeout: 120_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-character-workspace-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const port = await new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
  });
  const volumeChecks: string[] = [];
  const sandbox = { orphanSweep: async () => ({ reapedContainers: 0, reapedVolumes: 0 }), workspaceVolumeName: (name: string) => name,
    workspaceVolumeExists: async (volume: string) => { volumeChecks.push(volume); return false; } } as unknown as DockerSandbox;
  const daemon = await startDaemon({ configPath: null, dbPath: path.join(dir, 'openhours.db'), wsPort: port, cadenceMs: 100, maxConcurrency: 1,
    llmClient: new ChatLLM([]) as never, sandbox, docker: false });
  try {
    const agent = daemon.store.listAgents()[0];
    const run = daemon.store.createTaskRun({ id: `character-setup-${randomUUID()}`, agentId: agent.id, taskName: 'Character setup previews (unsent)', modelId: agent.model_id });
    daemon.store.startTaskRun(run.id, agent.model_id, { executor: 'character-preview', origin: 'setup-child', parentRunId: 'run-parent' });
    const response = await fetch(`http://127.0.0.1:${port}/api/runs/${encodeURIComponent(run.id)}/workspace`, { headers: { Authorization: `Bearer ${daemon.wsServer.authToken}` } });
    assert.equal(response.status, 200);
    const body = await response.json() as { available: boolean; required?: boolean };
    assert.equal(body.available, false);
    assert.equal(body.required, false);
    assert.deepEqual(volumeChecks, [], 'Docker is not asked for a volume a no-tool run can never have');
  } finally {
    await daemon.shutdown();
  }
});
