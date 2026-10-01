import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CostLedger, BudgetExceededError } from '../src/kernel/cost-ledger.js';
import { ProviderCallError, type ILLMClient, type LLMRequest, type LLMResponse, type ChatMessage } from '../src/evals/llm-client.js';
import { oneShotCall, type OneShotAccounting, type OneShotUsage } from '../src/daemon/one-shot-call.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';

const TEST_MODEL = 'deepseek/deepseek-chat';

class MockLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  handler?: (req: LLMRequest) => Promise<LLMResponse> | LLMResponse;

  async generateCode(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...req });
    if (this.handler) {
      return await this.handler(req);
    }
    if (req.tools) {
      return {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'answer', arguments: JSON.stringify({ text: 'Done' }) }],
        inputTokens: 100,
        outputTokens: 50,
        attemptCount: 1,
        usageKnown: true,
      };
    }
    return {
      content: 'Mock response content',
      inputTokens: 100,
      outputTokens: 50,
      attemptCount: 1,
      usageKnown: true,
    };
  }
}

test('reserves before dispatch and accounts successful and empty replies once', async () => {
  const ledger = new CostLedger(':memory:');
  const llm = new MockLLM();
  const accountingEntries: OneShotAccounting[] = [];

  // 1. Successful response with content
  llm.handler = req => {
    // Assert tools are undefined
    assert.equal(req.tools, undefined, 'tools must be undefined');
    return {
      content: 'Non-empty reply',
      inputTokens: 120,
      outputTokens: 60,
      attemptCount: 1,
      usageKnown: true,
    };
  };

  const result = await oneShotCall({
    ledger,
    llm,
    taskId: 'task-1',
    agentId: 'agent-1',
    modelId: TEST_MODEL,
    budgetCapUsd: 10,
    estimatedTokens: 2000,
    systemPrompt: 'System prompt',
    userPrompt: 'User prompt',
    purpose: 'character-compose',
    onAccounting: (acc: OneShotAccounting) => accountingEntries.push(acc),
  });

  assert.equal(result.content, 'Non-empty reply');
  assert.equal(result.usage.logicalCalls, 1);
  assert.equal(result.usage.wireAttempts, 1);
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 60);
  assert.equal(result.usage.cachedTokens, null);
  assert.equal(result.usage.usageKnown, true);
  assert.equal(result.usage.priceKnown, true);
  assert.ok(typeof result.usage.costUsd === 'number' && result.usage.costUsd > 0);
  assert.equal(accountingEntries.length, 1);
  assert.equal(accountingEntries[0].status, 'RECONCILED');

  const db = (ledger as any).db as DatabaseSync;
  const row1 = db.prepare('SELECT status, input_tokens, output_tokens FROM cost_reservations WHERE id = ?').get(result.reservationId) as any;
  assert.equal(row1.status, 'RECONCILED');
  assert.equal(row1.input_tokens, 120);
  assert.equal(row1.output_tokens, 60);

  // 2. Empty content response is also accounted for
  llm.handler = () => ({
    content: '   ',
    inputTokens: 90,
    outputTokens: 0,
    attemptCount: 1,
    usageKnown: true,
  });

  const emptyResult = await oneShotCall({
    ledger,
    llm,
    taskId: 'task-1',
    agentId: 'agent-1',
    modelId: TEST_MODEL,
    budgetCapUsd: 10,
    estimatedTokens: 2000,
    systemPrompt: 'System prompt',
    userPrompt: 'User prompt',
    purpose: 'character-review',
    onAccounting: (acc: OneShotAccounting) => accountingEntries.push(acc),
  });

  assert.equal(emptyResult.content, '   ');
  assert.equal(emptyResult.usage.logicalCalls, 1);
  assert.equal(emptyResult.usage.wireAttempts, 1);
  assert.equal(emptyResult.usage.inputTokens, 90);
  assert.equal(emptyResult.usage.outputTokens, 0);
  assert.equal(accountingEntries.length, 2);
  assert.equal(accountingEntries[1].status, 'RECONCILED');

  const row2 = db.prepare('SELECT status, input_tokens, output_tokens FROM cost_reservations WHERE id = ?').get(emptyResult.reservationId) as any;
  assert.equal(row2.status, 'RECONCILED');
  assert.equal(row2.input_tokens, 90);
});

