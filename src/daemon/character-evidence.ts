/**
 * Pure typed evidence resolution, reply target binding, line-budgeted excerpting
 * and owner dictation checks for the character layer (Phase 2 Task 3, spec §23.1 P2-C1/P2-C2).
 */
import type { EvidenceSource } from './deliverable-checks.js';
import { statusIdOf } from './publish-probes.js';

export type EvidenceOrigin = 'page' | 'owner' | 'memory' | 'mission' | 'verified-result';
export type EvidenceTrust = 'unverified' | 'owner' | 'verified';

export interface TypedEvidence {
  sourceId: string;
  origin: EvidenceOrigin;
  url?: string;
  postId?: string;
  text: string;
  capturedAt: string;
  runId: string;
  trust: EvidenceTrust;
}

export interface RunEvidenceContext {
  runId: string;
  kind: 'routine' | 'owner-chat' | 'mission';
  sources: readonly EvidenceSource[];
  captures: ReadonlyMap<string, { url: string; capturedAt: string }>;
  restoredIds: ReadonlySet<string>;
  requestId: string;
  objectiveId?: string;
  sourceLimit: number;
}

export type EvidenceResult =
  | { ok: true; target: (TypedEvidence & { postId: string }) | null; items: TypedEvidence[] }
  | { ok: false; held: 'target-unbound' | 'evidence-unavailable' | 'evidence-missing'; missing: string[] };

export const EXACT_NOT_OWNER = "exact text must be the owner's own words";

function classifyOriginPrefix(src: EvidenceSource): EvidenceOrigin {
  const lower = (src.origin || '').toLowerCase();
  if (
    lower.startsWith('page') ||
    lower.startsWith('browser') ||
    lower.startsWith('web') ||
    lower.startsWith('mcp')
  ) {
    return 'page';
  }
  if (lower.startsWith('memory')) {
    return 'memory';
  }
  if (lower.startsWith('mission')) {
    return 'mission';
  }
  if (lower.startsWith('owner') || lower.startsWith('user')) {
    return 'owner';
  }
  return 'page';
}

function toTypedEvidence(src: EvidenceSource, ctx: RunEvidenceContext): TypedEvidence {
  const capture = ctx.captures.get(src.id);
  const url = capture?.url;
  const capturedAt = capture?.capturedAt ?? src.capturedAt;
  let postId: string | undefined;
  if (url) {
    try {
      const pid = statusIdOf(new URL(url, 'http://localhost').pathname);
      if (pid) postId = pid;
    } catch {}
  }

  let origin: EvidenceOrigin;
  let trust: EvidenceTrust;

  if (src.id === ctx.requestId) {
    if (ctx.kind === 'mission') {
      origin = 'mission';
      trust = 'unverified';
    } else {
      origin = 'owner';
      trust = 'owner';
    }
  } else if (ctx.objectiveId && src.id === ctx.objectiveId) {
    origin = 'owner';
    trust = 'owner';
  } else if (ctx.restoredIds.has(src.id)) {
    trust = 'unverified';
    origin = classifyOriginPrefix(src);
  } else if (src.id.startsWith('memory-') || src.origin.toLowerCase().startsWith('memory')) {
    origin = 'memory';
    trust = 'unverified';
  } else if (
    src.origin.toLowerCase().startsWith('browser') ||
    src.origin.toLowerCase().startsWith('web') ||
    src.origin.toLowerCase().startsWith('mcp') ||
    src.origin.toLowerCase().startsWith('page')
  ) {
    origin = 'page';
    trust = 'unverified';
  } else {
    origin = classifyOriginPrefix(src);
    trust = 'unverified';
  }

  return {
    sourceId: src.id,
    origin,
    url,
    postId,
    text: src.text,
    capturedAt,
    runId: ctx.runId,
    trust,
  };
}

export function resolveEvidence(
  ctx: RunEvidenceContext,
  input: {
    op: 'post' | 'reply';
    replyTo?: { url: string; sourceId: string };
    evidence?: readonly string[];
  }
): EvidenceResult {
  const sourceMap = new Map<string, EvidenceSource>();
  for (const src of ctx.sources) {
    sourceMap.set(src.id, src);
  }

  // Check requested evidence ids
  const requestedEvidenceIds = input.evidence ?? [];
  const missingEvidenceIds = requestedEvidenceIds.filter(id => !sourceMap.has(id));

  if (missingEvidenceIds.length > 0) {
    if (ctx.sources.length >= ctx.sourceLimit) {
      return { ok: false, held: 'evidence-unavailable', missing: missingEvidenceIds };
    }
    return { ok: false, held: 'evidence-missing', missing: missingEvidenceIds };
  }

  // Handle reply target if op === 'reply'
  let target: (TypedEvidence & { postId: string }) | null = null;
  if (input.op === 'reply') {
    if (!input.replyTo) {
      return { ok: false, held: 'target-unbound', missing: [] };
    }
    const { sourceId, url } = input.replyTo;
    // Restored sources and unknown ids never bind a reply target (D12, P2-C2)
    if (ctx.restoredIds.has(sourceId)) {
      return { ok: false, held: 'target-unbound', missing: [] };
    }
    const src = sourceMap.get(sourceId);
    if (!src) {
      return { ok: false, held: 'target-unbound', missing: [] };
    }
    const capture = ctx.captures.get(sourceId);
    if (!capture) {
      return { ok: false, held: 'target-unbound', missing: [] };
    }

    let capturePathname: string;
    try {
      capturePathname = new URL(capture.url, 'http://localhost').pathname;
    } catch {
      return { ok: false, held: 'target-unbound', missing: [] };
    }
    const capturePostId = statusIdOf(capturePathname);
    if (!capturePostId) {
      return { ok: false, held: 'target-unbound', missing: [] };
    }

    if (url) {
      let replyPathname: string;
      try {
        replyPathname = new URL(url, 'http://localhost').pathname;
      } catch {
        return { ok: false, held: 'target-unbound', missing: [] };
      }
      const replyPostId = statusIdOf(replyPathname);
      if (!replyPostId || replyPostId !== capturePostId) {
        return { ok: false, held: 'target-unbound', missing: [] };
      }
    }

    const typedTarget = toTypedEvidence(src, ctx);
    target = {
      ...typedTarget,
      postId: capturePostId,
      url: capture.url,
    };
  }

  const items: TypedEvidence[] = [];
  for (const id of requestedEvidenceIds) {
    const src = sourceMap.get(id)!;
    items.push(toTypedEvidence(src, ctx));
  }

  return { ok: true, target, items };
}

