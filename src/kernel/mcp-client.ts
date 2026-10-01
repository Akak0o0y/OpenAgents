/**
 * MCP client.
 *
 * ============================ TRUST BOUNDARY ============================
 * MCP servers are external processes with REAL host access - a filesystem
 * server can read your disk, a shell server can run commands. That makes where
 * this code runs the whole security question:
 *
 *   - This client runs in the DAEMON process. Never in a container.
 *   - Agent-authored code executes in `DockerSandbox.executeTask()` with
 *     `--network none` and no secrets. It cannot reach an MCP server, and
 *     nothing here is exposed to it.
 *   - Only the agent PROCESS (the daemon's own loop) may request a call, and
 *     only for a server explicitly allowlisted for that agent.
 *
 * Running MCP servers inside the sandbox would defeat their purpose; letting
 * sandboxed code reach them would defeat the sandbox. There is no third option,
 * so the client sits outside and the allowlist is the gate.
 * =======================================================================
 *
 * On accounting: the plan called for MCP calls to be "budget-accounted like a
 * model call". They are NOT priced in dollars here, deliberately - an MCP call
 * consumes no provider tokens, and inventing a price would put synthetic
 * numbers in the same ledger that elsewhere refuses catalog data without HTTP
 * provenance. Instead each server carries a per-run CALL QUOTA, which is a real
 * limit on a real quantity.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

export interface McpServerConfig {
  /** Stable name used in allowlists and events. */
  name: string;
  /** Executable to spawn. The server speaks MCP over stdio. */
  command: string;
  args?: string[];
  /**
   * Environment for the server process. Inherited vars are NOT passed through:
   * an MCP server has no business seeing OPENROUTER_API_KEY.
   */
  env?: Record<string, string>;
  /** Maximum calls per task run. A real limit on a real quantity. */
  callQuotaPerRun?: number;
  /** Tool names this server may expose. Empty means "any tool it advertises". */
  allowedTools?: string[];
  connectTimeoutMs?: number;
}

export interface McpToolDescriptor {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  server: string;
  tool: string;
  /** Text content flattened from the MCP content blocks. */
  text: string;
  isError: boolean;
  durationMs: number;
}

export class McpQuotaExceededError extends Error {
  constructor(
    readonly server: string,
    readonly quota: number
  ) {
    super(`MCP server "${server}" exceeded its per-run call quota of ${quota}.`);
    this.name = 'McpQuotaExceededError';
  }
}

export class McpNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpNotAllowedError';
  }
}

/** One connected server. */
interface Connection {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolDescriptor[];
  callsByRun: Map<string, number>;
}

export class McpClient {
  private connections = new Map<string, Connection>();
  private readonly validator = new AjvJsonSchemaValidator();

  /**
   * Connect to a server and cache its advertised tools.
   *
   * A failure to connect is thrown, never swallowed: a silently absent MCP
   * server would make an agent look merely unlucky rather than misconfigured.
   */
  async connect(config: McpServerConfig, replace = false): Promise<McpToolDescriptor[]> {
    if (!replace && this.connections.has(config.name)) {
      return this.connections.get(config.name)!.tools;
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // Explicit env only. The daemon holds provider credentials and an MCP
      // server must not inherit them just because it is a child process.
      env: config.env ?? {},
      stderr: 'pipe',
    });

    const client = new Client({ name: 'openhours-daemon', version: '0.1.0' }, { capabilities: {} });

