/**
 * Routines and agent data: the persistence layer for scheduled work.
 *
 * The two assertions that matter most here are about SILENT failures:
 *   - a disabled routine must never come back as due
 *   - setAgentData must UPDATE, not accumulate duplicate rows
 *
 * In-memory SQLite only. No Docker, and no dependence on the real clock: every
 * time is injected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { computeNextRun, parseSchedule } from '../src/daemon/cron.js';
import { DatabaseSync } from 'node:sqlite';
import { migrateRoutineScheduleEnabled } from '../src/daemon/db/schema.js';

const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);
const NOON = utc(2026, 6, 15, 12, 0);

function store(): AgentStore {
  const s = new AgentStore(':memory:');
  s.createAgent({
    id: 'alpha',
    name: 'Alpha',
    model_id: 'claude-haiku-4-5',
    budget_cap_usd: 10,
    current_status: 'IDLE',
  });
  s.createAgent({
    id: 'beta',
    name: 'Beta',
    model_id: 'claude-haiku-4-5',
    budget_cap_usd: 5,
    current_status: 'IDLE',
  });
  return s;
}

function makeRoutine(s: AgentStore, overrides: Record<string, unknown> = {}) {
  const schedule = parseSchedule('every day at 9 am');
  return s.createRoutine({
    agentId: 'alpha',
    name: 'Daily 9 AM sweep',
    cronExpression: schedule.cron,
    humanSchedule: schedule.human,
    timezone: 'UTC',
    promptTemplate: 'Run the standing test sweep and report failures.',
    nextRunAt: computeNextRun(schedule.cron, NOON, 'UTC'),
    ...overrides,
  } as any);
}

describe('routine CRUD', () => {
  it('migrates the old webhook-only sentinel once without losing fields or reclassifying new schedules', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE routines (id TEXT PRIMARY KEY, cron_expression TEXT, webhook_token TEXT, enabled INTEGER)');
      const insert = db.prepare('INSERT INTO routines VALUES (?, ?, ?, ?)');
      insert.run('hook', '4 3 29 2 *', 'preserved-token', 1);
      insert.run('lost-token', '4 3 29 2 *', null, 1);
      insert.run('daily', '0 9 * * *', null, 0);
      assert.equal(migrateRoutineScheduleEnabled(db), true);
      const rows = db.prepare('SELECT * FROM routines ORDER BY id').all();
      assert.deepEqual(rows.map(r => ({ ...r })), [
        { id: 'daily', cron_expression: '0 9 * * *', webhook_token: null, enabled: 0, schedule_enabled: 1 },
        { id: 'hook', cron_expression: '4 3 29 2 *', webhook_token: 'preserved-token', enabled: 1, schedule_enabled: 0 },
        { id: 'lost-token', cron_expression: '4 3 29 2 *', webhook_token: null, enabled: 1, schedule_enabled: 0 },
      ]);
      db.prepare('INSERT INTO routines VALUES (?, ?, ?, ?, ?)').run('explicit-leap-day', '4 3 29 2 *', null, 1, 1);
      assert.equal(migrateRoutineScheduleEnabled(db), false);
      assert.equal(db.prepare('SELECT schedule_enabled FROM routines WHERE id = ?').get('explicit-leap-day')?.schedule_enabled, 1);
    } finally { db.close(); }
  });
  it('creates a routine with its schedule in both forms', () => {
    const s = store();
    try {
      const r = makeRoutine(s);
      assert.equal(r.cron_expression, '0 9 * * *');
      assert.equal(r.human_schedule, 'every day at 9 am');
      assert.equal(r.enabled, 1);
      assert.equal(r.catch_up_policy, 'skip', 'the documented default');
      assert.equal(r.last_run_at, null);
      assert.equal(r.next_run_at, utc(2026, 6, 16, 9, 0));
    } finally {
      s.close();
    }
  });

  it('refuses a routine for an agent that does not exist', () => {
    const s = store();
    try {
      assert.throws(() => makeRoutine(s, { agentId: 'ghost' }), /does not exist/);
    } finally {
      s.close();
    }
  });

  it('lists soonest-due first, and filters by agent', () => {
    const s = store();
    try {
      makeRoutine(s, { name: 'later', nextRunAt: NOON + 90_000 });
      makeRoutine(s, { name: 'sooner', nextRunAt: NOON + 1000 });
      makeRoutine(s, { agentId: 'beta', name: 'other agent', nextRunAt: NOON + 500 });

      assert.deepEqual(s.listRoutines().map((r) => r.name), ['other agent', 'sooner', 'later']);
      assert.deepEqual(s.listRoutines('alpha').map((r) => r.name), ['sooner', 'later']);
    } finally {
      s.close();
    }
  });

  it('updates only the fields it is given', () => {
    const s = store();
    try {
      const r = makeRoutine(s);
      const updated = s.updateRoutine(r.id, { enabled: 0, name: 'Paused sweep' });
      assert.equal(updated.enabled, 0);
      assert.equal(updated.name, 'Paused sweep');
      assert.equal(updated.prompt_template, r.prompt_template, 'untouched fields survive');
      assert.ok(updated.updated_at >= r.updated_at);
    } finally {
      s.close();
    }
  });

  it('deletes, and reports whether anything was deleted', () => {
    const s = store();
    try {
      const r = makeRoutine(s);
      assert.equal(s.deleteRoutine(r.id), true);
      assert.equal(s.getRoutine(r.id), null);
      assert.equal(s.deleteRoutine(r.id), false, 'a second delete removes nothing');
    } finally {
      s.close();
    }
  });
});

describe('getDueRoutines', () => {
  it('returns only routines whose time has come', () => {
    const s = store();
    try {
      makeRoutine(s, { name: 'due', nextRunAt: NOON - 1000 });
      makeRoutine(s, { name: 'not yet', nextRunAt: NOON + 60_000 });
      assert.deepEqual(s.getDueRoutines(NOON).map((r) => r.name), ['due']);
    } finally {
      s.close();
    }
  });

  it('NEVER returns a disabled routine, however overdue', () => {
    // A paused routine that still fires is the worst kind of bug: the operator
    // switched it off and it kept spending.
    const s = store();
    try {
      makeRoutine(s, { name: 'paused', nextRunAt: NOON - 86_400_000, enabled: false });
      assert.deepEqual(s.getDueRoutines(NOON), []);
    } finally {
      s.close();
    }
  });

  it('NEGATIVE CONTROL: the same routine IS due once re-enabled', () => {
    // Without this, a getDueRoutines that returned nothing at all would satisfy
    // the test above while silently disabling every routine.
    const s = store();
    try {
      const r = makeRoutine(s, { nextRunAt: NOON - 1000, enabled: false });
      assert.equal(s.getDueRoutines(NOON).length, 0);
      s.updateRoutine(r.id, { enabled: 1 });
      assert.equal(s.getDueRoutines(NOON).length, 1);
    } finally {
      s.close();
    }
  });

  it('returns the most overdue first, so a backlog drains in order', () => {
    const s = store();
    try {
      makeRoutine(s, { name: 'recent', nextRunAt: NOON - 1000 });
      makeRoutine(s, { name: 'ancient', nextRunAt: NOON - 999_000 });
      assert.deepEqual(s.getDueRoutines(NOON).map((r) => r.name), ['ancient', 'recent']);
    } finally {
      s.close();
    }
  });
});

describe('recordRoutineRun', () => {
  it('advances the schedule and links the run back to the routine', () => {
    const s = store();
    try {
      const r = makeRoutine(s);
      const run = s.createTaskRun({ agentId: 'alpha', taskName: 'sweep' });
      const nextRunAt = computeNextRun(r.cron_expression, r.next_run_at, r.timezone);

      s.recordRoutineRun(r.id, run.id, 'QUEUED', nextRunAt);

      const after = s.getRoutine(r.id)!;
      assert.equal(after.next_run_at, nextRunAt);
      assert.equal(after.last_run_status, 'QUEUED');
      assert.ok(after.last_run_at !== null);
      assert.ok(after.next_run_at > r.next_run_at, 'the schedule must move forward');

      const history = s.listRoutineRuns(r.id);
      assert.equal(history.length, 1);
      assert.equal(history[0].id, run.id);
      assert.equal(history[0].routine_id, r.id);
    } finally {
      s.close();
    }
  });
});

describe('agent data', () => {
  it('stores and reads back a structured record', () => {
    const s = store();
    try {
      const rec = s.setAgentData({
        agentId: 'alpha',
        key: 'daily-report',
        category: 'report',
        data: { passed: 12, failed: 1 },
      });
      assert.equal(rec.category, 'report');

      const read = s.getAgentData('alpha', 'daily-report', 'report')!;
      assert.deepEqual(JSON.parse(read.data_json), { passed: 12, failed: 1 });
    } finally {
      s.close();
    }
  });

  it('UPDATES on repeat rather than accumulating duplicate rows', () => {
    // The whole reason the schema carries UNIQUE(agent_id, category, key). The
    // original plan keyed only on the id column, which would have let "set"
    // append forever while reads returned an arbitrary row.
    const s = store();
    try {
      const first = s.setAgentData({ agentId: 'alpha', key: 'k', category: 'metric', data: { v: 1 } });
      const second = s.setAgentData({ agentId: 'alpha', key: 'k', category: 'metric', data: { v: 2 } });

      assert.equal(second.id, first.id, 'the same row is reused');
      assert.equal(s.listAgentData('alpha', 'metric').length, 1, 'exactly one row, not two');
      assert.deepEqual(JSON.parse(s.getAgentData('alpha', 'k', 'metric')!.data_json), { v: 2 });
    } finally {
      s.close();
    }
  });

  it('keeps the same key separate across categories and agents', () => {
    const s = store();
    try {
      s.setAgentData({ agentId: 'alpha', key: 'k', category: 'report', data: 'A-report' });
      s.setAgentData({ agentId: 'alpha', key: 'k', category: 'metric', data: 'A-metric' });
      s.setAgentData({ agentId: 'beta', key: 'k', category: 'report', data: 'B-report' });

      assert.equal(JSON.parse(s.getAgentData('alpha', 'k', 'report')!.data_json), 'A-report');
      assert.equal(JSON.parse(s.getAgentData('alpha', 'k', 'metric')!.data_json), 'A-metric');
      assert.equal(JSON.parse(s.getAgentData('beta', 'k', 'report')!.data_json), 'B-report');
      assert.equal(s.listAgentData().length, 3);
    } finally {
      s.close();
    }
  });

  it('filters by agent and category', () => {
    const s = store();
    try {
      s.setAgentData({ agentId: 'alpha', key: 'a', category: 'report', data: 1 });
      s.setAgentData({ agentId: 'alpha', key: 'b', category: 'metric', data: 2 });
      s.setAgentData({ agentId: 'beta', key: 'c', category: 'report', data: 3 });

      assert.equal(s.listAgentData('alpha').length, 2);
      assert.equal(s.listAgentData(undefined, 'report').length, 2);
      assert.equal(s.listAgentData('alpha', 'report').length, 1);
    } finally {
      s.close();
    }
  });

  it('refuses data for an agent that does not exist', () => {
    const s = store();
    try {
      assert.throws(() => s.setAgentData({ agentId: 'ghost', key: 'k', data: 1 }), /does not exist/);
    } finally {
      s.close();
    }
  });

  it('deletes, and reports whether anything was deleted', () => {
    const s = store();
    try {
      const rec = s.setAgentData({ agentId: 'alpha', key: 'k', data: 1 });
      assert.equal(s.deleteAgentData(rec.id), true);
      assert.equal(s.deleteAgentData(rec.id), false);
      assert.equal(s.getAgentData('alpha', 'k'), null);
    } finally {
      s.close();
    }
  });
});

describe('migration safety', () => {
  it('task_runs gains routine_id, and a run without a routine reports none', () => {
    // Same additive discipline as the `layer` column: nullable, no table
    // rebuild, and old rows read back null rather than a guess.
    const s = store();
    try {
      const run = s.createTaskRun({ agentId: 'alpha', taskName: 'pre-existing' });
      const cols = s
        .getDatabase()
        .prepare(`PRAGMA table_info(task_runs)`)
        .all() as Array<{ name: string }>;
      assert.ok(cols.some((c) => c.name === 'routine_id'));

      const row = s.getDatabase().prepare(`SELECT * FROM task_runs WHERE id = ?`).get(run.id) as any;
      assert.equal(row.routine_id, null);
    } finally {
      s.close();
    }
  });
});
