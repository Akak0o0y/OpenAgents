import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const output = path.resolve('docs/validation/2026-09-22-activity-design');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 1060 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const evidence = { fixture: true, realComponents: true, checks: [], errors, passed: false };
try {
  await page.goto('http://127.0.0.1:5188/__activity-preview');
  await page.getByRole('region', { name: 'Command activity' }).waitFor();
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', { name: 'Switch to light' }).click();
    for (const width of [1080, 390]) {
      await page.setViewportSize({ width, height: 1060 });
      const metrics = await page.locator('[data-testid="step-row"]').evaluateAll(rows => rows.map(row => ({ height: row.getBoundingClientRect().height, width: row.getBoundingClientRect().width, scroll: row.scrollWidth })));
      assert.equal(metrics.length, 5);
      assert.ok(metrics.every(row => row.height >= 46), JSON.stringify(metrics));
      assert.ok(metrics.every(row => row.scroll <= row.width + 1), 'no row content overflow');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
      await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
      evidence.checks.push(`${theme}/${width}: readable rows and bounded width`);
    }
  }
  await page.setViewportSize({ width: 1080, height: 1060 });
  await page.getByRole('button', { name: 'Show 55 earlier completed steps' }).click();
  assert.equal(await page.getByTestId('step-row').count(), 60);
  const expanded = await page.getByTestId('activity-steps').evaluate(list => ({ height: list.clientHeight, scroll: list.scrollHeight, minRow: Math.min(...[...list.querySelectorAll('[data-testid="step-row"]')].map(row => row.getBoundingClientRect().height)) }));
  assert.ok(expanded.minRow >= 46, JSON.stringify(expanded));
  assert.ok(expanded.scroll > expanded.height, 'long history scrolls instead of compressing rows');
  await page.screenshot({ path: path.join(output, 'expanded-history.png'), fullPage: true });
  await page.getByRole('button', { name: 'Show recent activity' }).click();
  const command = page.getByRole('button', { name: 'Running command: ls -lah ~/Downloads', exact: true });
  await command.focus(); await page.keyboard.press('Enter');
  await page.getByText('total 2.4M', { exact: false }).waitFor();
  assert.equal(await command.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Space');
  assert.equal(await command.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('button button').count(), 0);
  evidence.checks.push('60-step history: scrolls, all rows readable, every step retained');
  evidence.checks.push('native keyboard disclosure and no nested buttons');
  assert.deepEqual(errors, []);
  evidence.passed = true;
} finally {
  await browser.close();
  fs.writeFileSync(path.join(output, 'ui.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
