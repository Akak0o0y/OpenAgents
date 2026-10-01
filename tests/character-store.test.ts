import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CharacterStore } from '../src/daemon/character-store.js';
import {
  CharacterConflictError,
  CharacterNotFoundError,
  CharacterInvalidError,
  createDefaultCharacterDocument,
  type CharacterDocument,
  type CharacterSettings,
} from '../src/daemon/character-schema.js';

function createTempDb(): { store: AgentStore; charStore: CharacterStore; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-char-store-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const store = new AgentStore(dbPath);
  const charStore = new CharacterStore(store);

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  return { store, charStore, cleanup };
}

function makeValidCharacterDoc(): CharacterDocument {
  const doc = createDefaultCharacterDocument('Milo');
  doc.identity.oneLine = 'A careful release assistant.';
  doc.purpose.statement = 'Help the engineering team ship reliable software without breaking parity.';
  doc.purpose.topics = ['TypeScript', 'Testing', 'Safety'];
  doc.voice.examples = [
    {
      id: 'ex-1',
      text: 'Tests are passing cleanly.',
      surface: 'chat',
      pinned: true,
      tags: ['status'],
      origin: 'owner',
    },
    {
      id: 'ex-2',
      text: 'Please check the build logs before deploying.',
      surface: 'chat',
      pinned: false,
      tags: ['advice'],
      origin: 'owner',
    },
    {
      id: 'ex-3',
      text: 'Parity baseline is preserved.',
      surface: 'chat',
      pinned: false,
      tags: ['baseline'],
      origin: 'owner',
    },
  ];
  doc.commitments = [
    {
      id: 'comm-1',
      topic: 'Parity',
      stance: 'Preserve existing behavior unconditionally.',
      importance: 'core',
      certainty: 'high',
      keywords: ['parity'],
    },
  ];
  return doc;
}

test('save uses compare-and-swap and leaves no rows on conflict', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-1',
      name: 'Milo',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
      system_prompt: 'Original job description',
    });

    // 1. Initial save with baseVersion = 0
    const v1 = charStore.save('bot-1', 0, {
      document: { identity: { name: 'Milo', oneLine: 'Helper.' } },
      settings: { mode: 'off' },
      note: 'Initial draft',
    });

    assert.equal(v1.version, 1);
    assert.equal(v1.agent_id, 'bot-1');
    assert.equal(v1.mode, 'off');
    assert.equal(v1.origin, 'studio');

    // 2. Conflict: saving with stale baseVersion = 0 throws CharacterConflictError
    assert.throws(
      () => {
        charStore.save('bot-1', 0, {
          document: { identity: { name: 'Stale update' } },
        });
      },
      (err: any) => {
        assert.ok(err instanceof CharacterConflictError);
        assert.equal(err.code, 'CharacterConflict');
        assert.equal(err.status, 409);
        assert.equal(err.currentVersion, 1);
        return true;
      }
    );

    // Verify only 1 version exists
    const history = charStore.getHistory('bot-1');
    assert.equal(history.length, 1);

    // 3. Save v2 with correct baseVersion = 1
    const v2 = charStore.save('bot-1', 1, {
      document: { identity: { name: 'Milo V2' } },
      note: 'Second version',
    });
    assert.equal(v2.version, 2);

    // 4. Test two store clients on the same DB race condition
    const dbPath = (store as any).db.name;
    if (dbPath && dbPath !== ':memory:') {
      const store2 = new AgentStore(dbPath);
      const charStore2 = new CharacterStore(store2);

      // Client 1 saves v3
      charStore.save('bot-1', 2, { note: 'v3 by client 1' });

      // Client 2 attempts save with stale baseVersion = 2
      assert.throws(
        () => {
          charStore2.save('bot-1', 2, { note: 'stale by client 2' });
        },
        (err: any) => err instanceof CharacterConflictError
      );
    }

    // Verify agents.system_prompt was not mutated
    const agent = store.getAgent('bot-1');
    assert.equal(agent?.system_prompt, 'Original job description');
  } finally {
    cleanup();
  }
});

