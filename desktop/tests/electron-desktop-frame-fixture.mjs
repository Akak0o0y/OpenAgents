// Real Electron rendering regression; isolated profile, synthetic pages, no accounts.
import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { contentSecurityPolicy } from '../src/content-security-policy.mjs';

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'oh-frame-regression-')));
const errors = [];
let server;
const timeout = setTimeout(() => { console.error('Viewer frame test timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/') res.end('<iframe src="/api/desktop/alpha/viewer.html"></iframe>');
    else if (req.url === '/blocked-parent') res.end('<iframe src="/not-a-viewer"></iframe>');
    else res.end('<h1 id="desktop-proof">Desktop frame rendered</h1><input aria-label="Desktop input">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // Negative control retains the original blanket frame denial.
  const policy = url => {
    const value = contentSecurityPolicy({ port, url });
    return process.env.OH_EXPECT_BLOCKED === '1' ? value.replace("frame-ancestors 'self'", "frame-ancestors 'none'") : value;
  };
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy(details.url)] } });
  });
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_event, ...args) => errors.push(args.map(String).join(' ')));
  await win.loadURL(`http://127.0.0.1:${port}/`);
  const rendered = await win.webContents.executeJavaScript(`(() => {
    try { const doc = document.querySelector('iframe').contentDocument;
      const input = doc.querySelector('input'); if (input) input.value = 'Operator input';
      return doc.querySelector('#desktop-proof')?.textContent === 'Desktop frame rendered' && input.value === 'Operator input';
    } catch { return false; }
  })()`);
  if (process.env.OH_EXPECT_BLOCKED === '1') {
    assert.equal(rendered, false, 'Old policy must reproduce the blank viewer');
    console.log('REPRODUCED: Electron blocks the embedded desktop with the old shell CSP.');
  } else {
    assert.equal(rendered, true, 'Bot desktop frame must render and accept input');
    await win.loadURL(`http://127.0.0.1:${port}/blocked-parent`);
    const blocked = await win.webContents.executeJavaScript(`(() => { try { return !document.querySelector('iframe').contentDocument?.querySelector('#desktop-proof'); } catch { return true; } })()`);
    assert.equal(blocked, true, 'Other app pages must remain non-embeddable');
    console.log('PASS: real Electron renders the bot desktop frame; unrelated frames remain blocked.');
  }
  win.destroy();
  clearTimeout(timeout); server.close(); app.exit(0);
}).catch(error => {
  console.error(error.stack, errors.filter(e => /frame|policy/i.test(e)).join('\n'));
  clearTimeout(timeout); server?.close(); app.exit(1);
});
