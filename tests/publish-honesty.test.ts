import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../src/daemon/agent-store.js';
import type { RoutineRecord } from '../src/daemon/db/schema.js';
import { acknowledgeRoutine, pendingForRoutine, publishSummary, recentPublishes } from '../src/daemon/external-effects.js';
import { readWorkResult } from '../src/daemon/work-results.js';
import { postCheckLine, publishNote } from '../src/daemon/work-runtime.js';
import { textSha256 } from '../src/daemon/publish-probes.js';
import type { PublishRecord } from '../src/daemon/browser-publish.js';
import type { LLMRequest } from '../src/evals/llm-client.js';
import { ROUTINE_ASK_TASK } from '../src/daemon/work-contract.js';
import { flowHarness, type FlowHarness } from './helpers/flow-harness.js';
import { xFixture } from './helpers/x-fixture.js';

/**
 * Stage 1 honest posting through the real routine stack (spec 11.5): loop runs of a routine with a
 * strict scripted model, on the local X-shaped fixture. Local managed Chromium only: nothing here
 * proves Linux Chrome, CDP file transfer or X's real behaviour, and nothing is sent to X.
 */

const utcMinute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const answer = (text: string) => ({ tool: 'answer', text, citations: [] });
const pendingText = (runId: string, at: number, origin: string) =>
  `Not started: run ${runId} at ${utcMinute(at)} UTC submitted something on ${new URL(origin).host} whose result was never confirmed. Check the account, then choose “Checked — continue” on this routine.`;

function payloads(h: FlowHarness, runId: string, type: string): Array<Record<string, unknown>> {
  return h.store.getTaskEvents(runId).filter(e => e.event_type === type).map(e => JSON.parse(e.payload_json) as Record<string, unknown>);
}
const reportReason = (h: FlowHarness, runId: string) => payloads(h, runId, 'WORK_REPORT').at(-1)?.reason;

/** A finished earlier run of the routine holding the given events, an hour ago. */
function pastRun(store: AgentStore, routine: RoutineRecord, events: Array<[string, Record<string, unknown>]>, status: 'COMPLETED' | 'FAILED' = 'COMPLETED') {
  const run = store.createTaskRun({ agentId: routine.agent_id, taskName: routine.task_name ?? ROUTINE_ASK_TASK, routineId: routine.id });
  store.startTaskRun(run.id);
  const at = Date.now() - 3_600_000;
  events.forEach(([type, payload], index) => store.recordEvent({ task_run_id: run.id, agent_id: routine.agent_id, event_type: type, payload_json: JSON.stringify(payload), timestamp: at + index * 1000 }));
  store.finishTaskRun(run.id, status, status === 'COMPLETED' ? undefined : 'fixture');
  return { run, at };
}
/** A PUBLISH_ATTEMPTED payload as the route handler writes it (spec 8.6). */
const attempted = (origin: string, publishId: string, extra: Record<string, unknown> = {}) =>
  ({ publishId, actionId: `click-${publishId}`, by: 'model', probe: 'x.com/create-tweet', op: 'reply', origin, sentAt: Date.now() - 3_600_000, ...extra });

test('the pending gate: a routine with an unconfirmed earlier post is held by the producer, and a run by hand fails before any model call', { timeout: 60_000 }, async () => {
  const site = await xFixture();
  const h = flowHarness({ origin: site.origin, actions: [answer('Nothing new since the last run.')] });
  try {
    const routine = h.routine({ name: 'viral-life', instruction: 'Post one reply on the fixture timeline.', nextRunAt: Date.now() - 1000 });
    const earlier = pastRun(h.store, routine, [['PUBLISH_ATTEMPTED', attempted(site.origin, 'p-earlier')]], 'FAILED');
    await h.start();
    await delay(300);
    assert.deepEqual(h.store.listRoutineRuns(routine.id).map(r => r.id), [earlier.run.id], 'the producer left the held routine due');
    assert.equal(h.store.getRoutine(routine.id)!.next_run_at, routine.next_run_at);

    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    assert.equal(run.status, 'FAILED');
    assert.equal(h.requests.length, 0, 'no model was called');
    const expected = pendingText(earlier.run.id, earlier.at, site.origin);
    assert.equal(reportReason(h, runId), expected);
    assert.ok(readWorkResult(h.store, runId)!.report.includes(expected));
    assert.ok(run.error_message?.includes(expected), 'error_message is the whole report');
    assert.equal(h.browser.status().active, 0, 'no browser was opened');

    assert.equal(acknowledgeRoutine(h.store, 'alpha', routine.id), 1);
    await h.until(() => h.store.listRoutineRuns(routine.id).length === 3);
    const next = h.store.listRoutineRuns(routine.id).find(r => r.id !== earlier.run.id && r.id !== runId)!;
    assert.equal((await h.finished(next.id)).status, 'COMPLETED', 'after "Checked — continue" the next occurrence runs');
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); await site.close(); }
});

test('the pending gate applies to a routine on a structured contract, through its run\'s routine_id', { timeout: 60_000 }, async () => {
  const site = await xFixture();
  const h = flowHarness({ origin: site.origin, actions: [] });
  try {
    const routine = h.routine({ name: 'weekly-brief', instruction: 'Summarize the fixture timeline.', taskName: 'work:evidence-brief' });
    const earlier = pastRun(h.store, routine, [['PUBLISH_ATTEMPTED', attempted(site.origin, 'p-brief')]], 'FAILED');
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    assert.equal(run.status, 'FAILED');
    assert.equal(h.requests.length, 0);
    const definition = h.store.getRunDefinition(runId) as { work?: { conversation?: boolean } } | null;
    assert.equal(definition?.work?.conversation, undefined, 'not a conversation, so the runtime got no input.scheduled');
    const expected = pendingText(earlier.run.id, earlier.at, site.origin);
    assert.equal(reportReason(h, runId), expected);
    assert.ok(readWorkResult(h.store, runId)!.report.includes(expected));
  } finally { await h.close(); await site.close(); }
});

test('without the publishPolicy option a routine run is neither held nor gated', { timeout: 60_000 }, async () => {
  const site = await xFixture();
  const h = flowHarness({ origin: site.origin, actions: [answer('Nothing new since the last run.')], publishPolicy: false });
  try {
    const routine = h.routine({ name: 'viral-life', instruction: 'Post one reply on the fixture timeline.', nextRunAt: Date.now() - 1000 });
    const earlier = pastRun(h.store, routine, [['PUBLISH_ATTEMPTED', attempted(site.origin, 'p-old')]], 'FAILED');
    assert.equal(pendingForRoutine(h.store, routine.id).length, 1, 'the item the gate would hold on');
    await h.start();
    await h.until(() => h.store.listRoutineRuns(routine.id).length === 2);
    const runId = h.store.listRoutineRuns(routine.id).find(r => r.id !== earlier.run.id)!.id;
    const run = await h.finished(runId);
    assert.equal(run.status, 'COMPLETED');
    assert.equal(readWorkResult(h.store, runId)!.report, 'Nothing new since the last run.');
    assert.equal(h.requests.length, 1);
    assert.equal(h.store.getTaskEvents(runId).filter(e => e.event_type.startsWith('PUBLISH_')).length, 0);
  } finally { await h.close(); await site.close(); }
});

