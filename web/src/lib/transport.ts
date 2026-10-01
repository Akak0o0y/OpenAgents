/**
 * Daemon transport.
 *
 * Two channels, deliberately kept distinct:
 *   - WebSocket: live events as they are committed (the daemon's existing
 *     contract, unchanged by Cortex).
 *   - HTTP: the A5 read API, for history, the taxonomy, and workspace files.
 *
 * The socket is the live edge; HTTP fills in everything that happened before
 * this browser connected.
 */

import type { LayerId } from '@kernel/kernel/agent-layers.js';
import type { DockerStatus } from './desktop.js';

export interface AgentRow {
  id: string;
  name: string;
  model_id: string;
  fallback_model_id?: string | null;
  system_prompt?: string | null;
  /** Present only for bots that chose a provider connection. */
  connection_id?: string | null;
  routing_mode?: 'pinned' | 'auto' | null;
  capabilities?: string[];
  current_status: 'IDLE' | 'BUSY' | 'PAUSED' | 'DISABLED';
  budget_cap_usd: number;
  created_at?: number;
  updated_at?: number;
}

export interface TaskRunRow {
  id: string;
  agent_id: string;
  task_name: string;
  model_id: string;
  error_message?: string | null;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABORTED' | 'CRASHED';
  turns_taken: number;
  actual_cost_usd: number;
  started_at: number | null;
  completed_at: number | null;
  /** The routine that scheduled this run, if any. */
  routine_id?: string | null;
  /** Routine run rows only (GET /api/routines/:id/runs): present when the run sent a post. */
  publish?: RunPublish;
  /** Set only when the model itself declared the block; the run is FAILED. */
  blocked?: true;
}

/** A run's posts as the runs API summarises them (spec 6.7, publishSummary). */
export interface RunPublish {
  state: 'confirmed' | 'confirmed-page' | 'rejected' | 'unconfirmed';
  /** Who sent the post that decided the state: model, operator or page (flow in Stage 2). */
  by: string;
  postUrl?: string;
  /** Set from any PUBLISH_REFUSED of the run. */
  heldBack: 'budget' | 'duplicate' | 'mismatch' | 'character' | 'internal' | null;
}

/** Something a run sent whose result was never confirmed (GET /api/system, spec 6.7). */
export interface PendingEffectRow {
  routineId: string;
  routineName: string;
  /** The routine was deleted: its items hold nothing and are only listed. */
  routineDeleted: boolean;
  runId: string;
  at: number;
  kind: 'action' | 'publish';
  /** Absent for an action on the bot's desktop. */
  origin?: string;
  /** The run started before this version first ran, so only its click was recorded. */
  before: boolean;
  /** The fixed "Not started: …" text the execute gate reports. */
  detail: string;
}

