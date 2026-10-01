// Disposable integration test. No real bot data, personal browser, sign-in, or model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import WebSocket from 'ws';
const packageRoot = process.env.OPENHOURS_DESKTOP_PACKAGE;
const load = relative => import(packageRoot ? pathToFileURL(path.join(packageRoot, 'dist/src', relative)).href : new URL('../dist/src/' + relative, import.meta.url).href);
const { resolveDockerHost } = await load('kernel/docker-host.js');
const { dockerRunner } = await load('daemon/browser-sandbox.js');
const { BotDesktop, desktopAssetsDir } = await load('daemon/bot-desktop.js');
const { BrowserTools } = await load('daemon/browser-tools.js');
const { AgentStore } = await load('daemon/agent-store.js');
const { ArtifactStore } = await load('daemon/artifacts.js');
const { MemorySecretStore } = await load('daemon/secret-store.js');
const { ApprovalGate } = await load('daemon/control-plane.js');
const { DaemonWsServer } = await load('daemon/ws-server.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-desktop-integration-'));
const run = dockerRunner(resolveDockerHost());
const docker = async args => { const r = await run(args, { timeoutMs: 120000 }); if (r.exitCode) throw new Error(r.stderr || r.stdout); return r.stdout; };
const store = new AgentStore(':memory:');
for (const id of ['alpha', 'beta']) store.createAgent({ id, name: id, model_id: 'fixture', budget_cap_usd: 0, current_status: 'IDLE' });
const desktopOptions = { ownerId: dir, stateDir: dir, assetsDir: desktopAssetsDir(), image: process.env.OPENHOURS_DESKTOP_TEST_IMAGE, autoProvision: true, identityKey: id => store.desktopIdentity(id) };
const desktop = new BotDesktop(desktopOptions);
const cleanupIdentities = ['alpha', 'beta'].map(id => desktop.identity(id));
const approvals = new ApprovalGate(store);
const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), approvals, desktop });
const token = randomBytes(32).toString('hex');
const daemon = new DaemonWsServer(0, undefined, { desktopAccess: id => browser.desktopAccess(id), desktopOnRevoke: (id, close) => browser.desktopOnRevoke(id, close) }, { token });
const evidence = { at: new Date().toISOString(), scope: 'Real disposable Docker desktops + BrowserTools + authenticated daemon viewer; not X/Google sign-in or installer upgrade', packageRoot, image: desktop.image, runtime: process.versions.electron ? 'Electron ' + process.versions.electron : 'Node', checks: [], passed: false };
let observer, ui, peer;
const check = text => { evidence.checks.push(text); console.log('PASS: ' + text); };
const startRun = id => { const r = store.createTaskRun({ agentId: id, taskName: 'desktop-proof' }); store.startTaskRun(r.id, 'fixture'); return r.id; };
const attach = async id => { const ep = desktop.endpoint(id); return chromium.connectOverCDP(ep.base + '/cdp', { headers: { Authorization: 'Bearer ' + ep.token } }); };
try {
  await desktop.ensureImage();
  assert.equal(desktop.provisionStatus().state, 'ready');
  check('Bot desktop software prepared from bundled assets without a development flag');
  await daemon.start();
  const base = `http://127.0.0.1:${daemon.boundPort}`, headers = { Authorization: 'Bearer ' + token };
  const alphaRun = startRun('alpha');
  await browser.call('alpha', alphaRun, { tool: 'browser', action: 'snapshot' }, new AbortController().signal);
  const alpha = desktop.identity('alpha'), endpoint = desktop.endpoint('alpha');
  assert.equal((await fetch(endpoint.base + '/health')).status, 401);
  assert.equal((await fetch(endpoint.base + '/health', { headers: { Authorization: 'Bearer bad' } })).status, 401);
  assert.equal((await fetch(endpoint.base + '/health', { headers: { Authorization: 'Bearer ' + endpoint.token } })).status, 200);
  const info = JSON.parse(await docker(['inspect', alpha.name]))[0];
  assert.equal(info.Config.User, 'bot'); assert.equal(info.HostConfig.Privileged, false); assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(Object.keys(info.NetworkSettings.Networks), [alpha.network]);
  assert.equal(info.HostConfig.PortBindings['6090/tcp'][0].HostIp, '127.0.0.1');
  assert.equal(info.HostConfig.PortBindings['9222/tcp'], undefined);
  assert.equal(info.Mounts.filter(m => m.Type === 'bind').length, 3);
  const processes = await docker(['exec', alpha.name, 'ps', '-eo', 'args']);
  assert.doesNotMatch(processes, /--no-sandbox|--enable-automation|--disable-extensions/);
  assert.match(await docker(['exec', alpha.name, 'xwininfo', '-root', '-tree']), /Google Chrome/);
  const version = await docker(['exec', alpha.name, 'google-chrome-stable', '--version']);
  assert.match(version, /^Google Chrome \d/); assert.doesNotMatch(version, /Testing/);
  await assert.rejects(docker(['exec', alpha.name, 'chroot', '/', 'true']), /Operation not permitted/);
  check('BrowserTools starts real ' + version + ' in non-root XFCE; no published CDP, no host browser/profile, gateway requires secret');

  observer = await attach('alpha');
  // The HTTP handshake timeout must not become an idle timeout on the upgraded CDP socket.
  await new Promise(resolve => setTimeout(resolve, 12000));
  assert.equal(observer.isConnected(), true, 'CDP must survive idle time after its handshake');
  let context = observer.contexts()[0], page = context.pages()[0];
  await page.setContent('<title>Alpha desktop fixture</title><h1>Same persistent Chrome session</h1><input aria-label="Fixture note"><p>Disposable integration proof only.</p>');
  await context.addCookies([{ name: 'desktop-proof', value: 'alpha-only', domain: 'example.com', path: '/', expires: Math.floor(Date.now()/1000)+3600 }]);
  await docker(['exec', alpha.name, 'touch', '/home/bot/workspace/alpha-only']);
  await browser.call('alpha', alphaRun, { tool: 'browser', action: 'snapshot' }, new AbortController().signal);
  assert.match(browser.getLatestState('alpha').title, /Alpha desktop fixture/);
  check('Bot adapter observes the same Chrome page shown on its Linux desktop');
  const grant = setInterval(() => { for (const request of store.listApprovals({ pendingOnly: true })) approvals.decide(request.id, 'APPROVED', 'Disposable local form fixture only'); }, 20);
  try { await browser.call('alpha', alphaRun, { tool: 'browser', action: 'fill', target: { role: 'textbox', name: 'Fixture note', index: 0 }, value: 'bot action' }, new AbortController().signal); }
  finally { clearInterval(grant); }
  assert.equal(await page.getByRole('textbox', { name: 'Fixture note' }).inputValue(), 'bot action');
  assert.equal(store.listApprovals({}).length, 1);
  check('Bot changes a synthetic form in its desktop Chrome through the existing approval gate');

  const computerGrant = setInterval(() => { for (const request of store.listApprovals({ pendingOnly: true })) approvals.decide(request.id, 'APPROVED', 'Disposable native desktop fixture only'); }, 20);
  try {
    const screen = await browser.computerCall('alpha', alphaRun, { tool: 'computer', action: 'screenshot' }, new AbortController().signal);
    assert.equal(screen.width, 1440); assert.equal(screen.height, 900);
    assert.equal(Buffer.from(screen.image.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    // Focus the fixture control, then prove that native X11 keyboard input reaches
    // regular Chrome. No external site or real account participates.
    await page.bringToFront(); await page.getByRole('textbox', { name: 'Fixture note' }).focus();
    await browser.computerCall('alpha', alphaRun, { tool: 'computer', action: 'key', key: 'ctrl+a' }, new AbortController().signal);
    await browser.computerCall('alpha', alphaRun, { tool: 'computer', action: 'type', text: 'native bot input' }, new AbortController().signal);
    assert.equal(await page.getByRole('textbox', { name: 'Fixture note' }).inputValue(), 'native bot input');
    await assert.rejects(browser.computerCall('alpha', alphaRun, { tool: 'computer', action: 'click', x: 2000, y: 10 }, new AbortController().signal), /outside/);
    check('Native bot desktop screenshot and X11 keyboard input work in real regular Chrome, with geometry checks');
  } finally { clearInterval(computerGrant); }

  const viewer = base + '/api/desktop/alpha/viewer.html';
  assert.equal((await fetch(viewer)).status, 401);
  assert.equal((await fetch(viewer, { headers })).status, 403);
  await browser.control('alpha', { action: 'takeover' });
  if (process.env.OPENHOURS_VIEWER_ELECTRON) {
    const env = { ...process.env, OH_DESKTOP_VIEWER_URL: viewer, OH_DESKTOP_VIEWER_TOKEN: token,
      OH_DESKTOP_VIEWER_SCREENSHOT: path.resolve('docs/validation/2026-09-20-bot-desktop/electron-embedded-desktop.png') };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.OPENHOURS_VIEWER_ELECTRON, ['desktop/tests/electron-live-desktop-fixture.mjs'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', data => process.stdout.write(data));
      child.stderr.on('data', data => process.stderr.write(data));
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Electron embedded desktop check failed: ' + code)));
    });
    check('Actual Linux Chrome desktop paints inside Electron iframe under production shell CSP');
  }
  assert.equal((await fetch(viewer, { headers })).status, 200);
  assert.equal((await fetch(base + '/api/desktop/beta/viewer.html', { headers })).status, 403);
  assert.equal((await fetch(viewer, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  peer = new WebSocket(base.replace('http:', 'ws:') + '/api/desktop/alpha/websockify', { headers });
  const greeting = once(peer, 'message'); await once(peer, 'open');
  assert.match((await greeting)[0].toString(), /^RFB /);
  // Local headless Chromium is only the viewer test driver. The bot is Chrome Stable in Docker.
  ui = await chromium.launch({ headless: true });
  const uiContext = await ui.newContext({ viewport: { width: 1440, height: 1000 } });
  const uiPage = await uiContext.newPage();
  uiPage.on('pageerror', error => console.log('Viewer error: ' + error.message));
  uiPage.on('console', message => { if (message.type() === 'error') console.log('Viewer console: ' + message.text().replace(/data:[^']+/g, '[image bytes]').slice(0, 500)); });
  await uiPage.goto(base + '/connect');
  await uiPage.evaluate(async token => { const r = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); if (!r.ok) throw new Error('fixture session rejected'); }, token);
  await uiPage.goto(viewer);
  await uiPage.waitForFunction(() => document.getElementById('status')?.textContent === '', { timeout: 15000 });
  await uiPage.waitForFunction(() => {
    const canvas = document.querySelector('canvas'), ctx = canvas?.getContext('2d');
    if (!ctx || !canvas.width || !canvas.height) return false;
    const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data, colors = new Set();
    for (let i = 0; i < bytes.length; i += 400) colors.add(`${bytes[i]},${bytes[i+1]},${bytes[i+2]}`);
    return colors.size > 30;
  }, undefined, { timeout: 15000 }).catch(async error => {
    console.log('Viewer diagnostics: ' + JSON.stringify(await uiPage.evaluate(() => ({ status: document.getElementById('status')?.textContent, canvases: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height, visible: c.getBoundingClientRect().toJSON() })) }))));
    throw error;
  });
  assert.ok(await uiPage.locator('canvas').count());
  await uiPage.screenshot({ path: path.resolve('docs/validation/2026-09-20-bot-desktop/viewer-before-input.png') });
  // Use the viewer for focus as a human would. A CDP click may focus the DOM
  // while Chrome's native omnibox still owns keyboard input on about:blank.
  // Fixed 1440x900 desktop + 1440x1000 viewer; verified in viewer-before-input.png.
  await page.evaluate(() => document.querySelector('input').addEventListener('click', () => document.querySelector('input').dataset.viewerClicked = 'yes'));
  await uiPage.mouse.click(90, 264);
  await page.waitForFunction(() => document.querySelector('input')?.dataset.viewerClicked === 'yes', undefined, { timeout: 10000 });
  await uiPage.keyboard.type(' human input');
  await page.waitForFunction(() => document.querySelector('input')?.value.includes('human input'), undefined, { timeout: 10000 });
  check('Human keyboard input travels through noVNC into the same Chrome form');
  const screenshot = path.resolve('docs/validation/2026-09-20-bot-desktop/integrated-viewer.png');
  fs.mkdirSync(path.dirname(screenshot), { recursive: true }); await uiPage.screenshot({ path: screenshot });
  check('Authenticated noVNC viewer renders the real desktop; anonymous, wrong-bot, and foreign-origin access rejected');
  const closed = once(peer, 'close');
  await browser.control('alpha', { action: 'resume' });
  await closed; peer = null;
  assert.equal((await fetch(viewer, { headers })).status, 403);
  check('Resume closes existing viewer access before bot control continues');
  await ui.close(); ui = null;
  await page.goto('http://127.0.0.1:6090/health').catch(() => {});
  assert.doesNotMatch(await page.locator('body').innerText(), /"ready":true/);
  assert.match(await page.locator('body').innerText(), /Blocked|ERR_/);
  check('Chrome cannot reach container-local management endpoints through its public-only proxy');
  await observer.close(); observer = null;
  await browser.endRun(alphaRun);
  assert.equal(JSON.parse(await docker(['inspect', alpha.name]))[0].State.Running, false);
  const betaRun = startRun('beta');
  await browser.call('beta', betaRun, { tool: 'browser', action: 'snapshot' }, new AbortController().signal);
  observer = await attach('beta');
  assert.equal((await observer.contexts()[0].cookies()).some(c => c.name === 'desktop-proof'), false);
  await assert.rejects(docker(['exec', desktop.identity('beta').name, 'test', '-e', '/home/bot/workspace/alpha-only']));
  await observer.close(); observer = null;
  await browser.endRun(betaRun);
  const restarted = startRun('alpha');
  await browser.call('alpha', restarted, { tool: 'browser', action: 'snapshot' }, new AbortController().signal);
  observer = await attach('alpha');
  assert.equal((await observer.contexts()[0].cookies()).find(c => c.name === 'desktop-proof')?.value, 'alpha-only');
  await docker(['exec', alpha.name, 'test', '-e', '/home/bot/workspace/alpha-only']);
  await observer.close(); observer = null;
  await browser.endRun(restarted);
  check('Alpha and Beta keep separate files/cookies; Alpha profile survives endRun, container shutdown and a new task');
  const manual = await browser.openLogin('alpha', 'https://example.com');
  const manualEndpoint = desktop.endpoint('alpha');
  const manualHeaders = { Authorization: 'Bearer ' + manualEndpoint.token };
  assert.equal((await fetch(manualEndpoint.base + '/cdp/json/version/', { headers: manualHeaders })).status, 403);
  await docker(['exec', alpha.name, 'node', '-e', "fetch('http://127.0.0.1:9222/json/version').then(()=>process.exit(1),()=>process.exit(0))"]);
  const manualProcesses = await docker(['exec', alpha.name, 'ps', '-eo', 'args']);
  assert.doesNotMatch(manualProcesses, /--remote-debugging-port|--enable-automation/);
  assert.ok(browser.desktopAccess('alpha'));
  assert.equal((await browser.liveState('alpha')).state.login, true);
  const conflict = startRun('alpha');
  await assert.rejects(browser.call('alpha', conflict, { tool: 'browser', action: 'snapshot' }, new AbortController().signal), /another run/);
  store.finishTaskRun(conflict, 'ABORTED');
  const savedManual = await browser.finishLogin('alpha', manual.runId);
  assert.equal(savedManual.verified, false);
  assert.equal(browser.desktopAccess('alpha'), null);
  assert.equal(browser.status().active, 0);
  const afterManual = startRun('alpha');
  await browser.call('alpha', afterManual, { tool: 'browser', action: 'snapshot' }, new AbortController().signal);
  observer = await attach('alpha');
  assert.equal((await observer.contexts()[0].cookies()).find(c => c.name === 'desktop-proof')?.value, 'alpha-only');
  await observer.close(); observer = null; await browser.endRun(afterManual);
  check('Human sign-in runs Chrome without a debugging port or Playwright; model work is excluded, save revokes viewer, and the same profile survives bot restart');
  // An unclean stop (Docker or WSL killed mid-run) skips the cleanup trap, so display :1's lock
  // stays in the container layer; `docker start` reuses it and Xtigervnc used to refuse the display.
  await desktop.prepare('alpha');
  await docker(['kill', alpha.name]);
  await docker(['cp', `${alpha.name}:/tmp/.X1-lock`, '-']);
  await desktop.prepare('alpha');
  observer = await attach('alpha');
  assert.equal((await observer.contexts()[0].cookies()).find(c => c.name === 'desktop-proof')?.value, 'alpha-only');
  await observer.close(); observer = null; await desktop.stopAgent('alpha');
  check('A desktop killed uncleanly restarts in the same container: the stale display lock is cleared and the profile is intact');
  if (!process.env.OPENHOURS_DESKTOP_TEST_IMAGE) {
    // Simulate an app recipe update using only a disposable owned container.
    // An extra Dockerfile comment changes the recipe identity but reuses layers.
    const previousAssets = path.join(dir, 'previous-recipe');
    // The whole bundled recipe: a hand-picked subset broke when recipe files were added.
    fs.cpSync(desktopAssetsDir(), previousAssets, { recursive: true });
    fs.appendFileSync(path.join(previousAssets, 'Dockerfile'), '\n# disposable previous-recipe lifecycle fixture\n');
    const previous = new BotDesktop({ ...desktopOptions, assetsDir: previousAssets });
    // Replace current stopped test container with a known older recipe, keeping
    // its fixture home. The production upgrade path then performs the reverse.
    const owned = JSON.parse(await docker(['inspect', alpha.name]))[0];
    assert.equal(owned.Config.Labels['openhours.desktop.bot'], alpha.bot);
    assert.equal(owned.State.Running, false);
    await docker(['rm', owned.Id]);
    await previous.prepare('alpha'); await previous.stop();
    const beforeUpgrade = JSON.parse(await docker(['inspect', alpha.name]))[0].Id;
    await desktop.prepare('alpha');
    assert.notEqual(JSON.parse(await docker(['inspect', alpha.name]))[0].Id, beforeUpgrade);
    observer = await attach('alpha');
    assert.equal((await observer.contexts()[0].cookies()).find(c => c.name === 'desktop-proof')?.value, 'alpha-only');
    await docker(['exec', alpha.name, 'test', '-e', '/home/bot/workspace/alpha-only']);
    await observer.close(); observer = null; await desktop.stopAgent('alpha');
    check('Real Docker recipe upgrade replaces only the owned container and preserves existing Chrome cookies and files');
  }
  for (const task of store.listTaskRuns('alpha')) if (task.status === 'RUNNING') store.finishTaskRun(task.id, 'COMPLETED');
  await desktop.retireAgent('alpha', () => store.deleteAgent('alpha'));
  assert.equal(JSON.parse(await docker(['inspect', alpha.name]))[0].State.Running, false);
  assert.equal(JSON.parse(await docker(['volume', 'inspect', alpha.volume]))[0].Name, alpha.volume);
  store.createAgent({ id: 'alpha', name: 'Recreated Alpha', model_id: 'fixture', budget_cap_usd: 0, current_status: 'IDLE' });
  cleanupIdentities.push(desktop.identity('alpha'));
  assert.notEqual(desktop.identity('alpha').volume, alpha.volume);
  await desktop.prepare('alpha');
  observer = await attach('alpha');
  assert.equal((await observer.contexts()[0].cookies()).some(c => c.name === 'desktop-proof'), false);
  await assert.rejects(docker(['exec', desktop.identity('alpha').name, 'test', '-e', '/home/bot/workspace/alpha-only']));
  await observer.close(); observer = null; await desktop.stopAgent('alpha');
  check('Delete/recreate retains the archived home but gives the same bot ID a fresh desktop with no old cookies or files');
  assert.equal(store.getDatabase().prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 0);
  check('Persistent profile is used directly; no browser cookies exported to the host session table');
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error.stack ?? error).slice(0, 6000); process.exitCode = 1;
  try { await ui.contexts()[0].pages()[0].screenshot({ path: path.resolve('docs/validation/2026-09-20-bot-desktop/viewer-input-failure.png') }); } catch {}
  for (const agent of ['alpha', 'beta']) try {
    const info = JSON.parse(await docker(['inspect', desktop.identity(agent).name]))[0];
    evidence[agent + 'FailureState'] = { running: info.State.Running, exitCode: info.State.ExitCode, oomKilled: info.State.OOMKilled, desktop: desktop.status(agent), connected: observer?.isConnected() };
    evidence[agent + 'FailureConfig'] = { image: info.Image, configuredImage: info.Config.Image,
      expectedImage: JSON.parse(await docker(['image', 'inspect', desktop.image]))[0].Id,
      user: info.Config.User, privileged: info.HostConfig.Privileged, capDrop: info.HostConfig.CapDrop,
      bindings: info.HostConfig.PortBindings, networks: Object.keys(info.NetworkSettings.Networks), mounts: info.Mounts };
  } catch {}
}
finally {
  peer?.terminate(); await ui?.close().catch(() => {}); await observer?.close().catch(() => {});
  await browser.stop().catch(() => {}); await desktop.stop().catch(() => {}); await daemon.close(); store.close();
  for (const id of cleanupIdentities) {
    try {
      const info = JSON.parse(await docker(['inspect', id.name]))[0];
      if (info.Config.Labels?.['openhours.desktop.bot'] === id.bot && info.Name === '/' + id.name) await docker(['rm', '-f', id.name]);
    } catch {}
    for (const [kind, name] of [['volume', id.volume], ['network', id.network]]) try {
      const info = JSON.parse(await docker([kind, 'inspect', name]))[0];
      if (info.Labels?.['openhours.desktop.bot'] === id.bot && info.Name === name) await docker([kind, 'rm', name]);
    } catch {}
  }
  const output = path.resolve('docs/validation/2026-09-20-bot-desktop/' + (packageRoot ? 'packaged-desktop-integration.json' : process.env.OPENHOURS_DESKTOP_TEST_IMAGE ? 'integration-negative-control.json' : 'integration.json'));
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
