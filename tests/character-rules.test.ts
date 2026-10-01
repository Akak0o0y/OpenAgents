import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkCharacterRules,
  type CharacterRuleContext,
  type CharacterRuleFinding,
  jaccardTrigramSimilarity,
} from '../src/daemon/character-rules.js';
import type { CharacterDocument, CharacterSettings } from '../src/daemon/character-schema.js';

function createMockDoc(overrides: Partial<CharacterDocument> = {}): CharacterDocument {
  return {
    version: 1,
    identity: {
      name: 'Milo',
      tagline: 'Autonomous AI assistant',
      avatarUrl: '',
      handle: 'milo_agent',
      timezone: 'UTC',
      locale: 'en',
    },
    voice: {
      tone: 'helpful',
      style: 'concise',
      vocabulary: [],
      avoidPhrases: ['as an ai', 'delve'],
      avoidTopics: ['politics', 'crypto'],
      catchphrases: [],
    },
    postRules: {
      length: 280,
      maxHashtags: 1,
      links: 'never',
    },
    personality: {
      sliders: {
        curious: 3,
        organised: 3,
        outgoing: 3,
        agreeable: 3,
        sensitive: 3,
      },
      traits: [],
      quirks: [],
    },
    commitments: {
      core: [],
      boundaries: [],
      stances: [],
    },
    ...overrides,
  } as unknown as CharacterDocument;
}

const mockSettings: CharacterSettings = {
  mode: 'character',
  checks: {
    sampling: 'all',
    reviewer: null,
    outage: 'rules-only',
    inventedDetails: 'everyday-only',
  },
  growth: {
    review: 'off',
    readEngagement: false,
  },
  retention: {
    months: 12,
  },
};

test('hard and advisory rules stay distinct', () => {
  const doc = createMockDoc();
  const context: CharacterRuleContext = {
    surface: 'public-compose',
    retainedConfirmedPosts: ['Past confirmed post about building software.'],
  };

  // 1. Clean compliant text
  const clean = checkCharacterRules('Exploring new algorithms for graph processing today.', doc, mockSettings, context);
  assert.equal(clean.hardPass, true, 'clean text must pass hard rules');
  assert.equal(clean.hardFindings.length, 0);
  assert.equal(clean.advisoryFindings.length, 0);

  // 2. Hard failure: Avoid phrase ("delve")
  const withAvoidPhrase = checkCharacterRules('Let us delve into this new data structure.', doc, mockSettings, context);
  assert.equal(withAvoidPhrase.hardPass, false);
  assert.ok(withAvoidPhrase.hardFindings.some((f: CharacterRuleFinding) => f.code === 'AVOID_PHRASE'));

  // 3. Hard failure: Disallowed link (links: 'never')
  const withLink = checkCharacterRules('Check out https://example.com for more information.', doc, mockSettings, context);
  assert.equal(withLink.hardPass, false);
  assert.ok(withLink.hardFindings.some((f: CharacterRuleFinding) => f.code === 'LINK_FORBIDDEN'));

  // 4. Hard failure: Excessive hashtags (maxHashtags: 1)
  const withHashtags = checkCharacterRules('Building graphs #tech #ai #software today.', doc, mockSettings, context);
  assert.equal(withHashtags.hardPass, false);
  assert.ok(withHashtags.hardFindings.some((f: CharacterRuleFinding) => f.code === 'HASHTAG_LIMIT'));

  // 5. Hard failure: Weighted length exceeding 280
  const longText = 'A'.repeat(285);
  const withLong = checkCharacterRules(longText, doc, mockSettings, context);
  assert.equal(withLong.hardPass, false);
  assert.ok(withLong.hardFindings.some((f: CharacterRuleFinding) => f.code === 'LENGTH_LIMIT'));

  // 6. Advisory only: all uppercase casing
  const yelling = checkCharacterRules('THIS IS AN ALL UPPERCASE TEXT BUT COMPLIANT WITH HARD RULES.', doc, mockSettings, context);
  assert.equal(yelling.hardPass, true, 'advisory casing must not fail hard rules');
  assert.ok(yelling.advisoryFindings.some((f: CharacterRuleFinding) => f.code === 'CASING_ADVISORY'));

  // 7. Advisory only: emoji frequency
  const emojis = checkCharacterRules('Graph processing is great today! 🚀✨🎉🤖', doc, mockSettings, context);
  assert.equal(emojis.hardPass, true, 'emoji advisory must not fail hard rules');
  assert.ok(emojis.advisoryFindings.some((f: CharacterRuleFinding) => f.code === 'EMOJI_FREQUENCY'));

  // 8. Advisory only: AI phrase
  const aiPhrase = checkCharacterRules('This project stands as a testament to hard engineering work.', doc, mockSettings, context);
  assert.equal(aiPhrase.hardPass, true, 'AI phrase advisory must not fail hard rules');
  assert.ok(aiPhrase.advisoryFindings.some((f: CharacterRuleFinding) => f.code === 'AI_PHRASE'));

  // 9. Advisory only: Avoid topic keyword
  const avoidTopic = checkCharacterRules('Discussion about decentralized crypto ledgers.', doc, mockSettings, context);
  assert.equal(avoidTopic.hardPass, true, 'avoid topic keyword is advisory for reviewer');
  assert.ok(avoidTopic.advisoryFindings.some((f: CharacterRuleFinding) => f.code === 'AVOID_TOPIC_ADVISORY'));

  // 10. Advisory only: Repeated opening words
  const repeatedOpening = checkCharacterRules('Past confirmed post about exciting new developments.', doc, mockSettings, context);
  assert.equal(repeatedOpening.hardPass, true);
  assert.ok(repeatedOpening.advisoryFindings.some((f: CharacterRuleFinding) => f.code === 'REPEATED_OPENING'));
});

