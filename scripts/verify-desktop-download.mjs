// Production-transport regression: disposable Linux Chrome -> Windows/host daemon.
// Synthetic bytes only; no provider calls, accounts, personal profiles or network downloads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { BotDesktop, desktopAssetsDir } from '../dist/src/daemon/bot-desktop.js';
import { BrowserTools } from '../dist/src/daemon/browser-tools.js';
import { AgentStore } from '../dist/src/daemon/agent-store.js';
import { ArtifactStore } from '../dist/src/daemon/artifacts.js';
import { MemorySecretStore } from '../dist/src/daemon/secret-store.js';
import { ApprovalGate } from '../dist/src/daemon/control-plane.js';
import { dockerRunner } from '../dist/src/daemon/browser-sandbox.js';
import { resolveDockerHost } from '../dist/src/kernel/docker-host.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-desktop-download-'));
const store = new AgentStore(':memory:');
store.createAgent({ id: 'transfer-fixture', name: 'Transfer fixture', model_id: 'fixture', budget_cap_usd: 0, current_status: 'IDLE' });
const desktop = new BotDesktop({ ownerId: dir, stateDir: dir, assetsDir: desktopAssetsDir(), autoProvision: true });
const identity = desktop.identity('transfer-fixture');
const approvals = new ApprovalGate(store);
const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), approvals, desktop });
const runner = dockerRunner(resolveDockerHost());
const docker = async args => { const r = await runner(args, { timeoutMs: 30000 }); if (r.exitCode) throw new Error('Disposable Docker operation failed'); return r.stdout; };
const run = store.createTaskRun({ agentId: 'transfer-fixture', taskName: 'transfer-fixture' }); store.startTaskRun(run.id, 'fixture');
const controller = new AbortController();
const call = action => browser.call('transfer-fixture', run.id, { tool: 'browser', ...action }, controller.signal);
const evidence = { at: new Date().toISOString(), scope: 'Disposable real Linux Chrome/CDP byte transfer, no real accounts', image: desktop.image, passed: false };
let observer, timer, desktopRequested = false;
const grant = setInterval(() => { for (const row of store.listApprovals({ pendingOnly: true })) approvals.decide(row.id, 'APPROVED', 'Synthetic blob download only'); }, 20);
try {
  console.log('Checking the bot desktop image and Docker readiness.');
  await desktop.ensureImage();
  desktopRequested = true;
  console.log('Starting a disposable bot desktop.');
  await call({ action: 'snapshot' });
  const endpoint = desktop.endpoint('transfer-fixture');
  // Observation must not overwrite the runtime's download behavior/defaults.
  observer = await chromium.connectOverCDP(endpoint.base + '/cdp', { headers: { Authorization: 'Bearer ' + endpoint.token }, noDefaults: true });
  const page = observer.contexts()[0].pages()[0];
  const bytes = Buffer.alloc(128 * 1024, 37);
  await page.setContent('<title>Disposable transfer fixture</title><a download="fixture.bin">Download fixture</a>');
  await page.evaluate(() => { document.querySelector('a').href = URL.createObjectURL(new Blob([new Uint8Array(128 * 1024).fill(37)], { type: 'application/octet-stream' })); });
  await call({ action: 'snapshot' });
  console.log('Transferring synthetic bytes through the production CDP adapter.');
  const began = Date.now();
  timer = setTimeout(() => controller.abort(new Error('Fixture transfer exceeded 15 seconds')), 15000);
  try {
    const downloaded = await call({ action: 'download', target: { role: 'link', name: 'Download fixture', index: 0 } });
    assert.equal(downloaded.artifact?.sha256, createHash('sha256').update(bytes).digest('hex'));
    evidence.bytes = bytes.length;
    evidence.passed = true;
  } finally { evidence.transferMs = Date.now() - began; clearTimeout(timer); }
} catch (error) {
  evidence.error = String(error.message ?? error).slice(0, 1000);
  process.exitCode = 1;
} finally {
  clearTimeout(timer); clearInterval(grant);
  await observer?.close().catch(() => {});
  await browser.stop().catch(() => {}); await desktop.stop().catch(() => {}); store.close();
  // Only resources named for this newly created fixture profile, with its bot label.
  for (const [kind, name] of desktopRequested ? [['container', identity.name], ['volume', identity.volume], ['network', identity.network]] : []) {
    try {
      const info = JSON.parse(await docker([kind, 'inspect', name]))[0];
      const labels = kind === 'container' ? info.Config.Labels : info.Labels;
      assert.equal(labels?.['openhours.desktop.bot'], identity.bot);
      assert.equal(info.Name, kind === 'container' ? '/' + name : name);
      await docker([kind, 'rm', ...(kind === 'container' ? ['-f'] : []), name]);
    } catch (error) { (evidence.cleanupWarnings ??= []).push(`${kind}: ${error.message}`); }
  }
  const output = path.resolve('docs/validation/2026-09-21-browser-computer/desktop-download.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
