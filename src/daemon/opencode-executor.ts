/**
 * OpenCode Task Executor.
 *
 * An alternative to the built-in AgentLoop. Instead of our own "rewrite every file
 * each turn" loop, this hands the task to the OpenCode CLI, which has real tools
 * (read/write/edit/bash/grep) and runs its own multi-turn loop internally.
 *
 * THREE THINGS THIS FILE EXISTS TO GET RIGHT
 *
 * 1. OpenCode's exit code is NOT a success signal.
 *    Measured on two live runs that both failed with the same HTTP 429 and both
 *    produced no code: one exited 0, the other exited 1. The exit code is not
 *    merely wrong, it is inconsistent - so it cannot be read either way. Trusting
 *    a 0 would turn rate-limited runs into false greens. The verdict therefore
 *    never comes from the agent: it comes from re-running the test command in the
 *    hardened network-none executor container. Failures are read out of the NDJSON
 *    event stream, which is where OpenCode actually reports them.
 *
 * 2. The agent must not be able to pass by editing the tests.
 *    OpenCode can edit any file it can see, including the test file that judges it.
 *    Before verification, every protected (test) file is re-staged from the task
 *    definition, so tampering is overwritten and cannot buy a green.
 *
 * 3. Spend must not silently collapse to zero.
 *    OpenCode calls the provider itself, so we cannot observe tokens the way the
 *    built-in loop does. Usage is parsed from the event stream when present; when
 *    it is absent the reservation is closed as UNRECONCILED_ASSUMED_SPENT rather
 *    than reconciled at $0.
 *
 * Free-tier reality: one OpenCode session is an agentic loop, so it can spend many
 * OpenRouter requests. On an uncredited key (50 requests/day) a single session can
 * consume a large share of the day. There is no --max-turns flag to cap this from
 * outside, so the controls available are the session wall-clock timeout and the
 * daily ceiling enforced upstream by the work producer.
 */

import { DockerSandbox } from '../kernel/docker-sandbox.js';
import { CostLedger, isBudgetExceededError } from '../kernel/cost-ledger.js';
import { AgentStore } from './agent-store.js';
import { PROVISIONAL_CONFIG } from './config.js';
import type { AgentRecord, TaskRunRecord } from './db/schema.js';
import type { AgentLoopResult } from './agent-loop.js';
import { protectedTaskFiles } from './task-input.js';
import type { CharacterStore } from './character-store.js';

const INPUT_TOKEN_KEYS = ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'];
const OUTPUT_TOKEN_KEYS = ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'];

/**
 * Provider prefixes opencode resolves, mapped to the env var that unlocks each.
 * Verified with `opencode providers list`: one OPENCODE_API_KEY unlocks both
 * "OpenCode Zen" (opencode/*) and "OpenCode Go" (opencode-go/*).
 */
export const PROVIDER_ENV: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
};

/**
 * Normalise a model id to opencode's `provider/model` addressing.
 *
 * Ids that already name a known provider pass through untouched
 * (`opencode/nemotron-3-ultra-free`). Anything else is treated as a bare
 * OpenRouter id and gets the `openrouter/` prefix, which is how the rest of the
 * platform stores them (`nvidia/nemotron-3-super-120b-a12b:free`).
 */
export function toOpenCodeModel(modelId: string): string {
  const prefix = modelId.split('/')[0];
  return prefix in PROVIDER_ENV ? modelId : `openrouter/${modelId}`;
}

/**
 * Which credential a given model needs.
 *
 * Note the throw below is a drift guard, not a reachable path: toOpenCodeModel
 * normalises every unrecognised prefix to `openrouter/`, so the only way to reach
 * it is for PROVIDER_ENV and toOpenCodeModel to fall out of sync. Kept so that
 * adding a provider to one and not the other fails loudly instead of silently
 * routing to OpenRouter.
 */
export function requiredCredentialEnvVar(modelId: string): string {
  const openCodeModel = toOpenCodeModel(modelId);
  const provider = openCodeModel.split('/')[0];
  const envVar = PROVIDER_ENV[provider];
  if (!envVar) {
    throw new Error(
      `Unknown opencode provider "${provider}" in model "${openCodeModel}". ` +
      `Known providers: ${Object.keys(PROVIDER_ENV).join(', ')}.`
    );
  }
  return envVar;
}