/** Whether a routine must post (GET /api/system, spec 6.8). */
export interface PublishPolicyRow {
  routineId: string;
  origin: string;
  required: boolean;
  source: 'history' | 'observed' | 'owner';
  evidenceRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EventRow {
  id?: number | null;
  task_run_id: string;
  agent_id: string;
  model_id?: string | null;
  event_type: string;
  turn_number?: number | null;
  payload_json: string;
  timestamp: number;
  layer?: LayerId | null;
}

export interface ChatThreadRow {
  id: string;
  agent_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface ChatThreadPreviewRow extends ChatThreadRow {
  last_message_role: 'user' | 'assistant' | null;
  last_message_preview: string | null;
  last_message_at: number | null;
}

export interface ChatMessageRow {
  id?: number;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string;
  model_id?: string | null;
  cost_usd?: number | null;
  task_run_id?: string | null;
  created_at: number;
}

export interface ApprovalRow {
  id: string;
  task_run_id: string;
  agent_id: string;
  kind: string;
  payload_json: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  reason?: string | null;
  created_at: number;
  decided_at?: number | null;
  /** False when the row is answerable but nothing in the daemon is waiting. */
  waiting: boolean;
}

export interface LayerRow {
  id: LayerId;
  name: string;
  status: 'live' | 'partial' | 'hollow';
  description: string;
  evidence: string;
  eventTypes: string[];
}

export interface RoutineRow {
  id: string;
  agent_id: string;
  /** Present only when a webhook trigger has been issued for this routine. */
  webhook_token?: string | null;
  name: string;
  cron_expression: string;
  human_schedule?: string | null;
  timezone: string;
  prompt_template: string;
  task_name?: string | null;
  enabled: number;
  catch_up_policy: 'skip' | 'run_once';
  schedule_enabled?: number;
  last_run_at?: number | null;
  next_run_at: number;
  last_run_status?: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentDataRow {
  id: string;
  agent_id: string;
  routine_id?: string | null;
  task_run_id?: string | null;
  key: string;
  category: string;
  data_json: string;
  created_at: number;
  updated_at: number;
}

export interface BrowserLiveState {
  desktop?: boolean;
  runId?: string;
  controlled?: boolean;
  login?: boolean;
  busy?: boolean;
  width?: number;
  height?: number;
  warning?: string;
  url?: string;
  title?: string;
  tabs?: Array<{ index: number; url: string }>;
  screenshot?: string;
  action?: string;
  target?: string;
  status?: 'navigating' | 'interacting' | 'ready' | 'closed';
  timestamp?: number;
}

/** In dev the Vite proxy rewrites /ws to the daemon root; in prod we ARE the daemon. */
function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = '/ws';
  return `${proto}//${location.host}${path}`;
}

export class ApiError extends Error {
  readonly code?: string;
  readonly currentVersion?: number;
  readonly issues?: string[];
  constructor(message: string, readonly status: number, details?: { code?: string; currentVersion?: number; issues?: string[] }) {
    super(message); this.name = 'ApiError'; this.code = details?.code; this.currentVersion = details?.currentVersion; this.issues = details?.issues;
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, signal ? { signal } : undefined);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Surface the daemon's own reason. It distinguishes "reaped", "no such run"
    // and "this daemon has no read API", and flattening those into a generic
    // failure is exactly what the API was written to avoid.
    const reason = body?.reason ?? body?.error ?? `HTTP ${res.status}`;
    throw new ApiError(reason, res.status, body);
  }
  return body as T;
}

export async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    // Surface the daemon's own reason and kind. A budget cap is not a server
    // error and must not be shown as one.
    throw new ApiError(parsed?.error ?? `HTTP ${res.status}`, res.status, parsed);
  }
  return parsed as T;
}

async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE' });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) throw new Error(parsed?.error ?? `HTTP ${res.status}`);
  return parsed as T;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) throw new Error(parsed?.error ?? `HTTP ${res.status}`);
  return parsed as T;
}

export interface PluginRow {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  callQuotaPerRun: number;
  allowedTools: string[];
  connectTimeoutMs: number;
  /** From the live MCP registry, not from the config file. */
  connected: boolean;
  tools: string[];
  callsUsed?: number;
  quota?: number;
  error?: string;
}

export interface PluginWriteResponse {
  server: { name: string };
  configPath: string;
  restartRequired: boolean;
}

export interface DeleteAgentResponse {
  deleted: boolean;
  taskRuns: number;
  routines: number;
  threads: number;
  messages: number;
  events: number;
  approvals: number;
  data: number;
}

export type SearchKind = 'bot' | 'message' | 'routine' | 'file' | 'link' | 'group' | 'action';

export interface SearchResultRow {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string;
  agentId?: string;
  threadId?: string;
  timestamp?: number;
}

export interface SearchResponseBody {
  query: string;
  results: SearchResultRow[];
  unsupported: Array<{ kind: SearchKind; reason: string }>;
  truncated: boolean;
}

export interface AgentUsageRow {
  agentId: string;
  name: string;
  budgetCapUsd: number;
  spentUsd: number;
  runCount: number;
  failedRunCount: number;
  lastRunAt: number | null;
  /** Gateway calls whose price is unknown; excluded from spentUsd rather than counted as zero. */
  unpricedCallCount?: number;
  unpricedTokens?: number;
}

