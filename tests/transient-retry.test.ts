import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsDpapiSecretStore, SecretStoreError } from '../src/daemon/secret-store.js';

/**
 * Routines were dying permanently on failures where nothing had happened yet.
 *
 * Two of them are free to repeat: a gateway 502 means its own upstream failed before any
 * reply began, and a DPAPI timeout means a local decrypt never finished. Neither consumed
 * quota and neither had an effect. What must stay un-retried is anything that may already
 * have run, and anything a retry cannot change.
 */

test('a DPAPI timeout is retried, and a real failure is not', async () => {
  const store = new WindowsDpapiSecretStore(50) as unknown as { runOnce: (op: string, input: string) => Promise<string>; run: (op: string, input: string) => Promise<string> };
  let calls = 0;
  store.runOnce = async () => {
    calls += 1;
    if (calls < 3) throw new SecretStoreError('DPAPI unprotect timed out.');
    return Buffer.from('recovered', 'utf8').toString('base64');
  };
  assert.equal(await store.run('Unprotect', 'x'), Buffer.from('recovered', 'utf8').toString('base64'));
  assert.equal(calls, 3, 'a slow PowerShell start is worth waiting out');

  // A wrong user or corrupt ciphertext is not a timeout. Repeating it would only delay
  // the message that actually tells the operator what to fix.
  calls = 0;
  store.runOnce = async () => { calls += 1; throw new SecretStoreError('DPAPI unprotect failed: Key not valid for use in specified state.'); };
  await assert.rejects(store.run('Unprotect', 'x'), /Key not valid/);
  assert.equal(calls, 1, 'a genuine failure must surface immediately');
});

test('a timeout that never clears gives up rather than retrying forever', async () => {
  const store = new WindowsDpapiSecretStore(10) as unknown as { runOnce: () => Promise<string>; run: (op: string, input: string) => Promise<string> };
  let calls = 0;
  store.runOnce = async () => { calls += 1; throw new SecretStoreError('DPAPI unprotect timed out.'); };
  await assert.rejects(store.run('Unprotect', 'x'), /timed out/);
  assert.equal(calls, 3, 'bounded: a routine that retries forever never reports anything');
});

test('a gateway 502 is retried, and quota is not', async () => {
  const { LiveLLMClient } = await import('../src/evals/llm-client.js');
  const statuses: number[] = [];
  let attempts = 0;
  const responses = [502, 502, 200];
  const client = new LiveLLMClient({
    connections: { resolveForRequest: async () => ({ baseUrl: 'http://gateway.invalid/v1', apiKey: 'k', label: 'FreeLLMAPI' }) } as never,
  } as never) as unknown as { fetchCompletion: (...args: unknown[]) => Promise<Response>; callGateway: (req: unknown, connection: unknown) => Promise<unknown> };
  client.fetchCompletion = async () => {
    const status = responses[attempts++] ?? 200;
    statuses.push(status);
    return new Response(
      status === 200 ? JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }) : 'upstream unavailable',
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  };
  await client.callGateway(
    { modelId: 'nemotron-3-super-120b', systemPrompt: 's', messages: [], maxTokens: 16 },
    { id: 'c1' },
  ).catch(() => undefined);
  // The first two 502s were the gateway's own upstream failing before any reply began.
  assert.deepEqual(statuses, [502, 502, 200], 'a blip must not end the run');

  // Quota is different: the gateway has already exhausted its fallbacks, so waiting
  // changes nothing and the owner needs to hear it now.
  attempts = 0; statuses.length = 0;
  client.fetchCompletion = async () => { statuses.push(429); return new Response('rate limited', { status: 429 }); };
  await client.callGateway({ modelId: 'm', systemPrompt: 's', messages: [], maxTokens: 16 }, { id: 'c1' }).catch(() => undefined);
  assert.deepEqual(statuses, [429], 'a rate limit must surface immediately, not after three waits');
});
