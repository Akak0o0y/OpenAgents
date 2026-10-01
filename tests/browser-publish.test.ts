import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  PublishWatch,
  completionVerdict,
  publishRouteDecision,
  type AdmitResult,
  type PublishRecord,
  type PublishResponse,
  type RunPolicy,
} from '../src/daemon/browser-publish.js';
import { textSha256, xCreateTweet, type PublishProbe } from '../src/daemon/publish-probes.js';

/**
 * PublishWatch with fake requests (spec sections 6.2, 6.4 and 11.2). The probe here is a test
 * probe for a fixture origin, so these cases prove the watch's own rules and do not depend on
 * X's inferred CreateTweet shape; the one case that uses the real X probe says so in its title.
 * Nothing is sent anywhere: requests and responses are plain objects.
 */

const ORIGIN = 'https://publish-fixture.invalid';
const PROBE_ID = 'fixture/publish';
const TEXT = 'The fixture bot says hello to everyone';
const BODY_MARKER = 'BODY_MARKER_VALUE';

// Test probe: POST <ORIGIN>/publish with {"text", "replyTo"?}; a response {"id"} confirms,
// {"refused": true} is a certain rejection, anything else is unobserved.
const fixtureProbe: PublishProbe = {
  id: PROBE_ID,
  origins: [ORIGIN],
  notCreatedCodes: new Set([1]),
  account: { role: 'link', name: 'Profile' },
  match(req) {
    if (req.method !== 'POST' || req.url.origin !== ORIGIN || req.url.pathname !== '/publish') return null;
    const parsed = JSON.parse(req.postData ?? '{}') as { text?: string; replyTo?: string };
    return { probe: PROBE_ID, op: parsed.replyTo ? 'reply' : 'post', text: parsed.text, ...(parsed.replyTo ? { inReplyTo: parsed.replyTo } : {}) };
  },
  classify(res) {
    const json = res.body && res.body.length ? JSON.parse(res.body.toString('utf8')) as { id?: string; refused?: boolean } : null;
    if (res.status === 200 && json?.id) return { outcome: 'confirmed', postId: json.id, shape: ['id'] };
    if (json?.refused) return { outcome: 'rejected', reason: 'code 1', errorCodes: [1], shape: ['refused'] };
    return { outcome: 'unobserved', reason: json ? 'no-id' : 'empty-body', errorCodes: [], shape: [] };
  },
  postPath: (account, postId) => `/${account}/status/${postId}`,
  profilePaths: account => [`/${account}`],
};

const publish = (text: string, replyTo?: string) =>
  ({ method: 'POST', url: new URL(`${ORIGIN}/publish?session=QUERY_MARKER`), postData: JSON.stringify({ text, ...(replyTo ? { replyTo } : {}) }) });
const other = (path: string, postData: string | null, method = 'POST') => ({ method, url: new URL(`${ORIGIN}${path}`), postData });
const respond = (status: number, json: unknown): Promise<PublishResponse> =>
  Promise.resolve({ status: () => status, body: async () => Buffer.from(JSON.stringify(json)) });
const CONFIRMED = { id: '2101869834065576282', text: BODY_MARKER };
const REJECTED = { refused: true, text: BODY_MARKER };
const routine = (recent?: { textHashes?: string[]; targets?: string[] }): RunPolicy =>
  ({ publishLimit: 1, recent: { textHashes: new Set(recent?.textHashes ?? []), targets: new Set(recent?.targets ?? []) } });

function harness(opts: { policy?: RunPolicy; probes?: PublishProbe[]; resolvePostUrl?: (record: PublishRecord) => Promise<string | undefined>; emit?: (type: string, payload: unknown) => void } = {}) {
  let clock = 1_790_000_000_000;
  const events: Array<{ type: string; payload: unknown }> = [];
  const emit = opts.emit ?? ((type: string, payload: unknown) => { events.push({ type, payload }); });
  const watch = new PublishWatch({ probes: opts.probes ?? [fixtureProbe], policy: opts.policy, emit, now: () => clock, resolvePostUrl: opts.resolvePostUrl });
  return { watch, events, emit, now: () => clock, advance: (ms: number) => { clock += ms; } };
}

