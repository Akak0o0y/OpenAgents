import { RunCapacity } from './run-capacity.js';
import { saveWorkResult } from './work-results.js';
import type { WorkResult, WorkRuntime } from './work-runtime.js';
import type { ChatMessage } from '../evals/llm-client.js';
import type { WorkContract } from './work-contract.js';
/**
 * Daemon Task Scheduler
 * Orchestrates periodic execution cycles:
 * - Cadence interval with concurrency limit.
 * - Queries ProviderRouter for model budget and cooldown BEFORE starting a task.
 * - Tracks active AbortControllers for instant operator kill commands.
 */

import { PROVISIONAL_CONFIG } from './config.js';
import { AgentStore } from './agent-store.js';
import { ProviderRouter } from './provider-router.js';
import { providerKey } from './provider-connections.js';
import { AgentLoop } from './agent-loop.js';
import type { ApprovalGate, SteerBus } from './control-plane.js';
import { OpenCodeExecutor, type OpenCodeExecutorOptions } from './opencode-executor.js';
import { DockerSandbox } from '../kernel/docker-sandbox.js';
import { CostLedger } from '../kernel/cost-ledger.js';
import type { ILLMClient } from '../evals/llm-client.js';
import type { IWorkProducer } from './work-producer.js';
import type { CharacterStore } from './character-store.js';

export interface TaskDefinition {
  /** Snapshot of a supported work contract and this occurrence's instruction. */
  work?: { contract: WorkContract; request: string; sourceOrigin?: string; mission?: boolean; objective?: string; prior?: { runId: string };
    /** Run the instruction as a conversation turn: answer or research with tools, no fixed deliverable. */
    conversation?: boolean;
    sponsorAgentId?: string;
    delegationDepth?: number;
    background?: {id:string;ownerId:string;threadId?:string};
    questionResume?: { threadId?: string; files: Record<string, string> } };
  /** Fail visibly before dispatch when no trustworthy verifier is available. */
  unsupportedReason?: string;
  initialFiles: Record<string, string>;
  testCommand: string;
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * Files restored from this definition before grading, so an agent with real
   * file-editing tools cannot rewrite the supplied verifier. Both executors enforce
   * the initial tests and package manifests; this list adds protected files.
   */
  protectedFiles?: string[];
  /**
   * Block this task before any spend until an operator approves. Honoured by the
   * builtin executor; the OpenCode executor does not implement it yet, so the
   * scheduler refuses the combination rather than running an ungated task.
   */
  requiresApproval?: boolean;
  approvalTimeoutMs?: number;
}

export interface SchedulerOptions {
  workRuntime?: WorkRuntime;
  /**
   * Called inside a work run's finalization, after its result and status are
   * saved. This is where routine and mission results reach the conversation.
   */
  onWorkResult?: (run: NonNullable<ReturnType<AgentStore['getTaskRun']>>, result: WorkResult) => void;
  /** Earlier results a scheduled conversation run should build on rather than repeat. */
  historyFor?: (run: NonNullable<ReturnType<AgentStore['getTaskRun']>>) => ChatMessage[] | undefined;
  canRun?: (runId: string) => boolean;
  capacity?: RunCapacity;
  agentStore: AgentStore;
  providerRouter: ProviderRouter;
  sandbox?: DockerSandbox;
  ledger?: CostLedger;
  llmClient?: ILLMClient;
  approvalGate?: ApprovalGate;
  steerBus?: SteerBus;
  cadenceMs?: number;
  maxConcurrency?: number;
  taskDefinitions?: Record<string, TaskDefinition>; // taskName -> TaskDefinition
  workProducer?: IWorkProducer;
  /** Which executor runs the work. Defaults to PROVISIONAL_CONFIG.EXECUTOR. */
  executor?: 'builtin' | 'opencode';
  /** Extra options forwarded to the OpenCode executor when it is selected. */
  opencode?: Omit<OpenCodeExecutorOptions, 'agentStore' | 'sandbox' | 'ledger'>;
  characterStore?: CharacterStore;
}

