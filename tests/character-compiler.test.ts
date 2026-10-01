import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CharacterDocument,
  CharacterSettings,
  CharacterInvalidError,
  createDefaultCharacterDocument,
  createDefaultCharacterSettings,
  CHARACTER_DISAGREEMENT_LINE,
  CHARACTER_PRECEDENCE_LINE,
} from '../src/daemon/character-schema.js';
import {
  compileCharacterPacket,
  checkCharacterDocumentFit,
  COMPILER_VERSION,
  EMPTY_CARD_SHA256,
} from '../src/daemon/character-compiler.js';

test('public review supplies bounded rubric, approved core and candidate-based evidence', () => {
  const doc = createSampleMiloDocument();
  const settings = createDefaultCharacterSettings(); settings.mode = 'character';
  const packet = compileCharacterPacket({ document: doc, settings, surface: 'public-review', query: 'built safety', asOf: '2026-09-25T00:00:00.000Z' });
  assert.match(packet.stable, /review/i);
  assert.ok(packet.stable.includes('Tests must pass before shipping'));
  assert.ok(packet.data.includes('24/7 autonomous safety harnesses'));
  assert.ok(packet.stable.length <= 2000);
  assert.ok(packet.data.length <= 2400);
});

function createSampleMiloDocument(): CharacterDocument {
  const doc = createDefaultCharacterDocument('Milo');
  doc.identity.handle = '@milo';
  doc.identity.oneLine = 'Pragmatic assistant with a dry wit and deep respect for code correctness.';
  doc.purpose.statement = 'Help the engineering team ship reliable software without breaking parity.';
  doc.purpose.topics = ['TypeScript', 'Testing', 'Safety'];

  doc.biography = [
    {
      id: 'bio-1',
      text: 'Built to maintain 24/7 autonomous safety harnesses.',
      provenance: 'owner-attested',
      salient: true,
    },
  ];

  doc.voice.rules.casing = 'normal';
  doc.voice.rules.emoji = 'rare';
  doc.voice.rules.do = ['Be concise', 'Cite evidence'];
  doc.voice.rules.dont = ['Speculate'];

  doc.voice.examples = [
    {
      id: 'ex-1',
      text: 'The build failed on line 42; here is the trace.',
      surface: 'post',
      pinned: true,
      tags: ['build'],
      origin: 'owner',
    },
    {
      id: 'ex-2',
      text: 'Parity is preserved across all four seams.',
      surface: 'post',
      pinned: true,
      tags: ['parity'],
      origin: 'owner',
    },
    {
      id: 'ex-3',
      text: 'Running regression sweep before making assertions.',
      surface: 'reply',
      pinned: false,
      tags: ['testing'],
      origin: 'owner',
    },
  ];

  doc.personality.sliders = {
    curious: 1, // Stick to familiar topics...
    organised: 5, // Be precise and structured...
    outgoing: 3, // empty
    agreeable: 3, // empty
    sensitive: 3, // empty
  };
  doc.personality.humour = 'dry';

  doc.commitments = [
    {
      id: 'comm-1',
      topic: 'Correctness',
      stance: 'Tests must pass before shipping',
      importance: 'core',
      certainty: 'high',
      keywords: ['tests', 'shipping'],
    },
  ];

  doc.standards.never = ['claim unverified work is done', 'fabricate test results'];
  doc.standards.avoidTopics = ['personal gossip'];
  doc.notes = 'Do not compile this note';

  return doc;
}

test('golden packets cover every mode and surface', () => {
  const doc = createSampleMiloDocument();
  const settings = createDefaultCharacterSettings();

  // 1. owner-chat Character mode
  settings.mode = 'character';
  const chatCharPacket = compileCharacterPacket({
    document: doc,
    settings,
    surface: 'owner-chat',
  });
  const goldenChatChar = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'tests/fixtures/character/goldens/owner-chat-character.json'),
      'utf8',
    ),
  );
  assert.equal(chatCharPacket.stable, goldenChatChar.expectedStable);
  assert.equal(chatCharPacket.mode, 'character');
  assert.equal(chatCharPacket.surface, 'owner-chat');
  assert(chatCharPacket.stable.includes(CHARACTER_PRECEDENCE_LINE));
  assert(chatCharPacket.stable.includes(CHARACTER_DISAGREEMENT_LINE));
  assert(!chatCharPacket.stable.includes('Do not compile this note'));

  // 2. owner-chat Voice mode
  settings.mode = 'voice';
  const chatVoicePacket = compileCharacterPacket({
    document: doc,
    settings,
    surface: 'owner-chat',
  });
  const goldenChatVoice = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'tests/fixtures/character/goldens/owner-chat-voice.json'),
      'utf8',
    ),
  );
  assert.equal(chatVoicePacket.stable, goldenChatVoice.expectedStable);
  assert.equal(chatVoicePacket.mode, 'voice');
  assert(!chatVoicePacket.stable.includes(CHARACTER_DISAGREEMENT_LINE)); // Voice has no disagreement line
  assert(chatVoicePacket.stable.includes(CHARACTER_PRECEDENCE_LINE));

  // 3. public-compose Character mode
  settings.mode = 'character';
  const composeCharPacket = compileCharacterPacket({
    document: doc,
    settings,
    surface: 'public-compose',
  });
  const goldenComposeChar = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'tests/fixtures/character/goldens/public-compose-character.json'),
      'utf8',
    ),
  );
  assert.equal(composeCharPacket.stable, goldenComposeChar.expectedStable);
  assert(composeCharPacket.stable.includes('Built to maintain 24/7 autonomous safety harnesses.'));

  // 4. public-compose Voice mode
  settings.mode = 'voice';
  const composeVoicePacket = compileCharacterPacket({
    document: doc,
    settings,
    surface: 'public-compose',
  });
  const goldenComposeVoice = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'tests/fixtures/character/goldens/public-compose-voice.json'),
      'utf8',
    ),
  );
  assert.equal(composeVoicePacket.stable, goldenComposeVoice.expectedStable);

  // 5. task-loop
  const taskPacket = compileCharacterPacket({
    document: doc,
    settings,
    surface: 'task-loop',
  });
  const goldenTask = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'tests/fixtures/character/goldens/task-loop.json'),
      'utf8',
    ),
  );
  assert.equal(taskPacket.stable, goldenTask.expectedStable);
  assert(taskPacket.stable.length <= 320);

  // 6. code surface
  const codePacket = compileCharacterPacket({
    document: doc,
    settings,
    surface: 'code',
  });
  assert.equal(codePacket.stable, '');
  assert.equal(codePacket.data, '');

  // 7. Off mode
  settings.mode = 'off';
  const offPacket = compileCharacterPacket({
    document: doc,
    settings,
    surface: 'owner-chat',
  });
  assert.equal(offPacket.stable, '');
  assert.equal(offPacket.data, '');
  assert.equal(offPacket.meta.stableSha256, EMPTY_CARD_SHA256);
});