/** Token counts as the provider reported them. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface UsageDay {
  date: string;
  models: Record<string, TokenTotals>;
  totals: TokenTotals;
}

/** One coding tool on this machine, read from the session logs it writes. */
export interface LocalProviderUsage {
  id: string;
  label: string;
  root: string;
  sessionCount: number;
  days: UsageDay[];
  totals: TokenTotals;
  models: Record<string, TokenTotals>;
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface LocalUsageBody {
  providers: LocalProviderUsage[];
  /** Tools whose usage cannot be read here, each with the reason. */
  unavailable: Array<{ id: string; label: string; reason: string }>;
  windowDays: number;
  scannedAt: number;
  bytesRead: number;
  truncated: boolean;
}

/** A gateway connection's pool, once per connection. Its price is unknown, so only admission counts are shown. */
export interface FreePoolModelInfo {
  id: string;
  displayName?: string;
  platform?: string;
  totalBudget?: number;
  totalUsed?: number;
  rpmLimit?: number;
  rpdLimit?: number;
  status?: string;
}

export interface ConnectionPoolUsageRow {
  connectionId: string;
  name: string;
  requestsLast24h: number;
  tokensLast24h: number;
  requestsPerDay: number;
  tokensPerDay: number;
  gatewayQuota: {
    available: boolean;
    reason?: string;
    totalBudget?: number;
    totalUsed?: number;
    models?: FreePoolModelInfo[];
  };
}

export interface UsageSummaryBody {
  agents: AgentUsageRow[];
  totalSpentUsd: number;
  totalBudgetCapUsd: number;
  totalRunCount: number;
  since: number | null;
  billing: { supported: false; reason: string };
  /** Absent from daemons that predate provider connections. */
  connections?: ConnectionPoolUsageRow[];
  /**
   * Null means the first scan has not finished, which is NOT the same as zero
   * usage - the interface has to say "still reading", not "nothing here".
   */
  local: LocalUsageBody | null;
}

export type RoutingMode = 'pinned' | 'auto';

export type ProviderConnectionStatus =
  | 'untested'
  | 'incomplete'
  | 'disabled'
  | 'connected'
  | 'unreachable'
  | 'invalid_credentials'
  | 'invalid_catalog'
  | 'no_usable_models'
  | 'exhausted';

export interface ProviderCatalogModel {
  id: string;
  /** Null when the gateway does not report whether this model can serve now. */
  usable: boolean | null;
  executionStatus: string | null;
  virtual: boolean;
  supportsTools: boolean | null;
  supportsVision: boolean | null;
  contextWindow: number | null;
}

/** Never contains a key: `hasKey` is all a settings read reveals. */
export interface ProviderConnectionRow {
  id: string;
  name: string;
  preset: 'freellmapi' | 'custom';
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
  status: ProviderConnectionStatus;
  statusMessage: string;
  checkedAt: number | null;
  catalog: { fetchedAt: number | null; models: ProviderCatalogModel[] };
  limits: { requestsPerDay: number; tokensPerDay: number };
  admissionUsed: { requestsLast24h: number; tokensLast24h: number };
  dashboardUrl: string;
  pinning: 'identity-checked-per-turn';
  usedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** Mirrors LocalGatewayStatus in src/daemon/local-gateway.ts. */
export interface LocalGatewayStatus {
  state: 'not-found' | 'stopped' | 'starting' | 'running' | 'failed';
  directory: string | null;
  detected: string | null;
  port: number;
  baseUrl: string;
  dashboardUrl: string;
  autoStart: boolean;
  message: string;
  pid: number | null;
  log: string[];
}

export interface ProvidersBody {
  connections: ProviderConnectionRow[];
  /** Names (never values) of provider keys the daemon has from its environment. */
  environmentCredentials?: string[];
  secretStorage: { available: boolean; backend: string; reason?: string };
  preset: { preset: 'freellmapi'; name: string; baseUrl: string };
  openrouterPreset?: { preset: 'custom'; name: string; baseUrl: string };
}

export interface ProviderSaveInput {
  id?: string;
  name: string;
  preset: 'freellmapi' | 'custom';
  baseUrl: string;
  enabled: boolean;
  /** Write-only; omit to keep the stored key. */
  apiKey?: string;
  limits?: { requestsPerDay?: number; tokensPerDay?: number };
}


export interface GatewayRoutingWeights {
  reliability: number;
  speed: number;
  intelligence: number;
}

export interface GatewayStatus {
  connectionId: string;
  name: string;
  upstream: {
    providers: Array<{ platform: string; name: string; status: string; keys: number }>;
    counts: { healthy: number; rate_limited: number; invalid: number; unknown: number };
  };
  routing: {
    strategy: string;
    weights: GatewayRoutingWeights;
    presets: Record<string, GatewayRoutingWeights>;
    exploreEnabled: boolean;
    keySelectionStrategy: string;
    peakAdjusted: boolean;
    peakHoursAdjust: boolean;
    cooldownCeilingMs: number | null;
  } | null;
  tokenUsage?: {
    totalBudget: number;
    totalUsed: number;
    models?: FreePoolModelInfo[];
  } | null;
}

export interface GatewayRoutingInput {
  strategy?: string;
  weights?: Partial<GatewayRoutingWeights>;
  exploreEnabled?: boolean;
  cooldownCeilingMs?: number | null;
  peakHoursAdjust?: boolean;
}

export const api = {
  createAgent: (body: { id: string; name: string; modelId: string; fallbackModelId?: string | null; systemPrompt?: string; budgetCapUsd: number; connectionId?: string | null; routingMode?: RoutingMode | null }) =>
    postJson<{ agent: AgentRow }>('/api/agents', body),

  updateAgent: (id: string, body: { name?: string; modelId?: string; fallbackModelId?: string | null; systemPrompt?: string; budgetCapUsd?: number; connectionId?: string | null; routingMode?: RoutingMode | null }) =>
    patchJson<{ agent: AgentRow }>(`/api/agents/${encodeURIComponent(id)}`, body),

  /** Settings, Providers. Keys are write-only: no response contains one and none is kept in browser storage. */
  providers: () => getJson<ProvidersBody>('/api/providers'),
  saveProvider: (body: ProviderSaveInput) => postJson<{ connection: ProviderConnectionRow }>('/api/providers', body),
  testProvider: (id: string) => postJson<{ connection: ProviderConnectionRow }>(`/api/providers/${encodeURIComponent(id)}/test`, {}),
  refreshProviderModels: (id: string) =>
    postJson<{ connection: ProviderConnectionRow }>(`/api/providers/${encodeURIComponent(id)}/refresh-models`, {}),
  removeProviderKey: (id: string) => deleteJson<{ connection: ProviderConnectionRow }>(`/api/providers/${encodeURIComponent(id)}/key`),
  getGatewayStatus: (id: string) => getJson<GatewayStatus>(`/api/providers/${encodeURIComponent(id)}/gateway`),
  updateGatewayRouting: (id: string, body: GatewayRoutingInput) =>
    postJson<any>(`/api/providers/${encodeURIComponent(id)}/gateway-routing`, body),
  removeProvider: (id: string) => deleteJson<{ removed: boolean }>(`/api/providers/${encodeURIComponent(id)}`),

  /**
   * Delete a bot and everything belonging to it.
   *
   * The daemon answers 409 while a run is QUEUED or RUNNING, and that reason is
   * surfaced verbatim - "wait for the run to finish" and "the daemon broke" need
   * very different responses from the operator.
   */
  deleteAgent: (id: string) =>
    deleteJson<DeleteAgentResponse>(`/api/agents/${encodeURIComponent(id)}`),

  plugins: () => getJson<{ plugins: PluginRow[] }>('/api/plugins'),
  reloadPlugins: () => postJson('/api/plugins/reload', {}),

  installPlugin: (body: { name: string; command: string; args?: string[]; env?: Record<string, string> }) =>
    postJson<PluginWriteResponse>('/api/plugins', body),

  uninstallPlugin: (name: string) =>
    deleteJson<PluginWriteResponse>(`/api/plugins/${encodeURIComponent(name)}`),

  layers: () => getJson<{ layers: LayerRow[] }>('/api/layers'),

  chatThreads: (agentId?: string) =>
    getJson<{ threads: ChatThreadRow[] }>(
      `/api/chat/threads${agentId ? `?agent=${encodeURIComponent(agentId)}` : ''}`
    ),

  /**
   * Threads with each one's last message, for the sidebar snippet. One request
   * for the whole fleet rather than one transcript fetch per bot.
   */
  chatThreadPreviews: (agentId?: string) => {
    const params = new URLSearchParams({ preview: '1' });
    if (agentId) params.set('agent', agentId);
    return getJson<{ threads: ChatThreadPreviewRow[]; previews: boolean }>(
      `/api/chat/threads?${params.toString()}`
    );
  },

  createThread: (agentId: string, title?: string) =>
    postJson<{ thread: ChatThreadRow }>('/api/chat/threads', { agentId, title }),

  chatMessages: (threadId: string) =>
    getJson<{ messages: ChatMessageRow[] }>(
      `/api/chat/threads/${encodeURIComponent(threadId)}/messages`
    ),

  workTasks: () => getJson<{ tasks: Array<{ id: string; name: string; description: string; requirements: string[] }> }>('/api/chat/tasks'),
  cancelChat: (threadId: string, requestId: string) => postJson<{ stopped: boolean }>(`/api/chat/threads/${encodeURIComponent(threadId)}/requests/${encodeURIComponent(requestId)}/cancel`, {}),
  chatProgress: (threadId: string, requestId: string) => getJson<{ progress: { taskRunId: string; turn: number; tool: string | null; steps: string[]; todos?: Array<{ id?: string; text: string; status: 'pending' | 'in_progress' | 'completed' }> } | null }>(`/api/chat/threads/${encodeURIComponent(threadId)}/requests/${encodeURIComponent(requestId)}`),
  steerChat: (threadId: string, requestId: string, message: string) => postJson<{ success: boolean; message?: string }>(`/api/chat/threads/${encodeURIComponent(threadId)}/requests/${encodeURIComponent(requestId)}/steer`, { message }),

  sendChat: (threadId: string, message: string, requestId?: string, taskId?: string) =>
    postJson<{ reply: ChatMessageRow; taskRunId: string }>(
      `/api/chat/threads/${encodeURIComponent(threadId)}/messages`,
      { message, requestId, taskId }
    ),

  approvals: (runId?: string) =>
    getJson<{ approvals: ApprovalRow[]; pending: number; orphaned: number }>(
      `/api/approvals${runId ? `?run=${encodeURIComponent(runId)}` : ''}`
    ),

  mcp: () =>
    getJson<{
      servers: Array<{ name: string; connected: boolean; tools: string[]; callsUsed: number; quota: number; error?: string }>;
      configured: number;
      connected: number;
    }>('/api/mcp'),

  state: () => getJson<{ agents: AgentRow[]; taskRuns: TaskRunRow[]; serverTime: number }>('/api/state'),

  runEvents: (runId: string, since?: number) =>
    getJson<{ runId: string; events: EventRow[]; latestEventId: number | null }>(
      `/api/runs/${encodeURIComponent(runId)}/events${since !== undefined ? `?since=${since}` : ''}`
    ),

  stepCounts: (runIds: string[]): Promise<Record<string, number>> => {
    if (!runIds.length) return Promise.resolve({});
    const params = new URLSearchParams({ ids: runIds.join(',') });
    return getJson<{ stepCounts: Record<string, number> }>(`/api/runs/step-counts?${params.toString()}`)
      .then((r) => r.stepCounts ?? {})
      .catch(() => ({}));
  },

  workspace: (runId: string) =>
    getJson<{ available: true; files: string[] } | { available: false; required: false; reason: string }>(
      `/api/runs/${encodeURIComponent(runId)}/workspace`
    ),

  workspaceFile: (runId: string, file: string) =>
    getJson<{ available: true; content: string; truncated: boolean }>(
      `/api/runs/${encodeURIComponent(runId)}/workspace?file=${encodeURIComponent(file)}`
    ),

  saveWorkspaceFile: (runId: string, file: string, content: string, expectedContent: string) =>
    postJson<{ success: boolean; runId: string; file: string; reason?: string }>(
      `/api/runs/${encodeURIComponent(runId)}/workspace?file=${encodeURIComponent(file)}`,
      { content, expectedContent }
    ),

  /**
   * Cross-content search. Run on the daemon, not in the browser: the client
   * holds only the conversation it has opened, so a local filter would report
   * "no results" for messages that exist.
   */
  search: (query: string, kinds?: SearchKind[], limit?: number, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q: query });
    if (kinds?.length) params.set('kinds', kinds.join(','));
    if (limit !== undefined) params.set('limit', String(limit));
    return getJson<SearchResponseBody>(`/api/search?${params.toString()}`, signal);
  },

