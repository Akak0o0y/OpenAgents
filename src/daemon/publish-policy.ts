/**
 * Publish policy: whether a routine must post, kept as a durable routine-level fact.
 *
 * A row is keyed by routine id, so it survives instruction edits. It is seeded
 * once from history (any browser click, double_click or press on a probe origin
 * in one of the routine's runs), noted when a run sends a post, and otherwise
 * changed only by the owner. An owner row is never overwritten afterwards: only
 * the owner's switch can turn "must post" off.
 *
 * Both tables are created here, in the memory.ts pattern, not in schema.ts. They
 * cascade with their routine and bot and point at no run or event, so they can
 * never make deleteRoutine or deleteAgent fail. There are no CHECK constraints
 * (schema.ts:190-194): SQLite cannot change one in place.
 */
import type { AgentStore } from './agent-store.js';
import type { PublishProbe } from './publish-probes.js';

export interface PublishPolicyRecord {
  routineId: string;
  agentId: string;
  origin: string;
  probe: string;
  required: boolean;
  source: 'history' | 'observed' | 'owner';
  evidenceRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface PolicyRow {
  routine_id: string;
  agent_id: string;
  origin: string;
  probe: string;
  required: number;
  source: string;
  evidence_run_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Browser gestures that can submit a post. Visits and fills never seed. */
const SEEDING_ACTIONS = new Set(['click', 'double_click', 'press']);

export class PublishPolicy {
  constructor(private readonly store: AgentStore, private readonly probes: readonly PublishProbe[]) {
    const db = store.getDatabase();
    db.exec(`CREATE TABLE IF NOT EXISTS routine_publish_policy (
      routine_id TEXT PRIMARY KEY REFERENCES routines(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      origin TEXT NOT NULL, probe TEXT NOT NULL, required INTEGER NOT NULL, source TEXT NOT NULL,
      evidence_run_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS routine_publish_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.seedFromHistory();
    // Written once. The first installation time tells the owner which unconfirmed
    // items were recorded before posts were checked (PendingEffect.before).
    db.prepare(`INSERT OR IGNORE INTO routine_publish_meta (key, value) VALUES ('installed_at', ?)`).run(String(Date.now()));
  }

  get(routineId: string): PublishPolicyRecord | null {
    const row = this.store.getDatabase().prepare('SELECT * FROM routine_publish_policy WHERE routine_id = ?').get(routineId) as unknown as PolicyRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** The row when this routine must post; null when it may finish without posting. */
  mustPublish(routineId: string): PublishPolicyRecord | null {
    const record = this.get(routineId);
    return record?.required ? record : null;
  }

  /**
   * A run of this routine sent a post: mark the routine must-post, unless a row
   * already exists (history, an earlier observation and the owner's choice all
   * win). Selecting from routines turns a routine deleted mid-run, or another
   * bot's routine, into a no-op. OR IGNORE does not suppress a FOREIGN KEY failure.
   */
  noteAttempt(i: { agentId: string; routineId: string; origin: string; probe: string; runId: string }): void {
    const now = Date.now();
    this.store.getDatabase().prepare(`INSERT OR IGNORE INTO routine_publish_policy
      (routine_id, agent_id, origin, probe, required, source, evidence_run_id, created_at, updated_at)
      SELECT id, agent_id, ?, ?, 1, 'observed', ?, ?, ? FROM routines WHERE id = ? AND agent_id = ?`)
      .run(i.origin, i.probe, i.runId, now, now, i.routineId, i.agentId);
  }

  /** The owner's switch. The row becomes an owner row, which nothing else changes afterwards. */
  set(agentId: string, routineId: string, required: boolean): PublishPolicyRecord {
    const routine = this.store.getRoutine(routineId);
    if (!routine || routine.agent_id !== agentId) throw new Error('This routine does not belong to this bot.');
    const db = this.store.getDatabase();
    const now = Date.now();
    if (this.get(routineId)) {
      db.prepare(`UPDATE routine_publish_policy SET required = ?, source = 'owner', updated_at = ? WHERE routine_id = ?`)
        .run(required ? 1 : 0, now, routineId);
    } else {
      const probe = this.probes[0];
      const origin = probe?.origins[0];
      if (!probe || !origin) throw new Error('No publish probe is configured, so this routine cannot be marked.');
      db.prepare(`INSERT INTO routine_publish_policy
        (routine_id, agent_id, origin, probe, required, source, evidence_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'owner', NULL, ?, ?)`)
        .run(routineId, agentId, origin, probe.id, required ? 1 : 0, now, now);
    }
    return this.get(routineId)!;
  }

  list(agentId: string): PublishPolicyRecord[] {
    const rows = this.store.getDatabase()
      .prepare('SELECT * FROM routine_publish_policy WHERE agent_id = ? ORDER BY created_at, routine_id')
      .all(agentId) as unknown as PolicyRow[];
    return rows.map(toRecord);
  }

  /**
   * Mark every routine without a row that ever clicked, double-clicked or pressed
   * in the browser on a probe origin. The earliest such run by event time is the
   * evidence. Runs of deleted routines never seed: task_runs.routine_id has no
   * foreign key and outlives its routine, and the join on routines drops those runs.
   */
  private seedFromHistory(): void {
    const byOrigin = new Map<string, PublishProbe>();
    for (const probe of this.probes) {
      for (const origin of probe.origins) if (!byOrigin.has(origin)) byOrigin.set(origin, probe);
    }
    if (byOrigin.size === 0) return;
    const db = this.store.getDatabase();
    const rows = db.prepare(`SELECT r.id AS routine_id, r.agent_id AS agent_id, e.task_run_id AS run_id, e.payload_json AS payload_json
      FROM routines r
      JOIN task_runs t ON t.routine_id = r.id
      JOIN execution_events e ON e.task_run_id = t.id AND e.event_type = 'EXTERNAL_ACTION_STARTED'
      WHERE NOT EXISTS (SELECT 1 FROM routine_publish_policy p WHERE p.routine_id = r.id)
      ORDER BY e.timestamp ASC, e.id ASC`).all() as unknown as Array<{ routine_id: string; agent_id: string; run_id: string; payload_json: string | null }>;
    const seeds = new Map<string, { agentId: string; runId: string; origin: string; probe: string }>();
    for (const row of rows) {
      if (seeds.has(row.routine_id)) continue;
      const started = parseStarted(row.payload_json);
      if (!started || started.transport !== 'browser' || !SEEDING_ACTIONS.has(started.action)) continue;
      const probe = byOrigin.get(started.origin);
      if (probe) seeds.set(row.routine_id, { agentId: row.agent_id, runId: row.run_id, origin: started.origin, probe: probe.id });
    }
    if (seeds.size === 0) return;
    const now = Date.now();
    const insert = db.prepare(`INSERT OR IGNORE INTO routine_publish_policy
      (routine_id, agent_id, origin, probe, required, source, evidence_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 'history', ?, ?, ?)`);
    this.store.transaction(() => {
      for (const [routineId, seed] of seeds) insert.run(routineId, seed.agentId, seed.origin, seed.probe, seed.runId, now, now);
    });
  }
}

function parseStarted(json: string | null): { transport: string; action: string; origin: string } | null {
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null; // an unreadable payload is not evidence of a click
  }
  if (!value || typeof value !== 'object') return null;
  const { transport, action, origin } = value as Record<string, unknown>;
  return typeof transport === 'string' && typeof action === 'string' && typeof origin === 'string' ? { transport, action, origin } : null;
}

function toRecord(row: PolicyRow): PublishPolicyRecord {
  return {
    routineId: row.routine_id,
    agentId: row.agent_id,
    origin: row.origin,
    probe: row.probe,
    required: Number(row.required) !== 0,
    source: row.source as PublishPolicyRecord['source'],
    evidenceRunId: row.evidence_run_id ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
