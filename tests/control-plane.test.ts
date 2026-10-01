/**
 * Phase C: approval gates and steering.
 *
 * The plan's three checks, plus the negative controls that make them mean
 * something:
 *   - an approval blocks a run and resumes it on decision
 *   - a steer changes the next turn's prompt
 *   - a steer is REFUSED for OpenCode runs, not silently dropped
 *
 * The Docker-backed cases run a real container; the rest are pure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/daemon/agent-loop.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ProviderRouter } from '../src/daemon/provider-router.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { ApprovalGate, SteerBus, SteerNotSupportedError } from '../src/daemon/control-plane.js';
import { layerForEvent } from '../src/kernel/agent-layers.js';
import type { ILLMClient, LLMRequest, LLMResponse } from '../src/evals/llm-client.js';

const DOCKER_TIMEOUT = 420_000;
const TEST_MODEL = 'claude-haiku-4-5';

class SpyLLMClient implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async generateCode(req: LLMRequest): Promise<LLMResponse> {
    const { onProviderEvent: _observer, signal: _signal, ...payload } = req;
    this.requests.push(structuredClone(payload));
    const i = Math.min(this.requests.length - 1, this.replies.length - 1);
    return { content: this.replies[i] ?? '', inputTokens: 100, outputTokens: 50, attemptCount: 1 };
  }
}

function harness() {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(':memory:');
  const agent = store.createAgent({
    id: 'agent-alpha',
    name: 'Alpha',
    model_id: TEST_MODEL,
    budget_cap_usd: 10,
    current_status: 'IDLE',
  });
  const taskRun = store.createTaskRun({ agentId: 'agent-alpha', taskName: 'control-fixture' });
  return {
    store,
    ledger,
    agent,
    taskRun,
    gate: new ApprovalGate(store),
    close: () => {
      store.close();
      ledger.close();
    },
  };
}

const FILES = {
  'package.json': JSON.stringify({ name: 'control-fixture', type: 'module' }),
  'test.js': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './src/index.js';",
    "test('add', () => { assert.equal(add(2, 3), 5); });",
  ].join('\n'),
  'src/index.js': 'export function add() { return 0; }',
};

const WRONG = '```javascript:src/index.js\nexport function add() { return 0; }\n```';
const RIGHT = '```javascript:src/index.js\nexport function add(a, b) { return a + b; }\n```';

/** Wait for the gate to actually block, so the assertion is not a race. */
function waitForPending(gate: ApprovalGate, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      const [pending] = gate.pendingIds();
      if (pending) {
        clearInterval(poll);
        resolve(pending);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('the gate never blocked'));
      }
    }, 40);
  });
}

describe('ApprovalGate: the store side', () => {
  it('records a request as PENDING and emits an event', () => {
    const h = harness();
    try {
      const approval = h.store.createApproval({
        taskRunId: h.taskRun.id,
        agentId: 'agent-alpha',
        kind: 'dispatch',
        payload: { taskName: 'control-fixture' },
      });
      assert.equal(approval.status, 'PENDING');
      assert.equal(approval.decided_at, null);

      const event = h.store.getTaskEvents(h.taskRun.id).find((e) => e.event_type === 'APPROVAL_REQUESTED');
      assert.ok(event);
      assert.equal(JSON.parse(event!.payload_json).approvalId, approval.id);
    } finally {
      h.close();
    }
  });

  it('attributes approval events to NO layer, because a human is not a cognitive layer', () => {
    // Lighting a ring from an operator decision would show the agent doing
    // something it did not do.
    assert.equal(layerForEvent('APPROVAL_REQUESTED'), null);
    assert.equal(layerForEvent('APPROVAL_DECIDED'), null);
  });

  it('refuses to re-decide an approval that was already answered', () => {
    // A late click must not reverse a verdict the agent has already acted on.
    const h = harness();
    try {
      const a = h.store.createApproval({ taskRunId: h.taskRun.id, agentId: 'agent-alpha', kind: 'dispatch' });
      h.store.decideApproval(a.id, 'APPROVED');
      assert.throws(() => h.store.decideApproval(a.id, 'DENIED'), /already APPROVED/);
    } finally {
      h.close();
    }
  });

  it('expires approvals left pending by a dead daemon, rather than leaving a dead button', () => {
    const h = harness();
    try {
      const a = h.store.createApproval({ taskRunId: h.taskRun.id, agentId: 'agent-alpha', kind: 'dispatch' });
      assert.equal(h.store.expireStaleApprovals(), 1);
      assert.equal(h.store.getApproval(a.id)!.status, 'EXPIRED');

      const decided = h.store
        .getTaskEvents(h.taskRun.id)
        .filter((e) => e.event_type === 'APPROVAL_DECIDED')
        .map((e) => JSON.parse(e.payload_json));
      assert.equal(decided[0].status, 'EXPIRED');
      assert.match(decided[0].reason, /daemon restarted/i);
    } finally {
      h.close();
    }
  });

  it('EXPIRES on timeout rather than auto-approving', async () => {
    // An unattended gate that approves itself is not a gate.
    const h = harness();
    try {
      const decision = await h.gate.request({
        taskRunId: h.taskRun.id,
        agentId: 'agent-alpha',
        kind: 'dispatch',
        timeoutMs: 60,
      });
      assert.equal(decision.status, 'EXPIRED');
      assert.notEqual(decision.status, 'APPROVED');
    } finally {
      h.close();
    }
  });

  it('knows the difference between an answerable row and a live waiter', async () => {
    const h = harness();
    try {
      const pending = h.gate.request({ taskRunId: h.taskRun.id, agentId: 'agent-alpha', kind: 'dispatch' });
      const id = await waitForPending(h.gate);
      assert.equal(h.gate.isWaiting(id), true);
      h.gate.decide(id, 'APPROVED');
      await pending;
      assert.equal(h.gate.isWaiting(id), false, 'settled approvals stop being live');
    } finally {
      h.close();
    }
  });
});

