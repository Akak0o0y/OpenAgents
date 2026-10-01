import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentStore } from './agent-store.js';
import type { CharacterStore } from './character-store.js';
import { CharacterJournal, CHARACTER_QUOTA_BYTES, type UtteranceRow } from './character-journal.js';
import { CharacterInvalidError, CharacterNotFoundError } from './character-schema.js';

export class CharacterPosts {
  constructor(private store: AgentStore, private characters: CharacterStore, private journal: CharacterJournal) {}
  private agent(id: string) { if (!this.store.getAgent(id)) throw new CharacterNotFoundError('Bot not found.'); }
  item(u: UtteranceRow) {
    const c = this.journal.candidates(u.id).find(c => c.id === u.finalCandidateId);
    const review = this.journal.reviews(u.id).filter(r => r.candidateId === c?.id).at(-1);
    const scored = u.semantic === 'passed' && review?.verdict === 'pass';
    return { id: u.id, status: u.status, statusReason: u.statusReason, semantic: u.semantic, op: u.op, replyTo: u.replyTo,
      postUrl: u.postUrl, version: u.version, createdAt: u.createdAt, updatedAt: u.updatedAt,
      finalCandidate: c ? { id: c.id, text: c.text, similarity: (c.rules as { similarity?: number })?.similarity ?? null,
        scores: scored ? review.scores as { voice: number; fit: number; consistency: number } : null,
        reviewer: review ? { model: review.reviewerModel, connectionId: review.reviewerConnectionId, sameAsAuthor: review.sameAsAuthor } : null } : null,
      calls: { logical: u.logicalCalls, wire: u.wireAttempts }, tokens: { input: u.inputTokens, output: u.outputTokens, cached: 'unavailable' as const },
      cost: { knownUsd: u.costUsd, unknownCalls: u.costUnknown } };
  }
  list(agentId: string, limit: number, cursor?: string) {
    this.agent(agentId); z.number().int().min(1).max(50).parse(limit);
    let before: { agent: string; at: number; id: string } | undefined;
    if (cursor) {
      try {
        before = z.object({ agent: z.literal(agentId), at: z.number().int().nonnegative(), id: z.string().min(1).max(200) }).strict().parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
        if (Buffer.from(JSON.stringify(before)).toString('base64url') !== cursor) throw new Error();
      } catch { throw new CharacterInvalidError('Invalid posts cursor.'); }
    }
    const db = this.store.getDatabase();
    const rows = before ? db.prepare('SELECT id FROM bot_character_utterances WHERE agent_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?').all(agentId, before.at, before.at, before.id, limit + 1)
      : db.prepare('SELECT id FROM bot_character_utterances WHERE agent_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(agentId, limit + 1);
    const items = rows.slice(0, limit).map(row => this.item(this.journal.get(agentId, String(row.id))!));
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ agent: agentId, at: last.createdAt, id: last.id })).toString('base64url') : null };
  }
  detail(agentId: string, id: string) {
    this.agent(agentId); const u = this.journal.get(agentId, id); if (!u) throw new CharacterNotFoundError('Post not found for this bot.');
    const reviews = this.journal.reviews(id);
    const events = u.publishId ? this.store.getDatabase().prepare("SELECT event_type,timestamp,payload_json FROM execution_events WHERE agent_id=? AND task_run_id=? AND event_type IN ('PUBLISH_ATTEMPTED','PUBLISH_OBSERVED','PUBLISH_RECONCILED','EXTERNAL_ACTION_ACKNOWLEDGED') ORDER BY timestamp,rowid").all(agentId, u.runId).flatMap(row => {
      let p: Record<string, unknown>; try { p = JSON.parse(String(row.payload_json)); } catch { return []; }
      if (![p.id, p.publishId, p.key].includes(u.publishId)) return [];
      return [{ type: String(row.event_type), at: Number(row.timestamp), ...Object.fromEntries(['outcome', 'reason', 'verdict', 'postUrl'].filter(k => typeof p[k] === 'string').map(k => [k, p[k]])) }];
    }) : [];
    return { utterance: { ...this.item(u), acknowledgedAt: u.acknowledgedAt }, candidates: this.journal.candidates(id).map(c => ({ ...c,
      reviews: reviews.filter(r => r.candidateId === c.id).map(r => ({ id: r.id, attempt: r.attempt, callNo: r.callNo, verdict: r.verdict, scores: r.scores,
        findings: r.findings, reviewer: { model: r.reviewerModel, connectionId: r.reviewerConnectionId, sameAsAuthor: r.sameAsAuthor },
        usage: { logical: r.logicalCalls, wire: r.wireAttempts, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd }, createdAt: r.createdAt })) })),
      stage1: u.publishId ? { publishId: u.publishId, events } : null };
  }
  metrics(agentId: string, version: number) {
    this.agent(agentId); const db = this.store.getDatabase();
    const all = db.prepare(`SELECT count(*) AS total,
      sum(status='confirmed') AS confirmed, sum(status='held') AS held,
      sum(status IN ('draft','admitted','attempted')) AS pending,
      sum(status='confirmed' AND semantic='passed') AS passed,
      sum(status='confirmed' AND semantic IN ('unchecked-invalid','unchecked-unavailable','not-sampled')) AS unchecked,
      sum(status='confirmed' AND semantic='out-of-scope') AS outOfScope,
      sum(EXISTS(SELECT 1 FROM bot_character_candidates c WHERE c.utterance_id=u.id AND c.attempt=2)) AS revised,
      sum(cost_usd) AS knownCost, sum(cost_unknown) AS unknownCost
      FROM bot_character_utterances u WHERE agent_id=? AND version=?`).get(agentId, version)!;
    const stats = db.prepare(`SELECT count(*) AS n, avg(json_extract(r.scores_json,'$.voice')) AS voice,
      avg(json_extract(r.scores_json,'$.fit')) AS fit, avg(json_extract(r.scores_json,'$.consistency')) AS consistency
      FROM bot_character_utterances u JOIN bot_character_reviews r ON r.id=(SELECT rr.id FROM bot_character_reviews rr
        WHERE rr.candidate_id=u.final_candidate_id ORDER BY rr.call_no DESC,rr.id DESC LIMIT 1)
      WHERE u.agent_id=? AND u.version=? AND u.status='confirmed' AND u.semantic='passed' AND r.verdict='pass' AND r.scores_json IS NOT NULL`).get(agentId, version)!;
    const num = (key: string) => Number(all[key] ?? 0), total = num('total'), confirmed = num('confirmed');
    return { version, n: Number(stats.n), mean: Number(stats.n) ? { voice: Number(stats.voice), fit: Number(stats.fit), consistency: Number(stats.consistency) } : null,
      reviseRate: total ? num('revised') / total : null, holdRate: total ? num('held') / total : null,
      costPerConfirmed: { knownUsd: confirmed ? num('knownCost') / confirmed : null, unknownCalls: num('unknownCost') },
      coverage: { passed: num('passed'), unchecked: num('unchecked'), outOfScope: num('outOfScope'), held: num('held'), pending: num('pending'),
        other: total - num('passed') - num('unchecked') - num('outOfScope') - num('held') - num('pending') },
      cachedTokens: 'unavailable' as const, storage: { usedBytes: this.journal.logicalBytes(agentId), quotaBytes: CHARACTER_QUOTA_BYTES } };
  }
  promote(agentId: string, baseVersion: number, utteranceId: string) {
    this.agent(agentId); const u = this.journal.get(agentId, utteranceId); if (!u) throw new CharacterNotFoundError('Post not found for this bot.');
    const c = this.journal.candidates(u.id).find(c => c.id === u.finalCandidateId);
    if (!c || Array.from(c.text).length > 600) throw new CharacterInvalidError('A final candidate of at most 600 characters is required.');
    const active = this.characters.getLatestVersion(agentId); if (!active) throw new CharacterNotFoundError('Character not found.');
    const exampleId = randomUUID();
    const saved = this.characters.save(agentId, baseVersion, { document: { voice: { examples: [...active.document.voice.examples,
      { id: exampleId, text: c.text, surface: u.op, pinned: false, tags: [], origin: 'promoted', sourceId: 'draft:promotion' }] } },
      sources: [{ handle: 'draft:promotion', kind: 'sample', text: c.text }], note: 'Owner promoted a post example.' });
    return { version: saved.version, exampleId };
  }
}
export type CharacterPostItem = ReturnType<CharacterPosts['item']>;
export type CharacterPostDetail = ReturnType<CharacterPosts['detail']>;
export type CharacterPostMetrics = ReturnType<CharacterPosts['metrics']>;
