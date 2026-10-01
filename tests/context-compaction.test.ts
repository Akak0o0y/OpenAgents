import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkRuntime, getModelContextWindow } from '../src/daemon/work-runtime.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';
import type { ILLMClient, LLMRequest, LLMResponse, ChatMessage } from '../src/evals/llm-client.js';
import { ProviderCallError } from '../src/evals/llm-client.js';
import { contextChars, fitObservationBudget } from '../src/daemon/context-budget.js';

const MODEL = 'openrouter/deepseek/deepseek-chat';

test('observation fitting counts tool schemas, removes duplicate snapshots and preserves instructions and native pairs', () => {
  const snapshot = 'Browser page content '.repeat(1200);
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Update the draft only. Do not publish.' },
    ...Array.from({ length: 4 }, (_, i): ChatMessage[] => [
      { role: 'assistant', content: '', toolCalls: [{ id: `browser-${i}`, name: 'browser', arguments: '{"action":"snapshot"}' }] },
      { role: 'tool', toolCallId: `browser-${i}`, content: JSON.stringify({ snapshot, summary: snapshot, outcome: 'observed' }) },
    ]).flat(),
    { role: 'user', content: 'Keep the saved draft. Do not submit it.' },
  ];
  const original = JSON.stringify(messages);
  const tools = [{ name: 'browser', description: 'Tool schema overhead '.repeat(1000), parameters: { type: 'object' } }];
  const result = fitObservationBudget('System '.repeat(1500), messages, tools);
  assert.ok(contextChars('System '.repeat(1500), result, tools) <= 90_000);
  assert.equal(JSON.stringify(messages), original, 'input history remains immutable');
  assert.deepEqual(result.filter(m => m.role === 'user'), messages.filter(m => m.role === 'user'));
  for (let i = 1; i < result.length - 1; i += 2) {
    assert.deepEqual(result[i], messages[i]);
    assert.equal(result[i + 1].toolCallId, result[i].toolCalls![0].id);
  }
  const latest = JSON.parse(result.at(-2)!.content);
  assert.equal(latest.snapshot, snapshot, 'newest full page survives when it fits');
  assert.notEqual(latest.summary, snapshot);
});

test('observation fitting prunes JSON-mode evidence and old images without mutating operator content', () => {
  const image = { mime: 'image/png' as const, data: 'fixture' };
  const messages: ChatMessage[] = [
    { role: 'user', content: 'User input must stay exact', images: [image] },
    { role: 'user', content: 'Old page '.repeat(4000), images: [image], observation: true } as ChatMessage,
    { role: 'user', content: 'New page with current references', images: [image], observation: true } as ChatMessage,
  ];
  const result = fitObservationBudget('system', messages, undefined, 60000);
  assert.ok(contextChars('system', result) <= 60000);
  assert.deepEqual(result[0], messages[0]);
  assert.equal(result[1].images, undefined);
  assert.match(result[1].content, /pruned/);
  assert.deepEqual(result[2], messages[2]);
});

test('impossible context budgets preserve operator authority instead of silently truncating it', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'Do not alter this instruction. '.repeat(5000) }];
  const result = fitObservationBudget('system', messages);
  assert.deepEqual(result, messages);
  assert.ok(contextChars('system', result) > 120000, 'caller must report an explicit capacity failure');
});

class MemorySandbox {
  calls: string[] = [];
  files = new Map<string, Record<string, string>>();
  async createWorkspaceVolume(id: string) { this.files.set(id, {}); return id; }
  async stageWorkspaceFiles(id: string, files: Record<string, string>) {
    const cur = this.files.get(id) ?? {};
    Object.assign(cur, files);
    this.files.set(id, cur);
  }
  async readWorkspaceFile(id: string, file: string) {
    const f = this.files.get(id);
    if (!f || !(file in f)) {
      if (file === 'README.md') return { content: '# Test', truncated: false };
      throw new Error(`Missing file: ${file}`);
    }
    return { content: f[file], truncated: false };
  }
  async executeTask(id: string, command: string) {
    this.calls.push(command);
    return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
  }
  async destroyWorkspaceVolume(id: string) { this.files.delete(id); }
}

class ScriptedLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  compactionHandler?: (request: LLMRequest) => Promise<LLMResponse> | LLMResponse;
  constructor(private responses: Array<string | Record<string, any>>) {}

  async generateCode(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: request.messages?.map(m => ({ ...m })) });
    
    // Check if this is a compaction call
    if (request.systemPrompt?.includes('execution history summarizer')) {
      request.onProviderEvent?.({ phase: 'complete', modelId: request.modelId, attempt: 1, elapsedMs: 25 });
      if (this.compactionHandler) {
        return await this.compactionHandler(request);
      }
      return {
        content: 'Historical summary: Agent performed exploratory read actions and completed work steps successfully.',
        inputTokens: 120,
        outputTokens: 30,
        attemptCount: 1,
      };
    }

    request.onProviderEvent?.({ phase: 'complete', modelId: request.modelId, attempt: 1, elapsedMs: 15 });
    const next = this.responses.shift() ?? { tool: 'answer', text: 'Done' };
    if (typeof next === 'object' && next !== null && 'toolCalls' in next) {
      return {
        content: '',
        toolCalls: next.toolCalls as any,
        inputTokens: 150,
        outputTokens: 50,
        attemptCount: 1,
      };
    }
    return {
      content: typeof next === 'string' ? next : JSON.stringify(next),
      inputTokens: 150,
      outputTokens: 50,
      attemptCount: 1,
    };
  }
}

