import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ChatService } from '../src/daemon/chat.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import type { ILLMClient, LLMRequest, LLMResponse } from '../src/evals/llm-client.js';

const DAY = 24 * 60 * 60 * 1000;

function makeStore() {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'claude-haiku-4-5', system_prompt: null,
    budget_cap_usd: 10, current_status: 'IDLE' });
  return store;
}

describe('24-hour chat retention', () => {
  it('removes expired messages and cached requests while preserving newer chat and run evidence', () => {
    const store = makeStore();
    try {
      const now = 1_800_000_000_000;
      const first = store.createThread({ agentId: 'alpha', title: 'First' });
      const second = store.createThread({ agentId: 'alpha', title: 'Second' });
      const run = store.createTaskRun({ agentId: 'alpha', taskName: 'chat:retention', modelId: 'claude-haiku-4-5' });
      const oldUser = store.appendMessage({ thread_id: first.id, role: 'user', content: 'Old prompt',
        created_at: now - DAY - 1 });
      store.appendMessage({ thread_id: first.id, role: 'assistant', content: 'Old reply', task_run_id: run.id,
        created_at: now - DAY });
      const freshUser = store.appendMessage({ thread_id: first.id, role: 'user', content: 'Fresh prompt',
        created_at: now - DAY + 1 });
      const protectedUser = store.appendMessage({ thread_id: second.id, role: 'user', content: 'In progress',
        created_at: now - DAY - 5 });
      const db = store.getDatabase();
      const insertRequest = db.prepare(`INSERT INTO chat_requests
        (thread_id, request_id, content, user_message_id, state, result_json) VALUES (?, ?, ?, ?, 'COMPLETED', ?)`);
      insertRequest.run(first.id, 'old', 'Old prompt', oldUser.id!, JSON.stringify({ reply: 'Old reply' }));
      insertRequest.run(first.id, 'fresh', 'Fresh prompt', freshUser.id!, null);
      insertRequest.run(second.id, 'protected', 'In progress', protectedUser.id!, null);

      const firstPass = store.pruneChatHistory(now - DAY, [second.id], now);
      assert.deepEqual(firstPass, { messagesDeleted: 2, requestsDeleted: 1, threadsReset: 0 });
      assert.deepEqual(store.getMessages(first.id).map(m => m.content), ['Fresh prompt']);
      assert.equal(store.getMessages(second.id).length, 1);
      assert.equal((db.prepare('SELECT count(*) n FROM chat_requests').get() as { n: number }).n, 2);
      assert.ok(store.getTaskRun(run.id));

      const secondPass = store.pruneChatHistory(now - DAY, [], now);
      assert.deepEqual(secondPass, { messagesDeleted: 1, requestsDeleted: 1, threadsReset: 1 });
      assert.equal(store.getThread(second.id)?.title, 'New conversation');
      assert.equal(store.getThread(first.id)?.title, 'First');
      assert.equal(store.getMessages(second.id).length, 0);
      assert.equal((db.prepare('SELECT count(*) n FROM chat_requests').get() as { n: number }).n, 1);
      assert.ok(store.getTaskRun(run.id));
    } finally {
      store.close();
    }
  });

  it('waits for an in-flight chat turn before clearing that thread', async () => {
    const store = makeStore();
    const ledger = new CostLedger(':memory:');
    let markStarted!: () => void;
    let releaseReply!: (value: LLMResponse) => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const llm: ILLMClient = {
      generateCode(_request: LLMRequest) {
        markStarted();
        return new Promise<LLMResponse>(resolve => { releaseReply = resolve; });
      },
    };
    const chat = new ChatService({ agentStore: store, ledger, llmClient: llm });
    try {
      const thread = chat.createThread('alpha');
      const pending = chat.send(thread.id, 'Keep this until the reply finishes');
      await started;
      const future = Date.now() + 2 * DAY;
      assert.equal(chat.pruneHistory(future).messagesDeleted, 0);
      assert.equal(store.getMessages(thread.id).length, 1);
      releaseReply({ content: 'Done', inputTokens: 20, outputTokens: 10, attemptCount: 1 });
      await pending;
      await Promise.resolve();
      assert.equal(chat.pruneHistory(future).messagesDeleted, 2);
      assert.equal(store.getThread(thread.id)?.title, 'New conversation');
      assert.equal(store.getMessages(thread.id).length, 0);
    } finally {
      await chat.stop();
      store.close();
      ledger.close();
    }
  });
});
