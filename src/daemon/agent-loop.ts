/**
 * Production Conversational Agent Execution Loop
 * Promoted from trace-runner.ts with three architectural differences:
 * 1. Conversational History: accumulates dialogue turns AND transmits them.
 *    (Until the layer-2 audit fix, this loop accumulated `messages` and then
 *    sent only `messages[last]`, so it was silently stateless - the model could
 *    not see its own prior attempts. `LLMRequest.messages` is what carries it.)
 * 2. Multi-File Workspace: Parses and tracks mutations across all workspace files.
 *    A response with no code fence is REJECTED, never written as prose.
 * 3. Event & Abort Synchronization: Synchronously records events through the
 *    store (which owns lifecycle events and the single broadcast fan-out), and
 *    responds immediately to AbortSignal for operator kill commands.
 */

import { DockerSandbox } from '../kernel/docker-sandbox.js';
import { CostLedger, isBudgetExceededError, isRateLimitExceededError } from '../kernel/cost-ledger.js';
import { ThrashDetector } from '../kernel/thrash-detector.js';
import { LiveLLMClient, ProviderCallError, type ILLMClient, type ChatMessage } from '../evals/llm-client.js';
import { AgentStore } from './agent-store.js';
import { ProviderRouter } from './provider-router.js';
import { ApprovalDeniedError, type ApprovalGate, type SteerBus } from './control-plane.js';
import { PROVISIONAL_CONFIG } from './config.js';
import type { AgentRecord, TaskRunRecord } from './db/schema.js';
import { taskContext, protectedTaskFiles } from './task-input.js';
import type { CharacterStore } from './character-store.js';

export interface AgentLoopOptions {
  sandbox?: DockerSandbox;
  ledger?: CostLedger;
  agentStore: AgentStore;
  providerRouter: ProviderRouter;
  llmClient?: ILLMClient;
  /** Operator gate. Omitted means no task can ever require approval. */
  approvalGate?: ApprovalGate;
  /** Operator steering. Omitted means steer messages are never applied. */
  steerBus?: SteerBus;
  characterStore?: CharacterStore;
}

export interface RunAgentTaskParams {
  agent: AgentRecord;
  taskRun: TaskRunRecord;
  initialFiles: Record<string, string>;
  testCommand: string;
  abortSignal?: AbortSignal;
  maxTurns?: number;
  timeoutMs?: number;
  /** Block before spending anything until an operator approves this run. */
  requiresApproval?: boolean;
  /** How long to wait for that decision before EXPIRING it. */
  approvalTimeoutMs?: number;
  protectedFiles?: string[];
}

export interface AgentLoopResult {
  outcome:
    | 'COMPLETED'
    | 'FAILED'
    | 'ABORTED'
    | 'CRASHED'
    | 'HIT_BUDGET_CAP'
    | 'RATE_LIMITED'
    | 'DENIED';
  turnsTaken: number;
  actualCostUsd: number;
  shadowCostUsd: number;
  errorMessage?: string;
}

export class AgentLoop {
  private sandbox: DockerSandbox;
  private ledger: CostLedger;
  private agentStore: AgentStore;
  private providerRouter: ProviderRouter;
  private llmClient: ILLMClient;
  private approvalGate?: ApprovalGate;
  private steerBus?: SteerBus;
  private characterStore?: CharacterStore;

  constructor(options: AgentLoopOptions) {
    this.sandbox = options.sandbox ?? new DockerSandbox();
    this.ledger = options.ledger ?? new CostLedger(PROVISIONAL_CONFIG.DB_PATH);
    this.agentStore = options.agentStore;
    this.providerRouter = options.providerRouter;
    this.llmClient = options.llmClient ?? new LiveLLMClient();
    this.approvalGate = options.approvalGate;
    this.steerBus = options.steerBus;
    this.characterStore = options.characterStore;
  }

