import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { attachDownloads } from '../src/downloads.mjs';

// A real Electron session/download, isolated from the user's app and profile.
const root = process.env.OH_DOWNLOAD_FIXTURE;
if (!root || !path.isAbsolute(root)) throw new Error('A fixture directory is required.');
app.setPath('userData', path.join(root,'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
const timer = setTimeout(() => { fs.writeFileSync(path.join(root,'error.txt'),'Download timeout'); app.exit(1); },20000);
const expected = 'Exact artifact content\nwith a final newline.\n';
attachDownloads(session.defaultSession,{ isTrusted: c => c === win.webContents, downloadsDirectory: root,
  onComplete: ({state,path:saved}) => {
    clearTimeout(timer);
    const actual = saved && fs.readFileSync(saved,'utf8');
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({state,saved,bytes:actual && Buffer.byteLength(actual),exact:actual===expected,electron:process.versions.electron,platform:process.platform},null,2));
    app.exit(state==='completed' && actual===expected ? 0 : 1);
  } });
// Test-only destination selection replaces human interaction with the dialog.
session.defaultSession.on('will-download',(_e,item)=>item.setSavePath(path.join(root,'downloaded.txt')));
await win.loadURL('data:text/html,<title>Download fixture</title>');
await win.webContents.executeJavaScript(`(() => { const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([${JSON.stringify(expected)}],{type:'text/plain'})); a.download='result.txt'; document.body.append(a); a.click(); })()`);
}).catch(error => { fs.writeFileSync(path.join(root,'error.txt'), String(error.stack ?? error)); app.exit(1); });
