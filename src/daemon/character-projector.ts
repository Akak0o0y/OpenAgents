/**
 * Character outcome projector.
 * Maps Stage 1 publishing events and acknowledgements onto the character post journal.
 * Idempotent: replaying signals never changes terminal outcomes or emits duplicate transitions.
 */

import type { AgentStore } from './agent-store.js';
import type { ExecutionEventRecord } from './db/schema.js';
import {
  CharacterJournal,
  type UtteranceRow,
  type UtteranceStatus,
  type RawUtterance,
  mapUtterance,
} from './character-journal.js';

export type ProjectionSignal = {
  type: 'PUBLISH_ATTEMPTED' | 'PUBLISH_OBSERVED' | 'PUBLISH_RECONCILED' | 'EXTERNAL_ACTION_ACKNOWLEDGED';
  payload: Record<string, unknown>;
  at: number;
};

/**
 * Pure function to derive the next utterance status from current status and Stage 1 signals.
 * (D24, P2-C4)
 */
export function deriveOutcome(
  current: { status: UtteranceStatus; acknowledgedAt: number | null },
  signals: readonly ProjectionSignal[],
  runEnded: boolean
): { status: UtteranceStatus; postUrl: string | null; acknowledgedAt: number | null } {
  // Terminal states (confirmed, rejected) never change on any signal
  if (current.status === 'confirmed' || current.status === 'rejected') {
    return {
      status: current.status,
      postUrl: null,
      acknowledgedAt: current.acknowledgedAt,
    };
  }

  let hasConfirmed = false;
  let postUrl: string | null = null;
  let hasRejected = false;
  let hasUnobserved = false;
  let acknowledgedAt = current.acknowledgedAt;

  for (const s of signals) {
    if (s.type === 'EXTERNAL_ACTION_ACKNOWLEDGED') {
      const pAt = typeof s.payload?.at === 'number' ? s.payload.at : undefined;
      acknowledgedAt = pAt ?? s.at;
    } else if (s.type === 'PUBLISH_OBSERVED') {
      const outcome = s.payload?.outcome;
      if (outcome === 'confirmed') {
        hasConfirmed = true;
        if (typeof s.payload?.postUrl === 'string' && s.payload.postUrl) {
          postUrl = s.payload.postUrl;
        }
      } else if (outcome === 'rejected') {
        hasRejected = true;
      } else if (outcome === 'unobserved') {
        hasUnobserved = true;
      }
    } else if (s.type === 'PUBLISH_RECONCILED') {
      const verdict = s.payload?.verdict;
      if (verdict === 'present') {
        hasConfirmed = true;
        if (typeof s.payload?.postUrl === 'string' && s.payload.postUrl) {
          postUrl = s.payload.postUrl;
        }
      }
      // 'not-found' is no proof and changes nothing (C4)
    }
  }

  // Confirmed proof wins over rejected (D24, P2-C4 table row 10)
  if (hasConfirmed) {
    return {
      status: 'confirmed',
      postUrl,
      acknowledgedAt,
    };
  }

  if (hasRejected) {
    return {
      status: 'rejected',
      postUrl: null,
      acknowledgedAt,
    };
  }

  // Unobserved, acknowledged, runEnded, or already uncertain -> uncertain
  if (hasUnobserved || acknowledgedAt !== null || runEnded || current.status === 'uncertain') {
    return {
      status: 'uncertain',
      postUrl: null,
      acknowledgedAt,
    };
  }

  // Otherwise, stays current status (e.g. attempted)
  return {
    status: current.status,
    postUrl: null,
    acknowledgedAt,
  };
}

export class CharacterProjector {
  private readonly store: AgentStore;
  private readonly journal: CharacterJournal;
  private readonly now: () => number;
  private readonly watchLimit: number;
  private readonly watchedRuns = new Set<string>();

  constructor(opts: {
    store: AgentStore;
    journal: CharacterJournal;
    now?: () => number;
    watchLimit?: number; /* 500 */
  }) {
    this.store = opts.store;
    this.journal = opts.journal;
    this.now = opts.now ?? (() => Date.now());
    this.watchLimit = opts.watchLimit ?? 500;
  }

  watchRun(runId: string): void {
    if (this.watchedRuns.has(runId)) {
      this.watchedRuns.delete(runId);
    }
    this.watchedRuns.add(runId);
    while (this.watchedRuns.size > this.watchLimit) {
      const first = this.watchedRuns.values().next().value;
      if (first !== undefined) {
        this.watchedRuns.delete(first);
      }
    }
  }

