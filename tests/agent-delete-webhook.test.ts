import { fixtureFetch as fetch } from './helpers/daemon-client.js';
/**
 * Deleting a bot, and firing a routine from a webhook.
 *
 * Both are destructive or externally reachable, so the tests are weighted
 * towards the refusals: a delete that orphans a running container, and a
 * webhook that fires something it should not.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { DaemonWsServer, type WsCommand } from './helpers/daemon-client.js';
import { initDaemonSchema } from '../src/daemon/db/schema.js';

describe('deleteAgent', () => {
  let store: AgentStore;

  beforeEach(() => {
    store = new AgentStore(':memory:');
    store.createAgent({
      id: 'atlas',
      name: 'Atlas',
      model_id: 'test-model',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });
  });

  it('reports nothing deleted for a bot that does not exist', () => {
    const result = store.deleteAgent('ghost');
    assert.equal(result.deleted, false);
  });

  it('retains a desktop retirement record and gives a recreated ID a new identity', () => {
    const first = store.desktopIdentity('atlas');
    assert.equal(store.deleteAgent('atlas').deleted, true);
    assert.throws(() => store.desktopIdentity('atlas'), /does not exist/);
    store.createAgent({ id: 'atlas', name: 'Recreated', model_id: 'test-model', budget_cap_usd: 10, current_status: 'IDLE' });
    assert.notEqual(store.desktopIdentity('atlas'), first);
    assert.equal(store.getDatabase().prepare('SELECT identity_key FROM retired_desktops WHERE agent_id = ?').get('atlas')?.identity_key, first);
    assert.equal(store.listAgentData('atlas').length, 0);
  });

  it('migrates legacy bots without changing their desktop and retains new identities across schema restarts', () => {
    const db = store.getDatabase();
    db.exec('ALTER TABLE agents DROP COLUMN desktop_key');
    initDaemonSchema(db);
    assert.equal(store.desktopIdentity('atlas'), 'atlas');
    store.deleteAgent('atlas');
    store.createAgent({ id: 'atlas', name: 'New', model_id: 'test', budget_cap_usd: 1, current_status: 'IDLE' });
    const next = store.desktopIdentity('atlas');
    assert.notEqual(next, 'atlas');
    initDaemonSchema(db);
    assert.equal(store.desktopIdentity('atlas'), next);
  });

  it('removes the bot and everything that belonged to it', () => {
    const thread = store.createThread({ agentId: 'atlas', title: 'chat' });
    store.appendMessage({ thread_id: thread.id, role: 'user', content: 'hello' });
    const run = store.createTaskRun({ agentId: 'atlas', taskName: 't', modelId: 'test-model' });
    store.startTaskRun(run.id, 'test-model');
    store.finishTaskRun(run.id, 'COMPLETED');
    store.recordEvent({
      task_run_id: run.id,
      agent_id: 'atlas',
      event_type: 'TASK_COMPLETED',
      payload_json: '{}',
      timestamp: Date.now(),
    });
    store.createApproval({ taskRunId: run.id, agentId: 'atlas', kind: 'question', payload: {} });
    store.setAgentData({ agentId: 'atlas', key: 'bot-profile', category: 'ui', data: { label: 'x' } });
    store.createRoutine({
      agentId: 'atlas',
      name: 'r',
      cronExpression: '0 8 * * *',
      timezone: 'UTC',
      promptTemplate: 'do it',
      nextRunAt: Date.now() + 1000,
    });

    const summary = store.deleteAgent('atlas');
    assert.equal(summary.deleted, true);
    assert.equal(summary.threads, 1);
    assert.equal(summary.messages, 1);
    assert.equal(summary.taskRuns, 1);
    assert.equal(summary.routines, 1);
    assert.equal(summary.approvals, 1);
    assert.equal(summary.data, 1);
    assert.ok(summary.events >= 1);

    assert.equal(store.getAgent('atlas'), null);
    assert.equal(store.listThreads('atlas').length, 0);
    assert.equal(store.listRoutines('atlas').length, 0);
    assert.equal(store.listTaskRuns('atlas').length, 0);
    assert.equal(store.listAgentData('atlas').length, 0);
  });

  it('REFUSES while a run is QUEUED, naming the reason', () => {
    store.createTaskRun({ agentId: 'atlas', taskName: 't', modelId: 'test-model' });
    assert.throws(() => store.deleteAgent('atlas'), /QUEUED or RUNNING/);
    assert.ok(store.getAgent('atlas'), 'the bot must survive a refused delete');
  });

  it('REFUSES while a run is RUNNING', () => {
    const run = store.createTaskRun({ agentId: 'atlas', taskName: 't', modelId: 'test-model' });
    store.startTaskRun(run.id, 'test-model');
    assert.throws(() => store.deleteAgent('atlas'), /QUEUED or RUNNING/);
  });

  it('allows the delete once the run has finished', () => {
    const run = store.createTaskRun({ agentId: 'atlas', taskName: 't', modelId: 'test-model' });
    store.startTaskRun(run.id, 'test-model');
    store.finishTaskRun(run.id, 'FAILED');
    assert.equal(store.deleteAgent('atlas').deleted, true);
  });

  it('leaves other bots untouched', () => {
    store.createAgent({
      id: 'ledger',
      name: 'Ledger',
      model_id: 'test-model',
      budget_cap_usd: 5,
      current_status: 'IDLE',
    });
    store.createThread({ agentId: 'ledger', title: 'keep me' });
    store.deleteAgent('atlas');
    assert.ok(store.getAgent('ledger'));
    assert.equal(store.listThreads('ledger').length, 1);
  });
});

describe('routine webhook tokens', () => {
  let store: AgentStore;

  beforeEach(() => {
    store = new AgentStore(':memory:');
    store.createAgent({
      id: 'atlas',
      name: 'Atlas',
      model_id: 'test-model',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });
  });

  function makeRoutine() {
    return store.createRoutine({
      agentId: 'atlas',
      name: 'Nightly',
      cronExpression: '0 8 * * *',
      timezone: 'UTC',
      promptTemplate: 'run it',
      nextRunAt: Date.now() + 1000,
    });
  }

  it('has no token until one is issued', () => {
    const routine = makeRoutine();
    assert.equal(routine.webhook_token ?? null, null);
  });

  it('resolves a routine by its issued token', () => {
    const routine = makeRoutine();
    store.setRoutineWebhookToken(routine.id, 'tok-abc');
    assert.equal(store.getRoutineByWebhookToken('tok-abc')?.id, routine.id);
  });

  it('does not match an empty token against a routine without one', () => {
    makeRoutine();
    assert.equal(store.getRoutineByWebhookToken(''), null);
    assert.equal(store.getRoutineByWebhookToken('anything'), null);
  });

  it('revokes the previous token when a new one is issued', () => {
    const routine = makeRoutine();
    store.setRoutineWebhookToken(routine.id, 'first');
    store.setRoutineWebhookToken(routine.id, 'second');
    assert.equal(store.getRoutineByWebhookToken('first'), null);
    assert.equal(store.getRoutineByWebhookToken('second')?.id, routine.id);
  });

  it('clears the token when webhooks are turned off', () => {
    const routine = makeRoutine();
    store.setRoutineWebhookToken(routine.id, 'gone-soon');
    store.setRoutineWebhookToken(routine.id, null);
    assert.equal(store.getRoutineByWebhookToken('gone-soon'), null);
  });

  it('refuses to issue a token for a routine that does not exist', () => {
    assert.throws(() => store.setRoutineWebhookToken('nope', 'x'), /does not exist/);
  });
});

describe('HTTP: DELETE /api/agents/:id and the webhook route', () => {
  const port = 4131;
  let store: AgentStore;
  let server: DaemonWsServer;
  let fired: string[] = [];

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
      id: 'busy',
      name: 'Busy',
      model_id: 'test-model',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });
    store.createTaskRun({ agentId: 'busy', taskName: 't', modelId: 'test-model' });

    // Deliberately NOT atlas: the delete test below removes that bot and
    // cascades its routines away, which would take the webhook with it.
    store.createAgent({
      id: 'hooked',
      name: 'Hooked',
      model_id: 'test-model',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });
    const routine = store.createRoutine({
      agentId: 'hooked',
      name: 'Nightly',
      cronExpression: '0 8 * * *',
      timezone: 'UTC',
      promptTemplate: 'run it',
      nextRunAt: Date.now() + 1000,
    });
    store.setRoutineWebhookToken(routine.id, 'good-token');

    server = new DaemonWsServer(port, () => ({ agents: store.listAgents() }));
    server.setAgentApi({
      create: (input) => input,
      update: (id) => ({ id }),
      remove: (id) => store.deleteAgent(id),
    });
    server.setWebhookApi({
      resolve: (token) => {
        const found = store.getRoutineByWebhookToken(token);
        return found ? { routineId: found.id, agentId: found.agent_id, name: found.name } : null;
      },
      fire: async (routineId) => {
        fired.push(routineId);
        return { taskRunId: `run-for-${routineId}` };
      },
    });
    server.onCommand(async (_cmd: WsCommand) => ({ success: false, error: 'unused' }));
    await server.start();
  });

  after(async () => {
    await server.close();
    store.close();
  });

  it('deletes a bot and reports what went with it', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/atlas`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.deleted, true);
    assert.equal(store.getAgent('atlas'), null);
  });

  it('answers 404 for a bot that does not exist', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/ghost`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  it('answers 409, not 500, when work is still in flight', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/busy`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    const body: any = await res.json();
    assert.match(body.error, /QUEUED or RUNNING/);
    assert.ok(store.getAgent('busy'));
  });

  it('fires a routine for a valid token', async () => {
    fired = [];
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/routines/good-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'a test' }),
    });
    assert.equal(res.status, 202);
    const body: any = await res.json();
    assert.equal(body.accepted, true);
    assert.equal(fired.length, 1);
  });

  it('answers 404 for an unknown token, and fires nothing', async () => {
    fired = [];
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/routines/wrong-token`, {
      method: 'POST',
    });
    assert.equal(res.status, 404);
    assert.equal(fired.length, 0);
  });

  it('REFUSES GET, so a crawler cannot run somebody routine', async () => {
    fired = [];
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/routines/good-token`);
    assert.equal(res.status, 405);
    assert.equal(fired.length, 0);
  });
});
