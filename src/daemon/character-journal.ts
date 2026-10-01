/**
 * Character post journal.
 * Tables: bot_character_utterances, bot_character_candidates, bot_character_reviews.
 * Enforces allowed status transitions, candidate/review immutability,
 * and 250 MiB logical-byte storage quota per bot.
 */

import { randomUUID } from 'node:crypto';
import type { AgentStore } from './agent-store.js';

export const CHARACTER_QUOTA_BYTES = 250 * 1024 * 1024; // 262,144,000
export const PREPARATION_RESERVE_BYTES = 64 * 1024;

export type UtteranceStatus =
  | 'draft'
  | 'held'
  | 'admitted'
  | 'refused'
  | 'attempted'
  | 'confirmed'
  | 'rejected'
  | 'uncertain'
  | 'expired';

export type SemanticStatus =
  | 'passed'
  | 'failed'
  | 'unchecked-unavailable'
  | 'unchecked-invalid'
  | 'not-sampled'
  | 'out-of-scope';

export type HeldReason =
  | 'target-unbound'
  | 'evidence-unavailable'
  | 'evidence-missing'
  | 'exact-not-owner'
  | 'storage-full'
  | 'character-off'
  | 'compose-failed'
  | 'rules-failed'
  | 'semantic-failed'
  | 'reviewer-unavailable'
  | 'reviewer-invalid'
  | 'cap-reached'
  | 'budget'
  | 'interrupted';

export type ExpiryReason =
  | 'expired'
  | 'replaced'
  | 'run-ended'
  | 'cancelled'
  | 'takeover'
  | 'version-changed'
  | 'restart';

export type CallUsage = {
  logicalCalls: number;
  wireAttempts: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: null;
  costUsd: number | null;
};

export class CharacterJournalConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharacterJournalConflict';
  }
}

export interface UtteranceRow {
  id: string;
  agentId: string;
  runId: string;
  surface: string;
  op: 'post' | 'reply';
  replyTo: string | null;
  accountHint: string | null;
  text: string | null;
  textSha256: string | null;
  version: number;
  status: UtteranceStatus;
  statusReason: string | null;
  semantic: SemanticStatus | null;
  publishId: string | null;
  postUrl: string | null;
  finalCandidateId: string | null;
  acknowledgedAt: number | null;
  logicalCalls: number;
  wireAttempts: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costUnknown: number;
  createdAt: number;
  updatedAt: number;
}

export interface NewCandidate {
  agentId: string;
  utteranceId: string;
  attempt: number;
  text: string;
  exactSha256: string;
  textSha256: string;
  version: number;
  composePacketSha256?: string | null;
  selection: unknown;
  evidence: unknown;
  rules: unknown;
}

export interface CandidateRow {
  id: string;
  agentId: string;
  utteranceId: string;
  attempt: number;
  text: string;
  exactSha256: string;
  textSha256: string;
  version: number;
  composePacketSha256: string | null;
  selection: unknown;
  evidence: unknown;
  rules: unknown;
  createdAt: number;
}

export interface NewReview {
  agentId: string;
  utteranceId: string;
  candidateId: string;
  runId: string;
  attempt: number;
  callNo: number;
  reviewerModel?: string | null;
  reviewerConnectionId?: string | null;
  sameAsAuthor: boolean;
  rules: unknown;
  verdict: string;
  scores?: unknown | null;
  findings?: unknown | null;
  extracted?: unknown | null;
  composePacketSha256?: string | null;
  reviewPacketSha256?: string | null;
  selection?: unknown | null;
  compilerVersion: string;
  mappingVersion: string;
  reviewerPromptVersion: string;
  logicalCalls: number;
  wireAttempts?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
}

export interface ReviewRow {
  id: string;
  agentId: string;
  utteranceId: string;
  candidateId: string;
  runId: string;
  attempt: number;
  callNo: number;
  reviewerModel: string | null;
  reviewerConnectionId: string | null;
  sameAsAuthor: boolean;
  rules: unknown;
  verdict: string;
  scores: unknown | null;
  findings: unknown | null;
  extracted: unknown | null;
  composePacketSha256: string | null;
  reviewPacketSha256: string | null;
  selection: unknown | null;
  compilerVersion: string;
  mappingVersion: string;
  reviewerPromptVersion: string;
  logicalCalls: number;
  wireAttempts: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  createdAt: number;
}

