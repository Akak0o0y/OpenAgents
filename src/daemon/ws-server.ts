import { CONNECT_HTML, CONNECT_JS } from './connect-page.js';
import { desktopHttp, desktopUpgrade, type DesktopAccess } from './desktop-viewer.js';
import { buildIdentity } from './build-identity.js';
/**
 * Daemon WebSocket Server (Port 4001)
 * Two-way real-time communication plus the Cortex read API:
 * 1. Outbound: Event stream pushing ExecutionEvents to connected frontends.
 * 2. Inbound: Command channel for operator control (pause / resume / kill / approve).
 * 3. HTTP GET: /health, /api/state, /api/layers, /api/runs/:id/events,
 *    /api/runs/:id/workspace - see handleReadApi().
 *
 * Invariant: Emits the exact same event objects persisted to SQLite.
 * This module is a transport only. It is handed a DaemonReadApi rather than
 * reaching into SQLite or Docker itself.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { DockerStatus } from './docker-status.js';

export interface DaemonDockerApi {
  status(): DockerStatus | null;
  refresh(): Promise<DockerStatus>;
}

export interface DaemonLocalGatewayApi {
  status(): unknown;
  action(body: unknown): Promise<unknown>;
}
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { API_VERSION, SESSION_COOKIE, hasCredentials, secretMatches } from './local-auth.js';
import { fileURLToPath } from 'node:url';
import type {
  ExecutionEventRecord,
  RoutineRecord,
  AgentDataRecord,
  TaskRunRecord,
} from './db/schema.js';
import { PROVISIONAL_CONFIG } from './config.js';
import { CONSOLE_HTML } from './console-page.js';
import { AGENT_LAYERS } from '../kernel/agent-layers.js';
import { SEARCH_KINDS, MAX_SEARCH_LIMIT, type SearchKind, type SearchResponse } from './search.js';
import type { UsageSummary } from './usage.js';
import type { RunLiveFrame, LiveChannel } from './live-stream.js';
import type { RunPublishSummary } from './external-effects.js';

// Implemented operator commands.
// 'approve' / 'deny' resolve an approval by id; 'steer' injects a message into a
// running builtin task at its next turn boundary. Approvals live in their own
// table rather than as an AWAITING_APPROVAL task status - SQLite cannot alter a
// CHECK constraint in place, and a blocked run genuinely is still RUNNING.
export type CommandType =
  | 'pause'
  | 'resume'
  | 'kill'
  | 'approve'
  | 'deny'
  | 'steer'
  | 'create_routine'
  | 'update_routine'
  | 'delete_routine'
  | 'run_routine_now';

export interface WsCommand {
  command: CommandType;
  /** agent_id, task_run_id, or approval id depending on the command. */
  targetId: string;
  payload?: any;
}

export interface WsCommandResult {
  success: boolean;
  command: CommandType;
  targetId: string;
  message?: string;
  error?: string;
  data?: any;
}

/**
 * The conversational surface. Separate from DaemonReadApi because these MUTATE:
 * sending a message spends money, so it must never be reachable by a caller that
 * only asked for read access.
 */
export interface DaemonChatApi {
  listThreads(agentId?: string): unknown[];
  /**
   * Threads with each one's last message. Optional so an older host stays
   * compatible; the route says plainly when it is absent instead of returning
   * threads with silently missing previews.
   */
  listThreadPreviews?(agentId?: string): unknown[];
  createThread(agentId: string, title?: string): unknown;
  getMessages(threadId: string): unknown[];
  listTasks?(): unknown[];
  requestProgress?(threadId: string, requestId: string): unknown;
  abortRequest?(threadId: string, requestId: string): boolean;
  steerRequest?(threadId: string, requestId: string, message: string): { success: boolean; message?: string; error?: string };
  send(threadId: string, message: string, requestId?: string, taskId?: string): Promise<unknown>;
}

/**
 * Settings → Providers. Responses never contain gateway keys: a connection reports only whether one is stored.
 * Errors may carry an HTTP `status`.
 */
export interface DaemonProviderApi {
  list(): Promise<unknown>;
  save(body: unknown): Promise<unknown>;
  test(id: string): Promise<unknown>;
  refreshModels(id: string): Promise<unknown>;
  models(id: string): Promise<unknown>;
  removeKey(id: string): unknown;
  remove(id: string): { removed: boolean };
  getGatewayStatus?(id: string): Promise<unknown>;
  updateGatewayRouting?(id: string, payload: unknown): Promise<unknown>;
}

/** Agent administration is kept separate from the read API because it mutates durable fleet state. */
export interface DaemonAgentApi {
  create(input: {
    id: string;
    name: string;
    modelId: string;
    fallbackModelId?: string | null;
    systemPrompt?: string | null;
    budgetCapUsd: number;
    connectionId?: string | null;
    routingMode?: 'pinned' | 'auto' | null;
  }): unknown;
  update(id: string, input: {
    name?: string;
    modelId?: string;
    fallbackModelId?: string | null;
    systemPrompt?: string | null;
    budgetCapUsd?: number;
    connectionId?: string | null;
    routingMode?: 'pinned' | 'auto' | null;
  }): unknown;
  /**
   * Delete a bot and everything belonging to it. Optional so a host can decline
   * to offer deletion at all; the route then answers 501 rather than pretending
   * the bot is gone.
   */
  remove?(id: string): { deleted: boolean; [key: string]: unknown } | Promise<{ deleted: boolean; [key: string]: unknown }>;
}

/**
 * Plugin (MCP server) administration. Separate from the read API because it
 * WRITES THE CONFIG FILE the daemon boots from.
 */
export interface DaemonPluginApi {
  reload?(): Promise<unknown>;
  list(): unknown[];
  install(input: unknown): unknown;
  uninstall(name: string): unknown;
}

/** Firing a routine out of band, from a webhook. */
export interface DaemonWebhookApi {
  /** Resolve a token to a routine id, or null when the token matches nothing. */
  resolve(token: string): { routineId: string; agentId: string; name: string } | null;
  /** Enqueue a run. Returns the created run id. */
  fire(routineId: string, source: string): Promise<{ taskRunId: string }>;
}

export type CommandHandler = (cmd: WsCommand) => Promise<{ success: boolean; message?: string; error?: string; data?: any }>;

/**
 * Read-side data the HTTP API serves. Injected rather than imported so this
 * module stays a transport: it knows how to answer a request, not how to reach
 * SQLite or Docker.
 */