function tracked(result: AdmitResult) {
  assert.equal(result.kind, 'track', JSON.stringify(result));
  return result as Extract<AdmitResult, { kind: 'track' }>;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('attribution: a request while a bot action is open belongs to that action', () => {
  const h = harness();
  h.watch.beginAction('a1', 'model', 'click', h.now());
  const model = tracked(h.watch.admit(publish(TEXT)));
  assert.equal(model.record.by, 'model');
  assert.equal(model.record.actionId, 'a1');
  h.watch.endAction('a1', h.now());
  h.watch.expect({actionId:'f1',text:'A second text for the flow author'});
  h.watch.beginAction('f1', 'flow', 'click', h.now());
  const flow = tracked(h.watch.admit(publish('A second text for the flow author')));
  assert.equal(flow.record.by, 'flow');
  assert.equal(flow.record.actionId, 'f1');
});

test('flow publication requires its expected text and reply target before a request can be tracked',()=>{
  const h=harness();h.watch.beginAction('flow','flow','click',h.now());
  assert.equal(h.watch.admit(publish(TEXT)).kind,'refuse');
  h.watch.expect({actionId:'flow',text:TEXT,inReplyTo:'123'});
  assert.equal(h.watch.admit(publish(TEXT,'456')).kind,'refuse');
  assert.equal(h.watch.admit(publish('Unexpected changed text','123')).kind,'refuse');
  assert.equal(tracked(h.watch.admit(publish(TEXT,'123'))).record.inReplyTo,'123');
});

test('attribution: operator input later than the latest bot STARTED makes the request the operator\'s', () => {
  const h = harness();
  h.watch.beginAction('a1', 'model', 'click', h.now());
  h.watch.endAction('a1', h.now());
  h.advance(200);
  h.watch.noteOperatorInput(h.now());
  const result = tracked(h.watch.admit(publish(TEXT)));
  assert.equal(result.record.by, 'operator');
  assert.equal(result.record.actionId, undefined);
});

test('attribution: within 20 s of the latest bot STARTED it is that action\'s, after that it is the page\'s', () => {
  const h = harness();
  h.watch.beginAction('a1', 'model', 'click', h.now());
  h.watch.endAction('a1', h.now() + 500);
  h.advance(10_000);
  assert.equal(tracked(h.watch.admit(publish(TEXT))).record.actionId, 'a1');
  h.advance(10_000); // exactly 20 s after STARTED: still the action's
  assert.equal(tracked(h.watch.admit(publish('Another text for the window test'))).record.actionId, 'a1');
  h.advance(1_000);
  const late = tracked(h.watch.admit(publish('A third text, now outside the window')));
  assert.equal(late.record.by, 'page');
  assert.equal(late.record.actionId, undefined);
  const fresh = harness();
  assert.equal(tracked(fresh.watch.admit(publish(TEXT))).record.by, 'page');
});

test('budget: a second bot publish in a routine run is refused and remembered for the action', () => {
  const h = harness({ policy: routine() });
  h.watch.beginAction('a1', 'model', 'click', h.now());
  tracked(h.watch.admit(publish(TEXT)));
  h.watch.endAction('a1', h.now());
  h.watch.beginAction('a2', 'model', 'click', h.now());
  assert.deepEqual(h.watch.admit(publish('A different text, same run')), { kind: 'refuse', reason: 'budget', by: 'model', actionId: 'a2', probe: PROBE_ID, op: 'post' });
  assert.deepEqual(h.watch.refusedFor('a2'), { reason: 'budget', op: 'post' });
  assert.equal(h.watch.refusedFor('a1'), undefined);
  h.watch.endAction('a2', h.now());
  h.advance(30_000);
  assert.deepEqual(h.watch.admit(publish('The page itself tries to post')), { kind: 'refuse', reason: 'budget', by: 'page', probe: PROBE_ID, op: 'post' });
  assert.equal(h.events.length, 0, 'admit never emits');
});

test('budget: a rejected record frees it', async () => {
  const h = harness({ policy: routine() });
  h.watch.beginAction('a1', 'model', 'click', h.now());
  const first = tracked(h.watch.admit(publish(TEXT)));
  assert.equal((await h.watch.track(first.record, respond(200, REJECTED))).state, 'rejected');
  h.watch.endAction('a1', h.now());
  h.watch.beginAction('a2', 'model', 'click', h.now());
  assert.equal(h.watch.admit(publish('A new text after the rejection')).kind, 'track');
});

test('budget: an operator publish is charged and never refused', () => {
  const h = harness({ policy: routine() });
  h.watch.noteOperatorInput(h.now());
  assert.equal(tracked(h.watch.admit(publish(TEXT))).record.by, 'operator');
  h.watch.beginAction('a1', 'model', 'click', h.now());
  assert.equal((h.watch.admit(publish('The bot tries after the operator')) as { reason?: string }).reason, 'budget');
  h.watch.endAction('a1', h.now());
  h.watch.noteOperatorInput(h.now());
  // the operator can still post again by hand, even the same text (risk 15)
  assert.equal(tracked(h.watch.admit(publish(TEXT))).record.by, 'operator');
});

test('outside routine runs nothing is refused: two posts are both tracked', () => {
  const h = harness();
  h.watch.beginAction('a1', 'model', 'click', h.now());
  tracked(h.watch.admit(publish(TEXT)));
  h.watch.endAction('a1', h.now());
  h.watch.beginAction('a2', 'model', 'click', h.now());
  tracked(h.watch.admit(publish(TEXT)));
  assert.equal(h.watch.all().length, 2);
  assert.equal(h.watch.refusedFor('a2'), undefined);
});

test('duplicate-text and duplicate-target are refused against the recent sets, after budget', () => {
  const recent = harness({ policy: routine({ textHashes: [textSha256(TEXT)], targets: ['2101869834065576282'] }) });
  recent.watch.beginAction('a1', 'model', 'click', recent.now());
  assert.equal((recent.watch.admit(publish('  The fixture bot   says hello to everyone ')) as { reason?: string }).reason, 'duplicate-text');
  assert.equal((recent.watch.admit(publish(TEXT, '999')) as { reason?: string }).reason, 'duplicate-text', 'text is checked before target');
  assert.equal((recent.watch.admit(publish('A fresh reply to an old target', '2101869834065576282')) as { reason?: string }).reason, 'duplicate-target');
  assert.deepEqual(recent.watch.refusedFor('a1'), { reason: 'duplicate-text', op: 'post' }, 'the first refusal of the action is kept');
  const order = harness({ policy: routine({ textHashes: [textSha256(TEXT)] }) });
  order.watch.beginAction('a1', 'model', 'click', order.now());
  tracked(order.watch.admit(publish('Something new that goes through')));
  assert.equal((order.watch.admit(publish(TEXT)) as { reason?: string }).reason, 'budget', 'budget is checked first');
});

test('a rejected attempt still counts toward duplicate-text and duplicate-target in the run', async () => {
  const h = harness({ policy: routine() });
  h.watch.beginAction('a1', 'model', 'click', h.now());
  const first = tracked(h.watch.admit(publish(TEXT, '1234567890123456789')));
  await h.watch.track(first.record, respond(200, REJECTED));
  h.watch.endAction('a1', h.now());
  h.watch.beginAction('a2', 'model', 'click', h.now());
  assert.equal((h.watch.admit(publish(TEXT, '555')) as { reason?: string }).reason, 'duplicate-text');
  assert.equal((h.watch.admit(publish('Different words, same target', '1234567890123456789')) as { reason?: string }).reason, 'duplicate-target');
  assert.equal(h.watch.admit(publish('Different words, different target', '555')).kind, 'track');
});

test('admit returns the attempted payload for every track, with exactly the PublishAttempted fields', () => {
  const h = harness({ policy: routine() });
  h.watch.beginAction('a1', 'model', 'click', h.now());
  const result = tracked(h.watch.admit(publish(TEXT, '2101869834065576282')));
  assert.deepEqual(Object.keys(result.attempted).sort(), ['actionId', 'by', 'exactDigest', 'inReplyTo', 'op', 'origin', 'probe', 'publishId', 'sentAt', 'textSha256']);
  assert.deepEqual(result.attempted, { publishId: result.record.publishId, actionId: 'a1', by: 'model', probe: PROBE_ID, op: 'reply', origin: ORIGIN,
    inReplyTo: '2101869834065576282', textSha256: textSha256(TEXT),exactDigest:createHash('sha256').update(TEXT).digest('hex'), sentAt: h.now() });
  assert.equal(result.record.state, 'pending');
  assert.match(result.record.publishId, /^[0-9a-f-]{36}$/);
  assert.equal(h.events.length, 0);
});

test('on x.com only a GraphQL write can be an unprobed publish: a telemetry post echoing a typed search passes (assumed X response shape)', () => {
  const h = harness({ probes: [xCreateTweet()], policy: routine() });
  const query = 'AI agents that post on their own';
  h.watch.noteFill(query);
  h.watch.beginAction('a1', 'model', 'press', h.now());
  const telemetry = { method: 'POST', url: new URL('https://x.com/i/api/1.1/jot/client_event.json'),
    postData: 'category=perftown&log=' + encodeURIComponent(JSON.stringify([{ event_namespace: { page: 'search' }, search_details: { query } }])) };
  assert.deepEqual(h.watch.admit(telemetry), { kind: 'pass' }, 'an analytics post that repeats the search is not a post');
  const draft = { method: 'POST', url: new URL('https://x.com/i/api/1.1/drafts/autosave.json'), postData: JSON.stringify({ draft: { text: query } }) };
  assert.deepEqual(h.watch.admit(draft), { kind: 'pass' }, 'a REST draft save is not a post');
  const renamed = { method: 'POST', url: new URL('https://x.com/i/api/graphql/Zz9/CreateTweetRenamed'), postData: JSON.stringify({ variables: { post_text: query } }) };
  const record = tracked(h.watch.admit(renamed)).record;
  assert.equal(record.unprobed, true, 'a GraphQL write that repeats the typed text can still be a renamed post');
  assert.equal(h.watch.all().length, 1);
});

test('an unprobed echo of a noted fill from a click is tracked with pathShape and settles unobserved', async () => {
  const h = harness({ policy: routine() });
  h.watch.noteFill(TEXT);
  h.watch.beginAction('c1', 'model', 'click', h.now());
  const result = tracked(h.watch.admit(other('/i/api/1.1/drafts/12345678/autosave.json?token=QUERY_MARKER', JSON.stringify({ draft: TEXT }))));
  assert.deepEqual(result.attempted, { publishId: result.record.publishId, actionId: 'c1', by: 'model', probe: PROBE_ID, op: 'unknown', origin: ORIGIN,
    unprobed: true, textSha256: textSha256(TEXT), sentAt: h.now(), pathShape: '/i/api/1.1/drafts/*/autosave.json' });
  const settled = await h.watch.track(result.record, respond(200, { ok: true }));
  assert.equal(settled.state, 'unobserved');
  assert.equal(settled.reason, 'unprobed');
  // it uses the run's budget: the real post from the same click is refused
  assert.equal((h.watch.admit(publish(TEXT)) as { reason?: string }).reason, 'budget');
});

test('an echo is tracked only from a submitting gesture, the operator or the page, never from typing', () => {
  const echo = () => other('/i/api/1.1/drafts/autosave.json', JSON.stringify({ draft: TEXT }));
  const h = harness();
  h.watch.noteFill(TEXT);
  h.watch.beginAction('f1', 'model', 'fill', h.now());
  assert.deepEqual(h.watch.admit(echo()), { kind: 'pass' }, 'during the fill');
  h.watch.endAction('f1', h.now());
  h.advance(1_000);
  assert.deepEqual(h.watch.admit(echo()), { kind: 'pass' }, 'within 20 s after the fill');
  h.watch.beginAction('p1', 'model', 'press', h.now());
  assert.equal(tracked(h.watch.admit(echo())).record.actionId, 'p1');
  h.watch.endAction('p1', h.now());
  h.watch.noteOperatorInput(h.now());
  assert.equal(tracked(h.watch.admit(echo())).record.by, 'operator');
  const page = harness();
  page.watch.noteFill(TEXT);
  assert.equal(tracked(page.watch.admit(echo())).record.by, 'page');
});

test('text the bot never filled is not tracked, and neither is a GET or another origin', () => {
  const h = harness();
  h.watch.noteFill(TEXT);
  h.watch.noteOperatorInput(h.now());
  assert.deepEqual(h.watch.admit(other('/i/api/1.1/dm/new.json', JSON.stringify({ text: 'Operator typed this direct message' }))), { kind: 'pass' });
  assert.deepEqual(h.watch.admit(other('/search', JSON.stringify({ q: TEXT }), 'GET')), { kind: 'pass' });
  assert.deepEqual(h.watch.admit({ method: 'POST', url: new URL('https://elsewhere.invalid/publish'), postData: JSON.stringify({ text: TEXT }) }), { kind: 'pass' });
  assert.equal(h.watch.all().length, 0);
});

test('publishRouteDecision: refuse aborts with PUBLISH_REFUSED, track emits PUBLISH_ATTEMPTED, a non-match continues', () => {
  const h = harness({ policy: routine() });
  h.watch.beginAction('a1', 'model', 'click', h.now());
  const first = publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: publish(TEXT), emit: h.emit });
  assert.equal(first.kind, 'track');
  assert.equal(h.events[0].type, 'PUBLISH_ATTEMPTED');
  assert.equal((h.events[0].payload as { publishId: string }).publishId, first.kind === 'track' ? first.record.publishId : '');
  const second = publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: publish('A second post in the same run'), emit: h.emit });
  assert.deepEqual(second, { kind: 'abort', refusal: { reason: 'budget', op: 'post', actionId: 'a1' } });
  assert.deepEqual(h.events[1], { type: 'PUBLISH_REFUSED', payload: { probe: PROBE_ID, op: 'post', reason: 'budget', actionId: 'a1', by: 'model' } });
  assert.deepEqual(publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: other('/i/api/1.1/jot/client_event.json', '{"event":"scroll"}'), emit: h.emit }), { kind: 'continue' });
  assert.deepEqual(publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: other('/publish', null, 'GET'), emit: h.emit }), { kind: 'continue' });
  assert.deepEqual(publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: { method: 'POST', url: new URL('https://elsewhere.invalid/publish'), postData: '{}' }, emit: h.emit }), { kind: 'continue' });
  assert.equal(h.events.length, 2);
});

