// Invoked by verify-bot-desktop against its disposable bot, never a user profile.
import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const packageRoot = process.env.OPENHOURS_DESKTOP_PACKAGE;
const { contentSecurityPolicy } = await import(packageRoot
  ? pathToFileURL(path.join(packageRoot, 'desktop/src/content-security-policy.mjs')).href
  : new URL('../src/content-security-policy.mjs', import.meta.url).href);
const viewer = new URL(process.env.OH_DESKTOP_VIEWER_URL);
if (viewer.hostname !== '127.0.0.1' || !process.env.OH_DESKTOP_VIEWER_TOKEN) throw new Error('Disposable loopback viewer required');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'oh-live-frame-')));
const deadline = setTimeout(() => { console.error('Live desktop frame timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    headers['Content-Security-Policy'] = [contentSecurityPolicy({ port: Number(viewer.port), url: details.url })];
    callback({ responseHeaders: headers });
  });
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadURL(viewer.origin + '/connect');
  await win.webContents.executeJavaScript(`(async () => {
    const r = await fetch('/api/session', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: ${JSON.stringify(process.env.OH_DESKTOP_VIEWER_TOKEN)}}) });
    if (!r.ok) throw new Error('Fixture authentication failed');
    document.body.replaceChildren();
    const heading = document.createElement('h1'); heading.textContent = 'Embedded bot desktop — Electron regression';
    const iframe = document.createElement('iframe'); iframe.src = ${JSON.stringify(viewer.href)};
    iframe.style.cssText = 'width:100%;height:750px;border:0';
    document.body.append(heading, iframe);
  })()`);
  let painted = false;
  for (let i = 0; i < 100 && !painted; i++) {
    painted = await win.webContents.executeJavaScript(`(() => {
      const doc = document.querySelector('iframe')?.contentDocument;
      if (doc?.getElementById('status')?.textContent !== '') return false;
      const canvas = doc.querySelector('canvas'), ctx = canvas?.getContext('2d');
      if (!ctx || !canvas.width || !canvas.height) return false;
      const data = ctx.getImageData(0,0,canvas.width,canvas.height).data, colors = new Set();
      for (let i=0;i<data.length;i+=400) colors.add(data[i]+','+data[i+1]+','+data[i+2]);
      return colors.size > 30;
    })()`);
    if (!painted) await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!painted) throw new Error('Actual bot desktop did not paint inside Electron iframe');
  if (process.env.OH_DESKTOP_VIEWER_SCREENSHOT) fs.writeFileSync(process.env.OH_DESKTOP_VIEWER_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  console.log('PASS: actual Linux Chrome desktop paints inside a same-origin Electron iframe with production CSP.');
  win.destroy(); clearTimeout(deadline); app.exit(0);
}).catch(error => { console.error(error.stack); clearTimeout(deadline); app.exit(1); });
