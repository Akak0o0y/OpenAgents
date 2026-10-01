import type { RunCapacity } from './run-capacity.js';
/**
 * Goal-Decomposition Work Producer.
 *
 * This is the autonomous half of the platform: instead of replaying a declared
 * backlog, it asks a model what to do next and registers the invented task with
 * the scheduler so it can actually run.
 *
 * It is also the one component whose failure mode is UNBOUNDED WORK, so every
 * call is gated four ways before a single token is spent:
 *   1. queue depth         - never propose while work is already pending
 *   2. wall-clock interval - on a 50-request/day free tier this is the real governor
 *   3. per-UTC-day ceiling - counts FAILURES too, so a model returning garbage
 *                            cannot spin the loop
 *   4. pre-dispatch budget - the same CostLedger discipline the agent loop uses
 *
 * A malformed or duplicate proposal still consumes its daily slot. That is
 * deliberate: making failures free is how runaway loops get funded.
 */

import type { AgentStore } from './agent-store.js';
import type { IWorkProducer } from './work-producer.js';
import type { ILLMClient } from '../evals/llm-client.js';
import { isBudgetExceededError, type CostLedger } from '../kernel/cost-ledger.js';
import { DockerSandbox } from '../kernel/docker-sandbox.js';
import { runPreflight } from './proposal-preflight.js';

/** A task definition invented at runtime and handed to the scheduler. */
export interface ProducedTaskDefinition {
  initialFiles: Record<string, string>;
  testCommand: string;
}

export interface ProposalSpec {
  name: string;
  testCommand: string;
  files: Record<string, string>;
}

export interface GoalDecompositionOptions {
  capacity?: RunCapacity;
  /** Standing mission this producer decomposes into concrete tasks. */
  mission: string;
  agentId: string;
  llmClient: ILLMClient;
  modelId: string;
  ledger: CostLedger;
  budgetCapUsd: number;
  /** Registers the invented definition so the scheduler can execute it. */
  registerTaskDefinition: (name: string, def: ProducedTaskDefinition) => void;
  maxQueueDepth?: number;
  /** Minimum wall-clock between proposals. Default 5 minutes. */
  minIntervalMs?: number;
  /** Hard ceiling on proposals per UTC day, failures included. Default 20. */
  maxProposalsPerDay?: number;
  /** Injectable clock so the guards are testable without waiting. */
  now?: () => number;
  /**
   * Sandbox used to pre-flight a proposal before accepting it. Defaults to a
   * real DockerSandbox, matching how the executors resolve theirs.
   */
  sandbox?: DockerSandbox;
  /**
   * Skip the pre-flight. Exists ONLY so tests that are not about the pre-flight
   * do not have to pay for a container - it is an explicit, named opt-out
   * rather than a silent fallback when a sandbox is missing.
   */
  skipPreflight?: boolean;
  preflightTimeoutMs?: number;
}

export class GoalDecompositionWorkProducer implements IWorkProducer {
  private readonly opts: GoalDecompositionOptions;
  private readonly sandbox: DockerSandbox;
  private readonly maxQueueDepth: number;
  private readonly minIntervalMs: number;
  private readonly maxProposalsPerDay: number;

  private running = false;
  private lastProposalAt = 0;
  private proposalsToday = 0;
  private dayKey = '';
  private readonly attempted = new Set<string>();
  private lastError: string | null = null;