export interface DaemonReadApi {
  desktopAccess?: DesktopAccess;
  desktopObserve?: DesktopAccess;
  browserRuntime?: string;
  desktopOnRevoke?: (agentId: string, close: () => void) => () => void;
  system?(method: string, url: URL, body: unknown, context?: { signal?: AbortSignal }): Promise<{ status: number; body: unknown }>;
  workResult?(runId: string): unknown;
  artifacts?(runId: string): unknown[];
  artifact?(runId: string, id: string): { path: string; content: string; sha256: string; encoding?: string } | null;
  browserScreenshot?(id: string): Buffer | null;
  browserState?(id: string): unknown;
  /** Layer-tagged events for one run, optionally only those after an event id. */
  getRunEvents(taskRunId: string, sinceEventId?: number): ExecutionEventRecord[];
  /**
   * Files in a run's live workspace. A finished run has had its volume reaped,
   * so `available: false` with a reason is the correct answer - an empty file
   * list would be indistinguishable from a task that produced nothing.
   */
  getRunWorkspace(taskRunId: string): Promise<
    { available: true; files: string[] } | { available: false; required?: false; reason: string }
  >;
  /** One file's text out of a run's live workspace. */
  readRunFile(taskRunId: string, file: string): Promise<
    { available: true; content: string; truncated: boolean } | { available: false; reason: string }
  >;
  /** Save the operator's retained text copy after the run finishes. */
  writeRunFile?(taskRunId: string, file: string, content: string, expectedContent: string): Promise<{ success: boolean; reason?: string }>;
  /**
   * Configured MCP servers and whether each is actually connected. The galaxy
   * draws a solid beam only for a server this returns as connected, so an
   * unreachable server cannot look wired up.
   */
  /** Approvals, newest last. `waiting` is false for a row nothing can answer. */
  approvals(taskRunId?: string): Array<{
    id: string;
    task_run_id: string;
    agent_id: string;
    kind: string;
    payload_json: string;
    status: string;
    reason?: string | null;
    created_at: number;
    decided_at?: number | null;
    waiting: boolean;
  }>;
  mcpStatus(): Array<{
    name: string;
    connected: boolean;
    tools: string[];
    callsUsed: number;
    quota: number;
    error?: string;
  }>;
  routines?(agentId?: string): RoutineRecord[];
  routine?(id: string): RoutineRecord | null;
  /**
   * A routine's runs, newest first. `publish` summarises the posts a run sent (absent
   * when it sent none); `blocked` is set only when the model itself declared the block.
   */
  routineRuns?(routineId: string): Array<TaskRunRecord & { publish?: RunPublishSummary; blocked?: true }>;
  /**
   * Cross-content search over durable data. Optional because a daemon can be
   * constructed without one; the route answers 501 rather than an empty list,
   * so "nothing matched" is never confused with "search is not wired up".
   */
  search?(options: { query: string; kinds?: SearchKind[]; limit?: number }): SearchResponse;
  /** Reconciled spend per agent. Optional for the same reason as `search`. */
  usage?(): Promise<UsageSummary> | UsageSummary;
  stepCounts?(runIds: string[]): Record<string, number>;
  agentData?(agentId?: string, category?: string): AgentDataRecord[];
  getAgentDataRecord?(agentId: string, key: string, category?: string): AgentDataRecord | null;
  setAgentDataRecord?(params: {
    agentId: string;
    key: string;
    category?: string;
    data: unknown;
  }): AgentDataRecord;
  deleteAgentDataRecord?(id: string): boolean;
}

/**
 * Locate web/dist relative to this compiled module.
 *
 * Compiled output lives at dist/src/daemon/, so the repo root is three levels
 * up. Returning null when it is absent is deliberate: the daemon must run
 * perfectly well with no UI built.
 */
function resolveCortexBundle(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, '../../../web/dist');
    return fs.existsSync(path.join(candidate, 'index.html')) ? candidate : null;
  } catch {
    return null;
  }
}

export class DaemonWsServer {
  readonly authToken: string;
  private readonly allowedOrigins: Set<string>;
  private readonly profileId: string;
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  private port: number;
  private commandHandlers: CommandHandler[] = [];
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private statusProvider?: () => { agents?: any[]; taskRuns?: any[]; routines?: any[]; executor?: string | null };
  private readApi?: DaemonReadApi;
  /** Absolute path to the built Cortex bundle, or null if it was not found. */
  private staticRoot: string | null;
  private chatApi?: DaemonChatApi;
  private agentApi?: DaemonAgentApi;
  private pluginApi?: DaemonPluginApi;
  private webhookApi?: DaemonWebhookApi;
  private dockerApi?: DaemonDockerApi;
  private localGatewayApi?: DaemonLocalGatewayApi;
  private liveChannel?: LiveChannel;
  private subscribers = new Map<WebSocket, Set<string>>();
  get boundPort(): number { return this.port; }

  constructor(
    port: number = PROVISIONAL_CONFIG.WS_PORT,
    statusProvider?: () => { agents?: any[]; taskRuns?: any[]; routines?: any[]; executor?: string | null },
    readApi?: DaemonReadApi,
    security: { token?: string; allowedOrigins?: string[]; profileId?: string } = {}
  ) {
    this.port = port;
    this.statusProvider = statusProvider;
    this.readApi = readApi;
    this.staticRoot = resolveCortexBundle();
    this.authToken = security.token ?? randomBytes(32).toString('hex');
    this.profileId = security.profileId ?? 'embedded';
    this.allowedOrigins = new Set(security.allowedOrigins ?? []);
  }

  private isTrustedRequest(req: IncomingMessage): boolean {
    const host = req.headers.host;
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!host || !hosts.includes(host)) return false;
    const origin = req.headers.origin;
    if (origin && !hosts.map(h => `http://${h}`).includes(origin) && !this.allowedOrigins.has(origin)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site' && (!origin || !this.allowedOrigins.has(origin))) return false;
    return true;
  }

  /** Wire the conversational surface. Absent means chat answers 501. */
  setChatApi(api: DaemonChatApi | undefined): void {
    this.chatApi = api;
  }

  /** Wire durable fleet creation and editing. Absent means the routes answer 501. */
  setAgentApi(api: DaemonAgentApi | undefined): void {
    this.agentApi = api;
  }

  /** Wire plugin (MCP server) administration. Absent means the routes answer 501. */
  setPluginApi(api: DaemonPluginApi | undefined): void {
    this.pluginApi = api;
  }

  /** Wire webhook routine firing. Absent means the route answers 501. */
  setWebhookApi(api: DaemonWebhookApi | undefined): void {
    this.webhookApi = api;
  }

  /** Wire Docker status. Absent means /api/docker answers 501. */
  setDockerApi(api: DaemonDockerApi | undefined): void {
    this.dockerApi = api;
  }

  /** Wire the FreeLLMAPI supervisor. Absent means /api/local-gateway answers 501. */
  setLocalGatewayApi(api: DaemonLocalGatewayApi | undefined): void {
    this.localGatewayApi = api;
  }

  setLiveChannel(channel: LiveChannel | undefined): void {
    this.liveChannel = channel;
  }

