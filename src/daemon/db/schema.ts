/**
 * Daemon SQLite Database Schema Extension
 * Extends the existing CostLedger database with agents, task runs, and execution events.
 * Exclusive single-writer model in WAL mode.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { LayerId } from '../../kernel/agent-layers.js';

export type AgentStatus = 'IDLE' | 'BUSY' | 'PAUSED' | 'DISABLED';
export type TaskRunStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABORTED' | 'CRASHED';

export interface AgentRecord {
  id: string;
  name: string;
  model_id: string;
  fallback_model_id?: string | null;
  system_prompt?: string | null;
  requires_approval?: number;
  /** Operator-configured provider connection. Absent means today's provider inference from the model ID. */
  connection_id?: string | null;
  /** 'pinned' refuses any other served model; 'auto' is an explicit operator choice. Set only with a connection. */
  routing_mode?: 'pinned' | 'auto' | null;
  budget_cap_usd: number;
  current_status: AgentStatus;
  created_at: number;
  updated_at: number;
}

export interface TaskRunRecord {
  id: string;
  agent_id: string;
  task_name: string;
  model_id: string; // The exact model used for this run
  status: TaskRunStatus;
  turns_taken: number;
  actual_cost_usd: number;
  shadow_cost_usd: number;
  error_message?: string | null;
  started_at?: number | null;
  completed_at?: number | null;
  /** The routine that scheduled this run, if any. */
  routine_id?: string | null;
  task_definition_json?: string | null;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

export interface ApprovalRecord {
  id: string;
  task_run_id: string;
  agent_id: string;
  /** What is being approved, e.g. 'dispatch' or 'mcp-call'. */
  kind: string;
  payload_json: string;
  status: ApprovalStatus;
  /** Operator's reason, on decide. */
  reason?: string | null;
  created_at: number;
  decided_at?: number | null;
}

export type CatchUpPolicy = 'skip' | 'run_once';

export interface RoutineRecord {
  id: string;
  agent_id: string;
  name: string;
  cron_expression: string;
  human_schedule?: string | null;
  timezone: string;
  prompt_template: string;
  task_name?: string | null;
  enabled: number;
  catch_up_policy: CatchUpPolicy;
  /** Independent of enabled: webhook/manual-only routines have no timetable. */
  schedule_enabled?: number;
  last_run_at?: number | null;
  next_run_at: number;
  last_run_status?: string | null;
  /** Secret that lets an external system fire this routine. Null when unset. */
  webhook_token?: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentDataRecord {
  id: string;
  agent_id: string;
  routine_id?: string | null;
  task_run_id?: string | null;
  key: string;
  category: string;
  data_json: string;
  created_at: number;
  updated_at: number;
}

export interface ChatThreadRecord {
  id: string;
  agent_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessageRecord {
  id?: number;
  thread_id: string;
  role: ChatRole;
  content: string;
  /** Null on user turns. */
  model_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  /** The task_run this turn was billed and audited under. Null on user turns. */
  task_run_id?: string | null;
  created_at: number;
}

export interface ExecutionEventRecord {
  id?: number;
  task_run_id: string;
  agent_id: string;
  model_id?: string | null;
  event_type: string;
  turn_number?: number | null;
  payload_json: string;
  timestamp: number;
  /**
   * Which of the 12 ECC agent layers this event is evidence of.
   * Nullable on purpose: an unmapped event is still a valid audit row, it just
   * does not light up a ring in Cortex. AgentStore.recordEvent() fills this from
   * layerForEvent() when the caller does not supply one.
   */
  layer?: LayerId | null;
}

/**
 * Initialize all Phase 3 daemon tables in the shared SQLite database.
 */
export function initDaemonSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA journal_mode = WAL;`);

  db.exec(`
    -- Agents Table
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model_id TEXT NOT NULL,
      fallback_model_id TEXT,
      system_prompt TEXT,
      budget_cap_usd REAL NOT NULL,
      current_status TEXT NOT NULL CHECK (current_status IN ('IDLE', 'BUSY', 'PAUSED', 'DISABLED')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Task Runs Table
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      task_name TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED', 'CRASHED')),
      turns_taken INTEGER NOT NULL DEFAULT 0,
      actual_cost_usd REAL NOT NULL DEFAULT 0.0,
      shadow_cost_usd REAL NOT NULL DEFAULT 0.0,
      error_message TEXT,
      started_at INTEGER,
      completed_at INTEGER
    );

