// Disposable upgrade regression. No personal profile or existing bot is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BotDesktop, desktopAssetsDir } from '../dist/src/daemon/bot-desktop.js';
import { dockerRunner } from '../dist/src/daemon/browser-sandbox.js';
import { resolveDockerHost } from '../dist/src/kernel/docker-host.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-upgrade-regression-'));
const oldAssets = path.join(root, 'old-assets');
// The whole bundled recipe: a hand-picked subset broke when recipe files were added.
fs.cpSync(desktopAssetsDir(), oldAssets, { recursive: true });
fs.appendFileSync(path.join(oldAssets, 'Dockerfile'), '\n# disposable previous-recipe lifecycle fixture\n');
const options = { ownerId: root, stateDir: root, autoProvision: true, readyTimeoutMs: 25000 };
const previous = new BotDesktop({ ...options, assetsDir: oldAssets, image: process.env.OPENHOURS_PREVIOUS_DESKTOP_IMAGE });
const current = new BotDesktop({ ...options, assetsDir: desktopAssetsDir() });
const identity = current.identity('fixture');
const run = dockerRunner(resolveDockerHost());
const docker = async args => { const result = await run(args, { timeoutMs: 120000 }); if (result.exitCode) throw new Error(result.stderr || result.stdout); return result.stdout; };
const evidence = { passed: false, checks: [] };
try {
  await previous.prepare('fixture');
  await docker(['exec', identity.name, 'touch', '/home/bot/workspace/upgrade-marker']);
  await previous.stop();
  evidence.checks.push('Previous bot desktop stopped with its home retained');
  await current.prepare('fixture');
  await docker(['exec', identity.name, 'test', '-f', '/home/bot/workspace/upgrade-marker']);
  evidence.checks.push('Replacement container became ready and retained files');
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  try { const logs = await run(['logs', '--tail', '80', identity.name]); evidence.logs = logs.stdout + '\n' + logs.stderr; } catch (logError) { evidence.logs = String(logError); }
  try { evidence.lock = await docker(['exec', identity.name, 'readlink', '/home/bot/chrome-profile/SingletonLock']); } catch {}
  process.exitCode = 1;
} finally {
  await previous.stop().catch(() => {}); await current.stop().catch(() => {});
  // Delete only the exact resources this disposable identity created.
  const inspected = await run(['inspect', identity.name]);
  if (!inspected.exitCode) {
    const info = JSON.parse(inspected.stdout)[0];
    assert.equal(info.Config.Labels['openhours.desktop.bot'], identity.bot);
    assert.equal(info.Name, '/' + identity.name);
    await docker(['rm', info.Id]);
  }
  for (const [kind, name] of [['volume', identity.volume], ['network', identity.network]]) {
    const inspectedResource = await run([kind, 'inspect', name]);
    if (!inspectedResource.exitCode) {
      const info = JSON.parse(inspectedResource.stdout)[0];
      assert.equal(info.Labels['openhours.desktop.bot'], identity.bot);
      assert.equal(info.Name, name);
      await docker([kind, 'rm', name]);
    }
  }
  const output = path.resolve('docs/validation/2026-09-21-browser-computer/upgrade.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
