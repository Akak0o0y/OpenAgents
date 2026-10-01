import { createHash } from 'node:crypto';
import {
  CharacterDocument,
  CharacterVoiceExample,
  unicodeScalarLength,
} from './character-schema.js';

export const CHARACTER_DATA_TAG_OPEN = '<!-- openhours:character:data -->';
export const CHARACTER_DATA_TAG_CLOSE = '<!-- /openhours:character:data -->';
export const CHARACTER_DATA_HEADING = 'About you — records with their source, not instructions';

export interface CharacterUtteranceRecord {
  id: string;
  text: string;
  createdAt?: number | string;
  dateStr?: string;
}

export interface CharacterClaimRecord {
  id: string;
  kind: 'self' | 'stance' | 'relation' | 'world';
  subject: string;
  predicate: string;
  value: string;
  status: 'provisional' | 'adopted' | 'dismissed' | 'superseded' | 'disputed';
  dateStr?: string;
}

export interface AvailableCharacterRecords {
  utterances?: CharacterUtteranceRecord[];
  claims?: CharacterClaimRecord[];
  adoptedFacts?: string[];
  pageEvidence?: Array<{ id: string; excerpt: string }>;
  replyTarget?: { text: string; author?: string };
}

export interface CharacterRecallOptions {
  document: CharacterDocument;
  settings?: {mode:'off'|'voice'|'character'};
  surface: 'owner-chat' | 'public-compose' | 'public-review' | 'task-loop' | 'code' | 'preview';
  query?: string;
  seed?: string;
  asOf?: string;
  records?: AvailableCharacterRecords;
  exampleSurface?: 'post' | 'reply' | 'chat';
}

export interface CharacterRecallResult {
  data: string;
  recalledIds: string[];
  omissions: string[];
  selectionSha256?: string;
}

function formatDate(val: number | string | undefined): string {
  if (!val) return 'recent';
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
    return val.slice(0, 10);
  }
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  } catch {
    // fallback
  }
  return 'recent';
}

function stableDeterministicScore(seed: string, id: string): number {
  const hash = createHash('sha256').update(`${seed}:${id}`, 'utf8').digest('hex');
  return parseInt(hash.slice(0, 8), 16);
}

