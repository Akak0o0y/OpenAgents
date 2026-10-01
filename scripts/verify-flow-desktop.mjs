// Disposable bot-desktop verifier for Stage 1, honest posting (spec section 11.9). It needs Docker.
//
// It creates a new bot on a new desktop volume owned by a fresh temporary folder, so its container,
// volume and network names cannot belong to Milo or to any other existing bot. That bot has no X
// account and no saved cookies. Nothing is sent to X: the fixture origin https://publish-fixture.invalid
// is answered inside Chrome by the test-only fixtureRoutes seam. The only external request is the
// owner-approved POST of a dummy text to https://httpbin.org/anything (decision 7); --no-echo answers
// that request inside Chrome as well. It deletes only its own container, volume and network, after
// checking their bot label and name, and it never prints the desktop gateway token or a cookie.
//
// Usage: npm run test:flow-desktop -- --stage=1 [--no-echo] [--date=YYYY-MM-DD]
// With OPENHOURS_DESKTOP_PACKAGE=<unpacked app>/resources/app it loads that package's code instead of dist/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const stage = option('stage') ?? '1';
if (stage !== '1') {
  console.error(`--stage=${stage} is not in this build. Only the Stage 1 checks (--stage=1) exist; Stage 2 adds its own group.`);
  process.exit(2);
}
const noEcho = args.includes('--no-echo');
const day = option('date') ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error('--date must be YYYY-MM-DD.');
  process.exit(2);
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = process.env.OPENHOURS_DESKTOP_PACKAGE;
const load = relative => import(packageRoot
  ? pathToFileURL(path.join(packageRoot, 'dist/src', relative)).href
  : new URL('../dist/src/' + relative, import.meta.url).href);

const { resolveDockerHost } = await load('kernel/docker-host.js');
const { dockerRunner } = await load('daemon/browser-sandbox.js');
const { BotDesktop, desktopAssetsDir } = await load('daemon/bot-desktop.js');
const { BrowserTools, browserAction } = await load('daemon/browser-tools.js');
const { AgentStore } = await load('daemon/agent-store.js');
const { ArtifactStore } = await load('daemon/artifacts.js');
const { MemorySecretStore } = await load('daemon/secret-store.js');
const { setBrowserAutonomy } = await load('daemon/browser-accounts.js');
const { xCreateTweet, responseShape, textSha256 } = await load('daemon/publish-probes.js');
const { buildIdentity } = await load('daemon/build-identity.js');