test('publishRouteDecision: a refusal whose PUBLISH_REFUSED insert throws is still aborted', () => {
  const h = harness({ policy: routine() });
  const emit = (type: string, payload: unknown) => { if (type === 'PUBLISH_REFUSED') throw new Error('database is locked'); h.events.push({ type, payload }); };
  h.watch.beginAction('a1', 'model', 'click', h.now());
  assert.equal(publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: publish(TEXT), emit }).kind, 'track');
  assert.equal(publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: publish('Another post'), emit }).kind, 'abort');
});

test('publishRouteDecision: a probe whose match throws aborts with PUBLISH_REFUSED {reason:\'internal\'}', () => {
  const broken: PublishProbe = { ...fixtureProbe, match() { throw new Error('probe bug'); } };
  const h = harness({ probes: [broken] });
  assert.deepEqual(publishRouteDecision({ watch: h.watch, probes: [broken], req: publish(TEXT), emit: h.emit }), { kind: 'abort', refusal: { reason: 'internal', op: 'unknown' } });
  assert.deepEqual(h.events, [{ type: 'PUBLISH_REFUSED', payload: { reason: 'internal', probe: PROBE_ID, op: 'unknown', by: 'page' } }]);
});

test('publishRouteDecision: when the PUBLISH_ATTEMPTED insert throws, the request is aborted and its record dropped', () => {
  const h = harness({ policy: routine() });
  let failInsert = true;
  let failedId: string | undefined;
  const emit = (type: string, payload: unknown) => {
    if (type === 'PUBLISH_ATTEMPTED' && failInsert) { failedId = (payload as { publishId: string }).publishId; throw new Error('database is locked'); }
    h.events.push({ type, payload });
  };
  // A reply, so the retry below proves that both the text hash and the reply target left the run's dedupe sets.
  const reply = () => publish(TEXT, '1234567890123456789');
  h.watch.beginAction('a1', 'model', 'click', h.now());
  assert.deepEqual(publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: reply(), emit }), { kind: 'abort', refusal: { reason: 'internal', op: 'unknown' } });
  assert.deepEqual(h.events, [{ type: 'PUBLISH_REFUSED', payload: { reason: 'internal', probe: PROBE_ID, op: 'unknown', by: 'page' } }]);
  assert.equal(h.watch.all().length, 0, 'no phantom pending record');
  assert.equal(h.watch.anyPending(), false);
  assert.equal(h.watch.refusedFor('a1'), undefined, 'refusedFor holds admit refusals only, never an internal one');
  // The BrowserTools route handler drops the failed attempt again (task 7): a no-op for an id the watch no longer holds.
  assert.ok(failedId);
  h.watch.dropAdmitted(failedId);
  assert.equal(h.watch.all().length, 0);
  failInsert = false;
  assert.equal(publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: reply(), emit }).kind, 'track', 'the budget was not used, and neither the text nor the reply target is a duplicate');
});

