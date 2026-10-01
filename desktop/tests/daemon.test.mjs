import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, DaemonSupervisor } from '../src/daemon.mjs';

test('desktop authenticates its profile and rejects unrelated or incompatible services', async () => {
  const credentials = { token: 'test-token', profileId: 'profile-a', apiVersion: 1 };
  let profileId = 'profile-a'; let apiVersion = 1; let authorized = false;
  const server = http.createServer((req, res) => {
    authorized = req.headers.authorization === 'Bearer test-token';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ service: 'openhours-daemon', profileId, apiVersion }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.ok(await probe(port, credentials)); assert.equal(authorized, true);
    assert.equal(await probe(port, credentials, 'bot-desktop-v1'), null, 'Do not attach the new shell to the old browser runtime');
    profileId = 'other'; assert.equal(await probe(port, credentials), null);
    profileId = 'profile-a'; apiVersion = 2; assert.equal(await probe(port, credentials), null);
    assert.equal(await probe(port), null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('desktop refuses a port collision without spawning a second daemon', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-desktop-test-'));
  const moduleDir = path.join(root, 'dist/src/daemon'); fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(moduleDir, 'local-auth.js'), 'export const loadLocalCredentials = () => ({token: "fixture", profileId: "expected", apiVersion: 1});');
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const supervisor = new DaemonSupervisor({ appRoot: root, port: server.address().port });
    const [state, same] = await Promise.all([supervisor.start(), supervisor.start()]);
    assert.equal(state.status, 'failed'); assert.equal(same, state);
    assert.match(state.detail, /occupied/); assert.equal(supervisor.child, null); assert.equal(supervisor.owned, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.unlinkSync(path.join(moduleDir, 'local-auth.js')); fs.unlinkSync(path.join(root, 'package.json'));
    fs.rmdirSync(moduleDir); fs.rmdirSync(path.join(root, 'dist/src')); fs.rmdirSync(path.join(root, 'dist')); fs.rmdirSync(root);
  }
});
