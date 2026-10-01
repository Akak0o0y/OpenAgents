/**
 * 24/7 Autonomous Agent Platform - Kernel Type Definitions
 */

export type TaskStatus = 
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CRASHED'
  | 'THRASH_ABORTED'
  | 'BUDGET_EXCEEDED';

export interface TaskSpec {
  id: string;
  name: string;
  description: string;
  requirements: string[];
  runtime: 'node' | 'python';
  timeoutSeconds: number;
  budgetCapUsd: number;
  maxTurns: number;
  tier?: 'easy' | 'hard' | 'ambiguous' | 'impossible';
}

export interface SandboxConfig {
  volumeName: string;
  memoryMb: number;
  cpuLimit: number;
  pidsLimit: number;
  readOnlyRootFs: boolean;
  networkEnabled: boolean;
  env?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export interface CostRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Model rates (cost per 1M tokens) anchored to current model lineup.
 */
export const MODEL_PRICING: Record<string, CostRate> = {
  // Flagship reasoning & heavy coding tier
  'claude-sonnet-5': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-opus-5': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-fable-5-1': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  
  // Fast & cost-efficient tier for triage, scouting, and summarization
  'claude-haiku-4-5': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'anthropic/claude-haiku-4.5': { inputPerMillion: 1.00, outputPerMillion: 5.00 },
  'deepseek/deepseek-chat': { inputPerMillion: 0.32, outputPerMillion: 0.89 },
  'gemini-2.5-flash': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
};

export interface CostReservation {
  id: string;
  taskId: string;
  agentId: string;
  estimatedCostUsd: number;
  status: 'PENDING' | 'RECONCILED' | 'EXPIRED_UNDISPATCHED' | 'UNRECONCILED_ASSUMED_SPENT';
  modelId: string;
  createdAt: number;
  dispatchedAt?: number | null;
  expiresAt: number;
  actualCostUsd?: number;
  shadowCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  currentSpendUsd: number;
  budgetCapUsd: number;
  estimatedCostUsd: number;
  remainingUsd: number;
  reason?: string;
}

export interface TurnRecord {
  turnNumber: number;
  errorFingerprint: string | null;
  workspaceDiffHash: string;
  timestamp: number;
}

export interface ThrashState {
  consecutiveDuplicateErrors: number;
  consecutiveZeroDiffTurns: number;
  lastFingerprint: string | null;
  lastDiffHash: string | null;
  isThrashing: boolean;
  reason?: string;
}