test('known-usage errors reconcile and unsent errors release', async () => {
  const ledger = new CostLedger(':memory:');
  const llm = new MockLLM();
  const accountingEntries: OneShotAccounting[] = [];

  // Known usage error (e.g. HTTP error with reported tokens)
  llm.handler = () => {
    throw new ProviderCallError('HTTP_ERROR', 'Provider failed after generation', {
      status: 500,
      usage: { inputTokens: 75, outputTokens: 25 },
    });
  };

  await assert.rejects(
    async () => {
      await oneShotCall({
        ledger,
        llm,
        taskId: 'task-err',
        agentId: 'agent-1',
        modelId: TEST_MODEL,
        budgetCapUsd: 10,
        estimatedTokens: 1000,
        systemPrompt: 'System',
        userPrompt: 'User',
        purpose: 'character-compose',
        onAccounting: (acc: OneShotAccounting) => accountingEntries.push(acc),
      });
    },
    (err: any) => {
      assert.ok(err instanceof ProviderCallError);
      assert.equal(err.code, 'HTTP_ERROR');
      return true;
    }
  );

  assert.equal(accountingEntries.length, 1);
  assert.equal(accountingEntries[0].status, 'RECONCILED');
  assert.equal(accountingEntries[0].usage.inputTokens, 75);
  assert.equal(accountingEntries[0].usage.outputTokens, 25);
  assert.equal(accountingEntries[0].usage.cachedTokens, null);

  const db = (ledger as any).db as DatabaseSync;
  const row1 = db.prepare('SELECT status, input_tokens FROM cost_reservations WHERE id = ?').get(accountingEntries[0].reservationId) as any;
  assert.equal(row1.status, 'RECONCILED');
  assert.equal(row1.input_tokens, 75);

  // Unsent error (connection unavailable)
  llm.handler = () => {
    throw new ProviderCallError('CONNECTION_UNAVAILABLE', 'Connection unavailable', {
      notSent: true,
    });
  };

  await assert.rejects(
    async () => {
      await oneShotCall({
        ledger,
        llm,
        taskId: 'task-err',
        agentId: 'agent-1',
        modelId: TEST_MODEL,
        budgetCapUsd: 10,
        estimatedTokens: 1000,
        systemPrompt: 'System',
        userPrompt: 'User',
        purpose: 'character-compose',
        onAccounting: (acc: OneShotAccounting) => accountingEntries.push(acc),
      });
    },
    (err: any) => {
      assert.ok(err instanceof ProviderCallError);
      assert.equal(err.code, 'CONNECTION_UNAVAILABLE');
      return true;
    }
  );

  assert.equal(accountingEntries.length, 2);
  assert.equal(accountingEntries[1].status, 'EXPIRED_UNDISPATCHED');
  assert.equal(accountingEntries[1].usage.wireAttempts, 0);
  assert.equal(accountingEntries[1].usage.costUsd, 0);

  const row2 = db.prepare('SELECT status FROM cost_reservations WHERE id = ?').get(accountingEntries[1].reservationId) as any;
  assert.equal(row2.status, 'EXPIRED_UNDISPATCHED');
});

