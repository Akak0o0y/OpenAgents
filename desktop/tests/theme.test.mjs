import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settingsStore, sanitizeSettings, resolveAppTheme } from '../src/settings.mjs';

test('saved appearance survives restart and rejects invalid preferences', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-theme-'));
  try {
    assert.equal(sanitizeSettings({ themePreference: true }).themePreference, 'light');
    for (const preference of ['light', 'dark', 'system']) {
      settingsStore(dir).update({ themePreference: preference });
      assert.equal(settingsStore(dir).read().themePreference, preference);
    }
    assert.equal(resolveAppTheme('light', true), 'light');
    assert.equal(resolveAppTheme('dark', false), 'dark');
    assert.equal(resolveAppTheme('system', true), 'dark');
    assert.equal(resolveAppTheme('system', false), 'light');
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('real startup page paints the app preference even when OS theme is opposite', async () => {
  const browser = await chromium.launch();
  try {
    for (const [theme, systemTheme, background] of [['light', 'dark', '#f3f2ec'], ['dark', 'light', '#0d0f0d']]) {
      const page = await browser.newPage({ colorScheme: systemTheme, reducedMotion: 'reduce', viewport: { width: 1000, height: 700 } });
      // Deterministic shell-state fixture: visual QA is not a daemon boot test.
      await page.addInitScript(({theme, systemTheme}) => {
        window.openhours = {
          info: async () => ({ appTheme: theme, systemTheme, platform: 'win32' }),
          theme: { onAppearanceChange: handler => { window.changeAppearance = handler; } },
          window: { minimize() {}, close() {} },
          daemon: { status: async () => ({ state: { status: 'starting', port: 43140 } }), onState() {} },
          docker: { status: async () => ({ state: 'running' }), onStatus() {} },
        };
      }, {theme, systemTheme});
      const url = new URL('../src/startup/index.html', import.meta.url); url.searchParams.set('theme', theme);
      await page.goto(url.href);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), background);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('stage')).opacity === '1');
      if (process.env.OPENHOURS_THEME_EVIDENCE_DIR) {
        const directory = path.resolve(process.env.OPENHOURS_THEME_EVIDENCE_DIR);
        fs.mkdirSync(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, `${theme}.png`) });
      }
      await page.evaluate(next => window.changeAppearance(next), theme === 'light' ? 'dark' : 'light');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme === 'light' ? 'dark' : 'light');
      await page.close();
    }
  } finally { await browser.close(); }
});
