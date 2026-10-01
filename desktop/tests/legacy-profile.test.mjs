import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chooseUserData, LEGACY_PROFILE_FOLDER } from '../src/legacy-profile.mjs';

const appData = path.join('C:', 'Users', 'owner', 'AppData', 'Roaming');

test('a packaged app keeps using the OpenHours profile folder after the rename', () => {
  assert.equal(LEGACY_PROFILE_FOLDER, 'OpenHours');
  assert.equal(chooseUserData({ override: undefined, isPackaged: true, appData }), path.join(appData, 'OpenHours'));
});

test('a source run keeps the Electron default, so development never opens the real profile', () => {
  assert.equal(chooseUserData({ override: undefined, isPackaged: false, appData }), null);
});

test('an explicit absolute data folder always wins; a relative one is refused', () => {
  const custom = path.resolve('disposable-profile');
  assert.equal(chooseUserData({ override: custom, isPackaged: true, appData }), custom);
  assert.equal(chooseUserData({ override: custom, isPackaged: false, appData }), custom);
  assert.throws(() => chooseUserData({ override: 'relative', isPackaged: false, appData }), /OPENAGENTS_DATA_DIR/);
});

test('main.mjs pins the profile before the single-instance lock', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const pin = main.indexOf('chooseUserData({ override: process.env.OPENHOURS_DATA_DIR, isPackaged: app.isPackaged');
  assert.ok(pin > 0 && pin < main.indexOf('requestSingleInstanceLock('));
});
