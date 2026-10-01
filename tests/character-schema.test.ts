import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CharacterDocument,
  CharacterSettings,
  CharacterInvalidError,
  CHARACTER_SCHEMA_VERSION,
  CHARACTER_MAPPING_VERSION,
  SLIDER_LEVEL_1,
  SLIDER_LEVEL_5,
  compileSliderPhrase,
  CHARACTER_DISAGREEMENT_LINE,
  CHARACTER_PRECEDENCE_LINE,
  createDefaultCharacterDocument,
  createDefaultCharacterSettings,
  validateCharacterDocument,
  validateCharacterSettings,
  validateDraftSourceEnvelope,
  mergeCharacterDocument,
  mergeCharacterSettings,
  unicodeScalarLength,
} from '../src/daemon/character-schema.js';

test('off permits incomplete drafts but enabled modes enforce required fields', () => {
  // An empty/minimal document can be saved when mode is 'off'
  const draft = createDefaultCharacterDocument('Milo');
  draft.identity.oneLine = '';
  draft.voice.examples = [];
  draft.purpose.statement = '';

  const validatedOff = validateCharacterDocument(draft, 'off');
  assert.equal(validatedOff.identity.name, 'Milo');
  assert.equal(validatedOff.identity.oneLine, '');
  assert.equal(validatedOff.voice.examples.length, 0);

  // Voice mode requires oneLine and at least 3 examples
  assert.throws(
    () => validateCharacterDocument(draft, 'voice'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert.equal(err.code, 'CharacterInvalid');
      assert.equal(err.status, 400);
      assert(err.issues.some((i: string) => i.includes('oneLine')));
      assert(err.issues.some((i: string) => i.includes('examples')));
      return true;
    },
  );

  // Add oneLine and 2 examples: still fails for voice
  draft.identity.oneLine = 'Helpful assistant with a dry wit.';
  draft.voice.examples = [
    {
      id: 'ex-1',
      text: 'First sample post text.',
      surface: 'post',
      pinned: true,
      tags: ['intro'],
      origin: 'owner',
    },
    {
      id: 'ex-2',
      text: 'Second sample post text.',
      surface: 'reply',
      pinned: false,
      tags: [],
      origin: 'owner',
    },
  ];
  assert.throws(
    () => validateCharacterDocument(draft, 'voice'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('examples')));
      return true;
    },
  );

  // Add 3rd example: passes voice mode
  draft.voice.examples.push({
    id: 'ex-3',
    text: 'Third sample chat text.',
    surface: 'chat',
    pinned: false,
    tags: [],
    origin: 'drafted',
  });
  const validatedVoice = validateCharacterDocument(draft, 'voice');
  assert.equal(validatedVoice.voice.examples.length, 3);

  // Character mode additionally requires purpose.statement
  assert.throws(
    () => validateCharacterDocument(draft, 'character'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('statement')));
      return true;
    },
  );

  draft.purpose.statement = 'To assist the engineering team with clear technical reports.';
  const validatedChar = validateCharacterDocument(draft, 'character');
  assert.equal(validatedChar.purpose.statement, 'To assist the engineering team with clear technical reports.');
});