interface ActiveTaskHandle {
  taskRunId: string;
  agentId: string;
  abortController: AbortController;
  promise: Promise<void>;
}

export class TaskScheduler {
  private readonly capacity: RunCapacity;
  private readonly workRuntime?: WorkRuntime;
  private readonly canRun: (runId: string) => boolean;
  private readonly approvalGate?: ApprovalGate;
  private readonly onWorkResult?: SchedulerOptions['onWorkResult'];
  private readonly historyFor?: SchedulerOptions['historyFor'];
  private agentStore: AgentStore;
  private providerRouter: ProviderRouter;
  private agentLoop: AgentLoop;
  private openCodeExecutor: OpenCodeExecutor | null = null;
  private cadenceMs: number;
  private maxConcurrency: number;
  private taskDefinitions: Map<string, TaskDefinition> = new Map();
  private activeTasks: Map<string, ActiveTaskHandle> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private workProducer: IWorkProducer | null = null;
  private steerBus?: SteerBus;
  /** Which executor is actually in use, so steer can be refused honestly. */
  readonly executorKind: 'builtin' | 'opencode';
  private isTicking = false;
  private tickCompletion: Promise<void> = Promise.resolve();
  private running = false;

  constructor(options: SchedulerOptions) {
    this.agentStore = options.agentStore;
    this.capacity = options.capacity ?? new RunCapacity(options.maxConcurrency ?? PROVISIONAL_CONFIG.MAX_CONCURRENT_TASKS);
    this.workRuntime = options.workRuntime;
    this.canRun = options.canRun ?? (() => true);
    this.approvalGate = options.approvalGate;
    this.onWorkResult = options.onWorkResult;
    this.historyFor = options.historyFor;
    this.providerRouter = options.providerRouter;
    this.cadenceMs = options.cadenceMs ?? PROVISIONAL_CONFIG.SCHEDULER_CADENCE_MS;
    this.maxConcurrency = options.maxConcurrency ?? PROVISIONAL_CONFIG.MAX_CONCURRENT_TASKS;
    this.workProducer = options.workProducer ?? null;

    this.agentLoop = new AgentLoop({
      agentStore: this.agentStore,
      providerRouter: this.providerRouter,
      sandbox: options.sandbox,
      ledger: options.ledger,
      llmClient: options.llmClient,
      approvalGate: options.approvalGate,
      steerBus: options.steerBus,
      characterStore: options.characterStore,
    });

    this.steerBus = options.steerBus;
    const executorKind = options.executor ?? PROVISIONAL_CONFIG.EXECUTOR;
    this.executorKind = executorKind;
    if (executorKind === 'opencode') {
      // Constructed eagerly so a missing image or key surfaces at boot, not on the
      // first task hours later.
      this.openCodeExecutor = new OpenCodeExecutor({
        agentStore: this.agentStore,
        sandbox: options.sandbox,
        ledger: options.ledger,
        characterStore: options.characterStore,
        ...options.opencode,
      });
    }

    if (options.taskDefinitions) {
      for (const [name, def] of Object.entries(options.taskDefinitions)) {
        this.taskDefinitions.set(name, def);
      }
    }
  }

  registerTaskDefinition(taskName: string, def: TaskDefinition): void {
    this.taskDefinitions.set(taskName, def);
  }

  getTaskDefinition(taskName: string): TaskDefinition | undefined {
    return this.taskDefinitions.get(taskName);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Run first tick immediately
    this.tick().catch(console.error);

    this.timer = setInterval(() => {
      this.tick().catch(console.error);
    }, this.cadenceMs);
  }

