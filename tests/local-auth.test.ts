import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { DaemonWsServer } from '../src/daemon/ws-server.js';

test('shutdown closes an idle TCP connection and an incomplete HTTP request', { timeout: 3000 }, async () => {
  const { connect } = await import('node:net');
  const server = new DaemonWsServer(4194);
  await server.start();
  const idle = connect(4194, '127.0.0.1');
  const partial = connect(4194, '127.0.0.1');
  const errors: NodeJS.ErrnoException[] = [];
  idle.on('error', error => errors.push(error));
  partial.on('error', error => errors.push(error));
  try {
    await Promise.all([once(idle, 'connect'), once(partial, 'connect')]);
    partial.write('POST /api/session HTTP/1.1\r\nHost: 127.0.0.1:4194\r\n');
    const closed = Promise.all([idle, partial].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve()))));
    await server.close();
    await closed;
    assert.ok(errors.every(error => error.code === 'ECONNRESET'), 'force-closed sockets may reset on Windows');
  } finally { idle.destroy(); partial.destroy(); await server.close(); }
});

test('local API refuses unauthenticated, forged Host/Origin and unknown socket paths', async () => {
  const port = 4188;
  const server = new DaemonWsServer(port, () => ({ agents: [{ id: 'private-agent' }] }));
  let commands = 0;
  server.onCommand(async () => { commands++; return { success: true }; });
  await server.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${server.authToken}` };
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
    const forgedHost = await new Promise<number>(resolve => http.get(`${base}/health`, { headers: { ...headers, Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode!); }));
    assert.equal(forgedHost, 403);
    const rejectSocket = (suffix: string, options: WebSocket.ClientOptions) => new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${suffix}`, options);
      ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode!); });
      ws.on('error', () => {});
      ws.once('open', () => { ws.close(); reject(new Error('Unexpected accepted socket')); });
    });
    assert.equal(await rejectSocket('/ws', {}), 401);
    assert.equal(await rejectSocket('/ws', { headers, origin: 'https://evil.invalid' }), 403);
    assert.equal(await rejectSocket('/arbitrary', { headers }), 403);
    assert.equal(commands, 0);
    const connect = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token: server.authToken }) });
    assert.equal(connect.status, 204);
    assert.match(connect.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base, headers: { Cookie: connect.headers.get('set-cookie')!.split(';')[0] } });
    await once(ws, 'open'); ws.close(); await once(ws, 'close');
  } finally { await server.close(); }
});


test('profile credentials persist, mismatched profiles fail, and profile locks exclude other writers', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { loadLocalCredentials, acquireProfileLock } = await import('../src/daemon/local-auth.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-auth-test-'));
  const db = path.join(root, 'profile.db');
  try {
    const credentials = loadLocalCredentials(db);
    assert.deepEqual(loadLocalCredentials(db), credentials);
    assert.notEqual(loadLocalCredentials(path.join(root, 'other.db')).profileId, credentials.profileId);
    const release = acquireProfileLock(db);
    try { assert.throws(() => acquireProfileLock(db), /already in use/); }
    finally { release(); }
    const again = acquireProfileLock(db); again();
    fs.writeFileSync(db + '.lock.claim', 'interrupted startup');
    assert.throws(() => acquireProfileLock(db), /Another startup/);
    assert.equal(fs.existsSync(db + '.lock.claim'), true, 'never steal a concurrent startup guard');
    fs.writeFileSync(db + '.auth.json', JSON.stringify({ ...credentials, profileId: 'wrong-profile' }));
    assert.throws(() => loadLocalCredentials(db), /Invalid daemon credentials/);
  } finally {
    for (const entry of fs.readdirSync(root)) fs.unlinkSync(path.join(root, entry));
    fs.rmdirSync(root);
  }
});
