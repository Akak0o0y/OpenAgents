import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const electron = createRequire(import.meta.url)('electron');
test('real Electron embeds only the desktop viewer, with old-policy negative control', { timeout: 45000 }, async () => {
  for (const blocked of ['1', '0']) {
    const env = { ...process.env, OH_EXPECT_BLOCKED: blocked };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [fileURLToPath(new URL('./electron-desktop-frame-fixture.mjs', import.meta.url))], { env, windowsHide: true, timeout: 22000 });
    assert.match(stdout, blocked === '1' ? /REPRODUCED:/ : /PASS:/);
  }
});