const FIXTURE = 'https://publish-fixture.invalid';
const ECHO_ORIGIN = noEcho ? FIXTURE : 'https://httpbin.org';
const ECHO_URL = `${ECHO_ORIGIN}/anything`;
const CREATE_PATH = '/i/api/graphql/q1/CreateTweet';
const HANDLE = 'verifier_bot';
const AGENT = 'flow-verifier';
const CHECKS = ['attempt-before-send', 'route-sees-post-body', 'body-capture', 'page-check-delayed-article', 'new-tab-routed', 'deferred-teardown'];
const snowflake = ms => String((BigInt(ms) - 1288834974657n) << 22n);
const iso = ms => new Date(ms).toISOString();
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = text => String(text).replace(/[&<>"']/g, c => ESCAPES[c]);

// ---------------------------------------------------------------- fixture pages, served by the seam ---
const shell = (title, main, script = '') => '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title></head><body>'
  + `<header role="banner"><a href="/${HANDLE}" aria-label="Profile">Profile</a> <a href="/home">Home</a></header>`
  + `<main>${main}</main><script>${script}</script></body></html>`;

/** The composer posts in the assumed CreateTweet shape; `lateMs` renders our own article that many ms after the answer. */
const composeScript = cfg => `const cfg = ${JSON.stringify(cfg)};
const box = document.querySelector('[role=textbox]');
const post = document.querySelector('#post');
const typed = () => box.innerText.replace(/\\n$/, '');
box.addEventListener('input', () => { post.disabled = typed().trim() === ''; });
post.addEventListener('click', () => {
  const text = typed();
  fetch('${CREATE_PATH}?answer=' + cfg.answer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variables: { tweet_text: text }, queryId: 'q1' }) })
    .then(response => {
      const id = response.headers.get('x-verifier-post-id');
      if (id && cfg.lateMs >= 0) setTimeout(() => {
        const article = document.createElement('article');
        article.innerHTML = '<a href="/${HANDLE}">Verifier Bot</a> <a href="/${HANDLE}/status/' + id + '">now</a><div class="text"></div>';
        article.querySelector('.text').textContent = text;
        document.querySelector('#feed').append(article);
      }, cfg.lateMs);
      return response.text();
    })
    .catch(() => {});
});`;

const pages = {
  '/home': () => shell('Verifier home', '<p>Disposable publish fixture. Nothing here reaches x.com.</p><a href="/compose">Compose</a>'),
  [`/${HANDLE}`]: () => shell('Verifier profile',
    `<article><a href="/${HANDLE}">Verifier Bot</a> <a href="/${HANDLE}/status/${snowflake(Date.UTC(2026, 8, 1))}">Sep 1</a><div>Pinned verifier post.</div></article>`),
  '/compose': url => shell('Verifier composer',
    '<div role="textbox" aria-label="Post text" contenteditable="true" style="min-height:60px;border:1px solid #888"></div>'
      + '<button type="button" id="post" disabled>Post</button><section id="feed"></section>',
    composeScript({ answer: url.searchParams.get('answer') === 'empty' ? 'empty' : 'confirm', lateMs: Number(url.searchParams.get('late') ?? -1) })),
  '/echo': () => shell('Verifier echo', '<label>Echo text <input aria-label="Echo text"></label><button type="button" id="send">Send echo</button>',
    `document.querySelector('#send').addEventListener('click', () => { fetch(${JSON.stringify(ECHO_URL)}, { method: 'POST', mode: 'cors', headers: { 'content-type': 'text/plain' }, body: document.querySelector('input').value }).catch(() => {}); });`),
};

// ---------------------------------------------------------------- store, desktop and browser ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-flow-verifier-'));
const runner = dockerRunner(resolveDockerHost());
const docker = async dockerArgs => {
  const result = await runner(dockerArgs, { timeoutMs: 120_000 });
  if (result.exitCode) throw new Error(`docker ${dockerArgs.slice(0, 2).join(' ')} failed: ${String(result.stderr || result.stdout).slice(0, 300)}`);
  return result.stdout;
};
const store = new AgentStore(':memory:');
store.createAgent({ id: AGENT, name: 'Flow verifier', model_id: 'fixture', budget_cap_usd: 0, current_status: 'IDLE' });
setBrowserAutonomy(store, AGENT, 'always');
const desktop = new BotDesktop({ ownerId: dir, stateDir: dir, assetsDir: desktopAssetsDir(), autoProvision: true, identityKey: id => store.desktopIdentity(id) });
const identity = desktop.identity(AGENT);

const attemptsOf = runId => store.getTaskEvents(runId).filter(e => e.event_type === 'PUBLISH_ATTEMPTED');
const seam = { runId: '', expectText: '', creates: [] };
const fixtureRoutes = {
  origin: FIXTURE,
  async handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    let postData = '';
    try { postData = request.postData() ?? ''; } catch { postData = ''; }
    if (request.method() === 'GET') {
      const page = pages[url.pathname];
      if (!page) return false;
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page(url) });
      return true;
    }
    if (request.method() === 'POST' && url.pathname === CREATE_PATH) {
      const handledAt = Date.now();
      const rows = attemptsOf(seam.runId);
      // What the route handler had already written when the seam saw the request (S1-5), and whether the body reached it.
      seam.creates.push({ handledAt, attemptsBefore: rows.length, latestAttemptAt: rows.at(-1)?.timestamp ?? null,
        sawText: seam.expectText !== '' && postData.includes(seam.expectText) });
      // The id encodes the host clock at this moment, so the page check's snowflake window cannot drift out of range.
      const id = snowflake(handledAt);
      const body = url.searchParams.get('answer') === 'empty' ? '' : JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: id } } } } });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-verifier-post-id': id }, body });
      return true;
    }
    if (noEcho && request.method() === 'POST' && url.pathname === '/anything') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: postData, method: 'POST' }) });
      return true;
    }
    return false;
  },
};