// Completion gate, observation notes and failure close-out (spec 6.3 item 5, 6.9, 6.10). Exact texts from the spec.
const NONE = 'This routine publishes on x.com and no post was confirmed in this run. Post it once, or end with block and say why.';
const TURN_LIMIT = 'Task turn limit reached before verified completion.';
const PENDING_NOTE = 'The post was sent and X has not confirmed it yet. Do not post again.';
const BUDGET_NOTE = 'A second post in this run was held back. Nothing more was sent.';
const DUPLICATE_NOTE = 'This post was held back: the same text or the same post was already used in the last 7 days. Nothing was sent. Write different text or choose another post.';
const confirmedNote = (postUrl: string) => `X confirmed the post: ${postUrl}. Do not post again; answer with the result.`;
const responseLine = (postUrl: string) => `Post check: ${postUrl} — confirmed by X's response.`;

const browse = (action: Record<string, unknown>) => ({ tool: 'browser', ...action });
const openPost = (url: string) => browse({ action: 'navigate', url });
const typeReply = (text: string) => browse({ action: 'fill', target: { role: 'textbox', name: 'Post text' }, value: text });
const clickReply = () => browse({ action: 'click', target: { role: 'button', name: 'Reply' } });
const block = (reason: string) => ({ tool: 'block', reason });
const write = (content: string) => ({ tool: 'write', path: 'report.md', content });
/** What the model read last in this request: the observation of the action before it. */
const lastMessage = (request: LLMRequest) => request.messages!.at(-1)!.content;
const errors = (h: FlowHarness, runId: string) => payloads(h, runId, 'TOOL_CALL').filter(p => p.status === 'error').map(p => [p.tool, p.summary]);
const eventOrder = (h: FlowHarness, runId: string) => h.store.getTaskEvents(runId).map(e => e.event_type);
const statusId = (statusPath: string) => statusPath.split('/').at(-1)!;
/** A routine that must post (the owner's switch), so completion needs a confirmed post. */
function mustPost(h: FlowHarness, name = 'honest-tweet') {
  const routine = h.routine({ name, instruction: 'Reply once to a post on the fixture timeline.' });
  h.publishPolicy.set('alpha', routine.id, true);
  return routine;
}

test('publish notes and post-check lines are the exact texts', () => {
  const postUrl = 'http://127.0.0.1:4555/fixture_bot/status/2101869834065576282';
  assert.equal(publishNote({ state: 'confirmed', postUrl }), confirmedNote(postUrl));
  assert.equal(publishNote({ state: 'pending' }), PENDING_NOTE);
  assert.equal(publishNote({ state: 'unobserved', reason: 'empty-body' }), PENDING_NOTE);
  assert.equal(publishNote({ state: 'refused', reason: 'budget' }), BUDGET_NOTE);
  assert.equal(publishNote({ state: 'refused', reason: 'duplicate-text' }), DUPLICATE_NOTE);
  assert.equal(publishNote({ state: 'refused', reason: 'duplicate-target' }), DUPLICATE_NOTE);
  assert.equal(publishNote({ state: 'rejected', reason: 'code 187' }), undefined, 'X refused it: the publish field says so');
  assert.equal(publishNote({ state: 'refused', reason: 'expected-mismatch' }), undefined, 'Stage 2 only');
  assert.equal(publishNote({ state: 'confirmed' }), undefined, 'no address is invented');
  const record: PublishRecord = { publishId: 'p1', actionId: 'a1', by: 'model', probe: 'x.com/create-tweet', op: 'reply', origin: 'http://127.0.0.1:4555', state: 'confirmed', confirmedBy: 'response', postUrl, sentAt: 1 };
  assert.equal(postCheckLine(record), responseLine(postUrl));
  assert.equal(postCheckLine({ ...record, confirmedBy: 'page' }), `Post check: ${postUrl} — checked on the page.`);
  assert.equal(postCheckLine({ ...record, by: 'operator', actionId: undefined }), `Post check: ${postUrl} — posted by you during takeover.`);
  assert.equal(postCheckLine({ ...record, postUrl: undefined, postId: '2101869834065576282' }), responseLine('http://127.0.0.1:4555/i/status/2101869834065576282'));
});

test('H1: a routine reply is recorded before it is sent, X confirms it, the model is told, and the report carries the post check (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  const text = 'A fixture reply about patient testing, sent once.';
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(1)), typeReply(text), clickReply(), answer('Replied once to a timeline post.')] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: 'Reply once to a post on the fixture timeline.' });
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    const result = readWorkResult(h.store, runId)!;
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.equal(site.state.requests, 1);
    const attemptedEvent = h.store.getTaskEvents(runId).find(e => e.event_type === 'PUBLISH_ATTEMPTED')!;
    assert.ok(attemptedEvent.timestamp <= site.state.receivedAt[0], 'PUBLISH_ATTEMPTED is durable before the site receives the post');
    assert.equal(JSON.parse(attemptedEvent.payload_json).textSha256, textSha256(text));
    assert.deepEqual(payloads(h, runId, 'PUBLISH_OBSERVED').map(p => p.outcome), ['confirmed']);
    const postUrl = `${site.origin}/fixture_bot/status/${site.state.created[0].id}`;
    const seen = lastMessage(h.requests[3]);
    assert.ok(seen.includes('"publish":{"state":"confirmed"'), seen.slice(0, 600));
    assert.ok(seen.includes(confirmedNote(postUrl)), 'the click observation tells the model not to post again');
    assert.ok(result.report.endsWith(`\n\n${responseLine(postUrl)}`), result.report);
    assert.equal(h.requests.length, 4);
    assert.equal(h.publishPolicy.get(routine.id)?.source, 'observed', 'the completion gate noted the attempt');
    assert.equal(h.publishPolicy.get(routine.id)?.evidenceRunId, runId);
    assert.equal(h.browser.status().active, 0);
  } finally { await h.close(); await site.close(); }
});

