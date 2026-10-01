/**
 * Phase 2 Empirical Trace Runner
 * Executes multi-tenant benchmark tasks across multiple runs to establish
 * genuine distributions for turns-to-success, cost per attempt, and shadow
 * thrash false-positive rates.
 * Incorporates wall-clock bounds, turn pacing delays, attempt/turn separation,
 * RATE_LIMITED terminal outcome, and shadow cost recording.
 */

import { DockerSandbox } from '../kernel/docker-sandbox.js';
import { CostLedger, isBudgetExceededError, isRateLimitExceededError } from '../kernel/cost-ledger.js';
import { ThrashDetector } from '../kernel/thrash-detector.js';
import { STANDING_BENCHMARKS, type StandingTenantBenchmark } from '../kernel/standing-tenant.js';
import { MockLLMClient, type ILLMClient } from './llm-client.js';
import type { TraceRecord, TurnTelemetry, BenchmarkReport, TraceOutcome, ShadowThrashMetrics } from './types.js';

export interface TraceRunnerOptions {
  modelId?: string;
  maxTurns?: number;            // Default 40 to avoid artificial truncation
  runsPerTask?: number;         // e.g. 5 runs x 10 tasks = 50 traces
  budgetCapUsd?: number;
  dbPath?: string;
  traceTimeoutSeconds?: number; // Per-trace wall-clock timeout (e.g. 240s)
  turnPacingDelayMs?: number;   // Delay between turns to prevent 429 rate limit spikes (e.g. 1200ms)
  onTraceCompleted?: (trace: TraceRecord) => void;
}

export class TraceRunner {
  private sandbox: DockerSandbox;
  private ledger: CostLedger;
  private llmClient: ILLMClient;

  constructor(llmClient: ILLMClient, dbPath = ':memory:') {
    this.sandbox = new DockerSandbox();
    this.ledger = new CostLedger(dbPath);
    this.llmClient = llmClient;
  }