test('publishRouteDecision: an admission failure on a request that matches nothing continues', () => {
  const failing = { admit() { throw new Error('admission bug'); }, recognizes: () => false, dropAdmitted() {} } as unknown as PublishWatch;
  const events: unknown[] = [];
  assert.deepEqual(publishRouteDecision({ watch: failing, probes: [fixtureProbe], req: other('/i/api/1.1/jot/client_event.json', '{}'), emit: (type, payload) => { events.push({ type, payload }); } }), { kind: 'continue' });
  assert.equal(events.length, 0);
  const unsure = { admit() { throw new Error('admission bug'); }, recognizes() { throw new Error('probe bug'); }, dropAdmitted() {} } as unknown as PublishWatch;
  assert.equal(publishRouteDecision({ watch: unsure, probes: [fixtureProbe], req: other('/anything', '{}'), emit: () => {} }).kind, 'abort', 'a throwing re-test counts as recognized');
});

test('dropAdmitted removes only an admitted record that is not yet tracked, and ignores an id it does not hold', async () => {
  const h = harness({ policy: routine() });
  const first = tracked(h.watch.admit(publish(TEXT, '1234567890123456789')));
  h.watch.dropAdmitted('no-such-publish-id');
  assert.equal(h.watch.all().length, 1, 'an unknown id is a no-op');
  h.watch.dropAdmitted(first.record.publishId);
  assert.equal(h.watch.all().length, 0);
  h.watch.dropAdmitted(first.record.publishId);
  assert.equal(h.watch.all().length, 0, 'a second drop of the same id is a no-op');
  // The dropped record leaves no trace: the same text on the same post is admitted again, not refused as a duplicate.
  const second = tracked(h.watch.admit(publish(TEXT, '1234567890123456789')));
  const settling = h.watch.track(second.record, respond(200, CONFIRMED));
  h.watch.dropAdmitted(second.record.publishId);
  assert.equal((await settling).state, 'confirmed');
  assert.equal(h.watch.all().length, 1);
});