  usage: () => getJson<UsageSummaryBody>('/api/usage'),

  health: () => getJson<{ status: string; service: string; port: number; buildId?: string }>('/health'),

  /** Docker as the daemon's monitor last saw it; null before its first check. */
  docker: () => getJson<{ docker: DockerStatus | null }>('/api/docker'),
  /** Check Docker again now rather than at the monitor's next poll. */
  dockerRefresh: () => postJson<{ docker: DockerStatus }>('/api/docker', {}),

  /** The FreeLLMAPI gateway OpenAgents runs for this installation. */
  localGateway: () => getJson<{ gateway: LocalGatewayStatus }>('/api/local-gateway'),
  localGatewayAction: (body: { action: 'start' | 'stop' | 'restart' | 'configure'; directory?: string | null; port?: number; autoStart?: boolean }) =>
    postJson<{ gateway: LocalGatewayStatus }>('/api/local-gateway', body),

  routines: (agentId?: string) =>
    getJson<{ routines: RoutineRow[] }>(
      `/api/routines${agentId ? `?agent=${encodeURIComponent(agentId)}` : ''}`
    ),

  botSystem: (agentId: string) => getJson<{
    missions: Array<{ id: string; objective: string; status: string; runs: number; max_runs: number; reason: string; last_run_id: string | null }>;
    memory: Array<{key: string; text: string; origin: string; task_run_id: string | null}>;
    vault: {configured: boolean; path?: string | null; source?: 'app' | 'config' | null}; capacity: {used: number; limit: number}; research?: Record<string, unknown>;
    browser?: { enabled: boolean; ready: boolean; installing: boolean; error: string | null; active: number; limit: number; sessions: Array<{agentId: string; runId: string; url: string; login?: boolean}>; persistenceErrors?: Record<string, string>;
      desktop?: { state: 'stopped' | 'starting' | 'ready' | 'error'; message: string };
      desktopSetup?: { state: 'stopped' | 'starting' | 'ready' | 'error'; message: string };
      /** How freely the bot uses forms and buttons: ask on every site, only where no account is saved, or never. */
      autonomy?: 'ask' | 'accounts' | 'always';
      /** Where the bot's browser runs: a Docker sandbox, or this computer until the sandbox is ready. */
      isolation?: 'sandbox' | 'computer';
      sandbox?: { state: 'idle' | 'preparing' | 'downloading' | 'starting' | 'ready' | 'error'; message: string; image: string } | null;
      /** Sites and labels only; account details never leave the daemon. */
      connections?: Array<{ site: string; verified: boolean; updatedAt: number }>;
      accounts?: Array<{ id: string; site: string; label: string; updatedAt: number }> };
    /** Unconfirmed items of this bot's routines, then of its deleted routines. */
    pendingEffects?: PendingEffectRow[];
    /** Must-post rows of this bot's routines. */
    publishPolicies?: PublishPolicyRow[];
  }>(`/api/system?agent=${encodeURIComponent(agentId)}`),
  systemAction: (action: string, body: unknown) => postJson<any>(`/api/system/${encodeURIComponent(action)}`, body),

