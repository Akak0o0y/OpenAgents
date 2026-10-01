/**
 * Accounts a bot signs in with, and how freely it uses websites.
 *
 * The owner wants to give a bot account details and have it log in and work by
 * itself with Playwright, from its sandbox. The rule that makes that safe is
 * that the details never reach the model: a model reads untrusted pages, and
 * anything it can see, a page can ask it to repeat. These tests pin that down:
 *
 *   1. Details are encrypted, listed without secrets, and released only for
 *      their own site.
 *   2. The card the bot raises saves them through the daemon, and nothing else
 *      can pretend to be that card.
 *   3. In a real browser, driven over Playwright's remote protocol the way the
 *      Docker sandbox is: the bot signs in with `secret`, the password goes only
 *      into a password box, what it reads back is redacted, a site with an
 *      account needs no approval, and "ask" still asks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { BrowserTools, browserAction } from '../src/daemon/browser-tools.js';
import { BrowserAccounts, browserAutonomy, normaliseSite, setBrowserAutonomy, siteMatches } from '../src/daemon/browser-accounts.js';
import { browserEgress } from '../src/daemon/browser-egress.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';
import { ApprovalGate } from '../src/daemon/control-plane.js';
import { systemApi } from '../src/daemon/system-api.js';

const USERNAME = 'alice@example.com';
const PASSWORD = 'Tr0ub4dor&3-never-shown';

function fleet() {
  const store = new AgentStore(':memory:');
  for (const id of ['alpha', 'beta']) store.createAgent({ id, name: id, model_id: 'claude-haiku-4-5', current_status: 'IDLE', budget_cap_usd: 1 });
  return store;
}

const settle = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

test('account details are encrypted, listed without secrets, and released only for their own site', async () => {
  assert.equal(normaliseSite('https://www.GitHub.com/login'), 'github.com');
  assert.equal(normaliseSite('gist.github.com'), 'gist.github.com');
  assert.throws(() => normaliseSite('not a site'), /not a website address/);
  assert.equal(siteMatches('github.com', 'gist.github.com'), true);
  assert.equal(siteMatches('github.com', 'www.github.com'), true);
  assert.equal(siteMatches('github.com', 'evilgithub.com'), false);
  assert.equal(siteMatches('github.com', 'github.com.evil.io'), false);

  const store = fleet();
  const accounts = new BrowserAccounts(store, new MemorySecretStore());
  try {
    const saved = await accounts.save('alpha', { site: 'https://www.github.com/login', username: ` ${USERNAME} `, password: 'first' });
    assert.equal(saved.site, 'github.com');
    assert.equal(saved.label, 'github.com');
    const raw = JSON.stringify(store.getDatabase().prepare('SELECT * FROM bot_accounts').all());
    assert.ok(!raw.includes(USERNAME) && !raw.includes('first'), 'nothing is stored in the clear');
    assert.ok(!JSON.stringify(accounts.list('alpha')).includes(USERNAME), 'the list carries sites and labels only');

    const replaced = await accounts.save('alpha', { site: 'github.com', username: USERNAME, password: PASSWORD });
    assert.equal(replaced.id, saved.id, 'the same site and label replace the details');
    assert.equal(accounts.list('alpha').length, 1);
    assert.equal(await accounts.secretFor('alpha', 'https://gist.github.com/new', 'username'), USERNAME);
    assert.equal(await accounts.secretFor('alpha', 'https://github.com/login', 'password'), PASSWORD);
    await assert.rejects(accounts.secretFor('alpha', 'https://evilgithub.com/login', 'password'), /No saved account for evilgithub\.com/);
    await assert.rejects(accounts.secretFor('alpha', 'https://phish.example/login', 'password', saved.id), /is for another site/);
    await assert.rejects(accounts.secretFor('beta', 'https://github.com/login', 'password'), /No saved account/, 'one bot never uses another bot\'s account');

    const work = await accounts.save('alpha', { site: 'github.com', label: 'Work', username: 'alice-work', password: 'work-pass' });
    await assert.rejects(accounts.secretFor('alpha', 'https://github.com/login', 'username'), /Several accounts are saved for github\.com/);
    assert.equal(await accounts.secretFor('alpha', 'https://github.com/login', 'username', work.id), 'alice-work');

    await assert.rejects(new BrowserAccounts(store, new MemorySecretStore({ available: false })).save('alpha', { site: 'x.com', username: 'a', password: 'b' }), /Fixture store disabled/);
    await assert.rejects(accounts.save('ghost', { site: 'x.com', username: 'a', password: 'b' }), /Unknown bot/);

    assert.equal(browserAutonomy(store, 'alpha'), 'accounts', 'by default a saved account may be used without asking');
    assert.equal(setBrowserAutonomy(store, 'alpha', 'ask'), 'ask');
    assert.equal(browserAutonomy(store, 'alpha'), 'ask');
    assert.throws(() => setBrowserAutonomy(store, 'alpha', 'sometimes'), /Choose ask, accounts or always/);

    assert.deepEqual(accounts.remove('alpha', work.id), { removed: true });
    assert.deepEqual(accounts.remove('beta', saved.id), { removed: false }, 'a bot cannot remove another bot\'s account');
    assert.equal(accounts.list('alpha').length, 1);
  } finally {
    store.close();
  }
});

test('the account card saves through the daemon, and nothing else can pass as that card', async () => {
  const store = fleet();
  const accounts = new BrowserAccounts(store, new MemorySecretStore());
  const gate = new ApprovalGate(store);
  const decided: string[] = [];
  gate.onDecision('account-request', (_record, status) => { decided.push(status); });
  gate.onDecision('routine-create', () => {});
  const api = systemApi({ missions: {} as never, memory: {} as never, retention: {} as never, capacity: {} as never, store, accounts, approvals: gate, abort: () => false });
  const post = (route: string, body: unknown) => api('POST', new URL(`http://127.0.0.1/api/system/${route}`), body);
  try {
    const run = store.createTaskRun({ agentId: 'alpha', taskName: 'chat:thread' });
    const card = gate.propose({ taskRunId: run.id, agentId: 'alpha', kind: 'account-request', payload: { site: 'github.com' } });
    const saved = await post('browser-account', { agentId: 'alpha', site: 'github.com', username: USERNAME, password: PASSWORD, approvalId: card.id });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(!JSON.stringify(saved.body).includes(PASSWORD) && !JSON.stringify(saved.body).includes(USERNAME), 'the response echoes no details');
    await settle(() => decided.length > 0);
    assert.deepEqual(decided, ['APPROVED']);
    assert.equal(store.getApproval(card.id)?.status, 'APPROVED');
    assert.equal(accounts.hasSite('alpha', 'github.com'), true);

    const again = await post('browser-account', { agentId: 'alpha', site: 'github.com', username: 'x', password: 'y', approvalId: card.id });
    assert.equal(again.status, 400);
    assert.match(String((again.body as { error: string }).error), /already answered/);

    const routineCard = gate.propose({ taskRunId: run.id, agentId: 'alpha', kind: 'routine-create', payload: {} });
    const wrongKind = await post('browser-account', { agentId: 'alpha', site: 'x.com', username: 'x', password: 'y', approvalId: routineCard.id });
    assert.match(String((wrongKind.body as { error: string }).error), /not an account request from this bot/);
    const betaRun = store.createTaskRun({ agentId: 'beta', taskName: 'chat:thread' });
    const betaCard = gate.propose({ taskRunId: betaRun.id, agentId: 'beta', kind: 'account-request', payload: { site: 'x.com' } });
    const wrongBot = await post('browser-account', { agentId: 'alpha', site: 'x.com', username: 'x', password: 'y', approvalId: betaCard.id });
    assert.match(String((wrongBot.body as { error: string }).error), /not an account request from this bot/);
    assert.equal(store.getApproval(betaCard.id)?.status, 'PENDING');

    const [account] = accounts.list('alpha');
    assert.deepEqual((await post('browser-account-delete', { agentId: 'alpha', id: account.id })).body, { removed: true });
    assert.deepEqual((await post('browser-autonomy', { agentId: 'alpha', autonomy: 'always' })).body, { autonomy: 'always' });
    assert.equal(browserAutonomy(store, 'alpha'), 'always');
    assert.equal((await post('browser-autonomy', { agentId: 'alpha', autonomy: 'maybe' })).status, 400);
  } finally {
    store.close();
  }
});

test('in a remotely driven browser the bot signs in by itself, never sees the details, and asks only where it should', { timeout: 90_000 }, async () => {
  const logins: Array<Record<string, string>> = [];
  const site = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const fields = Object.fromEntries(new URLSearchParams(body));
        logins.push(fields);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<title>Welcome</title><h1>Dashboard</h1><p>Signed in as ${fields.email}</p>`);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Sign in</title><form method="post" action="/login"><label>Email<input name="email" type="email"></label><label>Password<input name="password" type="password"></label><label>Comment<textarea name="comment"></textarea></label><button>Sign in</button></form>');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const origin = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;

  // A Playwright server, as the sandbox runs one, and the proxy its browser uses.
  const serverPort = await new Promise<number>((resolve) => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); }); });
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js');
  const server = spawn(process.execPath, [cli, 'run-server', '--port', String(serverPort), '--host', '127.0.0.1', '--path', '/secret-path', '--unsafe'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    server.stdout.on('data', (chunk) => { if (/Listening on/.test(String(chunk))) resolve(); });
    server.once('exit', (code) => reject(new Error(`run-server exited ${code}`)));
  });
  const egress = await browserEgress([origin]);

  const store = fleet();
  const secrets = new MemorySecretStore();
  const accounts = new BrowserAccounts(store, secrets);
  const artifacts = new ArtifactStore(store);
  const gate = new ApprovalGate(store);
  const decide = setInterval(() => { for (const row of store.listApprovals({ pendingOnly: true })) gate.decide(row.id, 'DENIED', 'Fixture operator'); }, 10);
  const sandbox = { endpoint: () => ({ wsEndpoint: `ws://127.0.0.1:${serverPort}/secret-path`, proxy: egress.url }), status: () => ({ state: 'ready' as const, message: 'ready', image: 'fixture' }), markBroken: () => {} };
  const browser = new BrowserTools({ store, artifacts, secrets, approvals: gate, accounts, sandbox });
  const signal = new AbortController().signal;
  const start = (agentId: string) => { const run = store.createTaskRun({ agentId, taskName: 'browser-accounts' }); store.startTaskRun(run.id, 'claude-haiku-4-5'); return run; };
  const call = (run: { id: string; agent_id: string }, action: object) => browser.call(run.agent_id, run.id, browserAction.parse({ tool: 'browser', ...action }), signal);
  try {
    await accounts.save('alpha', { site: '127.0.0.1', username: USERNAME, password: PASSWORD });
    await accounts.save('beta', { site: 'example.com', username: 'beta-user', password: 'beta-pass' });
    assert.equal(browser.status('alpha').isolation, 'sandbox');

    const run = start('alpha');
    await call(run, { action: 'navigate', url: origin });
    assert.equal(browser.status('alpha').sessions[0].isolation, 'sandbox', 'the session runs in the remote browser');
    const typedName = await call(run, { action: 'fill', target: { role: 'textbox', name: 'Email' }, secret: 'username' });
    assert.ok(!typedName.snapshot.includes(USERNAME), 'the page read back does not show the username');
    assert.match(typedName.snapshot, /\[saved username\]/);
    await assert.rejects(call(run, { action: 'fill', target: { role: 'textbox', name: 'Comment' }, secret: 'password' }), /only into a password field/);
    await assert.rejects(call(run, { action: 'fill', target: { role: 'textbox', name: 'Comment' }, secret: 'username' }), /only into a username or email box/);
    await assert.rejects(call(run, { action: 'fill', target: { role: 'textbox', name: 'Email' }, secret: 'username', value: 'x' }), /either value or secret/);
    await call(run, { action: 'fill', target: { role: 'textbox', name: 'Password' }, secret: 'password' });
    const signedIn = await call(run, { action: 'click', target: { role: 'button', name: 'Sign in' } });
    assert.deepEqual(logins, [{ email: USERNAME, password: PASSWORD, comment: '' }], 'the site received the real details');
    assert.match(signedIn.snapshot, /Signed in as \[saved username\]/);
    assert.equal(store.listApprovals({}).length, 0, 'a site with a saved account needed no approval');
    const events = store.getDatabase().prepare('SELECT event_type, payload_json FROM execution_events WHERE task_run_id = ?').all(run.id) as Array<{ event_type: string; payload_json: string }>;
    assert.ok(events.some((row) => row.event_type === 'BROWSER_INTERACTION_ALLOWED' && JSON.parse(row.payload_json).autonomy === 'accounts'));
    assert.ok(events.some((row) => row.event_type === 'BROWSER_OPENED' && JSON.parse(row.payload_json).isolation === 'sandbox'));
    assert.ok(!JSON.stringify(events).includes(PASSWORD) && !JSON.stringify(events).includes(USERNAME), 'no event carries a detail');
    assert.ok(!JSON.stringify(browser.status('alpha')).includes(PASSWORD));
    await browser.endRun(run.id);

    const other = start('beta');
    await call(other, { action: 'navigate', url: origin });
    await assert.rejects(call(other, { action: 'fill', target: { role: 'textbox', name: 'Email' }, secret: 'username' }), /No saved account for 127\.0\.0\.1/);
    const betaAccount = accounts.list('beta')[0];
    await assert.rejects(call(other, { action: 'fill', target: { role: 'textbox', name: 'Password' }, secret: 'password', account: betaAccount.id }), /for another site/);
    await browser.endRun(other.id);

    setBrowserAutonomy(store, 'alpha', 'ask');
    const careful = start('alpha');
    await call(careful, { action: 'navigate', url: origin });
    await assert.rejects(call(careful, { action: 'fill', target: { role: 'textbox', name: 'Email' }, value: 'typed by the bot' }), /not approved/);
    assert.equal(store.listApprovals({}).length, 1, '"ask" asks, even where an account is saved');
    assert.equal(logins.length, 1);
    await browser.endRun(careful.id);
  } finally {
    clearInterval(decide);
    await browser.stop();
    store.close();
    await egress.close();
    server.kill();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});
