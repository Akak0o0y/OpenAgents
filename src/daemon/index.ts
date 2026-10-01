import './env-bootstrap.js';
import { MissionService } from './missions.js';
import {GoalResults} from './goal-results.js';
import { WebResearch } from './web-research.js';
import { BrowserTools } from './browser-tools.js';
import { BrowserAccounts } from './browser-accounts.js';
import { publicAgentDataApi } from './internal-data.js';
import { MemoryService } from './memory.js';
import { RetentionService } from './retention.js';
import { systemApi } from './system-api.js';
import { BotDesktop, desktopAssetsDir } from './bot-desktop.js';
import { enqueueRoutine } from './routine-dispatch.js';
import { routineHistory } from './routine-history.js';
import { WorkRuntime } from './work-runtime.js';
import { WorkQuestions } from './work-questions.js';
import { BackgroundTasks } from './background-tasks.js';
import { RepositoryPublication, githubClient } from './repository-publication.js';
import { Attachments } from './attachments.js';
import { LiveChannel } from './live-stream.js';
import { ArtifactStore } from './artifacts.js';
import { CharacterStore } from './character-store.js';
import { CharacterProposals } from './character-proposals.js';
import { CharacterSetup } from './character-setup.js';
import { CharacterGrowth } from './character-growth.js';
import { CharacterDrift } from './character-drift.js';
import { FlowStore,flowKeyFor } from './flow-store.js';
import { FlowPlayer } from './flow-player.js';
import { CharacterQualification } from './character-qualification.js';
import {CharacterReviewService,type LocalReviewInstallation} from './character-review-service.js';
import { CharacterAudit } from './character-audit.js';
import { CharacterBundles } from './character-bundles.js';
import { CharacterRhythm } from './character-rhythm.js';
import { CharacterClaims } from './character-claims.js';
import { EngagementReader } from './engagement-reader.js';
import { CharacterRetention } from './character-retention.js';
import { RunCapacity } from './run-capacity.js';
import { readWorkResult } from './work-results.js';
import { PublishPolicy } from './publish-policy.js';
import { xCreateTweet } from './publish-probes.js';
import { pendingForRoutine, publishSummary } from './external-effects.js';
import { DIRECT_WORK_CONTRACTS, ROUTINE_ASK_CONTRACT, ROUTINE_ASK_TASK, workTaskDefinition } from './work-contract.js';
/**
 * OpenAgents Daemon Entrypoint
 * Long-lived backend process owning:
 * 1. Exclusive SQLite writer access (WAL mode).
 * 2. Fixed boot sequence:
 *    orphanSweep(forceAll: true) -> stale reservation sweep -> mark in-flight as CRASHED -> provider quota check -> WS server start -> scheduler start.
 *    Without Docker the sweep is deferred, not fatal: see Step 1.
 * 3. Graceful SIGINT/SIGTERM handling.
 */

import path from 'node:path';
import { routineBindingError } from './routine-task.js';
import { RepositoryFetcher } from './repository-snapshot.js';
import { acquireProfileLock, loadLocalCredentials } from './local-auth.js';
import { DockerSandbox } from '../kernel/docker-sandbox.js';
import { holdWslDistro, resolveDockerHost } from '../kernel/docker-host.js';
import { DockerMonitor } from './docker-status.js';
import { LocalGatewayService } from './local-gateway.js';
import { CostLedger } from '../kernel/cost-ledger.js';
import { AgentStore } from './agent-store.js';
import { ProviderRouter } from './provider-router.js';
import { CharacterPreviewService } from './character-preview.js';
import { characterApi } from './character-api.js';
import { CharacterJournal } from './character-journal.js';
import { CharacterAdmissions } from './character-admission.js';
import { CharacterProjector } from './character-projector.js';
import { DaemonWsServer, type WsCommand, type DaemonReadApi } from './ws-server.js';
import { McpRegistry } from './mcp-registry.js';
import { ApprovalGate, SteerBus, SteerNotSupportedError } from './control-plane.js';
import { loadConfigFile, systemPromptFor } from './config-file.js';
import { ChatService } from './chat.js';
import { TaskScheduler } from './scheduler.js';
import { PROVISIONAL_CONFIG } from './config.js';
import { STANDING_BENCHMARKS } from '../kernel/standing-tenant.js';
import { BacklogWorkProducer, PlaceholderWorkProducer, type IWorkProducer } from './work-producer.js';
import { GoalDecompositionWorkProducer } from './goal-producer.js';
import { RoutineWorkProducer, realignRoutineSchedules } from './routine-producer.js';
import { CompositeWorkProducer } from './composite-producer.js';
import { computeNextRun, parseSchedule } from './cron.js';
import { randomBytes } from 'node:crypto';
import { searchContent } from './search.js';
import { installPlugin, listConfiguredPlugins, uninstallPlugin, configuredPluginPermissions,grantInstalledPlugin } from './plugin-registry.js';
import { usageSummary } from './usage.js';
import { LocalUsageCache } from './local-usage-cache.js';
import { syncOpenRouterCatalog, syncModelsDevCatalog, LiveLLMClient, MockLLMClient, loadEnvFiles, type ILLMClient } from '../evals/llm-client.js';
import { requiredCredentialEnvVar } from './opencode-executor.js';
import { FREELLMAPI_PRESET, OPENROUTER_PRESET, ProviderConnectionService, ProviderSetupError, isVirtualModel } from './provider-connections.js';
import { createDefaultSecretStore, type SecretStore } from './secret-store.js';

