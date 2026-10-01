/**
 * Operator control plane: approval gates and steering.
 *
 * Both are the same shape of problem - a human wants to intervene in a loop
 * that is already running - and both are built on one rule:
 *
 *   AN INTERVENTION THAT CANNOT BE APPLIED MUST BE REFUSED, NOT IGNORED.
 *
 * A steer that silently no-ops, or an approval nobody is waiting on, is worse
 * than no feature at all: the operator believes they acted, and the agent
 * carries on regardless.
 */

import { AgentStore } from './agent-store.js';
import type { ApprovalRecord } from './db/schema.js';

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalDecision {
  status: 'APPROVED' | 'DENIED' | 'EXPIRED';
  reason?: string | null;
}

export class ApprovalDeniedError extends Error {
  constructor(
    readonly approvalId: string,
    readonly reason?: string | null
  ) {
    super(`Operator denied approval ${approvalId}${reason ? `: ${reason}` : '.'}`);
    this.name = 'ApprovalDeniedError';
  }
}

interface Waiter {
  resolve: (decision: ApprovalDecision) => void;
  timer?: NodeJS.Timeout;
}

/** Carries out an operator's decision on a proposal. */
export type ProposalHandler = (record: ApprovalRecord, status: 'APPROVED' | 'DENIED', reason: string | null) => void | Promise<void>;

/**
 * Blocks a running task until an operator decides.
 *
 * The task run stays RUNNING while blocked - it has not failed, and it has not
 * finished. The pending row in `approvals` is what says it is waiting.
 */
export class ApprovalGate {
  private waiters = new Map<string, Waiter>();

  constructor(private readonly store: AgentStore) {}

  /**
   * Ask, and wait.
   *
   * `timeoutMs` exists so a run cannot block forever on an operator who went
   * home. On timeout the approval is EXPIRED - not silently approved, which
   * would turn an unattended gate into no gate at all.
   */
  async request(params: {
    taskRunId: string;
    agentId: string;
    kind: string;
    payload?: Record<string, unknown>;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<ApprovalDecision> {
    params.abortSignal?.throwIfAborted();
    const record = this.store.createApproval({
      taskRunId: params.taskRunId,
      agentId: params.agentId,
      kind: params.kind,
      payload: params.payload,
    });

    return new Promise<ApprovalDecision>((resolve) => {
      let onAbort: (() => void) | undefined;
      const settle = (decision: ApprovalDecision) => {
        const waiter = this.waiters.get(record.id);
        if (!waiter) return; // already settled
        if (waiter.timer) clearTimeout(waiter.timer);
        if (onAbort) params.abortSignal?.removeEventListener('abort', onAbort);
        this.waiters.delete(record.id);
        resolve(decision);
      };

      let timer: NodeJS.Timeout | undefined;
      if (params.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          try {
            this.store.decideApproval(
              record.id,
              'EXPIRED',
              `No operator decision within ${params.timeoutMs}ms.`
            );
          } catch {
            // Already decided in the same tick; that path settles it.
          }
          settle({ status: 'EXPIRED', reason: 'timed out' });
        }, params.timeoutMs);
      }

      this.waiters.set(record.id, { resolve: settle, timer });

      // A killed task must not sit here holding a container hostage.
      onAbort = () => {
          try {
            this.store.decideApproval(record.id, 'EXPIRED', 'Task aborted before a decision was made.');
          } catch {
            /* already decided */
          }
          settle({ status: 'EXPIRED', reason: 'aborted' });
        };
      params.abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (params.abortSignal?.aborted) onAbort();
    });
  }

