// Disposable reproduction of Docker Desktop mount translation on restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotDesktop, desktopAssetsDir } from '../dist/src/daemon/bot-desktop.js';
import { dockerRunner } from '../dist/src/daemon/browser-sandbox.js';
import { resolveDockerHost } from '../dist/src/kernel/docker-host.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-restart-check-'));
const host = resolveDockerHost(), run = dockerRunner(host);
const desktop = new BotDesktop({ ownerId: dir, stateDir: dir, assetsDir: desktopAssetsDir(), host, autoProvision: true });
const id = desktop.identity('fixture');
try {
  await desktop.prepare('fixture'); await desktop.stopAgent('fixture');
  const info = JSON.parse((await run(['inspect', id.name])).stdout)[0];
  console.log(JSON.stringify({ transport: host.kind, expectedRoot: host.hostPath(dir), declaredMounts: info.HostConfig.Mounts, effectiveMounts: info.Mounts }, null, 2));
  await desktop.prepare('fixture');
  console.log('PASS: real Docker desktop restarted with its existing profile.');
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally {
  await desktop.stop();
  const found = await run(['inspect', id.name]);
  if (!found.exitCode) {
    const info = JSON.parse(found.stdout)[0];
    if (info.Name !== '/' + id.name || info.Config.Labels?.['openhours.desktop.bot'] !== id.bot) throw new Error('Refusing foreign cleanup');
    await run(['rm', id.name]);
  }
  for (const [kind, name] of [['volume', id.volume], ['network', id.network]]) {
    const found = await run([kind, 'inspect', name]);
    if (!found.exitCode && JSON.parse(found.stdout)[0].Labels?.['openhours.desktop.bot'] === id.bot) await run([kind, 'rm', name]);
  }
}