  workResult: (id: string) => getJson<{ result: { report: string; outcome: string } }>(`/api/runs/${encodeURIComponent(id)}/result`),

  routineRuns: (routineId: string) =>
    getJson<{ runs: TaskRunRow[] }>(
      `/api/routines/${encodeURIComponent(routineId)}/runs`
    ),

  agentData: (agentId?: string, category?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agent', agentId);
    if (category) params.set('category', category);
    const qs = params.toString();
    return getJson<{ data: AgentDataRow[] }>(`/api/data${qs ? `?${qs}` : ''}`);
  },

  setAgentData: (body: { agentId: string; key: string; category?: string; data: unknown }) =>
    postJson<{ record: AgentDataRow }>('/api/data', body),

  deleteAgentData: (id: string) =>
    deleteJson<{ deleted: boolean }>(`/api/data/${encodeURIComponent(id)}`),

  browserState: (agentOrRunId: string) =>
    getJson<{ available: boolean; state: BrowserLiveState | null }>(
      `/api/agents/${encodeURIComponent(agentOrRunId)}/browser/state`
    ).catch(() => ({ available: false, state: null })),

  browserScreenUrl: (agentOrRunId: string) =>
    `/api/agents/${encodeURIComponent(agentOrRunId)}/browser/screen`,
};

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface AttemptSnapshot {
  attemptId: string;
  revision: number;
  text: string;
  reasoning?: string;
}