test('scalar caps differ from UTF-16 packet sizes and UTF-8 storage limits', () => {
  // Test scalar caps with surrogate pairs (emojis) and multi-byte characters (Arabic)
  const doc = createDefaultCharacterDocument('Milo');

  // Arabic text: 10 characters = 10 scalars, but 20 bytes in UTF-8
  const arabicText = 'مرحبا بالعالم'; // 13 chars
  assert.equal(unicodeScalarLength(arabicText), 13);
  doc.identity.name = arabicText;
  const validatedArabic = validateCharacterDocument(doc, 'off');
  assert.equal(validatedArabic.identity.name, arabicText);

  // Emoji surrogate pair: '🚀' is 2 UTF-16 code units, but 1 Unicode scalar
  const rocket = '🚀';
  assert.equal(rocket.length, 2);
  assert.equal(unicodeScalarLength(rocket), 1);

  // Field cap for identity.oneLine is 240 scalars.
  // 240 rockets = 480 UTF-16 length, but exactly 240 scalars. Must pass!
  doc.identity.oneLine = rocket.repeat(240);
  assert.equal(doc.identity.oneLine.length, 480);
  assert.equal(unicodeScalarLength(doc.identity.oneLine), 240);
  const validatedEmojis = validateCharacterDocument(doc, 'off');
  assert.equal(unicodeScalarLength(validatedEmojis.identity.oneLine), 240);

  // 241 rockets = 241 scalars. Must fail scalar cap!
  doc.identity.oneLine = rocket.repeat(241);
  assert.throws(
    () => validateCharacterDocument(doc, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('oneLine')));
      return true;
    },
  );

  // UTF-8 storage limit: document <= 64 KiB (65,536 bytes)
  // Fill background facts to exceed 64 KiB
  doc.identity.oneLine = 'Back to normal.';
  doc.backgroundFacts = [];
  for (let i = 0; i < 60; i++) {
    doc.backgroundFacts.push({
      id: `bg-${i}`,
      keys: ['test'],
      text: 'X'.repeat(500),
      provenance: 'fictional',
      always: false,
    });
  }
  // 60 * 500 = 30,000 bytes. Add notes up to 2000
  doc.notes = 'N'.repeat(2000);
  assert(Buffer.byteLength(JSON.stringify(doc), 'utf8') <= 65536);
  assert.doesNotThrow(() => validateCharacterDocument(doc, 'off'));

  // Now create an oversized document > 64 KiB
  // (e.g. by monkeypatching or testing storage bound check directly)
  const oversizedDoc = JSON.parse(JSON.stringify(doc));
  oversizedDoc.notes = 'N'.repeat(40000); // would fail scalar cap too, but let's test UTF-8 byte check
  assert.throws(
    () => validateCharacterDocument(oversizedDoc, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );

  // Settings storage limit: <= 8 KiB (8,192 bytes)
  const settings = createDefaultCharacterSettings();
  assert(Buffer.byteLength(JSON.stringify(settings), 'utf8') <= 8192);
  assert.doesNotThrow(() => validateCharacterSettings(settings));

  // Settings with huge unexpected payload fails
  const oversizedSettings = {
    ...settings,
    growth: {
      review: 'on' as const,
      readEngagement: true,
      maySuggest: Array.from({ length: 500 }, (_, i) => `section-${i}-${'Y'.repeat(50)}`),
    },
  };
  assert(Buffer.byteLength(JSON.stringify(oversizedSettings), 'utf8') > 8192);
  assert.throws(
    () => validateCharacterSettings(oversizedSettings),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );
});

test('unknown keys and future schema versions are rejected', () => {
  const doc = createDefaultCharacterDocument('Milo');

  // Unknown top-level key
  const withUnknownKey = { ...doc, extraField: 'not-allowed' };
  assert.throws(
    () => validateCharacterDocument(withUnknownKey, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );

  // Unknown key in nested object
  const withNestedUnknownKey = JSON.parse(JSON.stringify(doc));
  withNestedUnknownKey.identity.unknownProp = 123;
  assert.throws(
    () => validateCharacterDocument(withNestedUnknownKey, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );

  // Future schema version
  const withFutureSchema = { ...doc, schema: 'openhours.character/2' };
  assert.throws(
    () => validateCharacterDocument(withFutureSchema, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );

  // Unknown mapping version
  const withUnknownMapping = JSON.parse(JSON.stringify(doc));
  withUnknownMapping.personality.mappingVersion = 'openhours.sliders/99';
  assert.throws(
    () => validateCharacterDocument(withUnknownMapping, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );

  // BCP-47 language tag validation
  const withInvalidLanguage = JSON.parse(JSON.stringify(doc));
  withInvalidLanguage.identity.languages = ['not_a_valid_bcp47_locale_tag_12345'];
  assert.throws(
    () => validateCharacterDocument(withInvalidLanguage, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );

  // IANA timezone validation
  const withInvalidTz = JSON.parse(JSON.stringify(doc));
  withInvalidTz.identity.timezone = 'Invalid/Fake_Zone';
  assert.throws(
    () => validateCharacterDocument(withInvalidTz, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );

  // Pinned examples cap: at most 2 pinned
  const with3Pinned = JSON.parse(JSON.stringify(doc));
  with3Pinned.voice.examples = [
    { id: '1', text: 'one', surface: 'post', pinned: true, tags: [], origin: 'owner' },
    { id: '2', text: 'two', surface: 'post', pinned: true, tags: [], origin: 'owner' },
    { id: '3', text: 'three', surface: 'post', pinned: true, tags: [], origin: 'owner' },
  ];
  assert.throws(
    () => validateCharacterDocument(with3Pinned, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('pinned')));
      return true;
    },
  );

  // Core commitments cap: at most 4 core
  const with5Core = JSON.parse(JSON.stringify(doc));
  with5Core.commitments = Array.from({ length: 5 }, (_, i) => ({
    id: `c-${i}`,
    topic: `topic ${i}`,
    stance: `stance ${i}`,
    importance: 'core',
    certainty: 'high',
    keywords: ['k1'],
  }));
  assert.throws(
    () => validateCharacterDocument(with5Core, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('core')));
      return true;
    },
  );

  // Salient biography cap: at most 3 salient
  const with4Salient = JSON.parse(JSON.stringify(doc));
  with4Salient.biography = Array.from({ length: 4 }, (_, i) => ({
    id: `b-${i}`,
    text: `bio ${i}`,
    provenance: 'owner-attested',
    salient: true,
  }));
  assert.throws(
    () => validateCharacterDocument(with4Salient, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('salient')));
      return true;
    },
  );

  // Always-on background facts cap: total text <= 400 characters
  const withOversizedAlways = JSON.parse(JSON.stringify(doc));
  withOversizedAlways.backgroundFacts = [
    { id: 'bg-1', keys: ['k'], text: 'A'.repeat(250), provenance: 'verified', always: true },
    { id: 'bg-2', keys: ['k'], text: 'B'.repeat(200), provenance: 'verified', always: true },
  ]; // total = 450 > 400
  assert.throws(
    () => validateCharacterDocument(withOversizedAlways, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('always')));
      return true;
    },
  );

  // Min/max ordering in postRules.length
  const withBadLengthOrder = JSON.parse(JSON.stringify(doc));
  withBadLengthOrder.voice.postRules.length = { min: 200, max: 100 };
  assert.throws(
    () => validateCharacterDocument(withBadLengthOrder, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );

  // Current focus date ordering: expiresAt >= startedAt
  const withBadFocusDates = JSON.parse(JSON.stringify(doc));
  withBadFocusDates.currentFocus = [
    {
      id: 'f-1',
      text: 'focus',
      startedAt: '2026-09-25T12:00:00Z',
      expiresAt: '2026-09-24T12:00:00Z',
    },
  ];
  assert.throws(
    () => validateCharacterDocument(withBadFocusDates, 'off'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );
});