test('a reply held back as a duplicate is explained to the model, which replies to another post instead (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  const target = statusId(site.statusPath(1));
  const h = flowHarness({ origin: site.origin, actions: [
    openPost(site.origin + site.statusPath(1)), typeReply('A reply to a post this bot answered an hour ago.'), clickReply(),
    openPost(site.origin + site.statusPath(2)), typeReply('A reply to a different post on the fixture timeline.'), clickReply(),
    answer('Replied to a fresh post instead.'),
  ] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: 'Reply once to a post on the fixture timeline.' });
    // An hour ago this routine replied to post 1, and X confirmed it.
    pastRun(h.store, routine, [
      ['PUBLISH_ATTEMPTED', attempted(site.origin, 'p-hour-ago', { inReplyTo: target, textSha256: textSha256('An earlier reply from an hour ago.') })],
      ['PUBLISH_OBSERVED', { publishId: 'p-hour-ago', outcome: 'confirmed', postId: '2101869834065576282', postUrl: `${site.origin}/fixture_bot/status/2101869834065576282`, settledAt: Date.now() - 3_599_000 }],
    ]);
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    const result = readWorkResult(h.store, runId)!;
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_REFUSED').map(p => [p.reason, p.op, p.by]), [['duplicate-target', 'reply', 'model']]);
    const heldBack = lastMessage(h.requests[3]);
    assert.ok(heldBack.includes('"publish":{"state":"refused","op":"reply","reason":"duplicate-target"}'), heldBack.slice(0, 600));
    assert.ok(heldBack.includes(DUPLICATE_NOTE));
    assert.equal(site.state.requests, 1, 'the held-back reply never reached the site');
    assert.equal(site.state.created[0].inReplyTo, statusId(site.statusPath(2)));
    const postUrl = `${site.origin}/fixture_bot/status/${site.state.created[0].id}`;
    assert.ok(lastMessage(h.requests[6]).includes(confirmedNote(postUrl)));
    assert.ok(result.report.endsWith(responseLine(postUrl)), result.report);
    assert.equal(h.requests.length, 7);
  } finally { await h.close(); await site.close(); }
});

test('a routine run cannot delegate, so no delegated run can post outside its one-post limit', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  const refused = 'A routine run cannot delegate: a delegated run would post outside this routine\'s one-post limit. Do the work in this run.';
  const h = flowHarness({ origin: site.origin, actions: [
    { tool: 'delegate', taskName: 'reply-for-me', instruction: 'Reply to the top post on the fixture timeline.' },
    block('Delegation is not available in a routine run.'),
  ] });
  try {
    const routine = mustPost(h);
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    assert.equal(run.status, 'FAILED');
    assert.deepEqual(errors(h, runId), [['delegate', refused]]);
    assert.equal(h.store.listTaskRuns('alpha').filter(r => r.task_name === 'reply-for-me').length, 0, 'no delegated run was created');
    assert.equal(h.requests.length, 2);
    assert.equal(site.state.requests, 0);
  } finally { await h.close(); await site.close(); }
});

test('H9: on a must-post routine, answer and finish without a post are refused with the exact text', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  const h = flowHarness({ origin: site.origin, actions: [
    answer('Nothing needed posting today.'), write('Drafted a reply but did not send it.'), { tool: 'verify' }, { tool: 'finish' }, block('No reply was posted in this run.'),
  ] });
  try {
    const routine = mustPost(h);
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    assert.equal(run.status, 'FAILED');
    assert.deepEqual(errors(h, runId), [['answer', NONE], ['finish', NONE]]);
    assert.equal(readWorkResult(h.store, runId)!.blocked?.declaredBy, 'model');
    assert.equal(h.requests.length, 5);
    assert.equal(site.state.requests, 0);
  } finally { await h.close(); await site.close(); }
});

for (const [label, actions, maxTurns, route] of [
  ['verify then the turn limit', [write('Drafted a reply but did not send it.'), { tool: 'verify' }], 2, 'the verified end of the loop (2346)'],
  ['write then the turn limit', [write('Drafted a reply but did not send it.')], 1, 'the auto-verify at the turn limit (2333)'],
] as const) {
  test(`H9: ${label} on a must-post routine ends FAILED with the exact text, never the turn-limit text`, { timeout: 90_000 }, async () => {
    const site = await xFixture();
    const h = flowHarness({ origin: site.origin, actions: [...actions], contract: { maxTurns } });
    try {
      const routine = mustPost(h);
      await h.start();
      const runId = h.manual(routine.id);
      const run = await h.finished(runId);
      assert.equal(run.status, 'FAILED', route);
      assert.equal(reportReason(h, runId), NONE, 'WORK_REPORT.reason is the refusal text exactly');
      const report = readWorkResult(h.store, runId)!.report;
      assert.ok(report.includes(NONE), report);
      assert.ok(!report.includes(TURN_LIMIT));
      assert.ok(run.error_message?.includes(NONE), 'error_message is the whole report');
      assert.ok(!run.error_message?.includes(TURN_LIMIT));
      assert.equal(h.requests.length, maxTurns);
      assert.equal(eventOrder(h, runId).filter(type => type === 'WORK_VERIFIED').length, 1);
    } finally { await h.close(); await site.close(); }
  });
}

