/**
 * Agent & Task Run Store
 * Exclusive SQLite persistence layer for agent fleet state, task run lifecycle,
 * execution events, and boot crash recovery sweeps.
 *
 * The store is the SOLE owner of task lifecycle events. Executors used to emit
 * their own TASK_STARTED / TASK_<status> alongside these, which put two rows in
 * the audit log for every transition (one with an empty payload) and inflated
 * every count built on execution_events by 2x. Executors now pass their richer
 * context in through `detail` instead of emitting a second event.
 *
 * recordEvent() is also the single broadcast point: it stamps the ECC layer,
 * inserts, and then notifies the event sink. Nothing else may broadcast, or the
 * same event reaches the UI twice.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  initDaemonSchema,
  type AgentRecord,
  type AgentStatus,
  type TaskRunRecord,
  type TaskRunStatus,
  type ExecutionEventRecord,
  type ApprovalRecord,
  type ApprovalStatus,
  type ChatThreadRecord,
  type ChatMessageRecord,
  type ChatRole,
  type RoutineRecord,
  type AgentDataRecord,
  type CatchUpPolicy,
} from './db/schema.js';
import { layerForEvent, type LayerId } from '../kernel/agent-layers.js';
import { PROVISIONAL_CONFIG } from './config.js';

/** Notified after an event is committed. The single fan-out point to the UI. */
export type EventSink = (event: ExecutionEventRecord) => void;

export class AgentStore {
  private db: DatabaseSync;
  private ownsDb: boolean;
  private eventSink: EventSink | null = null;

  constructor(dbOrPath: DatabaseSync | string = PROVISIONAL_CONFIG.DB_PATH) {
    if (typeof dbOrPath === 'string') {
      if (dbOrPath !== ':memory:') {
        const dir = path.dirname(path.resolve(dbOrPath));
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new DatabaseSync(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    initDaemonSchema(this.db);
  }

  getDatabase(): DatabaseSync {
    return this.db;
  }

  /**
   * Register the one consumer of committed events (in production, the WS
   * broadcaster). Deliberately a single sink rather than a listener list: the
   * bug this replaced was two code paths publishing the same event, and a
   * multicast API would invite it back.
   *
   * A throwing sink must not lose the row that is already committed, so failures
   * are logged and swallowed here - the durable record is the audit log, not the
   * broadcast.
   */
  setEventSink(sink: EventSink | null): void {
    this.eventSink = sink;
  }

  // ===========================================================================
  // AGENT CRUD
  // ===========================================================================

  createAgent(agent: Omit<AgentRecord, 'created_at' | 'updated_at'>): AgentRecord {
    const now = Date.now();
    const record: AgentRecord = {
      ...agent,
      fallback_model_id: agent.fallback_model_id ?? null,
      system_prompt: agent.system_prompt ?? null,
      created_at: now,
      updated_at: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO agents (id, name, model_id, fallback_model_id, system_prompt, budget_cap_usd, current_status, created_at, updated_at, requires_approval, connection_id, routing_mode, desktop_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.name,
      record.model_id,
      record.fallback_model_id ?? null,
      record.system_prompt ?? null,
      record.budget_cap_usd,
      record.current_status,
      record.created_at,
      record.updated_at,
      record.requires_approval ?? 0,
      record.connection_id ?? null,
      record.connection_id ? record.routing_mode ?? 'pinned' : null,
      `desktop-${randomUUID()}`
    );

    return record;
  }

  desktopIdentity(id: string): string {
    const row = this.db.prepare('SELECT desktop_key FROM agents WHERE id = ?').get(id);
    if (!row) throw new Error(`Agent "${id}" does not exist.`);
    return row.desktop_key as string | null ?? id;
  }

  assertAgentDeletable(id: string): void {
    const inFlight = this.db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE agent_id = ? AND status IN ('QUEUED', 'RUNNING')").get(id) as { n: number };
    if (Number(inFlight.n) > 0) throw new Error(`Agent "${id}" has ${inFlight.n} task run(s) still QUEUED or RUNNING. Wait for them to finish or kill them first.`);
  }

  getAgent(id: string): AgentRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM agents WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      model_id: row.model_id,
      fallback_model_id: row.fallback_model_id ?? null,
      system_prompt: row.system_prompt,
      requires_approval: Number(row.requires_approval ?? 0),
      budget_cap_usd: Number(row.budget_cap_usd),
      current_status: row.current_status as AgentStatus,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      ...AgentStore.connectionFields(row),
    };
  }

  listAgents(): AgentRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM agents ORDER BY created_at ASC`);
    const rows = stmt.all() as any[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      model_id: row.model_id,
      fallback_model_id: row.fallback_model_id ?? null,
      system_prompt: row.system_prompt,
      requires_approval: Number(row.requires_approval ?? 0),
      budget_cap_usd: Number(row.budget_cap_usd),
      current_status: row.current_status as AgentStatus,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      ...AgentStore.connectionFields(row),
    }));
  }

  /** Only bots that chose a provider connection carry these fields, so existing records keep their exact shape. */
  private static connectionFields(row: any): Pick<AgentRecord, 'connection_id' | 'routing_mode'> {
    return row.connection_id ? { connection_id: String(row.connection_id), routing_mode: row.routing_mode === 'auto' ? 'auto' : 'pinned' } : {};
  }

  updateAgentStatus(id: string, status: AgentStatus): void {
    if (status === 'IDLE' && this.hasRunningTasks(id)) status = 'BUSY';
    const stmt = this.db.prepare(`
      UPDATE agents SET current_status = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(status, Date.now(), id);
  }

  /**
   * Routine work already queued or running for one bot.
   *
   * Two routines that came due together were both dispatched, and then fought over the
   * one browser and the one desktop that bot owns - the second would find a page the
   * first had navigated away from. A bot does one routine at a time; the next waits.
   */
  activeRoutineRuns(agentId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM task_runs WHERE agent_id = ? AND routine_id IS NOT NULL AND status IN ('QUEUED', 'RUNNING')`
    ).get(agentId) as { n: number };
    return Number(row.n);
  }

  private hasRunningTasks(agentId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM task_runs WHERE agent_id = ? AND status = 'RUNNING' LIMIT 1`).get(agentId);
  }

