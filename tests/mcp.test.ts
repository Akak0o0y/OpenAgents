/**
 * Phase D: the MCP client and the trust boundary around it.
 *
 * These drive a REAL MCP server over stdio (tests/fixtures/echo-mcp-server.mjs),
 * not a mock, so the handshake and wire format are actually exercised.
 *
 * The security claims get negative controls, because "the sandbox cannot reach
 * MCP" is worth exactly nothing as an assertion and quite a lot as a test.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { AgentStore } from '../src/daemon/agent-store.js';
import { McpRegistry } from '../src/daemon/mcp-registry.js';
import { McpClient, McpNotAllowedError, McpQuotaExceededError } from '../src/kernel/mcp-client.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { layerForEvent } from '../src/kernel/agent-layers.js';
import { dockerArgv } from '../src/kernel/docker-host.js';

const DOCKER_TIMEOUT = 420_000;
const FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/echo-mcp-server.mjs');

function serverConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'echo',
    command: process.execPath, // the node binary running this test
    args: [FIXTURE],
    ...overrides,
  } as any;
}

function harness(allowlist: Record<string, string[]>, servers = [serverConfig()]) {
  const store = new AgentStore(':memory:');
  store.createAgent({
    id: 'agent-alpha',
    name: 'Alpha',
    model_id: 'claude-haiku-4-5',
    budget_cap_usd: 5,
    current_status: 'IDLE',
  });
  store.createAgent({
    id: 'agent-beta',
    name: 'Beta',
    model_id: 'claude-haiku-4-5',
    budget_cap_usd: 5,
    current_status: 'IDLE',
  });
  const taskRun = store.createTaskRun({ agentId: 'agent-alpha', taskName: 'mcp-fixture' });
  const registry = new McpRegistry({ agentStore: store, servers, allowlist });
  return {
    store,
    taskRun,
    registry,
    close: async () => {
      await registry.stop();
      store.close();
    },
  };
}

describe('McpClient speaks the real protocol', () => {
  let client: McpClient;

  before(async () => {
    client = new McpClient();
    await client.connect(serverConfig());
  });

  after(async () => {
    await client.close();
  });

  it('completes the handshake and discovers the advertised tools', () => {
    const names = client.listTools().map((t) => t.name).sort();
    assert.deepEqual(names, ['boom', 'leak_check', 'reverse']);
    assert.equal(client.isConnected('echo'), true);
  });

  it('calls a tool and returns its text', async () => {
    const res = await client.callTool('echo', 'reverse', { text: 'cortex' });
    assert.equal(res.text, 'xetroc');
    assert.equal(res.isError, false);
    assert.ok(res.durationMs >= 0);
  });

  it('reports a tool-level failure instead of throwing it away', async () => {
    const res = await client.callTool('echo', 'boom', {});
    assert.equal(res.isError, true, 'an isError result must survive to the caller');
  });

  it('SECURITY: the server process does not inherit provider credentials', async () => {
    // The daemon holds OPENROUTER_API_KEY / OPENCODE_API_KEY. An MCP server is a
    // child process and would inherit them by default - so the client passes an
    // explicit env. This proves it, rather than asserting it in a comment.
    process.env.OPENROUTER_API_KEY = 'sk-test-should-not-leak';
    const fresh = new McpClient();
    try {
      await fresh.connect(serverConfig({ name: 'leaktest' }));
      const res = await fresh.callTool('leaktest', 'leak_check', {});
      assert.equal(res.text, 'NO_CREDENTIALS', `MCP server saw credentials: ${res.text}`);
    } finally {
      await fresh.close();
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('refuses a tool the server never advertised', async () => {
    await assert.rejects(() => client.callTool('echo', 'rm_rf_slash', {}), McpNotAllowedError);
  });

  it('refuses a server that was never connected', async () => {
    await assert.rejects(() => client.callTool('ghost', 'reverse', {}), McpNotAllowedError);
  });

  it('exposes only allowlisted tools, whatever the server advertises', async () => {
    // A server that grows a new tool overnight must not silently gain reach.
    const narrow = new McpClient();
    try {
      const tools = await narrow.connect(serverConfig({ name: 'narrow', allowedTools: ['reverse'] }));
      assert.deepEqual(tools.map((t) => t.name), ['reverse']);
      await assert.rejects(() => narrow.callTool('narrow', 'boom', {}), McpNotAllowedError);
    } finally {
      await narrow.close();
    }
  });

  it('enforces the per-run call quota, then resets it on a new run', async () => {
    const limited = new McpClient();
    try {
      await limited.connect(serverConfig({ name: 'limited', callQuotaPerRun: 2 }));
      await limited.callTool('limited', 'reverse', { text: 'a' });
      await limited.callTool('limited', 'reverse', { text: 'b' });
      await assert.rejects(
        () => limited.callTool('limited', 'reverse', { text: 'c' }),
        McpQuotaExceededError
      );
      limited.resetRunQuotas();
      const after = await limited.callTool('limited', 'reverse', { text: 'd' });
      assert.equal(after.text, 'd');
    } finally {
      await limited.close();
    }
  });

  it('fails loudly when a server cannot start, rather than pretending it is absent', async () => {
    const broken = new McpClient();
    try {
      await assert.rejects(
        () =>
          broken.connect(
            serverConfig({ name: 'broken', args: ['/nonexistent-server.mjs'], connectTimeoutMs: 6000 })
          ),
        /Failed to connect MCP server "broken"/
      );
    } finally {
      await broken.close();
    }
  });
});

describe('McpRegistry gates by agent and records everything', () => {
  it('allows an allowlisted agent and records a layer-7 TOOL_CALL', async () => {
    const h = harness({ 'agent-alpha': ['echo'] });
    try {
      await h.registry.start();
      const res = await h.registry.call({
        agentId: 'agent-alpha',
        taskRunId: h.taskRun.id,
        server: 'echo',
        tool: 'reverse',
        args: { text: 'galaxy' },
      });
      assert.equal(res.text, 'yxalag');

      const call = h.store.getTaskEvents(h.taskRun.id).find((e) => e.event_type === 'TOOL_CALL');
      assert.ok(call, 'an MCP call must be recorded');
      assert.equal(call!.layer, 7, 'TOOL_CALL is layer-7 evidence');
      assert.equal(layerForEvent('TOOL_CALL'), 7);

      const payload = JSON.parse(call!.payload_json);
      assert.equal(payload.transport, 'mcp');
      assert.equal(payload.server, 'echo');
      assert.equal(payload.tool, 'reverse');
      assert.equal(payload.outcome, 'ok');
    } finally {
      await h.close();
    }
  });

  it('DEFAULT DENY: an agent with no allowlist entry gets nothing', async () => {
    // Forgetting to configure an agent must fail closed, not hand it every tool
    // on the machine.
    const h = harness({ 'agent-alpha': ['echo'] });
    try {
      await h.registry.start();
      assert.deepEqual(h.registry.serversForAgent('agent-beta'), []);
      assert.deepEqual(h.registry.toolsForAgent('agent-beta'), []);
      await assert.rejects(
        () =>
          h.registry.call({
            agentId: 'agent-beta',
            taskRunId: h.taskRun.id,
            server: 'echo',
            tool: 'reverse',
            args: { text: 'x' },
          }),
        McpNotAllowedError
      );
    } finally {
      await h.close();
    }
  });

  it('records a REFUSAL, so it is distinguishable from a call never attempted', async () => {
    const h = harness({});
    try {
      await h.registry.start();
      await assert.rejects(() =>
        h.registry.call({
          agentId: 'agent-alpha',
          taskRunId: h.taskRun.id,
          server: 'echo',
          tool: 'reverse',
        })
      );
      const call = h.store.getTaskEvents(h.taskRun.id).find((e) => e.event_type === 'TOOL_CALL');
      assert.ok(call, 'a refused call must still leave a trace');
      const payload = JSON.parse(call!.payload_json);
      assert.equal(payload.outcome, 'refused');
      assert.match(payload.reason, /not allowlisted/);
    } finally {
      await h.close();
    }
  });

  it('reports a failed server by name with its reason, not as a silent absence', async () => {
    const h = harness({ 'agent-alpha': ['echo'] }, [
      serverConfig({ name: 'echo' }),
      serverConfig({ name: 'dead', args: ['/nonexistent.mjs'], connectTimeoutMs: 6000 }),
    ]);
    try {
      const status = await h.registry.start();
      const echo = status.find((s) => s.name === 'echo')!;
      const dead = status.find((s) => s.name === 'dead')!;

      assert.equal(echo.connected, true, 'one bad server must not take the others down');
      assert.ok(echo.tools.includes('reverse'));

      assert.equal(dead.connected, false);
      assert.ok(dead.error && dead.error.length > 0, 'a dead server must explain itself');
      assert.deepEqual(dead.tools, []);
    } finally {
      await h.close();
    }
  });

  it('surfaces call usage against the quota for the operator', async () => {
    const h = harness({ 'agent-alpha': ['echo'] }, [serverConfig({ callQuotaPerRun: 3 })]);
    try {
      await h.registry.start();
      await h.registry.call({
        agentId: 'agent-alpha',
        taskRunId: h.taskRun.id,
        server: 'echo',
        tool: 'reverse',
        args: { text: 'q' },
      });
      const [status] = h.registry.status();
      assert.equal(status.callsUsed, 1);
      assert.equal(status.quota, 3);

      h.registry.beginRun(h.taskRun.id);
      assert.equal(h.registry.status()[0].callsUsed, 0, 'quotas are per run');
    } finally {
      await h.close();
    }
  });

  it('keeps concurrent run quotas independent and validates owner and arguments before dispatch', async () => {
    const h = harness({ 'agent-alpha': ['echo'], 'agent-beta': ['echo'] }, [serverConfig({ callQuotaPerRun: 1 })]);
    try {
      await h.registry.start();
      const second = h.store.createTaskRun({ agentId: 'agent-beta', taskName: 'second' });
      const call = { agentId: 'agent-alpha', taskRunId: h.taskRun.id, server: 'echo', tool: 'reverse', args: { text: 'first' } };
      await assert.rejects(() => h.registry.call({ ...call, agentId: 'agent-beta' }), /must belong/);
      await assert.rejects(() => h.registry.call({ ...call, args: { text: 123 } as any }), /Invalid arguments/);
      assert.equal(h.registry.status()[0].callsUsed, 0);
      await h.registry.call(call);
      h.registry.beginRun(second.id);
      await assert.rejects(() => h.registry.call(call), McpQuotaExceededError);
      await h.registry.call({ ...call, agentId: 'agent-beta', taskRunId: second.id });
      assert.equal(h.registry.status()[0].callsUsed, 2);
      h.registry.endRun(second.id);
      await assert.rejects(() => h.registry.call(call), McpQuotaExceededError);
    } finally { await h.close(); }
  });
});

describe('SECURITY: the sandbox cannot reach an MCP server', () => {
  it(
    'a network-none container cannot reach a REAL listening MCP-style socket',
    { timeout: DOCKER_TIMEOUT },
    async () => {
      // MCP servers here are stdio subprocesses of the daemon, so there is no
      // port for agent code to find. But an HTTP/SSE MCP server WOULD listen on
      // one, and the guarantee has to hold for that case too.
      //
      // The listener runs as a CONTAINER on the bridge network, not on the
      // Windows host. First attempt used a host-side Node listener on
      // 172.17.0.1; the positive control failed and revealed why - Docker runs
      // inside WSL2, so the bridge gateway is the WSL VM, and the probe could
      // not reach a Windows-bound socket even WITH networking. That version
      // would have "passed" while proving nothing.
      const docker = (args: string[]): string =>
        execFileSync(dockerArgv(args).command, dockerArgv(args).args, { encoding: 'utf-8' }).trim();

      const listener = `mcp-listener-${Date.now()}`;
      docker([
        'run', '-d', '--rm', '--name', listener, '--label', 'agent-platform=1',
        'alpine:latest', 'sh', '-c',
        'while true; do echo mcp-ish | nc -l -p 4457; done',
      ]);

      const sandbox = new DockerSandbox();
      const volume = await sandbox.createWorkspaceVolume(`mcp-boundary-${Date.now()}`);
      try {
        // Newer Docker leaves the legacy top-level IPAddress empty; the address
        // lives under Networks.bridge.
        const ip = docker(['inspect', '-f', '{{.NetworkSettings.Networks.bridge.IPAddress}}', listener]);
        assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, `listener has no bridge IP: "${ip}"`);

        await sandbox.stageWorkspaceFiles(volume, {
          'probe.mjs': [
            "import net from 'node:net';",
            `const socket = net.connect(4457, '${ip}');`,
            'socket.setTimeout(5000);',
            "socket.on('connect', () => { console.log('REACHED_LISTENER'); process.exit(1); });",
            "socket.on('error', () => { console.log('NO_ROUTE'); process.exit(0); });",
            "socket.on('timeout', () => { console.log('NO_ROUTE'); process.exit(0); });",
          ].join(String.fromCharCode(10)),
        });

        // POSITIVE CONTROL: on a bridge network the probe MUST reach the
        // listener. Without this the assertion below is satisfied by any broken
        // probe, which is exactly the trap the first version fell into.
        const reachable = await sandbox.executeTask(volume, 'node probe.mjs', {
          timeoutMs: 60_000,
          _unhardenedOverrides: { network: 'bridge' },
        } as any);
        assert.match(
          reachable.stdout,
          /REACHED_LISTENER/,
          `probe could not reach the listener even on a bridge network, so this test proves nothing. stdout: ${reachable.stdout}`
        );

        // THE ACTUAL CLAIM: the hardened executor profile has no route to it.
        const contained = await sandbox.executeTask(volume, 'node probe.mjs', { timeoutMs: 60_000 });
        assert.equal(
          contained.exitCode,
          0,
          `sandboxed code reached a live MCP-style socket - MCP would be exposed. stdout: ${contained.stdout}`
        );
        assert.match(contained.stdout, /NO_ROUTE/);
      } finally {
        await sandbox.destroyWorkspaceVolume(volume);
        try { docker(['rm', '-f', listener]); } catch { /* already gone */ }
      }
    }
  );

  it('the registry is daemon-side only: nothing in the sandbox path imports it', () => {
    // A structural assertion. If McpRegistry or McpClient is ever imported by
    // the sandbox or the executor, this fails and the trust boundary is back on
    // the table for review rather than quietly gone.
    for (const p of ['src/kernel/docker-sandbox.ts', 'src/daemon/opencode-executor.ts']) {
      if (!fs.existsSync(p)) continue;
      const source = fs.readFileSync(p, 'utf-8');
      assert.ok(
        !source.includes('mcp-registry') && !source.includes('McpClient'),
        `${p} must not reach the MCP layer - that would put host access inside the sandbox path`
      );
    }
  });
});