test('H10: a routine whose past run clicked on the site is must-post at start, and a draft-only run cannot complete', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-publish-honesty-'));
  const db = path.join(dir, 'state.db');
  // The database as an earlier OpenAgents left it: a routine that once clicked on the site, before Stage 1.
  const seed = new AgentStore(db);
  seed.createAgent({ id: 'alpha', name: 'Alpha', model_id: 'claude-haiku-4-5', budget_cap_usd: 10, current_status: 'IDLE' });
  const routine = seed.createRoutine({ agentId: 'alpha', name: 'honest-tweet', cronExpression: '*/15 * * * *', timezone: 'UTC', promptTemplate: 'Reply once to a post on the fixture timeline.',
    taskName: ROUTINE_ASK_TASK, nextRunAt: Date.now() + 86_400_000 });
  const past = pastRun(seed, routine, [
    ['EXTERNAL_ACTION_STARTED', { actionId: 'past-click', transport: 'browser', origin: site.origin, action: 'click' }],
    ['EXTERNAL_ACTION_FINISHED', { actionId: 'past-click', transport: 'browser' }],
  ]);
  seed.close();
  const h = flowHarness({ origin: site.origin, db, actions: [
    openPost(site.origin + site.statusPath(3)), typeReply('A reply that is typed but never sent.'), answer('Drafted a reply.'), block('The reply was only drafted.'),
  ] });
  try {
    const policy = h.publishPolicy.get(routine.id);
    assert.deepEqual(policy && [policy.required, policy.source, policy.evidenceRunId, policy.origin], [true, 'history', past.run.id, site.origin]);
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    assert.equal(run.status, 'FAILED');
    assert.deepEqual(errors(h, runId), [['answer', NONE]]);
    assert.equal(readWorkResult(h.store, runId)!.blocked?.declaredBy, 'model');
    assert.equal(site.state.requests, 0);
    assert.equal(h.publishPolicy.get(routine.id)?.source, 'history');
  } finally { await h.close(); await site.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('H13: a provider failure after a post still checks the post before the run fails, so the next occurrence is not held', { timeout: 90_000 }, async () => {
  const site = await xFixture({ noBody: true });
  const outOfCredits = Object.assign(new Error('Provider request failed with status 402: this account is out of credits.'), { status: 402 });
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(2)), typeReply('A fixture reply that X answers without a body.'), clickReply(), outOfCredits] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: 'Reply once to a post on the fixture timeline.' });
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    assert.equal(run.status, 'FAILED');
    assert.ok(readWorkResult(h.store, runId)!.report.includes('out of credits'));
    assert.equal(site.state.posts, 1);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_OBSERVED').map(p => [p.outcome, p.reason]), [['unobserved', 'empty-body']]);
    assert.ok(lastMessage(h.requests[3]).includes(PENDING_NOTE), 'the model was told not to post again');
    assert.deepEqual(payloads(h, runId, 'PUBLISH_RECONCILED').map(p => p.verdict), ['present']);
    const order = eventOrder(h, runId);
    assert.ok(order.indexOf('PUBLISH_RECONCILED') < order.indexOf('TASK_FAILED'), 'the post was checked before the run failed');
    assert.deepEqual(pendingForRoutine(h.store, routine.id), []);
    assert.equal(h.publishPolicy.get(routine.id)?.evidenceRunId, runId, 'the failure close-out noted the attempt');
    await h.scheduler.stop();
    h.store.updateRoutine(routine.id, { next_run_at: Date.now() - 1000 });
    assert.equal(await h.producer.produceNextTasks(h.store), 1, 'the next occurrence is not held');
  } finally { await h.close(); await site.close(); }
});

test('H14: a run that times out while X holds the answer keeps its session, and the close-out finds the post on the page', { timeout: 90_000 }, async () => {
  // holdMs is longer than the whole run, so the time limit always falls while the post is pending.
  const site = await xFixture({ holdMs: 8_000, noBody: true });
  const h = flowHarness({ origin: site.origin, contract: { timeoutMs: 7_000 },
    actions: [openPost(site.origin + site.statusPath(4)), typeReply('A fixture reply that X answers after the time limit.'), clickReply(), answer('Replied once.')] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: 'Reply once to a post on the fixture timeline.' });
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    assert.equal(site.state.requests, 1, 'the reply was sent before the time limit');
    assert.equal(run.status, 'FAILED');
    assert.ok(readWorkResult(h.store, runId)!.report.includes('Task time limit reached.'));
    assert.deepEqual(payloads(h, runId, 'PUBLISH_OBSERVED').map(p => [p.outcome, p.reason]), [['unobserved', 'empty-body']]);
    const reconciled = h.store.getTaskEvents(runId).find(e => e.event_type === 'PUBLISH_RECONCILED');
    assert.equal(reconciled && JSON.parse(reconciled.payload_json).verdict, 'present');
    assert.ok(reconciled!.timestamp >= (run.started_at ?? 0) + 7_000, 'checked after the run signal aborted, on the session the deferred teardown kept');
    const order = eventOrder(h, runId);
    assert.ok(order.indexOf('PUBLISH_RECONCILED') < order.indexOf('TASK_FAILED'));
    assert.equal(h.browser.status().active, 0, 'finally ended the kept session');
    assert.deepEqual(pendingForRoutine(h.store, routine.id), []);
  } finally { await h.close(); await site.close(); }
});

test('H17: when nothing suitable is found, answer is refused and the model\'s block ends the run BLOCKED', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  const reason = 'Nothing on the fixture timeline was suitable to reply to.';
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + '/home'), answer('Nothing on the timeline is worth a reply today.'), block(reason)] });
  try {
    const routine = mustPost(h);
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    assert.equal(run.status, 'FAILED');
    assert.deepEqual(errors(h, runId), [['answer', NONE]]);
    assert.deepEqual(readWorkResult(h.store, runId)!.blocked, { declaredBy: 'model', reason });
    assert.deepEqual(payloads(h, runId, 'WORK_BLOCKED').map(p => p.declaredBy), ['model']);
    assert.equal(site.state.requests, 0);
  } finally { await h.close(); await site.close(); }
});

test('a REST draft save that echoes the typed text is not a post: the reply still goes out once and the routine is not held (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture({ echoDraft: true });
  const h = flowHarness({ origin: site.origin, actions: [
    openPost(site.origin + site.statusPath(5)), typeReply('A reply the fixture saves as a draft first.'), browse({ action: 'click', target: { role: 'button', name: 'Save draft' } }), clickReply(),
    answer('Replied once.'),
  ] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: 'Reply once to a post on the fixture timeline.' });
    await h.start();
    const runId = h.manual(routine.id);
    const run = await h.finished(runId);
    assert.equal(run.status, 'COMPLETED');
    assert.ok(site.state.drafts >= 2, 'the fixture received the typing-time and the clicked draft saves');
    assert.deepEqual(payloads(h, runId, 'PUBLISH_ATTEMPTED').map(p => [p.unprobed, p.op]), [[undefined, 'reply']], 'only the reply is a post: REST writes on x.com are outside the probe\'s echoPaths');
    assert.deepEqual(payloads(h, runId, 'PUBLISH_REFUSED'), []);
    assert.equal(site.state.requests, 1, 'the reply left Chrome exactly once');
    assert.equal(h.requests.length, 5);
    assert.deepEqual(pendingForRoutine(h.store, routine.id), []);
  } finally { await h.close(); await site.close(); }
});

// Remaining Stage 1 loop-run cases (spec 11.5). Exact texts from the spec.
const UNCONFIRMED_REFUSAL = 'X did not confirm the post you submitted and it is not on your profile yet. It may still have landed: do not post again; end with block.';
const pageLine = (postUrl: string) => `Post check: ${postUrl} — checked on the page.`;
const takeoverLine = (postUrl: string) => `Post check: ${postUrl} — posted by you during takeover.`;
const clickPost = () => browse({ action: 'click', target: { role: 'button', name: 'Post' } });
const snapshot = () => browse({ action: 'snapshot' });
const REPLY_ONCE = 'Reply once to a post on the fixture timeline.';
type Site = Awaited<ReturnType<typeof xFixture>>;
/** The address resolvePostUrl gives our index-th created post: the Profile link's handle is fixture_bot. */
const ownPost = (site: Site, index = 0) => `${site.origin}/fixture_bot/status/${site.state.created[index].id}`;

