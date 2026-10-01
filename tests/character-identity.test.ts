import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStore } from '../src/daemon/agent-store.js';
import {
  CharacterStore,
  resolveExecutionSurface,
  type CharacterIdentityResult,
  type CharacterIdentityOptions,
} from '../src/daemon/character-store.js';
import {
  createDefaultCharacterDocument,
  CharacterInvalidError,
  type CharacterDocument,
} from '../src/daemon/character-schema.js';

function createTempDb(): { store: AgentStore; charStore: CharacterStore; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-char-identity-test-'));
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

function makeValidCharacterDoc(name = 'Milo'): CharacterDocument {
  const doc = createDefaultCharacterDocument(name);
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

test('surface precedence excludes routines missions delegation background and code from owner identity', () => {
  // 1. Code: contract kind is 'code'
  assert.equal(
    resolveExecutionSurface({ contract: { kind: 'code' }, conversation: true }),
    'code'
  );

  // 1b. Code: missing contract kind (runtime treats absent kind as code)
  assert.equal(
    resolveExecutionSurface({ contract: {}, conversation: true }),
    'code'
  );

  // 1c. Code: contract.repository is set
  assert.equal(
    resolveExecutionSurface({
      contract: { kind: 'report', repository: { owner: 'o', repo: 'r' } },
      conversation: true,
    }),
    'code'
  );

  // 2. Routine: durable run.routine_id
  assert.equal(
    resolveExecutionSurface({
      contract: { kind: 'report' },
      run: { routine_id: 'routine-123' },
      conversation: true,
    }),
    'task-loop'
  );

  // 2b. Routine: scheduled.routineId
  assert.equal(
    resolveExecutionSurface({
      contract: { kind: 'report' },
      scheduled: { routineId: 'routine-456' },
      conversation: true,
    }),
    'task-loop'
  );

  // 3. Mission: input.mission
  assert.equal(
    resolveExecutionSurface({
      contract: { kind: 'report' },
      mission: true,
      conversation: true,
    }),
    'task-loop'
  );

  // 4. Delegated: delegationDepth >= 2
  assert.equal(
    resolveExecutionSurface({
      contract: { kind: 'report' },
      delegationDepth: 2,
      conversation: true,
    }),
    'task-loop'
  );

  // 4b. Background: input.background
  assert.equal(
    resolveExecutionSurface({
      contract: { kind: 'report' },
      background: true,
      conversation: true,
    }),
    'task-loop'
  );

  // 5. Owner chat: conversation with no higher precedence match
  assert.equal(
    resolveExecutionSurface({
      contract: { kind: 'report' },
      conversation: true,
    }),
    'owner-chat'
  );

  // 6. Anything else
  assert.equal(resolveExecutionSurface({}), 'task-loop');
});

test('off performs one indexed lookup and no recall or compile', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-off-perf',
      name: 'Milo',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
      system_prompt: 'My job description',
    });

    // Save with mode: 'off'
    charStore.save('bot-off-perf', 0, {
      document: { identity: { name: 'Milo Draft' } },
      settings: { mode: 'off' },
    });

    const db = (store as any).db;
    let queryCount = 0;
    const origPrepare = db.prepare.bind(db);
    db.prepare = function (sql: string, ...args: any[]) {
      if (sql.includes('bot_character_versions')) {
        queryCount++;
      }
      return origPrepare(sql, ...args);
    };

    const res = charStore.identityFor(
      { id: 'bot-off-perf', system_prompt: 'My job description' },
      { conversation: true, fallback: 'Fallback' }
    );

    assert.equal(queryCount, 1, 'off performs exactly one indexed lookup');
    assert.equal(res.meta, null, 'meta must be null on Off');
    assert.equal(res.data, '', 'data must be empty on Off');
    assert.equal(res.stable, 'My job description', 'stable must be exact fallback/description');
  } finally {
    cleanup();
  }
});