  /** Execution never overrides an explicit operator pause or disable. */
  private reconcileAgentStatus(agentId: string): void {
    this.db.prepare(`UPDATE agents SET current_status = ?, updated_at = ?
      WHERE id = ? AND current_status NOT IN ('PAUSED', 'DISABLED')`)
      .run(this.hasRunningTasks(agentId) ? 'BUSY' : 'IDLE', Date.now(), agentId);
  }

  setRunDefinition(runId: string, definition: unknown): void {
    this.db.prepare(`UPDATE task_runs SET task_definition_json = ? WHERE id = ? AND status = 'QUEUED'`)
      .run(JSON.stringify(definition), runId);
  }

  getRunDefinition(runId: string): unknown | null {
    const row = this.db.prepare(`SELECT task_definition_json FROM task_runs WHERE id = ?`).get(runId) as any;
    return row?.task_definition_json ? JSON.parse(row.task_definition_json) : null;
  }

  updateAgent(
    id: string,
    updates: Partial<Pick<AgentRecord, 'name' | 'model_id' | 'fallback_model_id' | 'system_prompt' | 'budget_cap_usd' | 'connection_id' | 'routing_mode'>>
  ): AgentRecord {
    const existing = this.getAgent(id);
    if (!existing) throw new Error(`Agent "${id}" does not exist.`);

    const next = { ...existing, ...updates, updated_at: Date.now() };
    const connectionId = next.connection_id ?? null;
    const routingMode = connectionId ? next.routing_mode ?? 'pinned' : null;
    this.db.prepare(`
      UPDATE agents
      SET name = ?, model_id = ?, fallback_model_id = ?, system_prompt = ?, budget_cap_usd = ?, connection_id = ?, routing_mode = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.model_id,
      next.fallback_model_id ?? null,
      next.system_prompt ?? null,
      next.budget_cap_usd,
      connectionId,
      routingMode,
      next.updated_at,
      id
    );

    const { connection_id: _connection, routing_mode: _routing, ...rest } = next;
    return connectionId ? { ...rest, connection_id: connectionId, routing_mode: routingMode } : rest;
  }

  /**
   * Delete a bot and everything that belongs to it.
   *
   * REFUSES while work is in flight. A bot with a QUEUED or RUNNING task has a
   * scheduler entry, possibly a container, and a budget reservation pointing at
   * it; deleting the row would leave all three orphaned and the run would fail
   * later for a reason nobody could trace back to here.
   *
   * The cascade is explicit and ordered child-first because these tables carry
   * real foreign keys. It is wrapped in a transaction so a failure part-way
   * through cannot leave a half-deleted bot - which would be worse than either
   * outcome, since the agents row is what every other table points at.
   *
   * Returns what was removed, so the caller can report it rather than claiming
   * a clean delete it did not verify.
   */
  deleteAgent(id: string): {
    deleted: boolean;
    taskRuns: number;
    routines: number;
    threads: number;
    messages: number;
    events: number;
    approvals: number;
    data: number;
  } {
    const agent = this.getAgent(id);
    if (!agent) {
      return { deleted: false, taskRuns: 0, routines: 0, threads: 0, messages: 0, events: 0, approvals: 0, data: 0 };
    }

    this.assertAgentDeletable(id);

    const count = (sql: string) => Number((this.db.prepare(sql).get(id) as { n: number }).n);
    const summary = {
      deleted: true,
      taskRuns: count(`SELECT COUNT(*) AS n FROM task_runs WHERE agent_id = ?`),
      routines: count(`SELECT COUNT(*) AS n FROM routines WHERE agent_id = ?`),
      threads: count(`SELECT COUNT(*) AS n FROM chat_threads WHERE agent_id = ?`),
      messages: count(
        `SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE agent_id = ?)`
      ),
      events: count(`SELECT COUNT(*) AS n FROM execution_events WHERE agent_id = ?`),
      approvals: count(`SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ?`),
      data: count(`SELECT COUNT(*) AS n FROM agent_data WHERE agent_id = ?`),
    };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO retired_desktops (identity_key, agent_id, retired_at) VALUES (?, ?, ?)').run(this.desktopIdentity(id), id, Date.now());
      this.db
        .prepare(`DELETE FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE agent_id = ?)`)
        .run(id);
      this.db.prepare(`DELETE FROM chat_threads WHERE agent_id = ?`).run(id);
      this.db.prepare(`DELETE FROM agent_data WHERE agent_id = ?`).run(id);
      this.db.prepare(`DELETE FROM approvals WHERE agent_id = ?`).run(id);
      this.db.prepare(`DELETE FROM execution_events WHERE agent_id = ?`).run(id);
      this.db.prepare(`DELETE FROM routines WHERE agent_id = ?`).run(id);
      this.db.prepare(`DELETE FROM task_runs WHERE agent_id = ?`).run(id);
      this.db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return summary;
  }

  // ===========================================================================
  // TASK RUN STATE MACHINE
  // Transitions: QUEUED -> RUNNING -> {COMPLETED, FAILED, ABORTED, CRASHED}
  // ===========================================================================

  createTaskRun(params: {
    id?: string;
    agentId: string;
    taskName: string;
    modelId?: string;
    routineId?: string | null;
  }): TaskRunRecord {
    const agent = this.getAgent(params.agentId);
    if (!agent) {
      throw new Error(`Cannot create task run: Agent "${params.agentId}" does not exist.`);
    }

    const id = params.id ?? `run-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const model_id = params.modelId ?? agent.model_id;
    const routine_id = params.routineId ?? null;
    const record: TaskRunRecord = {
      id,
      agent_id: params.agentId,
      task_name: params.taskName,
      model_id,
      status: 'QUEUED',
      turns_taken: 0,
      actual_cost_usd: 0.0,
      shadow_cost_usd: 0.0,
      error_message: null,
      started_at: null,
      completed_at: null,
      routine_id,
    };