  /**
   * Execute a single scheduling cycle.
   */
  async tick(): Promise<void> {
    if (this.isTicking || !this.running) return;
    this.isTicking = true;
    let finishTick!: () => void;
    this.tickCompletion = new Promise(resolve => { finishTick = resolve; });

    try {
      // Produce work BEFORE the concurrency guard. At saturation the backlog must
      // still be replenished, otherwise the queue drains once and never refills.
      if (this.workProducer) {
        try {
          await this.workProducer.produceNextTasks(this.agentStore);
        } catch (err) {
          console.error('[Scheduler] Work producer failed this cycle:', err);
        }
      }

      if (!this.running || this.activeTasks.size >= this.maxConcurrency) {
        return;
      }

      // Query queued tasks
      const queued = this.agentStore.queuedTaskRuns();

      for (const run of queued) {
        // An awaited owner-chat admission is owned by ChatService, never by this producer.
        if(this.capacity.isWaiting(run.id))continue;
        if (this.activeTasks.has(run.id)) continue;
        if (!this.canRun(run.id)) continue;
        if (this.activeTasks.size >= this.maxConcurrency) {
          break;
        }

        const agent = this.agentStore.getAgent(run.agent_id);
        if (!agent || agent.current_status === 'DISABLED' || agent.current_status === 'PAUSED') {
          continue;
        }

        const taskDef = (this.agentStore.getRunDefinition(run.id) as TaskDefinition | null) ?? this.taskDefinitions.get(run.task_name);
        // Supported work retains the chosen model; no implicit fallback.
        const scheduleCheck = this.providerRouter.canSchedule(providerKey(agent), taskDef?.work || agent.connection_id ? undefined : agent.fallback_model_id);
        if (!scheduleCheck.allowed) {
          // Provider is cooling down and no fallback is permitted/available; wait for next cycle
          continue;
        }

        if (!taskDef) {
          this.agentStore.startTaskRun(run.id);
          this.agentStore.finishTaskRun(run.id, 'FAILED', `No task definition registered for "${run.task_name}".`);
          continue;
        }

        // Spawn task in background
        this.spawnTask(agent, run, taskDef);
      }
    } finally {
      this.isTicking = false;
      finishTick();
    }
  }

