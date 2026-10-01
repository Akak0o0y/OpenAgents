import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { BrowserTools, BrowserBusy, UncertainExternalEffect, browserAction } from '../src/daemon/browser-tools.js';
import { setBrowserAutonomy } from '../src/daemon/browser-accounts.js';
import type { BotDesktop } from '../src/daemon/bot-desktop.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';
import { ApprovalGate } from '../src/daemon/control-plane.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, Page } from 'playwright';
import { xCreateTweet, textSha256, type PublishProbe } from '../src/daemon/publish-probes.js';
import type { PublishWatch, RunPolicy } from '../src/daemon/browser-publish.js';
import { xFixture, type XFixtureToggles } from './helpers/x-fixture.js';

test('real Playwright sessions isolate bots, gate writes, retain captures and downloads and release capacity', { timeout: 60000 }, async () => {
  let posts = 0;
  const cookies: string[] = [];
  const server = http.createServer(async (req, res) => {
    cookies.push(req.headers.cookie ?? '');
    if (req.url === '/file') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="evidence.txt"' }); res.end('download evidence bytes'); return; }
    if (req.method === 'POST') { posts++; res.setHeader('Set-Cookie', 'botsecret=owned-by-a; Path=/'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Controlled browser task</title><h1>Browser fixture</h1><form method="post"><label>Note<input name="note"></label><label>Attachment<input type="file"></label><button>Save</button></form><a href="/file">Download evidence</a>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new AgentStore(':memory:'); const artifacts = new ArtifactStore(store); const gate = new ApprovalGate(store);
  for (const id of ['alpha', 'beta']) store.createAgent({ id, name: id, model_id: 'claude-haiku-4-5', current_status: 'IDLE', budget_cap_usd: 1 });
  const start = (agentId: string) => { const run = store.createTaskRun({ agentId, taskName: 'browser-test' }); store.startTaskRun(run.id, 'claude-haiku-4-5'); return run; };
  const a = start('alpha'), b = start('beta');
  const browser = new BrowserTools({ store, artifacts, secrets: new MemorySecretStore(), approvals: gate, previewOrigins: [origin], maxBrowsers: 2 });
  const signal = new AbortController().signal;
  let approve = false;
  const decide = setInterval(() => { for (const row of store.listApprovals({ pendingOnly: true })) gate.decide(row.id, approve ? 'APPROVED' : 'DENIED', 'Fixture operator'); }, 10);
  const call = (run: typeof a, action: unknown) => browser.call(run.agent_id, run.id, browserAction.parse({ tool: 'browser', ...action as object }), signal);
  try {
    const page = await call(a, { action: 'navigate', url: origin }); assert.match(page.snapshot, /Browser fixture/);
    await assert.rejects(call(a, { action: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'denied' }), /not approved/);
    assert.equal(posts, 0);
    approve = true;
    await call(a, { action: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'approved fixture' });
    await call(a, { action: 'click', target: { role: 'button', name: 'Save' } });
    assert.equal(posts, 1);
    const captures = await call(a, { action: 'screenshot' });
    assert.ok(captures.artifact);
    const downloaded = await call(a, { action: 'download', target: { role: 'link', name: 'Download evidence' } });
    assert.equal(downloaded.artifact?.sha256, createHash('sha256').update('download evidence bytes').digest('hex'));
    assert.equal(artifacts.list(a.id).length, 0, 'captures are not completed deliverables');
    assert.equal(artifacts.list(a.id, true).length, 2);
    const other = await call(b, { action: 'navigate', url: origin }); assert.match(other.snapshot, /Browser fixture/);
    assert.deepEqual(browser.status('alpha').sessions.map(s => s.agentId), ['alpha'], 'capability context does not expose other bots pages');
    assert.equal(cookies.at(-1), '', 'another bot has no cookie from alpha');
    await assert.rejects(browser.call('beta', a.id, browserAction.parse({ tool: 'browser', action: 'snapshot' }), signal), /belong/);
    const extra = start('alpha'); await assert.rejects(call(extra, { action: 'navigate', url: origin }), /already has/);
    await assert.rejects(call(b, { action: 'navigate', url: 'http://127.0.0.1:9/private' }), /ERR_|net::/);
    await browser.endRun(a.id); await browser.endRun(b.id);
    assert.equal(browser.status().active, 0);
    const resumed = start('alpha'); await call(resumed, { action: 'navigate', url: origin });
    assert.match(cookies.at(-1)!, /botsecret=owned-by-a/);
    assert.equal(posts, 1, 'restoration does not submit again');
    const source = artifacts.save(a.id, { 'upload.txt': 'scoped upload content' })[0];
    await call(resumed, { action: 'upload', target: { role: 'file', name: 'Attachment' }, sourceRunId: a.id, artifactId: source.id });
    await browser.endRun(resumed.id);
    assert.equal(browser.status().active, 0);
    const crashed = start('alpha'); await call(crashed, { action: 'navigate', url: origin });
    // Fault injection uses the real owned Chromium PID; it never targets the user's browser.
    const session = (browser as unknown as { sessions: Map<string, { browser: Browser }> }).sessions.get(crashed.id)!;
    const cdp = await session.browser.newBrowserCDPSession();
    const processes = await cdp.send('SystemInfo.getProcessInfo');
    const browserPid = processes.processInfo.find(p => p.type === 'browser')!.id;
    await cdp.detach(); process.kill(browserPid, 'SIGKILL');
    for (let i = 0; i < 500 && browser.status().active; i++) await delay(10);
    assert.equal(browser.status().active, 0, 'a crashed worker releases its browser slot');
    const reopened = start('alpha'); await call(reopened, { action: 'navigate', url: origin });
    assert.equal(posts, 1, 'worker restart does not repeat a submission');
    await browser.endRun(reopened.id);
    const opening = call(start('alpha'), { action: 'navigate', url: origin });
    const interrupted = assert.rejects(opening, /stopped|closed|abort/i);
    await browser.stop(); await interrupted;
    assert.equal(browser.status().active, 0, 'shutdown during startup releases acquired capacity');
  } finally {
    clearInterval(decide); await browser.stop(); store.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('idle cleanup preserves active downloads and provider thinking, but cancellation and terminal cleanup still work', { timeout: 30000 }, async () => {
  const bytes = Buffer.alloc(128 * 1024, 17);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="slow.bin"' });
      res.write(bytes.subarray(0, 100));
      await delay(600);
      res.end(bytes.subarray(100));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Lifetime fixture</title><a href="/slow">Slow download</a>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new AgentStore(':memory:'), artifacts = new ArtifactStore(store), approvals = new ApprovalGate(store);
  store.createAgent({ id: 'lifetime', name: 'Lifetime', model_id: 'fixture', current_status: 'IDLE', budget_cap_usd: 1 });
  const browser = new BrowserTools({ store, artifacts, approvals, secrets: new MemorySecretStore(), previewOrigins: [origin], idleTimeoutMs: 30 });
  const decide = setInterval(() => { for (const row of store.listApprovals({ pendingOnly: true })) approvals.decide(row.id, 'APPROVED', 'Local fixture only'); }, 10);
  const start = () => { const run = store.createTaskRun({ agentId: 'lifetime', taskName: 'lifetime' }); store.startTaskRun(run.id, 'fixture'); return run; };
  const waitClosed = async () => { for (let i = 0; i < 200 && browser.status().active; i++) await delay(10); assert.equal(browser.status().active, 0); };
  const call = (id: string, signal: AbortSignal, action: object) => browser.call('lifetime', id, browserAction.parse({ tool: 'browser', ...action }), signal);
  try {
    const run = start(), controller = new AbortController();
    await call(run.id, controller.signal, { action: 'navigate', url: origin });
    await delay(150);
    assert.equal(browser.status().active, 1, 'model thinking must not lose its existing page');
    const result = await call(run.id, controller.signal, { action: 'download', target: { role: 'link', name: 'Slow download' } });
    assert.equal(result.artifact?.sha256, createHash('sha256').update(bytes).digest('hex'));
    store.finishTaskRun(run.id, 'COMPLETED');
    await waitClosed();

    const cancelled = start(), abort = new AbortController();
    await call(cancelled.id, abort.signal, { action: 'navigate', url: origin });
    const pending = call(cancelled.id, abort.signal, { action: 'download', target: { role: 'link', name: 'Slow download' } });
    const rejected = assert.rejects(pending, /closed|abort|cancel|uncertain/i);
    await delay(100); abort.abort(new Error('Fixture cancellation'));
    await rejected; await waitClosed();
  } finally {
    clearInterval(decide); await browser.stop(); store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// Publish seams (Stage 1, spec 6.3). Local managed Chromium only: nothing here proves Linux Chrome or CDP behaviour.
const SEAM_PAGE = '<title>Seam fixture</title><label>Note<input name="note"></label><button type="button">Plain</button><a href="/file">Download evidence</a>';
async function seamSite() {
  const server = http.createServer((req, res) => {
    if (req.url === '/file') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="seam.txt"' }); res.end('seam download bytes'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(SEAM_PAGE);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
type BrowserToolsOptions = ConstructorParameters<typeof BrowserTools>[0];
function seamRig(origin: string, extra: Partial<BrowserToolsOptions> = {}) {
  const store = new AgentStore(':memory:');
  for (const id of ['alpha', 'beta']) { store.createAgent({ id, name: id, model_id: 'fixture', current_status: 'IDLE', budget_cap_usd: 1 }); setBrowserAutonomy(store, id, 'always'); }
  const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), previewOrigins: [origin], ...extra });
  const start = (agentId = 'alpha') => { const run = store.createTaskRun({ agentId, taskName: 'seam-test' }); store.startTaskRun(run.id, 'fixture'); return run.id; };
  const call = (runId: string, action: object, agentId = 'alpha') => browser.call(agentId, runId, browserAction.parse({ tool: 'browser', ...action }), new AbortController().signal);
  const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('Expected the call to fail.'); }, (error: unknown) => error as Error);
  return { store, browser, start, call, failure, async close() { await browser.stop(); store.close(); } };
}

test('a failure after a dispatched fill is an UncertainExternalEffect with the existing text', { timeout: 60000 }, async () => {
  const site = await seamSite();
  const rig = seamRig(site.origin, { testHooks: { afterDispatch: async (_actionId, action) => { if (action === 'fill') throw new Error('Injected after-dispatch failure.'); } } });
  try {
    const run = rig.start();
    await rig.call(run, { action: 'navigate', url: site.origin });
    const error = await rig.failure(rig.call(run, { action: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'seam note' }));
    assert.ok(error instanceof UncertainExternalEffect);
    assert.equal(error.message, 'Browser interaction outcome is uncertain. Inspect the page and action history; do not repeat the submission automatically.');
    assert.match(error.message, /outcome is uncertain/, 'the regex consumers keep matching');
    const types = rig.store.getTaskEvents(run).map(e => e.event_type);
    assert.equal(types.filter(type => type === 'EXTERNAL_ACTION_STARTED').length, 1);
    assert.equal(types.includes('EXTERNAL_ACTION_FINISHED'), false);
  } finally { await rig.close(); await site.close(); }
});

test('a download that finished before a later failure keeps its own error', { timeout: 60000 }, async () => {
  const site = await seamSite();
  const rig = seamRig(site.origin, { testHooks: { afterDispatch: async (_actionId, action) => { if (action === 'download') throw new Error('Injected failure after the download.'); } } });
  try {
    const run = rig.start();
    await rig.call(run, { action: 'navigate', url: site.origin });
    const error = await rig.failure(rig.call(run, { action: 'download', target: { role: 'link', name: 'Download evidence' } }));
    assert.equal(error instanceof UncertainExternalEffect, false);
    assert.equal(error.message, 'Injected failure after the download.');
    const events = rig.store.getTaskEvents(run);
    const ids = (type: string) => events.filter(e => e.event_type === type).map(e => JSON.parse(e.payload_json).actionId as string);
    assert.equal(ids('EXTERNAL_ACTION_STARTED').length, 1);
    assert.deepEqual(ids('EXTERNAL_ACTION_FINISHED'), ids('EXTERNAL_ACTION_STARTED'), 'uncertain only when a STARTED of the call is left without FINISHED');
  } finally { await rig.close(); await site.close(); }
});

test('BrowserBusy carries both existing texts', { timeout: 60000 }, async () => {
  const site = await seamSite();
  const rig = seamRig(site.origin, { maxBrowsers: 1 });
  try {
    await rig.call(rig.start(), { action: 'navigate', url: site.origin });
    const sameBot = await rig.failure(rig.call(rig.start(), { action: 'navigate', url: site.origin }));
    assert.ok(sameBot instanceof BrowserBusy);
    assert.equal(sameBot.message, 'This bot already has a browser session in another run. Wait for it to finish.');
    const full = await rig.failure(rig.call(rig.start('beta'), { action: 'navigate', url: site.origin }, 'beta'));
    assert.ok(full instanceof BrowserBusy);
    assert.equal(full.message, 'Browser capacity is full. Retry in a later bounded run.');
  } finally { await rig.close(); await site.close(); }
});

test('requireFreshObservation refuses with its own reason until a snapshot, and the operator text is unchanged', { timeout: 60000 }, async () => {
  const site = await seamSite();
  const rig = seamRig(site.origin);
  try {
    const run = rig.start();
    const plain = { action: 'click', target: { role: 'button', name: 'Plain' } };
    await rig.call(run, { action: 'navigate', url: site.origin });
    rig.browser.requireFreshObservation('alpha', run, 'Custom reason.');
    assert.equal((await rig.failure(rig.call(run, plain))).message, 'Custom reason.');
    await rig.call(run, { action: 'snapshot' });
    await rig.call(run, plain);
    rig.browser.markOperatorActed('alpha', run);
    assert.equal((await rig.failure(rig.call(run, plain))).message, 'The operator interacted with this page. Take a fresh browser snapshot and check what changed before acting. Do not repeat a submission the operator may have completed.');
    await rig.call(run, { action: 'snapshot' });
    await rig.call(run, plain);
  } finally { await rig.close(); await site.close(); }
});

test('call() keeps the one-action lease and its text', { timeout: 60000 }, async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const dispatched = new Promise<void>(resolve => { reached = resolve; });
  const site = await seamSite();
  const rig = seamRig(site.origin, { testHooks: { afterDispatch: async (_actionId, action) => { if (action === 'fill') { reached(); await held; } } } });
  try {
    const run = rig.start();
    await rig.call(run, { action: 'navigate', url: site.origin });
    const filling = rig.call(run, { action: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'held fill' });
    await dispatched;
    assert.equal((await rig.failure(rig.call(run, { action: 'snapshot' }))).message, 'An interaction is already running. Observe after it finishes.');
    release(); await filling;
  } finally { release(); await rig.close(); await site.close(); }
});

test('the run record outlives the session until clearRunPolicy; a session without one gets an ephemeral record', { timeout: 60000 }, async () => {
  const site = await seamSite();
  const rig = seamRig(site.origin);
  const runs = (rig.browser as unknown as { runs: Map<string, { ephemeral: boolean }> }).runs;
  try {
    const routine = rig.start();
    rig.browser.setRunPolicy(routine, { publishLimit: 1 });
    assert.deepEqual(rig.browser.publishes(routine), []);
    await rig.call(routine, { action: 'navigate', url: site.origin });
    await rig.browser.endRun(routine);
    assert.equal(runs.get(routine)?.ephemeral, false, 'endRun keeps a policy record');
    assert.deepEqual(rig.browser.publishes(routine), []);
    rig.browser.clearRunPolicy(routine);
    assert.equal(runs.has(routine), false);
    const plain = rig.start();
    await rig.call(plain, { action: 'navigate', url: site.origin });
    assert.equal(runs.get(plain)?.ephemeral, true);
    assert.throws(() => rig.browser.setRunPolicy(plain, { publishLimit: 1 }), /before the run opens its browser/);
    await rig.browser.endRun(plain);
    assert.equal(runs.has(plain), false, 'endRun drops an ephemeral record');
  } finally { await rig.close(); await site.close(); }
});

test('testHooks.beforeOpen counts session-open attempts per run', { timeout: 30000 }, async () => {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'alpha', name: 'alpha', model_id: 'fixture', current_status: 'IDLE', budget_cap_usd: 1 });
  const attempts: Array<[string, number]> = [];
  // No container starts: this stand-in desktop refuses to prepare, after the hook has run.
  const desktop = { prepare: async () => { throw new Error('No fixture desktop.'); }, provisionStatus: () => ({ state: 'ready' }), status: () => ({ state: 'stopped' }), cancelSetup: () => {} } as unknown as BotDesktop;
  const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), desktop,
    testHooks: { beforeOpen: async (runId, attempt) => { attempts.push([runId, attempt]); if (attempt === 1) throw new Error('Injected open failure.'); } } });
  const run = store.createTaskRun({ agentId: 'alpha', taskName: 'seam-test' }); store.startTaskRun(run.id, 'fixture');
  const navigate = () => browser.call('alpha', run.id, browserAction.parse({ tool: 'browser', action: 'navigate', url: 'https://example.invalid/' }), new AbortController().signal);
  try {
    await assert.rejects(navigate(), /Injected open failure/);
    await assert.rejects(navigate(), /No fixture desktop/);
    assert.deepEqual(attempts, [[run.id, 1], [run.id, 2]]);
    assert.equal(browser.status().active, 0, 'a failed open releases its capacity');
    assert.equal((browser as unknown as { runs: Map<string, unknown> }).runs.has(run.id), false, 'a failed open drops its ephemeral record');
  } finally { await browser.stop(); store.close(); }
});

/** A bot with autonomy 'always' on the X-shaped fixture, with xCreateTweet for the fixture's origin unless probes says otherwise. */
async function publishRig(toggles: XFixtureToggles = {}, extra: { probes?: ((origin: string) => PublishProbe[]) | null; testHooks?: BrowserToolsOptions['testHooks']; fixtureRoutes?: (origin: string) => NonNullable<BrowserToolsOptions['fixtureRoutes']> } = {}) {
  const site = await xFixture(toggles);
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'fixture', current_status: 'IDLE', budget_cap_usd: 1 });
  setBrowserAutonomy(store, 'alpha', 'always');
  const probes = extra.probes === null ? undefined : (extra.probes ?? (origin => [xCreateTweet([origin])]))(site.origin);
  const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), previewOrigins: [site.origin],
    publishProbes: probes, testHooks: extra.testHooks, fixtureRoutes: extra.fixtureRoutes?.(site.origin) });
  const idle = new AbortController().signal;
  const start = (policy?: RunPolicy) => { const run = store.createTaskRun({ agentId: 'alpha', taskName: 'publish-seam' }); store.startTaskRun(run.id, 'fixture'); if (policy) browser.setRunPolicy(run.id, policy); return run.id; };
  const call = (runId: string, action: object, signal = idle) => browser.call('alpha', runId, browserAction.parse({ tool: 'browser', ...action }), signal);
  const payloads = (runId: string, type: string) => store.getTaskEvents(runId).filter(e => e.event_type === type).map(e => JSON.parse(e.payload_json) as Record<string, unknown>);
  const composeReply = async (runId: string, k: number, text: string, signal = idle) => {
    await call(runId, { action: 'navigate', url: site.origin + site.statusPath(k) }, signal);
    await call(runId, { action: 'fill', target: { role: 'textbox', name: 'Post text' }, value: text }, signal);
  };
  const clickReply = (runId: string, signal = idle) => call(runId, { action: 'click', target: { role: 'button', name: 'Reply' } }, signal);
  const until = async (done: () => boolean, ms = 20_000) => { const end = Date.now() + ms; while (!done() && Date.now() < end) await delay(25); assert.ok(done(), 'The fixture condition was not reached in time.'); };
  const page = (runId: string) => (browser as unknown as { sessions: Map<string, { page: Page }> }).sessions.get(runId)!.page;
  const watch = (runId: string) => (browser as unknown as { runs: Map<string, { watch: PublishWatch }> }).runs.get(runId)!.watch;
  return { site, store, browser, start, call, payloads, composeReply, clickReply, until, page, watch,
    async close() { await browser.stop(); store.close(); await site.close(); } };
}

