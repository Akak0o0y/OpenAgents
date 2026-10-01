/**
 * A model's own tool-call syntax is an action, never an answer.
 *
 * Walking through the app on the owner's profile, a routine asked for "the
 * three most important AI news stories". DeepSeek, through OpenRouter, replied
 * with its native `<｜DSML｜ invoke name="web_search">` markup instead of a JSON
 * action, and the runtime - which treats plain text in a conversation as the
 * answer - posted that markup into the chat as the routine's result.
 *
 * These pin the fix: the markup is translated into the action it names and
 * run; markup that names nothing runnable is refused and the model is asked
 * again; and the conversation only ever receives a real answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '../src/daemon/index.js';
import { nativeToolCall } from '../src/daemon/work-runtime.js';
import { ProviderCallError, completionText } from '../src/evals/llm-client.js';
import type { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import type { LLMRequest } from '../src/evals/llm-client.js';

/** Exactly what deepseek/deepseek-v4.1-flash returned in the owner's routine run. */
const OBSERVED = `<｜DSML｜ calls>
<｜DSML｜ invoke name="web_search">
<｜DSML｜ parameter name="query" string="true">AI ML news last 24 hours</｜DSML｜ parameter>
</｜DSML｜ invoke>
<｜DSML｜ invoke name="web_search">
<｜DSML｜ parameter name="query" string="true">artificial intelligence news today</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;

test('native tool-call markup is recognised and read as the action it names', () => {
  assert.deepEqual(nativeToolCall(OBSERVED), { action: { tool: 'web_search', query: 'AI ML news last 24 hours' }, count: 2 });
  assert.deepEqual(nativeToolCall('<｜DSML｜ invoke name="plan"><｜DSML｜ parameter name="steps" string="false">["Search", "Answer"]</｜DSML｜ parameter></｜DSML｜ invoke>'),
    { action: { tool: 'plan', steps: ['Search', 'Answer'] }, count: 1 }, 'string="false" values are JSON');
  assert.deepEqual(nativeToolCall('<function_calls><invoke name="web_read"><parameter name="url">https://example.com/</parameter></invoke></function_calls>'),
    { action: { tool: 'web_read', url: 'https://example.com/' }, count: 1 });
  assert.deepEqual(nativeToolCall('<tool_call>{"name":"recall","arguments":{"query":"preferences"}}</tool_call>'),
    { action: { tool: 'recall', query: 'preferences' }, count: 1 });
  // The same model, a minute later, doubled its delimiters.
  assert.deepEqual(nativeToolCall('<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="web_search"> <｜｜DSML｜｜ parameter name="query" string="true">AI news today major announcement</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>'),
    { action: { tool: 'web_search', query: 'AI news today major announcement' }, count: 1 });
  assert.deepEqual(nativeToolCall('<|DSML| invoke name="recall"><|DSML| parameter name="query">x</|DSML| parameter></|DSML| invoke>'), { action: { tool: 'recall', query: 'x' }, count: 1 });
  // DeepSeek's other format.
  assert.deepEqual(nativeToolCall('<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>web_read\n```json\n{"url":"https://www.anthropic.com/news"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>'),
    { action: { tool: 'web_read', url: 'https://www.anthropic.com/news' }, count: 1 });
  assert.deepEqual(nativeToolCall('<｜DSML｜ calls></｜DSML｜ calls>'), { action: undefined, count: 0 }, 'markup without a call is still not an answer');
  assert.equal(nativeToolCall('Here are three stories: <b>one</b>, two and three.'), null, 'ordinary text is left alone');
  assert.equal(nativeToolCall('{"tool":"answer","text":"hi"}'), null);
});

