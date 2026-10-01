import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const script = path.resolve('scripts/character-probes.mjs');

test('v1 probes are reproducible and label long histories as scripted evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'character-probes-'));
  try {
    for (const suffix of ['a', 'b']) await run(process.execPath, [script, '--out', path.join(root, suffix)]);
    const first = await readFile(path.join(root, 'a', 'probes.json'), 'utf8');
    assert.equal(first, await readFile(path.join(root, 'b', 'probes.json'), 'utf8'));
    const evidence = JSON.parse(first);
    assert.equal(evidence.realProviderCalls, 0);
    assert.deepEqual(evidence.histories.map((h: any) => h.priorTurns), [8, 40, 80]);
    assert.ok(evidence.histories.every((h: any) => h.identityPreserved && h.logicalCalls > 0));
    assert.match(evidence.limitations.join(' '), /model quality/);
    assert.ok(evidence.packets.every((p: any) => p.stableChars <= p.stableLimit));
    assert.equal(first.includes('\r'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('probe writer refuses profile paths and preserves unowned output files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'character-probes-'));
  try {
    await writeFile(path.join(root, 'keep.txt'), 'preserve');
    await assert.rejects(run(process.execPath, [script, '--out', root]));
    assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'preserve');
    await assert.rejects(run(process.execPath, [script, '--out', path.join(root, 'AppData', 'Roaming', 'OpenHours')]));
    await assert.rejects(run(process.execPath, [script, '--profile', 'real']));
  } finally { await rm(root, { recursive: true, force: true }); }
});
