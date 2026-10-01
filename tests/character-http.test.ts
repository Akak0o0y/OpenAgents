import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { DaemonWsServer, fixtureFetch } from './helpers/daemon-client.js';
import type { DaemonReadApi } from '../src/daemon/ws-server.js';

test('disconnect cancels preview but normal request-body completion does not', async () => {
  const port = 4188;
  let capturedSignal: AbortSignal | undefined;
  let resolveSystemCall: ((val: { status: number; body: unknown }) => void) | null = null;
  let systemCalled = false;

  const readApi: DaemonReadApi = {
    system: async (method: string, url: URL, body: unknown, context?: { signal?: AbortSignal }): Promise<{ status: number; body: unknown }> => {
      systemCalled = true;
      capturedSignal = context?.signal;
      return new Promise<{ status: number; body: unknown }>((resolve) => {
        resolveSystemCall = resolve;
      });
    },
    approvals: () => [],
    mcpStatus: () => [],
    getRunEvents: () => [],
    getRunWorkspace: async () => ({ available: false, reason: 'test' }),
    readRunFile: async () => ({ available: false, reason: 'test' }),
  };

  const server = new DaemonWsServer(port, undefined, readApi);
  await server.start();

  try {
    // Case 1: Premature disconnect / socket destruction aborts the signal
    const clientReq = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/system/character-preview',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${server.authToken}`,
      },
    });

    clientReq.on('error', () => {}); // Expected ECONNRESET when deliberately disconnecting below.
    clientReq.write(JSON.stringify({ agentId: 'test-agent', situation: { type: 'post', about: 'test' } }));
    clientReq.end();

    // Wait until system API callback has been entered
    while (!systemCalled || !capturedSignal) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(capturedSignal.aborted, false, 'signal must not be aborted initially');

    // Destroy client request / disconnect socket prematurely
    clientReq.destroy();

    // Wait for res 'close' event in ws-server to trigger signal abort
    const start = Date.now();
    while (!capturedSignal.aborted && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(capturedSignal.aborted, true, 'signal must abort on client disconnect before completion');

    // Clean up pending promise
    if (resolveSystemCall) {
      (resolveSystemCall as (val: { status: number; body: unknown }) => void)({ status: 200, body: {} });
    }

    // Case 2: Normal request-body completion does NOT abort signal
    let normalSignal: AbortSignal | undefined;
    const normalReadApi: DaemonReadApi = {
      system: async (method: string, url: URL, body: unknown, context?: { signal?: AbortSignal }): Promise<{ status: number; body: unknown }> => {
        normalSignal = context?.signal;
        return { status: 200, body: { ok: true } };
      },
      approvals: () => [],
      mcpStatus: () => [],
      getRunEvents: () => [],
      getRunWorkspace: async () => ({ available: false, reason: 'test' }),
      readRunFile: async () => ({ available: false, reason: 'test' }),
    };

    // Replace readApi on server
    (server as any).readApi = normalReadApi;

    const res = await fixtureFetch(`http://127.0.0.1:${port}/api/system/character-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'test-agent', situation: { type: 'post', about: 'test' } }),
    });

    assert.equal(res.status, 200);
    const resBody = await res.json();
    assert.deepEqual(resBody, { ok: true });
    assert.ok(normalSignal, 'normal request must pass signal');
    assert.equal(normalSignal.aborted, false, 'signal must NOT abort on normal request completion');
  } finally {
    await server.close();
  }
});

test('unauthenticated requests never reach character services', async () => {
  const port = 4189;
  let systemCallCount = 0;

  const readApi: DaemonReadApi = {
    system: async (method: string, url: URL, body: unknown, context?: { signal?: AbortSignal }): Promise<{ status: number; body: unknown }> => {
      systemCallCount++;
      return { status: 200, body: { ok: true } };
    },
    approvals: () => [],
    mcpStatus: () => [],
    getRunEvents: () => [],
    getRunWorkspace: async () => ({ available: false, reason: 'test' }),
    readRunFile: async () => ({ available: false, reason: 'test' }),
  };

  const server = new DaemonWsServer(port, undefined, readApi);
  await server.start();

  try {
    // 1. Unauthenticated GET request to /api/system
    const getRes = await globalThis.fetch(`http://127.0.0.1:${port}/api/system?agent=bot-1`);
    assert.equal(getRes.status, 401);
    assert.equal(systemCallCount, 0, 'system API must not be called without auth');

    // 2. Unauthenticated POST request to /api/system/character-preview
    const postRes = await globalThis.fetch(`http://127.0.0.1:${port}/api/system/character-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'bot-1' }),
    });
    assert.equal(postRes.status, 401);
    assert.equal(systemCallCount, 0, 'system API must not be called without auth');
  } finally {
    await server.close();
  }
});