test('unknown dispatched usage stays assumed spent', async () => {
  const ledger = new CostLedger(':memory:');
  const llm = new MockLLM();
  const accountingEntries: OneShotAccounting[] = [];
  const emittedEvents: Array<{ type: string; payload: any }> = [];

  // Generic dispatched error without reported usage
  llm.handler = () => {
    throw new Error('Socket abruptly closed during stream');
  };

  await assert.rejects(
    async () => {
      await oneShotCall({
        ledger,
        llm,
        taskId: 'task-unknown',
        agentId: 'agent-1',
        modelId: TEST_MODEL,
        budgetCapUsd: 10,
        estimatedTokens: 1000,
        systemPrompt: 'System',
        userPrompt: 'User',
        purpose: 'compaction',
        onAccounting: (acc: OneShotAccounting) => accountingEntries.push(acc),
      });
    },
    (err: any) => err.message === 'Socket abruptly closed during stream'
  );

  assert.equal(accountingEntries.length, 1);
  assert.equal(accountingEntries[0].status, 'UNRECONCILED_ASSUMED_SPENT');
  assert.equal(accountingEntries[0].usage.usageKnown, false);
  assert.equal(accountingEntries[0].usage.costUsd, null);

  const db = (ledger as any).db as DatabaseSync;
  const row1 = db.prepare('SELECT status FROM cost_reservations WHERE id = ?').get(accountingEntries[0].reservationId) as any;
  assert.equal(row1.status, 'UNRECONCILED_ASSUMED_SPENT');

  // Response with usageKnown = false
  llm.handler = () => ({
    content: 'Result without token usage numbers',
    inputTokens: 0,
    outputTokens: 0,
    attemptCount: 1,
    usageKnown: false,
  });

  const res = await oneShotCall({
    ledger,
    llm,
    taskId: 'task-unknown',
    agentId: 'agent-1',
    modelId: TEST_MODEL,
    budgetCapUsd: 10,
    estimatedTokens: 1000,
    systemPrompt: 'System',
    userPrompt: 'User',
    purpose: 'compaction',
    emit: (type: string, payload: Record<string, unknown>) => emittedEvents.push({ type, payload }),
    onAccounting: (acc: OneShotAccounting) => accountingEntries.push(acc),
  });

  assert.equal(res.usage.usageKnown, false);
  assert.equal(res.usage.costUsd, null);
  assert.equal(accountingEntries[1].status, 'UNRECONCILED_ASSUMED_SPENT');
  assert.ok(emittedEvents.some(e => e.type === 'PROVIDER_USAGE_UNKNOWN' && e.payload.purpose === 'compaction'));
});

test('cancellation and budget errors remain errors', async () => {
  const ledger = new CostLedger(':memory:');
  const llm = new MockLLM();

  // 1. Pre-aborted signal
  const preAborted = AbortSignal.abort(new Error('Pre-dispatch aborted'));
  await assert.rejects(
    async () => {
      await oneShotCall({
        ledger,
        llm,
        taskId: 'task-cancel',
        agentId: 'agent-1',
        modelId: TEST_MODEL,
        budgetCapUsd: 10,
        estimatedTokens: 1000,
        systemPrompt: 'System',
        userPrompt: 'User',
        purpose: 'character-compose',
        signal: preAborted,
      });
    },
    (err: any) => err.message === 'Pre-dispatch aborted'
  );

  const db = (ledger as any).db as DatabaseSync;
  const count = db.prepare('SELECT COUNT(*) as count FROM cost_reservations').get() as any;
  assert.equal(count.count, 0, 'no reservation created on pre-dispatch abort');

  // 2. Budget exceeded error
  await assert.rejects(
    async () => {
      await oneShotCall({
        ledger,
        llm,
        taskId: 'task-budget',
        agentId: 'agent-broke',
        modelId: TEST_MODEL,
        budgetCapUsd: 0.000001, // extremely tiny budget
        estimatedTokens: 50000,
        systemPrompt: 'System',
        userPrompt: 'User',
        purpose: 'character-compose',
      });
    },
    (err: any) => err instanceof BudgetExceededError
  );
});