export interface RawUtterance {
  id: string;
  agent_id: string;
  run_id: string;
  surface: string;
  op: string;
  reply_to: string | null;
  account_hint: string | null;
  text: string | null;
  text_sha256: string | null;
  version: number;
  status: string;
  status_reason: string | null;
  semantic: string | null;
  publish_id: string | null;
  post_url: string | null;
  final_candidate_id: string | null;
  acknowledged_at: number | null;
  logical_calls: number;
  wire_attempts: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_unknown: number;
  created_at: number;
  updated_at: number;
}

interface RawCandidate {
  id: string;
  agent_id: string;
  utterance_id: string;
  attempt: number;
  text: string;
  exact_sha256: string;
  text_sha256: string;
  version: number;
  compose_packet_sha256: string | null;
  selection_json: string;
  evidence_json: string;
  rules_json: string;
  created_at: number;
}

interface RawReview {
  id: string;
  agent_id: string;
  utterance_id: string;
  candidate_id: string;
  run_id: string;
  attempt: number;
  call_no: number;
  reviewer_model: string | null;
  reviewer_connection_id: string | null;
  same_as_author: number;
  rules_json: string;
  verdict: string;
  scores_json: string | null;
  findings_json: string | null;
  extracted_json: string | null;
  compose_packet_sha256: string | null;
  review_packet_sha256: string | null;
  selection_json: string | null;
  compiler_version: string;
  mapping_version: string;
  reviewer_prompt_version: string;
  logical_calls: number;
  wire_attempts: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  created_at: number;
}

function parseJsonSafe<T>(jsonStr: string | null, fallback: T): T {
  if (!jsonStr) return fallback;
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return fallback;
  }
}

export function mapUtterance(raw: RawUtterance): UtteranceRow {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    runId: raw.run_id,
    surface: raw.surface,
    op: raw.op as 'post' | 'reply',
    replyTo: raw.reply_to,
    accountHint: raw.account_hint,
    text: raw.text,
    textSha256: raw.text_sha256,
    version: raw.version,
    status: raw.status as UtteranceStatus,
    statusReason: raw.status_reason,
    semantic: raw.semantic as SemanticStatus | null,
    publishId: raw.publish_id,
    postUrl: raw.post_url,
    finalCandidateId: raw.final_candidate_id,
    acknowledgedAt: raw.acknowledged_at,
    logicalCalls: raw.logical_calls,
    wireAttempts: raw.wire_attempts,
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    costUsd: raw.cost_usd,
    costUnknown: raw.cost_unknown,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function mapCandidate(raw: RawCandidate): CandidateRow {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    utteranceId: raw.utterance_id,
    attempt: raw.attempt,
    text: raw.text,
    exactSha256: raw.exact_sha256,
    textSha256: raw.text_sha256,
    version: raw.version,
    composePacketSha256: raw.compose_packet_sha256,
    selection: parseJsonSafe(raw.selection_json, {}),
    evidence: parseJsonSafe(raw.evidence_json, []),
    rules: parseJsonSafe(raw.rules_json, {}),
    createdAt: raw.created_at,
  };
}

function mapReview(raw: RawReview): ReviewRow {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    utteranceId: raw.utterance_id,
    candidateId: raw.candidate_id,
    runId: raw.run_id,
    attempt: raw.attempt,
    callNo: raw.call_no,
    reviewerModel: raw.reviewer_model,
    reviewerConnectionId: raw.reviewer_connection_id,
    sameAsAuthor: raw.same_as_author === 1,
    rules: parseJsonSafe(raw.rules_json, {}),
    verdict: raw.verdict,
    scores: parseJsonSafe(raw.scores_json, null),
    findings: parseJsonSafe(raw.findings_json, null),
    extracted: parseJsonSafe(raw.extracted_json, null),
    composePacketSha256: raw.compose_packet_sha256,
    reviewPacketSha256: raw.review_packet_sha256,
    selection: parseJsonSafe(raw.selection_json, null),
    compilerVersion: raw.compiler_version,
    mappingVersion: raw.mapping_version,
    reviewerPromptVersion: raw.reviewer_prompt_version,
    logicalCalls: raw.logical_calls,
    wireAttempts: raw.wire_attempts,
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cachedTokens: raw.cached_tokens,
    costUsd: raw.cost_usd,
    latencyMs: raw.latency_ms,
    createdAt: raw.created_at,
  };
}

