import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import {
  OpenCodeExecutor,
  parseOpenCodeStream,
  toOpenCodeModel,
  requiredCredentialEnvVar,
  shellQuote,
  isRateLimited,
} from '../src/daemon/opencode-executor.js';
import type { TaskRunRecord } from '../src/daemon/db/schema.js';
import { dockerArgv } from '../src/kernel/docker-host.js';

/** Paid model from the STATIC pricing table, so cost assertions are non-zero. */
const TEST_MODEL = 'claude-haiku-4-5';
const DOCKER_TIMEOUT = 420_000;

/** The exact line a live `opencode run --format json` emitted on a 429. */
const REAL_429_LINE = JSON.stringify({
  type: 'error',
  timestamp: 1788546168476,
  sessionID: 'ses_f925886a8ffeHfaTmMg5ThC4Bb',
  error: {
    name: 'APIError',
    data: {
      message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
      statusCode: 429,
      isRetryable: true,
    },
  },
});

function docker(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const argv = dockerArgv(args);
    const child = spawn(argv.command, argv.args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}

const TASK_FILES = {
  'package.json': JSON.stringify({ name: 'oc-fixture', type: 'module' }),
  'test.js': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './src/index.js';",
    "test('add', () => { assert.equal(add(2, 3), 5); });",
  ].join('\n'),
  // Deliberately wrong, so an agent that does nothing cannot pass by accident.
  'src/index.js': 'export function add() { return 0; }',
};

const IMPLEMENT = `printf 'export function add(a,b){return a+b;}\\n' > src/index.js`;
const TAMPER = `printf 'import test from "node:test";\\ntest("noop", () => {});\\n' > test.js`;

interface Harness {
  store: AgentStore;
  ledger: CostLedger;
  executor: OpenCodeExecutor;
  taskRun: TaskRunRecord;
  close(): void;
}

function harness(agentScript: string, over: Record<string, unknown> = {}): Harness {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(':memory:');
  store.createAgent({
    id: 'agent-alpha',
    name: 'Alpha',
    model_id: TEST_MODEL,
    budget_cap_usd: 10,
    current_status: 'IDLE',
  });
  store.createTaskRun({ agentId: 'agent-alpha', taskName: 'oc-fixture' });
  const taskRun = store.listTaskRuns()[0];

  const executor = new OpenCodeExecutor({
    agentStore: store,
    ledger,
    apiKey: 'test-sentinel-key',
    // Test seam: a deterministic script stands in for opencode, so the whole
    // pipeline runs without spending a single OpenRouter request.
    buildAgentCommand: () => agentScript,
    ...over,
  });

  return { store, ledger, executor, taskRun, close: () => { store.close(); ledger.close(); } };
}