  /**
   * Apply an operator decision and release whatever is waiting.
   *
   * Returns the updated record. Throws if the approval is unknown or already
   * decided - a late click must not reverse a verdict the agent has acted on.
   */
  decide(id: string, status: 'APPROVED' | 'DENIED', reason?: string): ApprovalRecord {
    if (this.store.getApproval(id)?.kind === 'character-change') throw new Error('Use character-decide with the exact proposal revision and change hash.');
    const updated = this.store.decideApproval(id, status, reason);
    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter.resolve({ status, reason: reason ?? null });
    } else {
      const handler = this.handlers.get(updated.kind);
      if (handler) {
        void Promise.resolve()
          .then(() => handler(updated, status, reason ?? null))
          .catch((error) => console.error(`[Approvals] The ${updated.kind} decision could not be carried out:`, error));
      }
    }
    return updated;
  }

  /**
   * Record a PROPOSAL: a decision for the operator that blocks nothing.
   *
   * A chat turn that proposes a routine or a mission ends straight away and
   * says so. The card stays answerable for as long as it takes a person to
   * read it, and the handler registered for its kind does the work when they
   * decide. Before this, the proposing turn waited inside its three-minute run
   * limit on a sixty-second approval, and a person reading the card lost it to
   * a timer, or to the Stop button the waiting composer offered meanwhile.
   */
  propose(params: { taskRunId: string; agentId: string; kind: string; payload?: Record<string, unknown> }): ApprovalRecord {
    if (!this.handlers.has(params.kind)) throw new Error(`Nothing can carry out a ${params.kind} proposal in this daemon.`);
    return this.store.createApproval(params);
  }

  /** What happens when a proposal of this kind is decided. */
  onDecision(kind: string, handler: ProposalHandler): void {
    this.handlers.set(kind, handler);
  }

  canPropose(kind: string): boolean {
    return this.handlers.has(kind);
  }

  private handlers = new Map<string, ProposalHandler>();

  /** Approvals this process is actually waiting on. */
  pendingIds(): string[] {
    return [...this.waiters.keys()];
  }

  /**
   * True when a decision would reach a live waiter.
   *
   * A PENDING row whose waiter died with a previous daemon is answerable in the
   * database but connected to nothing - callers use this to say so.
   */
  isWaiting(id: string, kind?: string): boolean {
    // A proposal has no waiter by design; its handler is what a decision reaches.
    return this.waiters.has(id) || (kind !== undefined && this.handlers.has(kind));
  }
}

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

export class SteerNotSupportedError extends Error {
  constructor(readonly executor: string) {
    super(
      `Steering is not supported for the "${executor}" executor. ` +
        `OpenCode runs its own loop inside the container, so an injected message would be discarded - ` +
        `refusing rather than pretending it was delivered.`
    );
    this.name = 'SteerNotSupportedError';
  }
}

/**
 * Messages an operator has queued for a running task.
 *
 * The builtin loop drains this at a turn boundary, so a steer lands between
 * turns rather than mid-flight. Only the builtin executor can honour it:
 * OpenCode owns its own conversation inside the container, and there is no
 * supported way to inject into it, so `assertSupported` refuses instead of
 * queueing a message that would never be read.
 */
export class SteerBus {
  private queues = new Map<string, string[]>();

  /** Throws for an executor that cannot apply a steer. */
  assertSupported(executor: string): void {
    if (executor !== 'builtin' && executor !== 'work') throw new SteerNotSupportedError(executor);
  }

  /** Queue a message for the next turn boundary of this run. */
  push(taskRunId: string, message: string): void {
    const trimmed = message.trim();
    if (!trimmed) throw new Error('Refusing to queue an empty steer message.');
    const queue = this.queues.get(taskRunId) ?? [];
    queue.push(trimmed);
    this.queues.set(taskRunId, queue);
  }

  /** Take everything queued, leaving the queue empty. */
  drain(taskRunId: string): string[] {
    const queue = this.queues.get(taskRunId);
    if (!queue || queue.length === 0) return [];
    this.queues.delete(taskRunId);
    return queue;
  }

  pending(taskRunId: string): number {
    return this.queues.get(taskRunId)?.length ?? 0;
  }

  /** Drop anything queued for a run that has ended. */
  clear(taskRunId: string): void {
    this.queues.delete(taskRunId);
  }
}
