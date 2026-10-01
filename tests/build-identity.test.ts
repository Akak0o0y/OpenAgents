/**
 * A display version such as 0.4.4 is reused across builds, so support and upgrade decisions
 * need an identity derived from the implementation that is actually loaded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIdentity, packageRoot } from '../src/daemon/build-identity.js';

function fakeBuild(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-build-identity-'));
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return root;
}

test('build identity distinguishes implementations that share a display version', () => {
  const version = JSON.stringify({ version: '0.4.4' });
  const a = fakeBuild({ 'package.json': version, 'dist/src/daemon/index.js': 'console.log(1)', 'web/dist/index.html': '<html>a</html>' });
  const b = fakeBuild({ 'package.json': version, 'dist/src/daemon/index.js': 'console.log(2)', 'web/dist/index.html': '<html>a</html>' });
  const uiOnly = fakeBuild({ 'package.json': version, 'dist/src/daemon/index.js': 'console.log(1)', 'web/dist/index.html': '<html>b</html>' });
  try {
    assert.equal(buildIdentity(a), buildIdentity(a), 'an unchanged build keeps one identity');
    assert.notEqual(buildIdentity(a), buildIdentity(b), 'different daemon code is a different build despite the same version');
    assert.notEqual(buildIdentity(a), buildIdentity(uiOnly), 'a changed UI bundle is also a different build');
    assert.match(buildIdentity(a), /^[a-f0-9]{16}$/, 'the identity is short and printable for diagnostics');
    const partial = fakeBuild({ 'package.json': version });
    assert.match(buildIdentity(partial), /^[a-f0-9]{16}$/, 'a partial installation is reported, not thrown');
    assert.notEqual(buildIdentity(partial), buildIdentity(a), 'missing implementation files are not treated as matching');
  } finally { for (const root of [a, b, uiOnly]) fs.rmSync(root, { recursive: true, force: true }); }
});

test('the running daemon reports an identity for its own package root', () => {
  assert.ok(fs.existsSync(path.join(packageRoot(), 'package.json')), 'package root resolves to the installed app');
  assert.match(buildIdentity(), /^[a-f0-9]{16}$/);
});