describe('OpenCode: pure helpers', () => {
  it('addresses OpenRouter models the way opencode does, idempotently', () => {
    assert.equal(toOpenCodeModel('nvidia/nemotron-3-super-120b-a12b:free'),
      'openrouter/nvidia/nemotron-3-super-120b-a12b:free');
    assert.equal(toOpenCodeModel('openrouter/x/y:free'), 'openrouter/x/y:free');
  });

  it('leaves OpenCode-hosted model ids untouched', () => {
    // Verified against `opencode models opencode` / `opencode models opencode-go`.
    assert.equal(toOpenCodeModel('opencode/nemotron-3-ultra-free'), 'opencode/nemotron-3-ultra-free');
    assert.equal(toOpenCodeModel('opencode-go/glm-5.3'), 'opencode-go/glm-5.3');
  });

  it('routes each provider to its own credential', () => {
    // One OPENCODE_API_KEY unlocks both Zen and Go (confirmed by `providers list`).
    assert.equal(requiredCredentialEnvVar('opencode/nemotron-3-ultra-free'), 'OPENCODE_API_KEY');
    assert.equal(requiredCredentialEnvVar('opencode-go/glm-5.3'), 'OPENCODE_API_KEY');
    assert.equal(requiredCredentialEnvVar('nvidia/nemotron-3-super-120b-a12b:free'), 'OPENROUTER_API_KEY');
    assert.equal(requiredCredentialEnvVar('openrouter/x/y'), 'OPENROUTER_API_KEY');
  });

  it('treats any unrecognised prefix as an OpenRouter model id', () => {
    // This is the actual rule, pinned deliberately. It has to be permissive
    // because real OpenRouter ids are bare vendor/model pairs ('nvidia/...'),
    // and there is no way to tell those from a typo. The consequence worth
    // knowing: a misspelled OpenCode prefix routes to OpenRouter and fails at
    // request time with an OpenRouter error, not a routing error.
    assert.equal(toOpenCodeModel('opencode-zen-typo/model'), 'openrouter/opencode-zen-typo/model');
    assert.equal(requiredCredentialEnvVar('opencode-zen-typo/model'), 'OPENROUTER_API_KEY');
  });

  it('shell-quotes a prompt containing single quotes', () => {
    const quoted = shellQuote("don't break; rm -rf /");
    assert.equal(quoted, `'don'\\''t break; rm -rf /'`);
    assert.ok(!quoted.includes("t break'"), 'the embedded quote must stay escaped');
  });

  it('parses the real 429 envelope opencode emitted', () => {
    const s = parseOpenCodeStream(REAL_429_LINE);
    assert.equal(s.eventCount, 1);
    assert.equal(s.sessionId, 'ses_f925886a8ffeHfaTmMg5ThC4Bb');
    assert.equal(s.errors.length, 1);
    assert.equal(s.errors[0].statusCode, 429);
    assert.equal(s.errors[0].name, 'APIError');
    assert.ok(isRateLimited(s), 'a 429 must be classified as rate limited');
  });

  it('reads token usage from tokens/usage keys', () => {
    const s = parseOpenCodeStream(
      [
        JSON.stringify({ type: 'step', tokens: { input: 100, output: 50 } }),
        JSON.stringify({ type: 'step', usage: { inputTokens: 7, outputTokens: 3 } }),
      ].join('\n')
    );
    assert.deepEqual(s.usage, { inputTokens: 107, outputTokens: 53 });
  });

  it('NEGATIVE CONTROL: reports null usage rather than inventing zero', () => {
    // If this returned {0,0}, the executor would reconcile a real session at $0.
    const s = parseOpenCodeStream(JSON.stringify({ type: 'message', text: 'hello' }));
    assert.equal(s.usage, null, 'absent usage must be null, never a zero reading');
  });

  it('NEGATIVE CONTROL: does not mistake unrelated input/output fields for tokens', () => {
    const s = parseOpenCodeStream(
      JSON.stringify({ type: 'tool', args: { input: 4096, output: 'out.txt' } })
    );
    assert.equal(s.usage, null, 'only tokens/usage keys may count as spend');
  });

  it('counts non-JSON lines instead of silently dropping them', () => {
    const s = parseOpenCodeStream('warning: something\n{"type":"message"}\nnot json');
    assert.equal(s.eventCount, 1);
    assert.equal(s.unparsedLines, 2);
  });

  it('refuses to dispatch without an API key', async () => {
    const h = harness('true', { apiKey: undefined });
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const bare = new OpenCodeExecutor({ agentStore: h.store, ledger: h.ledger, buildAgentCommand: () => 'true' });
    await assert.rejects(
      () => bare.executeTask({
        agent: h.store.getAgent('agent-alpha')!,
        taskRun: h.taskRun,
        initialFiles: TASK_FILES,
        testCommand: 'node --test test.js',
      }),
      /requires OPENROUTER_API_KEY/
    );
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    h.close();
  });

  it('protects tests and package scripts even with an explicit empty list', () => {
    const h = harness('true');
    assert.deepEqual(h.executor.resolveProtectedFiles(TASK_FILES), ['package.json', 'test.js']);
    assert.deepEqual(h.executor.resolveProtectedFiles(TASK_FILES, []), ['package.json', 'test.js']);
    assert.deepEqual(
      h.executor.resolveProtectedFiles({ 'tests/a.js': '', 'x.spec.ts': '', 'src/i.js': '' }),
      ['tests/a.js', 'x.spec.ts']
    );
    h.close();
  });
});

describe('OpenCode: containment posture', () => {
  it('gives the agent container the key and network, and the executor neither', { timeout: DOCKER_TIMEOUT }, async () => {
    const sandbox = new DockerSandbox();
    const vol = await sandbox.createWorkspaceVolume(`posture-${Date.now()}`);
    const probe =
      `printenv OPENROUTER_API_KEY || echo KEY_ABSENT; ` +
      `node -e "require('dns').promises.lookup('openrouter.ai').then(()=>console.log('NET_OK'),()=>console.log('NET_FAIL'))"`;

    try {
      const agentRes = await sandbox.runAgentContainer(vol, probe, {
        image: 'node:20-slim',
        secrets: { OPENROUTER_API_KEY: 'test-sentinel-key' },
        timeoutMs: 120_000,
      });
      assert.match(agentRes.stdout, /test-sentinel-key/, 'agent container must receive the key');
      assert.match(agentRes.stdout, /NET_OK/, 'agent container must have egress');

      // The verdict container. No secrets are even offered to it, and --network none.
      const execRes = await sandbox.executeTask(vol, probe, { timeoutMs: 120_000 });
      assert.match(execRes.stdout, /KEY_ABSENT/, 'executor must NOT see the key');
      assert.doesNotMatch(execRes.stdout, /test-sentinel-key/, 'the key must never leak into the executor');
      assert.match(execRes.stdout, /NET_FAIL/, 'executor must have no egress');
    } finally {
      await sandbox.destroyWorkspaceVolume(vol);
    }
  });
});