test('changing query seed or asOf cannot change the stable core', () => {
  const doc = createSampleMiloDocument();
  const settings = createDefaultCharacterSettings();
  settings.mode = 'character';

  const packet1 = compileCharacterPacket({
    document: doc,
    settings,
    surface: 'owner-chat',
    query: 'How is the deployment going?',
    seed: 'seed-run-1',
    asOf: '2026-09-25T10:00:00.000Z',
  });

  const packet2 = compileCharacterPacket({
    document: doc,
    settings,
    surface: 'owner-chat',
    query: 'A completely different query about databases!',
    seed: 'seed-run-999',
    asOf: '2030-01-01T00:00:00.000Z',
  });

  // The stable core and its hash MUST be byte-identical!
  assert.equal(packet1.stable, packet2.stable);
  assert.equal(packet1.meta.stableSha256, packet2.meta.stableSha256);
});

test('mandatory sections cannot be silently omitted', () => {
  const doc = createSampleMiloDocument();

  // Valid document fits
  assert.doesNotThrow(() => checkCharacterDocumentFit(doc, 'character'));
  assert.doesNotThrow(() => checkCharacterDocumentFit(doc, 'voice'));

  // 1. Header fit check: max 150 chars for owner-chat
  // If oneLine is too long to fit in 150-char header
  const docLongHeader = JSON.parse(JSON.stringify(doc));
  docLongHeader.identity.oneLine = 'X'.repeat(140); // 'You are Milo (@milo). ' + 140 = 162 > 150
  assert.throws(
    () => checkCharacterDocumentFit(docLongHeader, 'character'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('header')));
      return true;
    },
  );

  // 2. Lines fit check: max 350 chars
  const docLongLines = JSON.parse(JSON.stringify(doc));
  docLongLines.standards.never = [
    'A'.repeat(150),
    'B'.repeat(150),
    'C'.repeat(100),
  ];
  assert.throws(
    () => checkCharacterDocumentFit(docLongLines, 'character'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('lines') || i.includes('standards')));
      return true;
    },
  );

  // 3. Core commitments fit check: max 330 chars in Character mode
  const docLongCore = JSON.parse(JSON.stringify(doc));
  docLongCore.commitments = [
    {
      id: 'c-1',
      topic: 'Topic 1',
      stance: 'Z'.repeat(150),
      importance: 'core',
      certainty: 'high',
      keywords: ['k'],
    },
    {
      id: 'c-2',
      topic: 'Topic 2',
      stance: 'Y'.repeat(100),
      importance: 'core',
      certainty: 'high',
      keywords: ['k'],
    },
  ];
  // 150 + 100 + headers + 136 disagreement line > 330
  assert.throws(
    () => checkCharacterDocumentFit(docLongCore, 'character'),
    (err: any) => {
      assert(err instanceof CharacterInvalidError);
      assert(err.issues.some((i: string) => i.includes('core commitments')));
      return true;
    },
  );
});

test('serialized allocations include labels separators and fixed sentences', () => {
  const doc = createSampleMiloDocument();
  const settings = createDefaultCharacterSettings();

  // Test Character owner-chat total size <= 1600
  settings.mode = 'character';
  const chatChar = compileCharacterPacket({ document: doc, settings, surface: 'owner-chat' });
  assert(chatChar.stable.length <= 1600, `chatChar stable length ${chatChar.stable.length} must be <= 1600`);

  // Test Voice owner-chat total size <= 1000
  settings.mode = 'voice';
  const chatVoice = compileCharacterPacket({ document: doc, settings, surface: 'owner-chat' });
  assert(chatVoice.stable.length <= 1000, `chatVoice stable length ${chatVoice.stable.length} must be <= 1000`);

  // Test Character public-compose core <= 2500
  settings.mode = 'character';
  const compChar = compileCharacterPacket({ document: doc, settings, surface: 'public-compose' });
  assert(compChar.stable.length <= 2500, `compChar stable length ${compChar.stable.length} must be <= 2500`);

  // Test Voice public-compose core <= 1120
  settings.mode = 'voice';
  const compVoice = compileCharacterPacket({ document: doc, settings, surface: 'public-compose' });
  assert(compVoice.stable.length <= 1120, `compVoice stable length ${compVoice.stable.length} must be <= 1120`);

  // Test task-loop <= 320
  const taskPacket = compileCharacterPacket({ document: doc, settings, surface: 'task-loop' });
  assert(taskPacket.stable.length <= 320, `taskPacket stable length ${taskPacket.stable.length} must be <= 320`);
});