test('a reply is recorded as PUBLISH_ATTEMPTED before it reaches the site, and its confirmation carries the post URL (assumed X response shape)', { timeout: 60000 }, async () => {
  const rig = await publishRig();
  try {
    const run = rig.start({ publishLimit: 1 });
    const text = 'Fixture reply that is recorded before it is sent.';
    await rig.composeReply(run, 1, text);
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_OBSERVED').length === 1);
    const attempts = rig.store.getTaskEvents(run).filter(e => e.event_type === 'PUBLISH_ATTEMPTED');
    assert.equal(attempts.length, 1);
    assert.equal(rig.site.state.requests, 1);
    assert.ok(attempts[0].timestamp <= rig.site.state.receivedAt[0], 'the attempt is durable before the site receives the request');
    const attempted = JSON.parse(attempts[0].payload_json) as Record<string, unknown>;
    const click = rig.payloads(run, 'EXTERNAL_ACTION_STARTED').find(p => p.action === 'click');
    assert.equal(attempted.by, 'model');
    assert.equal(attempted.actionId, click?.actionId);
    assert.equal(attempted.op, 'reply');
    assert.equal(attempted.origin, rig.site.origin);
    assert.equal(attempted.inReplyTo, rig.site.statusPath(1).split('/').at(-1));
    assert.equal(attempted.textSha256, textSha256(text));
    const observed = rig.payloads(run, 'PUBLISH_OBSERVED')[0];
    assert.equal(observed.outcome, 'confirmed');
    assert.equal(observed.postUrl, `${rig.site.origin}/fixture_bot/status/${rig.site.state.created[0].id}`);
  } finally { await rig.close(); }
});