/** POSIX single-quote escaping: the command crosses an `sh -c` boundary. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface OpenCodeSessionError {
  name: string;
  message: string;
  statusCode: number | null;
}

export interface OpenCodeSessionSummary {
  sessionId: string | null;
  eventCount: number;
  /** Lines that were not JSON. Counted, never silently dropped. */
  unparsedLines: number;
  errors: OpenCodeSessionError[];
  /** null means OpenCode reported no usage - the caller must NOT record $0. */
  usage: { inputTokens: number; outputTokens: number } | null;
}

function pickNumber(rec: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Collect token counts from the event tree.
 *
 * Only objects reached through a `tokens` or `usage` key are considered. Matching
 * on bare `input`/`output` anywhere in the tree would happily pick up unrelated
 * fields and invent spend, which is worse than reporting nothing.
 */
function collectUsage(
  node: unknown,
  acc: { input: number; output: number; found: boolean },
  parentKey?: string
): void {
  if (Array.isArray(node)) {
    for (const child of node) collectUsage(child, acc);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const rec = node as Record<string, unknown>;

  if (parentKey === 'tokens' || parentKey === 'usage') {
    const input = pickNumber(rec, INPUT_TOKEN_KEYS);
    const output = pickNumber(rec, OUTPUT_TOKEN_KEYS);
    if (input !== null || output !== null) {
      acc.input += input ?? 0;
      acc.output += output ?? 0;
      acc.found = true;
      return; // do not descend, or nested duplicates get counted twice
    }
  }

  for (const [key, value] of Object.entries(rec)) collectUsage(value, acc, key);
}

/**
 * Parse `opencode run --format json` output.
 *
 * Envelope confirmed against a live run:
 *   {"type":"error","timestamp":...,"sessionID":"ses_...",
 *    "error":{"name":"APIError","data":{"message":"...","statusCode":429}}}
 */
export function parseOpenCodeStream(raw: string): OpenCodeSessionSummary {
  const summary: OpenCodeSessionSummary = {
    sessionId: null,
    eventCount: 0,
    unparsedLines: 0,
    errors: [],
    usage: null,
  };
  const acc = { input: 0, output: 0, found: false };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('{')) {
      summary.unparsedLines++;
      continue;
    }

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      summary.unparsedLines++;
      continue;
    }

    summary.eventCount++;
    if (!summary.sessionId && typeof event?.sessionID === 'string') {
      summary.sessionId = event.sessionID;
    }

    if (event?.type === 'error') {
      const data = event?.error?.data ?? {};
      summary.errors.push({
        name: String(event?.error?.name ?? 'UnknownError'),
        message: String(data?.message ?? event?.error?.message ?? 'OpenCode reported an error with no message'),
        statusCode: typeof data?.statusCode === 'number' ? data.statusCode : null,
      });
    }

    collectUsage(event, acc);
  }

  if (acc.found) {
    summary.usage = { inputTokens: acc.input, outputTokens: acc.output };
  }
  return summary;
}

export function isRateLimited(summary: OpenCodeSessionSummary): boolean {
  return summary.errors.some(
    (e) => e.statusCode === 429 || /rate limit/i.test(e.message)
  );
}

export interface OpenCodeExecutorOptions {
  agentStore: AgentStore;
  sandbox?: DockerSandbox;
  ledger?: CostLedger;
  image?: string;
  network?: string;
  /** Explicit credential override. Normally left unset so the provider's env var is used. */
  apiKey?: string;
  sessionTimeoutMs?: number;
  characterStore?: CharacterStore;
  /**
   * Test seam. Substituting a deterministic shell script here exercises the whole
   * pipeline - staging, tamper protection, verification, ledger - without spending
   * a single provider request.
   */
  buildAgentCommand?: (ctx: { model: string; prompt: string }) => string;
}

