// Operator acceptance in a separate persistent bot profile. Never copies personal Chrome data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AgentStore } from '../dist/src/daemon/agent-store.js';
import { ArtifactStore } from '../dist/src/daemon/artifacts.js';
import { MemorySecretStore } from '../dist/src/daemon/secret-store.js';
import { BrowserTools } from '../dist/src/daemon/browser-tools.js';
import { BotDesktop } from '../dist/src/daemon/bot-desktop.js';
import { desktopHttp, desktopUpgrade } from '../dist/src/daemon/desktop-viewer.js';

const directory = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'oh-bot-x-acceptance-'));
fs.mkdirSync(directory, { recursive: true });
const store = new AgentStore(path.join(directory, 'acceptance.db'));
if (!store.getAgent('acceptance')) store.createAgent({ id: 'acceptance', name: 'X acceptance bot', model_id: 'no-model', budget_cap_usd: 0, current_status: 'IDLE' });
const desktop = new BotDesktop({ ownerId: directory, stateDir: directory, assetsDir: path.resolve('docker/bot-desktop'), autoProvision: true });
const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), desktop });
const token = randomBytes(32).toString('hex'), connectPath = '/connect/' + randomBytes(32).toString('hex');
let entryUsed = false, port, stopping = false;
const matches = value => { const a = Buffer.from(value ?? ''), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
const authorized = req => matches((req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('oh_acceptance='))?.slice(14));
const trusted = req => req.headers.host === `127.0.0.1:${port}` && (!req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}`) && req.headers['sec-fetch-site'] !== 'cross-site';
const access = id => browser.desktopAccess(id);
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  if (!trusted(req)) { res.writeHead(403); res.end(); return; }
  if (req.method === 'GET' && req.url === connectPath && !entryUsed) {
    entryUsed = true;
    res.writeHead(302, { 'Set-Cookie': `oh_acceptance=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/api/desktop/acceptance/viewer.html' }); res.end(); return;
  }
  if (!authorized(req)) { res.writeHead(401); res.end('This test requires its one-use local connection link.'); return; }
  if (req.url?.startsWith('/api/desktop/')) { desktopHttp(req, res, access); return; }
  if (req.method === 'POST' && req.url === '/stop') { res.writeHead(200); res.end('Stopping the test desktop. Its profile is preserved.'); void stop(); return; }
  res.writeHead(404); res.end();
});
server.on('upgrade', (req, socket, head) => {
  if (!trusted(req) || !authorized(req) || !req.headers.origin) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  desktopUpgrade(req, socket, head, access, (id, close) => browser.desktopOnRevoke(id, close));
});
async function stop() {
  if (stopping) return; stopping = true;
  await browser.stop(); await desktop.stop();
  server.closeAllConnections(); server.close(); store.close();
  console.log('Acceptance service stopped; bot profile retained at ' + directory);
}
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
try {
  const result = await browser.openLogin('acceptance', 'https://x.com/i/flow/login');
  console.log(JSON.stringify({ directory, connectUrl: `http://127.0.0.1:${port}${connectPath}`, warning: result.warning ?? null }));
} catch (error) { console.error(error.message); await stop(); process.exitCode = 1; }
