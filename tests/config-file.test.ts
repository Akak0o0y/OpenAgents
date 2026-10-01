/**
 * Declarative configuration.
 *
 * Two things are being proven: that a valid file produces the fleet the
 * operator described, and that an invalid one FAILS LOUDLY. The second matters
 * more - most of these cases are mistakes that would otherwise be silent.
 *
 * Pure: no Docker, no daemon, no network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigError,
  DEFAULT_CONFIG_FILENAME,
  loadConfigFile,
  parseConfig,
  systemPromptFor,
  validateReferences,
} from '../src/daemon/config-file.js';

const MINIMAL = {
  agents: [{ id: 'alpha', name: 'Alpha', model: 'claude-haiku-4-5', budgetUsd: 10 }],
};

function withConfig(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagents-config-'));
  fs.writeFileSync(path.join(dir, DEFAULT_CONFIG_FILENAME), JSON.stringify(body), 'utf-8');
  return dir;
}

describe('parseConfig accepts a real fleet', () => {
  it('reads several named bots with distinct roles, models and budgets', () => {
    const config = parseConfig(
      JSON.stringify({
        executor: 'builtin',
        mission: 'Build small, well-tested utilities.',
        agents: [
          {
            id: 'alpha',
            name: 'Alpha',
            role: 'Backend engineer',
            model: 'model-a',
            budgetUsd: 10,
            mcpServers: ['notes'],
          },
          { id: 'beta', name: 'Beta', role: 'Test writer', model: 'model-b', budgetUsd: 2.5 },
        ],
        mcpServers: [{ name: 'notes', command: 'npx', args: ['-y', 'notes-mcp'] }],
      })
    );

    assert.equal(config.agents.length, 2);
    assert.equal(config.agents[0].model, 'model-a');
    assert.equal(config.agents[1].budgetUsd, 2.5);
    assert.deepEqual(config.agents[0].mcpServers, ['notes']);
    assert.equal(config.executor, 'builtin');
  });

  it('applies safe defaults so a minimal file is enough to start', () => {
    const config = parseConfig(JSON.stringify(MINIMAL));
    assert.deepEqual(config.mcpServers, []);
    assert.deepEqual(config.agents[0].mcpServers, [], 'no tools unless asked for');
    assert.equal(config.agents[0].requiresApproval, false);
  });

  it('turns a role into a system prompt, and lets an explicit prompt win', () => {
    const withRole = systemPromptFor({ id: 'a', name: 'Alpha', role: 'Backend engineer' } as any);
    assert.match(withRole ?? '', /You are Alpha/);
    assert.match(withRole ?? '', /Backend engineer/);
    assert.doesNotMatch(withRole ?? '', /fenced code|Reply ONLY|ES Modules/, 'persona must not impose a coding protocol on chat and planning');

    const explicit = systemPromptFor({
      id: 'a',
      name: 'Alpha',
      role: 'ignored',
      systemPrompt: 'VERBATIM',
    } as any);
    assert.equal(explicit, 'VERBATIM', 'an explicit prompt is used as written, not concatenated');

    assert.equal(systemPromptFor({ id: 'a', name: 'Alpha' } as any), null);
  });
});

describe('an invalid config fails loudly', () => {
  it('rejects a typo in an MCP allowlist, which would otherwise fail closed SILENTLY', () => {
    // The allowlist defaults to deny, so a misspelled server name produces no
    // error at runtime - the agent simply has no tools, for no visible reason.
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({
            agents: [{ id: 'alpha', name: 'A', model: 'm', budgetUsd: 1, mcpServers: ['notez'] }],
            mcpServers: [{ name: 'notes', command: 'npx' }],
          })
        ),
      (err: Error) =>
        err instanceof ConfigError &&
        /not defined/.test(err.message) &&
        /fail closed silently/.test(err.message)
    );
  });

  it('rejects duplicate agent ids', () => {
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({
            agents: [
              { id: 'alpha', name: 'A', model: 'm', budgetUsd: 1 },
              { id: 'alpha', name: 'B', model: 'm', budgetUsd: 1 },
            ],
          })
        ),
      /Duplicate agent id/
    );
  });

  it('rejects duplicate MCP server names', () => {
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({
            agents: MINIMAL.agents,
            mcpServers: [
              { name: 'notes', command: 'a' },
              { name: 'notes', command: 'b' },
            ],
          })
        ),
      /Duplicate MCP server name/
    );
  });

  it('rejects a fleet with no agents rather than booting an empty daemon', () => {
    assert.throws(() => parseConfig(JSON.stringify({ agents: [] })), /at least one agent/);
  });

  it('rejects a negative budget, which would disable the cap it is meant to enforce', () => {
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({ agents: [{ id: 'alpha', name: 'A', model: 'm', budgetUsd: -5 }] })
        ),
      /budgetUsd/
    );
  });

  it('rejects an unsafe agent id', () => {
    for (const id of ['Alpha', 'has space', '../escape', '']) {
      assert.throws(
        () => parseConfig(JSON.stringify({ agents: [{ id, name: 'A', model: 'm', budgetUsd: 1 }] })),
        `id ${JSON.stringify(id)} must be rejected`
      );
    }
  });

  it('reports WHICH field is wrong, not just that something is', () => {
    try {
      parseConfig(JSON.stringify({ agents: [{ id: 'alpha', name: 'A', budgetUsd: 1 }] }), 'my.json');
      assert.fail('should have thrown');
    } catch (err: any) {
      assert.match(err.message, /my\.json/);
      assert.match(err.message, /agents\.0\.model/, 'the path to the problem must be in the message');
    }
  });

  it('rejects malformed JSON with the parser reason', () => {
    assert.throws(() => parseConfig('{ not json', 'broken.json'), /broken\.json is not valid JSON/);
  });
});

describe('loadConfigFile', () => {
  it('loads the default filename from a directory', () => {
    const dir = withConfig(MINIMAL);
    const loaded = loadConfigFile(undefined, dir);
    assert.ok(loaded);
    assert.equal(loaded!.config.agents[0].id, 'alpha');
    assert.match(loaded!.source, /openhours\.config\.json$/);
  });

  it('returns null when no config exists, so zero-config still boots', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'openagents-empty-'));
    assert.equal(loadConfigFile(undefined, empty), null);
  });

  it('THROWS when an explicitly requested file is missing', () => {
    // Silently ignoring a path the operator typed is the worst outcome: they
    // would believe their configuration was applied.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'openagents-empty-'));
    assert.throws(() => loadConfigFile('does-not-exist.json', empty), /Config file not found/);
  });
});

describe('validateReferences', () => {
  it('NEGATIVE CONTROL: a correct allowlist passes', () => {
    // Without this, a validator that rejected everything would satisfy the
    // rejection tests above while blocking every valid configuration.
    assert.doesNotThrow(() =>
      validateReferences({
        agents: [
          {
            id: 'alpha',
            name: 'A',
            model: 'm',
            budgetUsd: 1,
            mcpServers: ['notes'],
            requiresApproval: false,
          },
        ],
        routines: [],
        mcpServers: [
          {
            name: 'notes',
            command: 'npx',
            args: [],
            env: {},
            callQuotaPerRun: 50,
            allowedTools: [],
            connectTimeoutMs: 15000,
          },
        ],
        scheduler: {},
      } as any)
    );
  });

  it('validates routine references and syntax', () => {
    // Valid routine passes
    const valid = parseConfig(
      JSON.stringify({
        agents: MINIMAL.agents,
        routines: [
          {
            id: 'morning-sweep',
            agentId: 'alpha',
            name: 'Morning Sweep',
            schedule: 'every day at 9 am',
            prompt: 'Check logs and run tests',
          },
        ],
      })
    );
    assert.equal(valid.routines.length, 1);
    assert.equal(valid.routines[0].id, 'morning-sweep');

    // Duplicate routine id
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({
            agents: MINIMAL.agents,
            routines: [
              { id: 'r1', agentId: 'alpha', name: 'R1', schedule: '0 9 * * *', prompt: 'p' },
              { id: 'r1', agentId: 'alpha', name: 'R2', schedule: '0 10 * * *', prompt: 'p' },
            ],
          })
        ),
      /Duplicate routine id/
    );

    // Target unknown agent
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({
            agents: MINIMAL.agents,
            routines: [
              { id: 'r1', agentId: 'ghost', name: 'R1', schedule: '0 9 * * *', prompt: 'p' },
            ],
          })
        ),
      /targets unknown agent "ghost"/
    );

    // Invalid schedule string
    assert.throws(
      () =>
        parseConfig(
          JSON.stringify({
            agents: MINIMAL.agents,
            routines: [
              { id: 'r1', agentId: 'alpha', name: 'R1', schedule: 'invalid schedule nonsense', prompt: 'p' },
            ],
          })
        ),
      /invalid schedule/
    );
  });
});

describe('provider connection references', () => {
  it('keeps a connection and routing mode on the agent and leaves ordinary agents unchanged', () => {
    const config = parseConfig(
      JSON.stringify({
        agents: [
          { id: 'gateway', name: 'Gateway', model: 'meta-llama/llama-4-scout:free', connection: 'freellmapi-abc123', routing: 'auto', budgetUsd: 5 },
          { id: 'plain', name: 'Plain', model: 'claude-haiku-4-5', budgetUsd: 5 },
        ],
      })
    );
    assert.equal(config.agents[0].connection, 'freellmapi-abc123');
    assert.equal(config.agents[0].routing, 'auto');
    assert.equal(config.agents[0].model, 'meta-llama/llama-4-scout:free', 'the exact wire ID is kept, slashes included');
    assert.equal(config.agents[1].connection, undefined);
    assert.equal(config.agents[1].routing, undefined);
  });

  it('refuses routing without a connection, a pinned alias and a fallback model on a connection', () => {
    const agent = (extra: object) =>
      JSON.stringify({ agents: [{ id: 'gateway', name: 'Gateway', model: 'llama-3.3-70b', budgetUsd: 5, ...extra }] });
    assert.throws(() => parseConfig(agent({ routing: 'auto' })), /without a connection/);
    assert.throws(() => parseConfig(agent({ connection: 'gw-1', model: 'auto' })), /pins the routing alias "auto"/);
    assert.throws(() => parseConfig(agent({ connection: 'gw-1', model: 'auto:fast', routing: 'pinned' })), /pins the routing alias/);
    assert.throws(() => parseConfig(agent({ connection: 'gw-1', fallbackModel: 'other-model' })), /Fallback models are not supported/);
    assert.throws(() => parseConfig(agent({ connection: 'gw-1', routing: 'sometimes' })));
    assert.doesNotThrow(() => parseConfig(agent({ connection: 'gw-1', model: 'auto', routing: 'auto' })));
  });
});