// Verifier-only probe (decision 7): confirmed only when the echo returns exactly the text that was sent.
const echo = { sent: '' };
const echoProbe = {
  id: 'verifier/echo',
  origins: [ECHO_ORIGIN],
  notCreatedCodes: new Set(),
  account: { role: 'link', name: 'Profile' },
  match(req) {
    if (req.method.toUpperCase() !== 'POST' || req.url.origin !== ECHO_ORIGIN || req.url.pathname !== '/anything') return null;
    return req.postData ? { probe: 'verifier/echo', op: 'post', text: req.postData } : { probe: 'verifier/echo', op: 'post' };
  },
  classify(res) {
    if (!res.body || res.body.length === 0) return { outcome: 'unobserved', reason: 'empty-body', errorCodes: [], shape: [] };
    let json;
    try { json = JSON.parse(res.body.toString('utf8')); } catch { return { outcome: 'unobserved', reason: 'unparseable-body', errorCodes: [], shape: [] }; }
    const shape = responseShape(json);
    if (res.status === 200 && json && typeof json === 'object' && echo.sent !== '' && json.data === echo.sent) {
      // A synthetic numeric id: the echo service creates no post.
      return { outcome: 'confirmed', postId: String(Date.now()), shape };
    }
    return { outcome: 'unobserved', reason: res.status === 200 ? 'echo-mismatch' : `http ${res.status}`, errorCodes: [], shape };
  },
  postPath: (account, postId) => `/${account}/status/${postId}`,
  profilePaths: account => [`/${account}`],
};

const browser = new BrowserTools({ store, artifacts: new ArtifactStore(store), secrets: new MemorySecretStore(), desktop,
  publishProbes: [xCreateTweet([FIXTURE]), echoProbe], fixtureRoutes });

const evidence = {
  at: new Date().toISOString(),
  scope: 'Stage 1 honest posting on a disposable real bot desktop: Linux Chrome driven through the gateway /cdp. '
    + `The fixture origin ${FIXTURE} is answered inside Chrome by the test-only seam, in the assumed X CreateTweet shape. `
    + (noEcho ? 'The echo was answered inside Chrome too (--no-echo). ' : 'One owner-approved POST of a dummy text went to https://httpbin.org/anything. ')
    + 'No X page, no real account, not Milo\'s bot, profile or volume.'
    + (packageRoot ? ` Code loaded from the package at ${packageRoot}.` : ''),
  buildIdentity: buildIdentity(),
  image: desktop.image,
  checks: [],
  bodyCapture: 'failed',
  passed: false,
};

