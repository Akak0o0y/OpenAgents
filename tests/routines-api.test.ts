import { fixtureFetch as fetch } from './helpers/daemon-client.js';
/**
 * Routines and Agent Data API & WebSocket tests.
 *
 * Exercises:
 * - HTTP GET /api/routines, GET /api/routines/:id/runs
 * - HTTP GET /api/data, POST /api/data, DELETE /api/data/:id
 * - WebSocket commands: create_routine, update_routine, run_routine_now, delete_routine
 */

import { describe, it, before, after } from 'node:test';
import { once } from 'node:events';
import { startDaemon } from '../src/daemon/index.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { MockLLMClient } from '../src/evals/llm-client.js';
import { registerFixtureServer } from './helpers/daemon-client.js';
import assert from 'node:assert/strict';
import { FixtureWebSocket as WebSocket } from './helpers/daemon-client.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { DaemonWsServer, type WsCommand } from './helpers/daemon-client.js';
import { computeNextRun, parseSchedule } from '../src/daemon/cron.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RoutineRecord } from '../src/daemon/db/schema.js';
import type { WorkResult } from '../src/daemon/work-runtime.js';
import { saveWorkResult } from '../src/daemon/work-results.js';
import { enqueueRoutine } from '../src/daemon/routine-dispatch.js';
import { ROUTINE_ASK_TASK } from '../src/daemon/work-contract.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';

describe('real daemon routine webhook commands', () => {
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  let ws: WebSocket;
  before(async () => {
    const sandbox = new DockerSandbox();
    sandbox.orphanSweep = async () => ({ reapedContainers: 0, reapedVolumes: 0 });
    daemon = await startDaemon({ configPath: null, dbPath: ':memory:', wsPort: 0, docker: false, sandbox,
      llmClient: new MockLLMClient(), workProducer: { start: async () => {}, stop: async () => {}, produceNextTasks: async () => 0 } });
    await daemon.scheduler.stop();
    registerFixtureServer(daemon.wsServer.boundPort, daemon.wsServer);
    ws = new WebSocket(`ws://127.0.0.1:${daemon.wsServer.boundPort}`);
    await once(ws, 'open');
  });
  after(async () => { ws?.close(); await daemon?.shutdown(); });
  function command(command: string, targetId: string, payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('Command deadline')); }, 3000);
      const listener = (data: import('ws').RawData) => {
        const event = JSON.parse(data.toString());
        if (event.type !== 'COMMAND_RESULT' || event.result.command !== command) return;
        clearTimeout(timer); ws.off('message', listener); resolve(event.result);
      };
      ws.on('message', listener);
      ws.send(JSON.stringify({ command, targetId, payload }));
    });
  }
  function routine() {
    const created = daemon.store.createRoutine({ agentId: 'agent-alpha', name: 'Atomic', cronExpression: '0 9 * * *', timezone: 'UTC', promptTemplate: 'Say hello', taskName: 'routine:ask', nextRunAt: Date.now() + 86_400_000, enabled: false });
    return daemon.store.setRoutineWebhookToken(created.id, `fixture-${created.id}`);
  }

  it('persists webhook-only intent without disabling webhook or manual runs', async () => {
    const created = await command('create_routine', 'agent-alpha', { agentId: 'agent-alpha', name: 'Webhook only', schedule: '0 0 * * *', scheduleEnabled: false, timezone: 'UTC', prompt: 'Say hello', taskName: 'routine:ask', webhookEnabled: true });
    assert.equal(created.success, true);
    const { id, webhook_token: token } = created.data;
    assert.equal(created.data.schedule_enabled, 0);
    assert.equal(daemon.store.getDueRoutines(Date.UTC(2040, 0, 1)).some(r => r.id === id), false);
    const saved = await command('update_routine', id, { name: 'Still webhook only' });
    assert.equal(saved.data.schedule_enabled, 0, 'omitted flag preserves intent');
    const fired = await fetch(`http://127.0.0.1:${daemon.wsServer.boundPort}/api/webhooks/routines/${token}`, { method: 'POST' });
    assert.equal(fired.status, 202);
    assert.equal((await command('run_routine_now', id, {})).success, true);
    assert.equal((await command('update_routine', id, { scheduleEnabled: true })).data.schedule_enabled, 1);
    assert.equal((await command('update_routine', id, { scheduleEnabled: false })).data.schedule_enabled, 0);
    assert.equal((await command('update_routine', id, { scheduleEnabled: 'false' })).success, false);
  });

  it('creates a functioning webhook from command intent and revokes its URL', async () => {
    const created = await command('create_routine', 'agent-alpha', { agentId: 'agent-alpha', name: 'Created hook', schedule: '0 9 * * *', timezone: 'UTC', prompt: 'Say hello', taskName: 'routine:ask', enabled: false, webhookEnabled: true });
    assert.equal(created.success, true);
    const { id, webhook_token: token } = created.data;
    assert.ok(token, 'creation must issue the requested token');
    assert.equal(daemon.store.getRoutineByWebhookToken(token)?.id, id);
    assert.equal((await command('update_routine', id, { enabled: true })).success, true);
    const url = `http://127.0.0.1:${daemon.wsServer.boundPort}/api/webhooks/routines/${token}`;
    const fired = await fetch(url, { method: 'POST' });
    assert.equal(fired.status, 202);
    assert.equal(daemon.store.listRoutineRuns(id).length, 1);
    assert.equal((await command('update_routine', id, { webhookEnabled: false })).success, true);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
  });

  it('invalid updates preserve every field and the previous token', async () => {
    const original = routine();
    for (const payload of [{ schedule: 'invalid', webhookEnabled: false }, { timezone: 'Not/AZone', rotateWebhook: true }]) {
      const result = await command('update_routine', original.id, { name: 'Should not persist', ...payload });
      assert.equal(result.success, false);
      assert.deepEqual(daemon.store.getRoutine(original.id), original);
    }
  });

  it('ordinary saves retain the token; explicit rotation changes it', async () => {
    const original = routine();
    const saved = await command('update_routine', original.id, { name: 'Renamed', webhookEnabled: true });
    assert.equal(saved.success, true);
    assert.equal(saved.data.webhook_token, original.webhook_token);
    const rotated = await command('update_routine', original.id, { rotateWebhook: true });
    assert.equal(rotated.success, true);
    assert.notEqual(rotated.data.webhook_token, original.webhook_token);
    assert.equal(daemon.store.getRoutineByWebhookToken(original.webhook_token!), null);
  });

  it('token storage failure rolls back field updates and creation', async () => {
    const original = routine();
    const originalSetter = daemon.store.setRoutineWebhookToken;
    const count = daemon.store.listRoutines().length;
    daemon.store.setRoutineWebhookToken = () => { throw new Error('Fixture token write failure'); };
    try {
      assert.equal((await command('update_routine', original.id, { name: 'Rollback', rotateWebhook: true })).success, false);
      assert.deepEqual(daemon.store.getRoutine(original.id), original);
      assert.equal((await command('create_routine', 'agent-alpha', { agentId: 'agent-alpha', name: 'Rollback', schedule: '0 9 * * *', prompt: 'Say hello', taskName: 'routine:ask', webhookEnabled: true })).success, false);
      assert.equal(daemon.store.listRoutines().length, count);
    } finally { daemon.store.setRoutineWebhookToken = originalSetter; }
  });
});

