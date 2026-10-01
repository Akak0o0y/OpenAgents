import { normalizeEcho, weightedLength, textSha256 } from './publish-probes.js';
import type { CharacterDocument, CharacterSettings } from './character-schema.js';

export interface CharacterRuleFinding {
  code: string;
  severity: 'block' | 'warn' | 'info';
  message: string;
  span?: [number, number];
}

export interface CharacterRuleResult {
  hardPass: boolean;
  hardFindings: CharacterRuleFinding[];
  advisoryFindings: CharacterRuleFinding[];
  weightedLength: number;
  hash: string;
}

export interface CharacterRuleContext {
  surface?: 'public-compose' | 'owner-chat' | 'public-review' | 'task-loop';
  retainedConfirmedPosts?: string[];
}

const COMMON_AI_PHRASES = [
  'testament to',
  'delve',
  'tapestry',
  'beacon',
  'in a world where',
  'furthermore',
  'game changer',
  'revolutionize',
  'in summary',
  'it is important to remember',
];

const URL_REGEX = /https?:\/\/[^\s]+|www\.[^\s]+/iu;
const HASHTAG_REGEX = /(?:^|\s)#[A-Za-z0-9_\p{L}]+/gu;
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

export function characterTrigrams(text: string): Set<string> {
  const normalized = normalizeEcho(text).toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    trigrams.add(normalized.slice(i, i + 3));
  }
  return trigrams;
}