  /**
   * Parse multi-file code blocks from a conversational response.
   * Recognizes:
   * 1. // filename: src/index.js
   * 2. ```javascript:src/index.js
   * 3. An unlabeled fence, which defaults to src/index.js
   *
   * It deliberately does NOT accept a response with no code fence at all.
   * That path used to write the model's entire prose reply into src/index.js,
   * so a chatty answer silently corrupted the workspace and the tests then
   * failed for a reason that had nothing to do with the model's competence -
   * which in turn fed a fresh error fingerprint to the thrash detector and hid
   * the real cause. A missing fence is now a reported parse failure, matching
   * how trace-runner already tracks `codeFenceMissing`.
   */
  private extractFilesFromResponse(
    responseContent: string,
    existingFiles: Record<string, string>
  ): { files: Record<string, string>; codeFenceMissing: boolean; unlabeledFences: number } {
    const updated = { ...existingFiles };
    const stripped = responseContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Match code blocks with optional file path headers
    const blockRegex = /```(?:[a-zA-Z0-9_-]+)?(?::([^\n]+))?\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    let matchCount = 0;
    let unlabeledFences = 0;

    while ((match = blockRegex.exec(stripped)) !== null) {
      matchCount++;
      let filePath = match[1]?.trim();
      const content = match[2].trim();

      // If no explicit language:filepath header, inspect first line for comment path
      if (!filePath) {
        const firstLine = content.split('\n')[0].trim();
        const commentMatch = firstLine.match(/^(?:\/\/|#|\/\*)\s*(?:filename:|file:)?\s*([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/i);
        if (commentMatch) {
          filePath = commentMatch[1];
        }
      }

      // An unlabeled fence still defaults to the single-file convention the
      // system prompt describes, but it is counted so the drift is visible.
      if (!filePath) {
        filePath = 'src/index.js';
        unlabeledFences++;
      }

      updated[filePath] = content;
    }

    // No fence at all: refuse to write anything. The caller turns this into a
    // corrective turn rather than staging prose as source.
    return {
      files: updated,
      codeFenceMissing: matchCount === 0,
      unlabeledFences,
    };
  }

  /**
   * Execute the conversational multi-turn task loop.
   */
  async executeTask(params: RunAgentTaskParams): Promise<AgentLoopResult> {
    const { agent, taskRun, initialFiles, testCommand, abortSignal } = params;
    if (agent.connection_id) {
      throw new Error(`Bot "${agent.id}" uses provider connection "${agent.connection_id}". The built-in coding loop is not wired for provider connections yet, so this task was refused instead of being sent to another provider.`);
    }
    const maxTurns = params.maxTurns ?? PROVISIONAL_CONFIG.PROVISIONAL_TURN_CEILING;
    const taskTimeoutMs = params.timeoutMs ?? PROVISIONAL_CONFIG.DEFAULT_TASK_TIMEOUT_MS;

    let volumeName: string | null = null;
    const thrashDetector = new ThrashDetector(
      PROVISIONAL_CONFIG.PROVISIONAL_THRASH_MAX_DUPLICATE_ERRORS,
      PROVISIONAL_CONFIG.PROVISIONAL_THRASH_MAX_MUTATION_STAGNANT_TURNS
    );

    let workspaceFiles: Record<string, string> = { ...initialFiles };
    let actualCostUsd = 0.0;
    let shadowCostUsd = 0.0;
    let turnsTaken = 0;
    let outcome: AgentLoopResult['outcome'] = 'FAILED';
    let errorMessage: string | undefined;

    const messages: ChatMessage[] = [];

    // System Prompt
    const codeFallback = agent.system_prompt ?? `You are ${agent.name}, an expert autonomous software engineer.`;
    const resolvedIdentity = this.characterStore?.identityFor(agent, {
      surface: 'code',
      fallback: codeFallback,
    });
    const systemPrompt = `${resolvedIdentity?.stable ?? codeFallback}\n\nFor this coding task, follow the execution format below.
You are implementing code to satisfy acceptance criteria and make all tests pass.
The project uses ES Modules ("type": "module"), so ensure you use named ES exports (e.g. export class / export function).
When writing files, format each file inside a markdown code fence labeled with the relative file path, e.g.:
\`\`\`javascript:src/index.js
// code here
\`\`\`
Return only clean, production-ready code.`;

    let currentModel = taskRun.model_id ?? agent.model_id;

    try {
      // 1. Mark task as RUNNING in store with attributed model_id.
      // The store owns TASK_STARTED; this loop contributes detail rather than
      // emitting a second copy of the same transition.
      this.agentStore.startTaskRun(taskRun.id, currentModel, { executor: 'builtin', maxTurns });
    // Initial User Prompt
    let userPrompt = `Task Name: ${taskRun.task_name}
Initial Workspace Files:
${taskContext(workspaceFiles)}

Verification command: ${testCommand}

Please review the requirements, implement the required modules, and ensure all tests pass.`;

    messages.push({ role: 'user', content: userPrompt });

      abortSignal?.throwIfAborted();
      volumeName = await this.sandbox.createWorkspaceVolume(`task-${taskRun.id}`);

      // Layer 1 evidence. `source` matters: a default prompt and an operator's
      // own prompt are different systems, and the panel should not conflate them.
      this.emitEvent({
        task_run_id: taskRun.id,
        agent_id: agent.id,
        model_id: currentModel,
        event_type: 'PROMPT_ASSEMBLED',
        turn_number: 0,
        payload_json: JSON.stringify({
          source: agent.system_prompt ? 'agent' : 'default',
          promptChars: systemPrompt.length,
        }),
        timestamp: Date.now(),
      });

      // 2. Stage initial files to volume
      await this.sandbox.stageWorkspaceFiles(volumeName, initialFiles);

      // 3. Operator gate, BEFORE any spend. The run stays RUNNING while blocked -
      // it has not failed and it has not finished, and the pending approvals row
      // is what records that it is waiting.
      if (params.requiresApproval) {
        if (!this.approvalGate) {
          // Refuse rather than proceed. A task that asked for a gate and got
          // none has had its guarantee silently removed.
          outcome = 'FAILED';
          errorMessage =
            'Task requires approval but this loop was constructed without an ApprovalGate. Refusing to dispatch.';
          throw new Error(errorMessage);
        }
        const decision = await this.approvalGate.request({
          taskRunId: taskRun.id,
          agentId: agent.id,
          kind: 'dispatch',
          payload: { taskName: taskRun.task_name, modelId: currentModel, maxTurns },
          timeoutMs: params.approvalTimeoutMs,
          abortSignal,
        });

        if (decision.status !== 'APPROVED') {
          outcome = decision.status === 'DENIED' ? 'DENIED' : 'ABORTED';
          errorMessage =
            decision.status === 'DENIED'
              ? new ApprovalDeniedError(taskRun.id, decision.reason).message
              : `Approval ${decision.status.toLowerCase()}: ${decision.reason ?? 'no decision'}`;
          return { outcome, turnsTaken, actualCostUsd, shadowCostUsd, errorMessage };
        }
      }

      // 4. Multi-Turn Loop
      for (let turn = 1; turn <= maxTurns; turn++) {
        turnsTaken = turn;

        // Operator steering lands HERE, at a turn boundary, so an injected
        // message is never spliced into a request already in flight.
        for (const steer of this.steerBus?.drain(taskRun.id) ?? []) {
          messages.push({ role: 'user', content: steer });
          this.emitEvent({
            task_run_id: taskRun.id,
            agent_id: agent.id,
            model_id: currentModel,
            event_type: 'STEER_APPLIED',
            turn_number: turn,
            payload_json: JSON.stringify({ message: steer.slice(0, 500), messageCount: messages.length }),
            timestamp: Date.now(),
          });
        }

        // Check AbortSignal (e.g. operator kill command)
        if (abortSignal?.aborted) {
          outcome = 'ABORTED';
          errorMessage = 'Operator terminated task execution';
          break;
        }

        // Check Provider Router budget / cooldown (opt-in fallback only)
        const scheduleCheck = this.providerRouter.canSchedule(agent.model_id, agent.fallback_model_id);
        if (!scheduleCheck.allowed) {
          outcome = 'RATE_LIMITED';
          errorMessage = scheduleCheck.reason ?? 'Provider on cooldown';
          break;
        }

        const modelToDispatch = scheduleCheck.modelToUse;
        currentModel = modelToDispatch;
        if (taskRun.model_id !== currentModel) {
          taskRun.model_id = currentModel;
          this.agentStore.getDatabase().prepare(`UPDATE task_runs SET model_id = ? WHERE id = ?`).run(currentModel, taskRun.id);
        }

        // Pre-dispatch budget check
        let reservation;
        try {
          reservation = this.ledger.reserveWithBudgetCheck(
            taskRun.id,
            agent.id,
            modelToDispatch,
            agent.budget_cap_usd,
            15000
          );
        } catch (err: unknown) {
          if (isBudgetExceededError(err)) {
            outcome = 'HIT_BUDGET_CAP';
            errorMessage = err.message;
            break;
          }
          throw err;
        }

        this.ledger.markDispatched(reservation.id);

        // Layer 2 evidence, recorded BEFORE the call so it describes what was
        // actually sent. `chars` is a size proxy, not a token count - this loop
        // has no tokenizer, and a fabricated token number would be worse than an
        // honest one.
        this.emitEvent({
          task_run_id: taskRun.id,
          agent_id: agent.id,
          model_id: modelToDispatch,
          event_type: 'HISTORY_APPENDED',
          turn_number: turn,
          payload_json: JSON.stringify({
            messageCount: messages.length,
            roles: messages.map((m) => m.role),
            chars: messages.reduce((n, m) => n + m.content.length, 0),
          }),
          timestamp: Date.now(),
        });

        // Call LLM
        let response;
        try {
          response = await this.llmClient.generateCode({
            modelId: modelToDispatch,
            systemPrompt,
            // userPrompt stays the latest turn for single-shot compatibility,
            // but `messages` is what actually makes this loop conversational.
            // It used to be accumulated and then discarded here, which left the
            // model blind to its own previous attempts.
            userPrompt: messages[messages.length - 1].content,
            messages,
            maxTokens: 2048, // clamped to avoid 402 out-of-credit rejection
            signal: abortSignal,
            onProviderEvent: event => this.emitEvent({task_run_id:taskRun.id, agent_id:agent.id, model_id:modelToDispatch, event_type:'PROVIDER_CALL', turn_number:turn, timestamp:Date.now(), payload_json:JSON.stringify(event)}),
          });
          this.providerRouter.recordSuccess(modelToDispatch);
        } catch (err: any) {
          if (err instanceof ProviderCallError && err.details.usage) {
            const cost = this.ledger.reconcile(reservation.id, err.details.usage.inputTokens, err.details.usage.outputTokens);
            actualCostUsd += cost.actualCostUsd; shadowCostUsd += cost.shadowCostUsd;
            this.agentStore.updateTaskRunProgress(taskRun.id, turn, actualCostUsd, shadowCostUsd);
          }
          if (isRateLimitExceededError(err)) {
            this.providerRouter.recordError(modelToDispatch, err.status, err.rawBody ?? '');
            outcome = 'RATE_LIMITED';
            errorMessage = err.message;
            break;
          }
          outcome = abortSignal?.aborted ? 'ABORTED' : 'FAILED';
          errorMessage = err.message;
          break;
        }

        // Keep the aggregate retry event for existing Cortex consumers; the
        // provider events above also record failed attempts and their timing.
        if (response.attemptCount > 1) {
          this.emitEvent({
            task_run_id: taskRun.id,
            agent_id: agent.id,
            model_id: modelToDispatch,
            event_type: 'PROVIDER_RETRY',
            turn_number: turn,
            payload_json: JSON.stringify({
              attemptCount: response.attemptCount,
              retries: response.attemptCount - 1,
            }),
            timestamp: Date.now(),
          });
        }

        // Reconcile spend
        const reconciled = response.usageKnown === false ? {actualCostUsd:0, shadowCostUsd:0} : this.ledger.reconcile(
          reservation.id,
          response.inputTokens,
          response.outputTokens
        );
        actualCostUsd += reconciled.actualCostUsd;
        shadowCostUsd += reconciled.shadowCostUsd;

        // Update progress in SQLite
        this.agentStore.updateTaskRunProgress(taskRun.id, turn, actualCostUsd, shadowCostUsd);

        // Check abort after LLM generation
        if (abortSignal?.aborted) {
          outcome = 'ABORTED';
          errorMessage = 'Operator terminated task execution';
          break;
        }

        // Append assistant turn to conversational history
        messages.push({ role: 'assistant', content: response.content });

        // Extract updated files and stage them.
        const extraction = this.extractFilesFromResponse(response.content, workspaceFiles);

        if (extraction.codeFenceMissing) {
          // The format rule is now enforced in code, not merely asserted in the
          // system prompt. Nothing is staged; the model is told plainly.
          this.emitEvent({
            task_run_id: taskRun.id,
            agent_id: agent.id,
            model_id: currentModel,
            event_type: 'RESPONSE_FORMAT_REJECTED',
            turn_number: turn,
            payload_json: JSON.stringify({
              reason: 'No markdown code fence in response; workspace left untouched.',
              responsePreview: response.content.slice(0, 300),
              attemptCount: response.attemptCount,
            }),
            timestamp: Date.now(),
          });
          messages.push({
            role: 'user',
            content:
              'Your reply contained no markdown code fence, so nothing was written. ' +
              'Reply with ONLY fenced code blocks, each labeled with its relative path, e.g.\n' +
              '```javascript:src/index.js\n// code\n```',
          });
          continue;
        }

        workspaceFiles = extraction.files;
        for (const name of protectedTaskFiles(initialFiles, params.protectedFiles)) {
          workspaceFiles[name] = initialFiles[name];
        }
        await this.sandbox.stageWorkspaceFiles(volumeName, workspaceFiles);

        // Check abort before executing container
        if (abortSignal?.aborted) {
          outcome = 'ABORTED';
          errorMessage = 'Operator terminated task execution';
          break;
        }

        // Execute tests
        const execRes = await this.sandbox.executeTask(volumeName, testCommand, {
          timeoutMs: taskTimeoutMs,
          signal: abortSignal,
        });

        // Check abort after executing container
        if (abortSignal?.aborted) {
          outcome = 'ABORTED';
          errorMessage = 'Operator terminated task execution';
          break;
        }

        const combinedOutput = [execRes.stderr.trim(), execRes.stdout.trim()].filter(Boolean).join('\n');
        const testOutput = combinedOutput.trim();
        const testsPassed = execRes.exitCode === 0;

        // Record turn in Thrash Detector
        const thrashState = thrashDetector.recordTurn(turn, testOutput, workspaceFiles);
        if (thrashState.isThrashing) {
          this.emitEvent({
            task_run_id: taskRun.id,
            agent_id: agent.id,
            model_id: currentModel,
            event_type: 'THRASH_WARNING',
            turn_number: turn,
            payload_json: JSON.stringify({
              reason: thrashState.reason,
              lastFingerprint: thrashState.lastFingerprint,
            }),
            timestamp: Date.now(),
          });
        }

        // Broadcast turn completion
        this.emitEvent({
          task_run_id: taskRun.id,
          agent_id: agent.id,
          model_id: currentModel,
          event_type: 'TURN_COMPLETED',
          turn_number: turn,
          payload_json: JSON.stringify({
            modelId: currentModel,
            testsPassed,
            testExitCode: execRes.exitCode,
            testOutput: testOutput.slice(0, 1000), // bounded summary for WS stream
            costUsd: reconciled.actualCostUsd,
            shadowCostUsd: reconciled.shadowCostUsd,
            tokens: { input: response.inputTokens, output: response.outputTokens },
            // Provider-level retries (429/503 backoff) happen inside the client
            // and do not advance the turn number. Recording the count here is
            // what makes that hidden repair loop visible in the audit log.
            attemptCount: response.attemptCount,
            unlabeledFences: extraction.unlabeledFences,
            historyMessages: messages.length,
          }),
          timestamp: Date.now(),
        });

        // Check if tests succeeded
        if (testsPassed) {
          outcome = 'COMPLETED';
          break;
        }

        // Feed failure back into conversational history for next turn
        messages.push({
          role: 'user',
          content: `Test execution failed with exit code ${execRes.exitCode}.\n\nTest Output:\n${testOutput}\n\nPlease analyze the test failure, update the workspace files, and provide the fix.`,
        });
      }
    } catch (error) {
      outcome = abortSignal?.aborted ? 'ABORTED' : 'FAILED';
      errorMessage = abortSignal?.aborted ? 'Operator terminated task execution' : error instanceof Error ? error.message : String(error);
    } finally {
      // Persist the workspace before publishing the terminal event.
      const finalStatus =
        outcome === 'COMPLETED'
          ? 'COMPLETED'
          : outcome === 'ABORTED'
          ? 'ABORTED'
          : 'FAILED';

      // Store owns TASK_<status>; `outcome` is carried separately from `status`
      // because they differ: HIT_BUDGET_CAP and RATE_LIMITED both persist as
      // FAILED, and collapsing them would erase why the run stopped.
      if (volumeName) this.agentStore.setAgentData({ agentId: agent.id, key: taskRun.id, category: 'workspaces', data: { volumeName } });
      this.agentStore.finishTaskRun(taskRun.id, finalStatus, errorMessage, {
        outcome,
        executor: 'builtin',
        modelId: currentModel,
        turnsTaken,
        actualCostUsd,
        shadowCostUsd,
      });


    }

    return {
      outcome,
      turnsTaken,
      actualCostUsd,
      shadowCostUsd,
      errorMessage,
    };
  }

  /**
   * Record a detail event. Broadcasting is NOT done here: the store's event sink
   * is the single fan-out point, so an event emitted through this path reaches
   * the UI exactly once.
   */
  private emitEvent(event: Parameters<AgentStore['recordEvent']>[0]): void {
    this.agentStore.recordEvent(event);
  }
}