/** Runs the routine once by hand and waits until execute's finally has run. */
async function runOnce(h: FlowHarness, routine: RoutineRecord) {
  const runId = h.manual(routine.id);
  const run = await h.finished(runId);
  return { runId, run, result: readWorkResult(h.store, runId)! };
}

/**
 * The run-history rows as the runs API returns them (task 11's routineRuns mapping in index.ts), built from
 * the same two sources without a daemon: publishSummary, and blocked only for a FAILED run the model blocked.
 */
function runRows(h: FlowHarness, routineId: string) {
  const runs = h.store.listRoutineRuns(routineId);
  const posts = publishSummary(h.store, runs.map(run => run.id));
  return new Map(runs.map(run => [run.id, {
    status: run.status,
    publish: posts.get(run.id),
    blocked: run.status === 'FAILED' && readWorkResult(h.store, run.id)?.blocked?.declaredBy === 'model',
  }]));
}

test('H1 badge: a reply X confirmed shows in the run history as posted by the model (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(6)), typeReply('A fixture reply whose run history shows it posted.'), clickReply(), answer('Replied once to a timeline post.')] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const { runId, run, result } = await runOnce(h, routine);
    assert.equal(run.status, 'COMPLETED', result.report);
    // The UI shows "Posted ✓" for this summary (task 13).
    assert.deepEqual(runRows(h, routine.id).get(runId), { status: 'COMPLETED', publish: { state: 'confirmed', by: 'model', postUrl: ownPost(site), heldBack: null }, blocked: false });
  } finally { await h.close(); await site.close(); }
});

test('H2: X answers with an unlisted error code, the page check finds the reply, and the run completes (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture({ unknownError: true });
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(1)), typeReply('A fixture reply that X answers with an unknown error code.'), clickReply(), answer('Replied once to a timeline post.')] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const { runId, run, result } = await runOnce(h, routine);
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.equal(site.state.posts, 1, 'the site created and listed the reply');
    assert.deepEqual(payloads(h, runId, 'PUBLISH_OBSERVED').map(p => [p.outcome, p.reason, p.errorCodes]), [['unobserved', 'unlisted-code', [999]]]);
    assert.ok(lastMessage(h.requests[3]).includes(PENDING_NOTE), 'the model was told the post is not confirmed yet');
    const postUrl = ownPost(site);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_RECONCILED').map(p => [p.verdict, p.postUrl, p.by]), [['present', postUrl, 'page-check']]);
    assert.equal(site.state.profileGets, 0, 'found on the status page the model was on');
    assert.ok(result.report.endsWith(`\n\n${pageLine(postUrl)}`), result.report);
    // "Posted ✓ (checked on page)" in the UI.
    assert.deepEqual(runRows(h, routine.id).get(runId)?.publish, { state: 'confirmed-page', by: 'model', postUrl, heldBack: null });
  } finally { await h.close(); await site.close(); }
});

test('H3: an id inside a visibility wrapper, next to a warning, is confirmed by the response (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture({ wrapped: true });
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(2)), typeReply('A fixture reply that X wraps in a visibility result.'), clickReply(), answer('Replied once to a timeline post.')] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const { runId, run, result } = await runOnce(h, routine);
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_OBSERVED').map(p => [p.outcome, p.postId]), [['confirmed', site.state.created[0].id]]);
    assert.equal(payloads(h, runId, 'PUBLISH_RECONCILED').length, 0, 'no page check was needed');
    const postUrl = ownPost(site);
    assert.ok(lastMessage(h.requests[3]).includes(confirmedNote(postUrl)));
    assert.ok(result.report.endsWith(`\n\n${responseLine(postUrl)}`), result.report);
    assert.deepEqual(runRows(h, routine.id).get(runId)?.publish, { state: 'confirmed', by: 'model', postUrl, heldBack: null });
  } finally { await h.close(); await site.close(); }
});

test('H4: an empty answer and a reply that appears six seconds later are confirmed on the current page, without the profile', { timeout: 90_000 }, async () => {
  const site = await xFixture({ noBody: true, lateArticle: true });
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(3)), typeReply('A fixture reply that shows up on the page a little later.'), clickReply(), answer('Replied once to a timeline post.')] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const { runId, run, result } = await runOnce(h, routine);
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_OBSERVED').map(p => [p.outcome, p.reason]), [['unobserved', 'empty-body']]);
    const events = h.store.getTaskEvents(runId);
    const sent = events.find(e => e.event_type === 'PUBLISH_ATTEMPTED')!;
    const found = events.find(e => e.event_type === 'PUBLISH_RECONCILED')!;
    assert.equal(JSON.parse(found.payload_json).verdict, 'present');
    assert.ok(found.timestamp - sent.timestamp >= 5_500, 'the page poll kept looking until the late reply appeared');
    assert.equal(site.state.profileGets, 0);
    assert.ok(result.report.endsWith(`\n\n${pageLine(ownPost(site))}`), result.report);
  } finally { await h.close(); await site.close(); }
});

test('H5: a reply that is not on its status page is found on the profile once the profile has loaded', { timeout: 90_000 }, async () => {
  const site = await xFixture({ noBody: true, slowProfile: true, hideReplies: true });
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(4)), typeReply('A fixture reply that only the profile page lists.'), clickReply(), answer('Replied once to a timeline post.')] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const { runId, run, result } = await runOnce(h, routine);
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.equal(site.state.profileGets, 1, 'phase 2 opened the profile');
    const events = h.store.getTaskEvents(runId);
    const sent = events.find(e => e.event_type === 'PUBLISH_ATTEMPTED')!;
    const found = events.find(e => e.event_type === 'PUBLISH_RECONCILED')!;
    const postUrl = ownPost(site);
    assert.deepEqual(JSON.parse(found.payload_json), { publishId: JSON.parse(sent.payload_json).publishId, verdict: 'present', postUrl, by: 'page-check' });
    assert.ok(found.timestamp - sent.timestamp >= 15_000, 'phase 1 gave up on the status page first');
    assert.ok(result.report.endsWith(`\n\n${pageLine(postUrl)}`), result.report);
    assert.deepEqual(runRows(h, routine.id).get(runId)?.publish, { state: 'confirmed-page', by: 'model', postUrl, heldBack: null });
  } finally { await h.close(); await site.close(); }
});

test('H17 (runs API): the model\'s block shows as blocked in the run history, with no post badge', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  const reason = 'Nothing on the fixture timeline was suitable to reply to.';
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + '/home'), answer('Nothing on the timeline is worth a reply today.'), block(reason)] });
  try {
    const routine = mustPost(h);
    await h.start();
    const { runId, run } = await runOnce(h, routine);
    assert.equal(run.status, 'FAILED');
    // The UI labels this run BLOCKED (task 13).
    assert.deepEqual(runRows(h, routine.id).get(runId), { status: 'FAILED', publish: undefined, blocked: true });
  } finally { await h.close(); await site.close(); }
});