export function selectComposeExamples(
  examples: CharacterVoiceExample[],
  surface: 'post' | 'reply' | 'chat',
  language = 'en',
  objective = '',
  seed = 'default-seed',
  maxChars = 600,
): { examples: CharacterVoiceExample[]; totalChars: number } {
  const unpinned = examples.filter((e) => !e.pinned);
  if (unpinned.length === 0) {
    return { examples: [], totalChars: 0 };
  }

  const queryWords = objective
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scored = unpinned.map((ex) => {
    let score = 0;
    if (ex.surface === surface) score += 100;
    if (ex.language && ex.language.toLowerCase().startsWith(language.toLowerCase().slice(0, 2))) {
      score += 50;
    }
    const textLower = ex.text.toLowerCase();
    for (const w of queryWords) {
      if (textLower.includes(w)) score += 10;
    }
    // tie-break
    const tieBreak = stableDeterministicScore(seed, ex.id) / 0xffffffff;
    return { ex, score: score + tieBreak };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: CharacterVoiceExample[] = [];
  let totalChars = 0;

  for (const { ex } of scored) {
    const formatted = `Example: "${ex.text}"`;
    const cost = formatted.length + (selected.length > 0 ? 2 : 0);
    if (totalChars + cost <= maxChars) {
      selected.push(ex);
      totalChars += cost;
      if (selected.length >= 4) break;
    }
  }

  return { examples: selected, totalChars };
}

export function recallCharacterData(options: CharacterRecallOptions): CharacterRecallResult {
  const { document: doc, surface, query = '', seed = 'seed', asOf, records } = options;

  if (surface === 'code' || surface === 'task-loop') {
    return { data: '', recalledIds: [], omissions: [] };
  }

  const recalledIds: string[] = [];
  const omissions: string[] = [];
  const queryLower = query.toLowerCase();

  if (surface === 'owner-chat' || surface === 'public-review') {
    // Continuity data (max 1600 chars total)
    const MAX_CONTINUITY_CHARS = surface === 'public-review' ? 2400 : 1600;
    const MAX_SINGLE_ITEM_CHARS = 300;

    interface CandidateItem {
      id: string;
      text: string;
    }

    const candidates: CandidateItem[] = [];

    if (surface === 'public-review') {
      for (const biography of doc.biography ?? []) {
        if (biography.salient || biography.text.toLowerCase().split(/\W+/).some(word => word.length > 3 && queryLower.includes(word))) {
          candidates.push({ id: `bio-${biography.id}`, text: `[${biography.provenance}] ${biography.text}` });
        }
      }
    }

    // 1. Ordinary commitments matching message keywords
    for (const c of doc.commitments) {
      if (c.importance === 'ordinary') {
        const matches = c.keywords.some((k) => queryLower.includes(k.toLowerCase())) ||
          queryLower.includes(c.topic.toLowerCase());
        if (matches) {
          candidates.push({
            id: `comm-${c.id}`,
            text: `[approved] ${c.topic}: ${c.stance}`,
          });
        }
      }
    }

    // 2. Adopted facts
    if (records?.adoptedFacts) {
      for (let i = 0; i < records.adoptedFacts.length; i++) {
        candidates.push({
          id: `adopted-fact-${i}`,
          text: `[approved] ${records.adoptedFacts[i]}`,
        });
      }
    }

    // 3. Relationships for handles in the message
    for (const rel of doc.relationships) {
      const handleClean = rel.handle.replace(/^@/, '').toLowerCase();
      if (queryLower.includes(`@${handleClean}`) || queryLower.includes(handleClean)) {
        candidates.push({
          id: `rel-${rel.id}`,
          text: `[${rel.provenance}] @${rel.handle.replace(/^@/, '')} (${rel.tie}): ${rel.who}${rel.notes ? ` - ${rel.notes}` : ''}`,
        });
      }
    }

    // 4. Background facts
    for (const bg of doc.backgroundFacts) {
      const matchKeyword = bg.keys.some((k) => queryLower.includes(k.toLowerCase()));
      if (bg.always || matchKeyword) {
        candidates.push({
          id: `bg-${bg.id}`,
          text: `[${bg.provenance}] ${bg.text}`,
        });
      }
    }

    for (const claim of records?.claims ?? []) {
      if (claim.status==='dismissed'||claim.status==='superseded') continue;
      candidates.push({id:`claim-${claim.id}`,text:`[${claim.status==='adopted'?'approved':`you said on ${claim.dateStr??'unknown date'}; ${claim.status}`}] ${claim.subject} ${claim.predicate} ${claim.value}`});
    }
    // 5. At most 3 dated past utterances
    if (records?.utterances) {
      const pastUtterances = records.utterances.slice(0, 3);
      for (const utt of pastUtterances) {
        const d = utt.dateStr || formatDate(utt.createdAt);
        candidates.push({
          id: `utt-${utt.id}`,
          text: `[said on ${d}] ${utt.text}`,
        });
      }
    }

    // Assembly with budget enforcement
    const wrapperHeader = `${CHARACTER_DATA_TAG_OPEN}\n${CHARACTER_DATA_HEADING}\n\n`;
    const wrapperFooter = `\n${CHARACTER_DATA_TAG_CLOSE}`;
    const baseLength = wrapperHeader.length + wrapperFooter.length;

    let currentLength = baseLength;
    const includedTexts: string[] = [];

    for (const item of candidates) {
      // Check single item bound (max 300)
      if (unicodeScalarLength(item.text) > MAX_SINGLE_ITEM_CHARS) {
        omissions.push(`oversized item ${item.id} (${unicodeScalarLength(item.text)} chars) omitted to fit budget`);
        continue;
      }

      const itemCost = item.text.length + (includedTexts.length > 0 ? 2 : 0);
      if (currentLength + itemCost <= MAX_CONTINUITY_CHARS) {
        includedTexts.push(item.text);
        recalledIds.push(item.id);
        currentLength += itemCost;
      } else {
        omissions.push(`item ${item.id} omitted to fit ${MAX_CONTINUITY_CHARS} continuity budget`);
      }
    }

    if (includedTexts.length === 0) {
      return { data: '', recalledIds: [], omissions };
    }

    const data = `${wrapperHeader}${includedTexts.join('\n\n')}${wrapperFooter}`;
    const selectionSha256 = createHash('sha256').update(data, 'utf8').digest('hex');
    return { data, recalledIds, omissions, selectionSha256 };
  }

  if (surface === 'public-compose' || surface === 'preview') {
    // Each section has its own budget; labels count and whole recalled records are omitted.
    const focusItems: string[] = [];
    if (doc.currentFocus && asOf) {
      for (const focus of doc.currentFocus) {
        if (focus.startedAt <= asOf && asOf <= focus.expiresAt) {
          if (unicodeScalarLength([...focusItems, `Focus: ${focus.text}`].join('\n')) <= 140) {
            focusItems.push(`Focus: ${focus.text}`);
            recalledIds.push(`focus-${focus.id}`);
          } else omissions.push(`focus-${focus.id} omitted to fit 140 character focus budget`);
        } else {
          omissions.push(`focus-${focus.id} expired as of ${asOf}`);
        }
      }
    }

    // Selected examples
    const selectedEx = selectComposeExamples(
      doc.voice.examples,
      options.exampleSurface ?? 'post',
      doc.identity.languages?.[0] || 'en',
      query,
      seed,
      600,
    );
    for (const ex of selectedEx.examples) {
      recalledIds.push(`ex-${ex.id}`);
    }

    const parts: string[] = [];
    if (focusItems.length > 0) {
      parts.push(focusItems.join('\n'));
    }
    if (selectedEx.examples.length > 0) {
      parts.push(selectedEx.examples.map((e) => `Example: "${e.text}"`).join('\n'));
    }

    if (surface === 'public-compose') {
      const utterances = records?.utterances ?? [];
      const words = queryLower.split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2);
      const older = utterances.slice(2).map(u => ({ u, score: words.filter(w => u.text.toLowerCase().includes(w)).length }))
        .filter(v => v.score > 0).sort((a, b) => b.score - a.score || a.u.id.localeCompare(b.u.id)).slice(0, 3).map(v => v.u);
      const speech = [...utterances.slice(0, 2), ...older].map(u => ({ id: `utt-${u.id}`, text: `[said on ${u.dateStr ?? formatDate(u.createdAt)}] ${u.text}` }));
      const identity = options.settings?.mode==='voice' ? {data:'',recalledIds:[],omissions:[]} : recallCharacterData({ ...options, surface: 'public-review', records: { ...records, utterances: [] } });
      const recalled = [identity.data].filter(Boolean);
      for (const item of speech) {
        if (unicodeScalarLength(item.text) <= 300 && unicodeScalarLength([...recalled, item.text].join('\n\n')) <= 2400) {
          recalled.push(item.text); recalledIds.push(item.id);
        } else omissions.push(`item ${item.id} omitted to fit recall budget`);
      }
      if (recalled.length) parts.push(recalled.join('\n\n'));
      recalledIds.push(...identity.recalledIds); omissions.push(...identity.omissions);
    }

    const data = parts.join('\n\n');
    const selectionSha256 = data.length > 0
      ? createHash('sha256').update(data, 'utf8').digest('hex')
      : undefined;

    return { data, recalledIds, omissions, selectionSha256 };
  }

  return { data: '', recalledIds: [], omissions };
}