export type RunLiveFrame =
  | { type: 'RUN_LIVE'; runId: string; kind: 'snapshot'; calls: { callId: string; tail: string; seq: number; bytes: number }[]; attempts?: AttemptSnapshot[] }
  | { type: 'RUN_LIVE'; runId: string; kind: 'output'; callId: string; stream: 'stdout' | 'stderr'; seq: number; data: string; truncated?: boolean }
  | { type: 'RUN_LIVE'; runId: string; kind: 'attempt'; attemptId: string; revision: number; phase: 'start' | 'end'; outcome?: 'committed' | 'abandoned' }
  | { type: 'RUN_LIVE'; runId: string; kind: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: any }
  | { type: 'RUN_LIVE'; runId: string; kind?: undefined; callId?: string; attempt?: number; stream?: 'stdout' | 'stderr'; chunk?: string; tail?: string; exitCode?: number | null; closed?: boolean };

export interface SocketHandlers {
  onHello: (payload: { agents: AgentRow[]; taskRuns: TaskRunRow[]; executor?: string | null; routines?: RoutineRow[] }) => void;
  onEvent: (event: EventRow) => void;
  onLive?: (frame: RunLiveFrame) => void;
  onState: (state: ConnectionState) => void;
}

const subscribedRunIds = new Set<string>();
const liveListeners = new Set<(frame: RunLiveFrame) => void>();
let activeSocket: WebSocket | null = null;