    const stmt = this.db.prepare(`
      INSERT INTO task_runs (
        id, agent_id, task_name, model_id, status, turns_taken, actual_cost_usd, shadow_cost_usd, error_message, started_at, completed_at, routine_id
      ) VALUES (?, ?, ?, ?, 'QUEUED', 0, 0.0, 0.0, NULL, NULL, NULL, ?)
    `);

    stmt.run(record.id, record.agent_id, record.task_name, record.model_id, record.routine_id ?? null);
    return record;
  }

  getTaskRun(id: string): TaskRunRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM task_runs WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      agent_id: row.agent_id,
      task_name: row.task_name,
      model_id: row.model_id,
      status: row.status as TaskRunStatus,
      turns_taken: Number(row.turns_taken),
      actual_cost_usd: Number(row.actual_cost_usd),
      shadow_cost_usd: Number(row.shadow_cost_usd),
      error_message: row.error_message,
      started_at: row.started_at ? Number(row.started_at) : null,
      completed_at: row.completed_at ? Number(row.completed_at) : null,
      routine_id: row.routine_id ?? null,
    };
  }

  listTaskRuns(agentId?: string): TaskRunRecord[] {
    let rows: any[];
    if (agentId) {
      const stmt = this.db.prepare(`SELECT * FROM task_runs WHERE agent_id = ? ORDER BY id DESC`);
      rows = stmt.all(agentId) as any[];
    } else {
      const stmt = this.db.prepare(`SELECT * FROM task_runs ORDER BY id DESC`);
      rows = stmt.all() as any[];
    }

    return rows.map(row => ({
      id: row.id,
      agent_id: row.agent_id,
      task_name: row.task_name,
      model_id: row.model_id,
      status: row.status as TaskRunStatus,
      turns_taken: Number(row.turns_taken),
      actual_cost_usd: Number(row.actual_cost_usd),
      shadow_cost_usd: Number(row.shadow_cost_usd),
      error_message: row.error_message,
      started_at: row.started_at ? Number(row.started_at) : null,
      completed_at: row.completed_at ? Number(row.completed_at) : null,
      routine_id: row.routine_id ?? null,
    }));
  }

  countPendingTaskRuns(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE status IN ('QUEUED','RUNNING')").get() as { n: number }).n);
  }

  queuedTaskRuns(): TaskRunRecord[] {
    // Admission scans only the queue, in arrival order, regardless of the size
    // of completed history retained by a long-running installation.
    return this.db.prepare("SELECT * FROM task_runs WHERE status='QUEUED' ORDER BY rowid ASC").all() as unknown as TaskRunRecord[];
  }

  /**
   * QUEUED -> RUNNING, and the one place TASK_STARTED is written.
   *
   * `detail` carries whatever the caller knows that the store does not (which
   * executor, the wire model name). It is merged into the single lifecycle event
   * rather than emitted as a second one.
   */
  startTaskRun(taskRunId: string, modelId?: string, detail?: Record<string, unknown>): void {
    const existing = this.getTaskRun(taskRunId);
    if (!existing) {
      throw new Error(`Task run "${taskRunId}" not found.`);
    }
    if (existing.status !== 'QUEUED') {
      throw new Error(`Invalid state transition: Cannot start task run in "${existing.status}" status.`);
    }

    const now = Date.now();
    const effectiveModel = modelId ?? existing.model_id;
    const stmt = this.db.prepare(`
      UPDATE task_runs SET status = 'RUNNING', started_at = ?, model_id = ? WHERE id = ?
    `);
    stmt.run(now, effectiveModel, taskRunId);

    // Update agent status to BUSY
    this.reconcileAgentStatus(existing.agent_id);
    this.db.prepare(`UPDATE routines SET last_run_status = 'RUNNING', updated_at = ? WHERE last_run_id = ?`).run(now, taskRunId);

    this.recordEvent({
      task_run_id: taskRunId,
      agent_id: existing.agent_id,
      model_id: effectiveModel,
      event_type: 'TASK_STARTED',
      turn_number: 0,
      payload_json: JSON.stringify({
        taskName: existing.task_name,
        modelId: effectiveModel,
        startedAt: now,
        ...detail,
      }),
      timestamp: now,
    });
  }

  updateTaskRunProgress(
    taskRunId: string,
    turnsTaken: number,
    actualCostUsd: number,
    shadowCostUsd: number
  ): void {
    const stmt = this.db.prepare(`
      UPDATE task_runs
      SET turns_taken = ?, actual_cost_usd = ?, shadow_cost_usd = ?
      WHERE id = ?
    `);
    stmt.run(turnsTaken, actualCostUsd, shadowCostUsd, taskRunId);
  }

  /**
   * RUNNING -> terminal, and the one place TASK_<status> is written.
   * See startTaskRun for why `detail` exists.
   */
  finishTaskRun(
    taskRunId: string,
    status: 'COMPLETED' | 'FAILED' | 'ABORTED' | 'CRASHED',
    errorMessage?: string,
    detail?: Record<string, unknown>
  ): void {
    const existing = this.getTaskRun(taskRunId);
    if (!existing) {
      throw new Error(`Task run "${taskRunId}" not found.`);
    }
    if (existing.status !== 'RUNNING' && !(existing.status==='QUEUED'&&status!=='COMPLETED')) {
      throw new Error(`Invalid state transition: Cannot finish task run in "${existing.status}" status.`);
    }

    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE task_runs
      SET status = ?, error_message = ?, completed_at = ?
      WHERE id = ?
    `);
    stmt.run(status, errorMessage ?? null, now, taskRunId);

    // Reset agent back to IDLE
    this.reconcileAgentStatus(existing.agent_id);
    this.db.prepare(`UPDATE routines SET last_run_status = ?, updated_at = ? WHERE last_run_id = ?`).run(status, now, taskRunId);

    this.recordEvent({
      task_run_id: taskRunId,
      agent_id: existing.agent_id,
      // Attribution matters on the terminal event: the run may have failed over
      // to the fallback model mid-flight, so read it back rather than assuming.
      model_id: this.getTaskRun(taskRunId)?.model_id ?? existing.model_id,
      event_type: `TASK_${status}`,
      turn_number: existing.turns_taken,
      payload_json: JSON.stringify({
        status,
        errorMessage: errorMessage ?? null,
        completedAt: now,
        ...detail,
      }),
      timestamp: now,
    });
  }

  // ===========================================================================
  // ROUTINES
  // next_run_at is always an absolute instant, computed by the cron engine in
  // the routine's own timezone. The scheduler therefore compares integers and
  // never has to reason about wall clocks or DST.
  // ===========================================================================

  createRoutine(params: {
    id?: string;
    agentId: string;
    name: string;
    cronExpression: string;
    humanSchedule?: string | null;
    timezone?: string;
    promptTemplate: string;
    taskName?: string | null;
    enabled?: boolean;
    catchUpPolicy?: CatchUpPolicy;
    scheduleEnabled?: boolean;
    nextRunAt: number;
  }): RoutineRecord {
    if (!this.getAgent(params.agentId)) {
      throw new Error(`Cannot create routine: agent "${params.agentId}" does not exist.`);
    }
    const now = Date.now();
    const record: RoutineRecord = {
      id: params.id ?? `rtn-${now}-${Math.random().toString(36).substring(2, 7)}`,
      agent_id: params.agentId,
      name: params.name,
      cron_expression: params.cronExpression,
      human_schedule: params.humanSchedule ?? null,
      timezone: params.timezone ?? 'UTC',
      prompt_template: params.promptTemplate,
      task_name: params.taskName ?? null,
      enabled: params.enabled === false ? 0 : 1,
      catch_up_policy: params.catchUpPolicy ?? 'skip',
      schedule_enabled: params.scheduleEnabled === false ? 0 : 1,
      last_run_at: null,
      next_run_at: params.nextRunAt,
      last_run_status: null,
      created_at: now,
      updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO routines (id, agent_id, name, cron_expression, human_schedule, timezone,
        prompt_template, task_name, enabled, catch_up_policy, last_run_at, next_run_at,
        last_run_status, created_at, updated_at, schedule_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)
    `).run(
      record.id, record.agent_id, record.name, record.cron_expression,
      record.human_schedule ?? null, record.timezone, record.prompt_template, record.task_name ?? null,
      record.enabled, record.catch_up_policy, record.next_run_at, now, now, record.schedule_enabled!
    );
    return record;
  }

  getRoutine(id: string): RoutineRecord | null {
    const row = this.db.prepare(`SELECT * FROM routines WHERE id = ?`).get(id) as any;
    return row ? this.toRoutine(row) : null;
  }

  listRoutines(agentId?: string): RoutineRecord[] {
    const rows = agentId
      ? (this.db.prepare(`SELECT * FROM routines WHERE agent_id = ? ORDER BY next_run_at ASC`).all(agentId) as any[])
      : (this.db.prepare(`SELECT * FROM routines ORDER BY next_run_at ASC`).all() as any[]);
    return rows.map((r) => this.toRoutine(r));
  }

  /** Only fields an operator may change. id, agent and timestamps are not among them. */
  updateRoutine(
    id: string,
    updates: Partial<Pick<RoutineRecord,
      'name' | 'cron_expression' | 'human_schedule' | 'timezone' | 'prompt_template' |
      'task_name' | 'enabled' | 'schedule_enabled' | 'catch_up_policy' | 'next_run_at' | 'last_run_status'>>
  ): RoutineRecord {
    const existing = this.getRoutine(id);
    if (!existing) throw new Error(`Routine "${id}" not found.`);

    const allowed = [
      'name', 'cron_expression', 'human_schedule', 'timezone', 'prompt_template',
      'task_name', 'enabled', 'schedule_enabled', 'catch_up_policy', 'next_run_at', 'last_run_status',
    ] as const;
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const field of allowed) {
      if (updates[field] !== undefined) {
        sets.push(`${field} = ?`);
        args.push(updates[field] as any);
      }
    }
    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    args.push(Date.now(), id);
    this.db.prepare(`UPDATE routines SET ${sets.join(', ')} WHERE id = ?`).run(...(args as any[]));
    return this.getRoutine(id)!;
  }

  /**
   * Issue (or re-issue) a routine's webhook token.
   *
   * Re-issuing REVOKES the previous token by overwriting it, which is the
   * point: a leaked URL has to be revocable without deleting the routine.
   */
  setRoutineWebhookToken(id: string, token: string | null): RoutineRecord {
    const existing = this.getRoutine(id);
    if (!existing) throw new Error(`Routine "${id}" does not exist.`);
    this.db
      .prepare(`UPDATE routines SET webhook_token = ?, updated_at = ? WHERE id = ?`)
      .run(token, Date.now(), id);
    return this.getRoutine(id)!;
  }

  /**
   * Look a routine up by its webhook token.
   *
   * A null or empty token never matches. Without that guard every routine that
   * has no webhook configured would be reachable by presenting no token at all.
   */
  getRoutineByWebhookToken(token: string): RoutineRecord | null {
    if (!token) return null;
    const row = this.db
      .prepare(`SELECT * FROM routines WHERE webhook_token = ? AND webhook_token IS NOT NULL`)
      .get(token) as any;
    return row ? this.toRoutine(row) : null;
  }

  /**
   * Delete a routine and unlink what it produced.
   *
   * `agent_data.routine_id` references this table with no ON DELETE clause, so a
   * routine that had ever stored data could not be deleted at all: SQLite refused
   * with "FOREIGN KEY constraint failed" and the operator saw a delete that did
   * nothing. The column is nullable, so those rows are unlinked rather than removed -
   * what a bot learned while running a routine outlives the schedule that produced it.
   */
  deleteRoutine(id: string): boolean {
    return this.transaction(() => {
      this.db.prepare(`UPDATE agent_data SET routine_id = NULL WHERE routine_id = ?`).run(id);
      const res = this.db.prepare(`DELETE FROM routines WHERE id = ?`).run(id);
      return Number(res.changes) > 0;
    });
  }

  /** Enabled routines whose time has come. Ordered oldest-due first. */
  getDueRoutines(asOfEpochMs: number = Date.now()): RoutineRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM routines WHERE enabled = 1 AND schedule_enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC`)
      .all(asOfEpochMs) as any[];
    return rows.map((r) => this.toRoutine(r));
  }

  recordRoutineRun(routineId: string, taskRunId: string, status: string, nextRunAt: number): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE routines SET last_run_at = ?, next_run_at = ?, last_run_status = ?, updated_at = ?, last_run_id = ? WHERE id = ?
    `).run(now, nextRunAt, status, now, taskRunId, routineId);

    // Bind the run back to its routine so history is queryable both ways.
    this.db.prepare(`UPDATE task_runs SET routine_id = ? WHERE id = ?`).run(routineId, taskRunId);
  }

  listRoutineRuns(routineId: string): TaskRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_runs WHERE routine_id = ? ORDER BY id DESC`)
      .all(routineId) as any[];
    return rows.map((row) => ({
      id: row.id,
      agent_id: row.agent_id,
      task_name: row.task_name,
      model_id: row.model_id,
      status: row.status as TaskRunStatus,
      turns_taken: Number(row.turns_taken),
      actual_cost_usd: Number(row.actual_cost_usd),
      shadow_cost_usd: Number(row.shadow_cost_usd),
      error_message: row.error_message,
      started_at: row.started_at ? Number(row.started_at) : null,
      completed_at: row.completed_at ? Number(row.completed_at) : null,
      routine_id: row.routine_id ?? null,
    }));
  }

  private toRoutine(row: any): RoutineRecord {
    return {
      id: row.id,
      agent_id: row.agent_id,
      name: row.name,
      cron_expression: row.cron_expression,
      human_schedule: row.human_schedule ?? null,
      timezone: row.timezone,
      prompt_template: row.prompt_template,
      task_name: row.task_name ?? null,
      enabled: Number(row.enabled),
      catch_up_policy: row.catch_up_policy as CatchUpPolicy,
      schedule_enabled: Number(row.schedule_enabled),
      last_run_at: row.last_run_at ? Number(row.last_run_at) : null,
      next_run_at: Number(row.next_run_at),
      last_run_status: row.last_run_status ?? null,
      webhook_token: row.webhook_token ?? null,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  // ===========================================================================
  // AGENT DATA (reports, metrics, microapp state)
  // ===========================================================================

  /**
   * Upsert keyed on (agent, category, key).
   *
   * The UNIQUE constraint in the schema is what makes this an update rather
   * than an append; without it every "set" would add a row and reads would
   * return whichever one the query planner happened to reach first.
   */
  setAgentData(params: {
    agentId: string;
    key: string;
    category?: string;
    data: unknown;
    routineId?: string | null;
    taskRunId?: string | null;
  }): AgentDataRecord {
    if (!this.getAgent(params.agentId)) {
      throw new Error(`Cannot store data: agent "${params.agentId}" does not exist.`);
    }
    const category = params.category ?? 'general';
    const now = Date.now();
    const dataJson = JSON.stringify(params.data ?? null);

    const existing = this.getAgentData(params.agentId, params.key, category);
    if (existing) {
      this.db.prepare(`
        UPDATE agent_data SET data_json = ?, routine_id = ?, task_run_id = ?, updated_at = ? WHERE id = ?
      `).run(dataJson, params.routineId ?? null, params.taskRunId ?? null, now, existing.id);
      return { ...existing, data_json: dataJson, updated_at: now };
    }

    const record: AgentDataRecord = {
      id: `dat-${now}-${Math.random().toString(36).substring(2, 7)}`,
      agent_id: params.agentId,
      routine_id: params.routineId ?? null,
      task_run_id: params.taskRunId ?? null,
      key: params.key,
      category,
      data_json: dataJson,
      created_at: now,
      updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO agent_data (id, agent_id, routine_id, task_run_id, key, category, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.agent_id, record.routine_id ?? null, record.task_run_id ?? null,
      record.key, record.category, record.data_json, now, now
    );
    return record;
  }

  getAgentData(agentId: string, key: string, category = 'general'): AgentDataRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_data WHERE agent_id = ? AND key = ? AND category = ?`)
      .get(agentId, key, category) as any;
    return row ? this.toAgentData(row) : null;
  }

  listAgentData(agentId?: string, category?: string): AgentDataRecord[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (agentId) { clauses.push('agent_id = ?'); args.push(agentId); }
    if (category) { clauses.push('category = ?'); args.push(category); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM agent_data ${where} ORDER BY updated_at DESC`)
      .all(...(args as any[])) as any[];
    return rows.map((r) => this.toAgentData(r));
  }

  getAgentDataById(id: string): AgentDataRecord | null {
    const row = this.db.prepare(`SELECT * FROM agent_data WHERE id = ?`).get(id) as any;
    return row ? this.toAgentData(row) : null;
  }

  deleteAgentData(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM agent_data WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  private toAgentData(row: any): AgentDataRecord {
    return {
      id: row.id,
      agent_id: row.agent_id,
      routine_id: row.routine_id ?? null,
      task_run_id: row.task_run_id ?? null,
      key: row.key,
      category: row.category,
      data_json: row.data_json,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  // ===========================================================================
  // CHAT
  // Conversation is product data, kept apart from the audit log. The two are
  // linked by task_run_id: an assistant turn records which run it was billed
  // and audited under, so a reply can always be traced back to its events.
  // ===========================================================================

  createThread(params: { id?: string; agentId: string; title?: string }): ChatThreadRecord {
    const agent = this.getAgent(params.agentId);
    if (!agent) throw new Error(`Cannot create thread: agent "${params.agentId}" does not exist.`);

    const now = Date.now();
    const record: ChatThreadRecord = {
      id: params.id ?? `thr-${now}-${Math.random().toString(36).substring(2, 7)}`,
      agent_id: params.agentId,
      title: params.title?.trim() || 'New conversation',
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(`INSERT INTO chat_threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(record.id, record.agent_id, record.title, now, now);
    return record;
  }

  getThread(id: string): ChatThreadRecord | null {
    const row = this.db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(id) as any;
    return row ? this.toThread(row) : null;
  }

  listThreads(agentId?: string): ChatThreadRecord[] {
    const rows = agentId
      ? (this.db.prepare(`SELECT * FROM chat_threads WHERE agent_id = ? ORDER BY updated_at DESC`).all(agentId) as any[])
      : (this.db.prepare(`SELECT * FROM chat_threads ORDER BY updated_at DESC`).all() as any[]);
    return rows.map((r) => this.toThread(r));
  }

  /**
   * Threads plus each one's most recent message.
   *
   * The sidebar shows a last-message snippet for EVERY bot at once. Fetching a
   * full transcript per bot to find its last line is one request per bot and
   * grows without bound; this is a single correlated query instead. The preview
   * is truncated in SQL so a very long message never has to cross the wire just
   * to be cut to one line in the browser.
   */
  listThreadPreviews(agentId?: string): Array<
    ChatThreadRecord & {
      last_message_role: 'user' | 'assistant' | null;
      last_message_preview: string | null;
      last_message_at: number | null;
    }
  > {
    const sql = `
      SELECT t.*,
             m.role       AS last_message_role,
             SUBSTR(m.content, 1, 240) AS last_message_preview,
             m.created_at AS last_message_at
      FROM chat_threads t
      LEFT JOIN chat_messages m
        ON m.id = (SELECT id FROM chat_messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1)
      ${agentId ? 'WHERE t.agent_id = ?' : ''}
      ORDER BY t.updated_at DESC
    `;
    const stmt = this.db.prepare(sql);
    const rows = (agentId ? stmt.all(agentId) : stmt.all()) as any[];
    return rows.map((r) => ({
      ...this.toThread(r),
      last_message_role: (r.last_message_role as 'user' | 'assistant' | null) ?? null,
      last_message_preview: r.last_message_preview ?? null,
      last_message_at: r.last_message_at ?? null,
    }));
  }

  /** Rename a thread, e.g. from its first user message. */
  renameThread(id: string, title: string): void {
    this.db.prepare(`UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title.trim() || 'New conversation', Date.now(), id);
  }

  appendMessage(message: Omit<ChatMessageRecord, 'id' | 'created_at'> & { created_at?: number }): ChatMessageRecord {
    const thread = this.getThread(message.thread_id);
    if (!thread) throw new Error(`Cannot append: thread "${message.thread_id}" does not exist.`);

    const created_at = message.created_at ?? Date.now();
    const res = this.db.prepare(`
      INSERT INTO chat_messages (thread_id, role, content, model_id, input_tokens, output_tokens, cost_usd, task_run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.thread_id,
      message.role,
      message.content,
      message.model_id ?? null,
      message.input_tokens ?? null,
      message.output_tokens ?? null,
      message.cost_usd ?? null,
      message.task_run_id ?? null,
      created_at
    );

    // Threads sort by recency, so every append refreshes the thread.
    this.db.prepare(`UPDATE chat_threads SET updated_at = ? WHERE id = ?`).run(created_at, message.thread_id);

    return { ...message, id: Number(res.lastInsertRowid), created_at };
  }

  getMessages(threadId: string): ChatMessageRecord[] {
    const rows = this.db.prepare(`SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id ASC`).all(threadId) as any[];
    return rows.map((r) => ({
      id: Number(r.id),
      thread_id: r.thread_id,
      role: r.role as ChatRole,
      content: r.content,
      model_id: r.model_id ?? null,
      input_tokens: r.input_tokens !== null ? Number(r.input_tokens) : null,
      output_tokens: r.output_tokens !== null ? Number(r.output_tokens) : null,
      cost_usd: r.cost_usd !== null ? Number(r.cost_usd) : null,
      task_run_id: r.task_run_id ?? null,
      created_at: Number(r.created_at),
    }));
  }

  private toThread(row: any): ChatThreadRecord {
    return {
      id: row.id,
      agent_id: row.agent_id,
      title: row.title,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  // ===========================================================================
  // APPROVALS
  // A blocked run stays RUNNING. Approval is tracked in its own table rather
  // than as a task_runs status, because SQLite cannot alter a CHECK constraint
  // in place and rebuilding task_runs would put every historical row at risk.
  // ===========================================================================

  createApproval(params: {
    id?: string;
    taskRunId: string;
    agentId: string;
    kind: string;
    payload?: Record<string, unknown>;
  }): ApprovalRecord {
    const now = Date.now();
    const record: ApprovalRecord = {
      id: params.id ?? `apr-${now}-${Math.random().toString(36).substring(2, 7)}`,
      task_run_id: params.taskRunId,
      agent_id: params.agentId,
      kind: params.kind,
      payload_json: JSON.stringify(params.payload ?? {}),
      status: 'PENDING',
      reason: null,
      created_at: now,
      decided_at: null,
    };

    this.db.prepare(`
      INSERT INTO approvals (id, task_run_id, agent_id, kind, payload_json, status, reason, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, ?, NULL)
    `).run(record.id, record.task_run_id, record.agent_id, record.kind, record.payload_json, now);

    this.recordEvent({
      task_run_id: record.task_run_id,
      agent_id: record.agent_id,
      event_type: 'APPROVAL_REQUESTED',
      payload_json: JSON.stringify({ approvalId: record.id, kind: record.kind, ...(params.payload ?? {}) }),
      timestamp: now,
    });

    return record;
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as any;
    return row ? this.toApproval(row) : null;
  }

  listApprovals(params: { taskRunId?: string; pendingOnly?: boolean } = {}): ApprovalRecord[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.taskRunId) {
      clauses.push('task_run_id = ?');
      args.push(params.taskRunId);
    }
    if (params.pendingOnly) clauses.push(`status = 'PENDING'`);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM approvals ${where} ORDER BY created_at ASC`).all(...(args as any[])) as any[];
    return rows.map((r) => this.toApproval(r));
  }

  /**
   * Record an operator decision.
   *
   * Only a PENDING approval can be decided. Re-deciding one would let a late
   * click silently reverse a verdict the agent has already acted on, so it
   * throws rather than overwriting.
   */
  decideApproval(id: string, status: Exclude<ApprovalStatus, 'PENDING'>, reason?: string): ApprovalRecord {
    const existing = this.getApproval(id);
    if (!existing) throw new Error(`Approval "${id}" not found.`);
    if (existing.status !== 'PENDING') {
      throw new Error(
        `Approval "${id}" was already ${existing.status}. A decided approval cannot be changed.`
      );
    }

    const now = Date.now();
    this.db.prepare(`UPDATE approvals SET status = ?, reason = ?, decided_at = ? WHERE id = ?`)
      .run(status, reason ?? null, now, id);

    this.recordEvent({
      task_run_id: existing.task_run_id,
      agent_id: existing.agent_id,
      event_type: 'APPROVAL_DECIDED',
      payload_json: JSON.stringify({ approvalId: id, kind: existing.kind, status, reason: reason ?? null }),
      timestamp: now,
    });

    return { ...existing, status, reason: reason ?? null, decided_at: now };
  }

  /**
   * Boot sweep: a pending approval from a dead daemon can never be answered,
   * because the promise that was waiting on it died with the process. Expiring
   * it is honest; leaving it PENDING would show the operator a decision that
   * does nothing.
   */
  expireStaleApprovals(): number {
    const stale = this.db.prepare(`SELECT * FROM approvals WHERE status = 'PENDING'`).all() as any[];
    if (stale.length === 0) return 0;
    const now = Date.now();
    const update = this.db.prepare(`UPDATE approvals SET status = 'EXPIRED', decided_at = ? WHERE id = ?`);
    for (const row of stale) {
      update.run(now, row.id);
      this.recordEvent({
        task_run_id: row.task_run_id,
        agent_id: row.agent_id,
        event_type: 'APPROVAL_DECIDED',
        payload_json: JSON.stringify({
          approvalId: row.id,
          kind: row.kind,
          status: 'EXPIRED',
          reason: 'The daemon restarted while this approval was pending; nothing was waiting for it any more.',
        }),
        timestamp: now,
      });
    }
    return stale.length;
  }

  private toApproval(row: any): ApprovalRecord {
    return {
      id: row.id,
      task_run_id: row.task_run_id,
      agent_id: row.agent_id,
      kind: row.kind,
      payload_json: row.payload_json,
      status: row.status as ApprovalStatus,
      reason: row.reason ?? null,
      created_at: Number(row.created_at),
      decided_at: row.decided_at ? Number(row.decided_at) : null,
    };
  }

  // ===========================================================================
  // EXECUTION EVENTS STREAM & AUDIT LOG
  // ===========================================================================

  /** Events recorded inside transaction(), published only after that transaction commits. */
  private deferredEvents: ExecutionEventRecord[] | null = null;

  /**
   * One synchronous durable unit. Inside a transaction this method opened, a
   * nested call joins it instead of nesting BEGIN. Events recorded under the
   * outermost call reach the sink only after COMMIT and are discarded on
   * ROLLBACK, so no observer sees a change that did not persist.
   *
   * A raw external BEGIN has no deferred event buffer, so joining it could
   * broadcast a change that later rolls back. That ownership is refused.
   * Direct recordEvent() calls inside raw transactions still publish at once;
   * the remaining raw-transaction callers record no events before COMMIT.
   */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) {
      if (!this.deferredEvents) throw new Error('store.transaction() cannot join a transaction it did not open; start the outer unit with store.transaction().');
      return fn();
    }
    this.db.exec('BEGIN IMMEDIATE');
    const deferred: ExecutionEventRecord[] = [];
    this.deferredEvents = deferred;
    try {
      const value = fn();
      if (value instanceof Promise) throw new Error('Store transactions must be synchronous.');
      this.db.exec('COMMIT');
      this.deferredEvents = null;
      for (const event of deferred) this.publish(event);
      return value;
    } catch (error) {
      this.deferredEvents = null;
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordEvent(event: ExecutionEventRecord): ExecutionEventRecord {
    // Callers may pin a layer explicitly; otherwise the taxonomy decides. null
    // is a valid answer for an unmapped event type - it is still recorded, it
    // just does not attribute to a ring in Cortex.
    const layer = event.layer ?? layerForEvent(event.event_type);

    const stmt = this.db.prepare(`
      INSERT INTO execution_events (task_run_id, agent_id, model_id, event_type, turn_number, payload_json, timestamp, layer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      event.task_run_id,
      event.agent_id,
      event.model_id ?? null,
      event.event_type,
      event.turn_number ?? null,
      event.payload_json,
      event.timestamp,
      layer
    );

    const saved: ExecutionEventRecord = {
      ...event,
      layer,
      id: Number(res.lastInsertRowid),
    };

    if (this.deferredEvents) this.deferredEvents.push(saved);
    else this.publish(saved);
    return saved;
  }

  private publish(saved: ExecutionEventRecord): void {
    if (!this.eventSink) return;
    try {
      this.eventSink(saved);
    } catch (err: any) {
      // The row is already durable. A broken transport must not fail the write.
      console.error(`[AgentStore] Event sink threw for ${saved.event_type}: ${err?.message ?? err}`);
    }
  }

  getTaskEvents(taskRunId: string): ExecutionEventRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM execution_events WHERE task_run_id = ? ORDER BY id ASC
    `);
    const rows = stmt.all(taskRunId) as any[];
    return rows.map(r => ({
      id: Number(r.id),
      task_run_id: r.task_run_id,
      agent_id: r.agent_id,
      model_id: r.model_id ?? null,
      event_type: r.event_type,
      turn_number: r.turn_number !== null ? Number(r.turn_number) : null,
      payload_json: r.payload_json,
      timestamp: Number(r.timestamp),
      layer: r.layer !== null && r.layer !== undefined ? (Number(r.layer) as LayerId) : null,
    }));
  }

  getLatestTaskEvent(taskRunId: string, eventType: string): ExecutionEventRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM execution_events
      WHERE task_run_id = ? AND event_type = ?
      ORDER BY id DESC
      LIMIT 1
    `);
    const r = stmt.get(taskRunId, eventType) as any;
    if (!r) return null;
    return {
      id: Number(r.id),
      task_run_id: r.task_run_id,
      agent_id: r.agent_id,
      model_id: r.model_id ?? null,
      event_type: r.event_type,
      turn_number: r.turn_number !== null ? Number(r.turn_number) : null,
      payload_json: r.payload_json,
      timestamp: Number(r.timestamp),
      layer: r.layer !== null && r.layer !== undefined ? (Number(r.layer) as LayerId) : null,
    };
  }

  getStepCounts(runIds: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    if (!runIds || runIds.length === 0) return counts;
    for (const id of runIds) counts[id] = 0;
    const placeholders = runIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT task_run_id, COUNT(*) as step_count
      FROM execution_events
      WHERE event_type = 'WORK_ACTION' AND task_run_id IN (${placeholders})
      GROUP BY task_run_id
    `);
    const rows = stmt.all(...runIds) as any[];
    for (const row of rows) {
      if (row.task_run_id) {
        counts[row.task_run_id] = Number(row.step_count) || 0;
      }
    }
    return counts;
  }

  /**
   * Retention Policy: Prune execution events older than specified retention cutoff.
   * Prevents unbounded storage growth on 24/7 continuous runs.
   */
  pruneOldEvents(retentionDays = PROVISIONAL_CONFIG.EVENT_RETENTION_DAYS): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(`DELETE FROM execution_events WHERE timestamp < ?`);
    const res = stmt.run(cutoff);
    return Number(res.changes);
  }

  // ===========================================================================
  // BOOT RECOVERY SWEEP: CRASHED DISCRIMINATION
  // Finds orphaned RUNNING tasks from daemon crashes and marks them CRASHED
  // ===========================================================================

  markInFlightAsCrashed(sweepReason = 'Daemon startup crash sweep: previous process terminated abruptly'): number {
    const stmt = this.db.prepare(`SELECT * FROM task_runs WHERE status = 'RUNNING'`);
    const orphaned = stmt.all() as any[];

    if (orphaned.length === 0) {
      return 0;
    }

    const now = Date.now();
    const updateStmt = this.db.prepare(`
      UPDATE task_runs
      SET status = 'CRASHED', error_message = ?, completed_at = ?
      WHERE id = ?
    `);

    for (const run of orphaned) {
      updateStmt.run(sweepReason, now, run.id);

      // Reset agent status
      this.reconcileAgentStatus(run.agent_id);
      this.db.prepare(`UPDATE routines SET last_run_status = 'CRASHED', updated_at = ? WHERE last_run_id = ?`).run(now, run.id);

      // Record crash event
      this.recordEvent({
        task_run_id: run.id,
        agent_id: run.agent_id,
        model_id: run.model_id ?? null,
        event_type: 'TASK_CRASHED',
        turn_number: Number(run.turns_taken),
        payload_json: JSON.stringify({
          sweepReason,
          crashedAt: now,
          previousStatus: 'RUNNING',
        }),
        timestamp: now,
      });
    }

    return orphaned.length;
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
