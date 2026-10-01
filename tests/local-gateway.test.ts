/**
 * FreeLLMAPI run by OpenAgents.
 *
 * The real gateway is a separate project on the owner's machine, so these tests
 * use a stand-in: a tiny server started exactly the way the supervisor starts
 * FreeLLMAPI (a Node process, PORT and HOST in its environment). What they pin
 * down is the part a person would otherwise do by hand - find it, start it on a
 * port nobody else wants, bind it to this computer only, keep it running, and
 * keep the connection pointing at it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_GATEWAY_DEFAULT_PORT, LocalGatewayService, detectFreeLlmApi, isFreeLlmApi, launchPlan } from '../src/daemon/local-gateway.js';

const temporary = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

function fakeCheckout(root: string, name = '@freellmapi/monorepo'): string {
  fs.mkdirSync(path.join(root, 'server', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }));
  return root;
}

/** Answers like a web server and reports the environment it was started with. */
const STAND_IN = `import http from 'node:http';
http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ host: process.env.HOST, port: process.env.PORT, nodeEnv: process.env.NODE_ENV })); })
  .listen(Number(process.env.PORT), process.env.HOST);`;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test('FreeLLMAPI is recognised by its package, found in the usual places, and launched from source or a build', () => {
  const home = temporary('oh-gw-home-');
  try {
    assert.equal(detectFreeLlmApi(home), null);
    fakeCheckout(path.join(home, 'Downloads', 'freellmapi'), 'something-else');
    assert.equal(detectFreeLlmApi(home), null, 'a folder with the right name but another package is not it');
    const checkout = fakeCheckout(path.join(home, 'Desktop', 'freellmapi'));
    assert.equal(detectFreeLlmApi(home), checkout);
    assert.equal(isFreeLlmApi(checkout), true);

    assert.match(String((launchPlan(checkout, 'node') as { error: string }).error), /npm install/);
    fs.mkdirSync(path.join(checkout, 'node_modules', 'tsx', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
    fs.writeFileSync(path.join(checkout, 'server', 'src', 'index.ts'), '');
    assert.deepEqual(launchPlan(checkout, 'node'), { command: 'node', args: [path.join(checkout, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(checkout, 'server', 'src', 'index.ts')] });
    fs.mkdirSync(path.join(checkout, 'server', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'server', 'dist', 'index.js'), '');
    assert.deepEqual(launchPlan(checkout, 'node'), { command: 'node', args: [path.join(checkout, 'server', 'dist', 'index.js')] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the gateway starts on this computer only, moves off a taken port, follows its address, restarts after a crash and stops', { timeout: 60_000 }, async () => {
  const root = temporary('oh-gw-');
  const checkout = fakeCheckout(path.join(root, 'freellmapi'));
  const script = path.join(root, 'stand-in.mjs');
  fs.writeFileSync(script, STAND_IN);
  const configPath = path.join(root, 'profile', 'local-gateway.json');
  const addresses: string[] = [];
  // A program holding the port: accepts connections and never answers. Its
  // sockets are tracked because close() waits for them, and the gateway's
  // probe leaves one open on a server that never replies.
  const heldSockets = new Set<net.Socket>();
  const held = net.createServer((socket) => { heldSockets.add(socket); socket.on('close', () => heldSockets.delete(socket)); });
  const heldPort = await freePort();
  await new Promise<void>((resolve) => held.listen(heldPort, '127.0.0.1', () => resolve()));
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ directory: checkout, port: heldPort, autoStart: true }));

  const gateway = new LocalGatewayService({
    configPath,
    detect: () => null,
    plan: () => ({ command: process.execPath, args: [script] }),
    onAddress: (url) => addresses.push(url),
  });
  try {
    assert.ok(Number(LOCAL_GATEWAY_DEFAULT_PORT) < 49152 && Number(LOCAL_GATEWAY_DEFAULT_PORT) !== 3001, 'a quiet default port, not the common 3001');
    const running = await gateway.start();
    assert.equal(running.state, 'running', running.message);
    assert.notEqual(running.port, heldPort, 'a port another program holds is replaced');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).port, running.port, 'the replacement is remembered');
    assert.deepEqual(addresses, [`http://127.0.0.1:${running.port}/v1`]);
    const env = await (await fetch(running.dashboardUrl)).json();
    assert.deepEqual(env, { host: '127.0.0.1', port: String(running.port), nodeEnv: 'production' }, 'bound to loopback, on the chosen port');

    process.kill(running.pid!);
    await waitFor(() => gateway.status().state === 'starting', 10_000, 'the restart to begin');
    await waitFor(() => gateway.status().state === 'running' && gateway.status().pid !== running.pid, 20_000, 'the restarted gateway');

    const stopped = await gateway.stop();
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.pid, null);
    await assert.rejects(gateway.configure({ directory: root }), /is not a FreeLLMAPI folder/);
    await assert.rejects(gateway.configure({ port: 60_000 }), /between 1025 and 49151/);
  } finally {
    await gateway.stop();
    for (const socket of heldSockets) socket.destroy();
    await new Promise<void>((resolve) => held.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('without a folder the gateway says it was not found and does not try to start', async () => {
  const root = temporary('oh-gw-none-');
  try {
    const gateway = new LocalGatewayService({ configPath: path.join(root, 'local-gateway.json'), detect: () => null });
    assert.equal(gateway.status().state, 'not-found');
    assert.match(gateway.status().message, /Choose its folder/);
    gateway.startIfWanted(true, true);
    assert.equal((await gateway.start()).state, 'not-found');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
