/**
 * Usage summary.
 *
 * The settings surface shows what this installation has actually spent. Every
 * number here comes from `task_runs.actual_cost_usd`, which is the reconciled
 * figure the cost ledger wrote after a dispatch - including chat turns, which
 * create a task run of their own precisely so their spend is auditable in the
 * same place.
 *
 * There is no plan, quota, trial or invoice in this runtime. The response says
 * so explicitly rather than leaving the UI to invent one: a per-agent budget cap
 * is a spend limit the operator configured, not a subscription.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { LocalUsageReport } from './local-usage.js';
import { connectionAdmissionUsage } from '../kernel/cost-ledger.js';

export interface AgentUsage {
  agentId: string;
  name: string;
  /** The operator-configured spend cap for this bot, in USD. */
  budgetCapUsd: number;
  /** Reconciled spend across every run this bot has completed. */
  spentUsd: number;
  runCount: number;
  /** Runs that ended in FAILED, ABORTED or CRASHED. */
  failedRunCount: number;
  lastRunAt: number | null;
  /** Calls through gateway connections whose price is unknown. Their cost is excluded from spentUsd, not counted as zero. */
  unpricedCallCount: number;
  unpricedTokens: number;
}

/** A gateway connection's pool, shown once per connection rather than once per model. */
export interface ConnectionPoolUsage {
  connectionId: string;
  name: string;
  requestsLast24h: number;
  tokensLast24h: number;
  requestsPerDay: number;
  tokensPerDay: number;
  /** A gateway's own quota view (e.g. FreeLLMAPI live monthly token budget). */
  gatewayQuota: {
    available: boolean;
    reason?: string;
    totalBudget?: number;
    totalUsed?: number;
    models?: Array<{
      id: string;
      displayName?: string;
      platform?: string;
      totalBudget?: number;
      totalUsed?: number;
      rpmLimit?: number;
      rpdLimit?: number;
      status?: string;
    }>;
  };
}

export interface UsageSummary {
  agents: AgentUsage[];
  totalSpentUsd: number;
  totalBudgetCapUsd: number;
  totalRunCount: number;
  connections: ConnectionPoolUsage[];
  /** Oldest run this database still holds, so a total is never read as all-time when it is not. */
  since: number | null;
  /** Stated so the UI never renders a billing promise this runtime cannot keep. */
  billing: {
    supported: false;
    reason: string;
  };
  /**
   * Token usage from OTHER coding tools on this machine, read from the session
   * logs they already write. Null when the daemon was started without it, or
   * while the first scan is still running - which is a different thing from
   * "you have not used anything", and the UI distinguishes them.
   */
  local: LocalUsageReport | null;
}

const FAILED_STATUSES = new Set(['FAILED', 'ABORTED', 'CRASHED']);

export function usageSummary(
  db: DatabaseSync,
  local: LocalUsageReport | null = null,
  gatewayQuotas?: Map<string, any>
): UsageSummary {
  const agents = db
    .prepare(`SELECT id, name, budget_cap_usd FROM agents ORDER BY name ASC`)
    .all() as any[];

  const runRows = db
    .prepare(
      `SELECT agent_id, status, actual_cost_usd, started_at, completed_at FROM task_runs`
    )
    .all() as any[];

  const perAgent = new Map<string, { spent: number; runs: number; failed: number; last: number | null }>();
  let since: number | null = null;

  for (const row of runRows) {
    const id = String(row.agent_id);
    const entry = perAgent.get(id) ?? { spent: 0, runs: 0, failed: 0, last: null };
    entry.spent += Number(row.actual_cost_usd) || 0;
    entry.runs += 1;
    if (FAILED_STATUSES.has(String(row.status))) entry.failed += 1;
    const at = row.completed_at ?? row.started_at;
    if (at !== null && at !== undefined) {
      const ts = Number(at);
      if (entry.last === null || ts > entry.last) entry.last = ts;
      if (since === null || ts < since) since = ts;
    }
    perAgent.set(id, entry);
  }

  // Gateway calls whose price is unknown are counted separately rather than as zero spend.
  const unpriced = new Map<string, { calls: number; tokens: number }>();
  if (hasTable(db, 'cost_reservations')) {
    const rows = db.prepare(`SELECT agent_id, COUNT(*) AS calls,
        TOTAL(CASE WHEN input_tokens IS NOT NULL THEN input_tokens + output_tokens ELSE COALESCE(estimated_tokens, 0) END) AS tokens
      FROM cost_reservations WHERE pricing_state = 'unknown' AND status IN ('PENDING', 'RECONCILED', 'UNRECONCILED_ASSUMED_SPENT') GROUP BY agent_id`).all() as any[];
    for (const row of rows) unpriced.set(String(row.agent_id), { calls: Number(row.calls), tokens: Number(row.tokens) });
  }

  const summaries: AgentUsage[] = agents.map((agent) => {
    const entry = perAgent.get(String(agent.id));
    return {
      agentId: String(agent.id),
      name: String(agent.name),
      budgetCapUsd: Number(agent.budget_cap_usd) || 0,
      spentUsd: entry ? round6(entry.spent) : 0,
      runCount: entry ? entry.runs : 0,
      failedRunCount: entry ? entry.failed : 0,
      lastRunAt: entry ? entry.last : null,
      unpricedCallCount: unpriced.get(String(agent.id))?.calls ?? 0,
      unpricedTokens: unpriced.get(String(agent.id))?.tokens ?? 0,
    };
  });

  const connections: ConnectionPoolUsage[] = hasTable(db, 'provider_connections')
    ? (db.prepare('SELECT id, name, requests_per_day, tokens_per_day FROM provider_connections ORDER BY name, id').all() as any[]).map((row) => {
      const quota = gatewayQuotas?.get(String(row.id));
      return {
        connectionId: String(row.id),
        name: String(row.name),
        ...connectionAdmissionUsage(db, String(row.id)),
        requestsPerDay: Number(row.requests_per_day),
        tokensPerDay: Number(row.tokens_per_day),
        gatewayQuota: quota ?? { available: false as const, reason: "The gateway's own quota view needs its dashboard session, which OpenAgents does not hold. These counts are OpenAgents admission only." },
      };
    })
    : [];

  return {
    agents: summaries,
    totalSpentUsd: round6(summaries.reduce((sum, a) => sum + a.spentUsd, 0)),
    totalBudgetCapUsd: round6(summaries.reduce((sum, a) => sum + a.budgetCapUsd, 0)),
    totalRunCount: summaries.reduce((sum, a) => sum + a.runCount, 0),
    connections,
    since,
    billing: {
      supported: false,
      reason:
        'OpenAgents runs against your own provider credentials. It has no plan, trial or invoice of its own; ' +
        'the figures above are reconciled model spend, and the caps are limits you configured.',
    },
    local,
  };
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Sub-cent model pricing means naive addition accumulates float noise. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