    -- Execution Events Table (Audit Log & Live Event Stream Source of Truth)
    CREATE TABLE IF NOT EXISTS execution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_run_id TEXT NOT NULL REFERENCES task_runs(id),
      agent_id TEXT NOT NULL,
      model_id TEXT,
      event_type TEXT NOT NULL,
      turn_number INTEGER,
      payload_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      layer INTEGER
    );

    -- Approvals live in their OWN table rather than as a task_runs status.
    -- SQLite cannot alter a CHECK constraint in place, so adding
    -- AWAITING_APPROVAL to task_runs.status would force a full table rebuild
    -- and put every historical row at risk. A blocked run stays RUNNING and
    -- the block is recorded here.
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      task_run_id TEXT NOT NULL REFERENCES task_runs(id),
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED')),
      reason TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );

    -- Chat lives in its own tables. Conversation is first-class product data,
    -- not an audit trail, so it is not squeezed into execution_events.
    -- Scheduled routines. next_run_at is always absolute epoch ms, computed
    -- from the cron expression in the routine's own timezone, so the scheduler
    -- never has to reason about wall clocks.
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      human_schedule TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      prompt_template TEXT NOT NULL,
      task_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      catch_up_policy TEXT NOT NULL DEFAULT 'skip' CHECK (catch_up_policy IN ('skip', 'run_once')),
      last_run_at INTEGER,
      next_run_at INTEGER NOT NULL,
      last_run_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Persistent agent data: reports, metrics and microapp state.
    --
    -- The UNIQUE constraint is load-bearing. setAgentData() is an UPSERT keyed
    -- on (agent, category, key); without it "set" would silently accumulate
    -- duplicate rows and getAgentData() would return an arbitrary one. The
    -- original plan specified only an id column, which cannot express that.
    CREATE TABLE IF NOT EXISTS agent_data (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      routine_id TEXT REFERENCES routines(id),
      task_run_id TEXT REFERENCES task_runs(id),
      key TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (agent_id, category, key)
    );

    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      model_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      task_run_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_artifacts (
      id TEXT PRIMARY KEY,
      task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(task_run_id, path)
    );

    CREATE TABLE IF NOT EXISTS chat_requests (
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      content TEXT NOT NULL,
      user_message_id INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('RUNNING', 'FAILED', 'COMPLETED')),
      result_json TEXT,
      PRIMARY KEY (thread_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(current_status);
    CREATE INDEX IF NOT EXISTS idx_chat_threads_agent ON chat_threads(agent_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id);
    CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_agent_data_lookup ON agent_data(agent_id, category, key);
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(task_run_id, status);
    CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_exec_events_task ON execution_events(task_run_id, timestamp);
    -- Global timestamp index for fast multi-agent recent activity feeds
    CREATE INDEX IF NOT EXISTS idx_exec_events_timestamp ON execution_events(timestamp);
  `);

  // CREATE TABLE IF NOT EXISTS is a no-op on a database that predates the
  // `layer` column, so the column has to be added explicitly for those.
  migrateExecutionEventsLayer(db);
  migrateTaskRunsRoutine(db);
  migrateRoutinesWebhookToken(db);
  migrateRoutineScheduleEnabled(db);
  const addColumn = (table: string, name: string, definition: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addColumn('agents', 'requires_approval', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('task_runs', 'task_definition_json', 'TEXT');
  addColumn('routines', 'last_run_id', 'TEXT');
  addColumn('chat_requests', 'request_scope', "TEXT NOT NULL DEFAULT 'chat'");
  addColumn('agents', 'connection_id', 'TEXT');
  addColumn('agents', 'routing_mode', 'TEXT');
  // NULL preserves existing bots' original hash(agentId) homes. Newly created
  // bots get a UUID; retired keys stay recorded and never return to circulation.
  addColumn('agents', 'desktop_key', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS retired_desktops (
    identity_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, retired_at INTEGER NOT NULL
  )`);
  addColumn('run_artifacts', 'encoding', "TEXT NOT NULL DEFAULT 'utf8'");
  addColumn('run_artifacts', 'purpose', "TEXT NOT NULL DEFAULT 'deliverable'");
  // Operator-configured inference connections. Keys exist only as protected ciphertext in
  // provider_secrets, which no settings, data, search or export path reads.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      preset TEXT NOT NULL CHECK (preset IN ('freellmapi', 'custom')),
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      requests_per_day INTEGER NOT NULL,
      tokens_per_day INTEGER NOT NULL,
      status TEXT NOT NULL,
      status_message TEXT NOT NULL,
      checked_at INTEGER,
      catalog_json TEXT,
      catalog_fetched_at INTEGER,
      tool_mode TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_secrets (
      connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id),
      ciphertext TEXT NOT NULL,
      backend TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  addColumn('provider_connections', 'tool_mode', 'TEXT');