test('a reply made only of a structured tool call is read as that call', () => {
  assert.equal(completionText({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"AI news today"}' } }] }),
    '{"query":"AI news today","tool":"web_search"}');
  assert.equal(completionText({ content: 'Plain answer.', tool_calls: [{ function: { name: 'web_search', arguments: '{}' } }] }), 'Plain answer.', 'text wins when there is text');
  assert.equal(completionText({ content: '', tool_calls: [{ function: { name: 'web_search', arguments: '{not json' } }] }), '', 'an unreadable call stays empty');
  assert.equal(completionText({ content: '' }), '');
  assert.equal(completionText(undefined), '');
});

// Conversation turns never touch Docker; the boot sweep gets a harmless stand-in.
const sandbox = {
  orphanSweep: async () => ({ reapedContainers: 0, reapedVolumes: 0 }),
  workspaceVolumeName: (name: string) => name,
  workspaceVolumeExists: async () => false,
  createWorkspaceVolume: async () => { throw new Error('A conversation must not create a Docker workspace.'); },
} as unknown as DockerSandbox;

const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

test('in a conversation, native markup runs as an action or is sent back, and only a real answer reaches the chat', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-native-'));
  const replies = [
    '<｜DSML｜ calls>\n<｜DSML｜ invoke name="plan">\n<｜DSML｜ parameter name="steps" string="false">["Look it up", "Answer briefly"]</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n<｜DSML｜ invoke name="recall">\n<｜DSML｜ parameter name="query" string="true">news</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>',
    '<｜DSML｜ calls>\n<｜DSML｜ invoke name="summon_news">\n<｜DSML｜ parameter name="topic" string="true">AI</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>',
    JSON.stringify({ tool: 'answer', text: 'Here is a short answer.', citations: [] }),
  ];
  const requests: LLMRequest[] = [];
  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push({ ...req, messages: [...(req.messages ?? [])] });
      return { content: replies.shift() ?? JSON.stringify({ tool: 'answer', text: 'No further script.', citations: [] }), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
    },
  };
  const daemon = await startDaemon({ configPath: null, dbPath: path.join(dir, 'openhours.db'), wsPort: await freePort(), cadenceMs: 100, maxConcurrency: 1, llmClient: llmClient as never, sandbox, docker: false });
  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);
    const sent = await daemon.chat.send(thread.id, 'what happened in AI today?', 'native-1');
    assert.equal(sent.reply.content, 'Here is a short answer.');
    assert.ok(!daemon.store.getMessages(thread.id).some((message) => /DSML/.test(message.content)), 'no markup in the conversation');

    const { id: runId } = daemon.store.getDatabase().prepare('SELECT id FROM task_runs WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1').get(agent.id) as { id: string };
    const events = daemon.store.getDatabase().prepare('SELECT event_type, payload_json FROM execution_events WHERE task_run_id = ? ORDER BY id').all(runId) as Array<{ event_type: string; payload_json: string }>;
    const translated = events.filter((row) => row.event_type === 'NATIVE_TOOL_CALL_TRANSLATED').map((row) => JSON.parse(row.payload_json));
    assert.deepEqual(translated, [{ tool: 'plan', calls: 2 }]);
    assert.ok(events.some((row) => row.event_type === 'WORK_PLAN'), 'the translated plan really ran');

    const feedback = (request: LLMRequest) => JSON.parse(request.messages!.at(-1)!.content) as { status: string; summary: string; note?: string };
    assert.equal(feedback(requests[1]).note, 'Only the first of 2 tool calls ran. Send one JSON action per reply.');
    const refused = feedback(requests[2]);
    assert.equal(refused.status, 'error');
    assert.match(refused.summary, /built-in tool-call format for "summon_news" that this runtime cannot run/, 'unrunnable markup is sent back with the reason');
    assert.match(refused.summary, /exactly one JSON action object/);
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a batch of read-only actions runs its first; a batch with an action that changes something stays refused', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-batch-'));
  const replies = [
    `${JSON.stringify({ tool: 'recall', query: 'first' })}\n${JSON.stringify({ tool: 'recall', query: 'second' })}`,
    `${JSON.stringify({ tool: 'plan', steps: ['Change the plan'] })}\n${JSON.stringify({ tool: 'recall', query: 'third' })}`,
    JSON.stringify({ tool: 'answer', text: 'Done looking.', citations: [] }),
  ];
  const requests: LLMRequest[] = [];
  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push({ ...req, messages: [...(req.messages ?? [])] });
      return { content: replies.shift() ?? JSON.stringify({ tool: 'answer', text: 'No further script.', citations: [] }), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
    },
  };
  const daemon = await startDaemon({ configPath: null, dbPath: path.join(dir, 'openhours.db'), wsPort: await freePort(), cadenceMs: 100, maxConcurrency: 1, llmClient: llmClient as never, sandbox, docker: false });
  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);
    const sent = await daemon.chat.send(thread.id, 'look a few things up', 'batch-1');
    assert.equal(sent.reply.content, 'Done looking.');
    const { id: runId } = daemon.store.getDatabase().prepare('SELECT id FROM task_runs WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1').get(agent.id) as { id: string };
    const actions = (daemon.store.getDatabase().prepare("SELECT payload_json FROM execution_events WHERE task_run_id = ? AND event_type = 'WORK_ACTION' ORDER BY id").all(runId) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json).tool);
    assert.deepEqual(actions, ['recall', 'answer'], 'only the first read ran, and the mixed batch ran nothing');
    const feedback = (request: LLMRequest) => JSON.parse(request.messages!.at(-1)!.content) as { status: string; summary: string; note?: string };
    assert.equal(feedback(requests[1]).status, 'ok');
    assert.equal(feedback(requests[1]).note, 'Only the first of 2 tool calls ran. Send one JSON action per reply.');
    assert.equal(feedback(requests[2]).status, 'error');
    assert.match(feedback(requests[2]).summary, /more than one JSON object/);
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('near its step limit a conversation is told to answer with what it has', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-steps-'));
  const requests: LLMRequest[] = [];
  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push({ ...req, messages: [...(req.messages ?? [])] });
      // Keeps looking things up, as the real model did, until told how few steps remain.
      const told = /steps? (is|are) left/.test(req.messages?.at(-1)?.content ?? '');
      return { content: JSON.stringify(told ? { tool: 'answer', text: 'Here is what I found so far.', citations: [] } : { tool: 'recall', query: `news-${requests.length}` }), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
    },
  };
  const daemon = await startDaemon({ configPath: null, dbPath: path.join(dir, 'openhours.db'), wsPort: await freePort(), cadenceMs: 100, maxConcurrency: 1, llmClient: llmClient as never, sandbox, docker: false });
  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);
    const sent = await daemon.chat.send(thread.id, 'find everything about this', 'steps-1');
    assert.equal(sent.reply.content, 'Here is what I found so far.');
    const warned = requests.findIndex((request) => /steps? (is|are) left/.test(request.messages?.at(-1)?.content ?? ''));
    assert.ok(warned > 0, 'the model was told before the limit');
    assert.match(requests[warned].messages!.at(-1)!.content, /2 steps are left\. Answer now/);
    assert.equal(requests.length, warned + 1, 'and it answered instead of running out');
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('an empty reply is sent back to the model instead of ending the work', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-empty-'));
  let calls = 0;
  const requests: LLMRequest[] = [];
  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push({ ...req, messages: [...(req.messages ?? [])] });
      calls++;
      if (calls === 1) throw new ProviderCallError('EMPTY_RESPONSE', `Model ${req.modelId} returned no final answer. Private reasoning is not an executable answer.`, { usage: { inputTokens: 10, outputTokens: 88 }, finishReason: 'stop' });
      return { content: JSON.stringify({ tool: 'answer', text: 'Answered on the second try.', citations: [] }), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
    },
  };
  const daemon = await startDaemon({ configPath: null, dbPath: path.join(dir, 'openhours.db'), wsPort: await freePort(), cadenceMs: 100, maxConcurrency: 1, llmClient: llmClient as never, sandbox, docker: false });
  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);
    const sent = await daemon.chat.send(thread.id, 'anything new?', 'empty-1');
    assert.equal(sent.reply.content, 'Answered on the second try.');
    assert.equal(calls, 2);
    const nudge = JSON.parse(requests[1].messages!.at(-1)!.content) as { status: string; summary: string };
    assert.equal(nudge.status, 'error');
    assert.match(nudge.summary, /Your last reply was empty/);
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
