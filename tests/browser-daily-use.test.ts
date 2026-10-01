import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { BrowserTools, browserAction } from '../src/daemon/browser-tools.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';
import { ApprovalGate } from '../src/daemon/control-plane.js';
import { WorkQuestions } from '../src/daemon/work-questions.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';
import { systemApi } from '../src/daemon/system-api.js';

test('human sign-in retains service workers and cache while headed bot sessions keep write protection', { timeout: 60000 }, async () => {
  let assets = 0, writes = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/worker-proof')e.respondWith(new Response('worker-active'));});");
    } else if (req.url === '/asset') {
      assets++; res.setHeader('Cache-Control', 'public, max-age=3600'); res.end('cached');
    } else if (req.url === '/write') { writes++; res.end('written'); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<title>Human sign-in fixture</title>'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'test', budget_cap_usd: 1, current_status: 'IDLE' });
  const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), previewOrigins: [url], headed: true });
  const sessions = (browser as unknown as { sessions: Map<string, { page: import('playwright').Page }> }).sessions;
  try {
    const login = await browser.openLogin('alpha', url);
    const page = sessions.get(login.runId)!.page;
    await page.evaluate(async () => { await navigator.serviceWorker.register('/worker.js'); await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.equal(await page.evaluate(async () => (await fetch('/worker-proof')).text()), 'worker-active');
    await page.evaluate(async () => { await (await fetch('/asset')).text(); await (await fetch('/asset')).text(); });
    assert.equal(assets, 1, 'human sign-in preserves ordinary HTTP caching');
    await browser.cancelLogin('alpha', login.runId);
    const run = store.createTaskRun({ agentId: 'alpha', taskName: 'headed-bot' }); store.startTaskRun(run.id, 'test');
    await browser.call('alpha', run.id, browserAction.parse({ tool: 'browser', action: 'navigate', url }), new AbortController().signal);
    const botPage = sessions.get(run.id)!.page;
    assert.equal(await botPage.evaluate(async () => { try { await fetch('/write', { method: 'POST' }); return false; } catch { return true; } }), true);
    assert.equal(writes, 0, 'headed automation must still enforce its write gate');
  } finally { await browser.stop(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('failed human sign-in save keeps the real browser open, permits retry, and cancel preserves saved state', { timeout: 60000 }, async () => {
  const server = http.createServer((_req, res) => { res.setHeader('Set-Cookie', 'session=fixture; Path=/'); res.end('<h1>Fixture account</h1>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const store = new AgentStore(':memory:');
  store.createAgent({id:'alpha', name:'Alpha', model_id:'test', budget_cap_usd:1, current_status:'IDLE'});
  const secrets = new MemorySecretStore();
  const browser = new BrowserTools({store, artifacts:new ArtifactStore(store), secrets, previewOrigins:[url]});
  const saved = () => store.getDatabase().prepare('SELECT ciphertext FROM browser_sessions WHERE agent_id=?').get('alpha');
  const protect = secrets.protect.bind(secrets);
  try {
    await browser.openLogin('alpha', url);
    await browser.finishLogin('alpha');
    const previous = saved(); assert.ok(previous);
    await browser.openLogin('alpha', url);
    secrets.protect = async () => { throw new Error('Fixture storage failure'); };
    await assert.rejects(browser.finishLogin('alpha'), /window is still open/);
    assert.equal(browser.status('alpha').sessions.length, 1);
    assert.deepEqual(saved(), previous);
    secrets.protect = protect;
    assert.equal((await browser.finishLogin('alpha')).saved, true);
    assert.equal(browser.status('alpha').sessions.length, 0);
    const afterRetry = saved();
    const cancelled = await browser.openLogin('alpha', url);
    const api = systemApi({store,browser,missions:{} as never,memory:{} as never,retention:{} as never,capacity:{} as never,abort:()=>false});
    const postCancel = (agentId: string, runId: string) => api('POST', new URL('http://localhost/api/system/browser-login-cancel'), { agentId, runId });
    assert.equal((await postCancel('other-bot', cancelled.runId)).status, 200);
    assert.equal(browser.status().active, 1, 'wrong bot cannot close the session');
    const response = await postCancel('alpha', cancelled.runId);
    assert.equal(response.status, 200);
    assert.equal(browser.status().active, 0);
    assert.equal(store.getTaskRun(cancelled.runId)?.status, 'ABORTED');
    assert.deepEqual(saved(), afterRetry, 'cancel does not overwrite saved session state');
    const reopened = await browser.openLogin('alpha', url);
    await postCancel('alpha', cancelled.runId);
    assert.equal(browser.status().active, 1, 'late cancellation cannot close a replacement login');
    // Closing the actual window must not try to read storage from a dead browser.
    const session = (browser as unknown as { sessions: Map<string, { browser: import('playwright').Browser }> }).sessions.get(reopened.runId)!;
    await session.browser.close();
    await browser.endRun(reopened.runId);
    assert.deepEqual(saved(), afterRetry);
    assert.deepEqual(browser.status('alpha').persistenceErrors, {});
    await browser.openLogin('alpha', `${url}/login`);
    await assert.rejects(browser.finishLogin('alpha'), /Sign-in is not complete/);
    assert.equal(browser.status('alpha').sessions.length, 1);
    assert.deepEqual(saved(), afterRetry);
  } finally { await browser.stop(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('live browser, human takeover, task cancellation and bot isolation use real Chromium', { timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Live fixture</title><input aria-label="Note" style="position:absolute;left:0;top:0;width:300px;height:60px"><p style="margin-top:100px;font-size:40px" id="clock"></p><script>setInterval(()=>document.querySelector("#clock").textContent=Date.now(),50)</script>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const store = new AgentStore(':memory:');
  for (const id of ['alpha', 'beta']) store.createAgent({ id, name: id, model_id: 'test', budget_cap_usd: 2, current_status: 'IDLE' });
  const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), previewOrigins: [url] });
  const run = store.createTaskRun({ agentId: 'alpha', taskName: 'test' }); store.startTaskRun(run.id, 'test');
  const controller = new AbortController();
  const call = (action: object) => browser.call('alpha', run.id, browserAction.parse({tool:'browser', ...action}), controller.signal);
  try {
    await call({action:'navigate', url});
    const frame1 = await browser.liveState('alpha') as any; await delay(100); const frame2 = await browser.liveState('alpha') as any;
    assert.match(frame1.state.screenshot, /^data:image\/jpeg;base64,/); assert.ok(frame1.state.screenshot !== frame2.state.screenshot, 'fresh frames change without model actions');
    assert.equal((await browser.liveState('beta')).available, false);
    await assert.rejects(browser.control('alpha', {action:'type', text:'x'}), /Take control/);
    await browser.control('alpha', {action:'takeover'});
    let advanced = false; const pending = call({action:'snapshot'}).then(r => { advanced = true; return r; });
    await delay(100); assert.equal(advanced, false);
    await browser.control('alpha', {action:'click', x:40, y:25});
    await browser.control('alpha', {action:'type', text:'private-human-value'});
    assert.equal((await browser.liveState('alpha') as any).state.controlled, true);
    await browser.control('alpha', {action:'resume'});
    const snapshot = await pending; assert.equal(advanced, true); assert.doesNotMatch(snapshot.snapshot, /private-human-value/);
    await browser.control('alpha', {action:'takeover'});
    await browser.control('alpha', {action:'scroll', delta:100});
    await browser.control('alpha', {action:'resume'});
    await assert.rejects(call({action:'navigate', url}), /fresh browser snapshot/, 'a bot cannot act on stale observations after human input');
    await call({action:'snapshot'});
    await browser.control('alpha', {action:'takeover'});
    const waiting = browser.waitForOperator(run.id, controller.signal);
    const rejected = assert.rejects(waiting, /operator cancelled/); controller.abort(new Error('operator cancelled')); await rejected;
    await browser.endRun(run.id); assert.equal((await browser.liveState('alpha')).available, false);
    const next = store.createTaskRun({agentId:'alpha',taskName:'closed-browser'}); store.startTaskRun(next.id,'test');
    await browser.call('alpha',next.id,browserAction.parse({tool:'browser',action:'navigate',url}),new AbortController().signal);
    await browser.control('alpha',{action:'takeover'});
    const closed = assert.rejects(browser.waitForOperator(next.id,new AbortController().signal), /closed during human control/);
    await browser.endRun(next.id); await closed;
  } finally { await browser.stop(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('sign-in navigation failure keeps the human window open and saves only to its bot', { timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/broken') { req.socket.destroy(); return; }
    res.setHeader('Set-Cookie', 'session=fixture; Path=/'); res.end('<title>Fixture account</title><h1>Signed in fixture</h1>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const store = new AgentStore(':memory:'); store.createAgent({id:'alpha',name:'Alpha',model_id:'test',budget_cap_usd:1,current_status:'IDLE'});
  const browser = new BrowserTools({store, artifacts:new ArtifactStore(store),secrets:new MemorySecretStore(),previewOrigins:[url]});
  try {
    const result = await browser.openLogin('alpha', `${url}/broken`);
    assert.equal(result.opened, true); assert.ok(result.warning); assert.equal(browser.status('alpha').sessions.length, 1);
    const live = await browser.liveState('alpha') as any; assert.equal(live.state.login, true); assert.equal(live.state.screenshot, undefined, 'never stream the human login screen');
    await browser.endRun(result.runId);
    const questions = new WorkQuestions(store), approvals = new ApprovalGate(store);
    approvals.onDecision('account-request', () => {});
    const parent = store.createTaskRun({agentId:'alpha',taskName:'chat'}); store.startTaskRun(parent.id,'test');
    const question = questions.ask({agentId:'alpha',runId:parent.id,purpose:'browser-signin',question:'Sign in',options:[],contract:CONVERSATION_CONTRACT,request:'Download my invoice',files:{'notes.txt':'Retained work'},conversation:true,context:'Read the invoice list. No download yet.'});
    const card = approvals.propose({agentId:'alpha',taskRunId:parent.id,kind:'account-request',payload:{site:'127.0.0.1',questionId:question.id}});
    store.finishTaskRun(parent.id,'COMPLETED');
    const api = systemApi({store,browser,questions,approvals,missions:{} as never,memory:{} as never,retention:{} as never,capacity:{} as never,abort:()=>false});
    const post = (action:string, body:unknown) => api('POST',new URL(`http://localhost/api/system/${action}`),body);
    assert.equal((await post('browser-login',{agentId:'alpha',url:'https://example.org',approvalId:card.id})).status,400,'cannot substitute a requested platform');
    assert.equal((await post('browser-control',{agentId:'alpha',action:'click',x:-1,y:0})).status,400,'coordinates validated');
    const opened = await post('browser-login',{agentId:'alpha',url,approvalId:card.id}); assert.equal(opened.status,200,JSON.stringify(opened.body));
    const finished = await post('browser-login-finish',{agentId:'alpha',approvalId:card.id}); assert.equal(finished.status,200,JSON.stringify(finished.body));
    const saved = finished.body as {saved:boolean;verified:boolean}; assert.equal(saved.saved,true); assert.equal(saved.verified,false,'generic saved cookies are not proof of login');
    const answered = questions.list('alpha').find(q=>q.id===question.id)!;
    assert.equal(answered.state,'answered'); assert.equal(store.getTaskRun(answered.resumedRunId!)?.status,'QUEUED');
    assert.equal(store.getApproval(card.id)?.status,'APPROVED');
    assert.equal((await post('browser-login-finish',{agentId:'alpha',approvalId:card.id})).status,400,'one continuation only');
    assert.equal(browser.connections('alpha').length,1); assert.equal(browser.status().active,0);
    browser.disconnect('alpha'); assert.deepEqual(browser.connections('alpha'),[]);
  } finally { await browser.stop(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