test('without a readable account link the post URL is /i/status/<id> (assumed X response shape)', { timeout: 60000 }, async () => {
  const rig = await publishRig({ noProfileLink: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 2, 'A reply on a page without a Profile link.');
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_OBSERVED').length === 1);
    assert.equal(rig.payloads(run, 'PUBLISH_OBSERVED')[0].postUrl, `${rig.site.origin}/i/status/${rig.site.state.created[0].id}`);
  } finally { await rig.close(); }
});

test('a second Reply in a routine run is refused for budget and never reaches the site', { timeout: 60000 }, async () => {
  const rig = await publishRig({ keepComposer: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 3, 'The one reply this routine run may send.');
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_OBSERVED').length === 1);
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_REFUSED').length === 1);
    const refused = rig.payloads(run, 'PUBLISH_REFUSED')[0];
    assert.equal(refused.reason, 'budget');
    assert.equal(refused.by, 'model');
    assert.equal(rig.site.state.requests, 1, 'the refused request never left Chrome');
    assert.equal(rig.payloads(run, 'PUBLISH_ATTEMPTED').length, 1);
  } finally { await rig.close(); }
});

test('outside a routine run both posts are tracked and neither is refused (assumed X response shape)', { timeout: 60000 }, async () => {
  const rig = await publishRig({ keepComposer: true });
  try {
    const run = rig.start();
    const post = () => rig.call(run, { action: 'click', target: { role: 'button', name: 'Post' } });
    await rig.call(run, { action: 'navigate', url: rig.site.origin + '/home' });
    await rig.call(run, { action: 'fill', target: { role: 'textbox', name: 'Post text' }, value: 'An original fixture post outside any routine.' });
    await post();
    await rig.until(() => rig.payloads(run, 'PUBLISH_OBSERVED').length === 1);
    await post();
    await rig.until(() => rig.payloads(run, 'PUBLISH_OBSERVED').length === 2);
    assert.equal(rig.site.state.requests, 2);
    assert.equal(rig.payloads(run, 'PUBLISH_REFUSED').length, 0);
    assert.deepEqual(rig.browser.publishes(run).map(record => [record.op, record.state]), [['post', 'confirmed'], ['post', 'confirmed']]);
  } finally { await rig.close(); }
});