  constructor(options: GoalDecompositionOptions) {
    if (!options.mission || !options.mission.trim()) {
      throw new Error('GoalDecompositionWorkProducer requires a non-empty mission.');
    }
    this.opts = options;
    this.sandbox = options.sandbox ?? new DockerSandbox();
    this.maxQueueDepth = options.maxQueueDepth ?? 1;
    this.minIntervalMs = options.minIntervalMs ?? 300_000;
    this.maxProposalsPerDay = options.maxProposalsPerDay ?? 20;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /** Last failure reason, so the dashboard can surface it instead of only the log. */
  get lastFailure(): string | null {
    return this.lastError;
  }

  get proposalsUsedToday(): number {
    return this.proposalsToday;
  }

  private clock(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private rollDay(): void {
    const key = new Date(this.clock()).toISOString().slice(0, 10); // UTC day boundary
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.proposalsToday = 0;
    }
  }

  async produceNextTasks(store: AgentStore): Promise<number> {
    if (!this.running) return 0;
    this.rollDay();

    // Guard 1: never propose while work is already pending.
    const inFlight = store.countPendingTaskRuns();
    if (inFlight >= this.maxQueueDepth) return 0;

    // Guard 2: wall-clock floor between proposals.
    const now = this.clock();
    if (this.lastProposalAt !== 0 && now - this.lastProposalAt < this.minIntervalMs) return 0;

    // Guard 3: per-UTC-day ceiling.
    if (this.proposalsToday >= this.maxProposalsPerDay) return 0;

    const agent = store.getAgent(this.opts.agentId);
    if (!agent || agent.current_status === 'PAUSED' || agent.current_status === 'DISABLED') return 0;

    const release = this.opts.capacity?.acquire(`producer-${this.opts.agentId}`);
    if (this.opts.capacity && !release) return 0;
    try {
    // Guard 4: pre-dispatch budget reservation.
    let reservation;
    try {
      reservation = this.opts.ledger.reserveWithBudgetCheck(
        'work-producer-' + String(now),
        this.opts.agentId,
        this.opts.modelId,
        this.opts.budgetCapUsd,
        4000
      );
    } catch (err: unknown) {
      if (isBudgetExceededError(err)) {
        this.lastError = 'Budget exceeded: ' + err.message;
        return 0;
      }
      throw err;
    }

    // Past this point the daily slot is spent whatever happens.
    this.lastProposalAt = now;
    this.proposalsToday++;

    const already = Array.from(this.attempted);
    const systemPrompt = [
      'You decompose a standing mission into ONE concrete, self-contained coding task.',
      'Reply with ONLY a JSON object - no prose, no code fence - of exactly this shape:',
      '{"name":"kebab-case-id","testCommand":"node --test test.js","files":{"test.js":"<test source>","src/index.js":"<stub source>"}}',
      'The test must fail against the stub, so an agent has something real to implement.',
    ].join('\n');
    const userPrompt = [
      'MISSION: ' + this.opts.mission,
      '',
      'ALREADY ATTEMPTED (do not repeat): ' + (already.length > 0 ? already.join(', ') : '(none)'),
      '',
      'Propose the single most valuable next task.',
    ].join('\n');

    this.opts.ledger.markDispatched(reservation.id);

    let raw: string;
    try {
      const res = await this.opts.llmClient.generateCode({
        modelId: this.opts.modelId,
        systemPrompt,
        userPrompt,
        maxTokens: 2048,
      });
      this.opts.ledger.reconcile(reservation.id, res.inputTokens, res.outputTokens);
      raw = res.content;
    } catch (err: any) {
      this.lastError = 'Proposal request failed: ' + (err?.message ?? String(err));
      return 0;
    }

    const spec = this.parseProposal(raw);
    if (!spec) return 0; // parseProposal recorded the reason

    if (this.attempted.has(spec.name)) {
      this.lastError = 'Duplicate proposal rejected: ' + spec.name;
      return 0;
    }

    // Pre-flight BEFORE accepting. A proposal whose test cannot load is
    // unpassable by construction, and the anti-tamper restore means even a
    // correct diagnosis by the agent gets reverted before grading.
    if (!this.opts.skipPreflight) {
      const preflight = await runPreflight(this.sandbox, spec, {
        timeoutMs: this.opts.preflightTimeoutMs,
      });
      if (preflight.verdict !== 'USABLE') {
        // The name is still marked attempted: re-proposing the same broken task
        // would burn another slot on a task already proven unusable.
        this.attempted.add(spec.name);
        this.lastError =
          `Proposal "${spec.name}" rejected by pre-flight (${preflight.verdict}): ${preflight.reason}` +
          (preflight.output ? ` | output: ${preflight.output.slice(0, 200)}` : '');
        return 0;
      }
    }

    this.attempted.add(spec.name);
    this.opts.registerTaskDefinition(spec.name, {
      initialFiles: spec.files,
      testCommand: spec.testCommand,
    });
    store.createTaskRun({ agentId: this.opts.agentId, taskName: spec.name });
    this.lastError = null;
    return 1;
    } finally { release?.(); }
  }

  /** Strict parse. A malformed proposal is a recorded failure, never a silent skip. */
  private parseProposal(raw: string): ProposalSpec | null {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = (fenced ? fenced[1] : raw).trim();

    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.lastError = 'Proposal was not valid JSON: ' + body.slice(0, 120);
      return null;
    }

    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    const testCommand = typeof parsed?.testCommand === 'string' ? parsed.testCommand.trim() : '';
    const files = parsed?.files;

    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) {
      this.lastError = 'Proposal name is not a safe kebab-case id: ' + JSON.stringify(parsed?.name);
      return null;
    }
    if (!testCommand) {
      this.lastError = 'Proposal is missing testCommand.';
      return null;
    }
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      this.lastError = 'Proposal is missing files.';
      return null;
    }
    for (const [k, v] of Object.entries(files)) {
      if (typeof v !== 'string') {
        this.lastError = 'Proposal file "' + k + '" is not a string.';
        return null;
      }
      // The staging layer guards the host too, but reject traversal at the source.
      if (k.startsWith('/') || k.startsWith('\\') || k.includes('..')) {
        this.lastError = 'Proposal file path escapes the workspace: ' + k;
        return null;
      }
    }

    return { name, testCommand, files: files as Record<string, string> };
  }
}