export async function startDaemon(options: {
  dbPath?: string;
  wsPort?: number;
  cadenceMs?: number;
  maxConcurrency?: number;
  llmClient?: ILLMClient;
  sandbox?: DockerSandbox;
  workProducer?: IWorkProducer;
  /** Standing mission. When set, the daemon generates its own work. */
  mission?: string;
  /** 'builtin' = AgentLoop, 'opencode' = OpenCode CLI in the agent container. */
  executor?: 'builtin' | 'opencode';
  /**
   * Explicit config file path. Omitted looks for openhours.config.json in the
   * working directory; `null` skips the lookup entirely.
   *
   * The null case exists for tests. Without it a boot test's fleet depends on
   * whether the developer happens to have a config file in the repo root, and
   * the suite passes or fails for reasons that have nothing to do with the code
   * under test.
   */
  configPath?: string | null;
  /** Protected credential storage for provider connections. Defaults to the OS user's store (Windows DPAPI). */
  secretStore?: SecretStore;
  /**
   * Docker status monitor. Defaults to a live one, except when a test injects
   * its own sandbox - that test is not asking to have the real Docker probed
   * every few seconds. `false` turns monitoring off.
   */
  docker?: DockerMonitor | false;
  /** The app's own daemon starts FreeLLMAPI even before a FreeLLMAPI connection exists (see LocalGatewayService.startIfWanted). */
  startLocalGatewayWithApp?: boolean;
  /** Explicit host-installed reviewer adapter and independently measured artifact evidence. */
  characterLocalReviewer?:LocalReviewInstallation;
} = {}): Promise<{
  store: AgentStore;
  ledger: CostLedger;
  sandbox: DockerSandbox;
  wsServer: DaemonWsServer;
  scheduler: TaskScheduler;
  providerRouter: ProviderRouter;
  providerConnections: ProviderConnectionService;
  /** Exposed for tests that decide proposals and hold conversations end to end. */
  approvalGate: ApprovalGate;
  chat: ChatService;
  /** Exposed for tests that tick the routine producer through the daemon's own wiring (its pending hold). */
  routineProducer: RoutineWorkProducer;
  shutdown: () => Promise<void>;
}> {
  const dbPath = options.dbPath ?? PROVISIONAL_CONFIG.DB_PATH;
  const wsPort = options.wsPort ?? PROVISIONAL_CONFIG.WS_PORT;
  // Read configuration first: it decides the fleet, the tools and the executor.
  // A bad config must stop the boot, not be discovered halfway through it.
  const fileConfig = options.configPath === null ? null : loadConfigFile(options.configPath);
  const contracts = [...DIRECT_WORK_CONTRACTS, ...(fileConfig?.config.contracts ?? [])];
  if (new Set(contracts.map(c => c.id)).size !== contracts.length) throw new Error('Duplicate contract ID.');
  const cadenceMs = options.cadenceMs ?? fileConfig?.config.scheduler.cadenceMs ?? PROVISIONAL_CONFIG.SCHEDULER_CADENCE_MS;
  const maxConcurrency = options.maxConcurrency ?? fileConfig?.config.scheduler.maxConcurrency ?? PROVISIONAL_CONFIG.MAX_CONCURRENT_TASKS;
  const mission = options.mission ?? fileConfig?.config.mission;
  if (fileConfig) {
    console.log(`Config:          ${fileConfig.source} (${fileConfig.config.agents.length} agent(s))`);
  } else {
    console.log('Config:          none found - using built-in defaults (see openhours.config.example.json)');
  }

  const executor = options.executor ?? fileConfig?.config.executor ?? PROVISIONAL_CONFIG.EXECUTOR;

  // Hydrate .env before anything reads a key, rather than relying on whichever
  // component happens to be constructed first.
  loadEnvFiles();
  // Which model (and therefore which credential) the agents will actually use.
  const activeModel = executor === 'opencode'
    ? PROVISIONAL_CONFIG.OPENCODE_MODEL
    : PROVISIONAL_CONFIG.PRIMARY_MODEL;

  if (executor === 'opencode') {
    const envVar = requiredCredentialEnvVar(activeModel);
    if (!process.env[envVar]) {
      throw new Error(
        `Executor "opencode" with model "${activeModel}" requires ${envVar} ` +
        `(environment or .env). Refusing to boot: every task would die inside the agent container.`
      );
    }
  }
  if (mission && mission.trim()) {
    // Checked at boot rather than on the first proposal 15 minutes later.
    const producerEnv = requiredCredentialEnvVar(PROVISIONAL_CONFIG.PRODUCER_MODEL);
    if (!process.env[producerEnv]) {
      throw new Error(
        `A mission requires ${producerEnv} for producer model ` +
        `"${PROVISIONAL_CONFIG.PRODUCER_MODEL}" (environment or .env). Refusing to boot.`
      );
    }
  }

  console.log('================================================================');
  console.log('                 OPENAGENTS DAEMON STARTUP                      ');
  console.log('================================================================');
  console.log(`Database Path:   ${dbPath}`);
  console.log(`WebSocket Port:  ${wsPort}`);
  console.log(`Cadence:         ${cadenceMs}ms`);
  console.log(`Concurrency Cap: ${maxConcurrency}`);
  console.log(`Executor:        ${executor}${executor === 'opencode' ? ` (${PROVISIONAL_CONFIG.OPENCODE_IMAGE}, network=${PROVISIONAL_CONFIG.OPENCODE_AGENT_NETWORK})` : ''}`);
  console.log('================================================================');

  // Step 1: Docker Orphan Sweep (forceAll: true at boot)
  console.log('[Boot 1/5] Executing initial Docker orphan sweep...');
  const credentials = dbPath === ':memory:' ? undefined : loadLocalCredentials(dbPath);
  const releaseProfile = dbPath === ':memory:' ? () => {} : acquireProfileLock(dbPath);
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
  const sandbox = options.sandbox ?? new DockerSandbox(undefined, dbPath === ':memory:' ? undefined : path.resolve(dbPath));
  // Docker is needed for sandboxed work, not for the daemon to exist. This sweep
  // used to be the first thing that threw when Docker was stopped or missing,
  // and the process exited before any interface could say why - to someone who
  // had just installed the app, OpenAgents simply did not open. Now the daemon
  // starts, the monitor reports Docker's state, and the sweep runs once Docker
  // answers. Tasks that need a sandbox meanwhile fail with Docker's own reason.
  let sweepDeferred = false;
  try {
    const sweepRes = await sandbox.orphanSweep({ forceAll: true, timeoutMs: 8000 });
    console.log(`           Reaped ${sweepRes.reapedContainers} containers, ${sweepRes.reapedVolumes} volumes.`);
  } catch (error) {
    sweepDeferred = true;
    console.warn(`           Docker is not available; the sweep will run when it is. ${String((error as Error)?.message ?? error).split('\n')[0]}`);
  }
  const dockerMonitor = options.docker === false ? null : options.docker ?? (options.sandbox ? null : new DockerMonitor());
  // Docker through WSL dies with its idle distribution, taking running bot desktops along.
  const wslHold = options.docker === false || options.sandbox ? null : holdWslDistro(resolveDockerHost(), { onLog: (line) => console.log(line) });
  if (wslHold) cleanup.push(() => wslHold.stop());

  // Step 2: Stale Sweeps (Cost Ledger + Agent Store crash recovery)
  console.log('[Boot 2/5] Performing stale ledger sweeps and crash recovery...');
  const store = new AgentStore(dbPath);
  cleanup.push(() => store.close());
  new GoalResults(store).recover();
  // Owner-chat requests queued in the previous process have no live HTTP/abort owner.
  for(const queued of store.queuedTaskRuns()){
    const owned=store.getDatabase().prepare("SELECT 1 FROM execution_events WHERE task_run_id=? AND event_type='RESOURCE_WAIT' LIMIT 1").get(queued.id);
    if(owned)store.finishTaskRun(queued.id,'CRASHED','The daemon restarted while this request was waiting for resources. No queued action was dispatched.');
  }
  // Settings → Providers. Gateway keys are protected for this OS user and never leave the daemon.
  const secretStore = options.secretStore ?? createDefaultSecretStore();
  const providerConnections = new ProviderConnectionService(store, secretStore);

  // FreeLLMAPI, run by OpenAgents when this installation uses it (local-gateway.ts).
  const localGateway = dbPath === ':memory:' ? null : new LocalGatewayService({
    configPath: path.join(path.dirname(path.resolve(dbPath)), 'local-gateway.json'),
    onLog: (line) => console.log(line),
    // The gateway came up or moved: loopback FreeLLMAPI connections follow it,
    // so a port taken by something else never breaks the bots that use it.
    onAddress: (baseUrl) => {
      const changed = store.getDatabase().prepare(`UPDATE provider_connections SET base_url = ?, updated_at = ?
        WHERE preset = 'freellmapi' AND base_url <> ? AND (base_url LIKE 'http://127.0.0.1:%' OR base_url LIKE 'http://localhost:%')`)
        .run(baseUrl, Date.now(), baseUrl);
      if (Number(changed.changes) > 0) console.log(`[FreeLLMAPI] Connection address updated to ${baseUrl}.`);
    },
  });
  cleanup.push(async () => { await localGateway?.stop(); });
  localGateway?.startIfWanted(providerConnections.list().some((connection) => connection.preset === 'freellmapi'), options.startLocalGatewayWithApp ?? false);

  // Usage from the OTHER coding tools on this machine, read from the logs they
  // already write. Warmed at boot so the first request does not pay for the
  // full scan; see local-usage-cache.ts.
  const localUsage = new LocalUsageCache({
    stateDir: path.dirname(path.resolve(dbPath)),
    onLog: (message) => console.log(message),
  });
  localUsage.refresh();
  const ledger = new CostLedger(store.getDatabase());
  const sweptReservations = ledger.sweepStaleReservations();
  const sweptTasks = store.markInFlightAsCrashed('Daemon startup sweep: previous daemon terminated abruptly');
  // A pending approval from a dead daemon can never be answered - the promise
  // waiting on it died with the process. Expiring it is honest; leaving it
  // PENDING would show the operator a button that does nothing.
  const expiredApprovals = store.expireStaleApprovals();
  if (expiredApprovals > 0) {
    console.log(`           Expired ${expiredApprovals} approval(s) left pending by a previous daemon.`);
  }
  console.log(`           Swept ${sweptReservations.expiredUndispatchedCount + sweptReservations.assumedSpentCount} stale reservations, marked ${sweptTasks} orphaned tasks as CRASHED.`);
  const realignedRoutines = realignRoutineSchedules(store);
  if (realignedRoutines > 0) {
    console.log(`           Re-aligned ${realignedRoutines} overdue routine(s) (catch_up_policy=skip).`);
  }

  // Step 3: Provider Router & Quota Load
  console.log('[Boot 3/5] Initializing provider router and checking model availability...');
  const providerRouter = new ProviderRouter();
  try {
    await syncOpenRouterCatalog();
    // OpenCode Zen / Go are absent from the OpenRouter catalog, so their pricing
    // must come from models.dev or getModelPricing throws on the first reservation.
    // Keyed off every model actually in play, NOT off the executor: the producer
    // and the executor can sit on different providers by design.
    const modelsInPlay = [activeModel, PROVISIONAL_CONFIG.PRODUCER_MODEL];
    if (modelsInPlay.some((m) => m.startsWith('opencode/') || m.startsWith('opencode-go/'))) {
      const md = await syncModelsDevCatalog();
      console.log(`           models.dev: ${md.count} models priced across ${md.providers.join(', ')} (${md.loadedFrom}).`);
    }
  } catch (err: any) {
    console.warn(`[Boot Warning] Catalog cache refresh skipped: ${err.message}`);
  }

  // Seed the fleet. A config file defines NAMED bots with roles, models,
  // budgets and tools; with no file the daemon still boots with one default
  // worker, and says so rather than pretending it was configured.
  const primaryAgentId = fileConfig ? fileConfig.config.agents[0].id : 'agent-alpha';
  const existingAgents = store.listAgents();
  const known = new Set(existingAgents.map((a) => a.id));

  if (fileConfig) {
    for (const agent of fileConfig.config.agents) {
      store.getDatabase().prepare('UPDATE agents SET requires_approval = ? WHERE id = ?').run(Number(agent.requiresApproval), agent.id);
      if (known.has(agent.id)) continue;
      if (agent.connection && !providerConnections.get(agent.connection)) {
        console.warn(`[Boot Warning] Agent "${agent.id}" references provider connection "${agent.connection}", which is not configured in Settings. Its requests are refused until that connection exists.`);
      }
      store.createAgent({
        id: agent.id,
        name: agent.name,
        model_id: agent.model,
        fallback_model_id: agent.fallbackModel ?? null,
        connection_id: agent.connection ?? null,
        routing_mode: agent.connection ? agent.routing ?? 'pinned' : null,
        system_prompt: systemPromptFor(agent),
        requires_approval: Number(agent.requiresApproval),
        budget_cap_usd: agent.budgetUsd,
        current_status: 'IDLE',
      });
      console.log(
        `           Seeded agent "${agent.id}" (${agent.name}) on ${agent.model}` +
          (agent.mcpServers.length > 0 ? ` with tools: ${agent.mcpServers.join(', ')}` : '')
      );
    }
  } else if (existingAgents.length === 0) {
    store.createAgent({
      id: 'agent-alpha',
      name: 'Alpha Worker',
      model_id: activeModel,
      budget_cap_usd: 10.0,
      current_status: 'IDLE',
    });
    console.log(`           Seeded default agent "agent-alpha" (${activeModel}).`);
  }

  // Seed configured routines if declared
  if (fileConfig?.config.routines) {
    for (const r of fileConfig.config.routines) {
      const existing = store.getRoutine(r.id);
      if (existing) {
        // Repair a legacy config-owned routine once it gains an explicit task.
        // During this one-time repair, the explicit config is the authority for
        // its schedule and prompt as well as the newly required task binding.
        if (!existing.task_name && r.taskName) {
          const parsed = parseSchedule(r.schedule);
          const tz = r.timezone ?? 'UTC';
          store.updateRoutine(existing.id, { name: r.name, cron_expression: parsed.cron, human_schedule: parsed.human, timezone: tz,
            prompt_template: r.prompt, task_name: r.taskName, enabled: r.enabled ? 1 : 0, catch_up_policy: r.catchUpPolicy,
            next_run_at: computeNextRun(parsed.cron, Date.now(), tz) });
          console.log(`           Repaired routine "${r.id}" with task "${r.taskName}" from configuration.`);
        }
        continue;
      }
      try {
        const parsed = parseSchedule(r.schedule);
        const tz = r.timezone ?? 'UTC';
        const nextRunAt = computeNextRun(parsed.cron, Date.now(), tz);
        store.createRoutine({
          id: r.id,
          agentId: r.agentId,
          name: r.name,
          cronExpression: parsed.cron,
          humanSchedule: parsed.human,
          timezone: tz,
          promptTemplate: r.prompt,
          taskName: r.taskName,
          enabled: r.enabled,
          catchUpPolicy: r.catchUpPolicy,
          nextRunAt,
        });
        console.log(`           Seeded routine "${r.id}" (${r.name}, "${parsed.human}") for agent "${r.agentId}".`);
      } catch (err: any) {
        console.warn(`[Boot Warning] Skipping invalid routine "${r.id}": ${err.message}`);
      }
    }
  }

  // Work producer. Precedence: explicit instance > mission > nothing.
  // Without one the daemon executes only operator-enqueued work.
  // The scheduler does not exist yet, so registration is deferred through a ref.
  let schedulerRef: TaskScheduler | null = null;
  const capacity = new RunCapacity(maxConcurrency);
  const flowStore=new FlowStore(store);
  const currentFlowKey=(routineId:string)=>{const r=store.getRoutine(routineId);if(!r)return null;
    const c=r.task_name===ROUTINE_ASK_TASK?ROUTINE_ASK_CONTRACT:contracts.find(c=>`work:${c.id}`===r.task_name);
    return c&&c.kind!=='code'&&!c.repository?flowKeyFor(r.id,c.id,r.prompt_template):null;};
  let workProducer: IWorkProducer;
  if (options.workProducer) {
    workProducer = options.workProducer;
  } else if (mission && mission.trim()) {
    workProducer = new GoalDecompositionWorkProducer({
      capacity,
      mission,
      agentId: primaryAgentId,
      // Share the boot sandbox so the pre-flight uses the same Docker context
      // the executors will.
      sandbox,
      llmClient: options.llmClient ?? new LiveLLMClient({ connections: providerConnections }),
      // NOT activeModel: the producer talks to a chat-completions endpoint, while
      // activeModel may be an agentic-executor model on a different provider.
      modelId: PROVISIONAL_CONFIG.PRODUCER_MODEL,
      ledger,
      budgetCapUsd: PROVISIONAL_CONFIG.DEFAULT_TASK_BUDGET_USD,
      registerTaskDefinition: (name, def) => {
        if (!schedulerRef) throw new Error('Scheduler not ready for task registration.');
        schedulerRef.registerTaskDefinition(name, def);
      },
      minIntervalMs: PROVISIONAL_CONFIG.GOAL_PRODUCER_MIN_INTERVAL_MS,
      maxProposalsPerDay: PROVISIONAL_CONFIG.GOAL_PRODUCER_MAX_PROPOSALS_PER_DAY,
    });
  } else {
    workProducer = new PlaceholderWorkProducer();
  }

  // Routine work producer: prioritised over background cycle work
  const routineProducer = new RoutineWorkProducer({
    maxQueueDepth: maxConcurrency,
    getTaskDefinition: (name) => schedulerRef?.getTaskDefinition(name),
    // Leave a routine due while an earlier run of it sent something whose result was
    // never confirmed (external-effects.ts). The owner's "Checked — continue" releases
    // it; items of deleted routines hold nothing. Stage 2 adds the attention check here.
    holds: (agentId, routineId) => pendingForRoutine(store, routineId).length > 0 || !!flowStore.heldForAttention(agentId,routineId,currentFlowKey(routineId)??'') || !characterRhythm.eligibility(agentId,routineId,'schedule',store.getRoutine(routineId)?.next_run_at??Date.now()).eligible,
    registerTaskDefinition: (name, def) => {
      if (!schedulerRef) throw new Error('Scheduler not ready for task registration.');
      schedulerRef.registerTaskDefinition(name, def);
    },
  });

  const missions = new MissionService(store, contracts, maxConcurrency);
  const memory = new MemoryService(store, Object.fromEntries((fileConfig?.config.agents ?? []).filter(a => a.obsidianVault).map(a => [a.id, path.resolve(path.dirname(fileConfig!.source), a.obsidianVault!)])));
  const retention = new RetentionService(store, sandbox);
  const activeWorkProducer = new CompositeWorkProducer({
    producers: [routineProducer, missions, workProducer],
    maxQueueDepth: maxConcurrency,
  });
  cleanup.push(() => activeWorkProducer.stop());
  await activeWorkProducer.start();
  console.log(
    `           Work producer: ${activeWorkProducer.constructor.name} ([RoutineWorkProducer, ${workProducer.constructor.name}])`
  );

  // Step 4: WS Server Start
  console.log(`[Boot 4/5] Starting WebSocket server on port ${wsPort}...`);
  // Volume naming is owned by DockerSandbox.createWorkspaceVolume(`task-${runId}`).
  const volumeNameForRun = (runId: string) => {
    const run = store.getTaskRun(runId);
    const saved = run && store.getAgentData(run.agent_id, runId, 'workspaces');
    return saved ? JSON.parse(saved.data_json).volumeName : sandbox.workspaceVolumeName(`task-${runId}`);
  };

  /**
   * Concrete reader behind the Cortex HTTP API. Every "not available" answer
   * states WHY - a finished run has had its workspace reaped, and reporting an
   * empty file list would be indistinguishable from a task that wrote nothing.
   */
  // MCP lives HERE, in the daemon, and nowhere else. See mcp-client.ts for why.
  const mcpRegistry = new McpRegistry({
    agentStore: store,
    servers: fileConfig ? fileConfig.config.mcpServers : PROVISIONAL_CONFIG.MCP_SERVERS,
    allowlist: fileConfig
      ? Object.fromEntries(fileConfig.config.agents.map((a) => [a.id, a.mcpServers]))
      : PROVISIONAL_CONFIG.MCP_ALLOWLIST,
  });
  cleanup.push(() => mcpRegistry.stop());
  const mcpStatus = await mcpRegistry.start();
  if (mcpStatus.length > 0) {
    const up = mcpStatus.filter((s) => s.connected).length;
    console.log(`           MCP: ${up}/${mcpStatus.length} servers connected.`);
    for (const failed of mcpStatus.filter((s) => !s.connected)) {
      console.warn(`[MCP Warning] "${failed.name}" is not connected: ${failed.error}`);
    }
  }

  // Operator control plane. Both are constructed before the scheduler so a task
  // can be gated from its very first tick.
  const approvalGate = new ApprovalGate(store);
  const steerBus = new SteerBus();

  const artifacts = new ArtifactStore(store);
  const characterJournal = new CharacterJournal({ store });
  let characterAdmissions: CharacterAdmissions;
  let characterQualification:CharacterQualification;
  const characterStore = new CharacterStore(store, {
    onVersionSaved: (agentId) => {characterAdmissions?.invalidateAgent(agentId, 'version-changed');characterQualification?.invalidateAgent(agentId,'identity-changed');},
  });
  characterAdmissions = new CharacterAdmissions({
    store,
    journal: characterJournal,
    assertRelease:id=>characterQualification?.assertRelease(id),
    activeVersion: (agentId) => {
      const v = characterStore.getLatest(agentId);
      return v ? { version: v.version, mode: v.mode } : null;
    },
  });
  const characterProjector = new CharacterProjector({ store, journal: characterJournal });
  const characterProposals = new CharacterProposals(store, characterStore);
  const characterRhythm = new CharacterRhythm(store, characterStore);
  const characterClaims = new CharacterClaims(store, characterStore, characterJournal);
  characterQualification=new CharacterQualification(store,agentId=>{characterAdmissions.invalidateAgent(agentId,'version-changed');});
  const characterReviewService=new CharacterReviewService(store,options.characterLocalReviewer);
  cleanup.push(()=>characterReviewService.stop());
  const characterAudit=new CharacterAudit(store,characterQualification);
  const characterSetup = new CharacterSetup({ store, characters: characterStore, proposals: characterProposals, capacity, ledger,
    llm: options.llmClient ?? new LiveLLMClient({ connections: providerConnections }), providerRouter });
  characterProjector.repairAll();
  characterClaims.repair();
  const characterPreview = new CharacterPreviewService({ agentStore: store, characterStore, capacity, ledger,
    llm: options.llmClient ?? new LiveLLMClient({ connections: providerConnections }), providerRouter, connections: providerConnections });

  const research = new WebResearch({ enabled: fileConfig?.config.research.enabled ?? true });
  // Accounts a bot signs in with by itself; encrypted, and typed only on their own site.
  const browserAccounts = new BrowserAccounts(store, secretStore);
  // Every daemon browser uses a bot-owned desktop. No development flag or host fallback.
  const browserIsolation = fileConfig?.config.browser.isolation ?? 'auto';
  const botDesktop = new BotDesktop({ ownerId: path.resolve(dbPath), stateDir: path.join(path.dirname(path.resolve(dbPath)), 'bot-desktops'), assetsDir: desktopAssetsDir(), autoProvision: true, identityKey: id => store.desktopIdentity(id) });
  // Sites whose posts are recorded before they leave Chrome and proven afterwards.
  const probes = [xCreateTweet()];
  const browser = new BrowserTools({ store, artifacts, secrets: secretStore, approvals: approvalGate, accounts: browserAccounts, desktop: botDesktop, isolation: browserIsolation, enabled: fileConfig?.config.browser.enabled ?? true, maxBrowsers: fileConfig?.config.browser.maxConcurrency ?? 2, publishProbes: probes });
  // Must-post routines. Constructing it creates its tables, seeds them from history and
  // writes the install marker, all before scheduler.start() below can tick the producer.
  const publishPolicy = new PublishPolicy(store, probes);
  const flowPlayer=new FlowPlayer({store,browser,flows:flowStore,probes});
  const characterBundles = new CharacterBundles(characterProposals, publishPolicy,async(agentId,pluginId)=>{
    grantInstalledPlugin(agentId,pluginId,fileConfig?.source);
    await mcpRegistry.reload(listConfiguredPlugins(fileConfig?.source),configuredPluginPermissions(fileConfig?.source));
  });
  const engagementReader = new EngagementReader(store, characterStore, browser, capacity);
  const characterRetention = new CharacterRetention(store, characterStore, characterAdmissions,ids=>characterQualification.evidenceRemoved(ids));
  void characterBundles.recover(new AbortController().signal).catch(() => console.warn('Pending character bundle recovery stopped.'));
  // Desktop setup is operator-controlled; a model tool cannot enable downloads.
  if (process.env.OPENHOURS_AUTO_SETUP === '1' && browser.status().enabled && !browser.status().ready) browser.install();
  cleanup.push(async () => { await browser.stop(); await botDesktop?.stop(); });
  // Public GitHub snapshots for operator-started repository work; nothing is published from them.
  const repositories = new RepositoryFetcher({
    local: Object.fromEntries(Object.entries(fileConfig?.config.repositories.local ?? {}).map(([alias, root]) => [alias, path.resolve(path.dirname(fileConfig!.source), root)])),
    githubToken: repository => {
      const grant = fileConfig?.config.repositories.github.find(g => g.repository.toLowerCase() === `${repository.owner}/${repository.repo}`.toLowerCase());
      if (!grant) return undefined;
      const token = process.env[grant.tokenEnv]?.trim();
      if (!token) throw new Error('The configured GitHub credential is unavailable. Set its environment variable before starting OpenAgents.');
      return token;
    },
  });
  const liveChannel = new LiveChannel((runId, frame) => wsServer.sendToSubscribers(runId, frame));
  const questions = new WorkQuestions(store);
  const background = new BackgroundTasks(store,Object.fromEntries((fileConfig?.config.agents??[]).map(a=>[a.id,a.delegateTo])));
  const attachments = new Attachments(store);
  const publicationGrant = (repository: string) => fileConfig?.config.repositories.github.find(g => g.publish && g.repository.toLowerCase() === repository.toLowerCase());
  const publication = new RepositoryPublication(store, artifacts, githubClient(repository => {
    const grant = publicationGrant(repository);
    return grant ? process.env[grant.tokenEnv]?.trim() ?? '' : '';
  }), repository => Boolean(publicationGrant(repository)));
  const workRuntime = new WorkRuntime({ store, engagementReader, flows:{store:flowStore,player:flowPlayer}, characterStore, characterSetup, characterPosting: { journal: characterJournal, admissions: characterAdmissions, projector: characterProjector, rhythm: characterRhythm, claims: characterClaims, qualification:characterQualification,reviewService:characterReviewService }, ledger, sandbox, artifacts, memory, providerRouter, contracts, missions, questions, attachments, visionModels: fileConfig?.config.visionModels ?? [], web: research, browser, repositories, mcp: mcpRegistry, approvals: approvalGate, llm: options.llmClient ?? new LiveLLMClient({ connections: providerConnections }), live: liveChannel, steer: steerBus,
    capacity, background, publishPolicy, delegationAllowlist: Object.fromEntries((fileConfig?.config.agents ?? []).map(a => [a.id, a.delegateTo])) });

  // ---- What the bot says by itself reaches the conversation ----
  //
  // Routine results, mission steps and the outcome of a decided proposal are
  // posted into the conversation the person already reads. The workspace shows
  // one conversation per bot - its most recent - so a separate thread would be
  // invisible, or would take over the chat without warning. Each post records a
  // CHAT_REPLY event, which is what tells an open chat to refresh.
  const postToConversation = (params: { agentId: string; threadId?: unknown; taskRunId: string; content: string; source: string;
    usage?: { inputTokens: number; outputTokens: number; costUsd: number | null } }): string => {
    const preferred = typeof params.threadId === 'string' ? store.getThread(params.threadId) : null;
    const threadId = preferred && preferred.agent_id === params.agentId ? preferred.id
      : store.listThreads(params.agentId)[0]?.id ?? store.createThread({ agentId: params.agentId, title: 'Conversation' }).id;
    const agent = store.getAgent(params.agentId);
    const message = store.appendMessage({ thread_id: threadId, role: 'assistant', content: params.content, model_id: agent?.model_id ?? null,
      input_tokens: params.usage?.inputTokens ?? null, output_tokens: params.usage?.outputTokens ?? null, cost_usd: params.usage?.costUsd ?? null, task_run_id: params.taskRunId });
    store.recordEvent({ task_run_id: params.taskRunId, agent_id: params.agentId, model_id: agent?.model_id ?? null, event_type: 'CHAT_REPLY',
      payload_json: JSON.stringify({ threadId, agentId: params.agentId, source: params.source, messageId: message.id }), timestamp: Date.now() });
    if (params.source === 'routine' || params.source === 'mission') {
      try {
        const existingFlagsRaw = store.getAgentData(params.agentId, 'flags', 'ui');
        const flags = existingFlagsRaw ? JSON.parse(existingFlagsRaw.data_json) : { pinned: false, unread: false, hidden: false, section: null };
        if (!flags.unread) {
          flags.unread = true;
          store.setAgentData({ agentId: params.agentId, category: 'ui', key: 'flags', data: flags });
        }
      } catch {
        /* ignore */
      }
    }
    return threadId;
  };

  const characterGrowth=new CharacterGrowth({store,characters:characterStore,proposals:characterProposals,capacity,ledger,
    llm:options.llmClient??new LiveLLMClient({connections:providerConnections}),providerRouter,
    notify:(agentId,taskRunId,content)=>{postToConversation({agentId,taskRunId,content,source:'character-growth'});}});
  const characterDrift=new CharacterDrift(store,characterStore,(agentId,taskRunId,content)=>{postToConversation({agentId,taskRunId,content,source:'character-drift'});});
  const characterTimers=new Map<string,ReturnType<typeof setTimeout>>();
  const checkCharacterAfterRun=(agentId:string)=>{
    if(characterTimers.has(agentId))return;
    characterTimers.set(agentId,setTimeout(()=>{characterTimers.delete(agentId);
      try{characterClaims.repair();characterDrift.check(agentId);characterRetention.prune(agentId);}catch{console.warn('Character maintenance could not complete.');}
      void characterGrowth.signal(agentId).catch(()=>console.warn('Character growth eligibility check failed.'));
    },1000));
  };
  const characterWeekly=setInterval(()=>{for(const a of store.listAgents())checkCharacterAfterRun(a.id);},7*86400000);
  const characterRetry=setInterval(()=>{for(const a of store.listAgents()){const status=characterGrowth.status(a.id);if(status.failures>0&&status.eligible)checkCharacterAfterRun(a.id);}},60000);
  const stopCharacterMaintenance=async()=>{clearInterval(characterWeekly);clearInterval(characterRetry);for(const t of characterTimers.values())clearTimeout(t);characterTimers.clear();await characterGrowth.stop();};
  cleanup.push(stopCharacterMaintenance);

  // Proposals from chat (see ApprovalGate.propose): the chat turn already ended,
  // so the decision is carried out here and answered in the same conversation.
  // Registering this is what makes request_human available: canPropose() asks whether a
  // decision on a kind has anywhere to go. Nothing is carried out here - the run is still
  // waiting inside its own turn and resumes the moment the decision lands, which is the
  // whole point: the operator does one step and the same task continues.
  approvalGate.onDecision('human-assist', () => {});
  approvalGate.onDecision('character-change', () => {});
  approvalGate.onDecision('routine-create', (record, status) => {
    const proposal = JSON.parse(record.payload_json) as { name: string; instruction: string; schedule: string; cron: string; timezone: string; threadId?: string | null };
    const say = (content: string) => postToConversation({ agentId: record.agent_id, threadId: proposal.threadId, taskRunId: record.task_run_id, source: 'proposal', content });
    if (status !== 'APPROVED') {
      say(`Okay, I won't create “${proposal.name}”. Tell me if you'd like a different schedule or instruction.`);
      return;
    }
    try {
      const nextRunAt = computeNextRun(proposal.cron, Date.now(), proposal.timezone);
      const routine = store.createRoutine({ agentId: record.agent_id, name: proposal.name, cronExpression: proposal.cron, humanSchedule: proposal.schedule,
        timezone: proposal.timezone, promptTemplate: proposal.instruction, taskName: ROUTINE_ASK_TASK, enabled: true, catchUpPolicy: 'skip', nextRunAt });
      store.recordEvent({ task_run_id: record.task_run_id, agent_id: record.agent_id, event_type: 'ROUTINE_CREATED',
        payload_json: JSON.stringify({ routineId: routine.id, source: 'chat', approvalId: record.id }), timestamp: Date.now() });
      const firstRun = new Date(nextRunAt).toLocaleString('en-US', { timeZone: proposal.timezone, dateStyle: 'medium', timeStyle: 'short' });
      say(`Created **${routine.name}**. It runs ${proposal.schedule} (${proposal.timezone}), starting ${firstRun}. Each result will appear here, and you can edit, pause or run it from the Workspace panel.`);
    } catch (error) {
      say(`I couldn't create “${proposal.name}”: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  approvalGate.onDecision('vault-connect', (record, status) => {
    const proposal = JSON.parse(record.payload_json) as { path: string; threadId?: string | null };
    const say = (content: string) => postToConversation({ agentId: record.agent_id, threadId: proposal.threadId, taskRunId: record.task_run_id, source: 'proposal', content });
    if (status !== 'APPROVED') {
      say('Okay, I won\'t connect that vault.');
      return;
    }
    try {
      const vault = memory.setVault(record.agent_id, proposal.path);
      say(`Connected your Obsidian vault at ${vault.path}. I can read notes from it into my memory and save new notes there; existing notes are never overwritten.`);
    } catch (error) {
      say(`I couldn't connect that vault: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  // The card itself saves the details (POST /api/system/browser-account) and
  // then approves; an approval without a saved account is said plainly.
  approvalGate.onDecision('account-request', (record, status) => {
    const proposal = JSON.parse(record.payload_json) as { site: string; threadId?: string | null; questionId?: string };
    const say = (content: string) => postToConversation({ agentId: record.agent_id, threadId: proposal.threadId, taskRunId: record.task_run_id, source: 'proposal', content });
    if (status !== 'APPROVED') {
      if (proposal.questionId) { try { questions.cancel(record.agent_id, proposal.questionId); } catch { /* An already resumed task remains under scheduler control. */ } }
      say(`Okay, I won't sign in to ${proposal.site}. I can still do the parts that don't need an account.`);
      return;
    }
    if (browser.connections(record.agent_id).some(c => c.site === proposal.site)) {
      say(`Your sign-in to ${proposal.site} is saved for this bot. ${proposal.questionId ? "I'm checking access and continuing your task." : 'Say "continue" and I will check access and pick up the task.'}`);
      return;
    }
    // Legacy password-card approvals continue through a new chat turn. Retire
    // their unused sign-in checkpoint so it cannot occupy a hidden pending slot.
    if (proposal.questionId) { try { questions.cancel(record.agent_id, proposal.questionId); } catch { /* Already resumed by the secure sign-in route. */ } }
    if (!browserAccounts.hasSite(record.agent_id, proposal.site)) {
      say(`No account for ${proposal.site} was saved, so I still can't sign in there. Add one from the bot panel and ask me again.`);
      return;
    }
    say(`Thanks. The account for ${proposal.site} is saved and encrypted on this computer. I type its details myself when I sign in there, and I never see them. Say "continue" and I'll pick up where I left off.`);
  });
  approvalGate.onDecision('mission-start', (record, status) => {
    const proposal = JSON.parse(record.payload_json) as { objective: string; contractId: string; maxRuns: number; intervalMs: number; threadId?: string | null };
    const say = (content: string) => postToConversation({ agentId: record.agent_id, threadId: proposal.threadId, taskRunId: record.task_run_id, source: 'proposal', content });
    if (status !== 'APPROVED') {
      say('Okay, I won\'t start that mission. Tell me if you\'d like to change the goal or the pace.');
      return;
    }
    try {
      missions.create({ agentId: record.agent_id, objective: proposal.objective, contractId: proposal.contractId, maxRuns: proposal.maxRuns, intervalMs: proposal.intervalMs });
      store.recordEvent({ task_run_id: record.task_run_id, agent_id: record.agent_id, event_type: 'MISSION_CREATED_FROM_CHAT',
        payload_json: JSON.stringify({ approvalId: record.id, maxRuns: proposal.maxRuns }), timestamp: Date.now() });
      say(`Started the mission. I'll take up to ${proposal.maxRuns} steps, at least ${Math.max(1, Math.round(proposal.intervalMs / 60000))} minutes apart, and post each result here. Pause or stop it any time from the Workspace panel.`);
    } catch (error) {
      say(`I couldn't start the mission: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const readApi: DaemonReadApi = {
    desktopAccess: agentId => browser.desktopAccess(agentId),
    desktopObserve: agentId => browser.desktopObserve(agentId),
    browserRuntime: 'bot-desktop-v1',
    desktopOnRevoke: (agentId, close) => browser.desktopOnRevoke(agentId, close),
    system: systemApi({ flows:flowStore,currentFlowKey,missions, memory, retention, capacity, browser, store, repositories, questions, publication, attachments, background, abort: id => chat.abortTask(id)||(schedulerRef?.abortTask(id) ?? false), research: () => research.capabilities(), accounts: browserAccounts, approvals: approvalGate, publishPolicy,
      character: characterApi({ store, characters: characterStore, proposals: characterProposals, bundles: characterBundles, claims: characterClaims, rhythm: characterRhythm, reader: engagementReader, retention: characterRetention, growth: characterGrowth, audit:characterAudit, qualification:characterQualification,reviewService:characterReviewService, journal: characterJournal, previews: characterPreview, connections: providerConnections,
        inspect: input => workRuntime.inspectOwnerChat(input) }) }),
    artifacts: id => artifacts.list(id, true),
    workResult: id => readWorkResult(store, id),
    artifact: (runId, id) => artifacts.read(runId, id),
    mcpStatus: () => mcpRegistry.status(),

    approvals: (taskRunId) =>
      store.listApprovals({ taskRunId }).map((a) => ({
        ...a,
        // Whether a decision would actually reach a waiter in THIS process.
        waiting: approvalGate.isWaiting(a.id, a.kind),
      })),

    getRunEvents(taskRunId, sinceEventId) {
      const events = store.getTaskEvents(taskRunId);
      return sinceEventId === undefined
        ? events
        : events.filter((e) => (e.id ?? 0) > sinceEventId);
    },

    async getRunWorkspace(taskRunId) {
      const run = store.getTaskRun(taskRunId);
      if (!run) return { available: false, reason: `No such task run: ${taskRunId}` };
      const definition = store.getRunDefinition(taskRunId) as { kind?: string; work?: { contract?: { kind?: string } } } | null;
      const kind = definition?.work?.contract?.kind ?? definition?.kind;
      // Character setup drafts and Studio previews are no-tool model calls; asking Docker for their volume only 404s.
      const started = run.task_name.startsWith('chat:') ? null : store.getLatestTaskEvent(taskRunId, 'TASK_STARTED');
      let executor: unknown;
      try { executor = started ? (JSON.parse(started.payload_json) as { executor?: unknown }).executor : undefined; } catch { executor = undefined; }
      if (run.task_name === 'browser-login' || run.task_name.startsWith('chat:') || kind === 'report' || kind === 'plan' || executor === 'character-preview') {
        try {
          const artifacts = store.getDatabase().prepare('SELECT path FROM run_artifacts WHERE task_run_id = ? ORDER BY path ASC').all(taskRunId) as Array<{ path: string }>;
          if (artifacts.length > 0) {
            return { available: true, files: artifacts.map(a => a.path) };
          }
        } catch {
          // ignore
        }
        return { available: false, required: false, reason: 'This task runs without a computer workspace. Open its result to download the deliverables.' };
      }
      const volume = volumeNameForRun(taskRunId);
      if (!(await sandbox.workspaceVolumeExists(volume))) {
        try {
          const artifacts = store.getDatabase().prepare('SELECT path FROM run_artifacts WHERE task_run_id = ? ORDER BY path ASC').all(taskRunId) as Array<{ path: string }>;
          if (artifacts.length > 0) {
            return { available: true, files: artifacts.map(a => a.path) };
          }
        } catch {
          // ignore
        }
        const isFinished = ['COMPLETED', 'FAILED', 'ABORTED', 'CRASHED'].includes(run.status);
        return {
          available: false,
          ...(isFinished ? { required: false } : {}),
          reason: `No retained workspace is available for this ${run.status} run. It may predate workspace retention or have been removed from Docker.`,
        };
      }
      return { available: true, files: await sandbox.listWorkspaceFiles(volume) };
    },

    async readRunFile(taskRunId, file) {
      const run = store.getTaskRun(taskRunId);
      if (!run) return { available: false, reason: `No such task run: ${taskRunId}` };
      // Retained deliverables remain editable without Docker. They are the
      // authoritative user copy; editing never rewrites the original task result.
      const retained = store.getDatabase().prepare('SELECT content, encoding FROM run_artifacts WHERE task_run_id=? AND path=?').get(taskRunId, file) as {content: string; encoding: string} | undefined;
      if (retained && run.status !== 'RUNNING' && run.status !== 'QUEUED') {
        return retained.encoding === 'base64'
          ? { available: false, reason: 'This is a binary file. Download it to open it.' }
          : { available: true, content: retained.content, truncated: false };
      }
      const volume = volumeNameForRun(taskRunId);
      if (await sandbox.workspaceVolumeExists(volume)) {
        try {
          const { content, truncated } = await sandbox.readWorkspaceFile(volume, file);
          if (!truncated && !retained && run.status !== 'RUNNING' && run.status !== 'QUEUED' && Buffer.byteLength(content) <= 256 * 1024 && !content.includes('\0')) {
            artifacts.save(taskRunId, { [file]: content });
          }
          return { available: true, content, truncated };
        } catch {
          // Fall through to run_artifacts if not found in volume
        }
      }
      try {
        const row = store.getDatabase().prepare('SELECT content, encoding FROM run_artifacts WHERE task_run_id = ? AND path = ?').get(taskRunId, file) as { content: string; encoding?: string } | undefined;
        if (row) {
          if (row.encoding === 'base64') return { available: false, reason: 'This is a binary file. Download it from the task result to open it.' };
          return { available: true, content: row.content, truncated: false };
        }
      } catch {
        // ignore
      }
      return {
        available: false,
        reason: `File "${file}" is not available in workspace for this run.`,
      };
    },

    async writeRunFile(taskRunId, file, content, expectedContent) {
      try {
        artifacts.edit(taskRunId, file, content, expectedContent);
        return { success: true };
      } catch (err: any) {
        return { success: false, reason: err?.message ?? String(err) };
      }
    },

    // Search and usage read the same database the rest of the API does, through
    // the store's own handle - no second connection, no copy of the schema.
    search: (options) => searchContent(store.getDatabase(), options),
    usage: async () => usageSummary(store.getDatabase(), localUsage.current(), await providerConnections.collectGatewayQuotas()),

    routines: (agentId) => store.listRoutines(agentId),
    routine: (id) => store.getRoutine(id),
    // Each run carries its post summary (the run-history badges) and whether the model
    // itself declared the block. Only a FAILED run can be model-blocked, so only those
    // runs' saved results are read.
    routineRuns: (routineId) => {
      const runs = store.listRoutineRuns(routineId);
      const posts = publishSummary(store, runs.map((run) => run.id));
      return runs.map((run) => {
        const publish = posts.get(run.id);
        const blocked = run.status === 'FAILED' && readWorkResult(store, run.id)?.blocked?.declaredBy === 'model';
        return { ...run, ...(publish ? { publish } : {}), ...(blocked ? { blocked: true as const } : {}) };
      });
    },
    stepCounts: (runIds) => store.getStepCounts(runIds),
    browserScreenshot: (id) => browser.getLatestScreenshot(id),
    browserState: (id) => browser.getLatestState(id),
    // Runtime-owned categories (saved results, checked work, recovery pins) are read-only here.
    ...publicAgentDataApi(store),
  };

  const wsServer = new DaemonWsServer(
    wsPort,
    () => ({
      agents: store.listAgents().map(agent => ({ ...agent,
        // Actual configured runtimes and connected per-agent MCP permissions.
        capabilities: ['tool-cost-ledger', 'tool-test-container', ...mcpRegistry.serversForAgent(agent.id).map(name => `mcp-${name}`), ...(executor === 'opencode' ? ['tool-opencode'] : [])],
      })),
      taskRuns: store.listTaskRuns(),
      routines: store.listRoutines(),
      // The UI disables steering for an executor that cannot apply it, so it
      // has to be told which one is running rather than guessing.
      executor,
    }),
    readApi,
    { ...credentials, allowedOrigins: (process.env.OPENHOURS_UI_ORIGINS ?? '').split(',').filter(Boolean) }
  );
  wsServer.setLiveChannel(liveChannel);

  // The store is the sole owner of the event stream, so this is the ONE place
  // events reach the wire. Executors record through the store and never
  // broadcast themselves, which is what stops a single transition being
  // delivered twice.
  store.setEventSink((event) => {
    wsServer.broadcast(event);
    try {
      characterProjector.onEvent(event);
      if(event.event_type==='CHARACTER_POSTED') {
        const payload=JSON.parse(event.payload_json??'{}');
        if(typeof payload.utteranceId==='string')characterClaims.project(event.agent_id,payload.utteranceId);
      }
      if(['TASK_COMPLETED','TASK_FAILED','TASK_ABORTED','TASK_BLOCKED'].includes(event.event_type)&&!event.task_run_id.startsWith('character-'))checkCharacterAfterRun(event.agent_id);
    } catch (error) {
      console.error('Character projector failed on event:', error);
    }
  });

  // A routine without a task is refused at every occurrence; say so at boot, not only in failed runs.
  for (const routine of store.listRoutines()) {
    if (routine.enabled && !routine.task_name) {
      console.warn(`[Boot Warning] Routine "${routine.id}" (${routine.name}) names no task, so each occurrence is refused. Bind it to a task such as work:evidence-brief, or disable it.`);
    }
  }

  // Step 5: Scheduler Start
  console.log('[Boot 5/5] Configuring and starting task scheduler...');
  const scheduler = new TaskScheduler({
    canRun: id => missions.canRun(id),
    capacity, workRuntime, characterStore,
    onWorkResult: (run, result) => {
      const resumed = (store.getRunDefinition(run.id) as { work?: { questionResume?: { threadId?: string } } } | null)?.work?.questionResume;
      if (resumed?.threadId) {
        store.appendMessage({ thread_id: resumed.threadId, role: 'assistant', content: result.report, model_id: run.model_id,
          input_tokens: result.inputTokens, output_tokens: result.outputTokens, cost_usd: result.actualCostUsd, task_run_id: run.id });
        return;
      }
      const usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.actualCostUsd };
      if (run.routine_id) {
        const routine = store.getRoutine(run.routine_id);
        if (routine) postToConversation({ agentId: routine.agent_id, taskRunId: run.id, source: 'routine', content: `**Routine · ${routine.name}**\n\n${result.report}`, usage });
        return;
      }
      const mission = store.getDatabase().prepare('SELECT objective FROM missions WHERE last_run_id = ?').get(run.id) as { objective: string } | undefined;
      if (mission) {
        const title = mission.objective.length > 90 ? `${mission.objective.slice(0, 90)}…` : mission.objective;
        postToConversation({ agentId: run.agent_id, taskRunId: run.id, source: 'mission', content: `**Mission step · ${title}**\n\n${result.report}`, usage });
      }
    },
    // A routine that answers from scratch every hour repeats itself; its last
    // few results let it report what is new.
    historyFor: (run) => (run.routine_id ? routineHistory(store, run.routine_id) : undefined),
    agentStore: store,
    providerRouter,
    sandbox,
    ledger,
    approvalGate,
    steerBus,
    llmClient: options.llmClient ?? new LiveLLMClient({ connections: providerConnections }),
    cadenceMs,
    maxConcurrency,
    workProducer: activeWorkProducer,
    executor,
  });

  schedulerRef = scheduler;

  // Register all standing benchmark tasks into scheduler
  for (const b of STANDING_BENCHMARKS) {
    scheduler.registerTaskDefinition(b.id, {
      initialFiles: b.initialFiles,
      testCommand: b.testCommand,
      maxTurns: b.maxTurns,
      timeoutMs: b.timeoutSeconds ? b.timeoutSeconds * 1000 : undefined,
    });
  }

  for (const contract of contracts) scheduler.registerTaskDefinition(`work:${contract.id}`, workTaskDefinition(contract, contract.description));
  // The default routine: its instruction runs as a conversation turn with tools.
  {
    const ask = workTaskDefinition(ROUTINE_ASK_CONTRACT, ROUTINE_ASK_CONTRACT.description);
    ask.work!.conversation = true;
    scheduler.registerTaskDefinition(ROUTINE_ASK_TASK, ask);
  }

  // Wire WebSocket operator commands to scheduler
  /**
   * Enqueue one run of a routine.
   *
   * Shared by the manual "Test run" button and the webhook endpoint so both
   * produce an identical run: the same task definition, the same recorded
   * ROUTINE_TRIGGERED event, the same schedule bookkeeping. The only difference
   * is the `source` stamped on the event, which is what lets an operator tell a
   * webhook-fired run from one they started themselves.
   */
  function dispatchRoutine(routineId: string, source: 'manual' | 'webhook') {
    const routine = store.getRoutine(routineId);
    if (!routine) throw new Error(`Routine "${routineId}" not found.`);
    const agent = store.getAgent(routine.agent_id);
    if (!agent) throw new Error(`Agent "${routine.agent_id}" not found.`);
    if (routine.enabled !== 1 && source === 'webhook') {
      // A disabled routine must not be firable from outside. The switch in the
      // editor is the operator saying "not now"; a webhook overriding it would
      // make that switch meaningless.
      throw new Error(`Routine "${routine.name}" is not active, so its webhook will not fire it.`);
    }

    const pacing=characterRhythm.eligibility(agent.id,routineId,source,source==='webhook'?Date.now():routine.next_run_at);
    if(flowStore.heldForAttention(agent.id,routineId,currentFlowKey(routineId)??''))throw new Error('Check the learned flow’s signed-in account before continuing.');
    if(!pacing.eligible)throw new Error(pacing.reason??'Outside the posting window.');
    const dispatched=enqueueRoutine(store, routineId, { source, maxQueueDepth: maxConcurrency,
      definition: routine.task_name ? schedulerRef?.getTaskDefinition(routine.task_name) : undefined });
    if(source==='manual'&&dispatched.created)characterRhythm.bindManual(agent.id,routineId,dispatched.run.id);
    return dispatched;
  }

  wsServer.onCommand(async (cmd: WsCommand) => {
    console.log(`[WS Command] Received "${cmd.command}" for target "${cmd.targetId}"`);
    if (cmd.command === 'kill') {
      const aborted = await browser.cancelLoginRun(cmd.targetId) || chat.abortTask(cmd.targetId) || scheduler.abortTask(cmd.targetId);
      return {
        success: aborted,
        message: aborted ? `Task ${cmd.targetId} killed.` : `Task ${cmd.targetId} was not running.`,
      };
    }
    if (cmd.command === 'pause') {
      store.updateAgentStatus(cmd.targetId, 'PAUSED');
      return { success: true, message: `Agent ${cmd.targetId} paused.` };
    }
    if (cmd.command === 'resume') {
      store.updateAgentStatus(cmd.targetId, 'IDLE');
      return { success: true, message: `Agent ${cmd.targetId} resumed.` };
    }
    if (cmd.command === 'approve' || cmd.command === 'deny') {
      const status = cmd.command === 'approve' ? 'APPROVED' : 'DENIED';
      try {
        // Say plainly when the row is answerable but nothing is listening,
        // rather than reporting a success that changes nothing.
        const pendingKind = (store.getDatabase().prepare('SELECT kind FROM approvals WHERE id = ?').get(cmd.targetId) as { kind: string } | undefined)?.kind;
        const live = approvalGate.isWaiting(cmd.targetId, pendingKind);
        approvalGate.decide(cmd.targetId, status, cmd.payload?.reason);
        return {
          success: true,
          message: live
            ? `Approval ${cmd.targetId} ${status.toLowerCase()}.`
            : `Approval ${cmd.targetId} recorded as ${status.toLowerCase()}, but nothing was waiting on it - ` +
              `the task that requested it is no longer running in this daemon.`,
        };
      } catch (err: any) {
        return { success: false, error: String(err?.message ?? err) };
      }
    }
    if (cmd.command === 'steer') {
      const message = String(cmd.payload?.message ?? '');
      try {
        const run = store.getTaskRun(cmd.targetId);
        if (!run) return { success: false, error: `No such task run: ${cmd.targetId}` };
        const isWorkTask = run.task_name.startsWith('work:') || run.task_name.startsWith('chat:') || Boolean((store.getRunDefinition(run.id) as any)?.work);
        steerBus.assertSupported(isWorkTask ? 'work' : scheduler.executorKind);
        if (run.status !== 'RUNNING') {
          return { success: false, error: `Task ${cmd.targetId} is ${run.status}, not RUNNING - nothing to steer.` };
        }
        steerBus.push(cmd.targetId, message);
        return { success: true, message: `Queued for the next turn boundary of ${cmd.targetId}.` };
      } catch (err: any) {
        return {
          success: false,
          error: err instanceof SteerNotSupportedError ? err.message : String(err?.message ?? err),
        };
      }
    }
    if (cmd.command === 'create_routine') {
      const { agentId, name, schedule, timezone, prompt, taskName, enabled, catchUpPolicy, webhookEnabled, scheduleEnabled } = cmd.payload ?? {};
      if (scheduleEnabled !== undefined && typeof scheduleEnabled !== 'boolean') return { success: false, error: 'scheduleEnabled must be a boolean.' };
      if (!agentId || !name || !schedule || !prompt) {
        return { success: false, error: 'agentId, name, schedule, and prompt are required to create a routine.' };
      }
      const agent = store.getAgent(agentId);
      if (!agent) {
        return { success: false, error: `Agent "${agentId}" does not exist.` };
      }
      const bindingError = routineBindingError(taskName, task => scheduler.getTaskDefinition(task), contracts);
      if (bindingError) return { success: false, error: bindingError };
      try {
        const parsed = parseSchedule(schedule);
        const tz = timezone ?? 'UTC';
        const nextRunAt = computeNextRun(parsed.cron, Date.now(), tz);
        const routine = store.transaction(() => {
          const created = store.createRoutine({
            agentId,
            name,
            cronExpression: parsed.cron,
            humanSchedule: parsed.human,
            timezone: tz,
            promptTemplate: prompt,
            taskName: taskName ?? null,
            enabled: enabled !== false,
            catchUpPolicy: catchUpPolicy ?? 'skip',
            scheduleEnabled,
            nextRunAt,
          });
          return webhookEnabled === true
            ? store.setRoutineWebhookToken(created.id, randomBytes(24).toString('base64url'))
            : created;
        });
        return { success: true, message: `Routine "${routine.id}" created.`, data: routine };
      } catch (err: any) {
        return { success: false, error: err.message ?? String(err) };
      }
    }
    if (cmd.command === 'update_routine') {
      const existing = store.getRoutine(cmd.targetId);
      if (!existing) {
        return { success: false, error: `Routine "${cmd.targetId}" not found.` };
      }
      const updates: any = {};
      if (cmd.payload?.scheduleEnabled !== undefined) {
        if (typeof cmd.payload.scheduleEnabled !== 'boolean') return { success: false, error: 'scheduleEnabled must be a boolean.' };
        updates.schedule_enabled = cmd.payload.scheduleEnabled ? 1 : 0;
      }
      if (cmd.payload?.name !== undefined) updates.name = cmd.payload.name;
      if (cmd.payload?.prompt !== undefined) updates.prompt_template = cmd.payload.prompt;
      if (cmd.payload?.taskName !== undefined) {
        const bindingError = routineBindingError(cmd.payload.taskName, task => scheduler.getTaskDefinition(task), contracts);
        if (bindingError) return { success: false, error: bindingError };
        updates.task_name = cmd.payload.taskName;
      }
      if (cmd.payload?.enabled !== undefined) updates.enabled = cmd.payload.enabled ? 1 : 0;
      if (cmd.payload?.catchUpPolicy !== undefined) updates.catch_up_policy = cmd.payload.catchUpPolicy;
      if (cmd.payload?.timezone !== undefined) updates.timezone = cmd.payload.timezone;

      if (cmd.payload?.schedule !== undefined) {
        try {
          const parsed = parseSchedule(cmd.payload.schedule);
          updates.cron_expression = parsed.cron;
          updates.human_schedule = parsed.human;
          const tz = updates.timezone ?? existing.timezone;
          updates.next_run_at = computeNextRun(parsed.cron, Date.now(), tz);
        } catch (err: any) {
          return { success: false, error: err.message ?? String(err) };
        }
      } else if (cmd.payload?.timezone !== undefined) {
        try {
          updates.next_run_at = computeNextRun(existing.cron_expression, Date.now(), cmd.payload.timezone);
        } catch (err: any) {
          return { success: false, error: err.message ?? String(err) };
        }
      }

      try {
        // Validate everything first; token and routine fields form one edit.
        const routine = store.transaction(() => {
          const updated = store.updateRoutine(cmd.targetId, updates);
          if (cmd.payload?.webhookEnabled === undefined && cmd.payload?.rotateWebhook !== true) return updated;
          const rotate = cmd.payload.rotateWebhook === true;
          const wantsToken = rotate || cmd.payload.webhookEnabled === true;
          const token = wantsToken ? (!rotate && existing.webhook_token) || randomBytes(24).toString('base64url') : null;
          return token === (existing.webhook_token ?? null) ? updated : store.setRoutineWebhookToken(cmd.targetId, token);
        });
        return { success: true, message: `Routine "${cmd.targetId}" updated.`, data: routine };
      } catch (err: any) {
        return { success: false, error: err.message ?? String(err) };
      }
    }
    if (cmd.command === 'delete_routine') {
      // Without this the store's exception escaped the handler and the operator saw a
      // delete button that did nothing at all, with no message to act on.
      try {
        const deleted = store.deleteRoutine(cmd.targetId);
        return {
          success: deleted,
          message: deleted ? `Routine "${cmd.targetId}" deleted.` : `Routine "${cmd.targetId}" not found.`,
        };
      } catch (err: any) {
        return { success: false, error: `Routine "${cmd.targetId}" could not be deleted: ${err?.message ?? String(err)}` };
      }
    }
    if (cmd.command === 'run_routine_now') {
      try {
        const { run, routine } = dispatchRoutine(cmd.targetId, 'manual');
        return {
          success: true,
          message: `Triggered run ${run.id} for routine "${routine.name}".`,
          data: { runId: run.id, taskRunId: run.id },
        };
      } catch (err: any) {
        return { success: false, error: String(err?.message ?? err) };
      }
    }
    return { success: false, error: `Command "${cmd.command}" not supported.` };
  });

  // The conversational surface. Same ledger as tasks, so a chat turn is
  // budgeted and audited exactly like any other dispatch.

  const chat = new ChatService({
    agenticChat: true,
    workRuntime, characterStore, capacity, providerRouter, memory, contractLookup: id => contracts.find(c => c.id === id),
    agentStore: store,
    ledger,
    llmClient: options.llmClient ?? new LiveLLMClient({ connections: providerConnections }),
    approvalGate,
    steerBus,
  });
  wsServer.setChatApi({
    listThreads: (agentId) => chat.listThreads(agentId),
    listThreadPreviews: (agentId) => store.listThreadPreviews(agentId),
    createThread: (agentId, title) => chat.createThread(agentId, title),
    getMessages: (threadId) => chat.getMessages(threadId),
    listTasks: () => contracts.map(({ id, name, description, requirements }) => ({ id, name, description, requirements })),
    requestProgress: (threadId, requestId) => chat.requestProgress(threadId, requestId),
    abortRequest: (threadId, requestId) => chat.abortRequest(threadId, requestId),
    steerRequest: (threadId, requestId, message) => chat.steerRequest(threadId, requestId, message),
    send: (threadId, message, requestId, taskId) => chat.send(threadId, message, requestId, taskId),
  });
  /** A bot's provider selection. Bots without a connection keep today's provider inference; none is migrated. */
  const connectionSelection = (modelId: string, connectionId: string | null, routingMode: 'pinned' | 'auto' | null | undefined) => {
    if (!connectionId) {
      if (routingMode) throw new ProviderSetupError('Routing modes apply only to a provider connection.');
      return { connection_id: null, routing_mode: null };
    }
    if (!providerConnections.get(connectionId)) throw new ProviderSetupError(`Provider connection "${connectionId}" does not exist.`);
    const mode = routingMode ?? 'pinned';
    if (mode === 'pinned' && isVirtualModel(modelId)) {
      throw new ProviderSetupError(`"${modelId}" is a routing alias. Choose automatic routing for it, or pick a concrete model to pin.`);
    }
    return { connection_id: connectionId, routing_mode: mode };
  };
  wsServer.setAgentApi({
    create: ({ id, name, modelId, fallbackModelId, systemPrompt, budgetCapUsd, connectionId, routingMode }) => store.createAgent({
      id,
      name,
      model_id: modelId,
      fallback_model_id: fallbackModelId ?? null,
      system_prompt: systemPrompt ?? null,
      budget_cap_usd: budgetCapUsd,
      current_status: 'IDLE',
      ...connectionSelection(modelId, connectionId ?? null, routingMode),
    }),
    update: (id, input) => {
      const current = store.getAgent(id);
      if (!current) throw new Error(`Agent "${id}" does not exist.`);
      const connectionChanged = input.connectionId !== undefined && input.connectionId !== (current.connection_id ?? null);
      const selectionTouched = input.connectionId !== undefined || input.routingMode !== undefined || (input.modelId !== undefined && !!current.connection_id);
      return store.updateAgent(id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.modelId !== undefined ? { model_id: input.modelId } : {}),
        ...(input.fallbackModelId !== undefined ? { fallback_model_id: input.fallbackModelId } : {}),
        ...(input.systemPrompt !== undefined ? { system_prompt: input.systemPrompt } : {}),
        ...(input.budgetCapUsd !== undefined ? { budget_cap_usd: input.budgetCapUsd } : {}),
        ...(selectionTouched ? connectionSelection(
          input.modelId ?? current.model_id,
          input.connectionId !== undefined ? input.connectionId : current.connection_id ?? null,
          // A newly chosen connection starts pinned unless automatic routing is chosen explicitly.
          input.routingMode !== undefined ? input.routingMode : connectionChanged ? undefined : current.routing_mode,
        ) : {}),
      });
    },
    remove: async (id) => {
      if (!store.getAgent(id)) return store.deleteAgent(id);
      store.assertAgentDeletable(id);
      return botDesktop.retireAgent(id, () => store.deleteAgent(id));
    },
  });
  // Settings → Providers. Reads report whether a key is stored, never the key.
  wsServer.setProviderApi({
    list: async () => ({ connections: providerConnections.list(), secretStorage: await providerConnections.availability(), environmentCredentials: ['OPENROUTER_API_KEY', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'].filter((name) => Boolean(process.env[name])), preset: localGateway ? { ...FREELLMAPI_PRESET, baseUrl: localGateway.status().baseUrl } : FREELLMAPI_PRESET, openrouterPreset: OPENROUTER_PRESET }),
    save: (body) => providerConnections.save(body),
    test: (id) => providerConnections.test(id),
    refreshModels: (id) => providerConnections.refreshModels(id),
    models: (id) => providerConnections.models(id),
    removeKey: (id) => providerConnections.removeKey(id),
    remove: (id) => providerConnections.remove(id),
    getGatewayStatus: (id) => providerConnections.getGatewayStatus(id),
    updateGatewayRouting: (id, payload) => providerConnections.updateGatewayRouting(id, payload),
  });

  // Plugins are MCP servers, and MCP servers live in the config file this
  // daemon booted from. Writing it is therefore the whole of "installing" one -
  // and the reason every write reports that a restart is required.
  wsServer.setPluginApi({
    list: () => {
      const configured = fileConfig ? listConfiguredPlugins(fileConfig.source) : [];
      const live = mcpRegistry.status();
      return configured.map((server) => {
        const status = live.find((entry) => entry.name === server.name);
        return {
          ...server,
          connected: status?.connected ?? false,
          tools: status?.tools ?? [],
          callsUsed: status?.callsUsed ?? 0,
          quota: status?.quota ?? server.callQuotaPerRun,
          error: status?.error,
        };
      });
    },
    reload: async () => ({plugins:await mcpRegistry.reload(listConfiguredPlugins(fileConfig?.source),configuredPluginPermissions(fileConfig?.source)),restartRequired:false}),
    install: async (input) => {
      const result=installPlugin(input,fileConfig?.source);
      try{await mcpRegistry.reload(listConfiguredPlugins(result.configPath),configuredPluginPermissions(result.configPath));return {...result,restartRequired:false};}
      catch(error){return {...result,error:error instanceof Error?error.message:String(error)};}
    },
    uninstall: async (name) => {
      const result=uninstallPlugin(name,fileConfig?.source);
      try{await mcpRegistry.reload(listConfiguredPlugins(result.configPath),configuredPluginPermissions(result.configPath));return {...result,restartRequired:false};}
      catch(error){return {...result,error:error instanceof Error?error.message:String(error)};}
    },
  });

  wsServer.setWebhookApi({
    resolve: (token) => {
      const routine = store.getRoutineByWebhookToken(token);
      return routine
        ? { routineId: routine.id, agentId: routine.agent_id, name: routine.name }
        : null;
    },
    fire: async (routineId) => {
      const { run } = dispatchRoutine(routineId, 'webhook');
      return { taskRunId: run.id };
    },
  });

  if (localGateway) {
    wsServer.setLocalGatewayApi({
      status: () => localGateway.status(),
      action: async (body) => {
        const input = (body ?? {}) as { action?: string; directory?: string | null; port?: number; autoStart?: boolean };
        // Starting can take a minute; the interface polls status instead of holding a request open.
        if (input.action === 'start') { void localGateway.start(); return localGateway.status(); }
        if (input.action === 'restart') { void localGateway.restart(); return localGateway.status(); }
        if (input.action === 'stop') return localGateway.stop();
        if (input.action === 'configure') {
          return localGateway.configure({
            ...(input.directory !== undefined ? { directory: input.directory } : {}),
            ...(input.port !== undefined ? { port: Number(input.port) } : {}),
            ...(input.autoStart !== undefined ? { autoStart: Boolean(input.autoStart) } : {}),
          });
        }
        throw new Error('Unknown action. Use start, stop, restart or configure.');
      },
    });
  }

  // Docker's status, for the interface and the desktop shell. Started, never
  // awaited: a cold WSL distro can take seconds to answer, and boot must not
  // wait on it.
  if (dockerMonitor) {
    wsServer.setDockerApi({ status: () => dockerMonitor.current(), refresh: () => dockerMonitor.refresh() });
    dockerMonitor.onChange((next, previous) => {
      if (next.state === 'running' && process.env.OPENHOURS_AUTO_SETUP === '1' && browser.status().enabled) browser.install();
      if (previous || next.state !== 'running') console.log(`[Docker] ${next.message}`);
      if (next.state !== 'running' || !sweepDeferred) return;
      sweepDeferred = false;
      // NOT forceAll. That is only safe before any task has run, and by the
      // time Docker comes up one may have. Containers left by a previous daemon
      // stopped when Docker did, so the exited-only sweep still reaches them.
      sandbox.orphanSweep({ forceAll: false })
        .then((swept) => console.log(`[Docker] Deferred sweep reaped ${swept.reapedContainers} containers.`))
        .catch((error) => {
          sweepDeferred = true;
          console.warn(`[Docker] Deferred sweep failed: ${String(error?.message ?? error).split('\n')[0]}`);
        });
    });
    dockerMonitor.start();
    cleanup.push(() => dockerMonitor.stop());
  }

  cleanup.push(() => chat.stop());
  cleanup.push(() => wsServer.close());
  cleanup.push(() => scheduler.stop());
  await wsServer.start();
  scheduler.start();

  console.log('================================================================');
  console.log('         DAEMON ACTIVE - READY TO SERVE WEBSOCKET & TASKS       ');
  console.log('================================================================');

  const shutdown = async () => {
    console.log('\n[Daemon] Initiating graceful shutdown...');
    await stopCharacterMaintenance();
    characterReviewService.stop();
    dockerMonitor?.stop();
    await localGateway?.stop();
    await scheduler.stop();
    await chat.stop();
    await browser.stop();
    await botDesktop?.stop();
    await activeWorkProducer.stop();
    // Deliberately NOT marking in-flight tasks as CRASHED here.
    // CRASHED means "the daemon died unexpectedly" and is the signal the boot
    // sweep uses. A graceful stop retires its tasks through the scheduler's
    // abort path; anything still RUNNING after a clean stop is a real bug and
    // should be caught by the NEXT boot sweep rather than disguised as routine.
    await mcpRegistry.stop();
    await wsServer.close();
    store.close();
    ledger.close();
    releaseProfile();
    console.log('[Daemon] Shutdown complete. Resources released.');
  };

  return {
    store,
    ledger,
    sandbox,
    wsServer,
    scheduler,
    providerRouter,
    providerConnections,
    approvalGate,
    chat,
    routineProducer,
    shutdown,
  };
  } catch (error) {
    for (const close of cleanup.reverse()) { try { await close(); } catch (cleanupError) { console.error('[Startup cleanup]', cleanupError); } }
    releaseProfile(); throw error;
  }
}

/**
 * Mock client that takes a bounded amount of time, so integration tests can
 * SIGKILL the daemon *during* an in-flight dispatch. Only reachable when
 * OPENHOURS_LLM_MODE=mock is set explicitly.
 */
class DelayedMockLLMClient extends MockLLMClient {
  constructor(private readonly delayMs: number) {
    super();
  }
  async generateCode(req: Parameters<MockLLMClient['generateCode']>[0]) {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return super.generateCode(req);
  }
}

// Direct execution entrypoint
if (process.argv[1]?.endsWith('index.js') && !process.env.DAEMON_TEST_MODE) {
  // Config precedence: environment variables override PROVISIONAL_CONFIG defaults.
  // Loud failure on malformed input - never silently fall back to a default.
  const envInt = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      console.error(`Fatal: ${name} must be numeric, received "${raw}".`);
      process.exit(1);
    }
    return n;
  };

  // Same discipline as envInt: an unrecognised executor is fatal, never a silent
  // downgrade to 'builtin'. Picking the wrong executor changes the security
  // posture (the OpenCode one runs a networked container), so it must be explicit.
  const resolveExecutorEnv = (): 'builtin' | 'opencode' | undefined => {
    const raw = process.env.OPENHOURS_EXECUTOR;
    if (raw === undefined || raw === '') return undefined;
    if (raw === 'builtin' || raw === 'opencode') return raw;
    console.error(`Fatal: OPENAGENTS_EXECUTOR must be "builtin" or "opencode", received "${raw}".`);
    process.exit(1);
  };

  // MockLLMClient is EXPLICIT-ONLY and is never reachable as a fallback.
  // It exists so integration tests can run a real daemon process without credentials.
  let llmClient: ILLMClient | undefined;
  const llmMode = process.env.OPENHOURS_LLM_MODE;
  if (llmMode === 'mock') {
    console.warn('****************************************************************');
    console.warn('  WARNING: OPENAGENTS_LLM_MODE=mock - MockLLMClient is active.');
    console.warn('  This daemon is NOT contacting a real model. Testing only.');
    console.warn('****************************************************************');
    const mockDelayMs = envInt('OPENHOURS_LLM_MOCK_DELAY_MS') ?? 0;
    llmClient = mockDelayMs > 0 ? new DelayedMockLLMClient(mockDelayMs) : new MockLLMClient();
  } else if (llmMode) {
    console.error(`Fatal: unsupported OPENAGENTS_LLM_MODE "${llmMode}" (only "mock" is recognized).`);
    process.exit(1);
  }

  // OPENHOURS_BACKLOG="cli-arg-parser,lru-cache-ttl" enqueues those tasks for
  // agent-alpha on a loop. Absent it, the daemon waits for operator-enqueued work.
  const backlogRaw = process.env.OPENHOURS_BACKLOG;
  let workProducer: IWorkProducer | undefined;
  if (backlogRaw) {
    const names = backlogRaw.split(',').map((n) => n.trim()).filter(Boolean);
    workProducer = new BacklogWorkProducer({
      backlog: names.map((taskName) => ({ agentId: 'agent-alpha', taskName })),
      mode: process.env.OPENHOURS_BACKLOG_MODE === 'once' ? 'once' : 'cycle',
      maxQueueDepth: envInt('OPENHOURS_MAX_QUEUE_DEPTH') ?? 1,
      knownTaskNames: STANDING_BENCHMARKS.map((b) => b.id),
    });
  }

  startDaemon({
    dbPath: process.env.OPENHOURS_DB_PATH,
    wsPort: envInt('OPENHOURS_PORT'),
    cadenceMs: envInt('OPENHOURS_CADENCE_MS'),
    maxConcurrency: envInt('OPENHOURS_MAX_CONCURRENCY'),
    llmClient,
    workProducer,
    mission: process.env.OPENHOURS_MISSION,
    // OPENHOURS_CONFIG names a config file; OPENHOURS_CONFIG="none" boots with
    // the built-in defaults and ignores any openhours.config.json in the
    // working directory.
    configPath:
      process.env.OPENHOURS_CONFIG === 'none' ? null : process.env.OPENHOURS_CONFIG || undefined,
    executor: resolveExecutorEnv(),
    // The app's daemon, or a person running it directly: FreeLLMAPI starts with it.
    startLocalGatewayWithApp: true,
  }).then(({ shutdown }) => {
    let stopping = false;
    const onSignal = async () => {
      if (stopping) return;
      stopping = true;
      await shutdown();
      process.exit(0);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    // THE SUPERVISOR IS WATCHED, NOT TRUSTED TO CLEAN UP.
    //
    // On Windows a child process outlives a parent that crashes or is ended in
    // Task Manager. A daemon left behind that way keeps the profile lock and
    // the port, so the next launch of the app cannot start its own and cannot
    // stop this one. The desktop shell passes its PID; when that process is
    // gone, this daemon shuts down gracefully by itself.
    const parentPid = envInt('OPENHOURS_PARENT_PID');
    if (parentPid) {
      const watch = setInterval(() => {
        try {
          process.kill(parentPid, 0);
        } catch (error: any) {
          // EPERM means it exists and belongs to someone else: still alive.
          if (error?.code === 'EPERM') return;
          clearInterval(watch);
          console.warn(`[Daemon] Supervisor process ${parentPid} has exited; shutting down.`);
          void onSignal();
        }
      }, 5000);
      watch.unref();
    }
  }).catch((err) => {
    console.error('Fatal Daemon Startup Error:', err);
    process.exit(1);
  });
}
