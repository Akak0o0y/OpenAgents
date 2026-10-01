/**
 * Routines and missions from chat, and results in chat.
 *
 * The owner's first real session found each of these broken in a different way:
 * chat had no routine tool, so "every hour, find new papers" became a mission
 * proposal whose sixty-second approval died with its turn; a routine built by
 * hand ran, and its results never reached the conversation.
 *
 * This runs a real daemon with a scripted model and checks the whole path:
 *
 *   1. A routine proposed in chat ends the turn at once, with a readable card.
 *   2. Approving the card creates the routine and says so in the conversation.
 *   3. The routine's run follows its instruction as a conversation turn, and its
 *      answer is posted into the same conversation.
 *   4. A mission proposal also ends its turn at once, and declining it is
 *      answered in the conversation without starting anything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '../src/daemon/index.js';
import { enqueueRoutine } from '../src/daemon/routine-dispatch.js';
import { ROUTINE_ASK_TASK } from '../src/daemon/work-contract.js';
import type { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import type { LLMRequest } from '../src/evals/llm-client.js';
import { BrowserAccounts } from '../src/daemon/browser-accounts.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';

const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

async function until<T>(read: () => T | undefined | null | false, timeoutMs: number, what: string | (() => string)): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${typeof what === 'function' ? what() : what}`);
}

// Conversation turns never touch Docker; the boot sweep and retention get a harmless stand-in.
const sandbox = {
  orphanSweep: async () => ({ reapedContainers: 0, reapedVolumes: 0 }),
  workspaceVolumeName: (name: string) => name,
  workspaceVolumeExists: async () => false,
  createWorkspaceVolume: async () => { throw new Error('A conversation must not create a Docker workspace.'); },
} as unknown as DockerSandbox;

test('a routine proposed in chat is created on approval and posts its results into the conversation; a declined mission starts nothing', { timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-proposals-'));
  const steps: unknown[] = [
    { tool: 'create_routine', name: 'AI papers', instruction: 'Find newly published AI papers and summarise the three most interesting.', schedule: 'every hour', timezone: 'Asia/Riyadh' },
    { tool: 'answer', text: 'Three new papers this hour: A, B and C.', citations: [] },
    { tool: 'start_mission', objective: 'Track new open-source agent frameworks', contractId: 'evidence-brief', maxRuns: 3, intervalMs: 3_600_000 },
  ];
  const requests: LLMRequest[] = [];
  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push(req);
      const step = steps.shift() ?? { tool: 'answer', text: 'No further script.', citations: [] };
      return { content: JSON.stringify(step), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
    },
  };

  const daemon = await startDaemon({ configPath: null, dbPath: path.join(dir, 'openhours.db'), wsPort: await freePort(), cadenceMs: 100, maxConcurrency: 1, llmClient: llmClient as never, sandbox, docker: false });
  try {
    const agent = daemon.store.listAgents()[0];
    assert.ok(agent, 'the default fleet has a bot');
    const thread = daemon.chat.createThread(agent.id);

    // 1. The proposal ends the turn at once.
    const proposed = await daemon.chat.send(thread.id, 'every hour, find new AI papers for me', 'routine-1');
    assert.equal(proposed.work?.outcome, 'COMPLETED');
    assert.match(proposed.reply.content, /Approve it on the card/);
    assert.match(proposed.reply.content, /\*\*AI papers\*\*: every hour \(Asia\/Riyadh\)/);
    assert.match(requests[0].systemPrompt, /"tool":"create_routine"/, 'the model is told it can create routines');
    const card = daemon.store.listApprovals({}).find((row) => row.kind === 'routine-create');
    assert.ok(card, 'a routine card is pending');
    assert.equal(card.status, 'PENDING');
    assert.equal(daemon.approvalGate.isWaiting(card.id, card.kind), true, 'the card is answerable without a waiting task');
    const payload = JSON.parse(card.payload_json);
    assert.equal(payload.question, 'Create the routine “AI papers”?');
    assert.equal(payload.cron, '0 * * * *');
    assert.equal(payload.threadId, thread.id);
    assert.equal(daemon.store.listRoutines().length, 0, 'nothing is created before approval');

    // 2. Approval creates it and answers in the conversation.
    daemon.approvalGate.decide(card.id, 'APPROVED');
    const conversation = () => daemon.store.getMessages(thread.id).map((m) => `${m.role}: ${m.content.slice(0, 160)}`).join(' | ');
    const routine = await until(() => daemon.store.listRoutines().find((row) => row.name === 'AI papers'), 30_000,
      () => `the routine. Routines: ${JSON.stringify(daemon.store.listRoutines().map((r) => r.name))}. Card: ${daemon.store.listApprovals({}).find((row) => row.id === card.id)?.status}. Conversation: ${conversation()}`);
    assert.equal(routine.task_name, ROUTINE_ASK_TASK);
    assert.equal(routine.timezone, 'Asia/Riyadh');
    assert.equal(routine.cron_expression, '0 * * * *');
    await until(() => daemon.store.getMessages(thread.id).some((m) => /^Created \*\*AI papers\*\*/.test(m.content)), 30_000, 'the confirmation');

    // 3. A run follows the instruction and its answer lands in the conversation.
    const { run } = enqueueRoutine(daemon.store, routine.id, { source: 'manual', maxQueueDepth: 5, definition: daemon.scheduler.getTaskDefinition(ROUTINE_ASK_TASK) });
    await until(() => daemon.store.getTaskRun(run.id)?.status === 'COMPLETED', 60_000, 'the routine run');
    const posted = await until(() => daemon.store.getMessages(thread.id).find((m) => m.task_run_id === run.id), 30_000, 'the routine result in chat');
    assert.equal(posted.role, 'assistant');
    assert.equal(posted.content, '**Routine · AI papers**\n\nThree new papers this hour: A, B and C.');
    const flagsData = daemon.store.getAgentData(routine.agent_id, 'flags', 'ui');
    assert.ok(flagsData, 'ui flags record saved for bot');
    assert.equal(JSON.parse(flagsData.data_json).unread, true, 'routine result marks bot unread');
    const runPrompt = requests[1].systemPrompt;
    assert.match(runPrompt, /This is a scheduled routine run: nobody is waiting to reply/);
    assert.doesNotMatch(runPrompt, /"tool":"create_routine"/, 'a scheduled run proposes nothing');

    // 4. A mission proposal ends its turn; declining it starts nothing and says so.
    const mission = await daemon.chat.send(thread.id, 'keep tracking new agent frameworks in the background', 'mission-1');
    assert.match(mission.reply.content, /as a mission\. Approve it on the card/);
    const missionCard = daemon.store.listApprovals({}).find((row) => row.kind === 'mission-start' && row.status === 'PENDING');
    assert.ok(missionCard, 'a mission card is pending');
    daemon.approvalGate.decide(missionCard.id, 'DENIED');
    await until(() => daemon.store.getMessages(thread.id).some((m) => /^Okay, I won't start that mission/.test(m.content)), 30_000, 'the decline reply');
    const missions = daemon.store.getDatabase().prepare('SELECT COUNT(*) AS n FROM missions').get() as { n: number };
    assert.equal(missions.n, 0);
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('an account the bot asks for in chat is entered in its card, never reaches the model, and is answered in the conversation', { timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-account-'));
  const username = 'alice@example.com';
  const password = 'Tr0ub4dor&3-in-chat-test';
  const steps: unknown[] = [
    { tool: 'request_account', site: 'https://www.github.com/login', reason: 'Star the repository you named.' },
    { tool: 'answer', text: 'I can sign in to GitHub now.', citations: [] },
    { tool: 'request_account', site: 'example.org', reason: 'Download your invoice.' },
  ];
  const requests: LLMRequest[] = [];
  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push(req);
      return { content: JSON.stringify(steps.shift() ?? { tool: 'answer', text: 'No further script.', citations: [] }), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
    },
  };
  const secretStore = new MemorySecretStore();
  const daemon = await startDaemon({ configPath: null, dbPath: path.join(dir, 'openhours.db'), wsPort: await freePort(), cadenceMs: 100, maxConcurrency: 1, llmClient: llmClient as never, sandbox, docker: false, secretStore });
  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);

    const asked = await daemon.chat.send(thread.id, 'star openagents on github for me', 'account-1');
    assert.match(asked.reply.content, /I need to sign in to \*\*github\.com\*\*\. Use \*\*Sign in securely\*\* on the card/);
    assert.match(requests[0].systemPrompt, /"tool":"request_account"/, 'the model is told it can ask for an account');
    assert.match(requests[0].systemPrompt, /No password credentials are saved for this bot/);
    const card = daemon.store.listApprovals({}).find((row) => row.kind === 'account-request');
    assert.ok(card, 'an account card is pending');
    const payload = JSON.parse(card.payload_json);
    assert.equal(payload.site, 'github.com', 'the site is normalised before it is shown');
    assert.equal(payload.question, `Sign in to github.com for ${agent.name}?`);

    // What the card does: the daemon saves the details, then approves.
    await new BrowserAccounts(daemon.store, secretStore).save(agent.id, { site: 'github.com', username, password });
    daemon.approvalGate.decide(card.id, 'APPROVED');
    await until(() => daemon.store.getMessages(thread.id).some((m) => /^Thanks\. The account for github\.com is saved/.test(m.content)), 30_000, 'the confirmation');

    await daemon.chat.send(thread.id, 'continue', 'account-2');
    const prompt = requests[1].systemPrompt;
    assert.match(prompt, /Saved accounts \(you never see their details\): \[\{"id":"acct-[^"]+","site":"github\.com","label":"github\.com"\}\]/);
    assert.match(prompt, /"secret":"password"/);
    assert.ok(!JSON.stringify(requests).includes(password) && !JSON.stringify(requests).includes(username), 'no detail ever reaches the model');
    const stored = JSON.stringify(daemon.store.getDatabase().prepare('SELECT * FROM approvals').all()) + JSON.stringify(daemon.store.getMessages(thread.id));
    assert.ok(!stored.includes(password) && !stored.includes(username), 'nor the card record or the conversation');

    await daemon.chat.send(thread.id, 'get my invoice from example.org', 'account-3');
    const second = daemon.store.listApprovals({}).find((row) => row.kind === 'account-request' && row.status === 'PENDING');
    assert.ok(second);
    daemon.approvalGate.decide(second.id, 'DENIED');
    await until(() => daemon.store.getMessages(thread.id).some((m) => /^Okay, I won't sign in to example\.org/.test(m.content)), 30_000, 'the decline reply');
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('an Obsidian vault named in chat is connected on approval, and the bot can then list, import and export its notes', { timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-vault-'));
  const vault = path.join(dir, 'Work vault');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Projects'));
  fs.writeFileSync(path.join(vault, 'Projects', 'plan.md'), '# Plan\nShip the tray icon first.');
  fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{}');
  const steps: unknown[] = [
    { tool: 'connect_obsidian_vault', path: vault },
    { tool: 'vault_list' },
    { tool: 'vault_import', file: 'Projects/plan.md', key: 'plan' },
    { tool: 'vault_export', key: 'plan' },
    { tool: 'answer', text: 'Imported your plan and saved a copy back to the vault.', citations: [] },
  ];
  const requests: LLMRequest[] = [];
  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push(req);
      return { content: JSON.stringify(steps.shift() ?? { tool: 'answer', text: 'No further script.', citations: [] }), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
    },
  };
  const daemon = await startDaemon({ configPath: null, dbPath: path.join(dir, 'openhours.db'), wsPort: await freePort(), cadenceMs: 100, maxConcurrency: 1, llmClient: llmClient as never, sandbox, docker: false });
  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);

    const proposed = await daemon.chat.send(thread.id, `use my obsidian vault at ${vault}`, 'vault-1');
    assert.match(proposed.reply.content, /connect that Obsidian vault\. Approve it on the card/);
    assert.match(requests[0].systemPrompt, /"tool":"connect_obsidian_vault"/);
    const card = daemon.store.listApprovals({}).find((row) => row.kind === 'vault-connect');
    assert.ok(card);
    daemon.approvalGate.decide(card.id, 'APPROVED');
    await until(() => daemon.store.getMessages(thread.id).some((m) => /^Connected your Obsidian vault at /.test(m.content)), 30_000, 'the vault confirmation');
    const stored = daemon.store.getDatabase().prepare('SELECT path FROM bot_vaults WHERE agent_id = ?').get(agent.id) as { path: string } | undefined;
    assert.equal(stored?.path, fs.realpathSync(vault));

    const worked = await daemon.chat.send(thread.id, 'bring my plan note into your memory and save a copy back', 'vault-2');
    assert.equal(worked.reply.content, 'Imported your plan and saved a copy back to the vault.');
    assert.match(requests[1].systemPrompt, /An Obsidian vault is connected\./);
    assert.doesNotMatch(requests[1].systemPrompt, /"tool":"connect_obsidian_vault"/, 'a connected vault is not proposed again');
    assert.match(JSON.stringify(requests[2].messages), /Projects\/plan\.md/, 'the note list reached the model');
    const note = daemon.store.getDatabase().prepare("SELECT text, origin FROM bot_memory WHERE agent_id = ? AND key = 'plan'").get(agent.id) as { text: string; origin: string } | undefined;
    assert.match(note?.text ?? '', /Ship the tray icon first/);
    assert.match(note?.origin ?? '', /^obsidian:Projects\/plan\.md/);
    assert.equal(fs.readdirSync(vault).filter((name) => /^OpenAgents-.*\.md$/.test(name)).length, 1, 'the export is a new file; nothing was overwritten');
    assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'plan.md'), 'utf8'), '# Plan\nShip the tray icon first.');
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