export interface OpenCodeTaskParams {
  agent: AgentRecord;
  taskRun: TaskRunRecord;
  initialFiles: Record<string, string>;
  testCommand: string;
  /** Defaults to every initial file that looks like a test. */
  protectedFiles?: string[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export class OpenCodeExecutor {
  private sandbox: DockerSandbox;
  private ledger: CostLedger;
  private agentStore: AgentStore;
  private image: string;
  private network: string;
  private apiKey: string | undefined;
  private sessionTimeoutMs: number;
  private buildAgentCommand: (ctx: { model: string; prompt: string }) => string;
  private characterStore?: CharacterStore;

  constructor(options: OpenCodeExecutorOptions) {
    this.agentStore = options.agentStore;
    this.sandbox = options.sandbox ?? new DockerSandbox();
    this.ledger = options.ledger ?? new CostLedger(PROVISIONAL_CONFIG.DB_PATH);
    this.image = options.image ?? PROVISIONAL_CONFIG.OPENCODE_IMAGE;
    this.network = options.network ?? PROVISIONAL_CONFIG.OPENCODE_AGENT_NETWORK;
    // Explicit override only. Falling back to a specific env var here would
    // silently hand an OpenRouter key to an OpenCode Zen model.
    this.apiKey = options.apiKey;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? PROVISIONAL_CONFIG.OPENCODE_SESSION_TIMEOUT_MS;
    this.characterStore = options.characterStore;
    this.buildAgentCommand =
      options.buildAgentCommand ??
      (({ model, prompt }) =>
        // --pure skips OpenCode's startup plugin npm install, keeping the run hermetic.
        // --auto is required for unattended operation; it is safe only because this
        // runs inside the hardened agent container.
        `opencode run --format json --pure --auto -m ${shellQuote(model)} ${shellQuote(prompt)}`);
  }

  resolveProtectedFiles(
    initialFiles: Record<string, string>,
    explicit?: string[]
  ): string[] {
    return protectedTaskFiles(initialFiles, explicit);
  }

  buildPrompt(params: OpenCodeTaskParams): string {
    const files = Object.keys(params.initialFiles);
    const protectedFiles = this.resolveProtectedFiles(params.initialFiles, params.protectedFiles);
    const codeFallback = params.agent.system_prompt ?? 'You are an autonomous software engineering assistant.';
    const resolvedIdentity = this.characterStore?.identityFor(params.agent, {
      surface: 'code',
      fallback: codeFallback,
    });
    return [
      resolvedIdentity?.stable ?? codeFallback,
      '',
      `Task: ${params.taskRun.task_name}`,
      '',
      'You are working in /workspace. These files already exist:',
      ...files.map((f) => `  - ${f}`),
      '',
      `Goal: make this command exit 0 -> ${params.testCommand}`,
      '',
      'Rules:',
      '  - Work only inside /workspace.',
      '  - Edit files directly with your tools. Do not print a patch and stop.',
      '  - The project uses ES modules ("type": "module"). Use named ES exports.',
      protectedFiles.length > 0
        ? `  - Do NOT modify the test files (${protectedFiles.join(', ')}). They are restored before grading, so editing them cannot help you.`
        : '  - Do NOT weaken or delete tests.',
      '',
      'Implement the solution, run the test command yourself, and iterate until it passes.',
    ].join('\n');
  }

  async executeTask(params: OpenCodeTaskParams): Promise<AgentLoopResult> {
    const { agent, taskRun, initialFiles, testCommand, abortSignal } = params;
    if (agent.connection_id) {
      throw new Error(`Bot "${agent.id}" uses provider connection "${agent.connection_id}". The OpenCode executor is not wired for provider connections yet, so this task was refused instead of being sent to another provider.`);
    }

    const modelId = taskRun.model_id ?? agent.model_id;
    const openCodeModel = toOpenCodeModel(modelId);

    // Resolve the credential for THIS model's provider, and inject only that one.
    // Loud, not a silent skip: without a key OpenCode authenticates as nobody and
    // the session dies inside the container where nobody reads the log.
    const credentialEnvVar = requiredCredentialEnvVar(modelId);
    const credential = this.apiKey ?? process.env[credentialEnvVar];
    if (!credential) {
      throw new Error(
        `OpenCodeExecutor requires ${credentialEnvVar} for model "${openCodeModel}" ` +
        `(environment, .env, or explicit apiKey option). Refusing to dispatch.`
      );
    }

    const timeoutMs = params.timeoutMs ?? PROVISIONAL_CONFIG.DEFAULT_TASK_TIMEOUT_MS;
    let volumeName: string | null = null;

    let outcome: AgentLoopResult['outcome'] = 'FAILED';
    let errorMessage: string | undefined;
    let actualCostUsd = 0;
    let shadowCostUsd = 0;
    let turnsTaken = 0;

    try {
      // The store owns TASK_STARTED; this executor contributes detail rather
      // than emitting a second copy of the same transition.
      this.agentStore.startTaskRun(taskRun.id, modelId, {
        executor: 'opencode',
        openCodeModel,
      });
      abortSignal?.throwIfAborted();
      volumeName = await this.sandbox.createWorkspaceVolume(`task-${taskRun.id}`);

      await this.sandbox.stageWorkspaceFiles(volumeName, initialFiles);

      if (abortSignal?.aborted) {
        outcome = 'ABORTED';
        errorMessage = 'Operator terminated task execution';
        return this.result(outcome, turnsTaken, actualCostUsd, shadowCostUsd, errorMessage);
      }

      // Budget guard before a single token is spent.
      let reservation;
      try {
        reservation = this.ledger.reserveWithBudgetCheck(
          taskRun.id,
          agent.id,
          modelId,
          agent.budget_cap_usd,
          PROVISIONAL_CONFIG.OPENCODE_ESTIMATED_SESSION_TOKENS
        );
      } catch (err: unknown) {
        if (isBudgetExceededError(err)) {
          outcome = 'HIT_BUDGET_CAP';
          errorMessage = err.message;
          return this.result(outcome, turnsTaken, actualCostUsd, shadowCostUsd, errorMessage);
        }
        throw err;
      }

      this.ledger.markDispatched(reservation.id);
      turnsTaken = 1; // one OpenCode session; its internal turns are not visible to us

      const prompt = this.buildPrompt(params);

      // Layer 1 evidence. There is no layer-2 counterpart here on purpose:
      // opencode owns its own conversation inside the container, so this daemon
      // has no history to report and must not pretend otherwise.
      this.emitEvent({
        task_run_id: taskRun.id,
        agent_id: agent.id,
        model_id: modelId,
        event_type: 'PROMPT_ASSEMBLED',
        turn_number: 0,
        payload_json: JSON.stringify({
          source: agent.system_prompt ? 'agent' : 'default',
          promptChars: prompt.length,
          executor: 'opencode',
        }),
        timestamp: Date.now(),
      });
      const agentRes = await this.sandbox.runAgentContainer(
        volumeName,
        this.buildAgentCommand({ model: openCodeModel, prompt }),
        {
          image: this.image,
          network: this.network,
          timeoutMs: this.sessionTimeoutMs,
          secrets: { [credentialEnvVar]: credential },
          signal: abortSignal,
        }
      );

      const summary = parseOpenCodeStream(agentRes.stdout);

      // Spend accounting. Never silently $0.
      if (summary.usage) {
        const reconciled = this.ledger.reconcile(
          reservation.id,
          summary.usage.inputTokens,
          summary.usage.outputTokens
        );
        actualCostUsd = reconciled.actualCostUsd;
        shadowCostUsd = reconciled.shadowCostUsd;
      } else {
        const assumed = this.ledger.markUnreconciledAssumedSpent(reservation.id);
        actualCostUsd = assumed.assumedCostUsd;
      }
      this.agentStore.updateTaskRunProgress(taskRun.id, turnsTaken, actualCostUsd, shadowCostUsd);

      this.emitEvent({
        task_run_id: taskRun.id,
        agent_id: agent.id,
        model_id: modelId,
        event_type: 'OPENCODE_SESSION',
        turn_number: turnsTaken,
        payload_json: JSON.stringify({
          sessionId: summary.sessionId,
          eventCount: summary.eventCount,
          unparsedLines: summary.unparsedLines,
          errors: summary.errors.slice(0, 5),
          usageReported: summary.usage !== null,
          // Recorded for forensics only. Observed as both 0 and 1 for identical
          // 429 failures, so nothing branches on it.
          agentExitCode: agentRes.exitCode,
          timedOut: agentRes.timedOut,
          durationMs: agentRes.durationMs,
        }),
        timestamp: Date.now(),
      });

      if (abortSignal?.aborted) {
        outcome = 'ABORTED';
        errorMessage = 'Operator terminated task execution';
        return this.result(outcome, turnsTaken, actualCostUsd, shadowCostUsd, errorMessage);
      }

      if (isRateLimited(summary)) {
        outcome = 'RATE_LIMITED';
        errorMessage = summary.errors.map((e) => e.message).join(' | ');
        return this.result(outcome, turnsTaken, actualCostUsd, shadowCostUsd, errorMessage);
      }

      // Anti-tamper: restore the files that grade the agent, then grade.
      const protectedFiles = this.resolveProtectedFiles(initialFiles, params.protectedFiles);
      if (protectedFiles.length > 0) {
        const restore: Record<string, string> = {};
        for (const f of protectedFiles) restore[f] = initialFiles[f];
        await this.sandbox.stageWorkspaceFiles(volumeName, restore);
        this.emitEvent({
          task_run_id: taskRun.id,
          agent_id: agent.id,
          model_id: modelId,
          event_type: 'PROTECTED_FILES_RESTAGED',
          turn_number: turnsTaken,
          payload_json: JSON.stringify({ files: protectedFiles }),
          timestamp: Date.now(),
        });
      }

      // THE VERDICT. Network-none container, no secrets, agent never touched it.
      const execRes = await this.sandbox.executeTask(volumeName, testCommand, { timeoutMs, signal: abortSignal });
      abortSignal?.throwIfAborted();
      const testsPassed = execRes.exitCode === 0;
      const testOutput = [execRes.stderr.trim(), execRes.stdout.trim()].filter(Boolean).join('\n');

      this.emitEvent({
        task_run_id: taskRun.id,
        agent_id: agent.id,
        model_id: modelId,
        event_type: 'TURN_COMPLETED',
        turn_number: turnsTaken,
        payload_json: JSON.stringify({
          modelId,
          testsPassed,
          testExitCode: execRes.exitCode,
          testOutput: testOutput.slice(0, 1000),
          costUsd: actualCostUsd,
          shadowCostUsd,
        }),
        timestamp: Date.now(),
      });

      if (testsPassed) {
        outcome = 'COMPLETED';
      } else {
        outcome = 'FAILED';
        errorMessage =
          summary.errors.length > 0
            ? `Agent errors: ${summary.errors.map((e) => e.message).join(' | ')}`
            : `Test command failed with exit code ${execRes.exitCode}: ${testOutput.slice(0, 500)}`;
      }

      return this.result(outcome, turnsTaken, actualCostUsd, shadowCostUsd, errorMessage);
    } catch (error) {
      outcome = abortSignal?.aborted ? 'ABORTED' : 'FAILED';
      errorMessage = error instanceof Error ? error.message : String(error);
      return this.result(outcome, turnsTaken, actualCostUsd, shadowCostUsd, errorMessage);
    } finally {
      const finalStatus =
        outcome === 'COMPLETED' ? 'COMPLETED' : outcome === 'ABORTED' ? 'ABORTED' : 'FAILED';

      // Store owns TASK_<status>. `outcome` is carried separately because it is
      // finer-grained than the persisted status: HIT_BUDGET_CAP and RATE_LIMITED
      // both persist as FAILED, and collapsing them would erase why it stopped.
      if (volumeName) this.agentStore.setAgentData({ agentId: agent.id, key: taskRun.id, category: 'workspaces', data: { volumeName } });
      this.agentStore.finishTaskRun(taskRun.id, finalStatus, errorMessage, {
        outcome,
        executor: 'opencode',
        modelId,
        openCodeModel,
        turnsTaken,
        actualCostUsd,
        shadowCostUsd,
      });

    }
  }

  private result(
    outcome: AgentLoopResult['outcome'],
    turnsTaken: number,
    actualCostUsd: number,
    shadowCostUsd: number,
    errorMessage?: string
  ): AgentLoopResult {
    return { outcome, turnsTaken, actualCostUsd, shadowCostUsd, errorMessage };
  }

  /**
   * Record a detail event. Broadcasting is NOT done here: the store's event sink
   * is the single fan-out point, so an event reaches the UI exactly once.
   */
  private emitEvent(event: Parameters<AgentStore['recordEvent']>[0]): void {
    this.agentStore.recordEvent(event);
  }
}