describe('Routines and Agent Data API & WS', () => {
  const port = 4120;
  let store: AgentStore;
  let server: DaemonWsServer;

  before(async () => {
    store = new AgentStore(':memory:');
    store.createAgent({
      id: 'alpha',
      name: 'Alpha Worker',
      model_id: 'test-model',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });

    server = new DaemonWsServer(
      port,
      () => ({
        agents: store.listAgents(),
        taskRuns: store.listTaskRuns(),
        routines: store.listRoutines(),
        executor: 'builtin',
      }),
      {
        getRunEvents: (id) => store.getTaskEvents(id),
        getRunWorkspace: async () => ({ available: false, reason: 'test' }),
        readRunFile: async () => ({ available: false, reason: 'test' }),
        approvals: () => [],
        mcpStatus: () => [],
        routines: (agentId) => store.listRoutines(agentId),
        routine: (id) => store.getRoutine(id),
        routineRuns: (routineId) => store.listRoutineRuns(routineId),
        agentData: (agentId, category) => store.listAgentData(agentId, category),
        getAgentDataRecord: (agentId, key, category) => store.getAgentData(agentId, key, category),
        setAgentDataRecord: (params) => store.setAgentData(params),
        deleteAgentDataRecord: (id) => store.deleteAgentData(id),
      }
    );

    server.onCommand(async (cmd: WsCommand) => {
      if (cmd.command === 'create_routine') {
        const { agentId, name, schedule, timezone, prompt, taskName, enabled, catchUpPolicy } = cmd.payload ?? {};
        const parsed = parseSchedule(schedule);
        const tz = timezone ?? 'UTC';
        const nextRunAt = computeNextRun(parsed.cron, Date.now(), tz);
        const routine = store.createRoutine({
          agentId,
          name,
          cronExpression: parsed.cron,
          humanSchedule: parsed.human,
          timezone: tz,
          promptTemplate: prompt,
          taskName: taskName ?? null,
          enabled: enabled !== false,
          catchUpPolicy: catchUpPolicy ?? 'skip',
          nextRunAt,
        });
        return { success: true, message: `Routine "${routine.id}" created.`, data: routine } as any;
      }
      if (cmd.command === 'run_routine_now') {
        const routine = store.getRoutine(cmd.targetId);
        if (!routine) return { success: false, error: 'Not found' };
        const run = store.createTaskRun({
          agentId: routine.agent_id,
          taskName: routine.task_name ?? `routine-${routine.id}`,
          modelId: 'test-model',
          routineId: routine.id,
        });
        store.recordRoutineRun(routine.id, run.id, 'QUEUED', routine.next_run_at);
        return { success: true, message: 'Run queued', data: { runId: run.id } } as any;
      }
      if (cmd.command === 'delete_routine') {
        const deleted = store.deleteRoutine(cmd.targetId);
        return { success: deleted, message: 'Deleted' };
      }
      return { success: false, error: 'Unsupported' };
    });

    await server.start();
  });

  after(async () => {
    await server.close();
    store.close();
  });

  it('HTTP /api/data handles GET, POST and DELETE', async () => {
    // 1. POST /api/data
    const postRes = await fetch(`http://127.0.0.1:${port}/api/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'alpha',
        key: 'daily-metrics',
        category: 'metric',
        data: { activeUsers: 42 },
      }),
    });
    assert.equal(postRes.status, 200);
    const postBody: any = await postRes.json();
    assert.ok(postBody.record.id);

    // 2. GET /api/data
    const getRes = await fetch(`http://127.0.0.1:${port}/api/data?agent=alpha&category=metric`);
    assert.equal(getRes.status, 200);
    const getBody: any = await getRes.json();
    assert.equal(getBody.data.length, 1);
    assert.deepEqual(JSON.parse(getBody.data[0].data_json), { activeUsers: 42 });

    // 3. DELETE /api/data/:id
    const delRes = await fetch(`http://127.0.0.1:${port}/api/data/${postBody.record.id}`, {
      method: 'DELETE',
    });
    assert.equal(delRes.status, 200);
    const delBody: any = await delRes.json();
    assert.equal(delBody.success, true);

    // Verify empty
    const checkRes = await fetch(`http://127.0.0.1:${port}/api/data?agent=alpha&category=metric`);
    const checkBody: any = await checkRes.json();
    assert.equal(checkBody.data.length, 0);
  });

  it('WS commands manage routines lifecycle', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => ws.on('open', resolve));

    const sendCmd = (cmd: string, targetId: string, payload?: any): Promise<any> => {
      return new Promise((resolve, reject) => {
        const handler = (data: import('ws').RawData) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'COMMAND_RESULT' && msg.result.command === cmd) {
            ws.off('message', handler);
            resolve(msg.result);
          }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ command: cmd, targetId, payload }));
      });
    };

    // 1. Create routine
    const createRes = await sendCmd('create_routine', 'new', {
      agentId: 'alpha',
      name: 'Nightly Sync',
      schedule: 'every day at 9 am',
      prompt: 'Perform sync sweep',
    });
    assert.equal(createRes.success, true);
    const routineId = createRes.data.id;
    assert.ok(routineId);

    // 2. Query routines via HTTP GET
    const listRes = await fetch(`http://127.0.0.1:${port}/api/routines`);
    const listBody: any = await listRes.json();
    assert.equal(listBody.routines.length, 1);
    assert.equal(listBody.routines[0].id, routineId);

    // 3. Trigger run_routine_now
    const runRes = await sendCmd('run_routine_now', routineId);
    assert.equal(runRes.success, true);

    // 4. Query routine runs via HTTP
    const runsRes = await fetch(`http://127.0.0.1:${port}/api/routines/${routineId}/runs`);
    const runsBody: any = await runsRes.json();
    assert.equal(runsBody.runs.length, 1);
    assert.equal(runsBody.runs[0].routine_id, routineId);

    // 5. Delete routine
    const delRes = await sendCmd('delete_routine', routineId);
    assert.equal(delRes.success, true);

    const afterListRes = await fetch(`http://127.0.0.1:${port}/api/routines`);
    const afterListBody: any = await afterListRes.json();
    assert.equal(afterListBody.routines.length, 0);

    ws.close();
  });
});

