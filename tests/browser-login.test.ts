import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginUrl, unfinishedLogin, rejectedGoogleLogin } from '../src/daemon/browser-login.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { BrowserTools } from '../src/daemon/browser-tools.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';
import type { BotDesktop } from '../src/daemon/bot-desktop.js';
import { setTimeout as delay } from 'node:timers/promises';

for (const mode of ['cancel', 'shutdown', 'deadline', 'cleanup-failure'] as const) {
  test(`login ${mode} during desktop startup releases admission and preserves the profile`, async () => {
    const store = new AgentStore(':memory:');
    store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'test', budget_cap_usd: 1, current_status: 'IDLE' });
    let prepared!: (value: { base: string; token: string }) => void;
    let stops = 0;
    const desktop = {
      provisionStatus: () => ({ state: 'ready' }), status: () => ({ state: 'starting' }), cancelSetup: () => {},
      beginHumanLogin: () => new Promise<{ base: string; token: string }>(resolve => { prepared = resolve; }),
      stopAgent: async () => { stops++; if (mode === 'cleanup-failure') throw new Error('Fixture stop failure'); },
    } as unknown as BotDesktop;
    const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), desktop, loginTimeoutMs: mode === 'deadline' ? 5 : 10000 });
    try {
      const opening = browser.openLogin('alpha', 'https://example.org');
      const rejected = assert.rejects(opening, /cancelled|stopped|timed out|Fixture stop failure/i);
      const runId = store.listTaskRuns()[0].id;
      assert.equal(browser.status().active, 1);
      await assert.rejects(browser.openLogin('alpha', 'https://example.org'), /already open/);
      let closing: Promise<unknown> | undefined;
      if (mode === 'shutdown') closing = browser.stop();
      else if (mode !== 'deadline') closing = mode === 'cleanup-failure'
        ? assert.rejects(browser.cancelLogin('alpha', runId), /could not stop/)
        : browser.cancelLogin('alpha', runId);
      else await delay(25);
      prepared({ base: 'http://127.0.0.1:1', token: 'fixture-only' });
      await rejected; await closing;
      assert.equal(stops, 1, 'owned desktop stops; no home deletion method is called');
      assert.equal(browser.status().active, 0);
      assert.equal(store.getTaskRun(runId)?.status, 'ABORTED');
      assert.equal((await browser.cancelLogin('alpha', runId)).cancelled, false, 'idempotent after termination');
    } finally { await browser.stop(); store.close(); }
  });
}

test('human desktop save failure remains retryable and never reports verified authentication', async () => {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'test', budget_cap_usd: 1, current_status: 'IDLE' });
  let failSave = true;
  const desktop = {
    provisionStatus: () => ({ state: 'ready' }), status: () => ({ state: 'ready' }), cancelSetup: () => {},
    beginHumanLogin: async () => ({ base: 'http://127.0.0.1:1', token: 'fixture-only' }),
    finishHumanLogin: async () => { if (failSave) throw new Error('Chrome could not close cleanly'); },
    stopAgent: async () => {},
  } as unknown as BotDesktop;
  const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), desktop });
  try {
    const opened = await browser.openLogin('alpha', 'https://example.org');
    assert.equal(opened.opened, true);
    await assert.rejects(browser.finishLogin('alpha', 'wrong-run'), /no longer open/);
    await assert.rejects(browser.finishLogin('alpha', opened.runId), /close cleanly/);
    assert.equal(browser.status().active, 1);
    assert.equal(browser.status('alpha').sessions[0]?.login, true);
    failSave = false;
    const result = await browser.finishLogin('alpha', opened.runId);
    assert.equal(result.saved, true);
    assert.equal(result.verified, false);
    assert.equal(browser.status().active, 0);
    assert.equal(store.getTaskRun(opened.runId!)?.status, 'COMPLETED');
  } finally { await browser.stop(); store.close(); }
});

test('X profiles open direct login, other websites retain their requested address', () => {
  assert.equal(loginUrl('https://x.com/example_account?ref=test').href, 'https://x.com/i/flow/login');
  assert.equal(loginUrl('https://www.twitter.com/example_account').href, 'https://x.com/i/flow/login');
  assert.equal(loginUrl('https://example.com/account?next=home').href, 'https://example.com/account?next=home');
  assert.throws(() => loginUrl('https://user:password@x.com'), /embedded credentials/);
  assert.throws(() => loginUrl('file:///tmp/login'), /login URL/);
});

test('X onboarding and Google rejection are not successful sign-ins', () => {
  for (const url of ['https://x.com/i/flow/login', 'https://x.com/i/jf/onboarding/web?mode=signup', 'https://example.com/signin']) assert.equal(unfinishedLogin(url), true);
  assert.equal(unfinishedLogin('https://x.com/home'), false);
  assert.equal(rejectedGoogleLogin('https://accounts.google.com/v3/signin/rejected?app_domain=test'), true);
  assert.equal(rejectedGoogleLogin('https://example.com/v3/signin/rejected'), false);
});