test('duplicate thresholds cover Arabic English mixed and short text', () => {
  const doc = createMockDoc();

  // 1. English exact duplicate
  const englishOriginal = 'We are shipping the new real-time activity stream engine.';
  const resEngExact = checkCharacterRules(
    englishOriginal,
    doc,
    mockSettings,
    { surface: 'public-compose', retainedConfirmedPosts: [englishOriginal] }
  );
  assert.equal(resEngExact.hardPass, false);
  assert.ok(resEngExact.hardFindings.some((f: CharacterRuleFinding) => f.code === 'EXACT_DUPLICATE'));

  // 2. Arabic exact duplicate
  const arabicOriginal = 'نحن نعمل اليوم على تحسين محرك معالجة البيانات الموزعة.';
  const resArExact = checkCharacterRules(
    arabicOriginal,
    doc,
    mockSettings,
    { surface: 'public-compose', retainedConfirmedPosts: [arabicOriginal] }
  );
  assert.equal(resArExact.hardPass, false);
  assert.ok(resArExact.hardFindings.some((f: CharacterRuleFinding) => f.code === 'EXACT_DUPLICATE'));

  // 3. Mixed script exact duplicate
  const mixedOriginal = 'تحديث جديد على engine معالجة البيانات بسرعة فائقة!';
  const resMixedExact = checkCharacterRules(
    mixedOriginal,
    doc,
    mockSettings,
    { surface: 'public-compose', retainedConfirmedPosts: [mixedOriginal] }
  );
  assert.equal(resMixedExact.hardPass, false);
  assert.ok(resMixedExact.hardFindings.some((f: CharacterRuleFinding) => f.code === 'EXACT_DUPLICATE'));

  // 4. Short text (<40 chars) exemption from near-duplicate Jaccard
  // Short texts that are not exact matches are exempt from trigram Jaccard
  const shortOriginal = 'Good morning everyone!';
  const shortVariant = 'Good morning friends!';
  assert.ok(shortVariant.length < 40);
  const resShort = checkCharacterRules(
    shortVariant,
    doc,
    mockSettings,
    { surface: 'public-compose', retainedConfirmedPosts: [shortOriginal] }
  );
  assert.equal(resShort.hardPass, true, 'short text variants under 40 chars must be exempt from Jaccard threshold');

  // Short text exact match must still fail
  const resShortExact = checkCharacterRules(
    shortOriginal,
    doc,
    mockSettings,
    { surface: 'public-compose', retainedConfirmedPosts: [shortOriginal] }
  );
  assert.equal(resShortExact.hardPass, false);
  assert.ok(resShortExact.hardFindings.some((f: CharacterRuleFinding) => f.code === 'EXACT_DUPLICATE'));

  // 5. Trigram Jaccard boundary >= 0.6 for longer texts (>= 40 chars)
  const baseEnglish = 'The distributed consensus algorithm guarantees consistency under network partitions.';
  // High similarity variant (minor word change): Jaccard >= 0.6
  const nearDuplicate = 'The distributed consensus algorithm guarantees high consistency under network partitions.';
  const jaccardEng = jaccardTrigramSimilarity(baseEnglish, nearDuplicate);
  assert.ok(jaccardEng >= 0.6, `Jaccard score ${jaccardEng} should be >= 0.6`);

  const resNearDup = checkCharacterRules(
    nearDuplicate,
    doc,
    mockSettings,
    { surface: 'public-compose', retainedConfirmedPosts: [baseEnglish] }
  );
  assert.equal(resNearDup.hardPass, false);
  assert.ok(resNearDup.hardFindings.some((f: CharacterRuleFinding) => f.code === 'NEAR_DUPLICATE'));

  // Arabic near duplicate
  const baseArabic = 'خوارزمية الإجماع الموزعة تضمن اتساق البيانات في حال انقطاع الشبكة.';
  const nearArabic = 'خوارزمية الإجماع الموزعة تضمن دقة اتساق البيانات في حال انقطاع الشبكة.';
  const jaccardAr = jaccardTrigramSimilarity(baseArabic, nearArabic);
  assert.ok(jaccardAr >= 0.6, `Arabic Jaccard score ${jaccardAr} should be >= 0.6`);

  const resNearAr = checkCharacterRules(
    nearArabic,
    doc,
    mockSettings,
    { surface: 'public-compose', retainedConfirmedPosts: [baseArabic] }
  );
  assert.equal(resNearAr.hardPass, false);
  assert.ok(resNearAr.hardFindings.some((f: CharacterRuleFinding) => f.code === 'NEAR_DUPLICATE'));

  // Distinct longer text (< 0.6 Jaccard) passes
  const distinctText = 'Exploring modern approaches to persistent memory storage and asynchronous disk writes.';
  const jaccardDistinct = jaccardTrigramSimilarity(baseEnglish, distinctText);
  assert.ok(jaccardDistinct < 0.6, `Distinct Jaccard score ${jaccardDistinct} should be < 0.6`);

  const resDistinct = checkCharacterRules(
    distinctText,
    doc,
    mockSettings,
    { surface: 'public-compose', retainedConfirmedPosts: [baseEnglish] }
  );
  assert.equal(resDistinct.hardPass, true, 'distinct text must pass near-duplicate check');
});

test('public length rules do not constrain owner chat', () => {
  const doc = createMockDoc();
  const longChatMessage = 'This is an in-depth conversation reply for the owner in owner chat. '.repeat(10);
  assert.ok(longChatMessage.length > 300, 'ChatMessage must exceed public 280 length');

  // Surface: owner-chat -> length rule must NOT constrain
  const chatResult = checkCharacterRules(
    longChatMessage,
    doc,
    mockSettings,
    { surface: 'owner-chat' }
  );
  assert.equal(chatResult.hardPass, true, 'owner-chat must not be constrained by public post length rules');
  assert.ok(!chatResult.hardFindings.some((f: CharacterRuleFinding) => f.code === 'LENGTH_LIMIT'));

  // Surface: public-compose -> length rule MUST constrain
  const publicResult = checkCharacterRules(
    longChatMessage,
    doc,
    mockSettings,
    { surface: 'public-compose' }
  );
  assert.equal(publicResult.hardPass, false, 'public-compose must enforce public post length rules');
  assert.ok(publicResult.hardFindings.some((f: CharacterRuleFinding) => f.code === 'LENGTH_LIMIT'));
});
