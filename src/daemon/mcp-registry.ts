/**
 * MCP registry: the daemon's gate in front of the MCP client.
 *
 * The client knows how to talk to a server. The registry decides WHETHER a
 * given agent is allowed to, and writes down what happened. It is the only
 * thing in the codebase permitted to call `McpClient.callTool`.
 *
 * Every call produces a TOOL_CALL event, including refused and failed ones.
 * A refusal that left no trace would be indistinguishable from a call that was
 * never attempted, and the difference matters when an agent is misbehaving.
 *
 * TOOL_CALL is what finally gives layer 7 a dedicated signal. Before this, tool
 * execution was only visible as a side-effect of TURN_COMPLETED's exit code.
 */

import { AgentStore } from './agent-store.js';
import {
  McpClient,
  McpNotAllowedError,
  McpQuotaExceededError,
  type McpCallResult,
  type McpServerConfig,
  type McpToolDescriptor,
} from '../kernel/mcp-client.js';

export interface McpRegistryOptions {
  agentStore: AgentStore;
  servers?: McpServerConfig[];
  /**
   * agentId -> server names that agent may use. An agent with no entry may use
   * NOTHING: the default is deny, so forgetting to configure an agent fails
   * closed rather than granting it every tool on the machine.
   */
  allowlist?: Record<string, string[]>;
  client?: McpClient;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  tools: string[];
  callsUsed: number;
  quota: number;
  /** Why this server is not connected. Present only on failure. */
  error?: string;
}

export interface McpCallContext {
  agentId: string;
  taskRunId: string;
  server: string;
  tool: string;
  args?: Record<string, unknown>;
  signal?: AbortSignal;
}

export class McpRegistry {
  private readonly store: AgentStore;
  private readonly client: McpClient;
  private servers: McpServerConfig[];
  private allowlist: Record<string, string[]>;
  private activeCalls = 0;
  private reloading = false;
  private readonly errors = new Map<string, string>();

  constructor(options: McpRegistryOptions) {
    this.store = options.agentStore;
    this.client = options.client ?? new McpClient();
    this.servers = options.servers ?? [];
    this.allowlist = options.allowlist ?? {};
  }

  /**
   * Connect every configured server.
   *
   * One server failing does not abort the rest, but the failure is RECORDED and
   * surfaced through status() - the operator sees a named, explained outage
   * instead of a tool that quietly stopped existing.
   */
  async start(): Promise<McpServerStatus[]> {
    for (const config of this.servers) {
      try {
        await this.client.connect(config);
        this.errors.delete(config.name);
      } catch (err: any) {
        this.errors.set(config.name, String(err?.message ?? err));
      }
    }
    return this.status();
  }

  /** Which servers this agent may use. Unknown agent means none. */
  serversForAgent(agentId: string): string[] {
    const allowed = this.allowlist[agentId] ?? [];
    return allowed.filter((name) => this.client.isConnected(name));
  }

  /** Tools this agent may actually invoke right now. */
  toolsForAgent(agentId: string): McpToolDescriptor[] {
    const allowed = new Set(this.serversForAgent(agentId));
    return this.client.listTools().filter((t) => allowed.has(t.server));
  }

  status(): McpServerStatus[] {
    return this.servers.map((config) => ({
      name: config.name,
      connected: this.client.isConnected(config.name),
      tools: this.client
        .listTools()
        .filter((t) => t.server === config.name)
        .map((t) => t.name),
      callsUsed: this.client.callsUsed(config.name),
      quota: config.callQuotaPerRun ?? 50,
      error: this.errors.get(config.name),
    }));
  }

  /** Start-of-run bookkeeping. Quotas are per run, so they reset per run. */
  beginRun(taskRunId = 'legacy'): void {
    this.client.resetRunQuotas(taskRunId);
  }

  endRun(taskRunId: string): void {
    this.client.resetRunQuotas(taskRunId);
  }

  /**
   * Invoke a tool on behalf of an agent, if it is allowed to.
   *
   * The allowlist check happens BEFORE the client is touched, so a disallowed
   * server is never even contacted - the refusal cannot leak the fact that the
   * server exists, and cannot cost the server anything.
   */
  async call(ctx: McpCallContext): Promise<McpCallResult> {
    if(this.reloading)throw new McpNotAllowedError('Plugins are reloading. Retry after reload completes.');
    const run = this.store.getTaskRun(ctx.taskRunId);
    if (!run || run.agent_id !== ctx.agentId) throw new McpNotAllowedError('The MCP call must belong to this bot and task run.');
    const allowed = this.allowlist[ctx.agentId] ?? [];

    if (!allowed.includes(ctx.server)) {
      const err = new McpNotAllowedError(
        `Agent "${ctx.agentId}" is not allowlisted for MCP server "${ctx.server}". ` +
          `Allowed: ${allowed.join(', ') || 'none'}.`
      );
      this.record(ctx, { outcome: 'refused', reason: err.message });
      throw err;
    }

    this.activeCalls++;
    try {
      const result = await this.client.callTool(ctx.server, ctx.tool, ctx.args ?? {}, { runId: ctx.taskRunId, signal: ctx.signal });
      this.record(ctx, {
        outcome: result.isError ? 'error' : 'ok',
        durationMs: result.durationMs,
        resultChars: result.text.length,
      });
      return result;
    } catch (err: any) {
      const refused = err instanceof McpNotAllowedError || err instanceof McpQuotaExceededError;
      this.record(ctx, {
        outcome: refused ? 'refused' : 'error',
        reason: String(err?.message ?? err),
      });
      throw err;
    } finally {this.activeCalls--;}
  }

  /** Replace live connections only between calls. Quotas survive replacement. Failed replacements keep the old server. */
  async reload(servers: McpServerConfig[], allowlist?: Record<string,string[]>): Promise<McpServerStatus[]> {
    if(this.reloading || this.activeCalls)throw new Error('A plugin call or reload is active. Retry reload after it completes.');
    this.reloading=true;
    try{
      for(const config of servers){
        const old=this.servers.find(s=>s.name===config.name);
        if(JSON.stringify(old)===JSON.stringify(config)&&this.client.isConnected(config.name))continue;
        try{await this.client.connect(config,true);this.errors.delete(config.name);}
        catch(error){this.errors.set(config.name,error instanceof Error?error.message:String(error));throw error;}
        this.servers=[...this.servers.filter(s=>s.name!==config.name),config];
      }
      for(const old of this.servers)if(!servers.some(s=>s.name===old.name)){await this.client.disconnect(old.name);this.errors.delete(old.name);}
      this.servers=[...servers]; if(allowlist)this.allowlist=allowlist;
      return this.status();
    }finally{this.reloading=false;}
  }

  private record(ctx: McpCallContext, detail: Record<string, unknown>): void {
    this.store.recordEvent({
      task_run_id: ctx.taskRunId,
      agent_id: ctx.agentId,
      event_type: 'TOOL_CALL',
      payload_json: JSON.stringify({
        transport: 'mcp',
        server: ctx.server,
        tool: ctx.tool,
        ...detail,
      }),
      timestamp: Date.now(),
    });
  }

  async stop(): Promise<void> {
    await this.client.close();
  }
}
