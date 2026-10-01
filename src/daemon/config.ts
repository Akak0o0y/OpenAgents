/**
 * OpenAgents Daemon Configuration
 * 
 * CRITICAL ARCHITECTURAL DIRECTIVE:
 * Because Phase 2 empirical trace calibration was shelved, all turn ceilings,
 * thrash detector thresholds, and scheduler cadences below are PROVISIONAL estimates.
 * 
 * RULE: NEVER inline magic constants in the loop, detector, or scheduler.
 * Every threshold and timing must reference this file so future Phase 2 calibration
 * is a pure drop-in config replacement with zero refactoring.
 */

import type { McpServerConfig } from '../kernel/mcp-client.js';

export const PROVISIONAL_CONFIG = {
  // Phase 2 Calibration Placeholders (PROVISIONAL - uncalibrated estimates)
  PROVISIONAL_TURN_CEILING: 25,
  PROVISIONAL_THRASH_MAX_DUPLICATE_ERRORS: 3,
  PROVISIONAL_THRASH_MAX_MUTATION_STAGNANT_TURNS: 3,
  
  // Cadence & Resource Budgets
  SCHEDULER_CADENCE_MS: 10_000,
  MAX_CONCURRENT_TASKS: 2,
  DEFAULT_TASK_TIMEOUT_MS: 60_000,
  DEFAULT_TASK_BUDGET_USD: 1.50,
  // Global daily spend cap resets strictly at 00:00 UTC
  GLOBAL_DAILY_BUDGET_USD: 25.00,
  DAILY_BUDGET_RESET_TIMEZONE: 'UTC',

  // Server & Transport
  // Single port: Node HTTP server handles normal requests and WebSocket protocol upgrade
  PORT: 4001,
  WS_PORT: 4001, // Alias for backwards compatibility
  DB_PATH: './data/openhours.db',
  
  // Event Retention
  EVENT_RETENTION_DAYS: 7, // Audit log pruning cutoff
  
  // Models (always OpenRouter-namespaced, validated against the live catalog).
  // The default is a low-cost model with tool and computer-use support. Agents
  // may still override it in openhours.config.json when a different provider or
  // an explicitly free tier is preferred.
  PRIMARY_MODEL: 'deepseek/deepseek-v4.1-flash',
  // Retained for compatibility with older free-tier deployments. The current
  // default is billed by token, so this legacy request hint is not an admission
  // limit for the default model.
  FREE_TIER_DAILY_REQUEST_LIMIT: 50,

  // Goal-decomposition producer. The producer remains independently selectable
  // so installations can keep decomposition on a separate free or local path.
  GOAL_PRODUCER_MIN_INTERVAL_MS: 900_000,
  GOAL_PRODUCER_MAX_PROPOSALS_PER_DAY: 10,
  // Note: No automatic fallback model configured.
  // Model substitution is an explicit, opt-in per-agent configuration.

  // --- OpenCode executor -----------------------------------------------------
  // Selects which executor the scheduler dispatches with. 'builtin' is the
  // hand-rolled AgentLoop; 'opencode' hands the task to the OpenCode CLI running
  // inside the networked agent container.
  EXECUTOR: 'builtin' as 'builtin' | 'opencode',

  // Pinned on purpose: a floating agent version makes runs irreproducible.
  // Rebuild with docker/opencode-agent.Dockerfile when bumping.
  OPENCODE_IMAGE: 'openhours/opencode-agent:1.18.28',

  // Model used when EXECUTOR='opencode'. Separate from PRIMARY_MODEL because the
  // built-in loop talks to OpenRouter directly and cannot address an
  // opencode/... id, while OpenCode Zen is not on OpenRouter at all.
  //
  // OpenCode Zen free tier: cost $0 in and out (confirmed via models.dev, the same
  // catalog the CLI reads), tool_call support true, 1M context. Crucially this is
  // a DIFFERENT quota from the OpenRouter 50-requests/day free tier.
  //
  // CAPABILITY VERIFIED (unlike PRIMARY_MODEL above): a live session implemented
  // slugify from a failing stub and the network-none verdict container passed it
  // 2/2 in 405s, at $0.00 actual / $0.096 shadow.
  OPENCODE_MODEL: 'opencode/nemotron-3-ultra-free',

  // Model for the goal-decomposition producer.
  //
  // Deliberately SEPARATE from the executor model, because the two halves have
  // opposite cost profiles: decomposition is one cheap chat completion, execution
  // is a long agentic session with many provider calls. Keeping them apart also
  // means the producer is not forced onto whatever the executor needs - and an
  // `opencode/...` id cannot be sent to OpenRouter at all.
  //
  // Set to an OpenRouter id (e.g. PRIMARY_MODEL) to run decomposition through
  // the same provider instead of the OpenCode executor.
  PRODUCER_MODEL: 'opencode/nemotron-3-ultra-free',

  // The agent container needs egress to reach OpenRouter. This is the one place
  // that widens the containment posture, so it is named and configurable: point
  // it at an egress-allowlist bridge to narrow it back down.
  OPENCODE_AGENT_NETWORK: 'bridge',

  /**
   * MCP servers the daemon connects at boot. EMPTY BY DEFAULT: an MCP server is
   * a real process with real host access, so one only exists because an operator
   * put it here.
   *
   * Example:
   *   { name: 'obsidian', command: 'npx', args: ['-y', 'obsidian-mcp'],
   *     env: { OBSIDIAN_VAULT: 'C:/vault' }, callQuotaPerRun: 20 }
   */
  MCP_SERVERS: [] as McpServerConfig[],

  /**
   * agentId -> MCP server names it may use. Default DENY: an agent with no entry
   * here can call nothing, so a forgotten config fails closed.
   */
  MCP_ALLOWLIST: {} as Record<string, string[]>,

  // Wall-clock ceiling for one OpenCode session. OpenCode exposes no turn limit,
  // so this timeout is the only hard bound on how long one session can run.
  OPENCODE_SESSION_TIMEOUT_MS: 900_000,

  // Pre-dispatch reservation for a whole session. Deliberately generous: an
  // agentic loop with tool calls spends far more than one chat completion, and
  // under-reserving would let a session slip past the budget cap.
  OPENCODE_ESTIMATED_SESSION_TOKENS: 120_000,
} as const;

export type DaemonConfig = typeof PROVISIONAL_CONFIG;