  /**
   * Parse extracted Javascript/Typescript code from LLM markdown response.
   * Tracks whether markdown code fences were omitted to prevent formatting flaws
   * from contaminating thrash detection.
   */
  private extractCodeFromResponse(raw: string): { code: string; codeFenceMissing: boolean } {
    const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const codeBlockMatch = stripped.match(/```(?:javascript|js|typescript|ts)?\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      return { code: codeBlockMatch[1].trim(), codeFenceMissing: false };
    }
    return { code: stripped.trim(), codeFenceMissing: true };
  }

  /**
   * Run a single task attempt (one trace).
   */
  async runTrace(
    task: StandingTenantBenchmark,
    runIndex: number,
    options: TraceRunnerOptions = {}
  ): Promise<TraceRecord> {
    const traceId = `trace-${task.id}-${runIndex}-${Date.now()}`;
    const modelId = options.modelId ?? 'claude-haiku-4-5';
    const maxTurns = options.maxTurns ?? 40;
    const budgetCapUsd = options.budgetCapUsd ?? task.budgetCapUsd ?? 2.00;
    const maxTraceWallClockSec = options.traceTimeoutSeconds ?? (task.timeoutSeconds ? task.timeoutSeconds * 5 : 240);
    const pacingDelayMs = options.turnPacingDelayMs ?? 1000;
    const thrashDetector = new ThrashDetector(3, 3);

    const turns: TurnTelemetry[] = [];
    const startedAt = Date.now();
    let outcome: TraceOutcome = 'HIT_TURN_CAP';
    let turnsToSuccess: number | undefined;
    let shadowThrashFiredAtTurn: number | undefined;
    let shadowThrashReason: string | undefined;
    let hasMissingCodeFence = false;
    let errorMessage: string | undefined;

    const volumeName = await this.sandbox.createWorkspaceVolume(traceId);

    try {
      // 1. Stage initial benchmark files
      await this.sandbox.stageWorkspaceFiles(volumeName, task.initialFiles);

      // Track active workspace files
      const workspaceFiles: Record<string, string> = { ...task.initialFiles };
      let lastStderr = '';

      for (let turn = 1; turn <= maxTurns; turn++) {
        // Check per-trace wall-clock cap
        const elapsedSec = (Date.now() - startedAt) / 1000;
        if (elapsedSec > maxTraceWallClockSec) {
          outcome = 'CONTAINER_TIMEOUT';
          errorMessage = `Trace wall-clock limit exceeded (${elapsedSec.toFixed(1)}s > ${maxTraceWallClockSec}s)`;
          break;
        }

        // 2. Pre-dispatch budget watchdog: check and reserve atomically
        let reservation;
        try {
          reservation = this.ledger.reserveWithBudgetCheck(
            traceId,
            `agent-${task.id}`,
            modelId,
            budgetCapUsd,
            15000
          );
        } catch (err: unknown) {
          if (isBudgetExceededError(err)) {
            outcome = 'HIT_BUDGET_CAP';
            errorMessage = err instanceof Error ? err.message : String(err);
            break;
          }
          throw err;
        }

        // 3. Prepare prompt (Stateless retry loop: current file + last stderr)
        const systemPrompt = `You are an expert autonomous software engineer.
You are implementing code to satisfy acceptance criteria and make tests pass.
The project uses ES Modules ("type": "module"), so ensure you use named ES exports (e.g. export function foo(...)). Output ONLY the clean Javascript code for src/index.js inside a \`\`\`javascript code block.`;

        const userPrompt = `Task ID: ${task.id}
Task Name: ${task.name}
Description: ${task.description}

Requirements:
${task.requirements.map(r => '- ' + r).join('\n')}

Current Turn: ${turn} of ${maxTurns}
Previous Stderr / Test Output:
${lastStderr ? lastStderr : '(First turn - no prior test output)'}

Current src/index.js:
${workspaceFiles['src/index.js'] ?? '// No implementation yet'}

Provide the implementation for src/index.js that satisfies all requirements and passes the tests.`;

        // 4. Mark dispatched immediately before API call
        this.ledger.markDispatched(reservation.id);

        // 5. Call LLM (retries on 429/503 happen inside client without advancing turnNumber)
        let response;
        try {
          response = await this.llmClient.generateCode({
            modelId,
            systemPrompt,
            userPrompt,
          });
        } catch (err: any) {
          if (isRateLimitExceededError(err)) {
            outcome = 'RATE_LIMITED';
            errorMessage = err.message;
            break;
          }
          outcome = 'HARNESS_ERROR';
          errorMessage = err.message;
          break;
        }

        // 6. Reconcile cost (both actual spend and normalized Sonnet 5 shadow cost)
        const reconciled = this.ledger.reconcile(
          reservation.id,
          response.inputTokens,
          response.outputTokens
        );

        // 7. Write generated code to /workspace/src/index.js
        const extracted = this.extractCodeFromResponse(response.content);
        if (extracted.codeFenceMissing) {
          hasMissingCodeFence = true;
        }

        workspaceFiles['src/index.js'] = extracted.code;
        await this.sandbox.stageWorkspaceFiles(volumeName, {
          'src/index.js': extracted.code,
        });

        // 8. Execute test suite
        const execRes = await this.sandbox.executeTask(volumeName, task.testCommand, {
          timeoutMs: task.timeoutSeconds ? task.timeoutSeconds * 1000 : 30000,
        });

        if (execRes.timedOut) {
          outcome = 'CONTAINER_TIMEOUT';
          errorMessage = 'Container execution timed out';
          break;
        }

        const combinedOutput = [execRes.stderr.trim(), execRes.stdout.trim()]
          .filter(Boolean)
          .join('\n');
        const testOutput = combinedOutput.trim();
        lastStderr = testOutput;
        const testsPassed = execRes.exitCode === 0;

        // 9. Evaluate thrash detector in SHADOW MODE (do not abort)
        const thrashState = thrashDetector.recordTurn(turn, testOutput, workspaceFiles);
        if (thrashState.isThrashing && shadowThrashFiredAtTurn === undefined) {
          shadowThrashFiredAtTurn = turn;
          shadowThrashReason = thrashState.reason;
        }

        turns.push({
          turnNumber: turn,
          attemptCount: response.attemptCount ?? 1,
          modelId,
          costUsd: reconciled.actualCostUsd,
          shadowCostUsd: reconciled.shadowCostUsd,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          testExitCode: execRes.exitCode,
          testsPassed,
          errorFingerprint: thrashState.lastFingerprint,
          workspaceDiffHash: thrashState.lastDiffHash ?? '',
          shadowThrashDetected: thrashState.isThrashing,
          shadowThrashReason: thrashState.reason,
          codeFenceMissing: extracted.codeFenceMissing,
        });

        // 10. Check if tests passed
        if (testsPassed) {
          turnsToSuccess = turn;
          outcome = 'PASSED';
          break;
        }

        // Pacing delay between turns to prevent rate-limit bursts on free models
        if (turn < maxTurns && pacingDelayMs > 0) {
          await new Promise(r => setTimeout(r, pacingDelayMs));
        }
      }
    } finally {
      await this.sandbox.destroyWorkspaceVolume(volumeName);
    }

