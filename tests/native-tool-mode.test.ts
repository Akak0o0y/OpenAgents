import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '../src/daemon/index.js';
import { buildToolDefinitions, availableTools, TOOL_DESCRIPTIONS } from '../src/daemon/tool-schemas.js';
import { resolveToolMode, recordToolDowngrade, resetToolDowngrades } from '../src/daemon/tool-mode.js';
import { compactContext } from '../src/daemon/memory.js';
import { flattenConversationForJson, ProviderCallError } from '../src/evals/llm-client.js';
import type { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import type { LLMRequest } from '../src/evals/llm-client.js';

test('buildToolDefinitions produces strict valid schemas without $schema and tool property', () => {
  const defs = buildToolDefinitions();
  assert.ok(defs.size >= 20, 'Has definitions for all actions');
  assert.ok(defs.has('answer'), 'Has answer tool');
  assert.ok(defs.has('recall'), 'Has recall tool');
  assert.ok(defs.has('web_search'), 'Has web_search tool');

  for (const [name, def] of defs.entries()) {
    assert.equal(def.name, name);
    assert.equal(def.description, TOOL_DESCRIPTIONS[name] ?? `Execute the ${name} action.`);
    assert.ok(def.parameters, `${name} has parameters`);
    assert.equal(def.parameters.$schema, undefined, `$schema must be stripped from ${name}`);
    const props = (def.parameters as any).properties ?? {};
    assert.equal(props.tool, undefined, `'tool' discriminator must be omitted from ${name}`);
    assert.equal((def.parameters as any).additionalProperties, false, `strict additionalProperties: false on ${name}`);
  }

  const answerDef = defs.get('answer')!;
  assert.ok((answerDef.parameters as any).properties.text, 'answer tool has text parameter');
  assert.ok((answerDef.parameters as any).properties.citations, 'answer tool has citations parameter');
});

test('availableTools filters tools according to context flags', () => {
  const baseTools = availableTools({});
  const baseNames = new Set(baseTools.map(t => t.name));
  assert.ok(baseNames.has('plan'));
  assert.ok(baseNames.has('read'));
  assert.ok(baseNames.has('write'));
  assert.ok(baseNames.has('verify'));
  assert.ok(baseNames.has('finish'));
  assert.ok(baseNames.has('block'));
  assert.ok(baseNames.has('remember'));
  assert.ok(baseNames.has('recall'));
  assert.ok(baseNames.has('compact'));
  assert.ok(baseNames.has('source'));
  assert.ok(!baseNames.has('web_search'), 'web_search not available without webEnabled');
  assert.ok(!baseNames.has('browser'), 'browser not available without browserEnabled');
  assert.ok(!baseNames.has('answer'), 'answer not available without isConversation');
  assert.ok(!baseNames.has('vault_list'), 'vault tools not available without vaultConfigured');
  assert.ok(!baseNames.has('run'), 'run not available without shellEnabled: the executor rejects a shell outside code contracts');
  assert.ok(new Set(availableTools({ shellEnabled: true }).map(t => t.name)).has('run'), 'a code contract still offers its shell');

  const webTools = availableTools({ webEnabled: true });
  const webNames = new Set(webTools.map(t => t.name));
  assert.ok(webNames.has('web_read'));
  assert.ok(webNames.has('web_search'));
  assert.ok(webNames.has('github_issues'));

  const convTools = availableTools({
    isConversation: true,
    canProposeRoutine: true,
    hasMissions: true,
    canProposeVault: true,
    hasRepositories: true,
    canProposeRepoWork: true,
  });
  const convNames = new Set(convTools.map(t => t.name));
  assert.ok(convNames.has('answer'));
  assert.ok(convNames.has('create_routine'));
  assert.ok(convNames.has('start_mission'));
  assert.ok(convNames.has('connect_obsidian_vault'));
  assert.ok(convNames.has('start_repository_work'));

  const missionTools = availableTools({ isMission: true, hasMissions: true });
  const missionNames = new Set(missionTools.map(t => t.name));
  assert.ok(missionNames.has('mission_items'));
  assert.ok(missionNames.has('track_issue'));

  const vaultTools = availableTools({ vaultConfigured: true });
  const vaultNames = new Set(vaultTools.map(t => t.name));
  assert.ok(vaultNames.has('vault_list'));
  assert.ok(vaultNames.has('vault_import'));
  assert.ok(vaultNames.has('vault_export'));
});

test('resolveToolMode follows 7-level priority order', () => {
  resetToolDowngrades();

  // 1. OPENHOURS_TOOL_MODE env var
  process.env.OPENHOURS_TOOL_MODE = 'json';
  assert.equal(resolveToolMode({ modelId: 'gpt-4o' }), 'json');
  process.env.OPENHOURS_TOOL_MODE = 'native';
  assert.equal(resolveToolMode({ modelId: 'gemini-2.5-pro' }), 'native');
  delete process.env.OPENHOURS_TOOL_MODE;

  // 2. In-memory downgrade set
  recordToolDowngrade('conn-1', 'deepseek-chat');
  assert.equal(resolveToolMode({ modelId: 'deepseek-chat', connectionId: 'conn-1' }), 'json');
  assert.equal(resolveToolMode({ modelId: 'deepseek-chat' }), 'json');
  assert.equal(resolveToolMode({ modelId: 'gpt-4o', connectionId: 'conn-1' }), 'json');
  assert.equal(resolveToolMode({ modelId: 'gpt-4o', connectionId: 'conn-2' }), 'native');
  resetToolDowngrades();
  assert.equal(resolveToolMode({ modelId: 'deepseek-chat', connectionId: 'conn-1' }), 'native');

  // 3. Gemini and OpenCode use JSON
  assert.equal(resolveToolMode({ modelId: 'google/gemini-2.5-flash' }), 'json');
  assert.equal(resolveToolMode({ modelId: 'opencode/big-model' }), 'json');
  assert.equal(resolveToolMode({ modelId: 'custom-model', provider: 'gemini' }), 'json');
  assert.equal(resolveToolMode({ modelId: 'custom-model', provider: 'opencode' }), 'json');

  // 4. Gateway catalog supportsTools
  assert.equal(resolveToolMode({ modelId: 'custom-model', supportsTools: false }), 'json');
  assert.equal(resolveToolMode({ modelId: 'custom-model', supportsTools: true }), 'native');

  // 5. OpenRouter supported_parameters
  assert.equal(resolveToolMode({ modelId: 'custom-model', supportedParameters: ['tools', 'temperature'] }), 'native');
  assert.equal(resolveToolMode({ modelId: 'custom-model', supportedParameters: ['temperature'] }), 'json');

  // 6. Connection tool_mode
  assert.equal(resolveToolMode({ modelId: 'custom-model', connectionToolMode: 'json' }), 'json');
  assert.equal(resolveToolMode({ modelId: 'custom-model', connectionToolMode: 'native' }), 'native');

  // 7. Default to native
  assert.equal(resolveToolMode({ modelId: 'claude-3-5-sonnet' }), 'native');
});

test('compactContext preserves tool call and tool result message pairs', () => {
  const messages: any[] = [
    { role: 'user', content: 'Objective' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'recall', arguments: '{"query":"a"}' }] },
    { role: 'tool', toolCallId: 'c1', content: '{"status":"ok","summary":"res1"}' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'recall', arguments: '{"query":"b"}' }] },
    { role: 'tool', toolCallId: 'c2', content: '{"status":"ok","summary":"res2"}' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'recall', arguments: '{"query":"c"}' }] },
    { role: 'tool', toolCallId: 'c3', content: '{"status":"ok","summary":"res3"}' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c4', name: 'recall', arguments: '{"query":"d"}' }] },
    { role: 'tool', toolCallId: 'c4', content: '{"status":"ok","summary":"res4"}' },
  ];

  const compacted = compactContext(messages, { state: 'test' });
  assert.equal(compacted[0].content, 'Objective');
  assert.match(compacted[1].content, /Runtime checkpoint/);
  // Message immediately after checkpoint must NOT be an orphaned role: 'tool'
  assert.notEqual(compacted[2].role, 'tool', 'Message after checkpoint cannot be orphaned tool result');
  assert.equal(compacted[2].role, 'assistant', 'Compaction preserves preceding assistant tool call');
});