// ---- Stage 1 posting: system API, runs API and the first start after the upgrade ----

const X = 'https://x.com';
const DAY = 86_400_000;
/** gqw8h's reply click on honest-tweet: 2026-09-22 08:16:58 UTC. */
const GQW8H_AT = Date.UTC(2026, 8, 22, 8, 16, 58);
/** wveu4's Post click on viral-life, which timed out: 2026-09-22 10:56:50 UTC. */
const WVEU4_AT = Date.UTC(2026, 8, 22, 10, 56, 50);
/** yf8vs's click for the since-deleted "Milo life": 2026-09-21 07:02:00 UTC. */
const YF8VS_AT = Date.UTC(2026, 8, 21, 7, 2, 0);

type Step = [eventType: string, payload: Record<string, unknown>];
const click = (actionId: string): Step => ['EXTERNAL_ACTION_STARTED', { actionId, transport: 'browser', origin: X, action: 'click' }];
const clickFinished = (actionId: string): Step => ['EXTERNAL_ACTION_FINISHED', { actionId, transport: 'browser' }];
const attempted = (publishId: string, extra: Record<string, unknown> = {}): Step =>
  ['PUBLISH_ATTEMPTED', { publishId, by: 'model', probe: 'x.com/create-tweet', op: 'reply', origin: X, sentAt: WVEU4_AT, ...extra }];
