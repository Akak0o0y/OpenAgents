import { fixtureFetch as fetch } from './helpers/daemon-client.js';
/**
 * Usage summary.
 *
 * The settings surface reports money. The tests that matter are the ones that
 * stop it reporting money that was never spent, and stop it presenting a
 * subscription this runtime does not have.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { DaemonWsServer } from './helpers/daemon-client.js';
import { usageSummary } from '../src/daemon/usage.js';

describe('usage', () => {
  const port = 4133;
  let store: AgentStore;
  let server: DaemonWsServer;

  before(async () => {
    store = new AgentStore(':memory:');
    store.createAgent({
      id: 'atlas',
      name: 'Atlas',
      model_id: 'test-model',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });
    store.createAgent({
      id: 'idle-bot',
      name: 'Idle',
      model_id: 'test-model',
      budget_cap_usd: 2.5,
      current_status: 'IDLE',
    });

    const done = store.createTaskRun({ agentId: 'atlas', taskName: 'first', modelId: 'test-model' });
    store.startTaskRun(done.id, 'test-model');
    store.updateTaskRunProgress(done.id, 1, 0.125, 0);
    store.finishTaskRun(done.id, 'COMPLETED');

    const failed = store.createTaskRun({ agentId: 'atlas', taskName: 'second', modelId: 'test-model' });
    store.startTaskRun(failed.id, 'test-model');
    store.updateTaskRunProgress(failed.id, 1, 0.005, 0);
    store.finishTaskRun(failed.id, 'FAILED', 'provider error');

    server = new DaemonWsServer(port, () => ({}), {
      getRunEvents: () => [],
      getRunWorkspace: async () => ({ available: false, reason: 'test' }),
      readRunFile: async () => ({ available: false, reason: 'test' }),
      approvals: () => [],
      mcpStatus: () => [],
      usage: () => usageSummary(store.getDatabase()),
    });
    await server.start();
  });

  after(async () => {
    await server.close();
    store.close();
  });

  it('sums reconciled spend per agent and counts failures separately', () => {
    const summary = usageSummary(store.getDatabase());
    const atlas = summary.agents.find((a) => a.agentId === 'atlas')!;
    assert.equal(atlas.spentUsd, 0.13);
    assert.equal(atlas.runCount, 2);
    assert.equal(atlas.failedRunCount, 1);
    assert.equal(atlas.budgetCapUsd, 10);
  });

  it('reports an agent that has never run as zero, not as absent', () => {
    const summary = usageSummary(store.getDatabase());
    const idle = summary.agents.find((a) => a.agentId === 'idle-bot');
    assert.ok(idle, 'an agent with no runs must still appear');
    assert.equal(idle!.spentUsd, 0);
    assert.equal(idle!.runCount, 0);
    assert.equal(idle!.lastRunAt, null);
  });

  it('states plainly that there is no billing relationship', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/usage`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.billing.supported, false);
    assert.match(body.billing.reason, /your own provider credentials/i);
    assert.equal(body.totalBudgetCapUsd, 12.5);
  });

  it('answers 501 when the daemon has no usage implementation', async () => {
    const bare = new DaemonWsServer(port + 1, () => ({}), {
      getRunEvents: () => [],
      getRunWorkspace: async () => ({ available: false, reason: 'test' }),
      readRunFile: async () => ({ available: false, reason: 'test' }),
      approvals: () => [],
      mcpStatus: () => [],
    });
    await bare.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port + 1}/api/usage`);
      assert.equal(res.status, 501);
    } finally {
      await bare.close();
    }
  });
});