test('identity preserves each caller fallback including an empty Description', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-enabled',
      name: 'Milo',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
    });

    charStore.save('bot-enabled', 0, {
      document: makeValidCharacterDoc('Milo'),
      settings: { mode: 'character' },
    });

    // 1. Off bot with null system_prompt uses caller fallback
    const offNullRes = charStore.identityFor(
      { id: 'bot-nonexistent', system_prompt: null },
      { conversation: true, fallback: 'Custom Fallback Text' }
    );
    assert.equal(offNullRes.stable, 'Custom Fallback Text');
    assert.equal(offNullRes.meta, null);

    // 2. Off bot with empty string system_prompt preserves empty string
    const offEmptyRes = charStore.identityFor(
      { id: 'bot-nonexistent', system_prompt: '' },
      { conversation: true, fallback: 'Custom Fallback Text' }
    );
    assert.equal(offEmptyRes.stable, '');
    assert.equal(offEmptyRes.meta, null);

    // 3. Enabled bot with null system_prompt returns card without "Your job" line
    const enabledNullRes = charStore.identityFor(
      { id: 'bot-enabled', system_prompt: null },
      { conversation: true, fallback: 'Custom Fallback Text', asOf: '2026-09-25T10:00:00.000Z' }
    );
    assert.ok(enabledNullRes.stable.includes('The owner, your job and runtime rules outrank this character.'));
    assert.ok(!enabledNullRes.stable.includes("Your job (the owner's Description):"));
    assert.ok(enabledNullRes.meta !== null);
    assert.equal(enabledNullRes.meta?.mode, 'character');

    // 4. Enabled bot with non-empty system_prompt appends "Your job" line
    const enabledWithDesc = charStore.identityFor(
      { id: 'bot-enabled', system_prompt: 'You are responsible for deployments.' },
      { conversation: true, asOf: '2026-09-25T10:00:00.000Z' }
    );
    assert.ok(enabledWithDesc.stable.includes("Your job (the owner's Description):\nYou are responsible for deployments."));
    assert.ok(enabledWithDesc.meta !== null);
  } finally {
    cleanup();
  }
});

test('a run retains its captured version after a save', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-pin',
      name: 'Milo',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
      system_prompt: 'Job description',
    });

    // Version 1
    charStore.save('bot-pin', 0, {
      document: makeValidCharacterDoc('Milo V1'),
      settings: { mode: 'character' },
    });

    // Run starts, captures identity
    const runIdentity = charStore.identityFor(
      { id: 'bot-pin', system_prompt: 'Job description' },
      { conversation: true, asOf: '2026-09-25T10:00:00.000Z' }
    );
    assert.equal(runIdentity.meta?.version, 1);
    assert.ok(runIdentity.stable.includes('Milo V1'));

    // Save Version 2
    charStore.save('bot-pin', 1, {
      document: makeValidCharacterDoc('Milo V2'),
      settings: { mode: 'character' },
    });

    // Run continues with pinned version: 1
    const pinnedIdentity = charStore.identityFor(
      { id: 'bot-pin', system_prompt: 'Job description' },
      { conversation: true, version: 1, asOf: '2026-09-25T10:00:00.000Z' }
    );
    assert.equal(pinnedIdentity.meta?.version, 1);
    assert.ok(pinnedIdentity.stable.includes('Milo V1'));

    // New run sees version 2
    const newRunIdentity = charStore.identityFor(
      { id: 'bot-pin', system_prompt: 'Job description' },
      { conversation: true, asOf: '2026-09-25T10:00:00.000Z' }
    );
    assert.equal(newRunIdentity.meta?.version, 2);
    assert.ok(newRunIdentity.stable.includes('Milo V2'));
  } finally {
    cleanup();
  }
});

test('ownerChat task uses the task packet and ownerChat off remains Off', () => {
  const { store, charStore, cleanup } = createTempDb();
  try {
    store.createAgent({
      id: 'bot-surfaces',
      name: 'Milo',
      model_id: 'claude-haiku-4-5',
      budget_cap_usd: 10,
      current_status: 'IDLE',
      system_prompt: 'Base Job',
    });

    // 1. ownerChat: 'task'
    charStore.save('bot-surfaces', 0, {
      document: makeValidCharacterDoc('Milo'),
      settings: { mode: 'character', surfaces: { ownerChat: 'task' } },
    });

    const taskRes = charStore.identityFor(
      { id: 'bot-surfaces', system_prompt: 'Base Job' },
      { conversation: true }
    );
    assert.equal(taskRes.meta?.surface, 'task-loop');
    assert.equal(taskRes.data, '');
    assert.ok(taskRes.stable.includes('prepare_post'));
    assert.ok(taskRes.stable.endsWith('Base Job'));

    // 2. ownerChat: 'off'
    charStore.save('bot-surfaces', 1, {
      settings: { surfaces: { ownerChat: 'off' } },
    });

    const offRes = charStore.identityFor(
      { id: 'bot-surfaces', system_prompt: 'Base Job' },
      { conversation: true }
    );
    assert.equal(offRes.meta, null, 'ownerChat off resolves as Off in Phase 1');
    assert.equal(offRes.data, '');
    assert.equal(offRes.stable, 'Base Job');

    // 3. Unknown future schema raises a typed error
    const db = (store as any).db;
    db.prepare(
      "UPDATE bot_character_versions SET document_json = json_set(document_json, '$.schema', 'openhours.character/999') WHERE agent_id = 'bot-surfaces' AND version = 2"
    ).run();

    assert.throws(
      () => {
        charStore.identityFor(
          { id: 'bot-surfaces', system_prompt: 'Base Job' },
          { conversation: true, version: 2 }
        );
      },
      (err: any) => err instanceof CharacterInvalidError
    );
  } finally {
    cleanup();
  }
});