test('an operator post during takeover is tracked by:"operator", never refused, charged to the budget, and its text is never noted', { timeout: 60000 }, async () => {
  const rig = await publishRig({ keepComposer: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    const text = 'Typed by the operator during takeover.';
    await rig.call(run, { action: 'navigate', url: rig.site.origin + rig.site.statusPath(3) });
    await rig.browser.control('alpha', { action: 'takeover' });
    await rig.browser.control('alpha', { action: 'click', x: 500, y: 50 });
    await rig.browser.control('alpha', { action: 'type', text });
    await rig.browser.control('alpha', { action: 'click', x: 280, y: 120 });
    await rig.until(() => rig.payloads(run, 'PUBLISH_ATTEMPTED').length === 1);
    await rig.browser.control('alpha', { action: 'resume' });
    const attempted = rig.payloads(run, 'PUBLISH_ATTEMPTED')[0];
    assert.equal(attempted.by, 'operator');
    assert.equal(attempted.actionId, undefined);
    assert.equal(attempted.textSha256, textSha256(text), 'the hash comes from the request body, not from a note');
    assert.equal(rig.watch(run).textFor(rig.browser.publishes(run)[0]), undefined, 'operator text is never noted');
    assert.equal(rig.payloads(run, 'PUBLISH_REFUSED').length, 0);
    await rig.call(run, { action: 'snapshot' });
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_REFUSED').length === 1);
    assert.equal(rig.payloads(run, 'PUBLISH_REFUSED')[0].reason, 'budget');
    assert.equal(rig.site.state.requests, 1);
  } finally { await rig.close(); }
});

test('an operator post made directly on the page after takeover (the bot desktop view, not control()) is the operator\'s and is never refused (assumed X response shape)', { timeout: 60000 }, async () => {
  const rig = await publishRig({ keepComposer: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 3, 'The bot replies to this post first.');
    await rig.clickReply(run);
    await rig.until(() => rig.browser.publishes(run).some(r => r.state === 'confirmed'));
    await rig.browser.control('alpha', { action: 'takeover' });
    // On the bot desktop the owner acts on the live desktop stream: nothing goes through control().
    const page = rig.page(run);
    await page.mouse.click(500, 50);
    await page.keyboard.type(' And the owner adds a reply of their own by hand.');
    await page.mouse.click(280, 120);
    await rig.until(() => rig.payloads(run, 'PUBLISH_ATTEMPTED').length === 2);
    const second = rig.payloads(run, 'PUBLISH_ATTEMPTED')[1];
    assert.equal(second.by, 'operator', 'a request made while the owner has control is the owner\'s');
    assert.equal(second.actionId, undefined);
    assert.equal(rig.payloads(run, 'PUBLISH_REFUSED').length, 0, 'the owner is never refused, not even for the budget or the same post');
    assert.equal(rig.site.state.requests, 2);
    await rig.browser.control('alpha', { action: 'resume' });
  } finally { await rig.close(); }
});

test('a probe that throws fails closed for the post and open for an unrelated write', { timeout: 60000 }, async () => {
  const broken = (origin: string): PublishProbe[] => {
    const base = xCreateTweet([origin]);
    return [{ id: base.id, origins: base.origins, notCreatedCodes: base.notCreatedCodes, account: base.account,
      classify: response => base.classify(response), postPath: (account, postId) => base.postPath(account, postId), profilePaths: (account, op) => base.profilePaths(account, op),
      match: request => { if (request.url.pathname.endsWith('/CreateTweet')) throw new Error('Fixture probe failure.'); return base.match(request); } }];
  };
  const rig = await publishRig({}, { probes: broken });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 4, 'This reply meets a probe that throws.');
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_REFUSED').length === 1);
    assert.equal(rig.payloads(run, 'PUBLISH_REFUSED')[0].reason, 'internal');
    assert.equal(rig.site.state.requests, 0, 'the post was aborted inside Chrome');
    assert.equal(rig.payloads(run, 'PUBLISH_ATTEMPTED').length, 0);
    const status = await rig.page(run).evaluate(async () => (await fetch('/i/api/1.1/drafts/autosave.json', { method: 'POST', body: '{"draft":{"text":"x"}}' })).status);
    assert.equal(status, 200, 'a write that matches nothing continues');
    assert.equal(rig.site.state.drafts, 1);
  } finally { await rig.close(); }
});