test('track settles no-response on a null or failed response, and body-unreadable when body() rejects', async () => {
  const h = harness();
  const nullResponse = tracked(h.watch.admit(publish('First text for the null response')));
  assert.equal((await h.watch.track(nullResponse.record, Promise.resolve(null))).reason, 'no-response');
  const failed = tracked(h.watch.admit(publish('Second text for the failed request')));
  assert.equal((await h.watch.track(failed.record, Promise.reject(new Error('net::ERR_ABORTED')))).reason, 'no-response');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const unreadable = tracked(h.watch.admit(publish('Third text whose body cannot be read')));
    const settled = await h.watch.track(unreadable.record, Promise.resolve({ status: () => 200, body: () => Promise.reject(new Error('No resource with given identifier found')) }));
    assert.equal(settled.state, 'unobserved');
    assert.equal(settled.reason, 'body-unreadable');
    assert.equal(settled.status, 200);
    const empty = tracked(h.watch.admit(publish('Fourth text with an empty body')));
    assert.equal((await h.watch.track(empty.record, Promise.resolve({ status: () => 200, body: async () => Buffer.alloc(0) }))).reason, 'empty-body');
    await flush();
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []);
  const observed = h.events.filter(event => event.type === 'PUBLISH_OBSERVED').map(event => (event.payload as { reason?: string }).reason);
  assert.deepEqual(observed, ['no-response', 'no-response', 'body-unreadable', 'empty-body']);
});

