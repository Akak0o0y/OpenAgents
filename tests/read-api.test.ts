import { fixtureFetch as fetch } from './helpers/daemon-client.js';
/**
 * Phase A5: the Cortex read API.
 *
 * These drive the real HTTP server over a real socket, but the data behind it is
 * a stub reader - the Docker-backed half is covered in kernel.test.ts where a
 * real volume already exists. Keeping them separate means the contract tests
 * cost nothing to run.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonWsServer, type DaemonReadApi } from './helpers/daemon-client.js';
import type { ExecutionEventRecord } from '../src/daemon/db/schema.js';

const PORT = 4123;
const BARE_PORT = 4124;
const BASE = `http://127.0.0.1:${PORT}`;
const BARE_BASE = `http://127.0.0.1:${BARE_PORT}`;

function event(id: number, type: string, layer: number | null): ExecutionEventRecord {
  return {
    id,
    task_run_id: 'run-1',
    agent_id: 'agent-alpha',
    model_id: 'claude-haiku-4-5',
    event_type: type,
    turn_number: 0,
    payload_json: '{}',
    timestamp: 1_700_000_000_000 + id,
    layer: layer as any,
  };
}

const EVENTS = [
  event(1, 'TASK_STARTED', 1),
  event(2, 'PROMPT_ASSEMBLED', 1),
  event(3, 'HISTORY_APPENDED', 2),
  event(4, 'TURN_COMPLETED', 9),
  event(5, 'TASK_COMPLETED', 12),
];

const readApi: DaemonReadApi = {
  approvals: (taskRunId) =>
    (taskRunId && taskRunId !== 'run-1'
      ? []
      : [
          {
            id: 'apr-1',
            task_run_id: 'run-1',
            agent_id: 'agent-alpha',
            kind: 'dispatch',
            payload_json: '{"taskName":"clamp-number"}',
            status: 'PENDING',
            reason: null,
            created_at: 1_700_000_000_000,
            decided_at: null,
            waiting: true,
          },
          {
            id: 'apr-2',
            task_run_id: 'run-1',
            agent_id: 'agent-alpha',
            kind: 'dispatch',
            payload_json: '{}',
            status: 'PENDING',
            reason: null,
            created_at: 1_700_000_000_001,
            decided_at: null,
            // Answerable in the database, but nothing in THIS process is waiting.
            waiting: false,
          },
        ]),
  mcpStatus: () => [
    { name: 'echo', connected: true, tools: ['reverse'], callsUsed: 2, quota: 50 },
    { name: 'dead', connected: false, tools: [], callsUsed: 0, quota: 50, error: 'spawn ENOENT' },
  ],
  getRunEvents(taskRunId, since) {
    if (taskRunId !== 'run-1') return [];
    return since === undefined ? EVENTS : EVENTS.filter((e) => (e.id ?? 0) > since);
  },
  async getRunWorkspace(taskRunId) {
    if (taskRunId === 'run-live') return { available: true, files: ['src/index.js', 'test.js'] };
    if (taskRunId === 'run-plan') return { available: false, required: false, reason: 'No workspace needed for a plan.' };
    return { available: false, reason: 'Workspace volume was reaped when the run reached COMPLETED.' };
  },
  async readRunFile(taskRunId, file) {
    if (taskRunId === 'run-live' && file === 'src/index.js') {
      return { available: true, content: 'export function add(a, b) { return a + b; }', truncated: false };
    }
    return { available: false, reason: `Failed to read ${file}` };
  },
};

let server: DaemonWsServer;
let bare: DaemonWsServer;

before(async () => {
  server = new DaemonWsServer(PORT, () => ({ agents: [], taskRuns: [] }), readApi);
  const agents = new Map<string, any>();
  server.setAgentApi({
    create: (input) => {
      if (agents.has(input.id)) throw new Error(`Agent "${input.id}" already exists.`);
      const agent = { id: input.id, name: input.name, model_id: input.modelId, system_prompt: input.systemPrompt ?? null, budget_cap_usd: input.budgetCapUsd, current_status: 'IDLE' };
      agents.set(input.id, agent);
      return agent;
    },
    update: (id, input) => {
      const existing = agents.get(id);
      if (!existing) throw new Error(`Agent "${id}" does not exist.`);
      const next = { ...existing, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.modelId !== undefined ? { model_id: input.modelId } : {}), ...(input.systemPrompt !== undefined ? { system_prompt: input.systemPrompt } : {}), ...(input.budgetCapUsd !== undefined ? { budget_cap_usd: input.budgetCapUsd } : {}) };
      agents.set(id, next);
      return next;
    },
  });
  await server.start();
  // Deliberately constructed WITHOUT a read API, to prove the difference between
  // "no data" and "this server cannot read data" is visible to a caller.
  bare = new DaemonWsServer(BARE_PORT, () => ({ agents: [], taskRuns: [] }));
  await bare.start();
});

after(async () => {
  await server.close();
  await bare.close();
});

async function get(path: string, base = BASE): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function mutate(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('agent administration API', () => {
  it('creates and updates durable agent settings with validation', async () => {
    const created = await mutate('/api/agents', 'POST', { id: 'design-bot', name: 'Design Bot', modelId: 'openrouter/auto', systemPrompt: 'Prototype interfaces.', budgetCapUsd: 8 });
    assert.equal(created.status, 201);
    assert.equal(created.body.agent.current_status, 'IDLE');

    const updated = await mutate('/api/agents/design-bot', 'PATCH', { name: 'Product Designer', budgetCapUsd: 12 });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.agent.name, 'Product Designer');
    assert.equal(updated.body.agent.budget_cap_usd, 12);

    const invalid = await mutate('/api/agents', 'POST', { id: '../bad', name: 'Bad', modelId: 'x', budgetCapUsd: 1 });
    assert.equal(invalid.status, 400);
  });
});

describe('GET /api/layers', () => {
  it('serves the whole taxonomy, including the layers that do not exist', async () => {
    const { status, body } = await get('/api/layers');
    assert.equal(status, 200);
    assert.equal(body.layers.length, 12);

    assert.equal(body.layers.find((l: any) => l.id === 3).status, 'live');
    assert.equal(body.layers.find((l: any) => l.id === 4).status, 'partial');
    assert.equal(body.layers.find((l: any) => l.id === 5).status, 'live');

    // Every hollow layer must arrive with a reason attached, or the panel can
    // only say "nothing here" without saying why.
    for (const layer of body.layers) {
      if (layer.status === 'hollow') {
        assert.match(layer.evidence, /NONE/, `layer ${layer.id} must explain its absence`);
        assert.equal(layer.eventTypes.length, 0);
      }
    }
  });

  it('answers even on a daemon with no read API, because the taxonomy is static', async () => {
    const { status, body } = await get('/api/layers', BARE_BASE);
    assert.equal(status, 200);
    assert.equal(body.layers.length, 12);
  });
});

describe('GET /api/runs/:id/events', () => {
  it('returns layer-tagged events plus a cursor to resume from', async () => {
    const { status, body } = await get('/api/runs/run-1/events');
    assert.equal(status, 200);
    assert.equal(body.runId, 'run-1');
    assert.equal(body.events.length, 5);
    assert.equal(body.since, null);
    assert.equal(body.latestEventId, 5);
    assert.deepEqual(body.events.map((e: any) => e.layer), [1, 1, 2, 9, 12]);
  });

  it('honours ?since= so a poller does not re-read what it already has', async () => {
    const { status, body } = await get('/api/runs/run-1/events?since=3');
    assert.equal(status, 200);
    assert.deepEqual(body.events.map((e: any) => e.id), [4, 5]);
    assert.equal(body.since, 3);
    assert.equal(body.latestEventId, 5);
  });

  it('reports a null cursor when nothing is new, rather than a stale one', async () => {
    const { body } = await get('/api/runs/run-1/events?since=5');
    assert.deepEqual(body.events, []);
    assert.equal(body.latestEventId, null);
  });

  it('rejects a malformed ?since= instead of quietly treating it as zero', async () => {
    // Number("abc") is NaN and every NaN comparison is false, so a silent coerce
    // would return an empty list and look exactly like "no new events".
    for (const bad of ['abc', '-1', '1.5', '']) {
      const { status } = await get(`/api/runs/run-1/events?since=${encodeURIComponent(bad)}`);
      assert.equal(status, 400, `since=${JSON.stringify(bad)} must be a 400`);
    }
  });

  it('returns an empty list for an unknown run, not an error', async () => {
    const { status, body } = await get('/api/runs/nope/events');
    assert.equal(status, 200);
    assert.deepEqual(body.events, []);
  });
});

describe('GET /api/runs/:id/workspace', () => {
  it('distinguishes a task that needs no workspace from a lost workspace', async () => {
    const { status, body } = await get('/api/runs/run-plan/workspace');
    assert.equal(status, 200);
    assert.equal(body.available, false);
    assert.equal(body.required, false);
  });
  it('lists the files of a live workspace', async () => {
    const { status, body } = await get('/api/runs/run-live/workspace');
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.deepEqual(body.files, ['src/index.js', 'test.js']);
  });

  it('says WHY a finished run has no workspace instead of returning an empty list', async () => {
    // An empty list would be indistinguishable from a task that wrote nothing.
    const { status, body } = await get('/api/runs/run-1/workspace');
    assert.equal(status, 404);
    assert.equal(body.available, false);
    assert.match(body.reason, /reaped/);
  });

  it('serves one file with ?file=', async () => {
    const { status, body } = await get('/api/runs/run-live/workspace?file=src/index.js');
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.equal(body.truncated, false);
    assert.match(body.content, /export function add/);
  });

  it('404s a file that is not there, carrying the reason', async () => {
    const { status, body } = await get('/api/runs/run-live/workspace?file=ghost.js');
    assert.equal(status, 404);
    assert.equal(body.available, false);
    assert.match(body.reason, /ghost\.js/);
  });
});

describe('GET /api/mcp', () => {
  it('reports each server and whether it is actually connected', async () => {
    const { status, body } = await get('/api/mcp');
    assert.equal(status, 200);
    assert.equal(body.configured, 2);
    assert.equal(body.connected, 1, 'connected counts real connections, not configuration');

    const dead = body.servers.find((s: any) => s.name === 'dead');
    assert.equal(dead.connected, false);
    assert.equal(dead.error, 'spawn ENOENT', 'a down server must explain itself');
    assert.deepEqual(dead.tools, [], 'a disconnected server advertises no tools');
  });

  it('surfaces quota usage so an operator can see a server being hammered', async () => {
    const { body } = await get('/api/mcp');
    const echo = body.servers.find((s: any) => s.name === 'echo');
    assert.equal(echo.callsUsed, 2);
    assert.equal(echo.quota, 50);
  });

  it('501s on a daemon with no read API rather than reporting zero servers', async () => {
    // "No servers" and "cannot answer" are different facts.
    const { status } = await get('/api/mcp', BARE_BASE);
    assert.equal(status, 501);
  });
});

describe('GET /api/approvals', () => {
  it('separates approvals a decision can actually reach from orphaned ones', async () => {
    // A PENDING row whose waiter died with a previous daemon is answerable but
    // connected to nothing. Counting them together would put a button in front
    // of the operator that silently does nothing.
    const { status, body } = await get('/api/approvals');
    assert.equal(status, 200);
    assert.equal(body.approvals.length, 2);
    assert.equal(body.pending, 1, 'only live waiters count as actionable');
    assert.equal(body.orphaned, 1);
  });

  it('filters by run', async () => {
    const { body } = await get('/api/approvals?run=run-other');
    assert.deepEqual(body.approvals, []);
    assert.equal(body.pending, 0);
  });

  it('501s on a daemon with no read API rather than reporting no approvals', async () => {
    const { status } = await get('/api/approvals', BARE_BASE);
    assert.equal(status, 501);
  });
});

describe('read API error posture', () => {
  it('501s when the daemon has no read API, rather than answering emptily', async () => {
    const { status, body } = await get('/api/runs/run-1/events', BARE_BASE);
    assert.equal(status, 501);
    assert.match(body.error, /without a read API/);
  });

  it('404s an unknown /api path with the path in the message', async () => {
    const { status, body } = await get('/api/does-not-exist');
    assert.equal(status, 404);
    assert.match(body.error, /\/api\/does-not-exist/);
  });

  it('REGRESSION: /api/state and /health still answer the old contract', async () => {
    // The existing console polls these; A5 must not have moved them.
    const state = await get('/api/state');
    assert.equal(state.status, 200);
    assert.ok(Array.isArray(state.body.agents));
    assert.ok(Array.isArray(state.body.taskRuns));

    const health = await get('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'HEALTHY');
  });
});