test('slider mappings preserve evidence-based disagreement', () => {
  assert.equal(CHARACTER_MAPPING_VERSION, 'openhours.sliders/1');
  assert.equal(CHARACTER_SCHEMA_VERSION, 'openhours.character/1');

  // Level 3 compiles to empty string
  assert.equal(compileSliderPhrase('curious', 3), '');
  assert.equal(compileSliderPhrase('organised', 3), '');
  assert.equal(compileSliderPhrase('outgoing', 3), '');
  assert.equal(compileSliderPhrase('agreeable', 3), '');
  assert.equal(compileSliderPhrase('sensitive', 3), '');

  // Level 1 phrases
  assert.equal(SLIDER_LEVEL_1.curious, 'Stick to familiar topics; prefer the practical to the novel.');
  assert.equal(SLIDER_LEVEL_1.organised, "Be loose and spontaneous; it's fine to leave threads open.");
  assert.equal(SLIDER_LEVEL_1.outgoing, 'Say less; let a short observation stand on its own.');
  assert.equal(
    SLIDER_LEVEL_1.agreeable,
    'Say plainly when you disagree and why; argue with ideas, never with people; change your mind when shown real evidence.',
  );
  assert.equal(SLIDER_LEVEL_1.sensitive, 'Stay unbothered; answer provocation with calm.');

  // Level 5 phrases
  assert.equal(SLIDER_LEVEL_5.curious, 'Notice odd details and ask why; connect unrelated things.');
  assert.equal(SLIDER_LEVEL_5.organised, "Be precise and structured; follow through on what you said you'd do.");
  assert.equal(SLIDER_LEVEL_5.outgoing, 'Talk to your audience directly; ask questions; share plans.');
  assert.equal(SLIDER_LEVEL_5.agreeable, "Look for what's right in other views first; disagree gently and briefly.");
  assert.equal(SLIDER_LEVEL_5.sensitive, 'Admit when things get to you; react openly to good and bad news.');

  // Level 2 and Level 4 prefixes
  assert.equal(compileSliderPhrase('agreeable', 1), SLIDER_LEVEL_1.agreeable);
  assert.equal(compileSliderPhrase('agreeable', 2), `Often: ${SLIDER_LEVEL_1.agreeable}`);
  assert.equal(compileSliderPhrase('agreeable', 4), `Often: ${SLIDER_LEVEL_5.agreeable}`);
  assert.equal(compileSliderPhrase('agreeable', 5), SLIDER_LEVEL_5.agreeable);

  // Evidence-based disagreement line
  assert.equal(
    CHARACTER_DISAGREEMENT_LINE,
    'When challenged without new evidence, explain your reason once, briefly. When shown real evidence, update and say you changed your mind.',
  );
  assert.equal(CHARACTER_DISAGREEMENT_LINE.length, 136);

  // Precedence line
  assert.equal(
    CHARACTER_PRECEDENCE_LINE,
    'The owner, your job and runtime rules outrank this character. It never changes a check or limit.',
  );
  assert.equal(CHARACTER_PRECEDENCE_LINE.length, 96);
});