test('track settles timeout at sentAt + 20 s', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const probed = tracked(h.watch.admit(publish(TEXT)));
  h.watch.noteFill('A draft text that is echoed later');
  h.watch.beginAction('c1', 'model', 'click', h.now());
  const unprobed = tracked(h.watch.admit(other('/drafts', JSON.stringify({ draft: 'A draft text that is echoed later' }))));
  const hanging = new Promise<PublishResponse | null>(() => {});
  const first = h.watch.track(probed.record, hanging);
  const second = h.watch.track(unprobed.record, hanging);
  t.mock.timers.tick(19_999);
  await flush();
  assert.equal(h.watch.anyPending(), true);
  t.mock.timers.tick(1);
  assert.equal((await first).reason, 'timeout');
  assert.equal((await second).reason, 'unprobed');
  assert.equal(h.watch.anyPending(), false);
  assert.equal(h.events.filter(event => event.type === 'PUBLISH_OBSERVED').length, 2);
});

test('a confirmed PUBLISH_OBSERVED carries the postUrl from resolvePostUrl and is emitted once', async () => {
  const seen: PublishRecord[] = [];
  const h = harness({ resolvePostUrl: async record => { seen.push(record); return `${ORIGIN}/fixture_bot/status/${record.postId}`; } });
  h.watch.beginAction('a1', 'model', 'click', h.now());
  const result = tracked(h.watch.admit(publish(TEXT)));
  const [one, two] = await Promise.all([h.watch.track(result.record, respond(200, CONFIRMED)), h.watch.track(result.record, respond(200, CONFIRMED))]);
  assert.equal(one.state, 'confirmed');
  assert.equal(one.confirmedBy, 'response');
  assert.equal(one.postUrl, `${ORIGIN}/fixture_bot/status/2101869834065576282`);
  assert.deepEqual(two, one);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].postId, '2101869834065576282');
  const observed = h.events.filter(event => event.type === 'PUBLISH_OBSERVED');
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].payload, { publishId: result.record.publishId, outcome: 'confirmed', status: 200, shape: ['id'], postId: '2101869834065576282',
    postUrl: `${ORIGIN}/fixture_bot/status/2101869834065576282`, settledAt: h.now() });
});

test('track never rejects: a throwing resolvePostUrl or emit leaves the verdict in the record', async () => {
  const noUrl = harness({ resolvePostUrl: async () => { throw new Error('page navigated'); } });
  const a = tracked(noUrl.watch.admit(publish(TEXT)));
  const settled = await noUrl.watch.track(a.record, respond(200, CONFIRMED));
  assert.equal(settled.state, 'confirmed');
  assert.equal(settled.postUrl, undefined);
  const closed = harness({ emit: () => { throw new Error('The database connection is not open'); } });
  const b = tracked(closed.watch.admit(publish(TEXT)));
  assert.equal((await closed.watch.track(b.record, respond(200, REJECTED))).state, 'rejected');
});