test('when the PUBLISH_ATTEMPTED insert fails the post is held back and leaves no phantom record (assumed X response shape)', { timeout: 60000 }, async () => {
  const rig = await publishRig();
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 5, 'A reply whose attempt record cannot be written at first.');
    rig.store.getDatabase().exec("CREATE TRIGGER fixture_attempt_fails BEFORE INSERT ON execution_events WHEN NEW.event_type = 'PUBLISH_ATTEMPTED' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END");
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_REFUSED').length === 1);
    assert.equal(rig.payloads(run, 'PUBLISH_REFUSED')[0].reason, 'internal');
    assert.equal(rig.site.state.requests, 0, 'nothing left Chrome');
    assert.deepEqual(rig.browser.publishes(run), [], 'no phantom pending record');
    rig.store.getDatabase().exec('DROP TRIGGER fixture_attempt_fails');
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_OBSERVED').length === 1);
    assert.equal(rig.site.state.requests, 1);
    assert.deepEqual(rig.browser.publishes(run).map(record => record.state), ['confirmed']);
    assert.equal(rig.payloads(run, 'PUBLISH_REFUSED').length, 1, 'the same text on the same post was not refused for budget or as a duplicate');
  } finally { await rig.close(); }
});

test('a draft that echoes the text while it is typed passes, and the reply itself is confirmed (assumed X response shape)', { timeout: 60000 }, async () => {
  const rig = await publishRig({ echoDraft: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 6, 'Draft autosave echoes this reply while it is typed.');
    await rig.until(() => rig.site.state.drafts >= 1);
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_OBSERVED').length === 1);
    assert.equal(rig.site.state.posts, 1);
    assert.deepEqual(rig.payloads(run, 'PUBLISH_ATTEMPTED').map(p => [p.op, p.unprobed ?? false]), [['reply', false]]);
    assert.equal(rig.payloads(run, 'PUBLISH_OBSERVED')[0].outcome, 'confirmed');
    assert.equal(rig.payloads(run, 'PUBLISH_REFUSED').length, 0);
  } finally { await rig.close(); }
});

test('a REST draft save that echoes the filled text on a click is not a post, so the reply still goes out once (assumed X response shape)', { timeout: 60000 }, async () => {
  const rig = await publishRig({ echoDraft: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    const text = 'Saved as a draft by a click before the reply.';
    await rig.composeReply(run, 7, text);
    const draftsBefore = rig.site.state.drafts; // the fixture also saves a draft while typing
    await rig.call(run, { action: 'click', target: { role: 'button', name: 'Save draft' } });
    await rig.until(() => rig.site.state.drafts > draftsBefore);
    assert.equal(rig.payloads(run, 'PUBLISH_ATTEMPTED').length, 0, 'only GraphQL writes on x.com can be unprobed publishes (the probe echoPaths rule)');
    await rig.clickReply(run);
    await rig.until(() => rig.browser.publishes(run).some(r => r.state === 'confirmed'));
    const attempted = rig.payloads(run, 'PUBLISH_ATTEMPTED');
    assert.equal(attempted.length, 1);
    assert.equal(attempted[0].unprobed, undefined);
    assert.equal(attempted[0].textSha256, textSha256(text));
    assert.equal(rig.payloads(run, 'PUBLISH_REFUSED').length, 0);
    assert.equal(rig.site.state.requests, 1, 'the reply left Chrome exactly once');
  } finally { await rig.close(); }
});
test('without publishProbes the route records no PUBLISH_* events and the post reaches the site as today', { timeout: 60000 }, async () => {
  const rig = await publishRig({}, { probes: null });
  try {
    const run = rig.start();
    await rig.composeReply(run, 1, 'Posted with no publish probes configured.');
    await rig.clickReply(run);
    await rig.until(() => rig.site.state.answered === 1);
    assert.equal(rig.site.state.posts, 1);
    assert.equal(rig.store.getTaskEvents(run).filter(e => e.event_type.startsWith('PUBLISH_')).length, 0);
    assert.deepEqual(rig.browser.publishes(run), []);
  } finally { await rig.close(); }
});

test('no publish record or PUBLISH_*/EXTERNAL_ACTION_* payload holds the text, the response body or the query string (assumed X response shape)', { timeout: 60000 }, async () => {
  const rig = await publishRig();
  try {
    const run = rig.start({ publishLimit: 1 });
    const text = 'Private fixture wording that must never be stored in events.';
    await rig.composeReply(run, 2, text);
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_OBSERVED').length === 1);
    assert.equal(rig.payloads(run, 'PUBLISH_OBSERVED')[0].outcome, 'confirmed');
    const stored = rig.store.getTaskEvents(run).filter(e => /^(PUBLISH_|EXTERNAL_ACTION_)/.test(e.event_type)).map(e => e.payload_json).join('\n') + JSON.stringify(rig.browser.publishes(run));
    for (const secret of [text, 'query-marker-7Q', 'fixture_feature']) assert.equal(stored.includes(secret), false, secret);
  } finally { await rig.close(); }
});

test('a post from a tab opened with new_tab is admitted and recorded', { timeout: 60000 }, async () => {
  const rig = await publishRig();
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.call(run, { action: 'navigate', url: rig.site.origin + '/home' });
    await rig.call(run, { action: 'new_tab', url: rig.site.origin + rig.site.statusPath(4) });
    await rig.call(run, { action: 'fill', target: { role: 'textbox', name: 'Post text' }, value: 'A reply sent from a second tab.' });
    await rig.clickReply(run);
    await rig.until(() => rig.payloads(run, 'PUBLISH_ATTEMPTED').length === 1);
    const attempted = rig.payloads(run, 'PUBLISH_ATTEMPTED')[0];
    assert.equal(attempted.by, 'model');
    assert.ok(attempted.actionId);
  } finally { await rig.close(); }
});