test('source envelopes preserve verbatim text', () => {
  const rawTextWithWhitespace = '  \r\n\tLeading and trailing spaces, plus CRLF.\r\nLine 2.\t  ';

  // Valid draft handle with 'draft:' prefix
  const envelope = validateDraftSourceEnvelope({
    handle: 'draft:sample-1',
    kind: 'sample',
    text: rawTextWithWhitespace,
    meta: { originalNote: 'preserved' },
  });

  // Source text is preserved verbatim - NO trimming
  assert.equal(envelope.text, rawTextWithWhitespace);
  assert.equal(envelope.handle, 'draft:sample-1');
  assert.equal(envelope.kind, 'sample');
  assert.equal(envelope.meta?.originalNote, 'preserved');

  // Handle format must start with draft:
  assert.throws(
    () =>
      validateDraftSourceEnvelope({
        handle: 'src-12345', // server id format, not a draft handle
        kind: 'sample',
        text: 'some text',
      }),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('handle')));
      return true;
    },
  );

  // 4,000 char cap on normal kinds
  assert.throws(
    () =>
      validateDraftSourceEnvelope({
        handle: 'draft:too-long',
        kind: 'sentence',
        text: 'A'.repeat(4001),
      }),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      return true;
    },
  );

  // description-original is uncapped
  const longOriginal = 'D'.repeat(10000);
  const uncappedEnvelope = validateDraftSourceEnvelope({
    handle: 'draft:desc-orig',
    kind: 'description-original',
    text: longOriginal,
  });
  assert.equal(uncappedEnvelope.text.length, 10000);

  // In contrast, document strings ARE trimmed
  const doc = createDefaultCharacterDocument('Milo');
  doc.identity.name = '   Trimmed Milo   ';
  const validated = validateCharacterDocument(doc, 'off');
  assert.equal(validated.identity.name, 'Trimmed Milo');
});

test('partial saves preserve hidden fields and merge correctly', () => {
  const base = createDefaultCharacterDocument('Milo');
  base.commitments = [
    {
      id: 'c-1',
      topic: 'Rust',
      stance: 'Memory safety matters',
      importance: 'core',
      certainty: 'high',
      keywords: ['rust'],
    },
  ];
  base.biography = [
    {
      id: 'b-1',
      text: 'Created in 2026',
      provenance: 'owner-attested',
      salient: true,
    },
  ];
  base.notes = 'Hidden owner notes';

  // Patch only touches identity and voice
  const patch = {
    identity: {
      name: 'Milo 2.0',
    },
    voice: {
      rules: {
        casing: 'lowercase' as const,
      },
    },
  };

  const merged = mergeCharacterDocument(base, patch);
  assert.equal(merged.identity.name, 'Milo 2.0');
  assert.equal(merged.voice.rules.casing, 'lowercase');
  // Hidden fields are preserved
  assert.equal(merged.commitments.length, 1);
  assert.equal(merged.commitments[0].topic, 'Rust');
  assert.equal(merged.biography.length, 1);
  assert.equal(merged.notes, 'Hidden owner notes');

  // Explicit array replaces array
  const patchWithNewArray = {
    commitments: [],
  };
  const mergedEmptyArray = mergeCharacterDocument(base, patchWithNewArray);
  assert.equal(mergedEmptyArray.commitments.length, 0);

  // Settings merge
  const baseSettings = createDefaultCharacterSettings();
  baseSettings.mode = 'off';
  baseSettings.growth = { review: 'off', readEngagement: false };

  const settingsPatch = {
    mode: 'voice' as const,
  };
  const mergedSettings = mergeCharacterSettings(baseSettings, settingsPatch);
  assert.equal(mergedSettings.mode, 'voice');
  assert.equal(mergedSettings.growth.review, 'off');
});
