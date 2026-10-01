import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentStore } from '../src/daemon/agent-store.js';
import { BacklogWorkProducer, PlaceholderWorkProducer } from '../src/daemon/work-producer.js';
import { startDaemon } from '../src/daemon/index.js';
import { MockLLMClient } from '../src/evals/llm-client.js';

function freshStore(): AgentStore {
  const store = new AgentStore(':memory:');
  store.createAgent({
    id: 'agent-alpha',
    name: 'Alpha',
    model_id: 'anthropic/claude-haiku-4.5',
    budget_cap_usd: 10,
    current_status: 'IDLE',
  });
  return store;
}

describe('BacklogWorkProducer', () => {
  it('enqueues up to maxQueueDepth and refuses to exceed it', async () => {
    const store = freshStore();
    const p = new BacklogWorkProducer({
      backlog: [
        { agentId: 'agent-alpha', taskName: 'a' },
        { agentId: 'agent-alpha', taskName: 'b' },
        { agentId: 'agent-alpha', taskName: 'c' },
      ],
      maxQueueDepth: 2,
    });
    await p.start();

    assert.equal(await p.produceNextTasks(store), 2, 'first pass fills the queue to depth');
    assert.equal(store.listTaskRuns().length, 2);
    assert.equal(await p.produceNextTasks(store), 0, 'queue is full - must produce nothing further');
    assert.equal(store.listTaskRuns().length, 2);
    store.close();
  });

  it('produces nothing before start() is called', async () => {
    const store = freshStore();
    const p = new BacklogWorkProducer({ backlog: [{ agentId: 'agent-alpha', taskName: 'a' }] });
    assert.equal(await p.produceNextTasks(store), 0, 'an unstarted producer must stay inert');
    store.close();
  });

  it('cycle mode wraps the backlog indefinitely', async () => {
    const store = freshStore();
    const p = new BacklogWorkProducer({
      backlog: [{ agentId: 'agent-alpha', taskName: 'a' }, { agentId: 'agent-alpha', taskName: 'b' }],
      mode: 'cycle',
      maxQueueDepth: 1,
    });
    await p.start();

    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      await p.produceNextTasks(store);
      const run = store.listTaskRuns().find((r) => r.status === 'QUEUED');
      assert.ok(run, `cycle ${i} must have produced a task`);
      names.push(run.task_name);
      store.startTaskRun(run.id);
      store.finishTaskRun(run.id, 'COMPLETED');
    }
    assert.deepEqual(names, ['a', 'b', 'a', 'b', 'a'], 'cycle mode must wrap, not stop at the end');
    assert.equal(p.isDrained, false);
    store.close();
  });

  it('once mode drains exactly once and then stops permanently', async () => {
    const store = freshStore();
    const p = new BacklogWorkProducer({
      backlog: [{ agentId: 'agent-alpha', taskName: 'a' }, { agentId: 'agent-alpha', taskName: 'b' }],
      mode: 'once',
      maxQueueDepth: 1,
    });
    await p.start();

    let produced = 0;
    for (let i = 0; i < 5; i++) {
      produced += await p.produceNextTasks(store);
      const run = store.listTaskRuns().find((r) => r.status === 'QUEUED');
      if (run) {
        store.startTaskRun(run.id);
        store.finishTaskRun(run.id, 'COMPLETED');
      }
    }
    assert.equal(produced, 2, 'once mode must emit each backlog entry exactly once');
    assert.equal(p.isDrained, true);
    store.close();
  });

  it('skips PAUSED and DISABLED agents rather than queueing unrunnable work', async () => {
    const store = freshStore();
    store.updateAgentStatus('agent-alpha', 'PAUSED');
    const p = new BacklogWorkProducer({
      backlog: [{ agentId: 'agent-alpha', taskName: 'a' }],
      maxQueueDepth: 5,
    });
    await p.start();

    assert.equal(await p.produceNextTasks(store), 0, 'a paused agent must receive no work');
    assert.equal(store.listTaskRuns().length, 0);

    store.updateAgentStatus('agent-alpha', 'IDLE');
    assert.equal(await p.produceNextTasks(store), 1, 'work must resume once the agent is IDLE');
    store.close();
  });

  it('fails LOUDLY when the backlog names a task the scheduler cannot run', () => {
    assert.throws(
      () => new BacklogWorkProducer({
        backlog: [{ agentId: 'agent-alpha', taskName: 'no-such-task' }],
        knownTaskNames: ['cli-arg-parser'],
      }),
      /does not know: no-such-task/,
      'unknown task names must throw at construction, not silently enqueue FAILED rows'
    );
  });
});

describe('Work producer integration: the daemon generates its own work', () => {
  const dbFor = (n: string) => path.join(process.cwd(), `temp-wp-${n}.db`);
  const wipe = (p: string) => {
    for (const ext of ['', '-wal', '-shm']) {
      const f = `${p}${ext}`;
      if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch { /* busy */ } }
    }
  };

  it('runs a task with NOTHING enqueued by the test', async () => {
    const dbPath = dbFor('backlog');
    wipe(dbPath);

    const daemon = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
      dbPath,
      wsPort: 4040,
      cadenceMs: 100,
      maxConcurrency: 1,
      llmClient: new MockLLMClient(),
      workProducer: new BacklogWorkProducer({
        backlog: [{ agentId: 'agent-alpha', taskName: 'cli-arg-parser' }],
        mode: 'cycle',
        maxQueueDepth: 1,
      }),
    });

    try {
      const deadline = Date.now() + 90_000;
      let sawRun = false;
      while (Date.now() < deadline) {
        if (daemon.store.listTaskRuns().length > 0) { sawRun = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(sawRun, 'The daemon must create its own task runs with no operator involvement');

      const run = daemon.store.listTaskRuns()[0];
      assert.equal(run.task_name, 'cli-arg-parser');
      assert.equal(run.agent_id, 'agent-alpha');
    } finally {
      await daemon.shutdown();
      wipe(dbPath);
    }
  });

  it('NEGATIVE CONTROL: with the placeholder producer the daemon stays idle forever', async () => {
    const dbPath = dbFor('placeholder');
    wipe(dbPath);

    const daemon = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
      dbPath,
      wsPort: 4041,
      cadenceMs: 100,
      maxConcurrency: 1,
      llmClient: new MockLLMClient(),
      workProducer: new PlaceholderWorkProducer(),
    });

    try {
      await new Promise((r) => setTimeout(r, 3000)); // ~30 scheduler ticks
      assert.equal(daemon.store.listTaskRuns().length, 0,
        'Without a real producer the daemon must never invent work - proves the backlog test is not passing by accident');
    } finally {
      await daemon.shutdown();
      wipe(dbPath);
    }
  });
});
