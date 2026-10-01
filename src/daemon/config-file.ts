/**
 * Declarative configuration.
 *
 * Until now "customisable" meant editing TypeScript: one agent was hardcoded in
 * index.ts, and MCP servers lived in a frozen constants object. That is fine for
 * the author and useless for anyone else - which is the whole problem with an
 * open-source repo you cannot configure without a compiler.
 *
 * A config file also gives this runtime the one Grok Bot feature it was missing:
 * several NAMED bots with distinct roles, models, budgets and tools, rather than
 * a single anonymous worker.
 *
 * Validation uses zod, which was already a declared dependency that nothing
 * imported (CONCERNS #9). This is the use it was declared for.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseSchedule } from './cron.js';
import { CustomContractSchema } from './work-contract.js';

/** Ids appear in URLs, event payloads and allowlists, so keep them tame. */
const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'must be kebab-case: lowercase letters, digits and dashes');

export const McpServerConfigSchema = z.object({
  name: IdSchema,
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /**
   * Explicit environment for the server process. NOT inherited: the daemon holds
   * provider credentials and an MCP server has no business seeing them.
   */
  env: z.record(z.string()).default({}),
  callQuotaPerRun: z.number().int().positive().default(50),
  /** Empty means "whatever the server advertises". Naming tools narrows it. */
  allowedTools: z.array(z.string()).default([]),
  connectTimeoutMs: z.number().int().positive().default(15_000),
});

export const AgentConfigSchema = z.object({
  obsidianVault: z.string().min(1).optional(),
  id: IdSchema,
  name: z.string().min(1),
  /**
   * What this bot is for, in one line. Becomes part of its system prompt, which
   * is what turns a fleet of identical workers into named colleagues.
   */
  role: z.string().optional(),
  /** Full override. When present, `role` is ignored rather than concatenated. */
  systemPrompt: z.string().optional(),
  model: z.string().min(1),
  /**
   * Provider connection ID from Settings → Providers. When set, `model` is that gateway's exact wire ID
   * and no provider is inferred from it.
   */
  connection: z.string().min(1).optional(),
  /** Only with `connection`. Pinned refuses any other served model; auto lets the gateway route within its pool. */
  routing: z.enum(['pinned', 'auto']).optional(),
  fallbackModel: z.string().optional(),
  budgetUsd: z.number().positive(),
  /** MCP servers this agent may use. DEFAULT DENY: absent means none. */
  mcpServers: z.array(z.string()).default([]),
  /** Other bots this bot may delegate to, including their configured tools. Empty denies cross-bot delegation. */
  delegateTo: z.array(IdSchema).max(100).default([]),
  /** Block this agent's tasks until an operator approves each dispatch. */
  requiresApproval: z.boolean().default(false),
});

export const RoutineConfigSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  name: z.string().min(1),
  schedule: z.string().min(1), // e.g. "0 9 * * *" or "every day at 9 am"
  timezone: z.string().default('UTC'),
  prompt: z.string().min(1),
  taskName: z.string().optional(),
  enabled: z.boolean().default(true),
  catchUpPolicy: z.enum(['skip', 'run_once']).default('skip'),
});

export const OpenAgentsConfigSchema = z.object({
  /** Explicit opt-in after verifying image input support for these exact provider/model IDs. */
  visionModels: z.array(z.string().min(1)).max(100).default([]),
  repositories: z.object({
    local: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/), z.string().min(1)).default({}),
    github: z.array(z.object({ repository: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/), tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), publish: z.boolean().default(false) }).strict()).max(100).default([]),
  }).default({}),
  research: z.object({ enabled: z.boolean().default(true) }).default({}),
  browser: z.object({ enabled: z.boolean().default(true), maxConcurrency: z.number().int().min(1).max(4).default(2),
    // auto: a Docker sandbox when Docker runs, else this computer. sandbox: only Docker. computer: never Docker.
    isolation: z.enum(['auto', 'sandbox', 'computer']).default('auto') }).default({}),
  contracts: z.array(CustomContractSchema).max(100).default([]),
  $schema: z.string().optional(),
  executor: z.enum(['builtin', 'opencode']).optional(),
  /** Standing goal the producer decomposes. Omit for operator-enqueued work only. */
  mission: z.string().optional(),
  agents: z.array(AgentConfigSchema).min(1, 'define at least one agent'),
  routines: z.array(RoutineConfigSchema).default([]),
  mcpServers: z.array(McpServerConfigSchema).default([]),
  scheduler: z
    .object({
      cadenceMs: z.number().int().positive().optional(),
      maxConcurrency: z.number().int().positive().optional(),
    })
    .default({}),
});

export type McpServerFileConfig = z.infer<typeof McpServerConfigSchema>;
export type AgentFileConfig = z.infer<typeof AgentConfigSchema>;
export type RoutineFileConfig = z.infer<typeof RoutineConfigSchema>;
export type OpenAgentsConfig = z.infer<typeof OpenAgentsConfigSchema>;