    const totalCostUsd = turns.reduce((sum, t) => sum + t.costUsd, 0);
    const totalShadowCostUsd = turns.reduce((sum, t) => sum + (t.shadowCostUsd ?? 0), 0);

    const record: TraceRecord = {
      traceId,
      taskId: task.id,
      taskName: task.name,
      runIndex,
      modelId,
      outcome,
      totalTurns: turns.length,
      totalCostUsd,
      totalShadowCostUsd,
      turnsToSuccess,
      shadowThrashFiredAtTurn,
      shadowThrashReason,
      shadowThrashDetected: shadowThrashFiredAtTurn !== undefined,
      hasMissingCodeFence,
      turns,
      startedAt,
      completedAt: Date.now(),
      errorMessage,
    };

    if (options.onTraceCompleted) {
      options.onTraceCompleted(record);
    }

    return record;
  }

  /**
   * Run the full multi-tenant trace collection suite across all tasks.
   */
  async runSuite(options: TraceRunnerOptions = {}): Promise<BenchmarkReport> {
    const runsPerTask = options.runsPerTask ?? 5;
    const tasks = STANDING_BENCHMARKS;
    const totalTracesPlanned = tasks.length * runsPerTask;
    const traces: TraceRecord[] = [];

    for (const task of tasks) {
      for (let run = 1; run <= runsPerTask; run++) {
        const record = await this.runTrace(task, run, options);
        traces.push(record);
      }
    }

    return this.computeReport(totalTracesPlanned, traces, options.modelId ?? 'claude-haiku-4-5');
  }

  /**
   * Compute comprehensive statistical report with exact denominators,
   * cross-tabulating shadow thrash against true terminal outcomes.
   */
  computeReport(
    totalTracesPlanned: number,
    traces: TraceRecord[],
    modelEvaluated = 'claude-haiku-4-5'
  ): BenchmarkReport {
    const totalTracesExecuted = traces.length;
    let passedCount = 0;

    const outcomesDistribution: Record<TraceOutcome, number> = {
      PASSED: 0,
      HIT_TURN_CAP: 0,
      HIT_BUDGET_CAP: 0,
      CONTAINER_TIMEOUT: 0,
      RATE_LIMITED: 0,
      HARNESS_ERROR: 0,
    };

    const flaggedByTerminalOutcome: Record<TraceOutcome, number> = {
      PASSED: 0,
      HIT_TURN_CAP: 0,
      HIT_BUDGET_CAP: 0,
      CONTAINER_TIMEOUT: 0,
      RATE_LIMITED: 0,
      HARNESS_ERROR: 0,
    };

    const successTurns: number[] = [];
    let totalFlagged = 0;
    let falsePositives = 0;
    let truePositives = 0;

    // Code fence tracking
    let tracesWithMissingCodeFence = 0;
    let cleanTracesFlagged = 0;
    let cleanFalsePositives = 0;

    for (const t of traces) {
      outcomesDistribution[t.outcome] = (outcomesDistribution[t.outcome] ?? 0) + 1;

      if (t.outcome === 'PASSED') {
        passedCount++;
        if (t.turnsToSuccess !== undefined) {
          successTurns.push(t.turnsToSuccess);
        }
      }

      if (t.hasMissingCodeFence) {
        tracesWithMissingCodeFence++;
      }

      // Shadow Thrash Analysis across ALL terminal states
      if (t.shadowThrashDetected) {
        totalFlagged++;
        flaggedByTerminalOutcome[t.outcome] = (flaggedByTerminalOutcome[t.outcome] ?? 0) + 1;

        if (t.outcome === 'PASSED') {
          falsePositives++;
        } else {
          truePositives++;
        }

        if (!t.hasMissingCodeFence) {
          cleanTracesFlagged++;
          if (t.outcome === 'PASSED') {
            cleanFalsePositives++;
          }
        }
      }
    }

    const falsePositiveRate = totalFlagged > 0 ? falsePositives / totalFlagged : 0;
    const cleanFalsePositiveRate = cleanTracesFlagged > 0 ? cleanFalsePositives / cleanTracesFlagged : 0;

    // Sort turns for percentile calculations
    successTurns.sort((a, b) => a - b);
    const p50 = successTurns.length > 0 ? successTurns[Math.floor(successTurns.length * 0.5)] : 0;
    const p90 = successTurns.length > 0 ? successTurns[Math.floor(successTurns.length * 0.9)] : 0;
    const min = successTurns.length > 0 ? successTurns[0] : 0;
    const max = successTurns.length > 0 ? successTurns[successTurns.length - 1] : 0;

    const totalSpentUsd = traces.reduce((sum, t) => sum + t.totalCostUsd, 0);
    const totalShadowCostUsd = traces.reduce((sum, t) => sum + (t.totalShadowCostUsd ?? 0), 0);
    const meanCostPerTraceUsd = totalTracesExecuted > 0 ? totalSpentUsd / totalTracesExecuted : 0;
    const maxCostTraceUsd = traces.length > 0 ? Math.max(...traces.map(t => t.totalCostUsd)) : 0;

    const shadowThrash: ShadowThrashMetrics = {
      totalFlagged,
      falsePositives,
      truePositives,
      falsePositiveRate,
      flaggedByTerminalOutcome,
      tracesWithMissingCodeFence,
      cleanTracesFlagged,
      cleanFalsePositives,
      cleanFalsePositiveRate,
    };

    return {
      totalTracesPlanned,
      totalTracesExecuted,
      completedCount: totalTracesExecuted,
      passedCount,
      censoredCount: outcomesDistribution.HIT_TURN_CAP,
      outcomesDistribution,
      shadowThrash,
      turnsToSuccess: {
        p50,
        p90,
        min,
        max,
        raw: successTurns,
      },
      costStats: {
        totalSpentUsd,
        totalShadowCostUsd,
        meanCostPerTraceUsd,
        maxCostTraceUsd,
      },
      methodologyLimits: {
        statelessRetryLoop: true,
        singleFileScope: 'src/index.js',
        modelEvaluated,
      },
      traces,
    };
  }

  /**
   * Execute Pre-flight Capability Verification across the Easy-tier benchmarks.
   * Strictly refuses MockLLMClient: capability verification against fixtures
   * is meaningless by construction.
   */
  async runPreflight(
    modelId: string,
    options: TraceRunnerOptions = {}
  ): Promise<{
    passed: boolean;
    allPassedUnderTwoTurns: boolean;
    traces: TraceRecord[];
    verdict: string;
  }> {
    if (this.llmClient instanceof MockLLMClient) {
      throw new Error(
        'Pre-flight capability check refused MockLLMClient: live model capability verification required.'
      );
    }

    const easyTasks = STANDING_BENCHMARKS.filter(t => t.tier === 'easy');
    const traces: TraceRecord[] = [];
    let allPassedUnderTwo = true;

    for (const task of easyTasks) {
      const trace = await this.runTrace(task, 1, {
        ...options,
        modelId,
        maxTurns: options.maxTurns ?? 5,
        budgetCapUsd: options.budgetCapUsd ?? 1.50,
      });
      traces.push(trace);
      if (trace.outcome !== 'PASSED' || trace.totalTurns > 2) {
        allPassedUnderTwo = false;
      }
    }

    const verdict = allPassedUnderTwo
      ? 'VERDICT: ✅ PRE-FLIGHT PASSED — You are CLEAR to proceed to the full run.'
      : 'VERDICT: ❌ PRE-FLIGHT FAILED — Model failed easy benchmarks or took > 2 turns.';

    return {
      passed: allPassedUnderTwo,
      allPassedUnderTwoTurns: allPassedUnderTwo,
      traces,
      verdict,
    };
  }

  close() {
    this.ledger.close();
  }
}
