import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../../src/daemon/agent-store.js';
import { ArtifactStore } from '../../src/daemon/artifacts.js';
import { BrowserTools } from '../../src/daemon/browser-tools.js';
import { setBrowserAutonomy } from '../../src/daemon/browser-accounts.js';
import { MemorySecretStore } from '../../src/daemon/secret-store.js';
import { ApprovalGate } from '../../src/daemon/control-plane.js';
import { CostLedger } from '../../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../../src/kernel/docker-sandbox.js';
import { WorkRuntime } from '../../src/daemon/work-runtime.js';
import { RunCapacity } from '../../src/daemon/run-capacity.js';
import { TaskScheduler } from '../../src/daemon/scheduler.js';
import { ProviderRouter } from '../../src/daemon/provider-router.js';
import { RoutineWorkProducer } from '../../src/daemon/routine-producer.js';
import { enqueueRoutine } from '../../src/daemon/routine-dispatch.js';
import { PublishPolicy } from '../../src/daemon/publish-policy.js';
import { pendingForRoutine } from '../../src/daemon/external-effects.js';
import { xCreateTweet, type PublishProbe } from '../../src/daemon/publish-probes.js';
import { ROUTINE_ASK_CONTRACT, ROUTINE_ASK_TASK, findWorkContract, workTaskDefinition, type WorkContract } from '../../src/daemon/work-contract.js';
import type { RoutineRecord, TaskRunRecord } from '../../src/daemon/db/schema.js';
import type { LLMRequest } from '../../src/evals/llm-client.js';

/**
 * A real routine stack for publish fixture cases (spec 11.4), after tests/browser-integration.test.ts:45-58:
 * AgentStore, WorkRuntime, TaskScheduler and RoutineWorkProducer on one database, BrowserTools with the
 * X probe injected for the fixture's own origin, and a strict shift-and-assert model fake. Nothing leaves
 * 127.0.0.1 and no Docker container starts.
 */
export type BrowserToolsOptions = ConstructorParameters<typeof BrowserTools>[0];
export interface FlowHarnessOptions {
  /** The fixture origin, http://127.0.0.1:<port>. */
  origin: string;
  /** Scripted model turns, shifted one per request. An Error entry is thrown as a provider failure. */
  actions: unknown[];
  /** A database file to open (a reopen when it already holds runs); ':memory:' by default. */
  db?: string;
  /** Overrides for the routine:ask contract, for example a lower maxTurns or timeoutMs. */
  contract?: Partial<WorkContract>;
  /** The producer's clock. */
  now?: () => number;
  testHooks?: BrowserToolsOptions['testHooks'];
  /** false builds the stack without the WorkRuntime publishPolicy and producer holds options (behaviour as today). */
  publishPolicy?: boolean;
  /** Probe factory for the fixture origin; xCreateTweet([origin]) by default. */
  probes?: (origin: string) => PublishProbe[];
}

export const HARNESS_AGENT = 'alpha';
const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'ABORTED', 'CRASHED']);

