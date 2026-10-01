import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CharacterDocument,
  createDefaultCharacterDocument,
} from '../src/daemon/character-schema.js';
import {
  recallCharacterData,
  selectComposeExamples,
  CharacterRecallOptions,
  CHARACTER_DATA_TAG_OPEN,
  CHARACTER_DATA_TAG_CLOSE,
  CHARACTER_DATA_HEADING,
} from '../src/daemon/character-recall.js';

test('compose recall retains two recent posts and relevant older posts with dated speech provenance', () => {
  const doc = createDefaultCharacterDocument('Milo');
  const result = recallCharacterData({ document: doc, surface: 'public-compose', query: 'SQLite', records: { utterances: [
    { id: 'new1', text: 'First recent thought.', createdAt: '2026-09-26' },
    { id: 'new2', text: 'Second recent thought.', createdAt: '2026-09-25' },
    { id: 'irrelevant', text: 'An old flower.', createdAt: '2026-09-24' },
    { id: 'relevant', text: 'SQLite deserves careful backups.', createdAt: '2026-09-01' },
  ] } });
  assert.ok(result.recalledIds.includes('utt-new1'));
  assert.ok(result.recalledIds.includes('utt-new2'));
  assert.ok(result.recalledIds.includes('utt-relevant'));
  assert.ok(!result.recalledIds.includes('utt-irrelevant'));
  assert.match(result.data, /said on 2026-09-01/);
});

function createSampleRecallDocument(): CharacterDocument {
  const doc = createDefaultCharacterDocument('Milo');
  doc.identity.name = 'Milo';
  doc.identity.handle = '@milo';

  doc.commitments = [
    {
      id: 'comm-1',
      topic: 'Rust',
      stance: 'Memory safety prevents whole classes of runtime bugs.',
      importance: 'ordinary',
      certainty: 'high',
      keywords: ['rust', 'memory', 'safety'],
    },
    {
      id: 'comm-2',
      topic: 'Testing',
      stance: 'Parity baselines must be captured before refactoring.',
      importance: 'core',
      certainty: 'high',
      keywords: ['parity', 'testing'],
    },
  ];

  doc.relationships = [
    {
      id: 'rel-1',
      handle: 'alice',
      platform: 'x',
      who: 'Lead security researcher at Cypher.',
      tie: 'peer',
      provenance: 'verified',
    },
  ];

  doc.backgroundFacts = [
    {
      id: 'bg-1',
      keys: ['database', 'sqlite'],
      text: 'Uses SQLite in WAL mode for persistent daemon state.',
      provenance: 'verified',
      always: true,
    },
    {
      id: 'bg-2',
      keys: ['deployment', 'docker'],
      text: 'Daemon containers run under restricted user permissions.',
      provenance: 'owner-attested',
      always: false,
    },
  ];

  doc.currentFocus = [
    {
      id: 'f-active',
      text: 'Stabilizing Phase 1 character layer implementation.',
      startedAt: '2026-09-20T00:00:00.000Z',
      expiresAt: '2026-09-30T00:00:00.000Z',
    },
    {
      id: 'f-expired',
      text: 'Preparing initial architectural design document.',
      startedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
    },
  ];

  doc.voice.examples = [
    {
      id: 'ex-post-1',
      text: 'Memory safety is non-negotiable for system daemons.',
      surface: 'post',
      pinned: false,
      tags: ['memory'],
      origin: 'owner',
    },
    {
      id: 'ex-post-2',
      text: 'Clean test runs make for quiet on-call rotations.',
      surface: 'post',
      pinned: false,
      tags: ['testing'],
      origin: 'owner',
    },
    {
      id: 'ex-reply-1',
      text: 'Have you verified the SQLite WAL configuration?',
      surface: 'reply',
      pinned: false,
      tags: ['sqlite'],
      origin: 'owner',
    },
    {
      id: 'ex-chat-1',
      text: 'I can inspect that log file for you right away.',
      surface: 'chat',
      pinned: false,
      tags: ['chat'],
      origin: 'drafted',
    },
  ];

  return doc;
}