test('the fixtureRoutes seam answers a tracked post after its PUBLISH_ATTEMPTED row exists (assumed X response shape)', { timeout: 60000 }, async () => {
  let runId = '';
  let attemptSeen: boolean | undefined;
  const rig = await publishRig({}, { fixtureRoutes: origin => ({ origin, async handle(route) {
    if (!new URL(route.request().url()).pathname.endsWith('/CreateTweet')) return false;
    attemptSeen = rig.store.getTaskEvents(runId).some(e => e.event_type === 'PUBLISH_ATTEMPTED');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '2101869834065576282' } } } } }) });
    return true;
  } }) });
  try {
    runId = rig.start({ publishLimit: 1 });
    await rig.composeReply(runId, 3, 'Answered by the seam inside the browser.');
    await rig.clickReply(runId);
    await rig.until(() => rig.payloads(runId, 'PUBLISH_OBSERVED').length === 1);
    assert.equal(attemptSeen, true);
    assert.equal(rig.site.state.requests, 0, 'the seam answered; nothing reached the site');
    const observed = rig.payloads(runId, 'PUBLISH_OBSERVED')[0];
    assert.equal(observed.outcome, 'confirmed');
    assert.equal(observed.postId, '2101869834065576282');
  } finally { await rig.close(); }
});

test('a Reply click waits for X to answer and reports publish.state confirmed (assumed X response shape)', { timeout: 60000 }, async () => {
  const rig = await publishRig({ holdMs: 3000 });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 1, 'The click waits for this confirmation from X.');
    const started = Date.now();
    const result = await rig.clickReply(run);
    assert.ok(Date.now() - started >= 2500, 'the click resolved only after the held response');
    assert.equal(result.publish?.state, 'confirmed');
    assert.equal(result.publish?.op, 'reply');
    assert.equal(result.publish?.postUrl, `${rig.site.origin}/fixture_bot/status/${rig.site.state.created[0].id}`);
  } finally { await rig.close(); }
});

test('the verdict wait is capped at 5 s and reports pending, not uncertain', { timeout: 60000 }, async () => {
  const rig = await publishRig({ holdMs: 8000 });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 2, 'X takes longer than five seconds to answer this.');
    const started = Date.now();
    const result = await rig.clickReply(run);
    const waited = Date.now() - started;
    assert.ok(waited >= 4500 && waited < 7900, `waited ${waited} ms`);
    assert.equal(result.publish?.state, 'pending');
    const click = rig.payloads(run, 'EXTERNAL_ACTION_STARTED').find(p => p.action === 'click')!;
    assert.equal(rig.payloads(run, 'EXTERNAL_ACTION_FINISHED').filter(p => p.actionId === click.actionId).length, 1, 'the click finished after its observation, as today');
  } finally { await rig.close(); }
});

test('a held-back second Reply reports publish {state:"refused", op:"reply", reason:"budget"}', { timeout: 60000 }, async () => {
  const rig = await publishRig({ keepComposer: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 3, 'Only the first of two Reply clicks is sent.');
    await rig.clickReply(run);
    const second = await rig.clickReply(run);
    assert.deepEqual(second.publish, { state: 'refused', op: 'reply', reason: 'budget' });
    assert.equal(rig.site.state.requests, 1);
  } finally { await rig.close(); }
});

test('a click that fails after X confirmed its post is rescued, not uncertain (assumed X response shape)', { timeout: 60000 }, async () => {
  let failed = false;
  const rig = await publishRig({}, { testHooks: { afterDispatch: async (_actionId, action) => {
    if (action !== 'click' || failed) return;
    failed = true;
    const end = Date.now() + 10_000;
    while (rig.site.state.answered < 1 && Date.now() < end) await delay(25);
    throw new Error('Injected failure after X answered.');
  } } });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 4, 'Rescued by the response from X.');
    const result = await rig.clickReply(run);
    assert.equal(result.publish?.state, 'confirmed');
    const click = rig.payloads(run, 'EXTERNAL_ACTION_STARTED').find(p => p.action === 'click')!;
    const finished = rig.payloads(run, 'EXTERNAL_ACTION_FINISHED').filter(p => p.actionId === click.actionId);
    assert.equal(finished.length, 1, 'exactly one FINISHED for the rescued click');
    assert.equal(finished[0].outcome, 'confirmed');
    assert.equal(finished[0].confirmedBy, 'response');
    assert.equal(finished[0].publishId, rig.browser.publishes(run)[0].publishId);
  } finally { await rig.close(); }
});

test('a click that fails while X never answers is uncertain after about 5 s', { timeout: 60000 }, async () => {
  const rig = await publishRig({ hang: true }, { testHooks: { afterDispatch: async (_actionId, action) => {
    if (action !== 'click') return;
    const end = Date.now() + 10_000;
    while (rig.site.state.requests < 1 && Date.now() < end) await delay(25);
    throw new Error('Injected failure while X is silent.');
  } } });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 5, 'X never answers this reply.');
    const started = Date.now();
    const error = await rig.clickReply(run).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof UncertainExternalEffect);
    assert.ok(Date.now() - started >= 4500, 'the rescue waited for a verdict first');
    const click = rig.payloads(run, 'EXTERNAL_ACTION_STARTED').find(p => p.action === 'click')!;
    assert.equal(rig.payloads(run, 'EXTERNAL_ACTION_FINISHED').filter(p => p.actionId === click.actionId).length, 0);
  } finally { await rig.close(); }
});

