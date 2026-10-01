/**
 * Marketplace catalogues.
 *
 * TWO DIFFERENT KINDS OF THING live in the marketplace, and they are honest in
 * different ways:
 *
 *  - BOT TEMPLATES are local fixtures. Importing one is real: it POSTs to
 *    /api/agents and a bot exists afterwards. The template content shown on the
 *    detail page is generated from the template itself, so a tab is never
 *    filled with prose describing capabilities the imported bot will not have.
 *
 *  - PLUGINS are MCP servers. Adding one is real: the daemon writes it into
 *    openhours.config.json. It is NOT started by that write - the daemon spawns
 *    MCP servers at boot - so the UI reports that a restart is required rather
 *    than showing the plugin as connected. `installCommand` must be on the
 *    daemon's allowlist or the install is refused.
 *
 * Names here are generic descriptions of open protocols and tools. No
 * third-party logos, trademarks or marketplace artwork are bundled.
 */

import { GROK_BOT_TEMPLATES, type BotTemplate } from './grokTemplates.js';
import type { AoraShape } from '../lib/aora-bot/shapes.js';

export interface TemplateContent {
  instructions: string;
  memories: string;
  skills: Array<{ name: string; summary: string }>;
  routines: Array<{ name: string; schedule: string }>;
  integrations: Array<{ name: string; summary: string }>;
}

export interface MarketplaceBotTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  shape: AoraShape;
  color: string;
  author: string;
  content: TemplateContent;
}

const AUTHOR = 'OpenAgents';

/**
 * Template content is DERIVED from the template, not written per entry.
 *
 * Seventy-four hand-written biographies would be seventy-four opportunities to
 * promise something the imported bot cannot do. Deriving keeps every tab
 * truthful about exactly what an import produces: a bot whose system prompt is
 * this description, with no memories, skills, routines or integrations until
 * the operator adds them.
 */
function contentFor(template: BotTemplate): TemplateContent {
  return {
    instructions:
      `${template.description}.\n\n` +
      `Work in small, verifiable steps. Say what you did and what you could not do. ` +
      `Ask before anything irreversible.`,
    memories:
      'No memories are packaged with this template. A bot builds its own memory from ' +
      'the work you give it, and importing does not copy anyone else\'s.',
    skills: [
      { name: `${template.category} triage`, summary: 'Sort incoming work and pick what matters first.' },
      { name: 'Written handover', summary: 'Summarise a session so the next run starts informed.' },
    ],
    routines: [
      { name: 'Daily check-in', schedule: 'Every day at 9:00 AM' },
      { name: 'Weekly summary', schedule: 'Every Monday at 8:00 AM' },
    ],
    integrations: [
      {
        name: 'MCP tools',
        summary:
          'This bot uses whatever MCP servers you allow it in openhours.config.json. ' +
          'Importing does not grant any tool access on its own.',
      },
    ],
  };
}

export const BOT_TEMPLATES: MarketplaceBotTemplate[] = GROK_BOT_TEMPLATES.map((template) => ({
  id: template.id,
  name: template.name,
  description: template.description,
  category: template.category,
  shape: template.shape as AoraShape,
  color: template.color,
  author: AUTHOR,
  content: contentFor(template),
}));

export const FEATURED_TEMPLATE_IDS = BOT_TEMPLATES.slice(0, 4).map((t) => t.id);

export const BOT_CATEGORIES = [
  'All',
  'From OpenAgents',
  'Engineering',
  'Sales',
  'Marketing',
  'Design',
  'Operations',
  'Executive & Admin',
  'Finance',
];

export interface PluginConnector {
  id: string;
  type: string;
}

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  featured: boolean;
  /** Where the server itself lives, so "View source" points somewhere real. */
  sourceUrl: string;
  connectors: PluginConnector[];
  /**
   * What the daemon will actually spawn when this plugin is added. The command
   * must be on the daemon's allowlist (see src/daemon/plugin-registry.ts) or the
   * install is refused.
   */
  installCommand: string;
  installArgs: string[];
  /** The openhours.config.json fragment that would enable it. */
  configExample: string;
}

function config(name: string, command: string, args: string[]): string {
  return JSON.stringify(
    { mcpServers: [{ name, command, args }] },
    null,
    2
  );
}

export const PLUGIN_CATALOG: PluginEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files under directories you allow.',
    category: 'Documents and Files',
    featured: true,
    sourceUrl: 'https://modelcontextprotocol.io/',
    connectors: [{ id: 'filesystem', type: 'Connector' }],
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
    configExample: config('filesystem', 'npx', ['-y', '@modelcontextprotocol/server-filesystem', './workspace']),
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Inspect history, diffs and branches in a local repository.',
    category: 'Infrastructure',
    featured: true,
    sourceUrl: 'https://modelcontextprotocol.io/',
    connectors: [{ id: 'git', type: 'Connector' }],
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-git', '--repository', '.'],
    configExample: config('git', 'npx', ['-y', '@modelcontextprotocol/server-git', '--repository', '.']),
  },
  {
    id: 'fetch',
    name: 'HTTP Fetch',
    description: 'Fetch a URL and return its text, for research and monitoring.',
    category: 'Research',
    featured: true,
    sourceUrl: 'https://modelcontextprotocol.io/',
    connectors: [{ id: 'fetch', type: 'Connector' }],
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-fetch'],
    configExample: config('fetch', 'npx', ['-y', '@modelcontextprotocol/server-fetch']),
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query a SQLite database and summarise what it holds.',
    category: 'Data & Analytics',
    featured: true,
    sourceUrl: 'https://modelcontextprotocol.io/',
    connectors: [{ id: 'sqlite', type: 'Connector' }],
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './data.db'],
    configExample: config('sqlite', 'npx', ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './data.db']),
  },
  {
    id: 'memory',
    name: 'Memory Graph',
    description: 'A persistent knowledge graph a bot can add to across runs.',
    category: 'Productivity',
    featured: false,
    sourceUrl: 'https://modelcontextprotocol.io/',
    connectors: [{ id: 'memory', type: 'Connector' }],
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-memory'],
    configExample: config('memory', 'npx', ['-y', '@modelcontextprotocol/server-memory']),
  },
  {
    id: 'time',
    name: 'Time and Timezones',
    description: 'Current time and timezone conversion, for schedule-aware work.',
    category: 'Scheduling',
    featured: false,
    sourceUrl: 'https://modelcontextprotocol.io/',
    connectors: [{ id: 'time', type: 'Connector' }],
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-time'],
    configExample: config('time', 'npx', ['-y', '@modelcontextprotocol/server-time']),
  },
  {
    id: 'everything',
    name: 'Protocol Test Server',
    description: 'A reference MCP server used to exercise tools, prompts and resources.',
    category: 'MCP',
    featured: false,
    sourceUrl: 'https://modelcontextprotocol.io/',
    connectors: [{ id: 'everything', type: 'Connector' }],
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-everything'],
    configExample: config('everything', 'npx', ['-y', '@modelcontextprotocol/server-everything']),
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Read-only SQL access to a Postgres database.',
    category: 'Data & Analytics',
    featured: false,
    sourceUrl: 'https://modelcontextprotocol.io/',
    connectors: [{ id: 'postgres', type: 'Connector' }],
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/db'],
    configExample: config('postgres', 'npx', ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/db']),
  },
];

export const PLUGIN_CATEGORIES = [
  'All',
  'Featured',
  'Data & Analytics',
  'Documents and Files',
  'Infrastructure',
  'MCP',
  'Productivity',
  'Research',
  'Scheduling',
];