const idle = new AbortController().signal;
const call = (runId, action, signal = idle) => browser.call(AGENT, runId, browserAction.parse({ tool: 'browser', ...action }), signal);
const payloads = (runId, type) => store.getTaskEvents(runId).filter(e => e.event_type === type).map(e => ({ at: e.timestamp, ...JSON.parse(e.payload_json) }));
const waitFor = async (done, ms, what) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for ${what}.`);
    await delay(100);
  }
};
const startRun = policy => {
  const run = store.createTaskRun({ agentId: AGENT, taskName: 'flow-verifier' });
  store.startTaskRun(run.id, 'fixture');
  if (policy) browser.setRunPolicy(run.id, policy);
  seam.runId = run.id;
  return run.id;
};
const finishRun = async (runId, status = 'COMPLETED') => {
  await browser.endRun(runId).catch(() => {});
  browser.clearRunPolicy(runId);
  if (store.getTaskRun(runId)?.status === 'RUNNING') store.finishTaskRun(runId, status);
};
const check = async (name, fn) => {
  try {
    const detail = await fn();
    evidence.checks.push({ name, passed: true, detail });
    console.log(`PASS ${name}: ${detail}`);
  } catch (error) {
    const detail = String(error?.message ?? error).slice(0, 2000);
    evidence.checks.push({ name, passed: false, detail });
    console.log(`FAIL ${name}: ${detail}`);
  }
};
const typePost = (runId, text, signal = idle) => call(runId, { action: 'fill', target: { role: 'textbox', name: 'Post text' }, value: text }, signal);
const clickPost = (runId, signal = idle) => call(runId, { action: 'click', target: { role: 'button', name: 'Post' } }, signal);

let desktopRequested = false;
try {
  console.log(`Disposable bot desktop: ${identity.name} (owner folder ${dir}).`);
  console.log('Checking the bot desktop image. The first run on a machine may build it.');
  await desktop.ensureImage();
  desktopRequested = true;

  // Run A: a routine-shaped run (publish limit 1). One post, answered by the seam with a confirmed body.
  const runA = startRun({ publishLimit: 1 });
  try {
    const typedA = `OpenAgents flow verifier check ${new Date().toISOString()}`;
    seam.expectText = typedA;
    await check('attempt-before-send', async () => {
      await call(runA, { action: 'navigate', url: `${FIXTURE}/compose?answer=confirm` });
      await typePost(runA, typedA);
      const before = seam.creates.length;
      await clickPost(runA);
      await waitFor(() => seam.creates.length > before && payloads(runA, 'PUBLISH_OBSERVED').length > 0, 25_000, 'the post to reach the seam and settle');
      const handled = seam.creates[before];
      const attempted = payloads(runA, 'PUBLISH_ATTEMPTED');
      if (attempted.length !== 1) throw new Error(`Expected one PUBLISH_ATTEMPTED, found ${attempted.length}.`);
      if (handled.attemptsBefore < 1) throw new Error('The seam handled the post before its PUBLISH_ATTEMPTED row existed.');
      if (handled.latestAttemptAt > handled.handledAt) throw new Error('The PUBLISH_ATTEMPTED row is later than the seam handling the request.');
      const observed = payloads(runA, 'PUBLISH_OBSERVED')[0];
      return `PUBLISH_ATTEMPTED (${iso(attempted[0].at)}) was already in the store when the seam handled the request (${iso(handled.handledAt)}); PUBLISH_OBSERVED ${observed.outcome}.`;
    });
    await check('route-sees-post-body', async () => {
      const handled = seam.creates.at(-1);
      const attempted = payloads(runA, 'PUBLISH_ATTEMPTED')[0];
      if (!handled || !attempted) throw new Error('No post was sent in the attempt-before-send run.');
      if (!handled.sawText) throw new Error('The route handler did not receive the typed text in postData.');
      if (attempted.textSha256 !== textSha256(typedA)) throw new Error('PUBLISH_ATTEMPTED.textSha256 is not the hash of the typed text, so the probe did not read the body.');
      if (attempted.op !== 'post') throw new Error(`Expected op post, found ${attempted.op}.`);
      return 'The page POST body reached the route handler through the gateway /cdp; the probe parsed its text (textSha256 matches) and op post.';
    });
  } finally { await finishRun(runA); }

  // Run B: no run policy (an ephemeral run with no budget), so its three posts are all admitted.
  const runB = startRun();
  try {
    await check('body-capture', async () => {
      const text = `OpenAgents flow verifier ${new Date().toISOString()}`;
      echo.sent = text;
      await call(runB, { action: 'navigate', url: `${FIXTURE}/echo` });
      await call(runB, { action: 'fill', target: { role: 'textbox', name: 'Echo text' }, value: text });
      const before = payloads(runB, 'PUBLISH_OBSERVED').length;
      await call(runB, { action: 'click', target: { role: 'button', name: 'Send echo' } });
      await waitFor(() => payloads(runB, 'PUBLISH_OBSERVED').length > before, 30_000, 'the echo response to be classified');
      const record = browser.publishes(runB).find(r => r.probe === 'verifier/echo');
      const observed = payloads(runB, 'PUBLISH_OBSERVED').at(-1);
      if (record?.state === 'confirmed' && record.confirmedBy === 'response') {
        evidence.bodyCapture = noEcho ? 'synthetic' : 'real';
        return `The ${noEcho ? 'seam-fulfilled' : 'real httpbin.org'} response body was read through Request.response() and classified confirmed (status ${observed.status}; keys ${(observed.shape ?? []).slice(0, 6).join(', ')}).`;
      }
      evidence.bodyCapture = 'failed';
      throw new Error(`The echo was not confirmed: outcome ${observed?.outcome ?? 'none'}, reason ${observed?.reason ?? 'none'}, status ${observed?.status ?? 'none'}.`);
    });
    await check('page-check-delayed-article', async () => {
      const text = `Verifier delayed article ${new Date().toISOString()}`;
      await call(runB, { action: 'snapshot' });
      await call(runB, { action: 'navigate', url: `${FIXTURE}/compose?answer=empty&late=6000` });
      await typePost(runB, text);
      const before = browser.publishes(runB).length;
      await clickPost(runB);
      await waitFor(() => browser.publishes(runB).length > before && browser.publishes(runB)[before].state !== 'pending', 25_000, 'the empty-body post to settle');
      const record = browser.publishes(runB)[before];
      if (record.state !== 'unobserved') throw new Error(`Expected an unobserved record, found ${record.state}.`);
      const verdict = await browser.confirmPublish(AGENT, runB, record.publishId, null, AbortSignal.timeout(40_000));
      const elapsed = Date.now() - record.sentAt;
      const reconciled = payloads(runB, 'PUBLISH_RECONCILED').filter(p => p.publishId === record.publishId).at(-1);
      if (verdict !== 'present' || reconciled?.verdict !== 'present') throw new Error(`The page check returned ${verdict}.`);
      // Phase 2 would have moved to the profile, which lists only the pinned post, so 'present' this early is phase 1.
      if (elapsed > 17_000) throw new Error(`Found only ${elapsed} ms after sending, which is past phase 1.`);
      return `An article rendered 6 s after the post was found by phase 1, ${elapsed} ms after sending; PUBLISH_RECONCILED present.`;
    });
    await check('new-tab-routed', async () => {
      const text = `Verifier new tab ${new Date().toISOString()}`;
      await call(runB, { action: 'snapshot' });
      await call(runB, { action: 'navigate', url: `${FIXTURE}/home` });
      const opened = await call(runB, { action: 'new_tab', url: `${FIXTURE}/compose?answer=confirm` });
      if (opened.tabs.length < 2) throw new Error(`Expected two tabs after new_tab, found ${opened.tabs.length}.`);
      await typePost(runB, text);
      const attemptsBefore = payloads(runB, 'PUBLISH_ATTEMPTED').length;
      const createsBefore = seam.creates.length;
      await clickPost(runB);
      await waitFor(() => payloads(runB, 'PUBLISH_ATTEMPTED').length > attemptsBefore && seam.creates.length > createsBefore, 25_000, 'the post from the new tab to reach the route handler');
      const click = payloads(runB, 'EXTERNAL_ACTION_STARTED').filter(p => p.action === 'click').at(-1);
      const attempted = payloads(runB, 'PUBLISH_ATTEMPTED').at(-1);
      if (attempted.by !== 'model' || attempted.actionId !== click?.actionId) throw new Error(`The new tab's post was attributed to ${attempted.by} ${attempted.actionId ?? ''}, not to the click.`);
      return `A POST from a tab opened after the session started (${opened.tabs.length} tabs) reached the route handler: PUBLISH_ATTEMPTED by model for click ${click.actionId}. The fixture registers no service worker, so the bypass itself is not exercised.`;
    });
  } finally { await finishRun(runB); }

  // Run C: a routine-shaped run cancelled while its post is unresolved. endRun is deliberately not called:
  // the 30 s deferred-teardown timer must end the session by itself.
  const runC = startRun({ publishLimit: 1 });
  const cancel = new AbortController();
  try {
    await check('deferred-teardown', async () => {
      const text = `Verifier teardown ${new Date().toISOString()}`;
      await call(runC, { action: 'navigate', url: `${FIXTURE}/compose?answer=empty&late=3000` }, cancel.signal);
      await typePost(runC, text, cancel.signal);
      await clickPost(runC, cancel.signal);
      await waitFor(() => browser.publishes(runC).some(r => r.state === 'unobserved'), 25_000, 'an unobserved post');
      const abortedAt = Date.now();
      cancel.abort(new Error('Verifier cancel with an unresolved post.'));
      await delay(1_000);
      if (browser.status().active !== 1) throw new Error('The session closed at once although a post was unresolved.');
      const records = await browser.closeOutPublishes(AGENT, runC, AbortSignal.timeout(25_000));
      const keptFor = Date.now() - abortedAt;
      if (records[0]?.state !== 'confirmed' || records[0]?.confirmedBy !== 'page') throw new Error(`Close-out left the post ${records[0]?.state ?? 'missing'}.`);
      if (browser.status().active !== 1) throw new Error('The session ended before close-out finished.');
      // The timer fires 30 s after the cancel; endRun then closes Chrome and stops the container (docker stop waits up to 20 s).
      await waitFor(() => browser.status().active === 0, 70_000, 'the deferred teardown to end the session');
      const endedAfter = Date.now() - abortedAt;
      if (endedAfter < 29_000) throw new Error(`The session ended ${endedAfter} ms after the cancel, before the 30 s deferral.`);
      if (endedAfter > 60_000) throw new Error(`The session ended ${endedAfter} ms after the cancel; the timer is 30 s and the container stop at most 20 s.`);
      const info = JSON.parse(await docker(['container', 'inspect', identity.name]))[0];
      if (info.State.Running !== false) throw new Error('The bot desktop container is still running after the deferred teardown.');
      return `The cancelled session was kept ${keptFor} ms for close-out, which confirmed the post on the page; the 30 s timer ended it ${endedAfter} ms after the cancel, and the container is stopped.`;
    });
  } finally { await finishRun(runC, 'ABORTED'); }
} catch (error) {
  evidence.error = String(error?.stack ?? error).slice(0, 4000);
} finally {
  await browser.stop().catch(() => {});
  await desktop.stop().catch(() => {});
  store.close();
  // Only this verifier's own resources, and only after their bot label and name match.
  for (const [kind, name] of desktopRequested ? [['container', identity.name], ['volume', identity.volume], ['network', identity.network]] : []) {
    try {
      const found = await runner([kind, 'inspect', name], { timeoutMs: 30_000 });
      if (found.exitCode) continue;
      const info = JSON.parse(found.stdout)[0];
      const labels = kind === 'container' ? info.Config.Labels : info.Labels;
      if (labels?.['openhours.desktop.bot'] !== identity.bot || info.Name !== (kind === 'container' ? '/' + name : name)) {
        (evidence.cleanupWarnings ??= []).push(`${kind} ${name} is not this verifier's; it was left untouched.`);
        continue;
      }
      await docker([kind, 'rm', ...(kind === 'container' ? ['-f'] : []), name]);
      if (!(await runner([kind, 'inspect', name], { timeoutMs: 30_000 })).exitCode) (evidence.cleanupWarnings ??= []).push(`${kind} ${name} still exists after removal.`);
    } catch (error) {
      (evidence.cleanupWarnings ??= []).push(`${kind} ${name}: ${String(error?.message ?? error).slice(0, 300)}`);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  for (const name of CHECKS) {
    if (!evidence.checks.some(c => c.name === name)) evidence.checks.push({ name, passed: false, detail: `Not run: ${evidence.error ? evidence.error.split('\n')[0] : 'an earlier step stopped the verifier'}.` });
  }
  evidence.checks.sort((a, b) => CHECKS.indexOf(a.name) - CHECKS.indexOf(b.name));
  evidence.passed = !evidence.error && evidence.checks.every(c => c.passed);
  const output = path.join(repoRoot, 'docs', 'validation', `${day}-honest-posting`, packageRoot ? 'bot-desktop-package.json' : 'bot-desktop.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${path.relative(repoRoot, output)}`);
  process.exitCode = evidence.passed ? 0 : 1;
}