test('recall is deterministic bot-scoped and provenance-labelled', () => {
  const doc = createSampleRecallDocument();
  const options: CharacterRecallOptions = {
    document: doc,
    surface: 'owner-chat',
    query: 'What do you think about rust and sqlite with @alice?',
    seed: 'test-seed-123',
    asOf: '2026-09-25T12:00:00.000Z',
    records: {
      utterances: [
        {
          id: 'utt-1',
          text: 'We validated the parity gate earlier today.',
          createdAt: 1758800000000,
          dateStr: '2026-09-25',
        },
      ],
      adoptedFacts: ['Porto is the birthplace of Milo’s creator.'],
    },
  };

  const recall1 = recallCharacterData(options);
  const recall2 = recallCharacterData(options);

  // Determinism
  assert.equal(recall1.data, recall2.data);
  assert.deepEqual(recall1.recalledIds, recall2.recalledIds);

  // Wrapper tag and heading
  assert(recall1.data.startsWith(CHARACTER_DATA_TAG_OPEN));
  assert(recall1.data.endsWith(CHARACTER_DATA_TAG_CLOSE));
  assert(recall1.data.includes(CHARACTER_DATA_HEADING));

  // Provenance labels
  assert(recall1.data.includes('[approved]'));
  assert(recall1.data.includes('[verified]'));
  assert(recall1.data.includes('[said on 2026-09-25]'));
  assert(recall1.data.includes('@alice'));
  assert(recall1.data.includes('Memory safety prevents whole classes of runtime bugs.'));
  assert(recall1.data.includes('Uses SQLite in WAL mode'));
  assert(recall1.data.includes('Porto is the birthplace'));
});

test('expired focus and absent journals add no data', () => {
  const doc = createSampleRecallDocument();

  // Test current focus filtering as of 2026-09-25
  const resultCurrent = recallCharacterData({
    document: doc,
    surface: 'public-compose',
    asOf: '2026-09-25T12:00:00.000Z',
  });
  assert(resultCurrent.data.includes('Stabilizing Phase 1 character layer implementation.'));
  assert(!resultCurrent.data.includes('Preparing initial architectural design document.')); // expired

  // If focus expired (asOf is October 2026)
  const resultLate = recallCharacterData({
    document: doc,
    surface: 'public-compose',
    asOf: '2026-10-15T12:00:00.000Z',
  });
  assert(!resultLate.data.includes('Stabilizing Phase 1'));
  assert(!resultLate.data.includes('Preparing initial architectural'));

  // Absent journals add no extra data
  const resultNoJournals = recallCharacterData({
    document: doc,
    surface: 'owner-chat',
    query: 'Simple hello message without keywords',
    asOf: '2026-09-25T12:00:00.000Z',
    records: {}, // empty
  });
  assert(!resultNoJournals.data.includes('[said on'));
});

test('selection omits whole oversized items and reports why', () => {
  const doc = createSampleRecallDocument();

  // Add huge background fact item > 300 chars
  doc.backgroundFacts.push({
    id: 'bg-oversized',
    keys: ['huge'],
    text: 'A'.repeat(350), // exceeds 300-char single item limit
    provenance: 'verified',
    always: true,
  });

  const recall = recallCharacterData({
    document: doc,
    surface: 'owner-chat',
    query: 'huge',
  });

  // Must omit the entire oversized item, not truncate it mid-text
  assert(!recall.data.includes('A'.repeat(300)));
  assert(recall.omissions.some((o: string) => o.includes('bg-oversized')));

  // Test deterministic example selection for public-compose
  const selectedExamples = selectComposeExamples(
    doc.voice.examples,
    'post',
    'en',
    'safety and testing',
    'seed-xyz',
    600,
  );
  assert(selectedExamples.examples.length >= 1);
  assert(selectedExamples.totalChars <= 600);
});