test('revert creates a new version without rewriting history', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-revert',
      name: 'Milo',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });

    // v1: Off
    const v1 = charStore.save('bot-revert', 0, {
      document: { identity: { name: 'Milo v1', oneLine: 'Initial' } },
      settings: { mode: 'off' },
    });

    // v2: Character mode
    const v2 = charStore.save('bot-revert', 1, {
      document: makeValidCharacterDoc(),
      settings: { mode: 'character' },
    });

    // v3: Off again
    const v3 = charStore.save('bot-revert', 2, {
      settings: { mode: 'off' },
    });

    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.equal(v3.version, 3);

    // Revert to v2 (which was Character mode)
    const v4 = charStore.revert('bot-revert', 3, 2, 'Reverting to v2 character mode');
    assert.equal(v4.version, 4);
    assert.equal(v4.mode, 'character');
    assert.equal(v4.origin, 'revert:2');
    assert.equal(v4.note, 'Reverting to v2 character mode');
    assert.equal(v4.document.identity.name, 'Milo');

    // Verify all 4 versions exist monotonically
    const history = charStore.getHistory('bot-revert');
    assert.equal(history.length, 4);
    assert.deepEqual(history.map((h: any) => h.version), [4, 3, 2, 1]);

    // Revert to non-existent version throws CharacterNotFoundError
    assert.throws(
      () => {
        charStore.revert('bot-revert', 4, 99);
      },
      (err: any) => {
        assert.ok(err instanceof CharacterNotFoundError);
        assert.equal(err.code, 'CharacterNotFound');
        assert.equal(err.status, 404);
        return true;
      }
    );

    // Revert with stale baseVersion throws CharacterConflictError
    assert.throws(
      () => {
        charStore.revert('bot-revert', 2, 1);
      },
      (err: any) => err instanceof CharacterConflictError
    );
  } finally {
    cleanup();
  }
});

test('partial saves preserve hidden fields and explicit arrays replace', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-partial',
      name: 'Milo',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });

    // Save v1 with biography and purpose topics
    const v1 = charStore.save('bot-partial', 0, {
      document: {
        identity: { name: 'Milo', oneLine: 'Initial' },
        biography: [
          { id: 'bio-1', text: 'Born in a lab.', provenance: 'owner-attested', salient: true },
          { id: 'bio-2', text: 'Loves clean architecture.', provenance: 'owner-attested', salient: true },
        ],
        purpose: {
          statement: 'Testing partial updates.',
          topics: ['Alpha', 'Beta'],
        },
      },
      settings: { mode: 'off' },
    });

    assert.equal(v1.document.biography?.length, 2);
    assert.deepEqual(v1.document.purpose?.topics, ['Alpha', 'Beta']);

    // Partial save updating only identity name and purpose topics
    const v2 = charStore.save('bot-partial', 1, {
      document: {
        identity: { name: 'Milo Modified' },
        purpose: { topics: ['Gamma'] },
      },
    });

    // Hidden field `biography` is preserved!
    assert.deepEqual(v2.document.biography, [
      { id: 'bio-1', text: 'Born in a lab.', provenance: 'owner-attested', salient: true },
      { id: 'bio-2', text: 'Loves clean architecture.', provenance: 'owner-attested', salient: true },
    ]);
    // Identity name was updated
    assert.equal(v2.document.identity.name, 'Milo Modified');
    // Explicit array was replaced, not merged into ['Alpha', 'Beta', 'Gamma']
    assert.deepEqual(v2.document.purpose?.topics, ['Gamma']);
  } finally {
    cleanup();
  }
});