  // Created after the migration, because the column it indexes may have just
  // been added.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_exec_events_layer ON execution_events(task_run_id, layer);`);
  // The same holds for task_runs.routine_id (migrateTaskRunsRoutine above): the
  // CREATE TABLE has no such column. The pending gate, the producer hold and
  // publish-policy seeding read a routine's runs through this index.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_routine ON task_runs(routine_id);`);
}

/**
 * Add `execution_events.layer` to a database created before the ECC layer
 * taxonomy existed.
 *
 * Additive and nullable by design: existing rows keep every field they had and
 * simply read back `layer = null`, which Cortex renders as "not attributed to a
 * layer" rather than guessing. Backfilling old rows through layerForEvent() was
 * considered and rejected - it would stamp today's taxonomy onto events emitted
 * by code that predates it, which is exactly the kind of fabricated provenance
 * this project refuses elsewhere.
 *
 * Returns true if the column was added, false if it was already present.
 */
/**
 * Link a task run back to the routine that scheduled it.
 *
 * Additive and nullable, exactly like the `layer` migration: an existing
 * database keeps every row and simply reads back routine_id = null, which is
 * the truth for runs created before routines existed.
 */
export function migrateTaskRunsRoutine(db: DatabaseSync): boolean {
  const columns = db.prepare(`PRAGMA table_info(task_runs)`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'routine_id')) return false;
  db.exec(`ALTER TABLE task_runs ADD COLUMN routine_id TEXT`);
  return true;
}

/**
 * Give a routine a webhook token, so an external system can fire it.
 *
 * Additive and nullable for the same reason as the migrations above: a routine
 * created before webhooks existed simply has no token, which reads back as "no
 * webhook trigger configured" rather than as a token nobody knows.
 *
 * The token is the whole authentication for that endpoint, so it is generated
 * with crypto randomness at the point of use, never derived from the routine id.
 */
export function migrateRoutineScheduleEnabled(db: DatabaseSync): boolean {
  const columns = db.prepare('PRAGMA table_info(routines)').all() as Array<{ name: string }>;
  if (columns.some(c => c.name === 'schedule_enabled')) return false;
  db.exec('SAVEPOINT routine_schedule_intent');
  try {
    db.exec('ALTER TABLE routines ADD COLUMN schedule_enabled INTEGER NOT NULL DEFAULT 1 CHECK (schedule_enabled IN (0, 1))');
    // Previous editors used this real leap-day schedule to mean no timetable.
    // Preserve the cron/token, including rows affected by the old lost-token bug.
    // Do this only once: new explicitly scheduled leap-day routines remain valid.
    db.prepare('UPDATE routines SET schedule_enabled = 0 WHERE trim(cron_expression) = ?').run('4 3 29 2 *');
    db.exec('RELEASE routine_schedule_intent');
    return true;
  } catch (error) {
    db.exec('ROLLBACK TO routine_schedule_intent; RELEASE routine_schedule_intent');
    throw error;
  }
}

export function migrateRoutinesWebhookToken(db: DatabaseSync): boolean {
  const columns = db.prepare(`PRAGMA table_info(routines)`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'webhook_token')) return false;
  db.exec(`ALTER TABLE routines ADD COLUMN webhook_token TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_webhook ON routines(webhook_token)`);
  return true;
}

export function migrateExecutionEventsLayer(db: DatabaseSync): boolean {
  const columns = db.prepare(`PRAGMA table_info(execution_events)`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'layer')) {
    return false;
  }
  db.exec(`ALTER TABLE execution_events ADD COLUMN layer INTEGER`);
  return true;
}