export function onLive(listener: (frame: RunLiveFrame) => void): () => void {
  liveListeners.add(listener);
  return () => {
    liveListeners.delete(listener);
  };
}

export function subscribeRuns(runIds: string[]): void {
  for (const id of runIds) {
    if (id) subscribedRunIds.add(id);
  }
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN && runIds.length > 0) {
    activeSocket.send(JSON.stringify({ type: 'subscribe', runIds: runIds.filter(Boolean) }));
  }
}

export function unsubscribeRuns(runIds: string[]): void {
  for (const id of runIds) {
    subscribedRunIds.delete(id);
  }
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN && runIds.length > 0) {
    activeSocket.send(JSON.stringify({ type: 'unsubscribe', runIds: runIds.filter(Boolean) }));
  }
}

/**
 * Connect, and keep reconnecting.
 *
 * A daemon restart must not leave the panel silently frozen showing stale rings,
 * so the connection state is reported to the UI rather than swallowed.
 */
export function connect(handlers: SocketHandlers): () => void {
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let backoffMs = 500;

  const open = () => {
    if (closed) return;
    handlers.onState('connecting');
    socket = new WebSocket(socketUrl());

    socket.onopen = () => {
      activeSocket = socket;
      backoffMs = 500;
      handlers.onState('open');
      if (subscribedRunIds.size > 0) {
        socket?.send(JSON.stringify({ type: 'subscribe', runIds: Array.from(subscribedRunIds) }));
      }
    };

    socket.onmessage = (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.data as string);
      } catch {
        return; // a frame we cannot parse is not a frame we should act on
      }
      if (msg.type === 'SYSTEM_HELLO') handlers.onHello(msg.payload ?? { agents: [], taskRuns: [] });
      else if (msg.type === 'EXECUTION_EVENT' && msg.event) handlers.onEvent(msg.event);
      else if (msg.type === 'RUN_LIVE') {
        handlers.onLive?.(msg as RunLiveFrame);
        for (const listener of liveListeners) {
          listener(msg as RunLiveFrame);
        }
      }
    };

    socket.onclose = () => {
      if (activeSocket === socket) activeSocket = null;
      handlers.onState('closed');
      if (closed) return;
      retry = setTimeout(open, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10_000);
    };

    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    closed = true;
    if (activeSocket === socket) activeSocket = null;
    if (retry) clearTimeout(retry);
    socket?.close();
  };
}

export function sendCommand(
  command:
    | 'pause'
    | 'resume'
    | 'kill'
    | 'approve'
    | 'deny'
    | 'steer'
    | 'create_routine'
    | 'update_routine'
    | 'delete_routine'
    | 'run_routine_now',
  targetId: string,
  payload?: Record<string, unknown>
): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl());
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Command timed out'));
    }, 10_000);

    ws.onopen = () => ws.send(JSON.stringify({ command, targetId, payload }));
    ws.onmessage = (raw) => {
      const msg = JSON.parse(raw.data as string);
      if (msg.type === 'COMMAND_RESULT') {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Command socket failed'));
    };
  });
}