test('the X probe end to end: a confirmed CreateTweet reply is tracked and settled (assumed X response shape)', async () => {
  const x = xCreateTweet([ORIGIN]);
  const h = harness({ probes: [x], policy: routine() });
  h.watch.beginAction('a1', 'model', 'click', h.now());
  const req = { method: 'POST', url: new URL(`${ORIGIN}/i/api/graphql/q1/CreateTweet`), postData: JSON.stringify({ variables: { tweet_text: TEXT, reply: { in_reply_to_tweet_id: '1234567890123456789' } } }) };
  const result = tracked(h.watch.admit(req));
  assert.equal(result.record.op, 'reply');
  assert.equal(result.record.probe, 'x.com/create-tweet');
  const settled = await h.watch.track(result.record, respond(200, { data: { create_tweet: { tweet_results: { result: { rest_id: '2101869834065576282' } } } } }));
  assert.equal(settled.state, 'confirmed');
  assert.equal(settled.postId, '2101869834065576282');
});

test('settle resolves at the verdict, at the absolute deadline, and when the signal fires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.watch.beginAction('a1', 'model', 'click', h.now());
  const confirmed = tracked(h.watch.admit(publish(TEXT)));
  const atVerdict = h.watch.settle('a1', h.now() + 5_000, new AbortController().signal);
  void h.watch.track(confirmed.record, respond(200, CONFIRMED));
  assert.equal((await atVerdict)?.state, 'confirmed');
  h.watch.endAction('a1', h.now());
  h.watch.beginAction('a2', 'model', 'click', h.now());
  tracked(h.watch.admit(publish('A post that never gets an answer')));
  const atDeadline = h.watch.settle('a2', h.now() + 5_000, new AbortController().signal);
  t.mock.timers.tick(5_000);
  assert.equal((await atDeadline)?.state, 'pending');
  const controller = new AbortController();
  const onAbort = h.watch.settle('a2', h.now() + 5_000, controller.signal);
  controller.abort();
  assert.equal((await onAbort)?.state, 'pending');
  assert.equal((await h.watch.settle('a2', h.now() + 5_000, AbortSignal.abort(new Error('run cancelled'))))?.state, 'pending', 'an aborted signal resolves; settle never rejects');
  const none = h.watch.settle('no-such-action', h.now() + 1_000, new AbortController().signal);
  t.mock.timers.tick(1_000);
  assert.equal(await none, undefined);
});

test('allSettled resolves when nothing is pending, at untilMs, or on abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  await h.watch.allSettled(h.now() + 20_000, new AbortController().signal);
  const first = tracked(h.watch.admit(publish(TEXT)));
  let done = false;
  const waiting = h.watch.allSettled(h.now() + 20_000, new AbortController().signal).then(() => { done = true; });
  await flush();
  assert.equal(done, false);
  await h.watch.track(first.record, respond(200, CONFIRMED));
  await waiting;
  tracked(h.watch.admit(publish('A post that hangs')));
  const atLimit = h.watch.allSettled(h.now() + 3_000, new AbortController().signal);
  t.mock.timers.tick(3_000);
  await atLimit;
  assert.equal(h.watch.anyPending(), true);
  const controller = new AbortController();
  const aborted = h.watch.allSettled(h.now() + 20_000, controller.signal);
  controller.abort();
  await aborted;
  assert.equal(h.watch.anyPending(), true);
  // An already-aborted signal resolves too: allSettled never rejects with the signal's reason.
  await h.watch.allSettled(h.now() + 20_000, AbortSignal.abort(new Error('run cancelled')));
});

test('textFor matches by hash, and no text, body or query string is stored or emitted', async () => {
  const h = harness({ policy: routine(), resolvePostUrl: async record => `${ORIGIN}/i/status/${record.postId}` });
  h.watch.noteFill(TEXT);
  h.watch.beginAction('a1', 'model', 'click', h.now());
  const decision = publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: publish(TEXT), emit: h.emit });
  assert.equal(decision.kind, 'track');
  const settled = await h.watch.track(decision.kind === 'track' ? decision.record : ({} as PublishRecord), respond(200, CONFIRMED));
  assert.equal(h.watch.textFor(settled), TEXT);
  assert.equal(h.watch.textFor({ ...settled, textSha256: textSha256('Operator typed this, never filled') }), undefined);
  assert.equal(h.watch.textFor({ ...settled, textSha256: undefined }), undefined);
  publishRouteDecision({ watch: h.watch, probes: [fixtureProbe], req: publish('A refused second post text'), emit: h.emit });
  const stored = JSON.stringify(h.watch.all()) + JSON.stringify(h.events);
  for (const secret of [TEXT, 'A refused second post text', BODY_MARKER, 'QUERY_MARKER', 'session=']) assert.ok(!stored.includes(secret), secret);
});