describe('OpenCode: end-to-end task execution', () => {
  it('completes a task and retains its workspace', { timeout: DOCKER_TIMEOUT }, async () => {
    const h = harness(IMPLEMENT);
    try {
      const res = await h.executor.executeTask({
        agent: h.store.getAgent('agent-alpha')!,
        taskRun: h.taskRun,
        initialFiles: TASK_FILES,
        testCommand: 'node --test test.js',
        timeoutMs: 120_000,
      });

      assert.equal(res.outcome, 'COMPLETED', res.errorMessage);
      assert.equal(h.store.getTaskRun(h.taskRun.id)!.status, 'COMPLETED');

      const volumes = await docker(['volume', 'ls', '-q']);
      assert.ok(!volumes.includes(`task-vol-task-${h.taskRun.id}`), 'task volume must be reaped');

      // Regression: the store and this executor both used to emit these, so one
      // task produced two TASK_STARTED and two terminal rows - one of each with
      // an empty payload - inflating every metric built on execution_events.
      const types = h.store.getTaskEvents(h.taskRun.id).map((e) => e.event_type);
      assert.equal(types.filter((t) => t === 'TASK_STARTED').length, 1,
        `exactly one TASK_STARTED per run; got ${types.join(', ')}`);
      assert.equal(types.filter((t) => t.startsWith('TASK_') && t !== 'TASK_STARTED').length, 1,
        `exactly one terminal event per run; got ${types.join(', ')}`);

      // The executor's detail survived the merge into the store-owned event.
      const started = h.store.getTaskEvents(h.taskRun.id).find((e) => e.event_type === 'TASK_STARTED')!;
      assert.equal(JSON.parse(started.payload_json).executor, 'opencode');
      assert.equal(started.layer, 1, 'TASK_STARTED is layer-1 evidence');
    } finally {
      h.close();
    }
  });

  it('an agent that rewrites the test file cannot buy a green', { timeout: DOCKER_TIMEOUT }, async () => {
    // The agent never implements add(); it only replaces the test with a no-op.
    const h = harness(TAMPER);
    try {
      const res = await h.executor.executeTask({
        agent: h.store.getAgent('agent-alpha')!,
        taskRun: h.taskRun,
        initialFiles: TASK_FILES,
        testCommand: 'node --test test.js',
        timeoutMs: 120_000,
      });

      assert.equal(res.outcome, 'FAILED', 'restored tests must expose the missing implementation');
      const events = h.store.getTaskEvents(h.taskRun.id).map((e) => e.event_type);
      assert.ok(events.includes('PROTECTED_FILES_RESTAGED'), 'restoration must be recorded');
    } finally {
      h.close();
    }
  });

  it('an explicit empty protection list cannot bypass test restoration', { timeout: DOCKER_TIMEOUT }, async () => {
    // An empty custom list must not opt out of mandatory verifier protection.
    const h = harness(TAMPER);
    try {
      const res = await h.executor.executeTask({
        agent: h.store.getAgent('agent-alpha')!,
        taskRun: h.taskRun,
        initialFiles: TASK_FILES,
        testCommand: 'node --test test.js',
        protectedFiles: [],
        timeoutMs: 120_000,
      });

      assert.equal(res.outcome, 'FAILED', 'mandatory protection prevents gutting the verifier');
    } finally {
      h.close();
    }
  });

  it('charges a session that reported no usage instead of recording $0', { timeout: DOCKER_TIMEOUT }, async () => {
    // The stub agent emits no JSON at all, exactly like an opencode run whose
    // usage we cannot observe. The reservation must still cost something.
    const h = harness(IMPLEMENT);
    try {
      const res = await h.executor.executeTask({
        agent: h.store.getAgent('agent-alpha')!,
        taskRun: h.taskRun,
        initialFiles: TASK_FILES,
        testCommand: 'node --test test.js',
        timeoutMs: 120_000,
      });

      assert.ok(
        res.actualCostUsd > 0,
        `unobserved usage must fall back to the estimate, got $${res.actualCostUsd}`
      );
      const session = h.store.getTaskEvents(h.taskRun.id).find((e) => e.event_type === 'OPENCODE_SESSION');
      assert.ok(session, 'session event must be recorded');
      assert.equal(JSON.parse(session!.payload_json).usageReported, false);
    } finally {
      h.close();
    }
  });

  it('treats a 429 in the event stream as RATE_LIMITED despite exit code 0', { timeout: DOCKER_TIMEOUT }, async () => {
    // The bug this guards: opencode's exit code is unusable - live runs returned
    // both 0 and 1 for the same 429. `exit 0` reproduces the dangerous half, where
    // a naive executor would report success. Classification must come from the stream.
    const h = harness(`echo '${REAL_429_LINE}'; exit 0`);
    try {
      const res = await h.executor.executeTask({
        agent: h.store.getAgent('agent-alpha')!,
        taskRun: h.taskRun,
        initialFiles: TASK_FILES,
        testCommand: 'node --test test.js',
        timeoutMs: 120_000,
      });

      assert.equal(res.outcome, 'RATE_LIMITED', 'exit 0 must not be read as success');
      assert.match(res.errorMessage ?? '', /free-models-per-day/);
    } finally {
      h.close();
    }
  });
});
