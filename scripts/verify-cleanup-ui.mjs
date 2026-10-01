// Real built UI -> authenticated daemon -> disposable database. No real accounts or model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startDaemon } from '../dist/src/daemon/index.js';
import { MemorySecretStore } from '../dist/src/daemon/secret-store.js';

const output = path.resolve('docs/validation/2026-09-21-release-0.4.4');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cleanup-ui-'));
const daemon = await startDaemon({ configPath: null, dbPath: path.join(profile, 'state.db'), wsPort: 0, docker: false, cadenceMs: 60000,
  secretStore: new MemorySecretStore(),
  sandbox: { orphanSweep: async () => ({ reapedContainers: 0, reapedVolumes: 0 }), workspaceVolumeName: n => n, workspaceVolumeExists: async () => false },
  llmClient: { async generateCode() { throw new Error('This UI check must not call a model'); } },
});
const origin = `http://127.0.0.1:${daemon.wsServer.boundPort}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const { token } = JSON.parse(fs.readFileSync(path.join(profile, 'state.db.auth.json'), 'utf8'));
await context.addCookies([{ name: 'openhours_session', value: token, url: origin }]);
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const evidence = { at: new Date().toISOString(), checks, errors, actualDaemon: true, syntheticProvider: true, passed: false };
const check = text => { checks.push(text); console.log('PASS: ' + text); };
async function until(read, test, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = read();
    if (test(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
try {
  const connection = await daemon.providerConnections.save({ name: 'UI fixture', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'synthetic-ui-only' });
  const catalog = [{ id: 'fixture/model', usable: true, virtual: false, supportsTools: true, supportsVision: false, contextWindow: 32000 }];
  daemon.store.getDatabase().prepare("UPDATE provider_connections SET status='connected', catalog_json=?, catalog_fetched_at=? WHERE id=?").run(JSON.stringify(catalog), Date.now(), connection.id);
  const agent = daemon.store.listAgents()[0];
  daemon.store.updateAgent(agent.id, { model_id: 'fixture/model', connection_id: connection.id, routing_mode: 'pinned' });
  const oldThread = daemon.chat.createThread(agent.id);
  daemon.store.appendMessage({ thread_id: oldThread.id, role: 'user', content: 'Find the unique cleanup navigation proof' });
  const latest = daemon.chat.createThread(agent.id);
  daemon.store.appendMessage({ thread_id: latest.id, role: 'user', content: 'Current conversation' });
  await page.goto(origin);
  const picker = page.getByRole('button', { name: 'Choose chat model', exact: true });
  await picker.waitFor();
  const logo = page.locator('.oh-brand-mark img');
  assert.equal(await logo.evaluate(img => img.complete && img.naturalWidth > 0), true);
  await picker.click();
  await page.getByRole('button', { name: 'Close model browser' }).click();
  await page.getByRole('dialog', { name: 'Choose a model' }).waitFor({ state: 'detached' });
  await picker.click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Choose a model' }).waitFor({ state: 'detached' });
  await picker.click();
  await page.getByRole('button', { name: /^Automatic/ }).click();
  await page.getByRole('button', { name: 'Use this model' }).click();
  await page.getByRole('dialog', { name: 'Choose a model' }).waitFor({ state: 'detached' });
  await until(() => daemon.store.getAgent(agent.id), row => row.routing_mode === 'auto', 'automatic routing persistence');
  check('Model picker closes with X and Escape; Automatic saves through the real daemon and dismisses');

  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await page.getByRole('button', { name: 'Create Routine', exact: true }).click();
  await page.getByPlaceholder('Name this routine').fill('Cleanup webhook proof');
  await page.getByPlaceholder('What should this routine do each time it runs?').fill('Say hello');
  await page.getByRole('button', { name: /Add trigger/ }).click();
  await page.getByRole('menuitem', { name: 'Webhook', exact: true }).click();
  await page.getByRole('button', { name: 'Create routine', exact: true }).click();
  const routine = await until(() => daemon.store.listRoutines(agent.id), rows => rows.some(row => row.name === 'Cleanup webhook proof'), 'webhook routine creation');
  const saved = routine.find(row => row.name === 'Cleanup webhook proof');
  assert.equal(saved.schedule_enabled, 0);
  assert.ok(saved.webhook_token);
  assert.equal(daemon.store.getDueRoutines(Date.UTC(2028, 1, 29, 3, 5)).some(row => row.id === saved.id), false);
  check('Real routine form persists webhook-only intent and token; it is not due at the former leap-day sentinel');

  await page.reload();
  await picker.waitFor();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search bots, messages and routines' }).fill('unique cleanup navigation proof');
  await page.getByRole('option').filter({ hasText: 'Find the unique cleanup navigation proof' }).first().click();
  await page.getByText('Find the unique cleanup navigation proof', { exact: true }).waitFor();
  check('Workspace search opens the matching older conversation');
  await page.screenshot({ path: path.join(output, 'workspace-logo-light.png'), fullPage: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'OpenAgents Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'workspace-logo-dark.png'), fullPage: true });
  assert.deepEqual(errors, []);
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error.stack ?? error);
  await page.screenshot({ path: path.join(output, 'cleanup-ui-failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await daemon.shutdown();
  fs.writeFileSync(path.join(output, 'cleanup-ui.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