const observed = (publishId: string, outcome: 'confirmed' | 'rejected' | 'unobserved', extra: Record<string, unknown> = {}): Step =>
  ['PUBLISH_OBSERVED', { publishId, outcome, settledAt: WVEU4_AT + 2000, ...extra }];
const refused = (reason: string): Step => ['PUBLISH_REFUSED', { probe: 'x.com/create-tweet', op: 'reply', reason, by: 'model' }];
const utcMinute = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
/** pendingMessage's browser text (spec 6.7), with the literal characters copied from the spec. */
const browserDetail = (runId: string, at: number) =>
  `Not started: run ${runId} at ${utcMinute(at)} UTC submitted something on x.com whose result was never confirmed. Check the account, then choose “Checked — continue” on this routine.`;

/** A finished routine run holding these events one second apart from `at`, as the runtime would have recorded them. */
function pastRun(store: AgentStore, routine: RoutineRecord, steps: Step[], options: { id?: string; at?: number; status?: 'COMPLETED' | 'FAILED' } = {}) {
  const at = options.at ?? WVEU4_AT;
  const run = store.createTaskRun({ ...(options.id ? { id: options.id } : {}), agentId: routine.agent_id, taskName: routine.task_name ?? `routine-${routine.id}`, routineId: routine.id });
  store.recordEvent({ task_run_id: run.id, agent_id: routine.agent_id, event_type: 'ROUTINE_TRIGGERED',
    payload_json: JSON.stringify({ routineId: routine.id, routineName: routine.name, source: 'schedule' }), timestamp: at - 1000 });
  store.startTaskRun(run.id);
  steps.forEach(([eventType, payload], index) => {
    store.recordEvent({ task_run_id: run.id, agent_id: routine.agent_id, event_type: eventType, payload_json: JSON.stringify(payload), timestamp: at + index * 1000 });
  });
  store.finishTaskRun(run.id, options.status ?? 'FAILED', 'fixture');
  return run;
}

function savedResult(result: Partial<WorkResult> & Pick<WorkResult, 'outcome' | 'report'>): WorkResult {
  return { artifacts: [], turns: 2, inputTokens: 10, outputTokens: 10, actualCostUsd: 0, shadowCostUsd: 0, ...result };
}

/** None of these tests starts a container; the boot sweep gets a harmless answer. */
function quietSandbox() {
  const sandbox = new DockerSandbox();
  sandbox.orphanSweep = async () => ({ reapedContainers: 0, reapedVolumes: 0 });
  return sandbox;
}