test('H6: a reply X never answers is refused at answer, the run ends blocked, and the routine waits for the owner\'s check', { timeout: 90_000 }, async () => {
  const site = await xFixture({ hang: true });
  const h = flowHarness({ origin: site.origin, actions: [
    openPost(site.origin + site.statusPath(1)), typeReply('A fixture reply that X never answers.'), clickReply(), answer('Replied once.'), block('X never confirmed the reply.'),
    // The next occurrence, after "Checked — continue".
    openPost(site.origin + site.statusPath(2)), typeReply('A fixture reply sent after the owner checked the account.'), clickReply(), answer('Replied once after the check.'),
  ] });
  try {
    const routine = h.routine({ name: 'viral-life', instruction: REPLY_ONCE });
    await h.start();
    const hung = await runOnce(h, routine);
    assert.equal(hung.run.status, 'FAILED');
    assert.equal(site.state.requests, 1);
    assert.equal(site.state.posts, 0, 'the reply is listed nowhere');
    assert.ok(lastMessage(h.requests[3]).includes(PENDING_NOTE));
    assert.deepEqual(errors(h, hung.runId), [['answer', UNCONFIRMED_REFUSAL]]);
    assert.equal(hung.result.blocked?.declaredBy, 'model');
    assert.deepEqual(payloads(h, hung.runId, 'PUBLISH_OBSERVED').map(p => [p.outcome, p.reason]), [['unobserved', 'timeout']]);
    assert.deepEqual(payloads(h, hung.runId, 'PUBLISH_RECONCILED').map(p => p.verdict), ['not-found', 'not-found'], 'the answer gate and the failure close-out each checked the page');
    const attemptedAt = h.store.getTaskEvents(hung.runId).find(e => e.event_type === 'PUBLISH_ATTEMPTED')!.timestamp;
    assert.deepEqual(pendingForRoutine(h.store, routine.id).map(item => [item.kind, item.runId]), [['publish', hung.runId]], 'the unsettled attempt is pending');
    assert.equal(h.requests.length, 5);

    // The producer leaves the routine due: no run, no schedule change.
    const due = Date.now() - 1000;
    h.store.updateRoutine(routine.id, { next_run_at: due });
    await delay(300);
    assert.equal(h.store.listRoutineRuns(routine.id).length, 1);
    assert.equal(h.store.getRoutine(routine.id)!.next_run_at, due);

    // A run by hand fails before any model call and opens no browser.
    const held = await runOnce(h, routine);
    assert.equal(held.run.status, 'FAILED');
    assert.equal(h.requests.length, 5, 'no model was called');
    assert.equal(reportReason(h, held.runId), pendingText(hung.runId, attemptedAt, site.origin));
    assert.equal(h.browser.status().active, 0);
    const rows = runRows(h, routine.id);
    assert.deepEqual(rows.get(hung.runId), { status: 'FAILED', publish: { state: 'unconfirmed', by: 'model', heldBack: null }, blocked: true });
    assert.deepEqual(rows.get(held.runId), { status: 'FAILED', publish: undefined, blocked: false }, 'the pending gate is not the model\'s block');

    // "Checked — continue": the next occurrence runs, and this time X answers.
    site.toggles.hang = false;
    assert.equal(acknowledgeRoutine(h.store, 'alpha', routine.id), 1);
    await h.until(() => h.store.listRoutineRuns(routine.id).length === 3);
    const next = h.store.listRoutineRuns(routine.id).find(r => r.id !== hung.runId && r.id !== held.runId)!;
    assert.equal((await h.finished(next.id)).status, 'COMPLETED', readWorkResult(h.store, next.id)?.report);
    assert.equal(h.requests.length, 9);
    assert.equal(site.state.posts, 1);
  } finally { await h.close(); await site.close(); }
});

test('H7: the owner takes over and posts by hand; the model\'s own Reply is held back and its answer carries the takeover line (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture({ keepComposer: true });
  let takeover: Promise<unknown> | undefined;
  const h = flowHarness({ origin: site.origin,
    actions: [openPost(site.origin + site.statusPath(3)), typeReply('Draft reply.'), snapshot(), clickReply(), answer('The owner posted the reply.')],
    // The owner asks for control while the model's fill is dispatched. Not awaited here: takeover waits for this action's lease.
    testHooks: { afterDispatch: async (_actionId, action) => { if (action === 'fill' && !takeover) takeover = h.browser.control('alpha', { action: 'takeover' }); } } });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const runId = h.manual(routine.id);
    await h.until(() => takeover !== undefined);
    await takeover;
    await h.browser.control('alpha', { action: 'click', x: 500, y: 50 });
    await h.browser.control('alpha', { action: 'type', text: ' Finished by the owner.' });
    await h.browser.control('alpha', { action: 'click', x: 280, y: 120 });
    await h.until(() => payloads(h, runId, 'PUBLISH_OBSERVED').length === 1);
    await h.browser.control('alpha', { action: 'resume' });
    const run = await h.finished(runId);
    const result = readWorkResult(h.store, runId)!;
    assert.equal(run.status, 'COMPLETED', result.report);
    // The model's snapshot ran only after the owner handed control back.
    const events = h.store.getTaskEvents(runId).map(e => [e.event_type, JSON.parse(e.payload_json) as Record<string, unknown>] as const);
    const resumed = events.findIndex(([type, p]) => type === 'BROWSER_CONTROL' && p.operator === false);
    const looked = events.findIndex(([type, p]) => type === 'BROWSER_ACTION_START' && p.action === 'snapshot');
    assert.ok(resumed > 0 && looked > resumed, 'the model\'s snapshot waited for the owner');
    assert.deepEqual(payloads(h, runId, 'PUBLISH_ATTEMPTED').map(p => [p.by, p.actionId]), [['operator', undefined]]);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_OBSERVED').map(p => p.outcome), ['confirmed']);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_REFUSED').map(p => [p.reason, p.op, p.by]), [['budget', 'reply', 'model']]);
    assert.ok(lastMessage(h.requests[4]).includes(BUDGET_NOTE), 'the model was told its Reply was held back');
    assert.equal(site.state.requests, 1);
    assert.equal(site.state.posts, 1);
    const postUrl = ownPost(site);
    assert.ok(result.report.endsWith(`\n\n${takeoverLine(postUrl)}`), result.report);
    assert.equal(h.requests.length, 5);
    assert.deepEqual(runRows(h, routine.id).get(runId)?.publish, { state: 'confirmed', by: 'operator', postUrl, heldBack: 'budget' });
  } finally { await h.close(); await site.close(); }
});