test('logical calls and transport attempts are distinct', async () => {
  const ledger = new CostLedger(':memory:');
  const llm = new MockLLM();
  const accountingEntries: OneShotAccounting[] = [];
  const emittedEvents: Array<any> = [];

  // Response with attemptCount = 4
  llm.handler = req => {
    req.onProviderEvent?.({ phase: 'complete', modelId: req.modelId, attempt: 4, elapsedMs: 120 });
    return {
      content: 'Success on 4th attempt',
      inputTokens: 200,
      outputTokens: 80,
      attemptCount: 4,
      usageKnown: true,
    };
  };

  const res = await oneShotCall({
    ledger,
    llm,
    taskId: 'task-distinct',
    agentId: 'agent-1',
    modelId: TEST_MODEL,
    budgetCapUsd: 10,
    estimatedTokens: 1000,
    systemPrompt: 'System',
    userPrompt: 'User',
    purpose: 'preview-compose',
    onProviderEvent: (ev: Record<string, unknown>) => emittedEvents.push(ev),
    onAccounting: (acc: OneShotAccounting) => accountingEntries.push(acc),
  });

  assert.equal(res.usage.logicalCalls, 1, 'logical calls must be 1');
  assert.equal(res.usage.wireAttempts, 4, 'wire attempts must reflect transport retries');
  assert.equal(res.usage.cachedTokens, null);
  assert.ok(emittedEvents.some(e => e.toolMode === 'none' && e.purpose === 'preview-compose'));

  // Error where provider event reported attempt: 2
  llm.handler = req => {
    req.onProviderEvent?.({ phase: 'failed', modelId: req.modelId, attempt: 2, elapsedMs: 80 });
    throw new ProviderCallError('HTTP_ERROR', 'Failed on attempt 2', { status: 502 });
  };

  await assert.rejects(
    async () => {
      await oneShotCall({
        ledger,
        llm,
        taskId: 'task-distinct-err',
        agentId: 'agent-1',
        modelId: TEST_MODEL,
        budgetCapUsd: 10,
        estimatedTokens: 1000,
        systemPrompt: 'System',
        userPrompt: 'User',
        purpose: 'preview-compose',
        onAccounting: (acc: OneShotAccounting) => accountingEntries.push(acc),
      });
    },
    (err: any) => err instanceof ProviderCallError
  );

  assert.equal(accountingEntries[1].usage.logicalCalls, 1);
  assert.equal(accountingEntries[1].usage.wireAttempts, 2);

  // Error without reported attempt: wireAttempts must be null, never manufactured as 4
  llm.handler = () => {
    throw new Error('Internal failure');
  };

  await assert.rejects(
    async () => {
      await oneShotCall({
        ledger,
        llm,
        taskId: 'task-distinct-err2',
        agentId: 'agent-1',
        modelId: TEST_MODEL,
        budgetCapUsd: 10,
        estimatedTokens: 1000,
        systemPrompt: 'System',
        userPrompt: 'User',
        purpose: 'preview-compose',
        onAccounting: (acc: OneShotAccounting) => accountingEntries.push(acc),
      });
    },
    (err: any) => err.message === 'Internal failure'
  );

  assert.equal(accountingEntries[2].usage.logicalCalls, 1);
  assert.equal(accountingEntries[2].usage.wireAttempts, null, 'wireAttempts must be null when unreported');
});

