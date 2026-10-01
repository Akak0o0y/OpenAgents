import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSchema } from '../src/daemon/work-actions.js';
import { availableTools } from '../src/daemon/tool-schemas.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ApprovalGate } from '../src/daemon/control-plane.js';

test('request_human carries what to do and why a person is needed', () => {
  const ok = actionSchema.safeParse({ tool: 'request_human', what: 'Enter the 2FA code from your phone', why: 'The code is sent to you, not to me.' });
  assert.equal(ok.success, true);
  for (const bad of [
    { tool: 'request_human' },
    { tool: 'request_human', what: '', why: 'x' },
    { tool: 'request_human', what: 'x' },
    { tool: 'request_human', what: 'x', why: 'y', url: 'not-a-url' },
    { tool: 'request_human', what: 'x', why: 'y', extra: 'no' },
  ]) {
    assert.equal(actionSchema.safeParse(bad).success, false, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('asking for help is offered only where a decision can reach someone', () => {
  const offered = (ctx: Parameters<typeof availableTools>[0]) => availableTools(ctx).map(t => t.name);
  assert.ok(!offered({}).includes('request_human'), 'with no approval gate there is nobody to ask');
  assert.ok(offered({ canRequestHuman: true }).includes('request_human'));
  // Deliberately not conversation-only: a scheduled run that meets a 2FA prompt should
  // be able to wait for a person rather than die.
  assert.ok(offered({ canRequestHuman: true, isScheduled: true }).includes('request_human'));
});

test('the tool tells the model to use it instead of giving up', () => {
  const tool = availableTools({ canRequestHuman: true }).find(t => t.name === 'request_human');
  assert.ok(tool);
  assert.match(tool.description, /2FA|CAPTCHA/i);
  assert.match(tool.description, /instead of giving up/i);
  assert.match(tool.description, /continue the same task/i);
});

test('the run waits for the operator, resumes on done, and is blocked on cannot', async () => {
  const store = new AgentStore(':memory:');
  const gate = new ApprovalGate(store);
  store.createAgent({ id: 'milo', name: 'Milo', model_id: 'claude-haiku-4-5', current_status: 'IDLE', budget_cap_usd: 1 });
  const run = store.createTaskRun({ agentId: 'milo', taskName: 'assist-test' });
  store.startTaskRun(run.id, 'claude-haiku-4-5');

  // Registering a handler is what makes the tool available at all.
  assert.equal(gate.canPropose('human-assist'), false);
  gate.onDecision('human-assist', () => {});
  assert.equal(gate.canPropose('human-assist'), true);

  // No timeout is passed: a person needs however long a 2FA code takes.
  const asked = gate.request({ taskRunId: run.id, agentId: 'milo', kind: 'human-assist',
    payload: { what: 'Enter the 2FA code', why: 'It is sent to you.', authoredByBot: true } });
  let settled = false;
  void asked.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false, 'the run must still be waiting, not failed and not finished');

  const [pending] = store.listApprovals({ pendingOnly: true });
  assert.equal(pending.kind, 'human-assist');
  assert.match(pending.payload_json, /Enter the 2FA code/);

  gate.decide(pending.id, 'APPROVED', 'Operator says done');
  assert.equal((await asked).status, 'APPROVED');

  const refused = gate.request({ taskRunId: run.id, agentId: 'milo', kind: 'human-assist', payload: { what: 'Pay the invoice', why: 'Your card.' } });
  const [second] = store.listApprovals({ pendingOnly: true });
  gate.decide(second.id, 'DENIED', 'Not doing that');
  const outcome = await refused;
  assert.equal(outcome.status, 'DENIED');
  store.close();
});

test('cancelling the task releases a run waiting on a person', async () => {
  const store = new AgentStore(':memory:');
  const gate = new ApprovalGate(store);
  store.createAgent({ id: 'milo', name: 'Milo', model_id: 'claude-haiku-4-5', current_status: 'IDLE', budget_cap_usd: 1 });
  const run = store.createTaskRun({ agentId: 'milo', taskName: 'assist-abort' });
  store.startTaskRun(run.id, 'claude-haiku-4-5');
  const controller = new AbortController();
  // An unanswered request must never hold a desktop open forever.
  const asked = gate.request({ taskRunId: run.id, agentId: 'milo', kind: 'human-assist',
    payload: { what: 'Clear the CAPTCHA', why: 'It exists to require a person.' }, abortSignal: controller.signal });
  controller.abort();
  assert.equal((await asked).status, 'EXPIRED');
  store.close();
});