describe('SteerBus', () => {
  it('queues and drains in order, leaving the queue empty', () => {
    const bus = new SteerBus();
    bus.push('run-1', 'first');
    bus.push('run-1', 'second');
    assert.equal(bus.pending('run-1'), 2);
    assert.deepEqual(bus.drain('run-1'), ['first', 'second']);
    assert.deepEqual(bus.drain('run-1'), [], 'a drained queue is empty, not repeated');
  });

  it('refuses an empty message instead of queueing a no-op turn', () => {
    const bus = new SteerBus();
    assert.throws(() => bus.push('run-1', '   '), /empty steer/i);
  });

  it('REFUSES steering for the OpenCode executor rather than silently dropping it', () => {
    // OpenCode owns its conversation inside the container. A queued message
    // would never be read, and the operator would believe they had redirected
    // an agent that never heard them.
    const bus = new SteerBus();
    assert.throws(() => bus.assertSupported('opencode'), SteerNotSupportedError);
    assert.doesNotThrow(() => bus.assertSupported('builtin'));
  });

  it('keeps queues separate per run', () => {
    const bus = new SteerBus();
    bus.push('run-1', 'for one');
    bus.push('run-2', 'for two');
    assert.deepEqual(bus.drain('run-1'), ['for one']);
    assert.deepEqual(bus.drain('run-2'), ['for two']);
  });
});

