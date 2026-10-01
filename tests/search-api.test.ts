import { fixtureFetch as fetch } from './helpers/daemon-client.js';
/**
 * Cross-content search: the query engine and the HTTP contract.
 *
 * The workspace search dialog is the only surface that claims to see across
 * bots, conversations and routines at once, so the two failure modes that
 * matter are covered explicitly: reporting "nothing found" for content that
 * exists, and reporting results for a daemon that cannot actually search.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { DaemonWsServer } from './helpers/daemon-client.js';
import { searchContent } from '../src/daemon/search.js';
import { computeNextRun, parseSchedule } from '../src/daemon/cron.js';

describe('search', () => {
  const port = 4131;
  let store: AgentStore;
  let server: DaemonWsServer;

  before(async () => {
    store = new AgentStore(':memory:');
    store.createAgent({
      id: 'atlas',
      name: 'Atlas',
      model_id: 'test-model',
      system_prompt: 'Maps a codebase and keeps the map current.',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });
    store.createAgent({
      id: 'ledger-bot',
      name: 'Ledger',
      model_id: 'test-model',
      system_prompt: 'Reconciles invoices.',
      budget_cap_usd: 5,
      current_status: 'IDLE',
    });

    const thread = store.createThread({ agentId: 'atlas', title: 'Atlas chat' });
    store.appendMessage({
      thread_id: thread.id,
      role: 'user',
      content: 'Please review the deployment checklist at https://example.invalid/deploy-runbook',
    });
    store.appendMessage({
      thread_id: thread.id,
      role: 'assistant',
      content: 'The checklist is stale; the rollback step is missing.',
    });

    const parsed = parseSchedule('every day at 9 am');
    store.createRoutine({
      agentId: 'atlas',
      name: 'Morning checklist sweep',
      cronExpression: parsed.cron,
      humanSchedule: parsed.human,
      timezone: 'UTC',
      promptTemplate: 'Re-read the checklist and report drift.',
      nextRunAt: computeNextRun(parsed.cron, Date.now(), 'UTC'),
    });

    store.setAgentData({
      agentId: 'atlas',
      key: 'checklist-report.md',
      category: 'report',
      data: { summary: 'rollback step missing' },
    });

    server = new DaemonWsServer(
      port,
      () => ({ agents: store.listAgents(), taskRuns: [], routines: store.listRoutines() }),
      {
        getRunEvents: (id) => store.getTaskEvents(id),
        getRunWorkspace: async () => ({ available: false, reason: 'test' }),
        readRunFile: async () => ({ available: false, reason: 'test' }),
        approvals: () => [],
        mcpStatus: () => [],
        search: (options) => searchContent(store.getDatabase(), options),
      }
    );
    await server.start();
  });

  after(async () => {
    await server.close();
    store.close();
  });

  it('finds a bot by name, id and role text', () => {
    const byName = searchContent(store.getDatabase(), { query: 'Atlas', kinds: ['bot'] });
    assert.equal(byName.results.length, 1);
    assert.equal(byName.results[0].id, 'atlas');

    const byRole = searchContent(store.getDatabase(), { query: 'invoices', kinds: ['bot'] });
    assert.equal(byRole.results[0].id, 'ledger-bot');
  });

  it('finds a message and attributes it to the right bot and thread', () => {
    const res = searchContent(store.getDatabase(), { query: 'rollback', kinds: ['message'] });
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].kind, 'message');
    assert.equal(res.results[0].agentId, 'atlas');
    assert.ok(res.results[0].threadId);
  });

  it('finds a routine by name and by its instruction text', () => {
    const byName = searchContent(store.getDatabase(), { query: 'Morning', kinds: ['routine'] });
    assert.equal(byName.results.length, 1);
    const byPrompt = searchContent(store.getDatabase(), { query: 'report drift', kinds: ['routine'] });
    assert.equal(byPrompt.results.length, 1);
  });

  it('extracts links out of message text', () => {
    const res = searchContent(store.getDatabase(), { query: 'runbook', kinds: ['link'] });
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].title, 'https://example.invalid/deploy-runbook');
  });

  it('reports groups as unsupported rather than empty', () => {
    const res = searchContent(store.getDatabase(), { query: 'anything', kinds: ['group'] });
    assert.equal(res.results.length, 0);
    assert.equal(res.unsupported.length, 1);
    assert.equal(res.unsupported[0].kind, 'group');
    assert.match(res.unsupported[0].reason, /no group conversations/i);
  });

  it('NEGATIVE CONTROL: a non-matching query returns nothing at all', () => {
    const res = searchContent(store.getDatabase(), { query: 'zz-no-such-content-zz' });
    assert.equal(res.results.length, 0);
  });

  it('treats LIKE wildcards in the query as literal characters', () => {
    // Without escaping, "%" would match every row and the dialog would show
    // every bot for a query that matches none of them.
    const res = searchContent(store.getDatabase(), { query: '%', kinds: ['bot'] });
    assert.equal(res.results.length, 0);
  });

  it('lists recent bots and routines for an empty query, but not messages', () => {
    const res = searchContent(store.getDatabase(), { query: '' });
    assert.ok(res.results.some((r) => r.kind === 'bot'));
    assert.ok(res.results.some((r) => r.kind === 'routine'));
    assert.equal(res.results.filter((r) => r.kind === 'message').length, 0);
  });

  it('serves GET /api/search and honours the kinds filter', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/search?q=Atlas&kinds=bot`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].kind, 'bot');
  });

  it('rejects an unknown kind, an oversized query and a bad limit', async () => {
    const badKind = await fetch(`http://127.0.0.1:${port}/api/search?q=a&kinds=bot,nonsense`);
    assert.equal(badKind.status, 400);
    assert.match((await badKind.json() as any).error, /Unknown search kind/);

    const longQuery = await fetch(`http://127.0.0.1:${port}/api/search?q=${'a'.repeat(201)}`);
    assert.equal(longQuery.status, 400);

    const badLimit = await fetch(`http://127.0.0.1:${port}/api/search?q=a&limit=0`);
    assert.equal(badLimit.status, 400);

    const emptyLimit = await fetch(`http://127.0.0.1:${port}/api/search?q=a&limit=`);
    assert.equal(emptyLimit.status, 400);
  });

  it('answers 501 when the daemon has no search implementation', async () => {
    const bare = new DaemonWsServer(port + 1, () => ({}), {
      getRunEvents: () => [],
      getRunWorkspace: async () => ({ available: false, reason: 'test' }),
      readRunFile: async () => ({ available: false, reason: 'test' }),
      approvals: () => [],
      mcpStatus: () => [],
    });
    await bare.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port + 1}/api/search?q=x`);
      assert.equal(res.status, 501);
    } finally {
      await bare.close();
    }
  });
});