test('compaction wrapper retains existing fallback and event semantics', async () => {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  const artifacts = new ArtifactStore(store);
  const agent = store.createAgent({
    id: 'worker',
    name: 'worker',
    model_id: TEST_MODEL,
    budget_cap_usd: 100,
    current_status: 'IDLE',
  });
  const llm = new MockLLM();

  class DummySandbox {
    calls: string[] = [];
    files = new Map<string, Record<string, string>>();
    async createWorkspaceVolume(id: string) { this.files.set(id, {}); return id; }
    async stageWorkspaceFiles(id: string, files: Record<string, string>) {
      const cur = this.files.get(id) ?? {};
      Object.assign(cur, files);
      this.files.set(id, cur);
    }
    async readWorkspaceFile(id: string, file: string) { return { content: 'test', truncated: false }; }
    async executeTask() { return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false }; }
    async destroyWorkspaceVolume(id: string) { this.files.delete(id); }
  }

  const runtime = new WorkRuntime({
    store,
    ledger,
    artifacts,
    sandbox: new DummySandbox() as any,
    llm,
  });

  const heavyHistory: ChatMessage[] = [
    { role: 'user', content: 'Objective' },
    ...Array.from({ length: 6 }, (_, i): ChatMessage[] => [
      { role: 'assistant', content: '', toolCalls: [{ id: `call-${i}`, name: 'write', arguments: JSON.stringify({ path: `file${i}.txt`, content: 'x'.repeat(15000) }) }] },
      { role: 'tool', toolCallId: `call-${i}`, content: 'Written' },
    ]).flat(),
  ];

  // 1. Compaction with LLM success
  llm.handler = req => {
    if (req.systemPrompt.includes('execution history summarizer')) {
      return {
        content: 'Execution summary: worker processed 6 files.',
        inputTokens: 300,
        outputTokens: 50,
        attemptCount: 1,
        usageKnown: true,
      };
    }
    if (req.tools) {
      return {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'answer', arguments: JSON.stringify({ text: 'Done after compact' }) }],
        inputTokens: 50,
        outputTokens: 20,
        attemptCount: 1,
        usageKnown: true,
      };
    }
    return {
      content: '{"tool":"answer","text":"Done after compact"}',
      inputTokens: 50,
      outputTokens: 20,
      attemptCount: 1,
      usageKnown: true,
    };
  };

  const run1 = store.createTaskRun({ agentId: agent.id, taskName: CONVERSATION_CONTRACT.id });
  store.startTaskRun(run1.id, TEST_MODEL);

  const res1 = await runtime.execute({
    taskRunId: run1.id,
    contract: CONVERSATION_CONTRACT,
    request: 'Start',
    initialMessages: heavyHistory,
    conversation: true,
    signal: AbortSignal.timeout(10000),
  });

  assert.equal(res1.outcome, 'COMPLETED');
  const events1 = store.getTaskEvents(run1.id);
  const compactEvents1 = events1.filter(e => e.event_type === 'CONTEXT_COMPACTED');
  assert.ok(compactEvents1.length >= 1, 'CONTEXT_COMPACTED emitted');
  const p1 = JSON.parse(compactEvents1[0].payload_json);
  assert.equal(p1.mode, 'llm');

  // 2. Compaction with LLM error falls back to deterministic
  llm.handler = req => {
    if (req.systemPrompt.includes('execution history summarizer')) {
      throw new Error('LLM summarizer failed');
    }
    if (req.tools) {
      return {
        content: '',
        toolCalls: [{ id: 'call-2', name: 'answer', arguments: JSON.stringify({ text: 'Done after fallback' }) }],
        inputTokens: 50,
        outputTokens: 20,
        attemptCount: 1,
        usageKnown: true,
      };
    }
    return {
      content: '{"tool":"answer","text":"Done after fallback"}',
      inputTokens: 50,
      outputTokens: 20,
      attemptCount: 1,
      usageKnown: true,
    };
  };

  const run2 = store.createTaskRun({ agentId: agent.id, taskName: CONVERSATION_CONTRACT.id });
  store.startTaskRun(run2.id, TEST_MODEL);

  const res2 = await runtime.execute({
    taskRunId: run2.id,
    contract: CONVERSATION_CONTRACT,
    request: 'Start again',
    initialMessages: heavyHistory,
    conversation: true,
    signal: AbortSignal.timeout(10000),
  });

  assert.equal(res2.outcome, 'COMPLETED');
  const events2 = store.getTaskEvents(run2.id);
  const compactEvents2 = events2.filter(e => e.event_type === 'CONTEXT_COMPACTED');
  assert.ok(compactEvents2.length >= 1);
  const p2 = JSON.parse(compactEvents2[0].payload_json);
  assert.equal(p2.mode, 'deterministic');
});
