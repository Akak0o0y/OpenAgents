/**
 * Phase 2 Trace Harness - Data Contracts & Metrics Types
 */

export type TraceOutcome =
  | 'PASSED'
  | 'HIT_TURN_CAP'
  | 'HIT_BUDGET_CAP'
  | 'CONTAINER_TIMEOUT'
  | 'RATE_LIMITED'
  | 'HARNESS_ERROR';

export interface TurnTelemetry {
  turnNumber: number;
  attemptCount: number; // Internal HTTP retries (429/503) separate from agent turnNumber
  modelId: string;
  costUsd: number;
  shadowCostUsd?: number; // Normalized shadow cost under Sonnet 5 benchmark rates ($3/M in, $15/M out)
  inputTokens: number;
  outputTokens: number;
  testExitCode: number;
  testsPassed: boolean;
  errorFingerprint: string | null;
  workspaceDiffHash: string;
  shadowThrashDetected: boolean;
  shadowThrashReason?: string;
  codeFenceMissing: boolean;
}

export interface TraceRecord {
  traceId: string;
  taskId: string;
  taskName: string;
  runIndex: number;
  modelId: string;
  outcome: TraceOutcome;
  totalTurns: number;
  totalCostUsd: number;
  totalShadowCostUsd: number;
  turnsToSuccess?: number;
  shadowThrashFiredAtTurn?: number;
  shadowThrashReason?: string;
  shadowThrashDetected: boolean;
  hasMissingCodeFence: boolean;
  turns: TurnTelemetry[];
  startedAt: number;
  completedAt: number;
  errorMessage?: string;
}

export interface ShadowThrashMetrics {
  totalFlagged: number;
  falsePositives: number; // flagged as thrash, but went on to pass
  truePositives: number;  // flagged as thrash, and did not pass
  falsePositiveRate: number; // falsePositives / totalFlagged
  flaggedByTerminalOutcome: Record<TraceOutcome, number>; // Cross-tabulation
  // Code fence pollution filtering
  tracesWithMissingCodeFence: number;
  cleanTracesFlagged: number;
  cleanFalsePositives: number;
  cleanFalsePositiveRate: number;
}

export interface BenchmarkReport {
  totalTracesPlanned: number;
  totalTracesExecuted: number;
  completedCount: number;
  passedCount: number;
  censoredCount: number; // HIT_TURN_CAP (truncated by max turns ceiling)
  outcomesDistribution: Record<TraceOutcome, number>;
  shadowThrash: ShadowThrashMetrics;
  turnsToSuccess: {
    p50: number;
    p90: number;
    min: number;
    max: number;
    raw: number[];
  };
  costStats: {
    totalSpentUsd: number;
    totalShadowCostUsd: number; // Economic benchmark baseline
    meanCostPerTraceUsd: number;
    maxCostTraceUsd: number;
  };
  suiteBudgetCapExceeded?: boolean;
  methodologyLimits: {
    statelessRetryLoop: boolean;
    singleFileScope: string;
    modelEvaluated: string;
  };
  traces: TraceRecord[];
}
