// Only the daemon knows the bearer. Neither Chrome pages nor the viewer receive it.
import http from 'node:http';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { validateComputerInput, executeComputer, captureDesktop } from './computer.mjs';
import {desktopObserver} from './observe.mjs';
import { executeExec, launchApp } from './exec.mjs';
import { executeFile } from './files.mjs';
import { startRecording, stopRecording, recordingStatus, validateRecordInput } from './recorder.mjs';
import { executeJob, stopAllJobs } from './jobs.mjs';
import { executeDisplay } from './display.mjs';
const downloadsDir = process.env.HOME + '/Downloads';
let chrome, human = false, switching = false;
let computerBusy = false;
/** Chrome is one application on this desktop, not the desktop itself. */
function chromeRunning() {
  return !!chrome && chrome.exitCode === null && chrome.signalCode === null;
}
async function startChrome(manual, url = 'about:blank') {
  if (chromeRunning()) throw new Error('Chrome is already running.');
  human = manual;
  // The wrapper owns the profile, proxy and debugging-port decisions so a menu
  // launch, a shell launch and this one cannot diverge.
  chrome = spawn('/usr/local/bin/openhours-chrome', [url], {
    stdio: 'inherit',
    env: { ...process.env, OPENHOURS_CHROME_HUMAN: manual ? '1' : '0' },
  });
  // Closing the browser window must leave the desktop, the viewer and this
  // gateway running; the session is not Chrome's to end.
  chrome.once('error', () => {});
  await once(chrome, 'spawn');
  // Spawning is not readiness. Chrome opens its debugging port a moment later, and a
  // client connecting in that gap gets a 503 that looks like a broken desktop.
  if (!manual) await waitForDevTools();
}
/** Resolve once Chrome answers on its debugging port, or give up at the deadline. */
async function waitForDevTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!chromeRunning()) throw new Error('Chrome exited before its debugging port opened.');
    try {
      const probe = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1000) });
      if (probe.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() >= deadline) throw new Error('Chrome did not open its debugging port in time.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
async function stopChrome() {
  if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return;
  const child = chrome;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chrome did not close cleanly')), 12000); })]); }
  finally { clearTimeout(timer); }
}
// A desktop that could not start Chrome is still a working desktop. Failing here
// would take the whole session down over one application.
try { await startChrome(false); } catch (error) { console.error('Chrome did not start with the desktop:', error.message); }
// No background job outlives the desktop that owns it.
process.once('SIGTERM', () => { stopAllJobs(); void stopChrome().then(() => process.exit(0), () => process.exit(1)); });
const token = fs.readFileSync('/run/secrets/desktop-token', 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('A desktop gateway secret is required.');
function authorized(req) {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function target(url, upgrade = false) {
  if (upgrade && url === '/viewer/websockify') return { port: 6080, path: '/websockify' };
  if (upgrade && /^\/cdp\/devtools\/browser\/[a-f0-9-]+$/.test(url)) return { port: 9222, path: url.slice(4) };
  if (!upgrade && url === '/cdp/json/version/') return { port: 9222, path: '/json/version' };
  if (!upgrade && /^\/viewer\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(url) && !url.split('/').includes('..')) return { port: 6080, path: url.slice(7) };
  return null;
}
const observeDesktop=desktopObserver();
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req)) { res.writeHead(401); res.end(); return; }
  if(req.url==='/observe'){observeDesktop(req,res);return;}
  if (req.method === 'POST' && req.url === '/computer') {
    if (human || switching || computerBusy) { res.writeHead(409); res.end('Desktop is under human control or busy.'); return; }
    computerBusy = true;
    let dispatched = false;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 48000) throw new Error('Too large'); }
      const input = JSON.parse(body);
      validateComputerInput(input);
      const size = await executeComputer(input, undefined, () => { dispatched = true; });
      // Capturing the instant an action dispatches returns the frame from before the
      // application repainted, so the bot chose its next click from a stale screen.
      if (!['screenshot', 'windows', 'wait'].includes(input.action)) await new Promise(resolve => setTimeout(resolve, 350));
      const data = await captureDesktop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...size, image: { mime: 'image/png', data } }));
    } catch {
      res.writeHead(dispatched ? 502 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: dispatched ? 'Computer interaction outcome is uncertain. Inspect the desktop before continuing; do not repeat a submission.' : 'Computer observation or input validation failed. Refresh the screen and check the action.' }));
    } finally { computerBusy = false; }
    return;
  }
  if (req.method === 'POST' && req.url === '/human/start') {
    if (switching || computerBusy) { res.writeHead(409); res.end(); return; }
    switching = true;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 8192) throw new Error('Too large'); }
      const url = new URL(JSON.parse(body).url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL');
      await stopChrome();
      await startChrome(true, url.href);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ human: true }));
    } catch { res.writeHead(400); res.end('Human sign-in could not start.'); }
    finally { switching = false; }
    return;
  }
  if (req.method === 'POST' && req.url === '/human/stop') {
    if (switching || !human) { res.writeHead(409); res.end(); return; }
    switching = true;
    try { await stopChrome(); res.writeHead(200); res.end(); }
    catch { res.writeHead(503); res.end('Chrome did not close cleanly; retry saving.'); }
    finally { switching = false; }
    return;
  }
  // The bot's own computer: a shell, its files and its applications. All three run
  // as the unprivileged bot user inside this container, under its seccomp profile
  // and behind its egress proxy. None of them can see the host.
  if (req.method === 'POST' && ['/exec', '/files', '/apps', '/record', '/jobs', '/display'].includes(req.url)) {
    if (human) { res.writeHead(409); res.end('The desktop is under human control.'); return; }
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 8 * 1024 * 1024) throw new Error('Request body is too large.'); }
      const input = JSON.parse(body);
      const result = req.url === '/exec' ? await executeExec(input)
        : req.url === '/files' ? await executeFile(input)
        : req.url === '/apps' ? await launchApp(input)
        : req.url === '/jobs' ? await executeJob(input)
        : req.url === '/display' ? await executeDisplay(input)
        : await (async () => {
            validateRecordInput(input);
            if (input.operation === 'start') return startRecording(input);
            if (input.operation === 'stop') return stopRecording();
            return recordingStatus();
          })();
      if(req.url==='/display'&&input.operation==='set')observeDesktop.reset();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      // The message is the only clue the caller gets about what to correct, and
      // these paths are container-local, so the real reason is returned.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
    return;
  }
  // Chrome can be closed and reopened without ending the session. Starting it
  // here also returns the desktop to automation mode after a human sign-in,
  // which otherwise left /cdp refused with no way back.
  if (req.method === 'POST' && (req.url === '/chrome/start' || req.url === '/chrome/stop')) {
    if (switching || computerBusy) { res.writeHead(409); res.end('Desktop is busy.'); return; }
    switching = true;
    try {
      if (req.url === '/chrome/stop') { await stopChrome(); human = false; }
      else if (!chromeRunning()) await startChrome(false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chrome: chromeRunning() ? (human ? 'human' : 'automation') : 'stopped' }));
    } catch { res.writeHead(503); res.end('Chrome could not be started.'); }
    finally { switching = false; }
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (human && req.url.startsWith('/cdp')) { res.writeHead(403); res.end(); return; }
  // Desktop health is the X display plus the viewer. Chrome is reported, never
  // required: closing the browser window used to make this 503, which the daemon
  // read as a dead desktop and tore the container down mid-session.
  if (req.url === '/health') {
    try {
      const viewer = await fetch('http://127.0.0.1:6080/vnc.html', { signal: AbortSignal.timeout(2000) });
      if (!viewer.ok) throw new Error('viewer unavailable');
      const screen = await executeComputer({ action: 'screenshot' });
      let browser;
      if (chromeRunning()) {
        browser = human
          ? 'Google Chrome (human sign-in)'
          : await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2000) })
              .then(r => r.json()).then(v => v.Browser).catch(() => 'Google Chrome (starting)');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: true, display: screen, chrome: chromeRunning() ? (human ? 'human' : 'automation') : 'stopped', browser }));
    } catch { res.writeHead(503); res.end(); }
    return;
  }
  // The debugging endpoint genuinely needs Chrome, so this one still fails when
  // it is closed - but it says so instead of condemning the desktop.
  if (req.url === '/cdp/json/version/') {
    try {
      if (!chromeRunning()) throw new Error('Chrome is not running');
      const version = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2000) }).then(r => r.json());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Use the gateway, never publish Chrome's unauthenticated debug socket.
      res.end(JSON.stringify({ ...version, webSocketDebuggerUrl: `ws://${req.headers.host}/cdp${new URL(version.webSocketDebuggerUrl).pathname}` }));
    } catch { res.writeHead(503); res.end(); }
    return;
  }
  // Chrome writes downloads onto this container's filesystem, which the daemon cannot read.
  // Only a plain name inside the downloads directory is served, so no path can escape it.
  if (req.url.startsWith('/downloads/')) {
    const name = decodeURIComponent(req.url.slice('/downloads/'.length));
    // Real filenames carry spaces, parentheses and non-Latin characters, so the
    // guard is on path shape, not on an alphabet: no separators, no traversal,
    // and the resolved parent must still be the downloads directory.
    if (!name || name.length > 255 || name === '.' || name === '..'
      || name.includes('/') || name.includes('\\') || name.includes('\0')) { res.writeHead(404); res.end(); return; }
    let file = path.join(downloadsDir, name);
    if (path.dirname(path.resolve(file)) !== path.resolve(downloadsDir)) { res.writeHead(404); res.end(); return; }
    if (!fs.existsSync(file)) {
      // Chrome appends " (1)", " (2)" when the name is already taken, and CDP
      // reports only the name it suggested, so the newest suffixed file wins.
      const ext = path.extname(name);
      const base = name.slice(0, name.length - ext.length);
      let newest = -1;
      for (const entry of (() => { try { return fs.readdirSync(downloadsDir); } catch { return []; } })()) {
        if (!entry.startsWith(base + ' (') || !entry.endsWith(')' + ext)) continue;
        if (!/^[0-9]+$/.test(entry.slice(base.length + 2, entry.length - ext.length - 1))) continue;
        const candidate = path.join(downloadsDir, entry);
        const time = fs.statSync(candidate).mtimeMs;
        if (time > newest) { newest = time; file = candidate; }
      }
    }
    let handle;
    try { handle = fs.openSync(file, 'r'); } catch { res.writeHead(404); res.end(); return; }
    const size = fs.fstatSync(handle).size;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) });
    const stream = fs.createReadStream('', { fd: handle, autoClose: true });
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    // The file stays. This is the bot's own Downloads folder on its own computer:
    // deleting after transfer made files vanish from under the person using the
    // desktop. The bot removes what it no longer wants through its file tools.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }

  const next = target(req.url);
  if (!next) { res.writeHead(404); res.end(); return; }
  const upstream = http.get({ host: '127.0.0.1', ...next, timeout: 5000 }, response => {
    res.writeHead(response.statusCode ?? 502, { 'Content-Type': response.headers['content-type'] ?? 'application/octet-stream' });
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on('close', () => upstream.destroy());
});
server.on('upgrade', (req, socket, head) => {
  const next = authorized(req) && !(human && req.url.startsWith('/cdp')) && target(req.url, true);
  if (!next) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  // Never forward the bearer or daemon cookies into Chrome or noVNC.
  const headers = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': req.headers['sec-websocket-key'], 'sec-websocket-version': '13' };
  if (req.headers['sec-websocket-protocol']) headers['sec-websocket-protocol'] = req.headers['sec-websocket-protocol'];
  const upstream = http.request({ host: '127.0.0.1', ...next, headers, timeout: 10000 });
  upstream.on('upgrade', (response, peer, pending) => {
    // The handshake has a deadline; a connected CDP/VNC session must survive idle time.
    upstream.setTimeout(0); peer.setTimeout(0);
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
    if (head.length) peer.write(head);
    if (pending.length) socket.write(pending);
    socket.pipe(peer).pipe(socket);
    socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
    socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
  });
  upstream.on('response', () => socket.destroy());
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  upstream.end();
});
server.listen(6090, '0.0.0.0');