function truncateGraphemes(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let result = '';
    for (const segment of segmenter.segment(text)) {
      if (result.length + segment.segment.length > maxLen) {
        break;
      }
      result += segment.segment;
    }
    return result;
  }
  let result = '';
  for (const char of text) {
    if (result.length + char.length > maxLen) break;
    result += char;
  }
  return result;
}

function truncateAtLineBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 1) return '…'.slice(0, budget);

  const lines = text.split('\n');
  const kept: string[] = [];
  let currentLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const addedLen = kept.length === 0 ? line.length : 1 + line.length;
    if (currentLen + addedLen + 1 <= budget) {
      kept.push(line);
      currentLen += addedLen;
    } else {
      break;
    }
  }

  if (kept.length > 0) {
    return kept.join('\n') + '…';
  }

  return truncateGraphemes(lines[0], budget - 1) + '…';
}

function extractFirstArticle(text: string): string {
  const lines = text.split('\n');
  let articleStartIndex = -1;
  let articleIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)-\s+article\b/);
    if (match) {
      articleStartIndex = i;
      articleIndent = match[1].length;
      break;
    }
  }

  if (articleStartIndex === -1) {
    return text;
  }

  const collected: string[] = [lines[articleStartIndex]];
  for (let i = articleStartIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      collected.push(line);
      continue;
    }
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    if (indent <= articleIndent) {
      break;
    }
    collected.push(line);
  }

  return collected.join('\n');
}

export function targetExcerpt(text: string, max: number = 1000): string {
  const article = extractFirstArticle(text);
  return truncateAtLineBoundary(article, max);
}

export function briefEvidence(
  items: readonly TypedEvidence[],
  budget: number = 600
): Array<{ id: string; trust: EvidenceTrust; origin: EvidenceOrigin; excerpt: string }> {
  if (items.length === 0) return [];

  let remaining = budget;
  const result: Array<{ id: string; trust: EvidenceTrust; origin: EvidenceOrigin; excerpt: string }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemsLeft = items.length - i;
    const itemBudget = Math.max(1, Math.floor(remaining / itemsLeft));
    const excerpt = truncateAtLineBoundary(item.text, itemBudget);
    remaining = Math.max(0, remaining - excerpt.length);
    result.push({
      id: item.sourceId,
      trust: item.trust,
      origin: item.origin,
      excerpt,
    });
  }

  return result;
}

export function evidenceSnapshot(
  target: TypedEvidence | null,
  items: readonly TypedEvidence[]
): TypedEvidence[] {
  const result: TypedEvidence[] = [];
  let remainingBudget = 2400;

  if (target) {
    const excerpt = targetExcerpt(target.text, 1000);
    remainingBudget = Math.max(0, remainingBudget - excerpt.length);
    result.push({
      ...target,
      text: excerpt,
    });
  }

  const nonTargetItems = target
    ? items.filter(it => it.sourceId !== target.sourceId)
    : items;

  for (let i = 0; i < nonTargetItems.length; i++) {
    const item = nonTargetItems[i];
    const itemsLeft = nonTargetItems.length - i;
    const itemBudget = Math.max(1, Math.floor(remainingBudget / itemsLeft));
    const excerpt = truncateAtLineBoundary(item.text, itemBudget);
    remainingBudget = Math.max(0, remainingBudget - excerpt.length);
    result.push({
      ...item,
      text: excerpt,
    });
  }

  return result;
}

export function ownerDictation(
  exact: string,
  owner: { request: string; history: ReadonlyArray<{ role: string; content: string }> }
): boolean {
  const cleanExact = exact.normalize('NFC').replace(/\r\n/g, '\n').trim();
  if (cleanExact.length === 0) return false;

  const cleanRequest = owner.request.normalize('NFC').replace(/\r\n/g, '\n');
  if (cleanRequest.includes(cleanExact)) {
    return true;
  }

  for (const msg of owner.history) {
    if (msg.role !== 'user') continue;
    const cleanContent = msg.content.normalize('NFC').replace(/\r\n/g, '\n');
    if (cleanContent.includes(cleanExact)) {
      return true;
    }
  }

  return false;
}
