/**
 * The conversational surface.
 *
 * Two properties matter more than the happy path:
 *   - a chat turn lights up the SAME Cortex layers a task does, otherwise this
 *     is a chatbox bolted onto the side of the product rather than part of it
 *   - it is budgeted BEFORE dispatch, so a capped agent is refused rather than
 *     billed and then refused
 *
 * No provider is contacted: the LLM client is a stub.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { ChatError, ChatService } from '../src/daemon/chat.js';
import { layerForEvent } from '../src/kernel/agent-layers.js';
import type { ILLMClient, LLMRequest, LLMResponse } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';

class StubLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(
    private readonly reply = 'Hello from the bot.',
    private readonly attemptCount = 1,
    private readonly failWith?: Error
  ) {}
  async generateCode(req: LLMRequest): Promise<LLMResponse> {
    const { onProviderEvent: _observer, signal: _signal, ...payload } = req;
    this.requests.push(structuredClone(payload));
    if (this.failWith) throw this.failWith;
    return {
      content: this.reply,
      inputTokens: 120,
      outputTokens: 40,
      attemptCount: this.attemptCount,
    };
  }
}

function harness(opts: { budgetUsd?: number; systemPrompt?: string; llm?: StubLLM } = {}) {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(':memory:');
  store.createAgent({
    id: 'alpha',
    name: 'Alpha',
    model_id: MODEL,
    system_prompt: opts.systemPrompt ?? null,
    budget_cap_usd: opts.budgetUsd ?? 10,
    current_status: 'IDLE',
  });
  const llm = opts.llm ?? new StubLLM();
  const chat = new ChatService({ agentStore: store, ledger, llmClient: llm });
  return {
    store,
    ledger,
    chat,
    llm,
    close: () => {
      store.close();
      ledger.close();
    },
  };
}

describe('threads', () => {
  it('creates a thread and names it from the first message', async () => {
    const h = harness();
    try {
      const thread = h.chat.createThread('alpha');
      assert.equal(thread.title, 'New conversation');

      await h.chat.send(thread.id, 'How does the cost ledger handle a crash?');
      assert.match(h.store.getThread(thread.id)!.title, /How does the cost ledger/);
    } finally {
      h.close();
    }
  });

  it('refuses a thread for an agent that does not exist', () => {
    const h = harness();
    try {
      assert.throws(() => h.chat.createThread('ghost'), /No such agent/);
    } finally {
      h.close();
    }
  });

  it('lists newest first, so the sidebar shows current work', async () => {
    const h = harness();
    try {
      const first = h.chat.createThread('alpha', 'older');
      const second = h.chat.createThread('alpha', 'newer');
      await h.chat.send(second.id, 'ping');
      assert.equal(h.chat.listThreads('alpha')[0].id, second.id);
      assert.equal(h.chat.listThreads('alpha').length, 2);
      assert.ok(first);
    } finally {
      h.close();
    }
  });
});

describe('a turn is conversational, not one-shot', () => {
  it('transmits the whole history, so the bot remembers what was said', async () => {
    const h = harness();
    try {
      const thread = h.chat.createThread('alpha');
      await h.chat.send(thread.id, 'My name is Aziz.');
      await h.chat.send(thread.id, 'What is my name?');

      const second = h.llm.requests[1];
      assert.equal(second.messages!.length, 3, 'user, assistant, user');
      assert.ok(second.messages!.some((m) => m.content.includes('My name is Aziz')));
      assert.ok(second.messages!.some((m) => m.role === 'assistant'));
    } finally {
      h.close();
    }
  });

  it('uses the agent system prompt, so bots answer in character', async () => {
    const h = harness({ systemPrompt: 'You are Alpha, a terse database specialist.' });
    try {
      const thread = h.chat.createThread('alpha');
      await h.chat.send(thread.id, 'hi');
      assert.match(h.llm.requests[0].systemPrompt, /terse database specialist/);
    } finally {
      h.close();
    }
  });

  it('persists both sides with usage and cost on the reply', async () => {
    const h = harness();
    try {
      const thread = h.chat.createThread('alpha');
      const res = await h.chat.send(thread.id, 'hello');

      const messages = h.chat.getMessages(thread.id);
      assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
      assert.equal(messages[0].cost_usd, null, 'a user turn costs nothing');
      assert.equal(messages[1].input_tokens, 120);
      assert.equal(messages[1].output_tokens, 40);
      assert.ok((messages[1].cost_usd ?? 0) > 0, 'a reply must carry its real cost');
      assert.equal(messages[1].task_run_id, res.taskRunId, 'a reply is traceable to its run');
    } finally {
      h.close();
    }
  });

  it('refuses an empty message rather than paying for nothing', async () => {
    const h = harness();
    try {
      const thread = h.chat.createThread('alpha');
      await assert.rejects(() => h.chat.send(thread.id, '   '), /empty message/i);
      assert.equal(h.llm.requests.length, 0);
    } finally {
      h.close();
    }
  });
});

describe('a chat turn lights up Cortex', () => {
  it('emits the same layer events a task does', async () => {
    // If chat did not do this, the galaxy would sit dark while you talk to a
    // bot, and the panel would only tell half the story of what the agent does.
    const h = harness();
    try {
      const thread = h.chat.createThread('alpha');
      const res = await h.chat.send(thread.id, 'hello');

      const events = h.store.getTaskEvents(res.taskRunId);
      const byType = new Map(events.map((e) => [e.event_type, e]));

      assert.ok(byType.has('PROMPT_ASSEMBLED'), 'layer 1');
      assert.equal(byType.get('PROMPT_ASSEMBLED')!.layer, 1);

      assert.ok(byType.has('HISTORY_APPENDED'), 'layer 2');
      assert.equal(byType.get('HISTORY_APPENDED')!.layer, 2);

      assert.ok(byType.has('CHAT_REPLY'), 'layer 9 - answer shaping');
      assert.equal(byType.get('CHAT_REPLY')!.layer, 9);
      assert.equal(layerForEvent('CHAT_REPLY'), 9);

      assert.ok(byType.has('TASK_COMPLETED'), 'layer 12 - persistence');
      assert.equal(byType.get('TASK_COMPLETED')!.layer, 12);
    } finally {
      h.close();
    }
  });

  it('records provider retries, which are otherwise invisible', async () => {
    const h = harness({ llm: new StubLLM('hi', 3) });
    try {
      const thread = h.chat.createThread('alpha');
      const res = await h.chat.send(thread.id, 'hello');
      const retry = h.store
        .getTaskEvents(res.taskRunId)
        .find((e) => e.event_type === 'PROVIDER_RETRY');
      assert.ok(retry);
      assert.equal(JSON.parse(retry!.payload_json).attemptCount, 3);
    } finally {
      h.close();
    }
  });

  it('NEGATIVE CONTROL: a single-attempt turn reports no retry', async () => {
    const h = harness();
    try {
      const thread = h.chat.createThread('alpha');
      const res = await h.chat.send(thread.id, 'hello');
      assert.ok(
        !h.store.getTaskEvents(res.taskRunId).some((e) => e.event_type === 'PROVIDER_RETRY'),
        'nothing was retried, so nothing may be reported'
      );
    } finally {
      h.close();
    }
  });
});

describe('chat is budgeted like everything else', () => {
  it('refuses a capped agent BEFORE calling the provider', async () => {
    // Billed-then-refused would be the worst of both: money spent, no answer.
    const h = harness({ budgetUsd: 0.0000001 });
    try {
      const thread = h.chat.createThread('alpha');
      await assert.rejects(
        () => h.chat.send(thread.id, 'hello'),
        (err: Error) => err instanceof ChatError && (err as ChatError).kind === 'BUDGET'
      );
      assert.equal(h.llm.requests.length, 0, 'the provider must never have been called');
    } finally {
      h.close();
    }
  });

  it('keeps the user message when the provider fails, so the conversation survives', async () => {
    const h = harness({ llm: new StubLLM('', 1, new Error('upstream exploded')) });
    try {
      const thread = h.chat.createThread('alpha');
      await assert.rejects(
        () => h.chat.send(thread.id, 'a question worth keeping'),
        /upstream exploded/
      );

      const messages = h.chat.getMessages(thread.id);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'a question worth keeping');
    } finally {
      h.close();
    }
  });

  it('marks the run FAILED when the provider fails, rather than leaving it RUNNING', async () => {
    const h = harness({ llm: new StubLLM('', 1, new Error('upstream exploded')) });
    try {
      const thread = h.chat.createThread('alpha');
      await assert.rejects(() => h.chat.send(thread.id, 'hi'));
      const run = h.store.listTaskRuns().find((r) => r.task_name === `chat:${thread.id}`);
      assert.equal(run?.status, 'FAILED');
    } finally {
      h.close();
    }
  });
});


describe('chat request lifecycle regressions', () => {
  it('replays completed requests without another message or model call, including after service restart', async () => {
    const h = harness();
    try {
      const thread = h.chat.createThread('alpha');
      const [first, duplicate] = await Promise.all([h.chat.send(thread.id, 'ping', 'request-1'), h.chat.send(thread.id, 'ping', 'request-1')]);
      assert.equal(first.reply.id, duplicate.reply.id);
      assert.equal(h.llm.requests.length, 1);
      assert.equal(h.store.getMessages(thread.id).length, 2);
      const restarted = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: h.llm });
      assert.deepEqual(await restarted.send(thread.id, 'ping', 'request-1'), first);
      await assert.rejects(restarted.send(thread.id, 'changed', 'request-1'), /different message/);
      assert.equal(h.llm.requests.length, 1);
    } finally { h.close(); }
  });

  it('a retry after provider failure reuses the persisted user message', async () => {
    class Flaky extends StubLLM {
      first = true;
      override async generateCode(req: LLMRequest): Promise<LLMResponse> {
        if (this.first) { this.first = false; throw new Error('temporary fixture failure'); }
        return super.generateCode(req);
      }
    }
    const h = harness({ llm: new Flaky() });
    try {
      const thread = h.chat.createThread('alpha');
      await assert.rejects(h.chat.send(thread.id, 'ping', 'retry-1'), /fixture failure/);
      const id = h.store.getMessages(thread.id)[0].id;
      const retry = await h.chat.send(thread.id, 'ping', 'retry-1');
      assert.equal(retry.userMessage.id, id);
      assert.deepEqual(h.store.getMessages(thread.id).map(m => m.role), ['user', 'assistant']);
      assert.deepEqual(h.llm.requests[0].messages?.map(m => m.role), ['user']);
    } finally { h.close(); }
  });

  it('concurrent turns see the preceding reply in order', async () => {
    const h = harness();
    try {
      const thread = h.chat.createThread('alpha');
      await Promise.all([h.chat.send(thread.id, 'first'), h.chat.send(thread.id, 'second')]);
      assert.deepEqual(h.llm.requests[1].messages?.map(m => m.role), ['user', 'assistant', 'user']);
      assert.deepEqual(h.store.getMessages(thread.id).map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
    } finally { h.close(); }
  });

  it('paused bots and approval-required bots cannot spend through chat', async () => {
    const h = harness();
    try {
      const thread = h.chat.createThread('alpha');
      h.store.updateAgentStatus('alpha', 'PAUSED');
      await assert.rejects(h.chat.send(thread.id, 'ping'), /paused/);
      h.store.updateAgentStatus('alpha', 'IDLE');
      h.store.getDatabase().prepare('UPDATE agents SET requires_approval = 1 WHERE id = ?').run('alpha');
      await assert.rejects(h.chat.send(thread.id, 'ping'), /approval gate/);
      assert.equal(h.llm.requests.length, 0);
      assert.equal(h.store.listTaskRuns()[0].status, 'FAILED');
    } finally { h.close(); }
  });

  it('operator cancellation aborts chat and shutdown waits for settlement', async () => {
    const h = harness();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const client: ILLMClient = { generateCode: req => new Promise((_resolve, reject) => {
      req.signal!.addEventListener('abort', () => reject(new Error('fixture cancelled')), { once: true }); entered();
    }) };
    const chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: client });
    try {
      const thread = chat.createThread('alpha');
      const pending = chat.send(thread.id, 'wait');
      const refused = assert.rejects(pending, /cancelled/);
      await started;
      assert.equal(chat.abortTask(h.store.listTaskRuns()[0].id), true);
      await refused;
      assert.equal(h.store.listTaskRuns()[0].status, 'ABORTED');
      await chat.stop();
    } finally { h.close(); }
  });
});