  sendToSubscribers(runId: string, frame: RunLiveFrame): void {
    const msg = JSON.stringify(frame);
    for (const [ws, set] of this.subscribers.entries()) {
      if (set.has(runId) && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
        } catch {
          // Socket write failed
        }
      }
    }
  }

  /**
   * Register a handler for inbound operator commands.
   */
  onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  /**
   * Start the HTTP and WebSocket server.
   */
  async start(): Promise<void> {
    if (this.wss) return;

    this.httpServer = createServer((req, res) => {
      if (!this.isTrustedRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Untrusted local request.' }));
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.url === '/api/session' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
        req.on('end', () => {
          let token: string | undefined;
          try { token = JSON.parse(body).token; } catch { /* refused below */ }
          if (!secretMatches(token, this.authToken)) { res.writeHead(401); res.end(); return; }
          res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${this.authToken}; HttpOnly; SameSite=Strict; Path=/`);
          res.writeHead(204); res.end();
        });
        return;
      }
      if (req.method === 'GET' && (req.url === '/connect' || req.url === '/connect.js')) {
        res.writeHead(200, { 'Content-Type': req.url === '/connect' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
        res.end(req.url === '/connect' ? CONNECT_HTML : CONNECT_JS); return;
      }
      if (req.method === 'GET' && ['/', '/legacy', '/console'].includes(req.url ?? '') && !hasCredentials(req, this.authToken)) {
        res.writeHead(302, { Location: '/connect' }); res.end(); return;
      }
      const webhook = req.url?.startsWith('/api/webhooks/routines/');
      if ((req.url?.startsWith('/api/') || req.url === '/health') && !webhook && !hasCredentials(req, this.authToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Connect this application to the local daemon before using the API.' }));
        return;
      }
      if (req.url?.startsWith('/api/desktop/') && this.readApi?.desktopAccess) {
        desktopHttp(req, res, this.readApi.desktopAccess, this.readApi.desktopObserve); return;
      }
      // Basic HTTP health probe on port 4001
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'HEALTHY', service: 'openhours-daemon', port: this.port, profileId: this.profileId, apiVersion: API_VERSION, browserRuntime: this.readApi?.browserRuntime, buildId: buildIdentity() }));
        return;
      }

      // Snapshot endpoint. The console polls this to reconcile after commands;
      // the Next.js control plane will consume the same contract.
      if (req.url === '/api/state') {
        const snapshot: any = this.statusProvider ? this.statusProvider() : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          serverTime: Date.now(),
          port: this.port,
          agents: snapshot.agents ?? [],
          taskRuns: snapshot.taskRuns ?? [],
          executor: snapshot.executor ?? null,
        }));
        return;
      }

      // The original hand-written console stays reachable. It is the fallback
      // when web/ has not been built, and it is what /legacy always serves.
      if (req.url === '/legacy' || req.url === '/console') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(CONSOLE_HTML);
        return;
      }

      // Cortex, if it has been built. `serveStatic` returns false when the
      // bundle is absent, and the request falls through to the old console
      // rather than to a blank page.
      if (req.method === 'GET' && this.serveStatic(req.url ?? '/', res)) {
        return;
      }

      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(CONSOLE_HTML);
        return;
      }

      // Cortex read API. Async because the workspace routes talk to Docker; the
      // rejection path answers 500 rather than taking the daemon down with an
      // unhandled rejection.
      if (req.url && req.url.startsWith('/api/plugins')) {
        this.handlePluginApi(req, res).catch((err: any) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          }
        });
        return;
      }

      if (req.url && req.url.startsWith('/api/webhooks/')) {
        this.handleWebhookApi(req, res).catch((err: any) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          }
        });
        return;
      }

      if (req.url && req.url.startsWith('/api/providers')) {
        this.handleProviderApi(req, res).catch((err: any) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          }
        });
        return;
      }

      if (req.url && req.url.startsWith('/api/agents')) {
        this.handleAgentApi(req, res).catch((err: any) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          }
        });
        return;
      }

      if (req.url && req.url.startsWith('/api/chat')) {
        this.handleChatApi(req, res).catch((err: any) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          }
        });
        return;
      }

      if (req.url && req.url.startsWith('/api/')) {
        this.handleReadApi(req, res).catch((err: any) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.httpServer.on('upgrade', (req, socket, head) => {
      const desktop = req.url?.startsWith('/api/desktop/') && this.readApi?.desktopAccess;
      const trusted = this.isTrustedRequest(req) && (req.url === '/ws' || !!desktop);
      // Browser sockets require an exact Origin. Non-browser callers use explicit bearer authentication.
      const authenticated = hasCredentials(req, this.authToken) && (!!req.headers.origin || !!req.headers.authorization);
      if (!trusted || !authenticated) {
        socket.end(`HTTP/1.1 ${trusted ? '401 Unauthorized' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`);
        return;
      }
      if (desktop) { desktopUpgrade(req, socket, head, desktop, this.readApi?.desktopOnRevoke); return; }
      this.wss!.handleUpgrade(req, socket, head, ws => this.wss!.emit('connection', ws, req));
    });

    this.wss.on('connection', (ws: WebSocket) => {
      (ws as any).isAlive = true;

      ws.on('pong', () => {
        (ws as any).isAlive = true;
      });

      // Send initial handshake with state snapshot
      const currentStatus = this.statusProvider ? this.statusProvider() : {};
      ws.send(JSON.stringify({
        type: 'SYSTEM_HELLO',
        payload: {
          serverTime: Date.now(),
          port: this.port,
          clientCount: this.wss?.clients.size ?? 1,
          agents: currentStatus.agents ?? [],
          taskRuns: currentStatus.taskRuns ?? [],
          routines: currentStatus.routines ?? [],
          executor: currentStatus.executor ?? null,
        },
      }));

      ws.on('close', () => {
        this.subscribers.delete(ws);
      });

      // Listen for operator commands
      ws.on('message', async (data: string | Buffer) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'subscribe' || parsed.type === 'unsubscribe') {
            const runIds: string[] = Array.isArray(parsed.runIds) ? parsed.runIds : [];
            let subs = this.subscribers.get(ws);
            if (!subs) {
              subs = new Set<string>();
              this.subscribers.set(ws, subs);
            }
            if (parsed.type === 'subscribe') {
              for (const id of runIds) {
                subs.add(id);
                if (this.liveChannel) {
                  const snapshot = this.liveChannel.getSnapshot(id);
                  if ((snapshot.calls.length > 0 || snapshot.attempts.length > 0) && ws.readyState === WebSocket.OPEN) {
                    const frame: RunLiveFrame = {
                      type: 'RUN_LIVE',
                      runId: id,
                      kind: 'snapshot',
                      calls: snapshot.calls,
                      attempts: snapshot.attempts,
                    };
                    ws.send(JSON.stringify(frame));
                  }
                }
              }
            } else {
              for (const id of runIds) subs.delete(id);
            }
            return;
          }
          if (!parsed.command || !parsed.targetId) {
            ws.send(JSON.stringify({
              type: 'COMMAND_ERROR',
              error: 'Invalid command payload: missing "command" or "targetId".',
            }));
            return;
          }

          const cmd: WsCommand = {
            command: parsed.command,
            targetId: parsed.targetId,
            payload: parsed.payload,
          };

          let handled = false;
          for (const handler of this.commandHandlers) {
            try {
              const res = await handler(cmd);
              ws.send(JSON.stringify({
                type: 'COMMAND_RESULT',
                result: {
                  success: res.success,
                  command: cmd.command,
                  targetId: cmd.targetId,
                  message: res.message,
                  error: res.error,
                  data: res.data,
                } as WsCommandResult,
              }));
              handled = true;
              break;
            } catch (err: any) {
              ws.send(JSON.stringify({
                type: 'COMMAND_RESULT',
                result: {
                  success: false,
                  command: cmd.command,
                  targetId: cmd.targetId,
                  error: err.message ?? String(err),
                } as WsCommandResult,
              }));
              handled = true;
              break;
            }
          }

          if (!handled) {
            ws.send(JSON.stringify({
              type: 'COMMAND_ERROR',
              error: `No handler registered for command "${cmd.command}".`,
            }));
          }
        } catch (err: any) {
          ws.send(JSON.stringify({
            type: 'PARSE_ERROR',
            error: `Failed to parse message: ${err.message}`,
          }));
        }
      });
    });

    // Heartbeat check every 15s to prune dead sockets
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return;
      for (const ws of this.wss.clients) {
        if ((ws as any).isAlive === false) {
          ws.terminate();
          continue;
        }
        (ws as any).isAlive = false;
        ws.ping();
      }
    }, 15_000);

    return new Promise((resolve, reject) => {
      this.httpServer!.listen(this.port, '127.0.0.1', () => {
        const address = this.httpServer!.address();
        if (address && typeof address !== 'string') this.port = address.port;
        resolve();
      });
      this.httpServer!.on('error', reject);
    });
  }

  /**
   * Serve the built Cortex bundle from web/dist.
   *
   * Returns false - never a 404 - when the bundle is missing, so a daemon
   * running without a UI build degrades to the original console instead of to
   * an empty page. Paths are resolved and then checked to be inside the bundle
   * root, so a crafted URL cannot read the rest of the disk.
   */
  private serveStatic(rawUrl: string, res: ServerResponse): boolean {
    const root = this.staticRoot;
    if (!root || !fs.existsSync(root)) return false;

    let pathname: string;
    try { pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname); } catch { return false; }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(root, relative);

    // Deliberately NO catch-all index.html fallback. Serving the app for an
    // unknown path would make /nope answer 200, and this daemon's contract is
    // that an unknown route 404s. Cortex is a single page with tabs, not a
    // client-side router, so it needs no deep-link rescue.
    if (!filePath.startsWith(root + path.sep) && filePath !== root) return false;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;

    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, {
      'Content-Type': types[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(fs.readFileSync(filePath));
    return true;
  }

  /** Read a JSON request body, with a size cap so a socket cannot exhaust memory. */
  private async readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<any> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes.`);
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch (err: any) {
      throw new Error(`Request body is not valid JSON: ${err?.message ?? err}`);
    }
  }

  private providerApi?: DaemonProviderApi;

  /** Parses optional provider connection fields. Existence and alias rules are checked by the agent API. */
  private connectionSelection(body: any): { connectionId?: string | null; routingMode?: 'pinned' | 'auto' | null } | { error: string } {
    const selection: { connectionId?: string | null; routingMode?: 'pinned' | 'auto' | null; fallbackModelId?: string | null } = {};
    if (body?.connectionId !== undefined) {
      if (body.connectionId !== null && (typeof body.connectionId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(body.connectionId))) {
        return { error: 'connectionId must be a provider connection ID or null.' };
      }
      selection.connectionId = body.connectionId;
    }
    if (body?.routingMode !== undefined) {
      if (body.routingMode !== null && body.routingMode !== 'pinned' && body.routingMode !== 'auto') {
        return { error: "routingMode must be 'pinned', 'auto' or null." };
      }
      selection.routingMode = body.routingMode;
    }
    if (body?.fallbackModelId !== undefined) {
      if (body.fallbackModelId !== null && (typeof body.fallbackModelId !== 'string' || body.fallbackModelId.length > 200)) {
        return { error: 'fallbackModelId must be a string up to 200 characters or null.' };
      }
      selection.fallbackModelId = body.fallbackModelId;
    }
    return selection;
  }

  /** Wire Settings → Providers. Absent means the routes answer 501. */
  setProviderApi(api: DaemonProviderApi | undefined): void {
    this.providerApi = api;
  }

  private async handleProviderApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const api = this.providerApi;
    if (!api) {
      json(501, { error: 'This daemon was started without provider connection support.' });
      return;
    }
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').slice(3);
    let id = '', action = '';
    try {
      [id = '', action = ''] = parts.map(decodeURIComponent);
    } catch {
      json(400, { error: 'Malformed provider route.' });
      return;
    }
    try {
      if (parts.length === 0 && method === 'GET') return json(200, await api.list());
      if (parts.length === 0 && method === 'POST') {
        let body: unknown;
        try { body = await this.readJsonBody(req, 16 * 1024); } catch (err: any) { json(400, { error: String(err?.message ?? err) }); return; }
        return json(200, { connection: await api.save(body) });
      }
      if (parts.length === 1 && id && method === 'DELETE') {
        const result = api.remove(id);
        return json(result.removed ? 200 : 404, result.removed ? result : { error: `No such provider connection: ${id}` });
      }
      if (parts.length === 2 && id && method === 'POST' && action === 'test') return json(200, { connection: await api.test(id) });
      if (parts.length === 2 && id && method === 'POST' && action === 'refresh-models') return json(200, { connection: await api.refreshModels(id) });
      if (parts.length === 2 && id && method === 'GET' && action === 'models') return json(200, { connection: await api.models(id) });
      if (parts.length === 2 && id && method === 'DELETE' && action === 'key') return json(200, { connection: api.removeKey(id) });
      if (parts.length === 2 && id && method === 'GET' && action === 'gateway') {
        if (!api.getGatewayStatus) return json(501, { error: 'Gateway status not supported.' });
        return json(200, await api.getGatewayStatus(id));
      }
      if (parts.length === 2 && id && method === 'POST' && action === 'gateway-routing') {
        if (!api.updateGatewayRouting) return json(501, { error: 'Gateway routing update not supported.' });
        const body = await this.readJsonBody(req, 16 * 1024);
        return json(200, await api.updateGatewayRouting(id, body));
      }
      json(404, { error: 'Unknown provider route.' });
    } catch (err: any) {
      // Validation messages name fields, never submitted values, so a rejected key is not echoed back.
      if (err?.name === 'ZodError') {
        json(400, { error: `Invalid provider connection settings: ${(err.issues ?? []).map((issue: any) => `${(issue.path ?? []).join('.') || 'body'} ${issue.message}`).join('; ')}` });
      } else {
        json(Number.isInteger(err?.status) ? err.status : 500, { error: String(err?.message ?? err) });
      }
    }
  }

  private async handleAgentApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!this.agentApi) {
      json(501, { error: 'This daemon was started without agent administration support.' });
      return;
    }

    const method = req.method ?? 'GET';
    const match = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (url.pathname === '/api/agents' && method === 'POST') {
      const body = await this.readJsonBody(req);
      const id = typeof body?.id === 'string' ? body.id.trim() : '';
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const modelId = typeof body?.modelId === 'string' ? body.modelId.trim() : '';
      const budgetCapUsd = Number(body?.budgetCapUsd ?? 10);
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
        json(400, { error: 'id must be 2-64 lowercase letters, numbers, or hyphens.' });
        return;
      }
      if (!name || name.length > 80 || !modelId || modelId.length > 200) {
        json(400, { error: 'name (1-80 characters) and modelId (1-200 characters) are required.' });
        return;
      }
      if (!Number.isFinite(budgetCapUsd) || budgetCapUsd <= 0) {
        json(400, { error: 'budgetCapUsd must be a positive number.' });
        return;
      }
      const selection = this.connectionSelection(body);
      if ('error' in selection) {
        json(400, { error: selection.error });
        return;
      }
      try {
        json(201, { agent: this.agentApi.create({ id, name, modelId, systemPrompt: body.systemPrompt, budgetCapUsd, ...selection }) });
      } catch (err: any) {
        json(Number.isInteger(err?.status) ? err.status : 409, { error: String(err?.message ?? err) });
      }
      return;
    }

    if (match && method === 'PATCH') {
      const body = await this.readJsonBody(req);
      const budgetCapUsd = body?.budgetCapUsd === undefined ? undefined : Number(body.budgetCapUsd);
      if (body?.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80)) {
        json(400, { error: 'name must contain 1-80 characters.' });
        return;
      }
      if (body?.modelId !== undefined && (typeof body.modelId !== 'string' || !body.modelId.trim() || body.modelId.trim().length > 200)) {
        json(400, { error: 'modelId must contain 1-200 characters.' });
        return;
      }
      if (budgetCapUsd !== undefined && (!Number.isFinite(budgetCapUsd) || budgetCapUsd <= 0)) {
        json(400, { error: 'budgetCapUsd must be a positive number.' });
        return;
      }
      const selection = this.connectionSelection(body);
      if ('error' in selection) {
        json(400, { error: selection.error });
        return;
      }
      try {
        json(200, { agent: this.agentApi.update(decodeURIComponent(match[1]), {
          name: body.name?.trim(),
          modelId: body.modelId?.trim(),
          systemPrompt: body.systemPrompt,
          budgetCapUsd,
          ...selection,
        }) });
      } catch (err: any) {
        json(Number.isInteger(err?.status) ? err.status : 404, { error: String(err?.message ?? err) });
      }
      return;
    }

    if (match && method === 'DELETE') {
      if (!this.agentApi.remove) {
        json(501, { error: 'This daemon was started without bot deletion support.' });
        return;
      }
      const id = decodeURIComponent(match[1]);
      try {
        const result = await this.agentApi.remove(id);
        json(result.deleted ? 200 : 404, result.deleted ? result : { error: `No such bot: ${id}` });
      } catch (err: any) {
        // A refusal because work is in flight is a conflict, not a server
        // error: the caller can retry once the run finishes.
        json(409, { error: String(err?.message ?? err) });
      }
      return;
    }

    json(405, { error: `${method} not allowed on ${url.pathname}` });
  }

  /**
   * Plugins: the MCP servers this daemon boots from its config file.
   *
   *   GET    /api/plugins        configured servers
   *   POST   /api/plugins        add one   { name, command, args, env?, ... }
   *   DELETE /api/plugins/:name  remove one
   *
   * Every write reports restartRequired, because this edits the config file and
   * does not start a process.
   */
  private async handlePluginApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const method = req.method ?? 'GET';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!this.pluginApi) {
      json(501, { error: 'This daemon was started without plugin administration support.' });
      return;
    }

    const statusFor = (kind: string) =>
      kind === 'NOT_FOUND' ? 404 : kind === 'CONFLICT' || kind === 'IN_USE' ? 409 : kind === 'NO_CONFIG' ? 412 : 400;

    if (url.pathname === '/api/plugins') {
      if (method === 'GET') {
        json(200, { plugins: this.pluginApi.list() });
        return;
      }
      if (method === 'POST') {
        const body = await this.readJsonBody(req);
        try {
          json(201, await this.pluginApi.install(body));
        } catch (err: any) {
          json(statusFor(err?.kind), { error: String(err?.message ?? err), kind: err?.kind ?? 'INVALID' });
        }
        return;
      }
      json(405, { error: `${method} not allowed on ${url.pathname}` });
      return;
    }

    const nameMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)$/);
    if(url.pathname==='/api/plugins/reload' && method==='POST'){
      try {if(!this.pluginApi.reload)throw new Error('Hot reload is unavailable.');json(200,await this.pluginApi.reload());}
      catch(err:any){json(409,{error:String(err?.message??err)});}return;
    }
    if (nameMatch && method === 'DELETE') {
      try {
        json(200, await this.pluginApi.uninstall(decodeURIComponent(nameMatch[1])));
      } catch (err: any) {
        json(statusFor(err?.kind), { error: String(err?.message ?? err), kind: err?.kind ?? 'INVALID' });
      }
      return;
    }

    json(404, { error: `No such endpoint: ${url.pathname}` });
  }

  /**
   * Fire a routine from an external system.
   *
   *   POST /api/webhooks/routines/:token
   *
   * The token IS the credential, so it is compared in constant time and a
   * mismatch answers exactly like an unknown token - a webhook endpoint that
   * distinguishes "wrong token" from "no such routine" leaks which tokens are
   * live. GET is refused: a link preview or a crawler must not be able to run
   * somebody's routine by fetching a URL.
   */
  private async handleWebhookApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const method = req.method ?? 'GET';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const match = url.pathname.match(/^\/api\/webhooks\/routines\/([^/]+)$/);
    if (!match) {
      json(404, { error: `No such endpoint: ${url.pathname}` });
      return;
    }

    if (method !== 'POST') {
      json(405, { error: 'Webhook triggers accept POST only.' });
      return;
    }

    if (!this.webhookApi) {
      json(501, { error: 'This daemon was started without webhook trigger support.' });
      return;
    }

    const token = decodeURIComponent(match[1]);
    const routine = this.webhookApi.resolve(token);
    if (!routine) {
      json(404, { error: 'Unknown or revoked webhook token.' });
      return;
    }

    // Read and discard the body: senders post payloads and a server that never
    // drains the stream can leave them waiting.
    await this.readJsonBody(req).catch(() => ({}));

    try {
      const { taskRunId } = await this.webhookApi.fire(routine.routineId, 'webhook');
      json(202, { accepted: true, routineId: routine.routineId, taskRunId });
    } catch (err: any) {
      json(409, { error: String(err?.message ?? err) });
    }
  }

  /**
   * The conversational surface.
   *
   *   GET  /api/chat/threads[?agent=id]        list conversations
   *   POST /api/chat/threads                   { agentId, title? }
   *   GET  /api/chat/threads/:id/messages      full transcript
   *   POST /api/chat/threads/:id/messages      { message } -> the reply
   *
   * POST /messages SPENDS MONEY, which is why chat is a separate interface from
   * the read API rather than another route on it.
   */
  private async handleChatApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!this.chatApi) {
      // Not an empty list: "no threads" and "this daemon cannot chat" are
      // different facts and the UI must be able to tell them apart.
      json(501, { error: 'This daemon was started without a chat service.' });
      return;
    }

    const method = req.method ?? 'GET';

    if (url.pathname === '/api/chat/tasks') {
      if (method !== 'GET') { json(405, { error: 'Use GET.' }); return; }
      if (!this.chatApi.listTasks) { json(501, { error: 'Verified work is unavailable.' }); return; }
      json(200, { tasks: this.chatApi.listTasks() }); return;
    }
    const progress = url.pathname.match(/^\/api\/chat\/threads\/([^/]+)\/requests\/([^/]+)$/);
    if (progress) {
      if (method !== 'GET') { json(405, { error: 'Use GET.' }); return; }
      json(200, { progress: this.chatApi.requestProgress?.(decodeURIComponent(progress[1]), decodeURIComponent(progress[2])) ?? null }); return;
    }
    const cancel = url.pathname.match(/^\/api\/chat\/threads\/([^/]+)\/requests\/([^/]+)\/cancel$/);
    if (cancel) {
      if (method !== 'POST') { json(405, { error: 'Use POST.' }); return; }
      const stopped = this.chatApi.abortRequest?.(decodeURIComponent(cancel[1]), decodeURIComponent(cancel[2]));
      json(stopped ? 200 : 409, stopped ? { stopped: true } : { error: 'Request is not currently running.' }); return;
    }
    const steer = url.pathname.match(/^\/api\/chat\/threads\/([^/]+)\/requests\/([^/]+)\/steer$/);
    if (steer) {
      if (method !== 'POST') { json(405, { error: 'Use POST.' }); return; }
      const body = await this.readJsonBody(req);
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!message) { json(400, { error: 'Message is required.' }); return; }
      if (!this.chatApi.steerRequest) { json(501, { error: 'Steering is not supported on this daemon.' }); return; }
      const result = this.chatApi.steerRequest(decodeURIComponent(steer[1]), decodeURIComponent(steer[2]), message);
      json(result.success ? 200 : 409, result); return;
    }

    if (url.pathname === '/api/chat/threads') {
      if (method === 'GET') {
        const agent = url.searchParams.get('agent') ?? undefined;
        // ?preview=1 asks for each thread's last message, which is what the
        // sidebar needs to show a snippet for every bot without one request
        // per conversation.
        if (url.searchParams.get('preview') === '1') {
          if (!this.chatApi.listThreadPreviews) {
            json(501, { error: 'This daemon was started without thread-preview support.' });
            return;
          }
          json(200, { threads: this.chatApi.listThreadPreviews(agent), previews: true });
          return;
        }
        json(200, { threads: this.chatApi.listThreads(agent), previews: false });
        return;
      }
      if (method === 'POST') {
        const body = await this.readJsonBody(req);
        if (!body?.agentId) {
          json(400, { error: 'agentId is required: a conversation belongs to a specific bot.' });
          return;
        }
        try {
          json(201, { thread: this.chatApi.createThread(String(body.agentId), body.title) });
        } catch (err: any) {
          json(404, { error: String(err?.message ?? err) });
        }
        return;
      }
      json(405, { error: `${method} not allowed on ${url.pathname}` });
      return;
    }

    const match = url.pathname.match(/^\/api\/chat\/threads\/([^/]+)\/messages$/);
    if (!match) {
      json(404, { error: `No such endpoint: ${url.pathname}` });
      return;
    }
    const threadId = decodeURIComponent(match[1]);

    if (method === 'GET') {
      try {
        json(200, { threadId, messages: this.chatApi.getMessages(threadId) });
      } catch (err: any) {
        json(404, { error: String(err?.message ?? err) });
      }
      return;
    }

    if (method === 'POST') {
      const body = await this.readJsonBody(req);
      const message = typeof body?.message === 'string' ? body.message : '';
      try {
        if (body.requestId !== undefined && typeof body.requestId !== 'string') throw Object.assign(new Error('Invalid request ID.'), { kind: 'INVALID' });
        if (body.taskId !== undefined && typeof body.taskId !== 'string') throw Object.assign(new Error('Invalid task ID.'), { kind: 'INVALID' });
        json(200, await this.chatApi.send(threadId, message, body.requestId, body.taskId));
      } catch (err: any) {
        // Map the failure to a status the UI can act on. A budget cap is not a
        // server error and must not be presented as one.
        const kind = err?.kind;
        const status =
          kind === 'NOT_FOUND' ? 404 : kind === 'INVALID' ? 400 : kind === 'BUDGET' ? 402 : kind === 'RATE_LIMIT' ? 429 : 502;
        json(status, { error: String(err?.message ?? err), kind: kind ?? 'PROVIDER' });
      }
      return;
    }

    json(405, { error: `${method} not allowed on ${url.pathname}` });
  }

  /**
   * Serve the Cortex read endpoints.
   *
   *   GET /api/layers                       - the ECC taxonomy and each layer's status
   *   GET /api/runs/:id/events?since=<id>   - layer-tagged events for one run
   *   GET /api/runs/:id/workspace           - files in the run's LIVE workspace
   *   GET /api/runs/:id/workspace?file=path - one file's text
   *
   * /api/state is handled earlier and deliberately left untouched: the existing
   * console polls it and the WS contract must not regress.
   */
  private async handleReadApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const method = req.method ?? 'GET';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // Docker's status. GET is the monitor's last answer; POST checks again now,
    // for a "Check again" button that should not wait for the next poll.
    if (url.pathname === '/api/docker') {
      if (!this.dockerApi) { json(501, { error: 'This daemon does not monitor Docker.' }); return; }
      if (method === 'POST') { json(200, { docker: await this.dockerApi.refresh() }); return; }
      if (method !== 'GET') { json(405, { error: `${method} not allowed on ${url.pathname}` }); return; }
      json(200, { docker: this.dockerApi.status() }); return;
    }

    // The FreeLLMAPI gateway OpenAgents runs. GET is its status; POST starts,
    // stops, restarts or configures it.
    if (url.pathname === '/api/local-gateway') {
      if (!this.localGatewayApi) { json(501, { error: 'This daemon does not manage a local gateway.' }); return; }
      if (method === 'GET') { json(200, { gateway: this.localGatewayApi.status() }); return; }
      if (method !== 'POST') { json(405, { error: `${method} not allowed on ${url.pathname}` }); return; }
      let body: unknown;
      try { body = await this.readJsonBody(req); } catch { json(400, { error: 'Invalid or oversized JSON body.' }); return; }
      try { json(200, { gateway: await this.localGatewayApi.action(body) }); }
      catch (error) { json(400, { error: String((error as Error)?.message ?? error) }); }
      return;
    }

    if (url.pathname.startsWith('/api/system')) {
      if (!this.readApi?.system) { json(501, { error: 'System features are unavailable.' }); return; }
      let body: unknown;
      try { body = method === 'POST' ? await this.readJsonBody(req, url.pathname === '/api/system/attachment-upload' ? 3 * 1024 * 1024 : 256 * 1024) : undefined; }
      catch { json(400, { error: 'Invalid or oversized JSON body.' }); return; }
      const ac = new AbortController();
      let completed = false;
      const onClose = () => {
        if (!completed) {
          ac.abort();
        }
      };
      res.on('close', onClose);
      try {
        const result = await this.readApi.system(method, url, body, { signal: ac.signal });
        completed = true;
        json(result.status, result.body);
        return;
      } finally {
        completed = true;
        res.off('close', onClose);
      }
    }

    // The taxonomy is static and needs no injected reader, so it answers even
    // when the daemon was constructed without a read API (as tests do).
    if (url.pathname === '/api/layers') {
      json(200, { layers: AGENT_LAYERS });
      return;
    }

    if (url.pathname === '/api/approvals') {
      if (!this.readApi) {
        json(501, { error: 'This daemon was started without a read API.' });
        return;
      }
      const runId = url.searchParams.get('run') ?? undefined;
      const approvals = this.readApi.approvals(runId);
      json(200, {
        approvals,
        // A PENDING row whose waiter died with a previous daemon is answerable in
        // the database but connected to nothing. Counting only live waiters stops
        // the UI offering a button that would do nothing.
        pending: approvals.filter((a) => a.status === 'PENDING' && a.waiting).length,
        orphaned: approvals.filter((a) => a.status === 'PENDING' && !a.waiting).length,
      });
      return;
    }

    if (url.pathname === '/api/mcp') {
      if (!this.readApi) {
        json(501, { error: 'This daemon was started without a read API.' });
        return;
      }
      const servers = this.readApi.mcpStatus();
      json(200, {
        servers,
        // Stated explicitly so a caller never has to infer "none configured"
        // from an empty array, which could equally mean "failed to load".
        configured: servers.length,
        connected: servers.filter((s) => s.connected).length,
      });
      return;
    }

    if (url.pathname === '/api/search') {
      if (!this.readApi?.search) {
        json(501, { error: 'This daemon was started without search support.' });
        return;
      }
      const query = url.searchParams.get('q') ?? '';
      if (query.length > 200) {
        json(400, { error: 'q must be 200 characters or fewer.' });
        return;
      }
      const kindsRaw = url.searchParams.get('kinds');
      let kinds: SearchKind[] | undefined;
      if (kindsRaw !== null && kindsRaw.trim() !== '') {
        const parts = kindsRaw.split(',').map((k) => k.trim()).filter(Boolean);
        const invalid = parts.filter((k) => !SEARCH_KINDS.includes(k as SearchKind));
        if (invalid.length > 0) {
          json(400, {
            error: `Unknown search kind(s): ${invalid.join(', ')}. Valid kinds: ${SEARCH_KINDS.join(', ')}.`,
          });
          return;
        }
        kinds = parts as SearchKind[];
      }
      const limitRaw = url.searchParams.get('limit');
      let limit: number | undefined;
      if (limitRaw !== null) {
        // Number('') is 0, which would silently mean "no results" instead of
        // being reported as malformed input.
        limit = limitRaw.trim() === '' ? NaN : Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
          json(400, { error: `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.` });
          return;
        }
      }
      json(200, this.readApi.search({ query, kinds, limit }));
      return;
    }

    if (url.pathname === '/api/usage') {
      if (!this.readApi?.usage) {
        json(501, { error: 'This daemon was started without usage reporting.' });
        return;
      }
      json(200, await this.readApi.usage());
      return;
    }

    if (url.pathname === '/api/routines') {
      if (!this.readApi?.routines) {
        json(501, { error: 'This daemon was started without routine support.' });
        return;
      }
      const agentId = url.searchParams.get('agent') ?? undefined;
      json(200, { routines: this.readApi.routines(agentId) });
      return;
    }

    const routineRunsMatch = url.pathname.match(/^\/api\/routines\/([^/]+)\/runs$/);
    if (routineRunsMatch) {
      if (!this.readApi?.routineRuns) {
        json(501, { error: 'This daemon was started without routine support.' });
        return;
      }
      const routineId = decodeURIComponent(routineRunsMatch[1]);
      json(200, { routineId, runs: this.readApi.routineRuns(routineId) });
      return;
    }

    if (url.pathname === '/api/data') {
      if (method === 'GET') {
        if (!this.readApi?.agentData) {
          json(501, { error: 'This daemon was started without agent data support.' });
          return;
        }
        const agentId = url.searchParams.get('agent') ?? undefined;
        const category = url.searchParams.get('category') ?? undefined;
        json(200, { data: this.readApi.agentData(agentId, category) });
        return;
      }
      if (method === 'POST') {
        if (!this.readApi?.setAgentDataRecord) {
          json(501, { error: 'This daemon was started without agent data support.' });
          return;
        }
        const body = await this.readJsonBody(req);
        if (typeof body?.agentId !== 'string' || body.agentId.trim() === '') {
          json(400, { error: 'agentId is required and must be a non-empty string.' });
          return;
        }
        if (typeof body?.key !== 'string' || body.key.trim() === '' || body.key.length > 200) {
          json(400, { error: 'key is required and must be 1-200 characters.' });
          return;
        }
        if (body.category !== undefined && (typeof body.category !== 'string' || body.category.length > 64)) {
          json(400, { error: 'category must be a string of 64 characters or fewer.' });
          return;
        }
        if (body.data === undefined) {
          json(400, { error: 'data is required. Send null explicitly to store an empty value.' });
          return;
        }
        // The store serialises `data` into a TEXT column. A payload that cannot
        // be serialised, or one large enough to bloat the row, is rejected here
        // rather than surfacing later as an opaque SQLite failure.
        let serialised: string;
        try {
          serialised = JSON.stringify(body.data);
        } catch (err: any) {
          json(400, { error: `data must be JSON-serialisable: ${String(err?.message ?? err)}` });
          return;
        }
        if (serialised === undefined) {
          json(400, { error: 'data must be JSON-serialisable.' });
          return;
        }
        if (serialised.length > 128 * 1024) {
          json(400, { error: 'data exceeds the 128KB per-record limit.' });
          return;
        }
        try {
          const record = this.readApi.setAgentDataRecord({
            agentId: String(body.agentId),
            key: String(body.key),
            category: body.category ? String(body.category) : undefined,
            data: body.data,
          });
          json(200, { record });
        } catch (err: any) {
          json(err?.name === 'ProtectedDataError' ? 403 : 400, { error: String(err?.message ?? err) });
        }
        return;
      }
      json(405, { error: `${method} not allowed on ${url.pathname}` });
      return;
    }

    const dataDeleteMatch = url.pathname.match(/^\/api\/data\/([^/]+)$/);
    if (dataDeleteMatch) {
      if (method === 'DELETE') {
        if (!this.readApi?.deleteAgentDataRecord) {
          json(501, { error: 'This daemon was started without agent data support.' });
          return;
        }
        const id = decodeURIComponent(dataDeleteMatch[1]);
        try {
          const deleted = this.readApi.deleteAgentDataRecord(id);
          json(200, { success: deleted, id });
        } catch (err: any) {
          if (err?.name !== 'ProtectedDataError') throw err;
          json(403, { error: String(err.message) });
        }
        return;
      }
      json(405, { error: `${method} not allowed on ${url.pathname}` });
      return;
    }

    const workResultMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/result$/);
    if (workResultMatch) {
      if (method !== 'GET') { json(405, { error: 'Use GET.' }); return; }
      const result = this.readApi?.workResult?.(decodeURIComponent(workResultMatch[1]));
      json(result ? 200 : 404, result ? { result } : { error: 'No saved work result for this run.' }); return;
    }

    const browserScreenMatch = url.pathname.match(/^\/api\/(?:runs|agents)\/([^/]+)\/browser\/screen$/);
    if (browserScreenMatch) {
      if (method !== 'GET') { json(405, { error: 'Use GET.' }); return; }
      const id = decodeURIComponent(browserScreenMatch[1]);
      const img = this.readApi?.browserScreenshot?.(id);
      if (!img) { json(404, { error: 'No browser screen available.' }); return; }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Content-Length': img.length,
      });
      res.end(img);
      return;
    }

    const browserStateMatch = url.pathname.match(/^\/api\/(?:runs|agents)\/([^/]+)\/browser\/state$/);
    if (browserStateMatch) {
      if (method !== 'GET') { json(405, { error: 'Use GET.' }); return; }
      const id = decodeURIComponent(browserStateMatch[1]);
      const state = this.readApi?.browserState?.(id);
      json(200, { state: state ?? null });
      return;
    }

    const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts(?:\/([^/]+))?$/);
    if (artifactMatch) {
      if (req.method !== 'GET') { json(405, { error: 'Use GET.' }); return; }
      const runId = decodeURIComponent(artifactMatch[1]);
      if (!artifactMatch[2]) {
        if (!this.readApi?.artifacts) { json(501, { error: 'Artifacts unavailable.' }); return; }
        json(200, { artifacts: this.readApi.artifacts(runId) }); return;
      }
      const file = this.readApi?.artifact?.(runId, decodeURIComponent(artifactMatch[2]));
      if (!file) { json(404, { error: 'Artifact not found for this run.' }); return; }
      res.writeHead(200, { 'Content-Type': file.encoding === 'base64' ? 'application/octet-stream' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${file.path.split('/').at(-1)!.replace(/[^a-zA-Z0-9_.-]/g, '_')}"`, 'X-Content-SHA256': file.sha256, 'X-Content-Type-Options': 'nosniff' });
      res.end(file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content); return;
    }

    if (url.pathname === '/api/runs/step-counts') {
      if (method !== 'GET') { json(405, { error: 'Use GET.' }); return; }
      if (!this.readApi?.stepCounts) {
        json(501, { error: 'Step counts unavailable.' });
        return;
      }
      const idsParam = url.searchParams.get('ids') ?? '';
      const ids = idsParam ? idsParam.split(',').filter(Boolean) : [];
      const stepCounts = this.readApi.stepCounts(ids);
      json(200, { counts: stepCounts, stepCounts });
      return;
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/(events|workspace)$/);
    if (!runMatch) {
      json(404, { error: `No such endpoint: ${url.pathname}` });
      return;
    }

    if (!this.readApi) {
      // Not a silent empty response: a caller must be able to tell "no data" from
      // "this server was never given a way to read data".
      json(501, { error: 'This daemon was started without a read API.' });
      return;
    }

    const runId = decodeURIComponent(runMatch[1]);
    const resource = runMatch[2];

    if (resource === 'events') {
      const sinceRaw = url.searchParams.get('since');
      let since: number | undefined;
      if (sinceRaw !== null) {
        // Number('') is 0, not NaN, so an empty ?since= would silently mean
        // "from the beginning" instead of being reported as malformed.
        since = sinceRaw.trim() === '' ? NaN : Number(sinceRaw);
        if (!Number.isInteger(since) || since < 0) {
          json(400, { error: `Invalid "since" parameter: ${sinceRaw}` });
          return;
        }
      }
      const events = this.readApi.getRunEvents(runId, since);
      json(200, {
        runId,
        since: since ?? null,
        // Lets a poller resume exactly where it stopped without re-reading.
        latestEventId: events.length > 0 ? events[events.length - 1].id ?? null : null,
        events,
      });
      return;
    }

    const file = url.searchParams.get('file');
    if (file !== null) {
      if (method === 'POST' || method === 'PUT') {
        if (!this.readApi.writeRunFile) {
          json(501, { error: 'Workspace editing is not supported by this daemon.' });
          return;
        }
        let body: any;
        try {
          body = await this.readJsonBody(req, 4 * 1024 * 1024);
        } catch {
          json(400, { error: 'Invalid JSON body.' });
          return;
        }
        if (typeof body?.content !== 'string' || typeof body?.expectedContent !== 'string') {
          json(400, { error: 'content and expectedContent must be strings.' });
          return;
        }
        const result = await this.readApi.writeRunFile(runId, file, body.content, body.expectedContent);
        json(result.success ? 200 : 400, { runId, file, ...result });
        return;
      }
      const result = await this.readApi.readRunFile(runId, file);
      json(result.available ? 200 : 404, { runId, file, ...result });
      return;
    }

    const workspace = await this.readApi.getRunWorkspace(runId);
    json(workspace.available || workspace.required === false ? 200 : 404, { runId, ...workspace });
  }

  /**
   * Broadcast an ExecutionEvent to all connected clients.
   * This is the exact event committed to SQLite execution_events.
   */
  broadcast(event: ExecutionEventRecord): void {
    if (!this.wss) return;
    const msg = JSON.stringify({
      type: 'EXECUTION_EVENT',
      event,
    });

    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  /**
   * Get count of active connected UI clients.
   */
  getClientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  /**
   * Stop the server and clean up connections.
   */
  async close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      const server = this.httpServer;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // The daemon settles active work before closing HTTP. Browser preconnects
        // and incomplete requests must not keep shutdown waiting indefinitely.
        server.closeAllConnections();
      });
      this.httpServer = null;
    }
  }
}