export class CharacterJournal {
  private readonly store: AgentStore;
  private readonly now: () => number;
  private readonly ids: () => string;
  readonly quotaBytes: number;

  constructor(opts: {
    store: AgentStore;
    now?: () => number;
    ids?: () => string;
    quotaBytes?: number;
  }) {
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
    this.ids = opts.ids ?? (() => randomUUID());
    this.quotaBytes = opts.quotaBytes ?? CHARACTER_QUOTA_BYTES;
    this.initSchema();
  }

  private initSchema(): void {
    const db = this.store.getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_character_utterances (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        surface TEXT NOT NULL,
        op TEXT NOT NULL,
        reply_to TEXT,
        account_hint TEXT,
        text TEXT,
        text_sha256 TEXT,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        status_reason TEXT,
        semantic TEXT,
        publish_id TEXT UNIQUE,
        post_url TEXT,
        final_candidate_id TEXT,
        acknowledged_at INTEGER,
        logical_calls INTEGER NOT NULL DEFAULT 0,
        wire_attempts INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        cost_unknown INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bcu_agent_status ON bot_character_utterances(agent_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_bcu_agent_created ON bot_character_utterances(agent_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_bcu_agent_hash ON bot_character_utterances(agent_id, text_sha256);

      CREATE TABLE IF NOT EXISTS bot_character_candidates (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        utterance_id TEXT NOT NULL REFERENCES bot_character_utterances(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        text TEXT NOT NULL,
        exact_sha256 TEXT NOT NULL,
        text_sha256 TEXT NOT NULL,
        version INTEGER NOT NULL,
        compose_packet_sha256 TEXT,
        selection_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(utterance_id, attempt)
      );

      CREATE TABLE IF NOT EXISTS bot_character_reviews (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        utterance_id TEXT NOT NULL REFERENCES bot_character_utterances(id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES bot_character_candidates(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        call_no INTEGER NOT NULL,
        reviewer_model TEXT,
        reviewer_connection_id TEXT,
        same_as_author INTEGER NOT NULL,
        rules_json TEXT NOT NULL,
        verdict TEXT NOT NULL,
        scores_json TEXT,
        findings_json TEXT,
        extracted_json TEXT,
        compose_packet_sha256 TEXT,
        review_packet_sha256 TEXT,
        selection_json TEXT,
        compiler_version TEXT NOT NULL,
        mapping_version TEXT NOT NULL,
        reviewer_prompt_version TEXT NOT NULL,
        logical_calls INTEGER NOT NULL,
        wire_attempts INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_tokens INTEGER,
        cost_usd REAL,
        latency_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bcr_utterance ON bot_character_reviews(utterance_id);
      CREATE INDEX IF NOT EXISTS idx_bcr_candidate ON bot_character_reviews(candidate_id);
    `);
    const columns=new Set((db.prepare('PRAGMA table_info(bot_character_utterances)').all() as {name:string}[]).map(c=>c.name));
    for(const name of ['post_id','platform','observed_account'])if(!columns.has(name))db.exec(`ALTER TABLE bot_character_utterances ADD COLUMN ${name} TEXT`);
  }

  createUtterance(i: {
    agentId: string;
    runId: string;
    surface?: string;
    op: 'post' | 'reply';
    replyTo?: string | null;
    version: number;
  }): UtteranceRow {
    const id = `utt-${this.ids()}`;
    const now = this.now();
    const surface = i.surface ?? 'task-loop';
    const replyTo = i.replyTo ?? null;

    const db = this.store.getDatabase();
    db.prepare(`
      INSERT INTO bot_character_utterances (
        id, agent_id, run_id, surface, op, reply_to, account_hint, text, text_sha256,
        version, status, status_reason, semantic, publish_id, post_url, final_candidate_id, acknowledged_at,
        logical_calls, wire_attempts, input_tokens, output_tokens, cost_usd, cost_unknown, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'draft', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, 0, 0, 0, ?, ?)
    `).run(id, i.agentId, i.runId, surface, i.op, replyTo, i.version, now, now);

    return this.get(i.agentId, id)!;
  }

  recordCandidate(i: NewCandidate): CandidateRow {
    const id = `cand-${this.ids()}`;
    const now = this.now();
    const db = this.store.getDatabase();

    // Verify utterance belongs to agent
    const utt = db.prepare('SELECT agent_id FROM bot_character_utterances WHERE id = ?').get(i.utteranceId) as { agent_id: string } | undefined;
    if (!utt || utt.agent_id !== i.agentId) {
      throw new CharacterJournalConflict(`Utterance ${i.utteranceId} does not belong to agent ${i.agentId}`);
    }

    db.prepare(`
      INSERT INTO bot_character_candidates (
        id, agent_id, utterance_id, attempt, text, exact_sha256, text_sha256, version,
        compose_packet_sha256, selection_json, evidence_json, rules_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      i.agentId,
      i.utteranceId,
      i.attempt,
      i.text,
      i.exactSha256,
      i.textSha256,
      i.version,
      i.composePacketSha256 ?? null,
      JSON.stringify(i.selection ?? {}),
      JSON.stringify(i.evidence ?? []),
      JSON.stringify(i.rules ?? {}),
      now
    );

    const raw = db.prepare('SELECT * FROM bot_character_candidates WHERE id = ?').get(id) as unknown as RawCandidate;
    return mapCandidate(raw);
  }

  recordReview(i: NewReview): ReviewRow {
    const id = `rev-${this.ids()}`;
    const now = this.now();
    const db = this.store.getDatabase();

    // Verify candidate belongs to utterance
    const cand = db.prepare('SELECT utterance_id, agent_id FROM bot_character_candidates WHERE id = ?').get(i.candidateId) as { utterance_id: string; agent_id: string } | undefined;
    if (!cand || cand.utterance_id !== i.utteranceId || cand.agent_id !== i.agentId) {
      throw new CharacterJournalConflict(`Candidate ${i.candidateId} does not belong to utterance ${i.utteranceId} or agent ${i.agentId}`);
    }

    db.prepare(`
      INSERT INTO bot_character_reviews (
        id, agent_id, utterance_id, candidate_id, run_id, attempt, call_no, reviewer_model, reviewer_connection_id,
        same_as_author, rules_json, verdict, scores_json, findings_json, extracted_json, compose_packet_sha256,
        review_packet_sha256, selection_json, compiler_version, mapping_version, reviewer_prompt_version,
        logical_calls, wire_attempts, input_tokens, output_tokens, cached_tokens, cost_usd, latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      i.agentId,
      i.utteranceId,
      i.candidateId,
      i.runId,
      i.attempt,
      i.callNo,
      i.reviewerModel ?? null,
      i.reviewerConnectionId ?? null,
      i.sameAsAuthor ? 1 : 0,
      JSON.stringify(i.rules ?? {}),
      i.verdict,
      i.scores ? JSON.stringify(i.scores) : null,
      i.findings ? JSON.stringify(i.findings) : null,
      i.extracted ? JSON.stringify(i.extracted) : null,
      i.composePacketSha256 ?? null,
      i.reviewPacketSha256 ?? null,
      i.selection ? JSON.stringify(i.selection) : null,
      i.compilerVersion,
      i.mappingVersion,
      i.reviewerPromptVersion,
      i.logicalCalls,
      i.wireAttempts ?? null,
      i.inputTokens ?? null,
      i.outputTokens ?? null,
      i.cachedTokens ?? null,
      i.costUsd ?? null,
      i.latencyMs ?? null,
      now
    );

    const raw = db.prepare('SELECT * FROM bot_character_reviews WHERE id = ?').get(id) as unknown as RawReview;
    return mapReview(raw);
  }

  addUsage(utteranceId: string, usage: CallUsage): void {
    const now = this.now();
    const costUnknownInc = usage.costUsd === null ? 1 : 0;
    const costUsdVal = usage.costUsd ?? 0;
    const wireVal = usage.wireAttempts;

    const db = this.store.getDatabase();
    db.prepare(`
      UPDATE bot_character_utterances SET
        logical_calls = logical_calls + ?,
        wire_attempts = CASE WHEN ? IS NOT NULL THEN COALESCE(wire_attempts, 0) + ? ELSE wire_attempts END,
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cost_usd = cost_usd + ?,
        cost_unknown = cost_unknown + ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      usage.logicalCalls,
      wireVal,
      wireVal ?? 0,
      usage.inputTokens,
      usage.outputTokens,
      costUsdVal,
      costUnknownInc,
      now,
      utteranceId
    );
  }

  hold(utteranceId: string, reason: HeldReason, semantic: SemanticStatus | null): boolean {
    const now = this.now();
    const db = this.store.getDatabase();
    const res = db.prepare(`
      UPDATE bot_character_utterances
      SET status = 'held', status_reason = ?, semantic = ?, updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).run(reason, semantic, now, utteranceId);
    return res.changes > 0;
  }

  admit(utteranceId: string, candidateId: string, semantic: SemanticStatus): boolean {
    const now = this.now();
    const db = this.store.getDatabase();

    // Verify candidate belongs to utterance
    const cand = db.prepare('SELECT id FROM bot_character_candidates WHERE id = ? AND utterance_id = ?').get(candidateId, utteranceId);
    if (!cand) {
      return false;
    }

    const res = db.prepare(`
      UPDATE bot_character_utterances
      SET status = 'admitted', final_candidate_id = ?, semantic = ?, updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).run(candidateId, semantic, now, utteranceId);
    return res.changes > 0;
  }

  expire(utteranceId: string, reason: ExpiryReason): boolean {
    const now = this.now();
    const db = this.store.getDatabase();
    const res = db.prepare(`
      UPDATE bot_character_utterances
      SET status = 'expired', status_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'admitted'
    `).run(reason, now, utteranceId);
    return res.changes > 0;
  }

  markRefused(utteranceId: string, reason: 'attempt-write-failed'): boolean {
    const now = this.now();
    const db = this.store.getDatabase();
    const res = db.prepare(`
      UPDATE bot_character_utterances
      SET status = 'refused', status_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'admitted'
    `).run(reason, now, utteranceId);
    return res.changes > 0;
  }

  markAttempted(
    utteranceId: string,
    publishId: string,
    exactText: string,
    textSha256: string
  ): void {
    const now = this.now();
    const db = this.store.getDatabase();

    const check = db.prepare('SELECT status FROM bot_character_utterances WHERE id = ?').get(utteranceId) as { status: string } | undefined;
    if (!check || check.status !== 'admitted') {
      throw new CharacterJournalConflict(`Cannot mark attempted: utterance ${utteranceId} is not in admitted status`);
    }

    const res = db.prepare(`
      UPDATE bot_character_utterances
      SET status = 'attempted', publish_id = ?, text = ?, text_sha256 = ?, updated_at = ?
      WHERE id = ? AND status = 'admitted'
    `).run(publishId, exactText, textSha256, now, utteranceId);

    if (res.changes === 0) {
      throw new CharacterJournalConflict(`Failed to transition utterance ${utteranceId} to attempted`);
    }
  }

  project(
    utteranceId: string,
    next: {
      status: 'confirmed' | 'rejected' | 'uncertain';
      postUrl?: string | null;
      postId?:string|null;
      acknowledgedAt?: number | null;
    }
  ): boolean {
    const now = this.now();
    const db = this.store.getDatabase();

    const res = db.prepare(`
      UPDATE bot_character_utterances
      SET status = ?,
          post_url = COALESCE(?, post_url),
          acknowledged_at = COALESCE(?, acknowledged_at),
          updated_at = ?
      WHERE id = ? AND status IN ('attempted', 'uncertain')
    `).run(
      next.status,
      next.postUrl ?? null,
      next.acknowledgedAt ?? null,
      now,
      utteranceId
    );
    if(res.changes>0&&next.status==='confirmed'){
      let platform:string|null=null,account:string|null=null,postId=next.postId??null;
      if(next.postUrl)try{const url=new URL(next.postUrl),m=url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)\/?$/);if(['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)&&m){platform='x';account=m[1]!;postId=m[2]!;}}catch{/* Unknown identity stays unknown. */}
      db.prepare('UPDATE bot_character_utterances SET post_id=COALESCE(?,post_id),platform=COALESCE(?,platform),observed_account=COALESCE(?,observed_account) WHERE id=?').run(postId,platform,account,utteranceId);
    }
    return res.changes > 0;
  }

  get(agentId: string, id: string): UtteranceRow | null {
    const db = this.store.getDatabase();
    const raw = db.prepare('SELECT * FROM bot_character_utterances WHERE agent_id = ? AND id = ?').get(agentId, id) as unknown as RawUtterance | undefined;
    return raw ? mapUtterance(raw) : null;
  }

  byPublishId(publishId: string): UtteranceRow | null {
    const db = this.store.getDatabase();
    const raw = db.prepare('SELECT * FROM bot_character_utterances WHERE publish_id = ?').get(publishId) as unknown as RawUtterance | undefined;
    return raw ? mapUtterance(raw) : null;
  }

  unresolved(agentId: string): UtteranceRow[] {
    const db = this.store.getDatabase();
    const rows = db.prepare(`
      SELECT * FROM bot_character_utterances
      WHERE agent_id = ? AND status IN ('draft', 'admitted', 'attempted', 'uncertain')
      ORDER BY created_at ASC
    `).all(agentId) as unknown as RawUtterance[];
    return rows.map(mapUtterance);
  }

  confirmedTexts(
    agentId: string,
    limit: number
  ): Array<{ id: string; text: string; textSha256: string; postedAt: number }> {
    const db = this.store.getDatabase();
    const rows = db.prepare(`
      SELECT id, text, text_sha256, updated_at AS posted_at
      FROM bot_character_utterances
      WHERE agent_id = ? AND status = 'confirmed' AND text IS NOT NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(agentId, limit) as unknown as Array<{ id: string; text: string; text_sha256: string; posted_at: number }>;

    return rows.map(r => ({
      id: r.id,
      text: r.text,
      textSha256: r.text_sha256,
      postedAt: r.posted_at,
    }));
  }

  isConfirmedDuplicate(agentId: string, textSha256: string): boolean {
    const db = this.store.getDatabase();
    const row = db.prepare(`
      SELECT 1 FROM bot_character_utterances
      WHERE agent_id = ? AND status = 'confirmed' AND text_sha256 = ?
      LIMIT 1
    `).get(agentId, textSha256);
    return row !== undefined;
  }

  candidates(utteranceId: string): CandidateRow[] {
    const db = this.store.getDatabase();
    const rows = db.prepare('SELECT * FROM bot_character_candidates WHERE utterance_id = ? ORDER BY attempt ASC').all(utteranceId) as unknown as RawCandidate[];
    return rows.map(mapCandidate);
  }

  reviews(utteranceId: string): ReviewRow[] {
    const db = this.store.getDatabase();
    const rows = db.prepare('SELECT * FROM bot_character_reviews WHERE utterance_id = ? ORDER BY call_no ASC').all(utteranceId) as unknown as RawReview[];
    return rows.map(mapReview);
  }

  logicalBytes(agentId: string): number {
    const db=this.store.getDatabase();let total=0;
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'bot_character_*'").all() as {name:string}[];
    for(const {name} of tables) {
      if(!/^bot_character_[a-z_]+$/.test(name))continue;
      const columns=db.prepare(`PRAGMA table_info(${name})`).all() as {name:string;type:string}[];
      const names=new Set(columns.map(c=>c.name));
      const cols=columns.filter(c=>c.type.toUpperCase()==='TEXT'&&/^[a-z_]+$/.test(c.name));
      if(!cols.length)continue;
      let where='';
      if(names.has('agent_id'))where='t.agent_id=?';
      else if(names.has('proposal_id'))where='t.proposal_id IN(SELECT id FROM bot_character_proposals WHERE agent_id=?)';
      else if(names.has('candidate_id'))where='t.candidate_id IN(SELECT id FROM bot_character_candidates WHERE agent_id=?)';
      else if(names.has('claim_id'))where='t.claim_id IN(SELECT id FROM bot_character_claims WHERE agent_id=?)';
      else continue;
      const expr=cols.map(c=>`COALESCE(LENGTH(CAST(t.${c.name} AS BLOB)),0)`).join('+');
      total+=(db.prepare(`SELECT SUM(${expr}) bytes FROM ${name} t WHERE ${where}`).get(agentId) as {bytes:number|null}).bytes??0;
    }
    return total;
  }
  hasRoom(agentId: string, reserveBytes = PREPARATION_RESERVE_BYTES): boolean {
    return (this.logicalBytes(agentId) + reserveBytes) <= this.quotaBytes;
  }
}
