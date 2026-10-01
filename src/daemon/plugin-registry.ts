/**
 * Plugins, which in OpenAgents means MCP servers.
 *
 * The daemon starts MCP servers at boot from `openhours.config.json`. That is a
 * deliberate design: an MCP server is a process the daemon spawns with a command
 * and arguments the operator chose, so "installing" one from a web UI is
 * literally editing that file.
 *
 * This module does exactly that and nothing more. It does NOT start a server, so
 * every write reports `restartRequired: true` - the UI says so rather than
 * showing a plugin as connected when no process exists yet.
 *
 * WHAT THIS DELIBERATELY REFUSES:
 *
 *  - Arbitrary commands. The command must be on an allowlist. Without that,
 *    `POST /api/plugins` is a remote-code-execution endpoint: anything that can
 *    reach the daemon's HTTP port could ask it to spawn any binary on the host.
 *  - Removing a server an agent is allowlisted for. The config validator treats
 *    a dangling reference as fatal, so allowing it here would write a config
 *    that refuses to boot.
 *  - Shell metacharacters in arguments, for the same reason as the first rule.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONFIG_FILENAME,
  McpServerConfigSchema,
  OpenAgentsConfigSchema,
  validateReferences,
  type McpServerFileConfig,
} from './config-file.js';

/**
 * Commands the daemon is willing to spawn for a plugin.
 *
 * These are package runners, not shells. `npx` and friends still execute code
 * from a registry, which is why the caller must be trusted to reach this API at
 * all - but an allowlist stops the endpoint from being a general "run this
 * binary" primitive, which is a different and much larger hole.
 */
export const ALLOWED_PLUGIN_COMMANDS = ['npx', 'node', 'uvx', 'python', 'python3', 'docker'];

/** Characters that mean something to a shell. None are legitimate here. */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\\"'\n\r]/;

export class PluginError extends Error {
  constructor(
    message: string,
    readonly kind: 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | 'IN_USE' | 'NO_CONFIG'
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export interface PluginWriteResult {
  server: McpServerFileConfig;
  configPath: string;
  /** Always true: this module writes config, it does not start processes. */
  restartRequired: true;
}

function resolveConfigPath(explicit?: string): string {
  const target = explicit ?? path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);
  if (!fs.existsSync(target)) {
    throw new PluginError(
      `No configuration file at ${target}. Plugins are stored there, so create it first ` +
        `(copy openhours.config.example.json) and restart the daemon.`,
      'NO_CONFIG'
    );
  }
  return target;
}

function readConfig(configPath: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err: any) {
    throw new PluginError(`${configPath} is not valid JSON: ${err?.message ?? err}`, 'INVALID');
  }
  const parsed = OpenAgentsConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PluginError(
      `${configPath} does not match the OpenAgents config schema, so it cannot be edited safely: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      'INVALID'
    );
  }
  // Keep the caller's original object so unknown top-level keys and formatting
  // intent survive a round-trip; only mcpServers is replaced.
  return { raw: raw as Record<string, unknown>, config: parsed.data };
}

/**
 * Write the file atomically.
 *
 * A config truncated by a crash mid-write is a daemon that will not boot, and
 * the operator would have no obvious way to connect that to having clicked
 * "Add" in a plugin list.
 */
function writeConfig(configPath: string, next: Record<string, unknown>): void {
  const temp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  fs.renameSync(temp, configPath);
}

function assertSafeServer(server: McpServerFileConfig): void {
  if (!ALLOWED_PLUGIN_COMMANDS.includes(server.command)) {
    throw new PluginError(
      `Command "${server.command}" is not on the allowlist (${ALLOWED_PLUGIN_COMMANDS.join(', ')}). ` +
        `Add it to openhours.config.json by hand if you really intend to run it.`,
      'INVALID'
    );
  }
  for (const arg of server.args) {
    if (SHELL_METACHARACTERS.test(arg)) {
      throw new PluginError(`Argument ${JSON.stringify(arg)} contains shell metacharacters.`, 'INVALID');
    }
  }
  for (const [key, value] of Object.entries(server.env)) {
    if (SHELL_METACHARACTERS.test(value)) {
      throw new PluginError(`Environment value for ${key} contains shell metacharacters.`, 'INVALID');
    }
  }
}

/** Every MCP server currently in the config file. */
export function listConfiguredPlugins(configPath?: string): McpServerFileConfig[] {
  const target = resolveConfigPath(configPath);
  return readConfig(target).config.mcpServers;
}

export function configuredPluginPermissions(configPath?: string): Record<string,string[]> {
  return Object.fromEntries(readConfig(resolveConfigPath(configPath)).config.agents.map(a=>[a.id,a.mcpServers]));
}

/** Grant only an already installed server. Never installs a command or changes other permissions. */
export function grantInstalledPlugin(agentId:string,name:string,configPath?:string):void {
  const target=resolveConfigPath(configPath),{raw,config}=readConfig(target);
  if(!config.mcpServers.some(s=>s.name===name))throw new PluginError('The requested plugin is not installed.','NOT_FOUND');
  const agent=config.agents.find(a=>a.id===agentId);if(!agent)throw new PluginError('This bot has no persistent plugin configuration.','NOT_FOUND');
  if(agent.mcpServers.includes(name))return;
  const agents=(raw.agents as Array<Record<string,unknown>>).map(a=>a.id===agentId?{...a,mcpServers:[...agent.mcpServers,name]}:a);
  const next={...raw,agents};OpenAgentsConfigSchema.parse(next);writeConfig(target,next);
}

/** Add a server. Refuses a duplicate name rather than silently replacing one. */
export function installPlugin(input: unknown, configPath?: string): PluginWriteResult {
  const target = resolveConfigPath(configPath);
  const parsed = McpServerConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new PluginError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'server'}: ${i.message}`).join('; '),
      'INVALID'
    );
  }
  const server = parsed.data;
  assertSafeServer(server);

  const { raw, config } = readConfig(target);
  if (config.mcpServers.some((s) => s.name === server.name)) {
    throw new PluginError(`An MCP server named "${server.name}" is already configured.`, 'CONFLICT');
  }

  const next = { ...raw, mcpServers: [...config.mcpServers, server] };
  // Validate the whole file before committing it, so a plugin write can never
  // produce a config the daemon would refuse to boot from.
  const revalidated = OpenAgentsConfigSchema.parse(next);
  validateReferences(revalidated);

  writeConfig(target, next);
  return { server, configPath: target, restartRequired: true };
}

/** Remove a server, unless an agent is allowlisted for it. */
export function uninstallPlugin(name: string, configPath?: string): PluginWriteResult {
  const target = resolveConfigPath(configPath);
  const { raw, config } = readConfig(target);

  const server = config.mcpServers.find((s) => s.name === name);
  if (!server) throw new PluginError(`No MCP server named "${name}" is configured.`, 'NOT_FOUND');

  const users = config.agents.filter((a) => a.mcpServers.includes(name)).map((a) => a.id);
  if (users.length > 0) {
    throw new PluginError(
      `"${name}" is allowlisted for agent(s) ${users.join(', ')}. Remove it from them first: ` +
        `a config that references a server that does not exist fails to boot.`,
      'IN_USE'
    );
  }

  const next = { ...raw, mcpServers: config.mcpServers.filter((s) => s.name !== name) };
  const revalidated = OpenAgentsConfigSchema.parse(next);
  validateReferences(revalidated);

  writeConfig(target, next);
  return { server, configPath: target, restartRequired: true };
}
