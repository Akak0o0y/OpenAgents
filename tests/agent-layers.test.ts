/**
 * Regression tests for the ECC agent-architecture-audit findings.
 *
 * Each of these locks a defect the audit found in a specific layer. They are
 * written as controls: the assertion states what the BROKEN behaviour was, so a
 * regression reads as a clear failure rather than a vague diff.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/daemon/agent-loop.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ProviderRouter } from '../src/daemon/provider-router.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import {
  buildConversation,
  type ILLMClient,
  type LLMRequest,
  type LLMResponse,
} from '../src/evals/llm-client.js';

const TEST_MODEL = 'claude-haiku-4-5';
const DOCKER_TIMEOUT = 420_000;

/** Records every request so tests can assert what actually reached the wire. */
class SpyLLMClient implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(private readonly replies: string[], private readonly attemptCount = 1) {}
  async generateCode(req: LLMRequest): Promise<LLMResponse> {
    const { onProviderEvent: _observer, signal: _signal, ...payload } = req;
    this.requests.push(structuredClone(payload));
    const i = Math.min(this.requests.length - 1, this.replies.length - 1);
    return {
      content: this.replies[i] ?? '',
      inputTokens: 100,
      outputTokens: 50,
      attemptCount: this.attemptCount,
    };
  }
}

function harness() {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(':memory:');
  const agent = store.createAgent({
    id: 'agent-alpha',
    name: 'Alpha',
    model_id: TEST_MODEL,
    budget_cap_usd: 10,
    current_status: 'IDLE',
  });
  const taskRun = store.createTaskRun({ agentId: 'agent-alpha', taskName: 'layers-fixture' });
  return { store, ledger, agent, taskRun, close: () => { store.close(); ledger.close(); } };
}

const FILES = {
  'package.json': JSON.stringify({ name: 'layers-fixture', type: 'module' }),
  'test.js': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './src/index.js';",
    "test('add', () => { assert.equal(add(2, 3), 5); });",
  ].join('\n'),
  'src/index.js': 'export function add() { return 0; }',
};

const WRONG = '```javascript:src/index.js\nexport function add() { return 0; }\n```';
const RIGHT = '```javascript:src/index.js\nexport function add(a, b) { return a + b; }\n```';

describe('Layer 2 - session history must actually be transmitted', () => {
  it('sends the full conversation, not just the last message', { timeout: DOCKER_TIMEOUT }, async () => {
    // The defect: messages[] was accumulated and then collapsed to
    // messages[last], so the model never saw its own prior attempts.
    const llm = new SpyLLMClient([WRONG, RIGHT]);
    const h = harness();
    try {
      await new AgentLoop({
        agentStore: h.store,
        ledger: h.ledger,
        providerRouter: new ProviderRouter(),
        llmClient: llm,
      }).executeTask({
        agent: h.agent,
        taskRun: h.taskRun,
        initialFiles: FILES,
        testCommand: 'node --test test.js',
        maxTurns: 3,
        timeoutMs: 120_000,
      });

      assert.ok(llm.requests.length >= 2, 'need at least two turns to test history');
      const second = llm.requests[1];

      assert.ok(Array.isArray(second.messages), 'turn 2 must carry a messages array');
      assert.ok(
        second.messages!.length >= 3,
        `turn 2 must include prior turns (user, assistant, user); got ${second.messages!.length}`
      );
      assert.ok(
        second.messages!.some((m) => m.role === 'assistant'),
        'the model must be shown its OWN previous answer - this is the whole fix'
      );
    } finally {
      h.close();
    }
  });

  it('buildConversation transmits history when present', () => {
    const out = buildConversation({
      modelId: TEST_MODEL,
      systemPrompt: 'sys',
      userPrompt: 'latest',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ],
    });
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'user']);
  });

  it('NEGATIVE CONTROL: with no history it degrades to a single user turn', () => {
    // Stateless callers (trace-runner, goal-producer) genuinely want this.
    const out = buildConversation({ modelId: TEST_MODEL, systemPrompt: 'sys', userPrompt: 'only' });
    assert.deepEqual(out, [{ role: 'user', content: 'only' }]);
  });

  it('drops system entries so the system prompt is never duplicated', () => {
    const out = buildConversation({
      modelId: TEST_MODEL,
      systemPrompt: 'sys',
      userPrompt: 'u',
      messages: [
        { role: 'system', content: 'DUPLICATE' },
        { role: 'user', content: 'u' },
      ],
    });
    assert.equal(out.length, 1);
    assert.ok(!out.some((m) => m.role === 'system'), 'layer-1 bloat: system must not be duplicated');
  });
});

describe('Layer 9 - a fence-less reply must not become source code', () => {
  it('rejects prose instead of writing it to src/index.js', { timeout: DOCKER_TIMEOUT }, async () => {
    // The defect: the entire prose reply was written into src/index.js, so the
    // workspace was corrupted and the test then failed for an unrelated reason.
    const llm = new SpyLLMClient(['Sure! I would start by creating an add function.']);
    const h = harness();
    try {
      await new AgentLoop({
        agentStore: h.store,
        ledger: h.ledger,
        providerRouter: new ProviderRouter(),
        llmClient: llm,
      }).executeTask({
        agent: h.agent,
        taskRun: h.taskRun,
        initialFiles: FILES,
        testCommand: 'node --test test.js',
        maxTurns: 1,
        timeoutMs: 120_000,
      });

      const events = h.store.getTaskEvents(h.taskRun.id);
      assert.ok(
        events.some((e) => e.event_type === 'RESPONSE_FORMAT_REJECTED'),
        'a fence-less reply must be recorded as a format rejection'
      );
      assert.ok(
        !events.some((e) => e.event_type === 'TURN_COMPLETED'),
        'nothing was staged, so no turn verdict should exist'
      );
    } finally {
      h.close();
    }
  });
});