describe('AgentLoop honours the control plane', () => {
  it('BLOCKS before any spend and resumes when approved', { timeout: DOCKER_TIMEOUT }, async () => {
    const llm = new SpyLLMClient([RIGHT]);
    const h = harness();
    try {
      const running = new AgentLoop({
        agentStore: h.store,
        ledger: h.ledger,
        providerRouter: new ProviderRouter(),
        llmClient: llm,
        approvalGate: h.gate,
      }).executeTask({
        agent: h.agent,
        taskRun: h.taskRun,
        initialFiles: FILES,
        testCommand: 'node --test test.js',
        maxTurns: 2,
        timeoutMs: 120_000,
        requiresApproval: true,
      });

      const id = await waitForPending(h.gate);

      assert.equal(llm.requests.length, 0, 'a blocked run must not have called the provider');
      assert.equal(
        h.store.getTaskRun(h.taskRun.id)!.status,
        'RUNNING',
        'a blocked run is still RUNNING - it has not failed and has not finished'
      );

      h.gate.decide(id, 'APPROVED', 'looks fine');
      const result = await running;

      assert.equal(result.outcome, 'COMPLETED', result.errorMessage);
      assert.ok(llm.requests.length > 0, 'approval must let the run proceed');
      assert.equal(h.store.getApproval(id)!.status, 'APPROVED');
    } finally {
      h.close();
    }
  });

  it('DENIAL stops the run without spending anything', { timeout: DOCKER_TIMEOUT }, async () => {
    const llm = new SpyLLMClient([RIGHT]);
    const h = harness();
    try {
      const running = new AgentLoop({
        agentStore: h.store,
        ledger: h.ledger,
        providerRouter: new ProviderRouter(),
        llmClient: llm,
        approvalGate: h.gate,
      }).executeTask({
        agent: h.agent,
        taskRun: h.taskRun,
        initialFiles: FILES,
        testCommand: 'node --test test.js',
        maxTurns: 2,
        timeoutMs: 120_000,
        requiresApproval: true,
      });

      const id = await waitForPending(h.gate);
      h.gate.decide(id, 'DENIED', 'not today');
      const result = await running;

      assert.equal(result.outcome, 'DENIED');
      assert.equal(result.actualCostUsd, 0, 'a denied run must cost nothing');
      assert.equal(llm.requests.length, 0, 'a denied run must never reach the provider');
      assert.match(result.errorMessage ?? '', /not today/);
    } finally {
      h.close();
    }
  });

  it(
    'a task requiring approval with NO gate is refused, not run ungated',
    { timeout: DOCKER_TIMEOUT },
    async () => {
      // Silently dropping the requirement would remove the guarantee the task
      // asked for, which is the worst possible outcome for a safety gate.
      const h = harness();
      try {
        const loop = new AgentLoop({
          agentStore: h.store,
          ledger: h.ledger,
          providerRouter: new ProviderRouter(),
          llmClient: new SpyLLMClient([RIGHT]),
          // no approvalGate
        });

        const result = await loop.executeTask({
              agent: h.agent,
              taskRun: h.taskRun,
              initialFiles: FILES,
              testCommand: 'node --test test.js',
              maxTurns: 1,
              timeoutMs: 120_000,
              requiresApproval: true,
            });
        assert.equal(result.outcome, 'FAILED');
        assert.match(result.errorMessage ?? '', /without an ApprovalGate/);
        assert.equal(h.store.getTaskRun(h.taskRun.id)?.status, 'FAILED');
      } finally {
        h.close();
      }
    }
  );

  it('applies a steer at the next turn boundary and records it', { timeout: DOCKER_TIMEOUT }, async () => {
    const llm = new SpyLLMClient([WRONG, RIGHT]);
    const bus = new SteerBus();
    const h = harness();
    try {
      bus.push(h.taskRun.id, 'Use a named export called add, taking two arguments.');

      await new AgentLoop({
        agentStore: h.store,
        ledger: h.ledger,
        providerRouter: new ProviderRouter(),
        llmClient: llm,
        steerBus: bus,
      }).executeTask({
        agent: h.agent,
        taskRun: h.taskRun,
        initialFiles: FILES,
        testCommand: 'node --test test.js',
        maxTurns: 3,
        timeoutMs: 120_000,
      });

      const first = llm.requests[0];
      assert.ok(
        first.messages!.some((m) => m.content.includes('named export called add')),
        'the steer must reach the transmitted conversation, not just a local queue'
      );

      const applied = h.store.getTaskEvents(h.taskRun.id).find((e) => e.event_type === 'STEER_APPLIED');
      assert.ok(applied, 'an applied steer must be auditable');
      assert.equal(applied!.layer, 2, 'a steer appends real session history');
      assert.equal(bus.pending(h.taskRun.id), 0, 'the queue is drained, not replayed every turn');
    } finally {
      h.close();
    }
  });

  it(
    'NEGATIVE CONTROL: with no steer queued the prompt is untouched',
    { timeout: DOCKER_TIMEOUT },
    async () => {
      const llm = new SpyLLMClient([RIGHT]);
      const h = harness();
      try {
        await new AgentLoop({
          agentStore: h.store,
          ledger: h.ledger,
          providerRouter: new ProviderRouter(),
          llmClient: llm,
          steerBus: new SteerBus(),
        }).executeTask({
          agent: h.agent,
          taskRun: h.taskRun,
          initialFiles: FILES,
          testCommand: 'node --test test.js',
          maxTurns: 2,
          timeoutMs: 120_000,
        });

        assert.equal(llm.requests[0].messages!.length, 1, 'exactly the initial user turn');
        assert.ok(
          !h.store.getTaskEvents(h.taskRun.id).some((e) => e.event_type === 'STEER_APPLIED'),
          'no steer happened, so none may be reported'
        );
      } finally {
        h.close();
      }
    }
  );
});
