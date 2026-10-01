/**
 * Phase A1/A2: the ECC layer taxonomy and the execution_events.layer migration.
 *
 * These are pure and fast - no Docker, no provider. The duplicate-lifecycle
 * regression (A3) is asserted inside the two end-to-end executor tests instead,
 * where a real task run is already paying for a container.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AGENT_LAYERS,
  getLayer,
  layerForEvent,
  type LayerId,
} from '../src/kernel/agent-layers.js';
import { initDaemonSchema, migrateExecutionEventsLayer } from '../src/daemon/db/schema.js';
import { AgentStore } from '../src/daemon/agent-store.js';

describe('agent layer taxonomy', () => {
  it('describes exactly the 12 ECC layers, numbered 1..12 in order', () => {
    assert.equal(AGENT_LAYERS.length, 12);
    assert.deepEqual(
      AGENT_LAYERS.map((l) => l.id),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    );
  });

  it('attributes memory and recall to actual events, with deterministic compaction marked partial', () => {
    assert.equal(getLayer(3).status, 'live');
    assert.equal(getLayer(4).status, 'partial');
    assert.equal(getLayer(5).status, 'live');
    assert.equal(layerForEvent('MEMORY_WRITTEN'), 3);
    assert.equal(layerForEvent('CONTEXT_COMPACTED'), 4);
    assert.equal(layerForEvent('MEMORY_RECALLED'), 5);
  });

  it('gives every hollow layer no event types, so Cortex can never animate one', () => {
    for (const layer of AGENT_LAYERS) {
      if (layer.status === 'hollow') {
        assert.equal(layer.eventTypes.length, 0, `hollow layer ${layer.id} must have no events`);
      }
    }
  });

  it('maps every declared event type back to its own layer', () => {
    // Guards the two halves drifting apart: the table claims an event is
    // evidence of a layer, and layerForEvent must agree.
    for (const layer of AGENT_LAYERS) {
      for (const eventType of layer.eventTypes) {
        assert.equal(
          layerForEvent(eventType),
          layer.id,
          `${eventType} is listed under layer ${layer.id} but maps to ${layerForEvent(eventType)}`
        );
      }
    }
  });

  it('maps the lifecycle events the runtime actually emits', () => {
    assert.equal(layerForEvent('TASK_STARTED'), 1);
    assert.equal(layerForEvent('TURN_COMPLETED'), 9);
    assert.equal(layerForEvent('RESPONSE_FORMAT_REJECTED'), 9);
    assert.equal(layerForEvent('THRASH_WARNING'), 11);
    assert.equal(layerForEvent('PROTECTED_FILES_RESTAGED'), 11);
    assert.equal(layerForEvent('OPENCODE_SESSION'), 6);
    assert.equal(layerForEvent('TASK_COMPLETED'), 12);
    assert.equal(layerForEvent('TASK_FAILED'), 12);
    assert.equal(layerForEvent('TASK_ABORTED'), 12);
    assert.equal(layerForEvent('TASK_CRASHED'), 12);
  });

  it('NEGATIVE CONTROL: an unknown event maps to null rather than a default layer', () => {
    // Defaulting would silently attribute new events to whichever layer the
    // fallback picked, which is how a panel starts lying.
    assert.equal(layerForEvent('SOMETHING_NOBODY_HAS_WRITTEN_YET'), null);
    assert.equal(layerForEvent(''), null);
  });

  it('getLayer throws on an id outside the taxonomy', () => {
    assert.throws(() => getLayer(99 as LayerId), /Unknown agent layer id/);
  });
});

describe('execution_events.layer migration', () => {
  function tmpDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagents-migrate-'));
    return path.join(dir, 'daemon.db');
  }

  it('adds the column to a database created before the taxonomy, keeping its rows', () => {
    const dbPath = tmpDbPath();

    // Build the PRE-migration schema by hand. Using initDaemonSchema here would
    // test nothing, because it already creates the column.
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE execution_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model_id TEXT,
        event_type TEXT NOT NULL,
        turn_number INTEGER,
        payload_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
    old.prepare(
      `INSERT INTO execution_events (task_run_id, agent_id, model_id, event_type, turn_number, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('run-legacy', 'agent-alpha', 'claude-haiku-4-5', 'TASK_STARTED', 0, '{"legacy":true}', 1700000000000);

    const before = old.prepare(`PRAGMA table_info(execution_events)`).all() as Array<{ name: string }>;
    assert.ok(!before.some((c) => c.name === 'layer'), 'fixture must start without the column');
    old.close();

    // Reopening through the real store runs the real migration path.
    const store = new AgentStore(dbPath);
    try {
      const cols = store
        .getDatabase()
        .prepare(`PRAGMA table_info(execution_events)`)
        .all() as Array<{ name: string }>;
      assert.ok(cols.some((c) => c.name === 'layer'), 'migration must add the layer column');

      const rows = store.getDatabase().prepare(`SELECT * FROM execution_events`).all() as any[];
      assert.equal(rows.length, 1, 'the pre-existing row must survive');
      assert.equal(rows[0].task_run_id, 'run-legacy');
      assert.equal(rows[0].payload_json, '{"legacy":true}');
      // Deliberately NOT backfilled: stamping today's taxonomy onto rows written
      // by code that predates it would be fabricated provenance.
      assert.equal(rows[0].layer, null);
    } finally {
      store.close();
    }
  });

  it('is idempotent - a second open does not re-add or duplicate the column', () => {
    const dbPath = tmpDbPath();
    const first = new AgentStore(dbPath);
    first.close();

    const second = new AgentStore(dbPath);
    try {
      const db = second.getDatabase();
      assert.equal(migrateExecutionEventsLayer(db), false, 'column already present');
      const cols = (db.prepare(`PRAGMA table_info(execution_events)`).all() as Array<{ name: string }>)
        .filter((c) => c.name === 'layer');
      assert.equal(cols.length, 1);
    } finally {
      second.close();
    }
  });

  it('reports true exactly once, on the open that actually adds the column', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE execution_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_run_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          model_id TEXT,
          event_type TEXT NOT NULL,
          turn_number INTEGER,
          payload_json TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
      `);
      assert.equal(migrateExecutionEventsLayer(db), true);
      assert.equal(migrateExecutionEventsLayer(db), false);
    } finally {
      db.close();
    }
  });
});

describe('AgentStore stamps and fans out events', () => {
  function store(): AgentStore {
    const s = new AgentStore(':memory:');
    s.createAgent({
      id: 'agent-alpha',
      name: 'Alpha',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 5,
      current_status: 'IDLE',
    });
    return s;
  }

  it('stamps the layer from the taxonomy when the caller does not supply one', () => {
    const s = store();
    try {
      const run = s.createTaskRun({ agentId: 'agent-alpha', taskName: 'stamp' });
      s.startTaskRun(run.id);
      const [started] = s.getTaskEvents(run.id);
      assert.equal(started.event_type, 'TASK_STARTED');
      assert.equal(started.layer, 1);
    } finally {
      s.close();
    }
  });

  it('records an unmapped event with a null layer instead of refusing it', () => {
    const s = store();
    try {
      const run = s.createTaskRun({ agentId: 'agent-alpha', taskName: 'unmapped' });
      s.recordEvent({
        task_run_id: run.id,
        agent_id: 'agent-alpha',
        event_type: 'CUSTOM_DIAGNOSTIC',
        payload_json: '{}',
        timestamp: Date.now(),
      });
      const [e] = s.getTaskEvents(run.id);
      assert.equal(e.event_type, 'CUSTOM_DIAGNOSTIC');
      assert.equal(e.layer, null, 'unmapped events are still auditable');
    } finally {
      s.close();
    }
  });

  it('emits exactly one TASK_STARTED and one terminal event per lifecycle', () => {
    const s = store();
    try {
      const run = s.createTaskRun({ agentId: 'agent-alpha', taskName: 'lifecycle' });
      s.startTaskRun(run.id, 'claude-haiku-4-5', { executor: 'builtin' });
      s.finishTaskRun(run.id, 'COMPLETED', undefined, { turnsTaken: 2 });

      const types = s.getTaskEvents(run.id).map((e) => e.event_type);
      assert.deepEqual(types, ['TASK_STARTED', 'TASK_COMPLETED']);

      const finished = s.getTaskEvents(run.id)[1];
      const payload = JSON.parse(finished.payload_json);
      assert.equal(payload.status, 'COMPLETED');
      assert.equal(payload.turnsTaken, 2, 'caller detail must survive the merge');
      assert.equal(finished.layer, 12);
    } finally {
      s.close();
    }
  });

  it('fans every committed event out to the sink exactly once, in order', () => {
    const s = store();
    try {
      const seen: string[] = [];
      s.setEventSink((e) => seen.push(e.event_type));
      const run = s.createTaskRun({ agentId: 'agent-alpha', taskName: 'fanout' });
      s.startTaskRun(run.id);
      s.finishTaskRun(run.id, 'FAILED', 'boom');
      assert.deepEqual(seen, ['TASK_STARTED', 'TASK_FAILED']);
    } finally {
      s.close();
    }
  });

  it('a throwing sink does not lose the committed row', () => {
    // The audit log is the durable record; a broken transport must not be able
    // to fail the write that already happened.
    const s = store();
    try {
      s.setEventSink(() => {
        throw new Error('transport is down');
      });
      const run = s.createTaskRun({ agentId: 'agent-alpha', taskName: 'sink-throws' });
      s.startTaskRun(run.id);
      assert.equal(s.getTaskEvents(run.id).length, 1);
    } finally {
      s.close();
    }
  });

  it('initDaemonSchema is safe to run twice on the same connection', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initDaemonSchema(db);
      initDaemonSchema(db);
      const cols = (db.prepare(`PRAGMA table_info(execution_events)`).all() as Array<{ name: string }>)
        .filter((c) => c.name === 'layer');
      assert.equal(cols.length, 1);
    } finally {
      db.close();
    }
  });
});

describe('Stage 1 publish events in the taxonomy', () => {
  const STAGE1: ReadonlyArray<[string, LayerId | null]> = [
    ['PUBLISH_OBSERVED', 7],
    ['PUBLISH_RECONCILED', 7],
    ['PUBLISH_ATTEMPTED', null],
    ['PUBLISH_REFUSED', null],
    ['EXTERNAL_ACTION_ACKNOWLEDGED', null],
  ];

  it('maps each Stage 1 event explicitly, the deliberate nulls included', () => {
    for (const [eventType, layer] of STAGE1) {
      assert.equal(layerForEvent(eventType), layer, eventType);
    }
  });

  it('lists every non-null Stage 1 event under its own layer and no null one under any layer', () => {
    // The check above runs one way only (eventTypes -> layerForEvent), so a
    // mapping that exists only in layerForEvent would pass it unnoticed.
    for (const [eventType, layer] of STAGE1) {
      const listedUnder = AGENT_LAYERS.filter((l) => l.eventTypes.includes(eventType)).map((l) => l.id);
      assert.deepEqual(listedUnder, layer === null ? [] : [layer], eventType);
    }
  });

  it('names the publish response and the page check in the layer 7 evidence', () => {
    assert.match(getLayer(7).evidence, /PUBLISH_OBSERVED/);
    assert.match(getLayer(7).evidence, /PUBLISH_RECONCILED/);
    assert.match(getLayer(7).evidence, /page check/);
  });

  it('stamps the Stage 1 layers when the store records the events', () => {
    const s = new AgentStore(':memory:');
    try {
      s.createAgent({ id: 'agent-alpha', name: 'Alpha', model_id: 'claude-haiku-4-5', budget_cap_usd: 5, current_status: 'IDLE' });
      const run = s.createTaskRun({ agentId: 'agent-alpha', taskName: 'publish-layers' });
      for (const [eventType] of STAGE1) {
        s.recordEvent({ task_run_id: run.id, agent_id: 'agent-alpha', event_type: eventType, payload_json: '{}', timestamp: Date.now() });
      }
      assert.deepEqual(s.getTaskEvents(run.id).map((e) => [e.event_type, e.layer]), STAGE1.map(([eventType, layer]) => [eventType, layer]));
    } finally {
      s.close();
    }
  });
});