export const DEFAULT_CONFIG_FILENAME = 'openhours.config.json';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Checks zod cannot express, each guarding a failure that would otherwise be
 * SILENT rather than loud.
 */
export function validateReferences(config: OpenAgentsConfig): void {
  const serverNames = new Set(config.mcpServers.map((s) => s.name));

  const dupServers = config.mcpServers
    .map((s) => s.name)
    .filter((n, i, all) => all.indexOf(n) !== i);
  if (dupServers.length > 0) {
    throw new ConfigError(`Duplicate MCP server name(s): ${[...new Set(dupServers)].join(', ')}.`);
  }

  const dupAgents = config.agents.map((a) => a.id).filter((n, i, all) => all.indexOf(n) !== i);
  if (dupAgents.length > 0) {
    throw new ConfigError(`Duplicate agent id(s): ${[...new Set(dupAgents)].join(', ')}.`);
  }

  for (const agent of config.agents) {
    for (const target of agent.delegateTo ?? []) {
      if (!config.agents.some(a => a.id === target)) throw new ConfigError(`Agent "${agent.id}" delegates to undefined bot "${target}".`);
    }
    if (agent.routing && !agent.connection) {
      throw new ConfigError(`Agent "${agent.id}" sets routing "${agent.routing}" without a connection. Routing modes apply only to a provider connection.`);
    }
    if (agent.connection && (agent.routing ?? 'pinned') === 'pinned' && (agent.model === 'auto' || agent.model.startsWith('auto:'))) {
      throw new ConfigError(`Agent "${agent.id}" pins the routing alias "${agent.model}". Aliases route between models, so set "routing": "auto" or choose a concrete model.`);
    }
    if (agent.connection && agent.fallbackModel) {
      throw new ConfigError(`Agent "${agent.id}" combines provider connection "${agent.connection}" with fallbackModel. Fallback models are not supported for connections.`);
    }
    for (const wanted of agent.mcpServers) {
      if (!serverNames.has(wanted)) {
        // This is the important one. The MCP allowlist DEFAULTS TO DENY, so a
        // typo here does not error at runtime - the agent simply has no tools,
        // for no visible reason. Catch it while the operator is looking.
        throw new ConfigError(
          `Agent "${agent.id}" is allowlisted for MCP server "${wanted}", which is not defined. ` +
            `Defined servers: ${[...serverNames].join(', ') || 'none'}. ` +
            `Left unchecked this would fail closed silently and the agent would just have no tools.`
        );
      }
    }
  }

  const dupRoutines = config.routines.map((r) => r.id).filter((n, i, all) => all.indexOf(n) !== i);
  if (dupRoutines.length > 0) {
    throw new ConfigError(`Duplicate routine id(s): ${[...new Set(dupRoutines)].join(', ')}.`);
  }

  const agentIds = new Set(config.agents.map((a) => a.id));
  for (const routine of config.routines) {
    if (!agentIds.has(routine.agentId)) {
      throw new ConfigError(
        `Routine "${routine.id}" targets unknown agent "${routine.agentId}". ` +
          `Defined agents: ${[...agentIds].join(', ') || 'none'}.`
      );
    }
    try {
      parseSchedule(routine.schedule);
    } catch (err: any) {
      throw new ConfigError(
        `Routine "${routine.id}" has invalid schedule "${routine.schedule}": ${err.message}`
      );
    }
  }
}

/** Turn `role` into a system prompt, unless one was given outright. */
export function systemPromptFor(agent: AgentFileConfig): string | null {
  if (agent.systemPrompt) return agent.systemPrompt;
  if (!agent.role) return null;
  return `You are ${agent.name}. Your role: ${agent.role}`;
}

export function parseConfig(raw: string, source = '<inline>'): OpenAgentsConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err: any) {
    throw new ConfigError(`${source} is not valid JSON: ${err?.message ?? err}`);
  }

  const parsed = OpenAgentsConfigSchema.safeParse(json);
  if (!parsed.success) {
    // zod's raw dump is unreadable; render one line per problem with its path.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`${source} is not a valid OpenAgents config:\n${issues}`);
  }

  validateReferences(parsed.data);
  return parsed.data;
}

/**
 * Load configuration from disk.
 *
 * An EXPLICIT path that does not exist throws - the operator asked for that
 * file and silently ignoring them would be the worst outcome. A missing default
 * file returns null, which the daemon reports before falling back to built-ins,
 * so zero-config still works and is never mistaken for configured.
 */
export function loadConfigFile(
  explicitPath?: string,
  cwd = process.cwd()
): { config: OpenAgentsConfig; source: string } | null {
  const target = explicitPath
    ? path.resolve(cwd, explicitPath)
    : path.resolve(cwd, DEFAULT_CONFIG_FILENAME);

  if (!fs.existsSync(target)) {
    if (explicitPath) throw new ConfigError(`Config file not found: ${target}`);
    return null;
  }

  return { config: parseConfig(fs.readFileSync(target, 'utf-8'), target), source: target };
}