  onEvent(event: ExecutionEventRecord): void {
    const isAck = event.event_type === 'EXTERNAL_ACTION_ACKNOWLEDGED';
    const isPublish =
      event.event_type === 'PUBLISH_ATTEMPTED' ||
      event.event_type === 'PUBLISH_OBSERVED' ||
      event.event_type === 'PUBLISH_RECONCILED';

    if (!isAck && !isPublish) {
      return;
    }

    // Only react to PUBLISH_* for watched runs. Acknowledgements are always projected.
    if (isPublish && !this.watchedRuns.has(event.task_run_id)) {
      return;
    }

    // Inside someone else's transaction, defer itself with setImmediate (db.isTransaction)
    if (this.store.getDatabase().isTransaction) {
      setImmediate(() => this.onEvent(event));
      return;
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = typeof event.payload_json === 'string'
        ? JSON.parse(event.payload_json)
        : (event.payload_json ?? {});
    } catch {
      return;
    }

    const publishId = isAck
      ? (typeof payload.key === 'string' ? payload.key : null)
      : (typeof payload.publishId === 'string' ? payload.publishId : null);

    if (!publishId) {
      return;
    }

    const utterance = this.journal.byPublishId(publishId);
    if (!utterance) {
      // Deleted or unknown row is never recreated
      return;
    }

    if (utterance.status === 'confirmed' || utterance.status === 'rejected') {
      return;
    }

    const signals = this.collectSignals(publishId, event);
    const runEnded = this.isRunEnded(utterance.runId);
    this.projectUtterance(utterance, signals, runEnded);
  }

  settleRun(runId: string): void {
    if (this.store.getDatabase().isTransaction) {
      setImmediate(() => this.settleRun(runId));
      return;
    }

    const db = this.store.getDatabase();
    const rows = db.prepare(`
      SELECT * FROM bot_character_utterances
      WHERE run_id = ? AND status IN ('draft', 'attempted')
      ORDER BY created_at ASC
    `).all(runId) as unknown as RawUtterance[];

    for (const raw of rows) {
      const utt = mapUtterance(raw);
      if (utt.status === 'draft') {
        this.journal.hold(utt.id, 'interrupted', utt.semantic);
      } else if (utt.status === 'attempted') {
        if (utt.publishId) {
          const signals = this.collectSignals(utt.publishId);
          this.projectUtterance(utt, signals, true);
        }
      }
    }
  }

  repairAgent(agentId: string): void {
    if (this.store.getDatabase().isTransaction) {
      setImmediate(() => this.repairAgent(agentId));
      return;
    }

    const unresolved = this.journal.unresolved(agentId);
    for (const utt of unresolved) {
      if (utt.status === 'draft') {
        if (this.isRunEnded(utt.runId)) {
          this.journal.hold(utt.id, 'interrupted', utt.semantic);
        }
      } else if (utt.status === 'attempted' || utt.status === 'uncertain') {
        if (utt.publishId) {
          const runEnded = this.isRunEnded(utt.runId);
          const signals = this.collectSignals(utt.publishId);
          this.projectUtterance(utt, signals, runEnded);
        }
      }
    }
  }

  repairAll(): { expired: number; held: number; projected: number } {
    if (this.store.getDatabase().isTransaction) {
      throw new Error('repairAll cannot run inside an existing transaction');
    }

    let expired = 0;
    let held = 0;
    let projected = 0;

    const db = this.store.getDatabase();

    // 1. admitted -> expired('restart')
    const admittedRows = db.prepare(`
      SELECT id FROM bot_character_utterances WHERE status = 'admitted'
    `).all() as Array<{ id: string }>;
    for (const { id } of admittedRows) {
      if (this.journal.expire(id, 'restart')) {
        expired++;
      }
    }

    // 2. draft -> held('interrupted')
    const draftRows = db.prepare(`
      SELECT id, semantic FROM bot_character_utterances WHERE status = 'draft'
    `).all() as Array<{ id: string; semantic: string | null }>;
    for (const row of draftRows) {
      if (this.journal.hold(row.id, 'interrupted', row.semantic as any)) {
        held++;
      }
    }

    // 3. attempted/uncertain -> derive outcome (with runEnded = true)
    const pendingRows = db.prepare(`
      SELECT * FROM bot_character_utterances WHERE status IN ('attempted', 'uncertain')
      ORDER BY created_at ASC
    `).all() as unknown as RawUtterance[];
    for (const raw of pendingRows) {
      const utt = mapUtterance(raw);
      if (utt.publishId) {
        const signals = this.collectSignals(utt.publishId);
        if (this.projectUtterance(utt, signals, true)) {
          projected++;
        }
      }
    }

    return { expired, held, projected };
  }

