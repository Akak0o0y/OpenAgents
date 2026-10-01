/**
 * Cost Ledger & Pre-Dispatch Budget Watchdog
 * Uses Node.js native zero-dependency SQLite (DatabaseSync) in WAL mode.
 * Implements pre-dispatch cost reservations, post-call reconciliation,
 * budget circuit breakers, crash-recovery expiry sweeps distinguishing
 * dispatched vs undispatched crashes, and hard budget enforcement.
 */

import { DatabaseSync } from 'node:sqlite';
import { MODEL_PRICING, type CostReservation, type BudgetCheckResult, type CostRate } from './types.js';

export class BudgetExceededError extends Error {
  public readonly code = 'BUDGET_EXCEEDED' as const;
  public readonly budgetCapUsd: number;
  public readonly currentSpendUsd: number;
  public readonly estimatedCostUsd: number;

  constructor(reason: string, details?: { budgetCapUsd?: number; currentSpendUsd?: number; estimatedCostUsd?: number }) {
    super(`BudgetExceeded: ${reason}`);
    this.name = 'BudgetExceededError';
    this.budgetCapUsd = details?.budgetCapUsd ?? 0;
    this.currentSpendUsd = details?.currentSpendUsd ?? 0;
    this.estimatedCostUsd = details?.estimatedCostUsd ?? 0;
  }
}

export function isBudgetExceededError(err: unknown): err is BudgetExceededError {
  return (
    err instanceof BudgetExceededError ||
    (typeof err === 'object' && err !== null && (err as any).code === 'BUDGET_EXCEEDED') ||
    (err instanceof Error && err.message.startsWith('BudgetExceeded'))
  );
}

export class RateLimitExceededError extends Error {
  public readonly code = 'RATE_LIMITED' as const;
  public readonly status: number;
  public readonly attempts: number;
  public readonly limitSource?: string;
  public readonly resetAt?: string;
  public readonly rawBody?: string;

  constructor(
    reason: string,
    details?: {
      status?: number;
      attempts?: number;
      limitSource?: string;
      resetAt?: string;
      rawBody?: string;
    }
  ) {
    super(`RateLimitExceeded: ${reason}`);
    this.name = 'RateLimitExceededError';
    this.status = details?.status ?? 429;
    this.attempts = details?.attempts ?? 1;
    this.limitSource = details?.limitSource;
    this.resetAt = details?.resetAt;
    this.rawBody = details?.rawBody;
  }
}

export function isRateLimitExceededError(err: unknown): err is RateLimitExceededError {
  return (
    err instanceof RateLimitExceededError ||
    (typeof err === 'object' && err !== null && (err as any).code === 'RATE_LIMITED') ||
    (err instanceof Error && (err.name === 'RateLimitExceededError' || err.message.startsWith('RateLimitExceeded')))
  );
}

const DYNAMIC_MODEL_PRICING: Map<string, CostRate> = new Map();

export function registerModelPricing(modelId: string, rate: CostRate): void {
  DYNAMIC_MODEL_PRICING.set(modelId, rate);
}

export function registerManyModelPricing(pricing: Record<string, CostRate>): void {
  for (const [k, v] of Object.entries(pricing)) {
    DYNAMIC_MODEL_PRICING.set(k, v);
  }
}

export function getRegisteredModels(): string[] {
  const dynamicKeys = Array.from(DYNAMIC_MODEL_PRICING.keys());
  const staticKeys = Object.keys(MODEL_PRICING);
  return Array.from(new Set([...staticKeys, ...dynamicKeys]));
}

export function clearDynamicPricing(): void {
  DYNAMIC_MODEL_PRICING.clear();
}

export function getModelPricing(modelId: string): CostRate {
  const dynamic = DYNAMIC_MODEL_PRICING.get(modelId);
  if (dynamic) return dynamic;
  const staticRate = MODEL_PRICING[modelId];
  if (staticRate) return staticRate;

  const allModels = getRegisteredModels();
  const sample = allModels.slice(0, 20).join(', ') + (allModels.length > 20 ? `... (${allModels.length} total models)` : '');
  throw new Error(
    `Unknown modelId "${modelId}". Must be one of registered models: ${sample}`
  );
}

/** Admission for a gateway connection whose price OpenAgents cannot know. The pool is counted once per connection, not per model. */
export interface ConnectionAdmission {
  connectionId: string;
  routingMode: 'pinned' | 'auto';
  requestsPerDay: number;
  tokensPerDay: number;
}

const ADMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Requests and tokens a connection used in the rolling 24-hour window. Calls without reconciled usage count their estimate. */
export function connectionAdmissionUsage(db: DatabaseSync, connectionId: string, now = Date.now()): { requestsLast24h: number; tokensLast24h: number } {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cost_reservations'").get()) return { requestsLast24h: 0, tokensLast24h: 0 };
  const row = db.prepare(`SELECT COUNT(*) AS requests,
      TOTAL(CASE WHEN status = 'RECONCILED' AND input_tokens IS NOT NULL THEN input_tokens + output_tokens ELSE COALESCE(estimated_tokens, 0) END) AS tokens
    FROM cost_reservations WHERE connection_id = ? AND created_at >= ? AND status IN ('PENDING', 'RECONCILED', 'UNRECONCILED_ASSUMED_SPENT')`)
    .get(connectionId, now - ADMISSION_WINDOW_MS) as { requests: number; tokens: number };
  return { requestsLast24h: Number(row.requests), tokensLast24h: Number(row.tokens) };
}

export class CostLedger {
  private db: DatabaseSync;
  private ownsDb: boolean;

  constructor(dbOrPath: DatabaseSync | string = ':memory:') {
    if (typeof dbOrPath === 'string') {
      this.db = new DatabaseSync(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`PRAGMA journal_mode = WAL;`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_reservations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        actual_cost_usd REAL,
        shadow_cost_usd REAL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'RECONCILED', 'EXPIRED_UNDISPATCHED', 'UNRECONCILED_ASSUMED_SPENT')),
        created_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reservations_agent ON cost_reservations(agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_reservations_task ON cost_reservations(task_id);
    `);
    // Gateway connections: price unknown, admission bounded, requested versus served identity retained.
    const columns = new Set((this.db.prepare('PRAGMA table_info(cost_reservations)').all() as Array<{ name: string }>).map(c => c.name));
    for (const [name, definition] of [['connection_id', 'TEXT'], ['pricing_state', "TEXT NOT NULL DEFAULT 'known'"], ['routing_mode', 'TEXT'],
      ['estimated_tokens', 'INTEGER'], ['served_model', 'TEXT'], ['usage_source', 'TEXT'], ['sponsor_agent_id', 'TEXT']] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE cost_reservations ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_reservations_connection ON cost_reservations(connection_id, created_at)');
  }

  /**
   * Pre-dispatch cost reservation:
   * Writes the estimated maximum spend to the ledger BEFORE dispatching the LLM call.
   * If the process crashes mid-turn, spend is accounted for rather than forgotten.
   */
  reserve(
    taskId: string,
    agentId: string,
    modelId: string,
    estimatedTokens = 20000,
    ttlSeconds = 900 // 15 minutes TTL
  ): CostReservation {
    const rate = getModelPricing(modelId);
    // Conservative estimate assuming 70% input, 30% output
    const estimatedCostUsd = (
      (estimatedTokens * 0.7 * rate.inputPerMillion) / 1_000_000 +
      (estimatedTokens * 0.3 * rate.outputPerMillion) / 1_000_000
    );

    const now = Date.now();
    const id = `res-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const expiresAt = now + ttlSeconds * 1000;

    const stmt = this.db.prepare(`
      INSERT INTO cost_reservations (
        id, task_id, agent_id, model_id, estimated_cost_usd, status, created_at, dispatched_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?)
    `);

    stmt.run(id, taskId, agentId, modelId, estimatedCostUsd, now, expiresAt);

    return {
      id,
      taskId,
      agentId,
      modelId,
      estimatedCostUsd,
      status: 'PENDING',
      createdAt: now,
      dispatchedAt: null,
      expiresAt,
    };
  }

  /**
   * Mark a reservation as dispatched:
   * Called immediately before emitting the network request to the provider API.
   * If a crash occurs after this point, the expiry sweep will NOT zero the cost.
   */
  markDispatched(reservationId: string): void {
    const stmt = this.db.prepare(`
      UPDATE cost_reservations
      SET dispatched_at = ?
      WHERE id = ? AND status = 'PENDING'
    `);
    stmt.run(Date.now(), reservationId);
  }

  /** A request that provably never left OpenAgents (its connection could not be resolved) spent nothing. */
  releaseUnsent(reservationId: string): void {
    this.db.prepare(`UPDATE cost_reservations SET status = 'EXPIRED_UNDISPATCHED' WHERE id = ? AND status = 'PENDING'`).run(reservationId);
  }

  /**
   * Post-dispatch reconciliation:
   * Replaces the estimated cost with the exact measured token usage.
   */
  reconcile(
    reservationId: string,
    inputTokens: number,
    outputTokens: number,
    detail: { servedModel?: string | null } = {}
  ): { actualCostUsd: number; shadowCostUsd: number; pricingKnown: boolean } {
    const row = this.db.prepare(`
      SELECT model_id, pricing_state FROM cost_reservations WHERE id = ?
    `).get(reservationId) as { model_id: string; pricing_state: string } | undefined;

    if (!row) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    // Sonnet 5 baseline for economic comparability ($3.00/M in, $15.00/M out)
    const sonnetRate = MODEL_PRICING['claude-sonnet-5'] ?? { inputPerMillion: 3.0, outputPerMillion: 15.0 };
    const shadowCostUsd = (
      (inputTokens * sonnetRate.inputPerMillion) / 1_000_000 +
      (outputTokens * sonnetRate.outputPerMillion) / 1_000_000
    );

    if (row.pricing_state === 'unknown') {
      // Gateway-reported tokens are kept; the cost stays NULL (unknown), never zero.
      this.db.prepare(`UPDATE cost_reservations SET actual_cost_usd = NULL, shadow_cost_usd = ?, input_tokens = ?, output_tokens = ?, status = 'RECONCILED',
        served_model = ?, usage_source = 'gateway-reported' WHERE id = ?`).run(shadowCostUsd, inputTokens, outputTokens, detail.servedModel ?? null, reservationId);
      return { actualCostUsd: 0, shadowCostUsd, pricingKnown: false };
    }

    const rate = getModelPricing(row.model_id);
    const actualCostUsd = (
      (inputTokens * rate.inputPerMillion) / 1_000_000 +
      (outputTokens * rate.outputPerMillion) / 1_000_000
    );

    const stmt = this.db.prepare(`
      UPDATE cost_reservations
      SET actual_cost_usd = ?, shadow_cost_usd = ?, input_tokens = ?, output_tokens = ?, status = 'RECONCILED'
      WHERE id = ?
    `);

    stmt.run(actualCostUsd, shadowCostUsd, inputTokens, outputTokens, reservationId);
    return { actualCostUsd, shadowCostUsd, pricingKnown: true };
  }

  /**
   * Close out a dispatched reservation whose real token usage we never learned.
   *
   * This exists for agentic CLI executors: an external agent (OpenCode) makes its
   * own provider calls, so if it reports no usage there is nothing to reconcile.
   * The request WAS sent, so the estimate must stand rather than collapse to zero -
   * silently recording $0 would let a task run free against its budget cap.
   *
   * Same semantics as the dispatched branch of sweepStaleReservations(), applied
   * to one reservation on demand instead of waiting for it to go stale.
   */
  markUnreconciledAssumedSpent(reservationId: string): { assumedCostUsd: number } {
    const row = this.db.prepare(`
      SELECT estimated_cost_usd, dispatched_at FROM cost_reservations WHERE id = ?
    `).get(reservationId) as { estimated_cost_usd: number; dispatched_at: number | null } | undefined;

    if (!row) {
      throw new Error(`Reservation ${reservationId} not found`);
    }
    if (row.dispatched_at === null) {
      throw new Error(
        `Reservation ${reservationId} was never dispatched; cannot assume it was spent. ` +
        `Call markDispatched() before the request, or let the sweep expire it.`
      );
    }

    this.db.prepare(`
      UPDATE cost_reservations
      SET status = 'UNRECONCILED_ASSUMED_SPENT', actual_cost_usd = CASE WHEN pricing_state = 'unknown' THEN NULL ELSE estimated_cost_usd END
      WHERE id = ?
    `).run(reservationId);

    return { assumedCostUsd: row.estimated_cost_usd };
  }

  /**
   * Boot-time and periodic expiry sweep:
   * Resolves the crash-recovery undercount ambiguity:
   * 1. If dispatched_at is NULL: the daemon crashed before sending the request. Provider was
   *    never called. Safe to zero out -> EXPIRED_UNDISPATCHED.
   * 2. If dispatched_at is NOT NULL: the request was sent to the provider. Provider charged us.
   *    Preserve estimated cost -> UNRECONCILED_ASSUMED_SPENT so budget isn't undercounted.
   */
  sweepStaleReservations(): { 
    expiredUndispatchedCount: number; 
    reclaimedUsd: number; 
    assumedSpentCount: number; 
    assumedSpentUsd: number; 
  } {
    const now = Date.now();
    
    const staleRows = this.db.prepare(`
      SELECT id, estimated_cost_usd, dispatched_at FROM cost_reservations
      WHERE status = 'PENDING' AND expires_at <= ?
    `).all(now) as { id: string; estimated_cost_usd: number; dispatched_at: number | null }[];

    let expiredUndispatchedCount = 0;
    let reclaimedUsd = 0;
    let assumedSpentCount = 0;
    let assumedSpentUsd = 0;

    for (const row of staleRows) {
      if (row.dispatched_at === null) {
        this.db.prepare(`
          UPDATE cost_reservations
          SET status = 'EXPIRED_UNDISPATCHED'
          WHERE id = ?
        `).run(row.id);
        expiredUndispatchedCount++;
        reclaimedUsd += row.estimated_cost_usd;
      } else {
        this.db.prepare(`
          UPDATE cost_reservations
          SET status = 'UNRECONCILED_ASSUMED_SPENT', actual_cost_usd = CASE WHEN pricing_state = 'unknown' THEN NULL ELSE estimated_cost_usd END
          WHERE id = ?
        `).run(row.id);
        assumedSpentCount++;
        assumedSpentUsd += row.estimated_cost_usd;
      }
    }

    return {
      expiredUndispatchedCount,
      reclaimedUsd,
      assumedSpentCount,
      assumedSpentUsd,
    };
  }

  /**
   * Pre-dispatch budget watchdog:
   * Verifies whether an agent's cumulative spend (reconciled + assumed + pending)
   * plus the projected cost of the next turn exceeds the task's budget cap.
   */
  checkBudget(
    agentId: string,
    budgetCapUsd: number,
    estimatedTokens = 20000,
    modelId: string = 'claude-sonnet-5'
  ): BudgetCheckResult {
    const rate = getModelPricing(modelId);
    const nextEstimatedCost = (
      (estimatedTokens * 0.7 * rate.inputPerMillion) / 1_000_000 +
      (estimatedTokens * 0.3 * rate.outputPerMillion) / 1_000_000
    );

    const spend = this.getAgentSpend(agentId);
    const projectedTotal = spend.totalUsd + nextEstimatedCost;
    const remainingUsd = Math.max(0, budgetCapUsd - spend.totalUsd);

    if (projectedTotal > budgetCapUsd) {
      return {
        allowed: false,
        currentSpendUsd: spend.totalUsd,
        budgetCapUsd,
        estimatedCostUsd: nextEstimatedCost,
        remainingUsd,
        reason: `Projected spend ($${projectedTotal.toFixed(4)}) exceeds budget cap ($${budgetCapUsd.toFixed(4)}). Current spend: $${spend.totalUsd.toFixed(4)}, next turn estimate: $${nextEstimatedCost.toFixed(4)}.`,
      };
    }

    return {
      allowed: true,
      currentSpendUsd: spend.totalUsd,
      budgetCapUsd,
      estimatedCostUsd: nextEstimatedCost,
      remainingUsd,
    };
  }

  /**
   * Explicit bounded admission for a connection whose price is unknown: requests and tokens over a rolling
   * 24-hour window, counted once for the whole connection. The row is marked pricing_state 'unknown'; its
   * zero estimated_cost_usd is a column requirement, never a price.
   */
  private reserveUnpriced(taskId: string, agentId: string, modelId: string, connection: ConnectionAdmission, estimatedTokens: number, ttlSeconds: number): CostReservation {
    const now = Date.now();
    const used = connectionAdmissionUsage(this.db, connection.connectionId, now);
    if (used.requestsLast24h + 1 > connection.requestsPerDay) {
      throw new BudgetExceededError(`Provider connection admission limit reached: ${used.requestsLast24h} of ${connection.requestsPerDay} requests in the last 24 hours. Its price is unknown, so OpenAgents keeps to the limit you configured.`);
    }
    if (used.tokensLast24h + estimatedTokens > connection.tokensPerDay) {
      throw new BudgetExceededError(`Provider connection admission limit reached: ${Math.round(used.tokensLast24h)} tokens used and about ${estimatedTokens} needed, against ${connection.tokensPerDay} per 24 hours. Its price is unknown, so OpenAgents keeps to the limit you configured.`);
    }
    const id = `res-${now}-${Math.random().toString(36).substring(2, 7)}`;
    const expiresAt = now + ttlSeconds * 1000;
    this.db.prepare(`INSERT INTO cost_reservations (id, task_id, agent_id, model_id, estimated_cost_usd, status, created_at, dispatched_at, expires_at,
        connection_id, pricing_state, routing_mode, estimated_tokens) VALUES (?, ?, ?, ?, 0, 'PENDING', ?, NULL, ?, ?, 'unknown', ?, ?)`)
      .run(id, taskId, agentId, modelId, now, expiresAt, connection.connectionId, connection.routingMode, estimatedTokens);
    return { id, taskId, agentId, modelId, estimatedCostUsd: 0, status: 'PENDING', createdAt: now, dispatchedAt: null, expiresAt };
  }

  /**
   * Enforce budget check and reserve atomically:
   * Refuses to reserve and throws if budget cap would be exceeded.
   */
  reserveWithBudgetCheck(
    taskId: string,
    agentId: string,
    modelId: string,
    budgetCapUsd: number,
    estimatedTokens = 20000,
    ttlSeconds = 900,
    connection?: ConnectionAdmission,
    sponsor?: { agentId: string; budgetCapUsd: number }
  ): CostReservation {
    if (sponsor && sponsor.agentId !== agentId) {
      if (connection) throw new Error('Cross-bot delegation requires known model pricing to enforce the parent budget.');
      const parentCheck = this.checkBudget(sponsor.agentId, sponsor.budgetCapUsd, estimatedTokens, modelId);
      if (!parentCheck.allowed) throw new BudgetExceededError(parentCheck.reason ?? 'Parent budget cap exceeded', {
        budgetCapUsd: sponsor.budgetCapUsd, currentSpendUsd: parentCheck.currentSpendUsd, estimatedCostUsd: parentCheck.estimatedCostUsd,
      });
    }
    // A gateway connection's price is unknown: never priced as a fixed model and never recorded as free.
    if (connection) return this.reserveUnpriced(taskId, agentId, modelId, connection, estimatedTokens, ttlSeconds);
    const check = this.checkBudget(agentId, budgetCapUsd, estimatedTokens, modelId);
    if (!check.allowed) {
      throw new BudgetExceededError(check.reason ?? 'Budget cap exceeded', {
        budgetCapUsd,
        currentSpendUsd: check.currentSpendUsd,
        estimatedCostUsd: check.estimatedCostUsd,
      });
    }
    const reservation = this.reserve(taskId, agentId, modelId, estimatedTokens, ttlSeconds);
    if (sponsor && sponsor.agentId !== agentId) this.db.prepare('UPDATE cost_reservations SET sponsor_agent_id = ? WHERE id = ?').run(sponsor.agentId, reservation.id);
    return reservation;
  }

  /**
   * Compute total active spend for an agent (reconciled actuals + active pending + assumed spent).
   * Also computes normalized shadow cost under Sonnet 5 benchmark rates.
   * Excludes EXPIRED_UNDISPATCHED (which represents aborted turns that cost zero).
   */
  getAgentSpend(agentId: string, sinceTimestamp = 0): { 
    totalUsd: number; 
    totalShadowUsd: number;
    reconciledUsd: number; 
    pendingReservationsUsd: number;
    assumedSpentUsd: number; 
  } {
    const row = this.db.prepare(`
      SELECT 
        TOTAL(CASE WHEN status = 'RECONCILED' THEN actual_cost_usd ELSE 0 END) as reconciled_usd,
        TOTAL(CASE WHEN status = 'RECONCILED' THEN shadow_cost_usd ELSE 0 END) as shadow_usd,
        TOTAL(CASE WHEN status = 'PENDING' THEN estimated_cost_usd ELSE 0 END) as pending_usd,
        TOTAL(CASE WHEN status = 'UNRECONCILED_ASSUMED_SPENT' THEN actual_cost_usd ELSE 0 END) as assumed_spent_usd
      FROM cost_reservations
      WHERE (agent_id = ? OR sponsor_agent_id = ?) AND created_at >= ? AND status IN ('PENDING', 'RECONCILED', 'UNRECONCILED_ASSUMED_SPENT')
    `).get(agentId, agentId, sinceTimestamp) as { reconciled_usd: number; shadow_usd: number; pending_usd: number; assumed_spent_usd: number };

    return {
      totalUsd: row.reconciled_usd + row.pending_usd + row.assumed_spent_usd,
      totalShadowUsd: row.shadow_usd,
      reconciledUsd: row.reconciled_usd,
      pendingReservationsUsd: row.pending_usd,
      assumedSpentUsd: row.assumed_spent_usd,
    };
  }

  close() {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