test('a non-publish click that fails after dispatch is still uncertain', { timeout: 60000 }, async () => {
  const rig = await publishRig({}, { testHooks: { afterDispatch: async (_actionId, action) => { if (action === 'click') throw new Error('Injected failure on a plain click.'); } } });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.call(run, { action: 'navigate', url: rig.site.origin + '/home' });
    const error = await rig.call(run, { action: 'click', target: { role: 'button', name: 'Refresh' } }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof UncertainExternalEffect);
    assert.equal(error.message, 'Browser interaction outcome is uncertain. Inspect the page and action history; do not repeat the submission automatically.');
    assert.deepEqual(rig.browser.publishes(run), []);
  } finally { await rig.close(); }
});

/** Sends a reply that X answers without proof, and returns its record once it has settled. */
async function unconfirmedReply(rig: Awaited<ReturnType<typeof publishRig>>, run: string, k: number, text: string, signal?: AbortSignal) {
  await rig.composeReply(run, k, text, signal);
  await rig.clickReply(run, signal);
  await rig.until(() => rig.browser.publishes(run).some(record => record.state !== 'pending'));
  return rig.browser.publishes(run).at(-1)!;
}
const never = () => new AbortController().signal;

test('the page check finds a late article on the current page without visiting the profile', { timeout: 60000 }, async () => {
  const rig = await publishRig({ noBody: true, lateArticle: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    const record = await unconfirmedReply(rig, run, 1, 'This reply appears on the page six seconds later.');
    assert.equal(record.state, 'unobserved');
    assert.equal(await rig.browser.confirmPublish('alpha', run, record.publishId, null, never()), 'present');
    const postUrl = `${rig.site.origin}/fixture_bot/status/${rig.site.state.created[0].id}`;
    assert.deepEqual(rig.payloads(run, 'PUBLISH_RECONCILED'), [{ publishId: record.publishId, verdict: 'present', postUrl, by: 'page-check' }]);
    assert.equal(rig.browser.publishes(run)[0].state, 'confirmed');
    assert.equal(rig.browser.publishes(run)[0].confirmedBy, 'page');
    assert.equal(rig.site.state.profileGets, 0);
  } finally { await rig.close(); }
});

test('when the current page lacks the post the profile is checked after it loads, and the model must observe again', { timeout: 90000 }, async () => {
  const rig = await publishRig({ noBody: true, slowProfile: true, hideReplies: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    const record = await unconfirmedReply(rig, run, 2, 'A reply that only the profile page lists.');
    assert.equal(await rig.browser.confirmPublish('alpha', run, record.publishId, null, never()), 'present');
    assert.equal(rig.site.state.profileGets, 1);
    assert.equal(rig.page(run).url(), `${rig.site.origin}/fixture_bot/with_replies`);
    const refused = await rig.call(run, { action: 'click', target: { role: 'button', name: 'Refresh' } }).then(() => null, (e: unknown) => e as Error);
    assert.equal(refused?.message, 'The page was changed to check a post. Take a fresh browser snapshot before acting.');
  } finally { await rig.close(); }
});

test('without an account link the page check is not-found at once, without the profile', { timeout: 60000 }, async () => {
  const rig = await publishRig({ noBody: true, noProfileLink: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    const record = await unconfirmedReply(rig, run, 2, 'No Profile link is shown on this page.');
    const started = Date.now();
    assert.equal(await rig.browser.confirmPublish('alpha', run, record.publishId, null, never()), 'not-found');
    assert.ok(Date.now() - started < 3000);
    assert.equal(rig.site.state.profileGets, 0);
    assert.deepEqual(rig.payloads(run, 'PUBLISH_RECONCILED').map(p => p.verdict), ['not-found']);
    assert.equal(rig.browser.publishes(run)[0].state, 'unobserved');
  } finally { await rig.close(); }
});

test('an operator-typed post has no known text, so the page check is not-found and the record stays unobserved', { timeout: 60000 }, async () => {
  const rig = await publishRig({ noBody: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.call(run, { action: 'navigate', url: rig.site.origin + rig.site.statusPath(5) });
    await rig.browser.control('alpha', { action: 'takeover' });
    await rig.browser.control('alpha', { action: 'click', x: 500, y: 50 });
    await rig.browser.control('alpha', { action: 'type', text: 'The operator wrote this reply by hand.' });
    await rig.browser.control('alpha', { action: 'click', x: 280, y: 120 });
    await rig.until(() => rig.browser.publishes(run).some(record => record.state === 'unobserved'));
    await rig.browser.control('alpha', { action: 'resume' });
    const [record] = rig.browser.publishes(run);
    assert.equal(await rig.browser.confirmPublish('alpha', run, record.publishId, null, never()), 'not-found');
    assert.deepEqual(rig.payloads(run, 'PUBLISH_RECONCILED'), [{ publishId: record.publishId, verdict: 'not-found', by: 'page-check' }]);
    assert.equal(rig.browser.publishes(run)[0].state, 'unobserved');
    assert.equal(rig.site.state.profileGets, 0);
  } finally { await rig.close(); }
});

test('phase 2 never runs while a post of the run is still pending', { timeout: 60000 }, async () => {
  const rig = await publishRig({ hang: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 6, 'X never answers, so this stays pending.');
    await rig.clickReply(run);
    const [record] = rig.browser.publishes(run);
    assert.equal(record.state, 'pending');
    assert.equal(await rig.browser.confirmPublish('alpha', run, record.publishId, null, never()), 'not-found');
    assert.equal(rig.site.state.profileGets, 0, 'no navigation while the post was in flight');
    assert.deepEqual(rig.payloads(run, 'PUBLISH_RECONCILED').map(p => p.verdict), ['not-found']);
  } finally { await rig.close(); }
});

test('a page check stopped by its signal writes no verdict and leaves the record unchanged', { timeout: 60000 }, async () => {
  const rig = await publishRig({ noBody: true, lateArticle: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    const record = await unconfirmedReply(rig, run, 7, 'The check of this reply is stopped early.');
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error('Fixture stop.')), 1000);
    await assert.rejects(rig.browser.confirmPublish('alpha', run, record.publishId, null, stop.signal), /Fixture stop/);
    assert.equal(rig.payloads(run, 'PUBLISH_RECONCILED').length, 0);
    assert.equal(rig.browser.publishes(run)[0].state, 'unobserved');
  } finally { await rig.close(); }
});

test('closeOutPublishes waits for a held response, then confirms the post on the page', { timeout: 60000 }, async () => {
  const rig = await publishRig({ holdMs: 8000, noBody: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.composeReply(run, 1, 'X answers this reply after eight seconds with no body.');
    const clicked = await rig.clickReply(run);
    assert.equal(clicked.publish?.state, 'pending');
    const records = await rig.browser.closeOutPublishes('alpha', run, AbortSignal.timeout(20_000));
    assert.deepEqual(records.map(record => [record.state, record.confirmedBy]), [['confirmed', 'page']]);
    assert.equal(rig.payloads(run, 'PUBLISH_OBSERVED')[0].outcome, 'unobserved');
  } finally { await rig.close(); }
});

test('closeOutPublishes without a session opens no browser and returns the records unchanged', { timeout: 60000 }, async () => {
  const rig = await publishRig({ noBody: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await unconfirmedReply(rig, run, 2, 'Checked only after the browser has closed.');
    await rig.browser.endRun(run);
    assert.equal(rig.browser.status().active, 0);
    const records = await rig.browser.closeOutPublishes('alpha', run, AbortSignal.timeout(20_000));
    assert.deepEqual(records.map(record => record.state), ['unobserved']);
    assert.equal(rig.browser.status().active, 0);
    assert.equal(rig.payloads(run, 'PUBLISH_RECONCILED').length, 0);
  } finally { await rig.close(); }
});

test('a cancelled run keeps its session while a post is unresolved; close-out can still check it; endRun and shutdown end it at once', { timeout: 60000 }, async () => {
  const rig = await publishRig({ noBody: true });
  const sessions = (rig.browser as unknown as { sessions: Map<string, { teardownTimer?: ReturnType<typeof setTimeout> }> }).sessions;
  try {
    const run = rig.start({ publishLimit: 1 });
    const cancel = new AbortController();
    await unconfirmedReply(rig, run, 3, 'Unresolved when the run is cancelled.', cancel.signal);
    cancel.abort(new Error('Fixture cancel.'));
    await delay(500);
    assert.equal(rig.browser.status().active, 1, 'kept for the close-out');
    const timer = sessions.get(run)?.teardownTimer;
    assert.ok(timer);
    assert.equal(timer.hasRef(), false, 'the teardown timer never keeps the daemon alive');
    const records = await rig.browser.closeOutPublishes('alpha', run, AbortSignal.timeout(20_000));
    assert.equal(records[0].state, 'confirmed');
    const ending = Date.now();
    await rig.browser.endRun(run);
    assert.equal(rig.browser.status().active, 0);
    assert.ok(Date.now() - ending < 10_000, 'endRun does not wait for the 30 s timer');

    const quiet = rig.start({ publishLimit: 1 });
    const quietCancel = new AbortController();
    await rig.call(quiet, { action: 'navigate', url: rig.site.origin + '/home' }, quietCancel.signal);
    quietCancel.abort(new Error('Fixture cancel.'));
    await rig.until(() => rig.browser.status().active === 0, 10_000);

    const kept = rig.start({ publishLimit: 1 });
    const keptCancel = new AbortController();
    await unconfirmedReply(rig, kept, 4, 'Unresolved when the daemon stops.', keptCancel.signal);
    keptCancel.abort(new Error('Fixture cancel.'));
    await delay(300);
    assert.equal(rig.browser.status().active, 1);
    await rig.browser.stop();
    assert.equal(rig.browser.status().active, 0, 'shutdown ends a deferred session at once');
  } finally { await rig.close(); }
});

test('the page check matches X-style rendering: shortened URLs, a leading URL, line breaks, collapsed spaces and Show more', { timeout: 90000 }, async () => {
  const rig = await publishRig({ noBody: true });
  try {
    const run = rig.start();
    const cases: Array<[number, string]> = [
      [1, 'Great read today, worth every minute of it https://example.com/very/long/path'],
      [2, 'https://example.com/start Morning thoughts on fixture testing and patience'],
      [3, 'First paragraph about fixtures.\n\nSecond paragraph about proof.'],
      [4, 'Doubled  space inside this sentence for the page check'],
      [5, 'A long post that X cuts short. '.repeat(6).trim()],
    ];
    for (const [index, [k, text]] of cases.entries()) {
      await rig.composeReply(run, k, text);
      await rig.clickReply(run);
      await rig.until(() => rig.browser.publishes(run).length === index + 1 && rig.browser.publishes(run)[index].state !== 'pending');
      const record = rig.browser.publishes(run)[index];
      assert.equal(await rig.browser.confirmPublish('alpha', run, record.publishId, null, never()), 'present', text);
    }
    assert.equal(rig.site.state.profileGets, 0);
  } finally { await rig.close(); }
});

test('our own new post whose shown text differs is not-found after both phases', { timeout: 90000 }, async () => {
  const rig = await publishRig({ noBody: true, shownText: 'Completely different words are shown on the page.' });
  try {
    const run = rig.start({ publishLimit: 1 });
    const record = await unconfirmedReply(rig, run, 1, 'The words typed into the composer for this reply.');
    assert.equal(await rig.browser.confirmPublish('alpha', run, record.publishId, null, never()), 'not-found');
    assert.equal(rig.site.state.profileGets, 1, 'phase 2 looked at the profile');
    assert.deepEqual(rig.payloads(run, 'PUBLISH_RECONCILED').map(p => p.verdict), ['not-found']);
    assert.equal(rig.browser.publishes(run)[0].state, 'unobserved');
  } finally { await rig.close(); }
});

test('a post whose response body is unreadable after the page moves on is found on the profile', { timeout: 90000 }, async () => {
  const rig = await publishRig({ leaveAfterPost: true });
  try {
    const run = rig.start({ publishLimit: 1 });
    await rig.call(run, { action: 'navigate', url: rig.site.origin + '/compose/post' });
    await rig.call(run, { action: 'fill', target: { role: 'textbox', name: 'Post text' }, value: 'Posted just before the compose view closed.' });
    await rig.call(run, { action: 'click', target: { role: 'button', name: 'Post' } });
    const records = await rig.browser.closeOutPublishes('alpha', run, AbortSignal.timeout(60_000));
    assert.deepEqual(records.map(record => [record.state, record.confirmedBy]), [['confirmed', 'page']]);
    const observed = rig.payloads(run, 'PUBLISH_OBSERVED');
    assert.equal(observed.length, 1);
    assert.equal(observed[0].outcome, 'unobserved');
    // Local Chromium either rejects body() ("No resource with given identifier") or leaves it waiting until the 20 s cap.
    assert.ok(['body-unreadable', 'timeout'].includes(String(observed[0].reason)), String(observed[0].reason));
    assert.equal(rig.site.state.profileGets, 1);
  } finally { await rig.close(); }
});