export function flowHarness(opts: FlowHarnessOptions) {
  const store = new AgentStore(opts.db ?? ':memory:');
  // The boot sweep (index.ts:222): a reopened database's interrupted runs become CRASHED.
  store.markInFlightAsCrashed('Daemon startup sweep: previous daemon terminated abruptly');
  if (!store.getAgent(HARNESS_AGENT)) store.createAgent({ id: HARNESS_AGENT, name: 'Alpha', model_id: 'claude-haiku-4-5', budget_cap_usd: 10, current_status: 'IDLE' });
  // Milo's autonomy: no approval card for forms and buttons.
  setBrowserAutonomy(store, HARNESS_AGENT, 'always');
  const ledger = new CostLedger(store.getDatabase()), artifacts = new ArtifactStore(store), approvals = new ApprovalGate(store), capacity = new RunCapacity(1);
  const probes = (opts.probes ?? (origin => [xCreateTweet([origin])]))(opts.origin);
  // Seeds must-post from history and writes the install marker, as at daemon start (spec 6.8).
  const publishPolicy = new PublishPolicy(store, probes);
  const publishEnabled = opts.publishPolicy !== false;
  const requests: LLMRequest[] = [];
  const actions = opts.actions;
  const llm = { async generateCode(req: LLMRequest) {
    requests.push({ ...req, messages: structuredClone(req.messages) });
    const action = actions.shift();
    assert.ok(action, 'Unexpected model turn');
    if (action instanceof Error) throw action;
    return { content: JSON.stringify(action), inputTokens: 1, outputTokens: 1, attemptCount: 1 };
  } };
  const sandbox = new DockerSandbox(); sandbox.createWorkspaceVolume = async () => { throw new Error('Publish fixtures must not start Docker.'); };
  const browser = new BrowserTools({ store, artifacts, secrets: new MemorySecretStore(), previewOrigins: [opts.origin], publishProbes: probes, testHooks: opts.testHooks });
  const runtime = new WorkRuntime({ store, ledger, artifacts, approvals, llm, sandbox, browser, publishPolicy: publishEnabled ? publishPolicy : undefined });
  const producer: RoutineWorkProducer = new RoutineWorkProducer({ maxQueueDepth: 1, now: opts.now, getTaskDefinition: name => scheduler.getTaskDefinition(name),
    // The wiring index.ts uses (task 11): a routine with a pending item is left due.
    holds: publishEnabled ? (_agentId, routineId) => pendingForRoutine(store, routineId).length > 0 : undefined });
  const scheduler: TaskScheduler = new TaskScheduler({ agentStore: store, ledger, llmClient: llm, sandbox, workRuntime: runtime, capacity, providerRouter: new ProviderRouter(),
    maxConcurrency: 1, cadenceMs: 10, executor: 'builtin', workProducer: producer });
  // The default routine task (index.ts:788-793): its instruction runs as a conversation turn with tools.
  const ask = workTaskDefinition({ ...ROUTINE_ASK_CONTRACT, ...opts.contract }, ROUTINE_ASK_CONTRACT.description);
  ask.work!.conversation = true;
  scheduler.registerTaskDefinition(ROUTINE_ASK_TASK, ask);
  // A structured contract: the scheduler passes neither conversation nor input.scheduled for it (scheduler.ts:271).
  const brief = findWorkContract('evidence-brief')!;
  scheduler.registerTaskDefinition(`work:${brief.id}`, workTaskDefinition(brief, brief.description));

  async function until(done: () => boolean, ms = 60_000): Promise<void> {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await delay(20);
    assert.ok(done(), 'The fixture condition was not reached in time.');
  }

  return {
    store, ledger, capacity, browser, runtime, publishPolicy, producer, scheduler, requests,
    /** A routine of the harness bot; not due unless nextRunAt says so. */
    routine(input: { name: string; instruction: string; nextRunAt?: number; taskName?: string }): RoutineRecord {
      return store.createRoutine({ agentId: HARNESS_AGENT, name: input.name, cronExpression: '*/15 * * * *', timezone: 'UTC', promptTemplate: input.instruction,
        taskName: input.taskName ?? ROUTINE_ASK_TASK, catchUpPolicy: 'skip', nextRunAt: input.nextRunAt ?? Date.now() + 86_400_000 });
    },
    /** A manual run (enqueueRoutine, source 'manual'), which bypasses the producer. Returns its run id. */
    manual(routineId: string): string {
      const routine = store.getRoutine(routineId);
      assert.ok(routine, 'Unknown fixture routine.');
      const dispatched = enqueueRoutine(store, routineId, { source: 'manual', maxQueueDepth: 1, definition: routine.task_name ? scheduler.getTaskDefinition(routine.task_name) : undefined });
      assert.ok(dispatched.created, 'The manual run was coalesced into an active run.');
      return dispatched.run.id;
    },
    /** Starts the producer and the scheduler (cadence 10 ms). */
    async start(): Promise<void> { await producer.start(); scheduler.start(); },
    until,
    /** Waits until the run is terminal and its capacity is released, so execute's finally has run. */
    async finished(runId: string, ms = 90_000): Promise<TaskRunRecord> {
      await until(() => TERMINAL.has(store.getTaskRun(runId)?.status ?? '') && capacity.used === 0, ms);
      return store.getTaskRun(runId)!;
    },
    /** Stops the scheduler (aborting a running run), the producer and the browser, then closes the database. */
    async close(): Promise<void> {
      await scheduler.stop(); await producer.stop(); await browser.stop(); ledger.close(); store.close();
    },
  };
}
export type FlowHarness = ReturnType<typeof flowHarness>;