    const timeoutMs = config.connectTimeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MCP server "${config.name}" did not respond within ${timeoutMs}ms.`)),
            timeoutMs
          );
        }),
      ]);
    } catch (err: any) {
      await transport.close().catch(() => undefined);
      throw new Error(`Failed to connect MCP server "${config.name}": ${err?.message ?? err}`);
    } finally {
      if (timer) clearTimeout(timer);
    }

    let listed;
    try { listed = await client.listTools({}, {timeout:timeoutMs}); }
    catch(error){await client.close().catch(()=>undefined);await transport.close().catch(()=>undefined);throw error;}
    const advertised: McpToolDescriptor[] = listed.tools.map((t: any) => ({
      server: config.name,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    // The allowlist filters what the daemon will EXPOSE, independently of what
    // the server chooses to advertise. A server that grows a new tool overnight
    // does not silently gain reach.
    const tools =
      config.allowedTools && config.allowedTools.length > 0
        ? advertised.filter((t) => config.allowedTools!.includes(t.name))
        : advertised;

    const old = this.connections.get(config.name);
    this.connections.set(config.name, { config, client, transport, tools, callsByRun: old?.callsByRun ?? new Map() });
    if(old){await old.client.close().catch(()=>undefined);await old.transport.close().catch(()=>undefined);}
    return tools;
  }

  /** Every tool currently exposed, across all connected servers. */
  listTools(): McpToolDescriptor[] {
    return [...this.connections.values()].flatMap((c) => c.tools);
  }

  isConnected(server: string): boolean {
    return this.connections.has(server);
  }

  connectedServers(): string[] {
    return [...this.connections.keys()];
  }

  callsUsed(server: string, runId?: string): number {
    const calls = this.connections.get(server)?.callsByRun;
    return runId ? calls?.get(runId) ?? 0 : [...(calls?.values() ?? [])].reduce((a, b) => a + b, 0);
  }

  /** Reset per-run counters. Called at the start of each task run. */
  resetRunQuotas(runId = 'legacy'): void {
    for (const conn of this.connections.values()) conn.callsByRun.delete(runId);
  }

  /**
   * Invoke a tool.
   *
   * Three gates, all in code rather than in a prompt: the server must be
   * connected, the tool must be on the allowlist, and the run must have quota
   * left. A tool that merely *sounds* allowed is refused.
   */
  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown> = {},
    options: { runId?: string; signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<McpCallResult> {
    const conn = this.connections.get(server);
    if (!conn) {
      throw new McpNotAllowedError(
        `MCP server "${server}" is not connected. Connected: ${this.connectedServers().join(', ') || 'none'}.`
      );
    }
    if (!conn.tools.some((t) => t.name === tool)) {
      throw new McpNotAllowedError(
        `Tool "${tool}" is not exposed by MCP server "${server}". Exposed: ${conn.tools.map((t) => t.name).join(', ') || 'none'}.`
      );
    }

    options.signal?.throwIfAborted();
    const descriptor = conn.tools.find(t => t.name === tool)!;
    if (descriptor.inputSchema) {
      const result = this.validator.getValidator(descriptor.inputSchema)(args);
      if (!result.valid) throw new McpNotAllowedError(`Invalid arguments for ${server}.${tool}: ${result.errorMessage}`);
    }
    const runId = options.runId ?? 'legacy';
    const quota = conn.config.callQuotaPerRun ?? 50;
    const used = conn.callsByRun.get(runId) ?? 0;
    if (used >= quota) {
      throw new McpQuotaExceededError(server, quota);
    }
    conn.callsByRun.set(runId, used + 1);

    const started = Date.now();
    const res: any = await conn.client.callTool({ name: tool, arguments: args }, undefined, { signal: options.signal, timeout: options.timeoutMs ?? 30_000 });

    // MCP returns typed content blocks. Flatten the text and say plainly when a
    // block carries something this daemon does not render.
    const text = (res?.content ?? [])
      .map((block: any) =>
        block?.type === 'text' ? String(block.text ?? '') : `[${block?.type ?? 'unknown'} content omitted]`
      )
      .join('\n');

    return {
      server,
      tool,
      text,
      isError: Boolean(res?.isError),
      durationMs: Date.now() - started,
    };
  }

  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.client.close().catch(() => undefined);
      await conn.transport.close().catch(() => undefined);
    }
    this.connections.clear();
  }

  async disconnect(name: string): Promise<void> {
    const conn=this.connections.get(name);if(!conn)return;
    this.connections.delete(name);await conn.client.close().catch(()=>undefined);await conn.transport.close().catch(()=>undefined);
  }
}
