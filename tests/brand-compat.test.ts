import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WindowsDpapiSecretStore } from '../src/daemon/secret-store.js';

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');

// Renaming the product must not change these: saved keys, cookies, containers and character rows depend on them.
test('identifiers that existing data depends on keep their pre-rename names', () => {
  assert.match(read('src/daemon/secret-store.ts'), /GetBytes\('OpenHours provider credential v1'\)/);
  assert.match(read('src/daemon/local-auth.ts'), /SESSION_COOKIE = 'openhours_session'/);
  assert.match(read('src/daemon/ws-server.ts'), /service: 'openhours-daemon'/);
  assert.match(read('src/daemon/bot-desktop.ts'), /ownerLabel = 'openhours\.desktop\.owner', botLabel = 'openhours\.desktop\.bot'/);
  assert.match(read('src/daemon/bot-desktop.ts'), /`openhours-bot-desktop:\$\{hash/);
  assert.match(read('src/daemon/character-schema.ts'), /CHARACTER_SCHEMA_VERSION = 'openhours\.character\/1'/);
  assert.match(read('src/daemon/config-file.ts'), /DEFAULT_CONFIG_FILENAME = 'openhours\.config\.json'/);
  assert.match(read('src/daemon/attachments.ts'), /\[\[openhours-attachment:/);
  assert.match(read('web/src/lib/botProfile.ts'), /'openhours\.bot-appearance\.v1'/);
  assert.match(read('desktop/electron-builder.yml'), /^appId: dev\.openhours\.cortex\r?$/m);
  assert.match(read('desktop/src/main.mjs'), /setAppUserModelId\('dev\.openhours\.cortex'\)/);
});

// One release version everywhere, from 0.6.0 (the rename) on: the installer, the exe and the profile backup all key on it.
test('everything a person sees is named OpenAgents, and every manifest carries the same release version', () => {
  const json = (file: string) => JSON.parse(read(file));
  const root = json('package.json'), desktopPkg = json('desktop/package.json'), webPkg = json('web/package.json');
  const release = String(root.version), [major, minor] = release.split('.').map(Number);
  assert.ok(major! > 0 || minor! >= 6, `${release} predates the OpenAgents name`);
  const builder = read('desktop/electron-builder.yml');
  for (const line of ['productName: OpenAgents', 'copyright: Copyright © 2026 OpenAgents', 'shortcutName: OpenAgents',
    'uninstallDisplayName: OpenAgents ${version}', 'artifactName: OpenAgents-${version}-${os}-${arch}-${ext}',
    'artifactName: OpenAgents-${version}-portable.${ext}', 'artifactName: OpenAgents-${version}-setup.${ext}', `buildVersion: ${release}`]) {
    assert.ok(builder.includes(line), line);
  }
  assert.match(read('web/index.html'), /<title>OpenAgents<\/title>/);
  assert.deepEqual([root.productName, root.releaseVersion, root.shortVersionWindows], ['OpenAgents', release, release]);
  assert.deepEqual([desktopPkg.name, desktopPkg.version], ['openagents-desktop', release]);
  assert.deepEqual([webPkg.name, webPkg.version], ['openagents-cortex', release]);
  for (const [file, name] of [['package-lock.json', root.name], ['desktop/package-lock.json', 'openagents-desktop'], ['web/package-lock.json', 'openagents-cortex']]) {
    const lock = json(file);
    assert.deepEqual([lock.name, lock.version, lock.packages[''].name, lock.packages[''].version], [name, release, name, release], file);
  }
});

// The contract behind the entropy pin: a key saved by 0.5.0 must still unlock. The ciphertext is made the way
// 0.5.0 made it, by PowerShell directly, so the expectation does not come from the store under test.
test('a provider key protected before the rename still unlocks', { skip: process.platform !== 'win32' && 'Windows DPAPI only' }, async () => {
  const script = "Add-Type -AssemblyName System.Security; $entropy = [Text.Encoding]::UTF8.GetBytes('OpenHours provider credential v1'); "
    + '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); '
    + '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)))';
  const saved = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: Buffer.from('compat-probe-0.5.0', 'utf8').toString('base64'), encoding: 'utf8', windowsHide: true });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(await new WindowsDpapiSecretStore().unprotect(saved.stdout.trim()), 'compat-probe-0.5.0');
});
