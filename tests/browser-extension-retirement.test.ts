import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { systemApi } from '../src/daemon/system-api.js';

test('retired extension endpoints reject old pair, poll, and connection requests', async () => {
  const api = systemApi({} as Parameters<typeof systemApi>[0]);
  for (const action of ['browser-connect', 'browser-connect-finish', 'browser-connect-forget', 'browser-bridge-pair', 'browser-bridge-next', 'browser-bridge-result', 'browser-bridge-validate', 'browser-bridge-offline']) {
    const result = await api('POST', new URL('http://127.0.0.1/api/system/' + action), {});
    assert.equal(result.status, 410, action);
    assert.match(JSON.stringify(result.body), /retired/);
  }
});

test('desktop bridge and packaging no longer expose the personal browser extension', () => {
  for (const file of ['desktop/src/main.mjs', 'desktop/src/preload.cjs', 'desktop/electron-builder.yml', 'web/src/lib/desktop.ts']) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /browser:prepare|browser:open|browser-extension|browser-connector/);
  }
  assert.equal(fs.existsSync('browser-extension/manifest.json'), false);
  assert.equal(fs.existsSync('src/daemon/connected-browser.ts'), false);
});