test('markConfirmedByPage confirms an unobserved record and emits PUBLISH_RECONCILED present; a rejected one is left alone', async () => {
  const h = harness();
  const unseen = tracked(h.watch.admit(publish(TEXT)));
  await h.watch.track(unseen.record, Promise.resolve(null));
  const postUrl = `${ORIGIN}/fixture_bot/status/2101869834065576282`;
  h.watch.markConfirmedByPage(unseen.record.publishId, postUrl);
  const [confirmed] = h.watch.all();
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.confirmedBy, 'page');
  assert.equal(confirmed.postUrl, postUrl);
  assert.deepEqual(h.events.at(-1), { type: 'PUBLISH_RECONCILED', payload: { publishId: unseen.record.publishId, verdict: 'present', postUrl, by: 'page-check' } });
  assert.equal(h.watch.unresolved().length, 0);
  const refused = tracked(h.watch.admit(publish('A post that X refused')));
  await h.watch.track(refused.record, respond(200, REJECTED));
  const before = h.events.length;
  h.watch.markConfirmedByPage(refused.record.publishId, postUrl);
  assert.equal(h.watch.all()[1].state, 'rejected');
  assert.equal(h.events.length, before);
});

test('forAction, unresolved and all return copies', () => {
  const h = harness();
  h.watch.beginAction('a1', 'model', 'click', h.now());
  tracked(h.watch.admit(publish(TEXT)));
  const [record] = h.watch.forAction('a1');
  (record as { state: string }).state = 'confirmed';
  assert.equal(h.watch.all()[0].state, 'pending');
  assert.equal(h.watch.unresolved().length, 1);
  assert.equal(h.watch.forAction('a2').length, 0);
});

const NONE = 'This routine publishes on x.com and no post was confirmed in this run. Post it once, or end with block and say why.';
const UNCONFIRMED = 'X did not confirm the post you submitted and it is not on your profile yet. It may still have landed: do not post again; end with block.';
const REJECTED_TEXT = 'X refused the post (code 187). Nothing was published. Write different text (for a reply, choose another post: the same one will be held back) and post once, or end with block.';
const record = (state: PublishRecord['state'], by: PublishRecord['by'] = 'model', extra: Partial<PublishRecord> = {}): PublishRecord =>
  ({ publishId: `${state}-${by}`, by, probe: PROBE_ID, op: 'post', origin: ORIGIN, state, sentAt: 1, ...extra });

test('completionVerdict: none, unconfirmed and rejected, with mustPublish true and false', () => {
  assert.deepEqual(completionVerdict([], true), { ok: false, kind: 'none', message: NONE });
  assert.deepEqual(completionVerdict([], false), { ok: true });
  for (const mustPublish of [true, false]) {
    assert.deepEqual(completionVerdict([record('pending')], mustPublish), { ok: false, kind: 'unconfirmed', message: UNCONFIRMED });
    assert.deepEqual(completionVerdict([record('unobserved')], mustPublish), { ok: false, kind: 'unconfirmed', message: UNCONFIRMED });
    assert.deepEqual(completionVerdict([record('rejected', 'model', { reason: 'code 187' })], mustPublish), { ok: false, kind: 'rejected', message: REJECTED_TEXT });
    assert.deepEqual(completionVerdict([record('rejected', 'model', { reason: 'code 187' }), record('unobserved')], mustPublish).ok, false);
    assert.equal((completionVerdict([record('rejected', 'model', { reason: 'code 187' }), record('unobserved')], mustPublish) as { kind: string }).kind, 'unconfirmed');
  }
});

test('completionVerdict: a confirmed record by model, flow, operator or page satisfies completion, with mustPublish true and false', () => {
  for (const mustPublish of [true, false]) {
    for (const by of ['model', 'flow', 'operator', 'page'] as const) {
      const confirmed = record('confirmed', by, { confirmedBy: 'response', postUrl: `${ORIGIN}/fixture_bot/status/1` });
      assert.deepEqual(completionVerdict([record('rejected', 'model', { reason: 'code 187' }), confirmed], mustPublish), { ok: true, record: confirmed }, `${by}/${mustPublish}`);
    }
    const byPage = record('confirmed', 'model', { confirmedBy: 'page' });
    assert.deepEqual(completionVerdict([record('unobserved', 'page'), byPage], mustPublish), { ok: true, record: byPage });
  }
});