test('H7b: a takeover that starts while the model\'s Reply is in flight leaves the post the model\'s, confirmed once (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture({ holdMs: 3000 });
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(4)), typeReply('A fixture reply the owner watches being sent.'), clickReply(), answer('Replied once.')] });
  let takeover: Promise<unknown> | undefined;
  // Right after the model's Reply click dispatched: the request has reached the site. Not awaited here: takeover waits for the click's lease.
  site.onPost = () => { takeover ??= h.browser.control('alpha', { action: 'takeover' }); };
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const runId = h.manual(routine.id);
    await h.until(() => takeover !== undefined);
    await takeover;
    const click = payloads(h, runId, 'EXTERNAL_ACTION_STARTED').find(p => p.action === 'click')!;
    assert.deepEqual(h.browser.publishes(runId).map(record => [record.by, record.actionId, record.state]), [['model', click.actionId, 'confirmed']]);
    await h.browser.control('alpha', { action: 'resume' });
    const run = await h.finished(runId);
    const result = readWorkResult(h.store, runId)!;
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_ATTEMPTED').map(p => [p.by, p.actionId]), [['model', click.actionId]]);
    assert.equal(site.state.posts, 1);
    assert.ok(result.report.endsWith(`\n\n${responseLine(ownPost(site))}`), result.report);
    assert.equal(h.requests.length, 4);
  } finally { await h.close(); await site.close(); }
});

test('H8: a second Reply click in the same run is held back before it leaves Chrome (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture({ keepComposer: true });
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(5)), typeReply('The one reply this routine run may send.'), clickReply(), clickReply(), answer('Replied once.')] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const { runId, run, result } = await runOnce(h, routine);
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.equal(payloads(h, runId, 'PUBLISH_ATTEMPTED').length, 1);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_REFUSED').map(p => [p.reason, p.op, p.by]), [['budget', 'reply', 'model']]);
    assert.equal(site.state.requests, 1, 'the second CreateTweet never reached the site');
    assert.equal(site.state.posts, 1);
    const postUrl = ownPost(site);
    assert.ok(lastMessage(h.requests[3]).includes(confirmedNote(postUrl)));
    const second = lastMessage(h.requests[4]);
    assert.ok(second.includes('"publish":{"state":"refused","op":"reply","reason":"budget"}'), second.slice(0, 600));
    assert.ok(second.includes(BUDGET_NOTE));
    assert.ok(result.report.endsWith(`\n\n${responseLine(postUrl)}`), result.report);
    assert.deepEqual(runRows(h, routine.id).get(runId)?.publish, { state: 'confirmed', by: 'model', postUrl, heldBack: 'budget' });
  } finally { await h.close(); await site.close(); }
});

test('H11: a Reply click that fails after X confirmed the post is rescued by the response, not uncertain (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  let failed = false;
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + site.statusPath(6)), typeReply('A fixture reply whose click fails after X answered it.'), clickReply(), answer('Replied once.')],
    // wveu4's shape: the post went through, then the click itself failed. Thrown once, after the site has answered.
    testHooks: { afterDispatch: async (_actionId, action) => {
      if (action !== 'click' || failed) return;
      failed = true;
      const end = Date.now() + 10_000;
      while (site.state.answered < 1 && Date.now() < end) await delay(25);
      throw new Error('Injected failure after X answered.');
    } } });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const { runId, run, result } = await runOnce(h, routine);
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.equal(failed, true);
    const click = payloads(h, runId, 'EXTERNAL_ACTION_STARTED').find(p => p.action === 'click')!;
    const finished = payloads(h, runId, 'EXTERNAL_ACTION_FINISHED').filter(p => p.actionId === click.actionId);
    const [attempt] = payloads(h, runId, 'PUBLISH_ATTEMPTED');
    assert.deepEqual(finished, [{ actionId: click.actionId, transport: 'browser', outcome: 'confirmed', confirmedBy: 'response', publishId: attempt.publishId }]);
    assert.deepEqual(errors(h, runId), [], 'the click was not reported as uncertain');
    const postUrl = ownPost(site);
    const seen = lastMessage(h.requests[3]);
    assert.ok(seen.includes(confirmedNote(postUrl)), seen.slice(0, 600));
    assert.ok(!seen.includes('outcome is uncertain'));
    assert.ok(result.report.endsWith(`\n\n${responseLine(postUrl)}`), result.report);
    assert.deepEqual(pendingForRoutine(h.store, routine.id), []);
  } finally { await h.close(); await site.close(); }
});

/**
 * An abrupt daemon stop (H12): the database closes first, so nothing more is written and the run stays
 * RUNNING on disk, as after a kill. Then the old stack is torn down. Its execute can only fail against the
 * closed database, so the scheduler task's rejection is caught before the close and swallowed here.
 */
async function crash(h: FlowHarness): Promise<void> {
  const active = (h.scheduler as unknown as { activeTasks: Map<string, { promise: Promise<void> }> }).activeTasks;
  const running = [...active.values()].map(task => task.promise.catch(() => {}));
  h.store.close();
  await h.scheduler.stop().catch(() => {});
  await Promise.all(running);
  await h.producer.stop();
  await h.browser.stop().catch(() => {});
}