async function until(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const idleProducer = { start: async () => {}, stop: async () => {}, produceNextTasks: async () => 0 };

describe('Stage 1 posting through the daemon API', () => {
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  const base = () => `http://127.0.0.1:${daemon.wsServer.boundPort}`;
  const get = async (pathname: string): Promise<any> => {
    const res = await fetch(`${base()}${pathname}`);
    assert.equal(res.status, 200, `GET ${pathname}`);
    return res.json();
  };
  const post = async (pathname: string, body: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base()}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const bot = (id: string) => daemon.store.createAgent({ id, name: id, model_id: 'test-model', budget_cap_usd: 10, current_status: 'IDLE' });
  const routineOf = (agentId: string, name: string) => daemon.store.createRoutine({ agentId, name, cronExpression: '*/15 * * * *',
    promptTemplate: `Run ${name}`, taskName: ROUTINE_ASK_TASK, nextRunAt: Date.now() + DAY, enabled: false });

  before(async () => {
    daemon = await startDaemon({ configPath: null, dbPath: ':memory:', wsPort: 0, docker: false, sandbox: quietSandbox(), llmClient: new MockLLMClient(), workProducer: idleProducer });
    await daemon.scheduler.stop();
    registerFixtureServer(daemon.wsServer.boundPort, daemon.wsServer);
  });
  after(async () => { await daemon?.shutdown(); });

  it('GET /api/routines/:id/runs adds each run’s post summary and a model-declared block', async () => {
    bot('post-runs');
    const routine = routineOf('post-runs', 'honest-tweet');
    const url = (id: string) => `${X}/example_account/status/${id}`;
    const confirmed = pastRun(daemon.store, routine, [attempted('p-confirmed'), observed('p-confirmed', 'confirmed', { postId: '1234567890123456789', postUrl: url('1234567890123456789') })], { status: 'COMPLETED' });
    const heldBack = pastRun(daemon.store, routine, [attempted('p-first'), observed('p-first', 'confirmed', { postId: '2102311235647680763', postUrl: url('2102311235647680763') }), refused('budget')], { status: 'COMPLETED' });
    const blocked = pastRun(daemon.store, routine, []);
    saveWorkResult(daemon.store, blocked.id, savedResult({ outcome: 'FAILED', report: "I can't do that here: Nothing suitable to reply to today.", blocked: { declaredBy: 'model', reason: 'Nothing suitable to reply to today.' } }));
    const failed = pastRun(daemon.store, routine, []);
    saveWorkResult(daemon.store, failed.id, savedResult({ outcome: 'FAILED', report: "I couldn't finish that. Task time limit reached." }));
    const quiet = pastRun(daemon.store, routine, [], { status: 'COMPLETED' });

    const body = await get(`/api/routines/${routine.id}/runs`);
    const runs = new Map<string, any>(body.runs.map((run: any) => [run.id, run]));
    assert.equal(runs.size, 5);
    assert.deepEqual(runs.get(confirmed.id).publish, { state: 'confirmed', by: 'model', postUrl: url('1234567890123456789'), heldBack: null });
    assert.deepEqual(runs.get(heldBack.id).publish, { state: 'confirmed', by: 'model', postUrl: url('2102311235647680763'), heldBack: 'budget' });
    assert.equal(runs.get(blocked.id).blocked, true);
    for (const run of [blocked, failed, quiet]) assert.equal('publish' in runs.get(run.id), false, `${run.id} sent no post`);
    for (const run of [confirmed, heldBack, failed, quiet]) assert.equal('blocked' in runs.get(run.id), false, `${run.id} was not blocked by the model`);
    assert.equal(runs.get(confirmed.id).status, 'COMPLETED', 'the run record itself is unchanged');
  });

  it('GET /api/system lists every unconfirmed item, a deleted routine’s included, and the publish policies', async () => {
    bot('post-pending');
    const viral = routineOf('post-pending', 'viral-life');
    const honest = routineOf('post-pending', 'honest-tweet');
    const hung = pastRun(daemon.store, viral, [attempted('p-hung'), observed('p-hung', 'unobserved', { reason: 'timeout' })]);
    pastRun(daemon.store, honest, [click('ok-click'), clickFinished('ok-click')], { status: 'COMPLETED' });
    const gone = routineOf('post-pending', 'Milo life');
    const goneRun = pastRun(daemon.store, gone, [click('gone-click')], { at: YF8VS_AT });
    assert.equal(daemon.store.deleteRoutine(gone.id), true);

    const system = await get('/api/system?agent=post-pending');
    assert.deepEqual(system.pendingEffects, [
      { routineId: viral.id, routineName: 'viral-life', routineDeleted: false, runId: hung.id, at: WVEU4_AT, kind: 'publish', origin: X, before: false, detail: browserDetail(hung.id, WVEU4_AT) },
      { routineId: gone.id, routineName: 'Milo life', routineDeleted: true, runId: goneRun.id, at: YF8VS_AT, kind: 'action', origin: X, before: false, detail: browserDetail(goneRun.id, YF8VS_AT) },
    ]);
    assert.deepEqual(system.publishPolicies, [], 'nothing was seeded: these routines were created after the daemon started');
    assert.ok(Array.isArray(system.missions) && typeof system.capacity?.limit === 'number', 'the existing fields are unchanged');
  });

  it('POST /api/system/routine-publish-policy records the owner’s switch and refuses unknown or other bots’ routines', async () => {
    bot('post-policy');
    bot('post-policy-other');
    const routine = routineOf('post-policy', 'honest-tweet');
    const theirs = routineOf('post-policy-other', 'their-routine');
    const off = await post('/api/system/routine-publish-policy', { agentId: 'post-policy', routineId: routine.id, required: false });
    assert.equal(off.status, 200);
    const { createdAt, updatedAt, ...record } = off.body;
    assert.deepEqual(record, { routineId: routine.id, agentId: 'post-policy', origin: X, probe: 'x.com/create-tweet', required: false, source: 'owner', evidenceRunId: null });
    assert.equal(createdAt, updatedAt);
    assert.deepEqual((await get('/api/system?agent=post-policy')).publishPolicies,
      [{ routineId: routine.id, origin: X, required: false, source: 'owner', evidenceRunId: null, createdAt, updatedAt }]);

    const on = await post('/api/system/routine-publish-policy', { agentId: 'post-policy', routineId: routine.id, required: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.required, true);
    assert.equal(on.body.source, 'owner');
    assert.equal(on.body.createdAt, createdAt, 'the row is updated, not replaced');

    for (const body of [
      { agentId: 'post-policy', routineId: 'rtn-missing', required: true },
      { agentId: 'post-policy', routineId: theirs.id, required: true },
    ]) {
      const answer = await post('/api/system/routine-publish-policy', body);
      assert.deepEqual(answer, { status: 400, body: { error: 'This routine does not belong to this bot.' } });
    }
    const notBoolean = await post('/api/system/routine-publish-policy', { agentId: 'post-policy', routineId: routine.id, required: 'false' });
    assert.equal(notBoolean.status, 400);
    assert.match(notBoolean.body.error, /required/);
    const extraKey = await post('/api/system/routine-publish-policy', { agentId: 'post-policy', routineId: routine.id, required: false, origin: 'https://mastodon.example' });
    assert.equal(extraKey.status, 400);
    assert.match(extraKey.body.error, /origin/);
    assert.equal((await get('/api/system?agent=post-policy')).publishPolicies[0].required, true, 'refused requests changed nothing');
    assert.deepEqual((await get('/api/system?agent=post-policy-other')).publishPolicies, []);
  });

  it('POST /api/system/routine-acknowledge marks every item shown on the routine as checked, in each item’s own run', async () => {
    bot('post-ack');
    const viral = routineOf('post-ack', 'viral-life');
    const own = pastRun(daemon.store, viral, [click('post-click'), attempted('p-post', { actionId: 'post-click' })]);
    const gone = routineOf('post-ack', 'Milo life');
    const goneRun = pastRun(daemon.store, gone, [click('gone-click')], { at: YF8VS_AT });
    assert.equal(daemon.store.deleteRoutine(gone.id), true);
    // With a policy row on x.com, the deleted routine's x.com item is shown on this routine too.
    assert.equal((await post('/api/system/routine-publish-policy', { agentId: 'post-ack', routineId: viral.id, required: true })).status, 200);
    assert.equal((await get('/api/system?agent=post-ack')).pendingEffects.length, 3);

    const extraKey = await post('/api/system/routine-acknowledge', { agentId: 'post-ack', routineId: viral.id, all: true });
    assert.equal(extraKey.status, 400);
    assert.match(extraKey.body.error, /all/);
    const unknown = await post('/api/system/routine-acknowledge', { agentId: 'post-ack', routineId: 'rtn-missing' });
    assert.deepEqual(unknown, { status: 400, body: { error: 'This routine does not belong to this bot.' } });
    assert.equal((await get('/api/system?agent=post-ack')).pendingEffects.length, 3, 'refused requests acknowledged nothing');

    assert.deepEqual(await post('/api/system/routine-acknowledge', { agentId: 'post-ack', routineId: viral.id }), { status: 200, body: { acknowledged: 3 } });
    const acks = (runId: string) => daemon.store.getTaskEvents(runId)
      .filter((e) => e.event_type === 'EXTERNAL_ACTION_ACKNOWLEDGED')
      .map((e) => ({ layer: e.layer, ...JSON.parse(e.payload_json) }));
    assert.deepEqual(acks(own.id).map(({ key, kind, by, layer }) => ({ key, kind, by, layer })), [
      { key: 'post-click', kind: 'action', by: 'operator', layer: null },
      { key: 'p-post', kind: 'publish', by: 'operator', layer: null },
    ]);
    assert.ok(acks(own.id).every((ack) => typeof ack.at === 'number'));
    assert.deepEqual(acks(goneRun.id).map(({ key, kind }) => ({ key, kind })), [{ key: 'gone-click', kind: 'action' }]);
    assert.equal(daemon.store.getTaskEvents(own.id).filter((e) => e.event_type === 'EXTERNAL_ACTION_FINISHED').length, 0, 'no synthetic FINISHED');
    assert.deepEqual((await get('/api/system?agent=post-ack')).pendingEffects, []);
    assert.deepEqual(await post('/api/system/routine-acknowledge', { agentId: 'post-ack', routineId: viral.id }), { status: 200, body: { acknowledged: 0 } });
  });
});

describe('first start after the upgrade on a live-shaped database', () => {
  it('seeds both live routines, lists wveu4 (before the install) and yf8vs, holds viral-life and keeps honest-tweet running', { timeout: 90_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-upgrade-'));
    const dbPath = path.join(dir, 'openhours.db');
    const GQW8H = 'run-1790064930008-gqw8h';
    const WVEU4 = 'run-1790074518658-wveu4';
    const YF8VS = 'run-1789974004374-yf8vs';

    // 1. The database as the previous version left it: clicks on x.com, a deleted
    //    routine's run, and neither publish-policy table nor the install marker.
    const previous = new AgentStore(dbPath);
    previous.createAgent({ id: 'milo', name: 'Milo', model_id: 'test-model', budget_cap_usd: 10, current_status: 'IDLE' });
    const make = (name: string) => previous.createRoutine({ agentId: 'milo', name, cronExpression: '*/15 * * * *', promptTemplate: `Run ${name}`, taskName: ROUTINE_ASK_TASK, nextRunAt: Date.now() + DAY });
    const honest = make('milo-15m-honest-tweet');
    const viral = make('milo-viral-life-tweets');
    const life = make('Milo life');
    pastRun(previous, honest, [click('gqw8h-reply'), clickFinished('gqw8h-reply')], { id: GQW8H, at: GQW8H_AT, status: 'COMPLETED' });
    pastRun(previous, viral, [click('wveu4-post')], { id: WVEU4, at: WVEU4_AT }); // the Post click timed out: no FINISHED
    pastRun(previous, life, [click('yf8vs-click')], { id: YF8VS, at: YF8VS_AT });
    assert.equal(previous.deleteRoutine(life.id), true);
    const old = previous.getDatabase();
    // `before` is strict started_at < installed_at: the runs must have started in the past.
    for (const [id, at] of [[GQW8H, GQW8H_AT], [WVEU4, WVEU4_AT], [YF8VS, YF8VS_AT]] as const) {
      old.prepare('UPDATE task_runs SET started_at = ?, completed_at = ? WHERE id = ?').run(at - 2000, at + 60_000, id);
    }
    assert.deepEqual(old.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'routine_publish_%'").all(), []);
    previous.close();

    // 2. First start of this version. No model call is expected anywhere below.
    const model = { calls: 0, async generateCode() { this.calls += 1; throw new Error('No model call is expected in this test.'); } };
    const bootedAt = Date.now();
    const daemon = await startDaemon({ configPath: null, dbPath, wsPort: 0, cadenceMs: 100, docker: false, sandbox: quietSandbox(),
      llmClient: model as never, secretStore: new MemorySecretStore(), workProducer: idleProducer });
    try {
      await daemon.scheduler.stop();
      registerFixtureServer(daemon.wsServer.boundPort, daemon.wsServer);
      const base = `http://127.0.0.1:${daemon.wsServer.boundPort}`;
      const system = async (): Promise<any> => (await fetch(`${base}/api/system?agent=milo`)).json();
      const byRoutine = (a: { routineId: string }, b: { routineId: string }) => a.routineId.localeCompare(b.routineId);

      // Seeding read the pre-install history; the install marker is this start.
      const marker = daemon.store.getDatabase().prepare("SELECT value FROM routine_publish_meta WHERE key = 'installed_at'").get() as { value: string };
      assert.ok(Number(marker.value) >= bootedAt, 'the install marker was written by this start');
      const first = await system();
      assert.deepEqual(first.publishPolicies.map(({ routineId, origin, required, source, evidenceRunId }: any) => ({ routineId, origin, required, source, evidenceRunId })).sort(byRoutine), [
        { routineId: honest.id, origin: X, required: true, source: 'history', evidenceRunId: GQW8H },
        { routineId: viral.id, origin: X, required: true, source: 'history', evidenceRunId: WVEU4 },
      ].sort(byRoutine));
      assert.deepEqual(first.pendingEffects, [
        { routineId: viral.id, routineName: 'milo-viral-life-tweets', routineDeleted: false, runId: WVEU4, at: WVEU4_AT, kind: 'action', origin: X, before: true, detail: browserDetail(WVEU4, WVEU4_AT) },
        { routineId: life.id, routineName: 'Milo life', routineDeleted: true, runId: YF8VS, at: YF8VS_AT, kind: 'action', origin: X, before: true, detail: browserDetail(YF8VS, YF8VS_AT) },
      ]);
      assert.equal(first.pendingEffects.some((item: any) => item.routineId === honest.id), false, 'honest-tweet has nothing of its own');
      assert.ok(first.publishPolicies.every((row: any) => row.origin === first.pendingEffects[1].origin), 'yf8vs is on both routines’ policy origin, so both editors list it');

      // 3. The first due tick: viral-life is held and left due; honest-tweet runs.
      const dueAt = Date.now() - 2000;
      daemon.store.updateRoutine(viral.id, { next_run_at: dueAt });
      daemon.store.updateRoutine(honest.id, { next_run_at: dueAt + 1000 });
      assert.equal(await daemon.routineProducer.produceNextTasks(daemon.store), 1);
      assert.deepEqual(daemon.store.listRoutineRuns(viral.id).map((run) => run.id), [WVEU4], 'no run for the held routine');
      assert.equal(daemon.store.getRoutine(viral.id)!.next_run_at, dueAt, 'it is left due');
      const honestRun = daemon.store.listRoutineRuns(honest.id).find((run) => run.id !== GQW8H)!;
      assert.equal(honestRun.status, 'QUEUED');
      daemon.store.startTaskRun(honestRun.id);
      daemon.store.finishTaskRun(honestRun.id, 'COMPLETED');

      // 4. A manual run bypasses the producer and stops at the execute gate, before any model call.
      const { run: manual } = enqueueRoutine(daemon.store, viral.id, { source: 'manual', maxQueueDepth: 5, definition: daemon.scheduler.getTaskDefinition(ROUTINE_ASK_TASK) });
      daemon.scheduler.start();
      await until(() => ['FAILED', 'COMPLETED', 'ABORTED'].includes(daemon.store.getTaskRun(manual.id)!.status), 30_000, 'the manual run');
      await daemon.scheduler.stop();
      const gated = daemon.store.getTaskRun(manual.id)!;
      assert.equal(gated.status, 'FAILED');
      assert.ok(gated.error_message?.includes(browserDetail(WVEU4, WVEU4_AT)), gated.error_message ?? 'no error message');
      assert.equal(model.calls, 0, 'no model was called');

      // 5. "Checked — continue" on viral-life acknowledges wveu4 and the listed yf8vs; the next tick runs it.
      const answer = await fetch(`${base}/api/system/routine-acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'milo', routineId: viral.id }) });
      assert.deepEqual({ status: answer.status, body: await answer.json() }, { status: 200, body: { acknowledged: 2 } });
      assert.deepEqual((await system()).pendingEffects, []);
      assert.equal(await daemon.routineProducer.produceNextTasks(daemon.store), 1);
      assert.equal(daemon.store.listRoutineRuns(viral.id).filter((run) => run.status === 'QUEUED').length, 1);
    } finally {
      await daemon.shutdown();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