  private spawnTask(
    agent: ReturnType<AgentStore['getAgent']>,
    run: ReturnType<AgentStore['getTaskRun']>,
    taskDef: TaskDefinition
  ): void {
    if (!agent || !run) return;

    let releaseCapacity:(()=>void)|undefined;
    const abortController = new AbortController();
    // Defer execution until its handle is registered, including synchronous refusals.
    const taskPromise = Promise.resolve().then(async () => {
      try {
        this.agentStore.recordEvent({task_run_id:run.id,agent_id:agent.id,event_type:'RESOURCE_WAIT',timestamp:Date.now(),payload_json:JSON.stringify({resource:'run-and-bot',origin:run.routine_id?'routine':'background',reason:'Waiting for a run slot and this bot.'})});
        releaseCapacity=await this.capacity.wait(run.id,agent.id,abortController.signal);
        abortController.signal.throwIfAborted();
        if (taskDef.unsupportedReason) throw new Error(taskDef.unsupportedReason);
        if (taskDef.work) {
          if (!this.workRuntime) throw new Error('Shared work runtime is unavailable.');
          this.agentStore.startTaskRun(run.id, agent.model_id, { executor: 'work', contractId: taskDef.work.contract.id, routineId: run.routine_id });
          if (taskDef.requiresApproval || agent.requires_approval) {
            if (!this.approvalGate) throw new Error('This bot requires an unavailable approval gate.');
            const decision = await this.approvalGate.request({ taskRunId: run.id, agentId: agent.id, kind: 'scheduled-work',
              payload: { routineId: run.routine_id, contractId: taskDef.work.contract.id, request: taskDef.work.request },
              timeoutMs: taskDef.approvalTimeoutMs ?? 300_000, abortSignal: abortController.signal });
            if (decision.status !== 'APPROVED') throw new Error('Scheduled work approval was denied or expired.');
          }
          abortController.signal.throwIfAborted();
          const work = taskDef.work;
          // Saved result and terminal status commit inside the runtime's finalization, together with any published files.
          await this.workRuntime.execute({ taskRunId: run.id, contract: work.contract, request: work.request, sourceOrigin: work.sourceOrigin, mission: work.mission, objective: work.objective,
            prior: work.prior, signal: abortController.signal, threadId: work.questionResume?.threadId, resumeFiles: work.questionResume?.files,
            background:work.background,sponsorAgentId:work.sponsorAgentId,delegationDepth:work.delegationDepth,
            ...(work.conversation ? { conversation: true, ...(work.questionResume ? {} : { scheduled: { routineId: run.routine_id ?? '' } }), history: this.historyFor?.(run) } : {}),
            commit: result => {
              saveWorkResult(this.agentStore, run.id, result);
              this.agentStore.finishTaskRun(run.id, result.outcome, result.outcome === 'COMPLETED' ? undefined : result.report,
                { executor: 'work', contractId: work.contract.id, routineId: run.routine_id, report: result.report, artifacts: result.artifacts.map(a => a.id) });
              // Delivering the result to the conversation must never undo saving it.
              try { this.onWorkResult?.(run, result); } catch (error) { console.error('[Scheduler] The result could not be posted to the conversation:', error); }
            } });
        } else if (this.openCodeExecutor) {
          // The OpenCode executor has no approval gate. Running an ungated task
          // that asked to be gated would silently remove the guarantee, so this
          // fails the run loudly instead.
          if (taskDef.requiresApproval || agent.requires_approval) {
            throw new Error(
              `Task "${run.task_name}" requires approval, but the OpenCode executor does not ` +
                `implement approval gating. Refusing to run it ungated.`
            );
          }
          await this.openCodeExecutor.executeTask({
            agent,
            taskRun: run,
            initialFiles: taskDef.initialFiles,
            testCommand: taskDef.testCommand,
            protectedFiles: taskDef.protectedFiles,
            abortSignal: abortController.signal,
            timeoutMs: taskDef.timeoutMs,
          });
        } else {
          await this.agentLoop.executeTask({
            agent,
            taskRun: run,
            initialFiles: taskDef.initialFiles,
            testCommand: taskDef.testCommand,
            protectedFiles: taskDef.protectedFiles,
            abortSignal: abortController.signal,
            maxTurns: taskDef.maxTurns,
            timeoutMs: taskDef.timeoutMs,
            requiresApproval: taskDef.requiresApproval || !!agent.requires_approval,
            approvalTimeoutMs: taskDef.approvalTimeoutMs,
          });
        }
      } catch (err: any) {
        console.error(`Task ${run.id} failed unexpectedly:`, err);
        const current = this.agentStore.getTaskRun(run.id);
        if (current?.status === 'QUEUED') this.agentStore.startTaskRun(run.id);
        if (this.agentStore.getTaskRun(run.id)?.status === 'RUNNING') {
          this.agentStore.finishTaskRun(run.id, abortController.signal.aborted ? 'ABORTED' : 'FAILED', String(err?.message ?? err));
        }
      } finally {
        // Queued steers for a finished run would otherwise leak, and worse,
        // could be applied to a later run that reused the id.
        this.steerBus?.clear(run.id);
        this.activeTasks.delete(run.id);
        releaseCapacity?.();
      }
    });

    this.activeTasks.set(run.id, {
      taskRunId: run.id,
      agentId: agent.id,
      abortController,
      promise: taskPromise,
    });
  }

  /**
   * Operator kill command: abort in-flight task execution immediately.
   */
  abortTask(taskRunId: string): boolean {
    const active = this.activeTasks.get(taskRunId);
    if (!active) {
      // Check if it's currently queued
      const run = this.agentStore.getTaskRun(taskRunId);
      if (run && run.status === 'QUEUED') {
        this.agentStore.startTaskRun(taskRunId);
        this.agentStore.finishTaskRun(taskRunId, 'ABORTED', 'Aborted while queued');
        return true;
      }
      return false;
    }

    active.abortController.abort();
    return true;
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // A producer may still be completing an asynchronous tick. Do not close its
    // database or miss tasks started by that tick while shutdown is in progress.
    await this.tickCompletion;

    // Abort all active tasks
    for (const handle of this.activeTasks.values()) {
      handle.abortController.abort();
    }

    // Await all in-flight tasks
    const activePromises = Array.from(this.activeTasks.values()).map((h) => h.promise);
    await Promise.allSettled(activePromises);
    this.activeTasks.clear();
  }
}
