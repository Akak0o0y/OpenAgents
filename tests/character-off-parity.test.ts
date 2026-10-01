/**
 * The character layer's Off parity gate (spec §6.1 and §17.1): a bot with no character, and a bot whose
 * latest character version is off, send exactly what they sent before the feature existed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentStore } from '../src/daemon/agent-store.js';
import {
  AGENT_ID, BASELINE_CASE_COUNT, BASELINE_DIR, FIXED_TIME, VOLATILE_FIELDS,
  assertParity, captureOffBaseline, compareBaseline, decodedFixtureStrings, lfSha256, normalizeCase, readBaseline,
  sourceHashMismatches, type BaselineCase,
} from './helpers/character-harness.js';

import { CharacterStore } from '../src/daemon/character-store.js';

/**
 * Task 4 real store save holding an enabled or draft version followed by
 * an off one. Nothing reads these rows yet; Task 5 proves the indexed Off path.
 */
function seedLatestOff(store: AgentStore): void {
  const charStore = new CharacterStore(store);
  const sample = 'Milo writes short, checked sentences.';
  charStore.save(AGENT_ID, 0, {
    document: {
      identity: { name: 'Milo', oneLine: 'A careful release assistant.' },
      voice: {
        examples: [
          {
            id: 'ex-1',
            text: sample,
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
    sources: [{ handle: 'draft:s1', kind: 'sample', text: sample }],
    note: 'Task 4 real store save v1',
  });
  charStore.save(AGENT_ID, 1, {
    settings: { mode: 'off' },
    note: 'Task 4 real store save v2 (latest is off)',
  });
  const latest = charStore.getLatestVersion(AGENT_ID);
  assert.ok(latest);
  assert.equal(latest.mode, 'off', 'the seeded latest version is off');
}

test('no-character requests match the pre-feature baseline', async () => {
  const { manifest, cases } = readBaseline(BASELINE_DIR);
  assert.equal(cases.length, BASELINE_CASE_COUNT, 'the baseline holds every case of the matrix');
  assert.match(manifest.baselineCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.normalization, VOLATILE_FIELDS, 'the baseline was recorded with exactly the current allowlist');
  const captured = await captureOffBaseline();
  assert.equal(captured.length, BASELINE_CASE_COUNT);
  assertParity(cases, captured);
});

test('latest-off requests match the same baseline', async () => {
  const { cases } = readBaseline(BASELINE_DIR);
  const seeded: string[] = [];
  const captured = await captureOffBaseline({ prepare: ({ store, caseId }) => { seedLatestOff(store); seeded.push(caseId); } });
  assert.deepEqual(seeded, captured.map(record => record.id), 'every case ran against a database holding a latest-off version');
  assertParity(cases, captured);
});

test('parity comparator rejects changes outside the volatility allowlist', () => {
  const { cases } = readBaseline(BASELINE_DIR);
  const target = cases.find(record => record.id === 'work-runtime.owner-chat.chat-service.full.native.supplied');
  assert.ok(target, 'baseline has the full owner-chat case');
  const index = cases.indexOf(target);
  const mutate = (change: (record: BaselineCase) => void): BaselineCase[] => {
    const copy = structuredClone(cases);
    change(copy[index]);
    return copy;
  };
  const request = (record: BaselineCase) => record.requests[0] as { systemPrompt: string; tools: Array<{ description: string }>; messages: Array<{ content: string }> };
  const rejects = (label: string, aspect: string, change: (record: BaselineCase) => void) => {
    const differences = compareBaseline(cases, mutate(change));
    assert.ok(differences.length > 0, `${label} must fail the comparator`);
    assert.ok(differences.every(d => d.caseId === target.id), `${label} is reported against its own case`);
    assert.ok(differences.some(d => d.aspect === aspect), `${label} is reported as ${aspect}: ${JSON.stringify(differences)}`);
  };

  assert.deepEqual(compareBaseline(cases, structuredClone(cases)), [], 'an identical capture has parity');
  rejects('a changed tool definition', 'tool definitions', record => { request(record).tools[3].description += '.'; });
  rejects('an extra tool definition', 'tool definitions', record => { request(record).tools.push({ description: 'propose_character' }); });
  rejects('one changed system-prompt byte', 'system text (including embedded guidance)', record => {
    const at = request(record).systemPrompt.indexOf('Current runtime snapshot');
    request(record).systemPrompt = `${request(record).systemPrompt.slice(0, at)}current${request(record).systemPrompt.slice(at + 7)}`;
  });
  rejects('one changed first-message byte', 'first message', record => {
    const first = request(record).messages[0];
    first.content = first.content.replace('Request:', 'Request;');
  });
  rejects('an added PROMPT_ASSEMBLED property', 'PROMPT_ASSEMBLED payload', record => {
    (record.promptAssembled[0] as Record<string, unknown>).character = { mode: 'off' };
  });
  rejects('an added request field', 'request fields', record => { (record.requests[0] as Record<string, unknown>).character = null; });
  rejects('an extra model call', 'logical call count', record => { record.logicalCalls += 1; });
  rejects('an extra event', 'event types', record => { record.eventTypes.push('CHARACTER_COMPOSED'); });
  // Arbitrary timestamps and UUID-looking text are not on the allowlist.
  rejects('a timestamp outside observedAt', 'first message', record => {
    request(record).messages[0].content += ' 2026-09-25T10:00:00.000Z';
  });
  rejects('a UUID-looking string', 'system text (including embedded guidance)', record => {
    request(record).systemPrompt = request(record).systemPrompt.replace('"agentId":"alpha"', '"agentId":"0b7f3c1e-2d4a-4f6b-9c8d-1e2f3a4b5c6d"');
  });

  // The one allowlisted field: a real observedAt value compares equal to the masked baseline.
  const raw = mutate(record => { request(record).systemPrompt = request(record).systemPrompt.replace('"observedAt":"<masked:observedAt>"', '"observedAt":"2031-07-04T12:34:56.789Z"'); });
  assert.notEqual(request(raw[index]).systemPrompt, request(target).systemPrompt);
  assert.deepEqual(compareBaseline(cases, raw), [], 'observedAt is the only normalized value');
  assert.equal(normalizeCase(raw[index]).requests[0].systemPrompt, request(target).systemPrompt);
  const missingCase = compareBaseline(cases, cases.filter(record => record !== target));
  assert.deepEqual(missingCase.map(d => [d.caseId, d.aspect]), [[target.id, 'case set']], 'a case that is no longer captured fails');
});

test('fixture strings contain no carriage returns', () => {
  const { files, strings } = decodedFixtureStrings();
  assert.ok(files.length >= BASELINE_CASE_COUNT + 1, `the baseline fixtures exist (found ${files.length} files)`);
  const withCarriageReturn = strings.filter(entry => entry.value.includes('\r'));
  assert.deepEqual(withCarriageReturn.map(entry => `${entry.file} ${entry.at}`), [], 'decoded fixture strings are LF-only (Amendment A1)');
  assert.ok(strings.some(entry => entry.value.includes('\n')), 'multiline values are present as escaped strings');
});

test('source hashes ignore checkout line endings', () => {
  const lf = 'export const a = 1;\nexport const b = 2;\n';
  assert.equal(lfSha256(lf.replace(/\n/g, '\r\n')), lfSha256(lf), 'CRLF hashes like LF');
  assert.equal(lfSha256(lf.replace(/\n/g, '\r')), lfSha256(lf), 'lone CR hashes like LF');
  assert.notEqual(lfSha256(lf.replace('1', '3')), lfSha256(lf), 'a content change still changes the hash');
  assert.notEqual(lfSha256(lf.trimEnd()), lfSha256(lf), 'a removed final newline still changes the hash');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-character-hash-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    const file = path.join(root, 'src', 'seam.ts');
    fs.writeFileSync(file, lf.replace(/\n/g, '\r\n'));
    const recorded = { 'src/seam.ts': lfSha256(lf) };
    assert.deepEqual(sourceHashMismatches(recorded, root), [], 'a CRLF checkout of the recorded source is unchanged');
    fs.writeFileSync(file, lf.replace('2', '5'));
    assert.deepEqual(sourceHashMismatches(recorded, root), ['src/seam.ts'], 'an edited source file blocks re-recording');
    fs.rmSync(file);
    assert.deepEqual(sourceHashMismatches(recorded, root), ['src/seam.ts'], 'a deleted source file blocks re-recording');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