export function jaccardTrigramSimilarity(a: string, b: string): number {
  const normA = normalizeEcho(a).toLowerCase();
  const normB = normalizeEcho(b).toLowerCase();
  if (normA === normB) return 1;

  const setA = characterTrigrams(a);
  const setB = characterTrigrams(b);
  if (setA.size === 0 && setB.size === 0) return normA === normB ? 1 : 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function checkCharacterRules(
  text: string,
  doc: CharacterDocument,
  settings: CharacterSettings,
  context: CharacterRuleContext = {}
): CharacterRuleResult {
  const hardFindings: CharacterRuleFinding[] = [];
  const advisoryFindings: CharacterRuleFinding[] = [];

  const len = weightedLength(text);
  const hash = textSha256(text);
  const normalizedLower = normalizeEcho(text).toLowerCase();
  const isOwnerChat = context.surface === 'owner-chat';

  // Support schema postRules at doc.voice.postRules or top-level doc.postRules for test mocks
  const postRules: any = doc.voice?.postRules ?? (doc as any).postRules;

  // --- HARD RULES ---

  // 1. Length limit (public only)
  if (!isOwnerChat && postRules) {
    const maxLen = typeof postRules.length === 'number' ? postRules.length : postRules.length?.max;
    if (typeof maxLen === 'number' && maxLen > 0 && len > maxLen) {
      hardFindings.push({
        code: 'LENGTH_LIMIT',
        severity: 'block',
        message: `Post length (${len}) exceeds allowed limit (${maxLen}).`,
      });
    }
  }

  // 2. Hashtag limit (public only)
  if (!isOwnerChat && postRules) {
    const maxHashtags = typeof postRules.hashtags === 'number' ? postRules.hashtags : postRules.maxHashtags;
    if (typeof maxHashtags === 'number') {
      const hashtags = text.match(HASHTAG_REGEX) ?? [];
      if (hashtags.length > maxHashtags) {
        hardFindings.push({
          code: 'HASHTAG_LIMIT',
          severity: 'block',
          message: `Hashtag count (${hashtags.length}) exceeds maximum (${maxHashtags}).`,
        });
      }
    }
  }

  // 3. Links (public only)
  if (!isOwnerChat && postRules?.links) {
    const hasLink = URL_REGEX.test(text);
    if (postRules.links === 'never' && hasLink) {
      hardFindings.push({
        code: 'LINK_FORBIDDEN',
        severity: 'block',
        message: 'Links are forbidden in post rules.',
      });
    } else if (postRules.links === 'always' && !hasLink) {
      hardFindings.push({
        code: 'LINK_REQUIRED',
        severity: 'block',
        message: 'A link is required by post rules.',
      });
    }
  }

  // 4. Avoid phrases
  if (doc.voice?.avoidPhrases && doc.voice.avoidPhrases.length > 0) {
    for (const phrase of doc.voice.avoidPhrases) {
      const trimmed = phrase.trim().toLowerCase();
      if (trimmed.length > 0 && normalizedLower.includes(trimmed)) {
        hardFindings.push({
          code: 'AVOID_PHRASE',
          severity: 'block',
          message: `Text contains avoided phrase: "${phrase}".`,
        });
      }
    }
  }

  // 5. Duplicates against retained confirmed posts
  const retained = context.retainedConfirmedPosts ?? [];
  if (retained.length > 0) {
    let exactFound = false;
    for (const past of retained) {
      if (textSha256(past) === hash || normalizeEcho(past).toLowerCase() === normalizedLower) {
        hardFindings.push({
          code: 'EXACT_DUPLICATE',
          severity: 'block',
          message: 'Text is an exact duplicate of a recent confirmed post.',
        });
        exactFound = true;
        break;
      }
    }

    // Near duplicate check (trigram Jaccard >= 0.6 for text >= 40 chars)
    if (!exactFound && text.length >= 40) {
      for (const past of retained.slice(0, 200)) {
        const sim = jaccardTrigramSimilarity(text, past);
        if (sim >= 0.6) {
          hardFindings.push({
            code: 'NEAR_DUPLICATE',
            severity: 'block',
            message: `Text is a near duplicate of a recent confirmed post (similarity ${sim.toFixed(2)}).`,
          });
          break;
        }
      }
    }
  }

  // --- ADVISORY RULES ---

  // 1. Casing advisory (all uppercase letters)
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length > 5 && letters === letters.toUpperCase()) {
    advisoryFindings.push({
      code: 'CASING_ADVISORY',
      severity: 'warn',
      message: 'Text appears in all uppercase letters.',
    });
  }

  // 2. Emoji frequency (4 or more emojis)
  const emojis = text.match(EMOJI_REGEX) ?? [];
  if (emojis.length >= 4) {
    advisoryFindings.push({
      code: 'EMOJI_FREQUENCY',
      severity: 'info',
      message: `High emoji count detected (${emojis.length} emojis).`,
    });
  }

  // 3. AI phrase detection
  for (const aiPhrase of COMMON_AI_PHRASES) {
    if (normalizedLower.includes(aiPhrase.toLowerCase())) {
      advisoryFindings.push({
        code: 'AI_PHRASE',
        severity: 'info',
        message: `Possible AI cliché detected: "${aiPhrase}".`,
      });
      break;
    }
  }

  // 4. Avoid topics keyword
  const avoidTopics = doc.standards?.avoidTopics ?? (doc.voice as any)?.avoidTopics ?? [];
  if (avoidTopics.length > 0) {
    for (const topic of avoidTopics) {
      const cleanTopic = topic.trim().toLowerCase();
      if (cleanTopic.length > 0) {
        const regex = new RegExp(`(?:^|\\W)${cleanTopic}(?:$|\\W)`, 'iu');
        if (regex.test(text)) {
          advisoryFindings.push({
            code: 'AVOID_TOPIC_ADVISORY',
            severity: 'warn',
            message: `Text touches potentially avoided topic keyword: "${topic}".`,
          });
        }
      }
    }
  }

  // 5. Repeated opening words
  if (retained.length > 0) {
    const words = normalizeEcho(text).split(/\s+/u).slice(0, 3).join(' ').toLowerCase();
    if (words.length > 5) {
      for (const past of retained.slice(0, 50)) {
        const pastWords = normalizeEcho(past).split(/\s+/u).slice(0, 3).join(' ').toLowerCase();
        if (words === pastWords) {
          advisoryFindings.push({
            code: 'REPEATED_OPENING',
            severity: 'info',
            message: `Opening words "${words}" repeat a recent post.`,
          });
          break;
        }
      }
    }
  }

  return {
    hardPass: hardFindings.length === 0,
    hardFindings,
    advisoryFindings,
    weightedLength: len,
    hash,
  };
}