describe('Layer 11 - hidden retries must be visible', () => {
  it('records attemptCount on the turn', { timeout: DOCKER_TIMEOUT }, async () => {
    const llm = new SpyLLMClient([RIGHT]);
    const h = harness();
    try {
      await new AgentLoop({
        agentStore: h.store,
        ledger: h.ledger,
        providerRouter: new ProviderRouter(),
        llmClient: llm,
      }).executeTask({
        agent: h.agent,
        taskRun: h.taskRun,
        initialFiles: FILES,
        testCommand: 'node --test test.js',
        maxTurns: 2,
        timeoutMs: 120_000,
      });

      const turn = h.store.getTaskEvents(h.taskRun.id).find((e) => e.event_type === 'TURN_COMPLETED');
      assert.ok(turn, 'a turn must have completed');
      const payload = JSON.parse(turn!.payload_json);
      assert.equal(typeof payload.attemptCount, 'number',
        'provider retries are invisible unless attemptCount is recorded');
      assert.equal(typeof payload.historyMessages, 'number');
    } finally {
      h.close();
    }
  });
});

describe('Phase A4 - the layer signals that were missing entirely', () => {
  it('records PROMPT_ASSEMBLED (layer 1) and HISTORY_APPENDED (layer 2)', { timeout: DOCKER_TIMEOUT }, async () => {
    const llm = new SpyLLMClient([WRONG, RIGHT]);
    const h = harness();
    try {
      await new AgentLoop({
        agentStore: h.store,
        ledger: h.ledger,
        providerRouter: new ProviderRouter(),
        llmClient: llm,
      }).executeTask({
        agent: h.agent,
        taskRun: h.taskRun,
        initialFiles: FILES,
        testCommand: 'node --test test.js',
        maxTurns: 3,
        timeoutMs: 120_000,
      });

      const events = h.store.getTaskEvents(h.taskRun.id);

      const prompt = events.find((e) => e.event_type === 'PROMPT_ASSEMBLED');
      assert.ok(prompt, 'layer 1 must emit evidence of its own');
      assert.equal(prompt!.layer, 1);
      assert.equal(JSON.parse(prompt!.payload_json).source, 'default');

      const history = events.filter((e) => e.event_type === 'HISTORY_APPENDED');
      assert.ok(history.length >= 2, 'one per dispatched turn');
      assert.equal(history[0].layer, 2);

      // The whole point of layer 2: the transmitted history GROWS across turns.
      const first = JSON.parse(history[0].payload_json);
      const second = JSON.parse(history[1].payload_json);
      assert.equal(first.messageCount, 1);
      assert.ok(
        second.messageCount > first.messageCount,
        `history must grow; turn 1 sent ${first.messageCount}, turn 2 sent ${second.messageCount}`
      );
      assert.ok(second.roles.includes('assistant'), 'turn 2 carries the model own prior answer');
    } finally {
      h.close();
    }
  });

  it('records PROVIDER_RETRY (layer 11) when the client retried', { timeout: DOCKER_TIMEOUT }, async () => {
    const llm = new SpyLLMClient([RIGHT], 3); // client needed 3 attempts
    const h = harness();
    try {
      await new AgentLoop({
        agentStore: h.store,
        ledger: h.ledger,
        providerRouter: new ProviderRouter(),
        llmClient: llm,
      }).executeTask({
        agent: h.agent,
        taskRun: h.taskRun,
        initialFiles: FILES,
        testCommand: 'node --test test.js',
        maxTurns: 2,
        timeoutMs: 120_000,
      });

      const retry = h.store.getTaskEvents(h.taskRun.id).find((e) => e.event_type === 'PROVIDER_RETRY');
      assert.ok(retry, 'silent provider retries must be visible in the audit log');
      assert.equal(retry!.layer, 11);
      const payload = JSON.parse(retry!.payload_json);
      assert.equal(payload.attemptCount, 3);
      assert.equal(payload.retries, 2);
    } finally {
      h.close();
    }
  });

  it('NEGATIVE CONTROL: a first-attempt success emits no PROVIDER_RETRY', { timeout: DOCKER_TIMEOUT }, async () => {
    // Without this, an always-on event would make layer 11 look busy on a run
    // where nothing was retried at all.
    const llm = new SpyLLMClient([RIGHT], 1);
    const h = harness();
    try {
      await new AgentLoop({
        agentStore: h.store,
        ledger: h.ledger,
        providerRouter: new ProviderRouter(),
        llmClient: llm,
      }).executeTask({
        agent: h.agent,
        taskRun: h.taskRun,
        initialFiles: FILES,
        testCommand: 'node --test test.js',
        maxTurns: 2,
        timeoutMs: 120_000,
      });

      assert.ok(
        !h.store.getTaskEvents(h.taskRun.id).some((e) => e.event_type === 'PROVIDER_RETRY'),
        'no retry happened, so no retry may be reported'
      );
    } finally {
      h.close();
    }
  });
});