test('source handles resolve atomically and cannot cross bots', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-src-1',
      name: 'Bot 1',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });
    store.createAgent({
      id: 'bot-src-2',
      name: 'Bot 2',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });

    // Save with draft source handle
    const v1 = charStore.save('bot-src-1', 0, {
      document: {
        identity: { name: 'Bot 1' },
        voice: {
          examples: [
            {
              id: 'ex-1',
              text: 'This is sample sentence for Bot 1.',
              surface: 'post',
              pinned: true,
              tags: ['intro'],
              origin: 'owner',
              sourceId: 'draft:sample-1',
            },
          ],
        },
      },
      settings: { mode: 'off' },
      sources: [
        {
          handle: 'draft:sample-1',
          kind: 'sample',
          text: 'This is sample sentence for Bot 1.',
        },
      ],
    });

    // The handle was resolved to an allocated server ID (src-...)
    const allocatedId = v1.document.voice?.examples?.[0]?.sourceId;
    assert.ok(allocatedId);
    assert.match(allocatedId, /^src-/);
    assert.notEqual(allocatedId, 'draft:sample-1');

    // The source exists in the DB
    const source = charStore.getSource('bot-src-1', allocatedId);
    assert.ok(source);
    assert.equal(source.text, 'This is sample sentence for Bot 1.');
    assert.equal(source.kind, 'sample');
    assert.equal(source.agent_id, 'bot-src-1');

    // Attempting to reference Bot 1's source from Bot 2 throws CharacterInvalidError
    assert.throws(
      () => {
        charStore.save('bot-src-2', 0, {
          document: {
            identity: { name: 'Bot 2' },
            voice: {
              examples: [
                {
                  id: 'ex-foreign',
                  text: 'Foreign example',
                  surface: 'post',
                  pinned: false,
                  tags: [],
                  origin: 'owner',
                  sourceId: allocatedId,
                },
              ],
            },
          },
          settings: { mode: 'off' },
        });
      },
      (err: any) => {
        assert.ok(err instanceof CharacterInvalidError);
        assert.ok(err.issues.some((i: string) => i.includes('Source not found or belongs to another bot')));
        return true;
      }
    );

    // Bot 2 has no versions created due to rollback
    assert.equal(charStore.getHistory('bot-src-2').length, 0);
  } finally {
    cleanup();
  }
});

test('description-original is stored verbatim beyond 4000 characters', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-desc',
      name: 'Bot Desc',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });

    const longText = 'A'.repeat(4500);

    // 1. description-original can exceed 4000 chars
    const v1 = charStore.save('bot-desc', 0, {
      document: { identity: { name: 'Bot Desc' } },
      settings: { mode: 'off' },
      sources: [
        {
          handle: 'draft:orig-desc',
          kind: 'description-original',
          text: longText,
        },
      ],
    });

    const sources = charStore.getSources('bot-desc', 'description-original');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].text.length, 4500);

    // 2. Normal sample > 4000 chars is rejected
    assert.throws(
      () => {
        charStore.save('bot-desc', 1, {
          sources: [
            {
              handle: 'draft:too-long-sample',
              kind: 'sample',
              text: 'B'.repeat(4001),
            },
          ],
        });
      },
      (err: any) => {
        assert.ok(err instanceof CharacterInvalidError);
        assert.ok(err.issues.some((i: string) => i.includes('4000')));
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('deleting a bot cascades both character tables', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-cascade',
      name: 'Bot Cascade',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });

    charStore.save('bot-cascade', 0, {
      document: {
        identity: { name: 'Bot Cascade' },
        voice: {
          examples: [
            {
              id: 'ex-1',
              text: 'Sample for cascade',
              surface: 'post',
              pinned: false,
              tags: [],
              origin: 'owner',
              sourceId: 'draft:s1',
            },
          ],
        },
      },
      settings: { mode: 'off' },
      sources: [{ handle: 'draft:s1', kind: 'sample', text: 'Sample for cascade' }],
    });

    const db = store.getDatabase();
    const vCount = db.prepare('SELECT COUNT(*) as c FROM bot_character_versions WHERE agent_id = ?').get('bot-cascade') as { c: number };
    const sCount = db.prepare('SELECT COUNT(*) as c FROM bot_character_sources WHERE agent_id = ?').get('bot-cascade') as { c: number };

    assert.equal(vCount.c, 1);
    assert.equal(sCount.c, 1);

    // Delete agent using AgentStore
    store.deleteAgent('bot-cascade');

    // Both tables cascaded
    const vCountAfter = db.prepare('SELECT COUNT(*) as c FROM bot_character_versions WHERE agent_id = ?').get('bot-cascade') as { c: number };
    const sCountAfter = db.prepare('SELECT COUNT(*) as c FROM bot_character_sources WHERE agent_id = ?').get('bot-cascade') as { c: number };

    assert.equal(vCountAfter.c, 0);
    assert.equal(sCountAfter.c, 0);
  } finally {
    cleanup();
  }
});