test('flattenConversationForJson transforms tool messages and assistant tool calls', () => {
  const messages: any[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Thinking...', toolCalls: [{ id: 'c1', name: 'recall', arguments: '{"query":"notes"}' }] },
    { role: 'tool', toolCallId: 'c1', content: '{"status":"ok","summary":"found note"}' },
  ];

  const flattened = flattenConversationForJson(messages);
  assert.equal(flattened.length, 3);
  assert.equal(flattened[0].role, 'user');
  assert.equal(flattened[0].content, 'hello');

  assert.equal(flattened[1].role, 'assistant');
  assert.match(flattened[1].content, /Thinking\.\.\./);
  assert.match(flattened[1].content, /"tool":"recall"/);
  assert.match(flattened[1].content, /"query":"notes"/);

  assert.equal(flattened[2].role, 'user');
  assert.equal(flattened[2].content, '{"status":"ok","summary":"found note"}');
});

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

test('in native tool mode, toolCalls execute via dispatch and match tool observations in next turn', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-native-test-'));
  const requests: LLMRequest[] = [];
  let turn = 0;

  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push({ ...req, messages: [...(req.messages ?? [])] });
      turn++;
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_recall_1', name: 'recall', arguments: JSON.stringify({ query: 'saved preferences' }) }],
          inputTokens: 20,
          outputTokens: 15,
          attemptCount: 1,
        };
      }
      return {
        content: JSON.stringify({ tool: 'answer', text: 'Found your preferences!', citations: [] }),
        inputTokens: 25,
        outputTokens: 10,
        attemptCount: 1,
      };
    },
  };

  const daemon = await startDaemon({
    configPath: null,
    dbPath: path.join(dir, 'openhours.db'),
    wsPort: await freePort(),
    cadenceMs: 100,
    maxConcurrency: 1,
    llmClient: llmClient as never,
    sandbox,
    docker: false,
  });

  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);
    const sent = await daemon.chat.send(thread.id, 'do you recall my preferences?', 'call-1');
    assert.equal(sent.reply.content, 'Found your preferences!');
    assert.equal(requests.length, 2);

    // Request 1 has tools definition populated
    assert.ok(requests[0].tools && requests[0].tools.length > 0, 'Tools passed to native request');
    const recallTool = requests[0].tools?.find(t => t.name === 'recall');
    assert.ok(recallTool, 'recall tool is in definitions');

    // Request 2 has assistant message with toolCalls followed by role: 'tool'
    const msgs = requests[1].messages!;
    const assistantMsg = msgs[msgs.length - 2];
    assert.equal(assistantMsg.role, 'assistant');
    assert.deepEqual(assistantMsg.toolCalls, [{ id: 'call_recall_1', name: 'recall', arguments: '{"query":"saved preferences"}' }]);

    const toolMsg = msgs[msgs.length - 1];
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.toolCallId, 'call_recall_1');
    const toolObs = JSON.parse(toolMsg.content);
    assert.equal(toolObs.status, 'ok');

    // Execution events verify TOOL_CALL
    const db = daemon.store.getDatabase();
    const rows = db.prepare("SELECT event_type, payload_json FROM execution_events WHERE event_type = 'TOOL_CALL'").all() as any[];
    assert.ok(rows.some(r => JSON.parse(r.payload_json).tool === 'recall'), 'TOOL_CALL event recorded for recall');
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('multi-call turn executes first tool call and marks subsequent calls as notRun with tool responses', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-multi-test-'));
  const requests: LLMRequest[] = [];
  let turn = 0;

  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push({ ...req, messages: [...(req.messages ?? [])] });
      turn++;
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'recall', arguments: '{"query":"first"}' },
            { id: 'c2', name: 'write', arguments: '{"path":"file.txt","content":"data"}' },
          ],
          inputTokens: 20,
          outputTokens: 25,
          attemptCount: 1,
        };
      }
      return {
        content: JSON.stringify({ tool: 'answer', text: 'Handled multi call.', citations: [] }),
        inputTokens: 30,
        outputTokens: 10,
        attemptCount: 1,
      };
    },
  };

  const daemon = await startDaemon({
    configPath: null,
    dbPath: path.join(dir, 'openhours.db'),
    wsPort: await freePort(),
    cadenceMs: 100,
    maxConcurrency: 1,
    llmClient: llmClient as never,
    sandbox,
    docker: false,
  });

  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);
    const sent = await daemon.chat.send(thread.id, 'recall and write', 'multi-1');
    assert.equal(sent.reply.content, 'Handled multi call.');

    // In turn 2, there should be tool messages for both c1 and c2
    const msgs = requests[1].messages!;
    const toolMsg1 = msgs.find(m => m.role === 'tool' && m.toolCallId === 'c1');
    const toolMsg2 = msgs.find(m => m.role === 'tool' && m.toolCallId === 'c2');
    assert.ok(toolMsg1, 'Tool message for c1 present');
    assert.ok(toolMsg2, 'Tool message for c2 present');

    const obs1 = JSON.parse(toolMsg1!.content);
    assert.equal(obs1.status, 'ok');

    const obs2 = JSON.parse(toolMsg2!.content);
    assert.equal(obs2.status, 'error');
    assert.equal(obs2.notRun, true);
    assert.match(obs2.summary, /Only the first of 2 tool calls ran/);
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('all read-only multi-call turn executes all tool calls in parallel', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-parallel-test-'));
  const requests: LLMRequest[] = [];
  let turn = 0;

  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push({ ...req, messages: [...(req.messages ?? [])] });
      turn++;
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'plan', arguments: '{"steps":["research topic"]}' },
            { id: 'c2', name: 'recall', arguments: '{"query":"topic"}' },
          ],
          inputTokens: 20,
          outputTokens: 25,
          attemptCount: 1,
        };
      }
      return {
        content: JSON.stringify({ tool: 'answer', text: 'Handled parallel read calls.', citations: [] }),
        inputTokens: 30,
        outputTokens: 10,
        attemptCount: 1,
      };
    },
  };

  const daemon = await startDaemon({
    configPath: null,
    dbPath: path.join(dir, 'openhours.db'),
    wsPort: await freePort(),
    cadenceMs: 100,
    maxConcurrency: 1,
    llmClient: llmClient as never,
    sandbox,
    docker: false,
  });

  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);
    const sent = await daemon.chat.send(thread.id, 'plan and search', 'parallel-1');
    assert.equal(sent.reply.content, 'Handled parallel read calls.');

    // In turn 2, both tool messages should be ok
    const msgs = requests[1].messages!;
    const toolMsg1 = msgs.find(m => m.role === 'tool' && m.toolCallId === 'c1');
    const toolMsg2 = msgs.find(m => m.role === 'tool' && m.toolCallId === 'c2');
    assert.ok(toolMsg1, 'Tool message for c1 present');
    assert.ok(toolMsg2, 'Tool message for c2 present');

    const obs1 = JSON.parse(toolMsg1!.content);
    assert.equal(obs1.status, 'ok');
    assert.match(obs1.summary, /Plan recorded as checklist/);

    const obs2 = JSON.parse(toolMsg2!.content);
    assert.equal(obs2.status, 'ok');
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('malformed JSON arguments in native tool call return error observation without crashing runtime', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-malformed-test-'));
  const requests: LLMRequest[] = [];
  let turn = 0;

  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push({ ...req, messages: [...(req.messages ?? [])] });
      turn++;
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'c_bad', name: 'recall', arguments: '{bad-json:' }],
          inputTokens: 20,
          outputTokens: 10,
          attemptCount: 1,
        };
      }
      return {
        content: JSON.stringify({ tool: 'answer', text: 'Fixed args.', citations: [] }),
        inputTokens: 30,
        outputTokens: 10,
        attemptCount: 1,
      };
    },
  };

  const daemon = await startDaemon({
    configPath: null,
    dbPath: path.join(dir, 'openhours.db'),
    wsPort: await freePort(),
    cadenceMs: 100,
    maxConcurrency: 1,
    llmClient: llmClient as never,
    sandbox,
    docker: false,
  });

  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);
    const sent = await daemon.chat.send(thread.id, 'trigger malformed', 'bad-1');
    assert.equal(sent.reply.content, 'Fixed args.');

    const msgs = requests[1].messages!;
    const toolMsg = msgs.find(m => m.role === 'tool' && m.toolCallId === 'c_bad');
    assert.ok(toolMsg, 'Error observation for c_bad present');
    const obs = JSON.parse(toolMsg!.content);
    assert.equal(obs.status, 'error');
    assert.match(obs.summary, /Invalid JSON arguments/);
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('HTTP 400 with tool error triggers downgrade to JSON mode with flattened conversation', { timeout: 120_000 }, async () => {
  resetToolDowngrades();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-downgrade-test-'));
  const requests: LLMRequest[] = [];
  let callCount = 0;

  const llmClient = {
    async generateCode(req: LLMRequest) {
      requests.push({ ...req, messages: [...(req.messages ?? [])] });
      callCount++;
      if (callCount === 1) {
        // Provider rejects tools parameter with HTTP 400
        throw new ProviderCallError('HTTP_ERROR', 'Provider rejected call: unsupported parameter: tools', { status: 400 });
      }
      // After downgrade to json mode, model replies with JSON action
      return {
        content: JSON.stringify({ tool: 'answer', text: 'Downgraded successfully.', citations: [] }),
        inputTokens: 20,
        outputTokens: 10,
        attemptCount: 1,
      };
    },
  };

  const daemon = await startDaemon({
    configPath: null,
    dbPath: path.join(dir, 'openhours.db'),
    wsPort: await freePort(),
    cadenceMs: 100,
    maxConcurrency: 1,
    llmClient: llmClient as never,
    sandbox,
    docker: false,
  });

  try {
    const agent = daemon.store.listAgents()[0];
    const thread = daemon.chat.createThread(agent.id);
    const sent = await daemon.chat.send(thread.id, 'downgrade please', 'down-1');
    assert.equal(sent.reply.content, 'Downgraded successfully.');
    assert.equal(callCount, 2);

    // Call 1 had tools
    assert.ok(requests[0].tools && requests[0].tools.length > 0);

    // Call 2 was downgraded: tools is undefined
    assert.equal(requests[1].tools, undefined, 'Downgraded call does not send tools');

    // Downgrade event was emitted
    const db = daemon.store.getDatabase();
    const events = db.prepare("SELECT event_type, payload_json FROM execution_events WHERE event_type = 'TOOL_MODE_DOWNGRADED'").all() as any[];
    assert.equal(events.length, 1, 'TOOL_MODE_DOWNGRADED recorded');
    const payload = JSON.parse(events[0].payload_json);
    assert.equal(payload.modelId, agent.model_id);
  } finally {
    resetToolDowngrades();
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('provider_connections schema includes tool_mode column and stores settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-db-test-'));
  const daemon = await startDaemon({
    configPath: null,
    dbPath: path.join(dir, 'openhours.db'),
    wsPort: await freePort(),
    cadenceMs: 100,
    maxConcurrency: 1,
    sandbox,
    docker: false,
  });

  try {
    const db = daemon.store.getDatabase();
    // Verify tool_mode column exists
    const cols = db.prepare("PRAGMA table_info(provider_connections)").all() as Array<{ name: string; type: string }>;
    const toolModeCol = cols.find(c => c.name === 'tool_mode');
    assert.ok(toolModeCol, 'tool_mode column exists on provider_connections');

    // Insert a test connection with tool_mode = 'json'
    db.prepare(`
      INSERT INTO provider_connections (id, name, preset, base_url, enabled, requests_per_day, tokens_per_day, status, status_message, tool_mode, created_at, updated_at)
      VALUES ('conn_test', 'Test Connection', 'custom', 'https://api.openai.com/v1', 1, 100, 100000, 'ready', 'OK', 'json', 1700000000000, 1700000000000)
    `).run();

    const row = db.prepare("SELECT tool_mode FROM provider_connections WHERE id = 'conn_test'").get() as { tool_mode: string };
    assert.equal(row.tool_mode, 'json');
  } finally {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