test('H12: a daemon that stops between the click and X\'s answer leaves the run CRASHED and the routine waiting for the owner (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture({ holdMs: 8_000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-publish-crash-'));
  const db = path.join(dir, 'state.db');
  const text = 'A fixture reply that is in flight when the daemon stops.';
  const first = flowHarness({ origin: site.origin, db, actions: [openPost(site.origin + site.statusPath(7)), typeReply(text), clickReply(), answer('Replied once.')] });
  let crashed = false;
  let second: FlowHarness | undefined;
  try {
    const routine = first.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await first.start();
    const runId = first.manual(routine.id);
    // The crash window: the click has FINISHED (its 5 s verdict wait ended pending) and X has not answered yet.
    await first.until(() => {
      const click = payloads(first, runId, 'EXTERNAL_ACTION_STARTED').find(p => p.action === 'click');
      return !!click && payloads(first, runId, 'EXTERNAL_ACTION_FINISHED').some(p => p.actionId === click.actionId);
    }, 30_000);
    assert.equal(site.state.answered, 0, 'X has not answered yet');
    crashed = true;
    await crash(first);

    // The next daemon start on the same database: the boot sweep marks the run CRASHED.
    second = flowHarness({ origin: site.origin, db, actions: [] });
    assert.equal(second.store.getTaskRun(runId)?.status, 'CRASHED');
    assert.equal(payloads(second, runId, 'PUBLISH_OBSERVED').length, 0, 'no verdict was ever written');
    const attemptedAt = second.store.getTaskEvents(runId).find(e => e.event_type === 'PUBLISH_ATTEMPTED')!.timestamp;
    assert.deepEqual(pendingForRoutine(second.store, routine.id).map(item => [item.kind, item.runId, item.at]), [['publish', runId, attemptedAt]]);
    const recent = recentPublishes(second.store, 'alpha', Date.now() - 7 * 86_400_000);
    assert.ok(recent.targets.has(statusId(site.statusPath(7))), 'the reply target is held back from later runs');
    assert.ok(recent.textHashes.has(textSha256(text)));

    second.store.updateRoutine(routine.id, { next_run_at: Date.now() - 1000 });
    await second.producer.start();
    assert.equal(await second.producer.produceNextTasks(second.store), 0, 'the producer leaves the routine due');
    assert.equal(second.store.listRoutineRuns(routine.id).length, 1);
    assert.equal(acknowledgeRoutine(second.store, 'alpha', routine.id), 1);
    assert.equal(await second.producer.produceNextTasks(second.store), 1, 'after "Checked — continue" the next occurrence is enqueued');
  } finally {
    if (!crashed) await first.close();
    await second?.close();
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H15: an original post X refuses frees the run\'s one post, and the model posts different text once (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture({ rejectFirst: true });
  const refused = 'A first original post that X refuses as a duplicate.';
  const posted = 'A second original post with different words.';
  const h = flowHarness({ origin: site.origin, actions: [openPost(site.origin + '/home'), typeReply(refused), clickPost(), typeReply(posted), clickPost(), answer('Posted once.')] });
  try {
    const routine = h.routine({ name: 'honest-post', instruction: 'Write one original post on the fixture timeline.' });
    await h.start();
    const { runId, run, result } = await runOnce(h, routine);
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_ATTEMPTED').map(p => [p.op, p.textSha256]), [['post', textSha256(refused)], ['post', textSha256(posted)]]);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_OBSERVED').map(p => [p.outcome, p.reason, p.errorCodes]), [['rejected', 'code 187', [187]], ['confirmed', undefined, undefined]]);
    const rejected = lastMessage(h.requests[3]);
    assert.ok(rejected.includes('"publish":{"state":"rejected","op":"post","reason":"code 187"}'), rejected.slice(0, 600));
    assert.equal(payloads(h, runId, 'PUBLISH_REFUSED').length, 0, 'the refused post freed the budget');
    assert.equal(site.state.requests, 2);
    assert.equal(site.state.posts, 1);
    assert.equal(site.state.created[0].text, posted);
    const postUrl = ownPost(site);
    assert.ok(result.report.endsWith(`\n\n${responseLine(postUrl)}`), result.report);
    assert.deepEqual(runRows(h, routine.id).get(runId), { status: 'COMPLETED', publish: { state: 'confirmed', by: 'model', postUrl, heldBack: null }, blocked: false });
  } finally { await h.close(); await site.close(); }
});

test('H15: after X refuses a reply, a retry on the same post is held back, and a reply to another post is sent (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture({ rejectFirst: true });
  const h = flowHarness({ origin: site.origin, actions: [
    openPost(site.origin + site.statusPath(3)), typeReply('A first reply that X refuses as a duplicate.'), clickReply(),
    typeReply('The same post again, in other words.'), clickReply(),
    openPost(site.origin + site.statusPath(4)), typeReply('A reply to a different post on the timeline.'), clickReply(),
    answer('Replied once to another post.'),
  ] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const { runId, run, result } = await runOnce(h, routine);
    assert.equal(run.status, 'COMPLETED', result.report);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_OBSERVED').map(p => p.outcome), ['rejected', 'confirmed']);
    assert.deepEqual(payloads(h, runId, 'PUBLISH_REFUSED').map(p => [p.reason, p.op, p.by]), [['duplicate-target', 'reply', 'model']]);
    const retry = lastMessage(h.requests[5]);
    assert.ok(retry.includes('"publish":{"state":"refused","op":"reply","reason":"duplicate-target"}'), retry.slice(0, 600));
    assert.ok(retry.includes(DUPLICATE_NOTE));
    assert.equal(site.state.requests, 2, 'the retry on the same post never reached the site');
    assert.equal(site.state.posts, 1);
    assert.equal(site.state.created[0].inReplyTo, statusId(site.statusPath(4)));
    assert.ok(result.report.endsWith(`\n\n${responseLine(ownPost(site))}`), result.report);
    assert.equal(h.requests.length, 9);
  } finally { await h.close(); await site.close(); }
});

test('H16: a later run of the routine is held back from the same post and from the same text (assumed X response shape)', { timeout: 90_000 }, async () => {
  const site = await xFixture();
  const text = 'A fixture reply this routine sends only once.';
  const h = flowHarness({ origin: site.origin, actions: [
    openPost(site.origin + site.statusPath(1)), typeReply(text), clickReply(), answer('Replied once.'),
    openPost(site.origin + site.statusPath(1)), typeReply('New words for the post this routine already answered.'), clickReply(), block('That post was already answered.'),
    openPost(site.origin + site.statusPath(2)), typeReply(text), clickReply(), block('That text was already posted.'),
  ] });
  try {
    const routine = h.routine({ name: 'honest-tweet', instruction: REPLY_ONCE });
    await h.start();
    const firstRun = await runOnce(h, routine);
    assert.equal(firstRun.run.status, 'COMPLETED', firstRun.result.report);
    const sameTarget = await runOnce(h, routine);
    const sameText = await runOnce(h, routine);
    const rows = runRows(h, routine.id);
    for (const [label, next, reason, request] of [['the same post', sameTarget, 'duplicate-target', 7], ['the same text', sameText, 'duplicate-text', 11]] as const) {
      assert.equal(next.run.status, 'FAILED', label);
      assert.deepEqual(payloads(h, next.runId, 'PUBLISH_REFUSED').map(p => [p.reason, p.op, p.by]), [[reason, 'reply', 'model']], label);
      assert.equal(payloads(h, next.runId, 'PUBLISH_ATTEMPTED').length, 0, label);
      const seen = lastMessage(h.requests[request]);
      assert.ok(seen.includes(`"publish":{"state":"refused","op":"reply","reason":"${reason}"}`), `${label}: ${seen.slice(0, 600)}`);
      assert.ok(seen.includes(DUPLICATE_NOTE), label);
      assert.deepEqual(rows.get(next.runId), { status: 'FAILED', publish: undefined, blocked: true }, label);
    }
    assert.equal(site.state.requests, 1, 'the fixture received only the first run\'s reply');
    assert.equal(site.state.posts, 1);
    assert.deepEqual(pendingForRoutine(h.store, routine.id), [], 'a held-back reply leaves nothing to check');
    assert.equal(h.requests.length, 12);
  } finally { await h.close(); await site.close(); }
});