function createHarness(actions: Array<string | Record<string, any>>, catalogContextWindow?: number) {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());

  let connectionId: string | undefined;
  if (catalogContextWindow) {
    connectionId = 'conn-1';
    store.getDatabase().prepare(`
      INSERT INTO provider_connections (id, name, preset, base_url, enabled, requests_per_day, tokens_per_day, status, status_message, catalog_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'conn-1',
      'Test Conn',
      'custom',
      'https://api.test',
      1,
      1000,
      100000,
      'connected',
      'Ready',
      JSON.stringify([{ id: MODEL, contextWindow: catalogContextWindow, supportsTools: true }]),
      Date.now(),
      Date.now()
    );
  }

  store.createAgent({
    id: 'worker',
    name: 'Worker',
    model_id: MODEL,
    connection_id: connectionId,
    budget_cap_usd: 100,
    current_status: 'IDLE'
  });

  const llm = new ScriptedLLM(actions);
  const artifacts = new ArtifactStore(store);
  const sandbox = new MemorySandbox();
  const runtime = new WorkRuntime({ store, ledger, llm, sandbox, artifacts });

  return {
    store,
    ledger,
    llm,
    artifacts,
    runtime,
    sandbox,
    close: () => { ledger.close(); store.close(); },
  };
}

test('getModelContextWindow: resolves from connection catalog, openrouter, or fallback', () => {
  // 1. From catalog
  const catalog = [{ id: 'test-model', contextWindow: 64000 }];
  assert.equal(getModelContextWindow('test-model', catalog), 64000);

  // 2. Fallback when not found
  assert.equal(getModelContextWindow('unknown-model', catalog), 128000);
  assert.equal(getModelContextWindow('unknown-model'), 128000);
});

test('Token meter: HISTORY_APPENDED emits estimatedTokens, lastInputTokens, and contextWindow across turns', async () => {
  const h = createHarness([
    { tool: 'read', path: 'README.md' },
    { tool: 'answer', text: 'Finished read' }
  ], 64000);

  try {
    const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
    h.store.startTaskRun(run.id, MODEL);

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Please read README.md',
      conversation: true,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(result.outcome, 'COMPLETED');

    const events = h.store.getTaskEvents(run.id);
    const historyEvents = events.filter(e => e.event_type === 'HISTORY_APPENDED');
    assert.equal(historyEvents.length, 2, 'Two turns executed');

    // Turn 1
    const p1 = JSON.parse(historyEvents[0].payload_json);
    assert.equal(typeof p1.estimatedTokens, 'number');
    assert.ok(p1.estimatedTokens > 0);
    assert.equal(p1.lastInputTokens, null, 'Turn 1 has no previous inputTokens');
    assert.equal(p1.contextWindow, 64000);

    // Turn 2
    const p2 = JSON.parse(historyEvents[1].payload_json);
    assert.equal(typeof p2.estimatedTokens, 'number');
    assert.ok(p2.estimatedTokens > p1.estimatedTokens, 'Context grows in turn 2');
    assert.equal(p2.lastInputTokens, 150, 'Turn 2 carries inputTokens from turn 1 response');
    assert.equal(p2.contextWindow, 64000);
  } finally {
    h.close();
  }
});

test('LLM summary compaction: triggers at 70% of contextWindow, emits CONTEXT_COMPACTED with mode: llm', async () => {
  // Set a small context window of 2000 tokens so 70% threshold is 1400 tokens (~5600 chars)
  const h = createHarness([], 2000);

  try {
    const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
    h.store.startTaskRun(run.id, MODEL);

    const longBlob = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(120); // ~6700 chars
    const initialHistory: ChatMessage[] = [
      { role: 'user', content: 'Initial task objective: analyze repository.' },
      { role: 'assistant', content: 'Turn 1: Starting file inspection.' },
      { role: 'tool', content: 'Observation 1: ' + longBlob } as any,
      { role: 'assistant', content: 'Turn 2: Reading more files.' },
      { role: 'tool', content: 'Observation 2: ' + longBlob } as any,
      { role: 'assistant', content: 'Turn 3: Still checking.' },
      { role: 'tool', content: 'Observation 3: ' + longBlob } as any,
      { role: 'assistant', content: 'Turn 4: Checking deeper.' },
      { role: 'tool', content: 'Observation 4: ' + longBlob } as any,
      { role: 'assistant', content: 'Turn 5: Ready to finish.' },
    ];

    h.llm['responses'] = [
      { tool: 'answer', text: 'Compaction finished and task completed.' }
    ];

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Analyze repository',
      initialMessages: initialHistory,
      conversation: true,
      signal: AbortSignal.timeout(15000),
    });

    assert.equal(result.outcome, 'COMPLETED');

    const events = h.store.getTaskEvents(run.id);
    const compactEvents = events.filter(e => e.event_type === 'CONTEXT_COMPACTED');
    assert.ok(compactEvents.length >= 1, 'CONTEXT_COMPACTED must be emitted');

    const payload = JSON.parse(compactEvents[0].payload_json);
    assert.equal(payload.mode, 'llm');
    assert.ok(payload.beforeChars > payload.afterChars, 'Compacted history must be smaller');
    assert.ok(payload.beforeChars > 10000);

    // Verify a PROVIDER_CALL was emitted with purpose: 'compaction'
    const providerCalls = events.filter(e => e.event_type === 'PROVIDER_CALL');
    const compactionCall = providerCalls.find(e => {
      const p = JSON.parse(e.payload_json);
      return p.purpose === 'compaction';
    });
    assert.ok(compactionCall, 'A PROVIDER_CALL with purpose compaction must be recorded');
  } finally {
    h.close();
  }
});

test('LLM summary compaction: preserves tool call and tool result pairs without orphaning', async () => {
  const h = createHarness([], 2000);

  try {
    const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
    h.store.startTaskRun(run.id, MODEL);

    const longText = 'Data payload block for inspection. '.repeat(100);
    const toolCallId = 'call_read_123';
    const initialHistory: ChatMessage[] = [
      { role: 'user', content: 'Task objective' },
      { role: 'assistant', content: 'Step 1', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"f1.ts"}' }] },
      { role: 'tool', content: 'Result 1: ' + longText, toolCallId: 'call_1' } as any,
      { role: 'assistant', content: 'Step 2', toolCalls: [{ id: 'call_2', name: 'read', arguments: '{"path":"f2.ts"}' }] },
      { role: 'tool', content: 'Result 2: ' + longText, toolCallId: 'call_2' } as any,
      { role: 'assistant', content: 'Step 3', toolCalls: [{ id: 'call_3', name: 'read', arguments: '{"path":"f3.ts"}' }] },
      { role: 'tool', content: 'Result 3: ' + longText, toolCallId: 'call_3' } as any,
      { role: 'assistant', content: 'Step 4', toolCalls: [{ id: toolCallId, name: 'read', arguments: '{"path":"file.ts"}' }] },
      { role: 'tool', content: 'Result 4: ' + longText, toolCallId } as any,
      { role: 'assistant', content: 'Step 5' },
    ];

    h.llm.compactionHandler = (req) => {
      return {
        content: 'Historical summary: earlier steps inspected data.',
        inputTokens: 100,
        outputTokens: 25,
        attemptCount: 1,
      };
    };

    h.llm['responses'] = [
      { tool: 'answer', text: 'All done.' }
    ];

    await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Check files',
      initialMessages: initialHistory,
      conversation: true,
      signal: AbortSignal.timeout(15000),
    });

    // Inspect the messages sent to the final answer turn
    const answerReq = h.llm.requests.find(r => !r.systemPrompt?.includes('execution history summarizer'));
    assert.ok(answerReq?.messages);
    const msgs = answerReq.messages;

    // messages[0] is the authority/task message
    assert.equal(msgs[0].role, 'user');
    // messages[1] is the compacted summary message
    assert.ok(msgs[1].content.includes('Historical execution summary (model-generated):'));
    assert.ok(msgs[1].content.includes('Runtime checkpoint'));

    // Check that tool call and tool result pairs in the remaining messages are intact
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'tool') {
        assert.ok(i > 0, 'tool message must not be first');
        const prev = msgs[i - 1];
        assert.ok(
          (prev.role === 'assistant' && prev.toolCalls && prev.toolCalls.length > 0) || prev.role === 'tool',
          'tool response must not be orphaned from assistant toolCalls'
        );
      }
    }
  } finally {
    h.close();
  }
});

test('Fallback: degrades gracefully to deterministic compaction when LLM summarization fails', async () => {
  const h = createHarness([], 2000);

  try {
    const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
    h.store.startTaskRun(run.id, MODEL);

    const longBlob = 'Filler data content '.repeat(200);
    const initialHistory: ChatMessage[] = [
      { role: 'user', content: 'Main instruction' },
      { role: 'assistant', content: 'Step 1' },
      { role: 'tool', content: 'Observation 1: ' + longBlob } as any,
      { role: 'assistant', content: 'Step 2' },
      { role: 'tool', content: 'Observation 2: ' + longBlob } as any,
      { role: 'assistant', content: 'Step 3' },
      { role: 'tool', content: 'Observation 3: ' + longBlob } as any,
      { role: 'assistant', content: 'Step 4' },
      { role: 'tool', content: 'Observation 4: ' + longBlob } as any,
      { role: 'assistant', content: 'Step 5' },
    ];

    // Make the compaction LLM call fail
    h.llm.compactionHandler = () => {
      throw new Error('LLM compaction service timed out');
    };

    h.llm['responses'] = [
      { tool: 'answer', text: 'Survived LLM failure and finished.' }
    ];

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Run test',
      initialMessages: initialHistory,
      conversation: true,
      signal: AbortSignal.timeout(15000),
    });

    assert.equal(result.outcome, 'COMPLETED');

    const events = h.store.getTaskEvents(run.id);
    const compactEvents = events.filter(e => e.event_type === 'CONTEXT_COMPACTED');
    assert.equal(compactEvents.length, 1);

    const payload = JSON.parse(compactEvents[0].payload_json);
    assert.equal(payload.mode, 'deterministic', 'Must fall back to deterministic mode');
    assert.ok(payload.beforeChars > payload.afterChars);
  } finally {
    h.close();
  }
});

test('Explicit compact action: triggers compaction pipeline and returns observation', async () => {
  const h = createHarness([
    { tool: 'compact' },
    { tool: 'answer', text: 'Done after compact' }
  ], 128000);

  try {
    const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
    h.store.startTaskRun(run.id, MODEL);

    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: CONVERSATION_CONTRACT,
      request: 'Perform compaction',
      conversation: true,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(result.outcome, 'COMPLETED');

    const events = h.store.getTaskEvents(run.id);
    const compactEvents = events.filter(e => e.event_type === 'CONTEXT_COMPACTED');
    assert.ok(compactEvents.length >= 1, 'CONTEXT_COMPACTED emitted on explicit compact tool');
  } finally {
    h.close();
  }
});

const nativeHeavyHistory = (): ChatMessage[] => [
  { role: 'user', content: 'Keep the original objective.' },
  ...Array.from({ length: 5 }, (_, i): ChatMessage[] => [
    { role: 'assistant', content: '', toolCalls: [{ id: `call-${i}`, name: 'write', arguments: JSON.stringify({ path: `src/${i}.js`, content: 'x'.repeat(22_000) }) }] },
    { role: 'tool', toolCallId: `call-${i}`, content: 'Written.' },
  ]).flat(),
];

test('provider context rejection retries a smaller request without replaying actions or dropping steering',async()=>{
  const h=createHarness([{tool:'answer',text:'Recovered'}],128000);let rejected=false;
  const generate=h.llm.generateCode.bind(h.llm);
  h.llm.generateCode=async request=>{if(!rejected){rejected=true;throw new ProviderCallError('HTTP_ERROR','maximum context length exceeded',{status:400,usage:{inputTokens:0,outputTokens:0}});}assert(request.messages?.some(m=>m.content==='Preserve exact steering'));return generate(request);};
  const run=h.store.createTaskRun({agentId:'worker',taskName:'overflow'});h.store.startTaskRun(run.id,MODEL);
  try{const result=await h.runtime.execute({taskRunId:run.id,contract:CONVERSATION_CONTRACT,request:'Recover',conversation:true,initialMessages:[{role:'user',content:'Original request'},{role:'assistant',content:'old reasoning '.repeat(500)},{role:'user',content:'Preserve exact steering'},{role:'assistant',content:'recent'},{role:'user',content:'observed',observation:true} as any],signal:AbortSignal.timeout(15000)});assert.equal(result.outcome,'COMPLETED',result.report);assert.deepEqual(h.sandbox.calls,[]);assert(h.store.getTaskEvents(run.id).some(e=>e.event_type==='CONTEXT_COMPACTED'&&JSON.parse(e.payload_json).mode==='overflow-recovery'));}finally{h.close();}
});

test('native arguments trigger compaction even when assistant text is empty', async () => {
  const h = createHarness([{ tool: 'answer', text: 'Done' }], 128000);
  try {
    const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
    h.store.startTaskRun(run.id, MODEL);
    const result = await h.runtime.execute({ taskRunId: run.id, contract: CONVERSATION_CONTRACT,
      request: 'Continue', initialMessages: nativeHeavyHistory(), conversation: true, signal: AbortSignal.timeout(15000) });
    assert.equal(result.outcome, 'COMPLETED');
    const summary = h.llm.requests.find(r => r.systemPrompt.includes('execution history summarizer'));
    assert.ok(summary, 'native payload size must trigger compaction');
    assert.ok(summary.userPrompt.includes('src/0.js'), 'summarizer sees arguments, not just tool names');
    assert.ok(h.store.getTaskEvents(run.id).some(e => e.event_type === 'CONTEXT_COMPACTED'));
  } finally { h.close(); }
});

for (const failure of ['dispatched', 'not-sent', 'empty-paid'] as const) {
  test(`compaction billing: ${failure} preserves accurate reservation status`, async () => {
    const h = createHarness([{ tool: 'answer', text: 'Done' }], 128000);
    h.llm.compactionHandler = () => {
      if (failure === 'not-sent') throw new ProviderCallError('CONNECTION_UNAVAILABLE', 'No request sent', { notSent: true });
      if (failure === 'dispatched') throw new Error('Socket closed after request dispatch');
      return { content: '', inputTokens: 120, outputTokens: 30, attemptCount: 1 };
    };
    try {
      const run = h.store.createTaskRun({ agentId: 'worker', taskName: CONVERSATION_CONTRACT.id });
      h.store.startTaskRun(run.id, MODEL);
      const result = await h.runtime.execute({ taskRunId: run.id, contract: CONVERSATION_CONTRACT,
        request: 'Continue', initialMessages: nativeHeavyHistory(), conversation: true, signal: AbortSignal.timeout(15000) });
      assert.equal(result.outcome, 'COMPLETED');
      const reservations = h.store.getDatabase().prepare('SELECT status FROM cost_reservations ORDER BY rowid').all() as Array<{ status: string }>;
      assert.equal(reservations[0].status, failure === 'not-sent' ? 'EXPIRED_UNDISPATCHED' : failure === 'empty-paid' ? 'RECONCILED' : 'UNRECONCILED_ASSUMED_SPENT');
      if (failure === 'empty-paid') assert.equal(result.inputTokens, 270);
    } finally { h.close(); }
  });
}

for (const native of [true, false]) {
  test(`runtime survives recent 24k browser observations after ordinary compaction (${native ? 'native' : 'JSON'} history)`, async () => {
    const h = createHarness([{ tool: 'answer', text: 'Draft remains saved; nothing was submitted.' }], 1_048_576);
    const snapshot = 's'.repeat(24_000);
    const initial: ChatMessage[] = [{ role: 'user', content: 'Inspect the saved draft; do not publish.' }];
    for (let i = 0; i < 4; i++) {
      initial.push(native
        ? { role: 'assistant', content: '', toolCalls: [{ id: `page-${i}`, name: 'browser', arguments: '{"action":"snapshot"}' }] }
        : { role: 'assistant', content: '{"tool":"browser","action":"snapshot"}' });
      const content = JSON.stringify({ tool: 'browser', snapshot, summary: snapshot, outcome: 'observed' });
      initial.push(native ? { role: 'tool', toolCallId: `page-${i}`, content } : { role: 'user', content, observation: true } as ChatMessage);
    }
    initial.push({ role: 'user', content: 'Do not repeat any external submission.' });
    const run = h.store.createTaskRun({ agentId: 'worker', taskName: 'context-fixture' }); h.store.startTaskRun(run.id, MODEL);
    try {
      const result = await h.runtime.execute({ taskRunId: run.id, contract: CONVERSATION_CONTRACT,
        request: 'Continue inspection', conversation: true, initialMessages: initial, signal: AbortSignal.timeout(15000) });
      assert.equal(result.outcome, 'COMPLETED', result.report);
      const request = h.llm.requests.find(r => !r.systemPrompt.includes('execution history summarizer'))!;
      assert.ok(request.messages!.some(m => m.content.includes('do not publish')));
      assert.ok(request.messages!.some(m => m.content === 'Do not repeat any external submission.'));
      assert.ok(contextChars(request.systemPrompt, request.messages!, request.tools) <= 90_000);
      assert.ok(h.store.getTaskEvents(run.id).some(e => e.event_type === 'CONTEXT_COMPACTED' && JSON.parse(e.payload_json!).mode === 'observation-budget'));
      assert.deepEqual(h.sandbox.calls, [], 'context recovery must not execute or replay a tool');
    } finally { h.close(); }
  });
}
