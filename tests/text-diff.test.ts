/**
 * Unified diffs for reviewable repository changes. A minimal applier in this test proves each patch reproduces the
 * changed files exactly, including files without a final newline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff, type FileChange } from '../src/daemon/text-diff.js';

/** Applies unified-diff hunks to one file's text. Throws when context does not match. */
function apply(before: string | null, patch: string, path: string): string | null {
  const section = patch.split(/^diff --git /m).find(part => part.startsWith(`a/${path} b/${path}\n`));
  if (!section) return before;
  if (section.includes('\n+++ /dev/null\n')) return null;
  const source = before === null || before === '' ? [] : before.split('\n');
  const sourceHasFinalNewline = before !== null && before.endsWith('\n');
  if (sourceHasFinalNewline) source.pop();
  const result: string[] = [];
  let cursor = 0, finalNewline = sourceHasFinalNewline || before === null;
  const body = section.split('\n');
  for (let i = 0; i < body.length; i++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(body[i]);
    if (!header) continue;
    const oldStart = Number(header[1]), oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const startIndex = oldCount === 0 ? oldStart : oldStart - 1;
    while (cursor < startIndex) result.push(source[cursor++]);
    for (i++; i < body.length && !body[i].startsWith('@@'); i++) {
      const line = body[i];
      if (line === '\\ No newline at end of file') { if (body[i - 1].startsWith('+') || body[i - 1].startsWith(' ')) finalNewline = false; continue; }
      const op = line[0], text = line.slice(1);
      if (op === ' ') { assert.equal(source[cursor], text, `context mismatch in ${path}`); result.push(source[cursor++]); finalNewline = true; }
      else if (op === '-') { assert.equal(source[cursor], text, `removal mismatch in ${path}`); cursor++; }
      else if (op === '+') { result.push(text); finalNewline = true; }
    }
    i--;
  }
  while (cursor < source.length) { result.push(source[cursor++]); finalNewline = sourceHasFinalNewline; }
  return result.length ? result.join('\n') + (finalNewline ? '\n' : '') : '';
}

test('a modified file produces a standard unified diff with context and correct hunk ranges', () => {
  const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n') + '\n';
  const after = ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'].join('\n') + '\n';
  const patch = unifiedDiff([{ path: 'src/count.txt', before, after }]);
  assert.equal(patch, [
    'diff --git a/src/count.txt b/src/count.txt', '--- a/src/count.txt', '+++ b/src/count.txt',
    '@@ -1,6 +1,6 @@', ' one', ' two', '-three', '+THREE', ' four', ' five', ' six',
    '@@ -8,3 +8,4 @@', ' eight', ' nine', ' ten', '+eleven', ''].join('\n'));
  assert.equal(apply(before, patch, 'src/count.txt'), after);
});

test('new, deleted, unchanged and newline-only changes are represented exactly', () => {
  const changes: FileChange[] = [
    { path: 'README.md', before: '# Title\nold text\n', after: '# Title\nnew text\n' },
    { path: 'src/new.js', before: null, after: 'export const created = true;\n' },
    { path: 'src/old.js', before: 'module.exports = 1;\n', after: null },
    { path: 'same.txt', before: 'unchanged\n', after: 'unchanged\n' },
    { path: 'no-newline.txt', before: 'a\nb\n', after: 'a\nb' },
  ];
  const patch = unifiedDiff(changes);
  assert.doesNotMatch(patch, /same\.txt/);
  assert.match(patch, /diff --git a\/src\/new\.js b\/src\/new\.js\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/src\/new\.js\n@@ -0,0 \+1 @@\n\+export const created = true;\n/);
  assert.match(patch, /diff --git a\/src\/old\.js b\/src\/old\.js\ndeleted file mode 100644\n--- a\/src\/old\.js\n\+\+\+ \/dev\/null\n@@ -1 \+0,0 @@\n-module\.exports = 1;\n/);
  assert.match(patch, /-b\n\+b\n\\ No newline at end of file\n/);
  assert.ok(patch.indexOf('README.md') < patch.indexOf('no-newline.txt') && patch.indexOf('no-newline.txt') < patch.indexOf('src/new.js'), 'files are sorted by path');
  for (const change of changes) assert.equal(apply(change.before, patch, change.path), change.after, change.path);
});

test('generated edits round-trip through the patch for many random files', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', ''];
  for (let round = 0; round < 60; round++) {
    const base = Array.from({ length: Math.floor(random() * 40) }, () => words[Math.floor(random() * words.length)]);
    const edited = base.flatMap(line => { const r = random(); return r < 0.1 ? [] : r < 0.2 ? [line, `inserted ${round}`] : r < 0.3 ? [`changed ${line}`] : [line]; });
    if (random() < 0.3) edited.push('tail');
    const before = base.length ? base.join('\n') + (random() < 0.8 ? '\n' : '') : '';
    const after = edited.length ? edited.join('\n') + (random() < 0.8 ? '\n' : '') : '';
    const patch = unifiedDiff([{ path: 'file.txt', before, after }]);
    if (before === after) { assert.equal(patch, ''); continue; }
    assert.equal(apply(before, patch, 'file.txt'), after, `round ${round}`);
  }
});

test('whole-file replacement stays correct when a change is too large to minimise', () => {
  const before = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join('\n') + '\n';
  const after = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n') + '\n';
  const patch = unifiedDiff([{ path: 'big.txt', before, after }]);
  assert.equal(apply(before, patch, 'big.txt'), after);
  assert.throws(() => unifiedDiff([{ path: 'huge.txt', before: 'x\n'.repeat(20_001), after: 'y\n' }]), /exceeds 20000 lines/);
});