  private isRunEnded(runId: string): boolean {
    const row = this.store.getDatabase().prepare('SELECT status FROM task_runs WHERE id = ?').get(runId) as { status: string } | undefined;
    if (!row) return false;
    return row.status !== 'QUEUED' && row.status !== 'RUNNING';
  }

  private collectSignals(publishId: string, incomingEvent?: ExecutionEventRecord): ProjectionSignal[] {
    const db = this.store.getDatabase();
    const rows = db.prepare(`
      SELECT event_type, payload_json, timestamp
      FROM execution_events
      WHERE (
        json_extract(payload_json, '$.publishId') = ?
        OR json_extract(payload_json, '$.key') = ?
      )
      AND event_type IN ('PUBLISH_ATTEMPTED', 'PUBLISH_OBSERVED', 'PUBLISH_RECONCILED', 'EXTERNAL_ACTION_ACKNOWLEDGED')
      ORDER BY id ASC
    `).all(publishId, publishId) as Array<{
      event_type: string;
      payload_json: string;
      timestamp: number;
    }>;

    const signals: ProjectionSignal[] = [];
    for (const r of rows) {
      let p: Record<string, unknown> = {};
      try {
        p = typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : (r.payload_json ?? {});
      } catch {}
      signals.push({
        type: r.event_type as ProjectionSignal['type'],
        payload: p,
        at: Number(r.timestamp),
      });
    }

    if (incomingEvent) {
      let incomingPayload: Record<string, unknown> = {};
      try {
        incomingPayload = typeof incomingEvent.payload_json === 'string'
          ? JSON.parse(incomingEvent.payload_json)
          : (incomingEvent.payload_json ?? {});
      } catch {}

      const incomingPublishId = incomingEvent.event_type === 'EXTERNAL_ACTION_ACKNOWLEDGED'
        ? incomingPayload?.key
        : incomingPayload?.publishId;

      if (incomingPublishId === publishId) {
        const exists = signals.some(
          s => s.type === incomingEvent.event_type && s.at === Number(incomingEvent.timestamp)
        );
        if (!exists) {
          signals.push({
            type: incomingEvent.event_type as ProjectionSignal['type'],
            payload: incomingPayload,
            at: Number(incomingEvent.timestamp),
          });
        }
      }
    }

    return signals;
  }

  private projectUtterance(
    utt: UtteranceRow,
    signals: readonly ProjectionSignal[],
    runEnded: boolean
  ): boolean {
    const outcome = deriveOutcome(
      { status: utt.status, acknowledgedAt: utt.acknowledgedAt },
      signals,
      runEnded
    );

    const statusChanged = outcome.status !== utt.status;
    const ackChanged = outcome.acknowledgedAt !== utt.acknowledgedAt && outcome.acknowledgedAt !== null;
    const urlChanged = outcome.postUrl !== null && outcome.postUrl !== utt.postUrl;

    if (!statusChanged && !ackChanged && !urlChanged) {
      return false;
    }

    let applied = false;
    this.store.transaction(() => {
      const ok = this.journal.project(utt.id, {
        status: outcome.status as 'confirmed' | 'rejected' | 'uncertain',
        postUrl: outcome.postUrl,
        postId:signals.map(s=>s.type==='PUBLISH_OBSERVED'&&s.payload.outcome==='confirmed'&&typeof s.payload.postId==='string'?s.payload.postId:null).find(Boolean)??null,
        acknowledgedAt: outcome.acknowledgedAt,
      });

      if (ok) {
        applied = true;
        if (statusChanged) {
          this.store.recordEvent({
            task_run_id: utt.runId,
            agent_id: utt.agentId,
            event_type: 'CHARACTER_POSTED',
            payload_json: JSON.stringify({
              utteranceId: utt.id,
              publishId: utt.publishId,
              status: outcome.status,
            }),
            timestamp: this.now(),
          });
        }
      }
    });

    return applied;
  }
}
