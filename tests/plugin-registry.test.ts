/**
 * Plugin installation writes the config file the daemon boots from.
 *
 * That makes it the highest-risk write in the product: a bad entry is a daemon
 * that will not start, and an unguarded `command` field is remote code
 * execution. These tests exist for those two failures specifically.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_PLUGIN_COMMANDS,
  installPlugin,
  listConfiguredPlugins,
  uninstallPlugin,
} from '../src/daemon/plugin-registry.js';

let dir: string;
let configPath: string;

const baseConfig = {
  executor: 'builtin',
  agents: [
    { id: 'atlas', name: 'Atlas', model: 'test-model', budgetUsd: 5, mcpServers: [] },
    { id: 'ledger', name: 'Ledger', model: 'test-model', budgetUsd: 5, mcpServers: ['git'] },
  ],
  mcpServers: [
    { name: 'git', command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'] },
  ],
};

function write(config: unknown) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

function read() {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

describe('plugin registry', () => {
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-plugins-'));
    configPath = path.join(dir, 'openhours.config.json');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    write(baseConfig);
  });

  it('lists what the config file holds', () => {
    const plugins = listConfiguredPlugins(configPath);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].name, 'git');
  });

  it('installs a server and reports that a restart is required', () => {
    const result = installPlugin(
      { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './work'] },
      configPath
    );
    assert.equal(result.restartRequired, true);
    assert.equal(result.server.name, 'filesystem');

    const written = read();
    assert.equal(written.mcpServers.length, 2);
    assert.ok(written.mcpServers.some((s: any) => s.name === 'filesystem'));
    // Everything else in the file is untouched.
    assert.equal(written.agents.length, 2);
    assert.equal(written.executor, 'builtin');
  });

  it('applies the schema defaults so the daemon reads a complete entry', () => {
    installPlugin({ name: 'fetch', command: 'npx', args: [] }, configPath);
    const entry = read().mcpServers.find((s: any) => s.name === 'fetch');
    assert.equal(entry.callQuotaPerRun, 50);
    assert.deepEqual(entry.allowedTools, []);
    assert.equal(entry.connectTimeoutMs, 15000);
  });

  it('REFUSES a command that is not on the allowlist', () => {
    // Without this the endpoint would spawn any binary on the host.
    assert.throws(
      () => installPlugin({ name: 'evil', command: 'bash', args: ['-c', 'id'] }, configPath),
      /not on the allowlist/
    );
    assert.equal(read().mcpServers.length, 1, 'nothing may be written on refusal');
  });

  it('accepts every command it claims to allow', () => {
    for (const command of ALLOWED_PLUGIN_COMMANDS) {
      write(baseConfig);
      assert.doesNotThrow(() => installPlugin({ name: 'probe', command, args: [] }, configPath));
    }
  });

  it('REFUSES shell metacharacters in arguments and environment', () => {
    assert.throws(
      () => installPlugin({ name: 'sneaky', command: 'npx', args: ['x; rm -rf /'] }, configPath),
      /shell metacharacters/
    );
    assert.throws(
      () => installPlugin({ name: 'sneaky', command: 'npx', args: [], env: { X: '$(id)' } }, configPath),
      /shell metacharacters/
    );
  });

  it('rejects a malformed entry with a field-level reason', () => {
    assert.throws(() => installPlugin({ name: 'Bad Name', command: 'npx' }, configPath), /kebab-case/);
    assert.throws(() => installPlugin({ command: 'npx' }, configPath), /name/);
  });

  it('refuses a duplicate name rather than replacing a server', () => {
    assert.throws(() => installPlugin({ name: 'git', command: 'npx', args: [] }, configPath), /already configured/);
    assert.equal(read().mcpServers.length, 1);
  });

  it('uninstalls a server nothing references', () => {
    installPlugin({ name: 'fetch', command: 'npx', args: [] }, configPath);
    const result = uninstallPlugin('fetch', configPath);
    assert.equal(result.restartRequired, true);
    assert.ok(!read().mcpServers.some((s: any) => s.name === 'fetch'));
  });

  it('REFUSES to uninstall a server an agent is allowlisted for', () => {
    // A dangling reference is fatal to validateReferences, so allowing this
    // would write a config the daemon cannot boot from.
    assert.throws(() => uninstallPlugin('git', configPath), /allowlisted for agent\(s\) ledger/);
    assert.equal(read().mcpServers.length, 1);
  });

  it('reports an unknown server rather than succeeding silently', () => {
    assert.throws(() => uninstallPlugin('nope', configPath), /No MCP server named/);
  });

  it('refuses to edit a config file that is not valid JSON', () => {
    fs.writeFileSync(configPath, '{ not json', 'utf-8');
    assert.throws(() => installPlugin({ name: 'fetch', command: 'npx' }, configPath), /not valid JSON/);
  });

  it('says plainly when there is no config file to edit', () => {
    assert.throws(
      () => installPlugin({ name: 'fetch', command: 'npx' }, path.join(dir, 'absent.json')),
      /No configuration file at/
    );
  });
});
