import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureWebSocket as WebSocket, registerFixtureServer } from './helpers/daemon-client.js';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { startDaemon as bootDaemon } from '../src/daemon/index.js';
async function startDaemon(options: Parameters<typeof bootDaemon>[0]) {
  const daemon = await bootDaemon(options); registerFixtureServer(options?.wsPort ?? 4001, daemon.wsServer); return daemon;
}
const ownerFilter = (db: string) => `label=openhours-owner=${createHash('sha256').update(path.resolve(db)).digest('hex').slice(0, 16)}`;
import { PROVISIONAL_CONFIG } from '../src/daemon/config.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { MockLLMClient } from '../src/evals/llm-client.js';
import { dockerArgv } from '../src/kernel/docker-host.js';


/**
 * Wait for a broadcast event to actually ARRIVE at the client.
 *
 * The obvious form - poll SQLite for the status change, then search the already
 * received messages - loses a race: the server calls send() synchronously inside
 * the same transaction that flips the row, but delivery to this socket is async.
 * Under load the poll can observe the new status a tick before the frame lands,
 * which made the kill test fail intermittently in the full suite while passing
 * on its own. This still fails when the event is never sent; it just no longer
 * depends on delivery winning a footrace against a 200ms timer.
 */
async function waitForBroadcast(
  received: any[],
  eventType: string,
  timeoutMs = 10_000
): Promise<any | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = received.find(
      (m) => m.type === 'EXECUTION_EVENT' && m.event?.event_type === eventType
    );
    if (hit || Date.now() > deadline) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Phase 3: Thin Vertical Slice Integration', () => {
  // Unique per run: a handle leaked by one run must never block the next.
  const testDbPath = path.join(process.cwd(), `temp-vertical-slice-${process.pid}.db`);
  const basePort = 4010;

  const validParserCode = `// file: src/index.js
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
`;

  const invalidParserCode = `// file: src/index.js
export function parseArgs(argv) {
  throw new Error('Not implemented yet');
}
`;

  function cleanupDb() {
    const stuck: string[] = [];
    for (const ext of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${ext}`;
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch (err: any) {
          // Do NOT swallow. A file that will not delete means a SQLite handle is
          // still open, which is a resource leak worth seeing rather than hiding.
          stuck.push(`${path.basename(f)} (${err.code ?? err.message})`);
        }
      }
    }
    if (stuck.length > 0) {
      console.warn(`[vertical-slice] LEAKED DB HANDLE - could not remove: ${stuck.join(', ')}`);
    }
  }

  before(() => {
    cleanupDb();
  });

  after(() => {
    cleanupDb();
  });

  it('boots daemon, connects WS, executes task to completion, and attributes model_id', async () => {
    const mockLlm = new MockLLMClient({
      default: [validParserCode],
    });

    const daemon = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
      dbPath: testDbPath,
      wsPort: basePort,
      cadenceMs: 100, // fast tick
      maxConcurrency: 1,
      llmClient: mockLlm,
    });

    try {
      // 1. Connect real WebSocket client with listener registered BEFORE open
      const ws = new WebSocket(`ws://localhost:${basePort}`);
      const receivedMessages: any[] = [];

      ws.on('message', (data: import('ws').RawData) => {
        const msg = JSON.parse(data.toString());
        receivedMessages.push(msg);
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      // Wait for SYSTEM_HELLO
      await new Promise((r) => setTimeout(r, 200));
      const helloMsg = receivedMessages.find((m) => m.type === 'SYSTEM_HELLO');
      assert.ok(helloMsg, 'Client must receive SYSTEM_HELLO on connection');
      assert.ok(Array.isArray(helloMsg.payload?.agents), 'SYSTEM_HELLO must include agents array');
      assert.equal(helloMsg.payload.agents[0].id, 'agent-alpha');

      // 2. Queue a task run for agent-alpha
      const run = daemon.store.createTaskRun({
        agentId: 'agent-alpha',
        taskName: 'cli-arg-parser',
      });
      assert.equal(run.status, 'QUEUED');
      assert.equal(run.model_id, PROVISIONAL_CONFIG.PRIMARY_MODEL, 'task_run must attribute exact model_id');

      // 3. Wait for scheduler to pick up, run container, and complete task
      const startTime = Date.now();
      let completed = false;
      while (Date.now() - startTime < 30000) {
        const updated = daemon.store.getTaskRun(run.id);
        if (updated?.status === 'COMPLETED') {
          completed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      assert.ok(completed, 'Task run must reach COMPLETED status in SQLite');
      const finalRun = daemon.store.getTaskRun(run.id);
      assert.equal(finalRun?.model_id, PROVISIONAL_CONFIG.PRIMARY_MODEL);

      // 4. Verify streamed events carry attributed model_id
      const startedEvent = await waitForBroadcast(receivedMessages, 'TASK_STARTED');
      assert.ok(startedEvent, 'WS must receive TASK_STARTED event');
      assert.equal(startedEvent.event.model_id, PROVISIONAL_CONFIG.PRIMARY_MODEL);

      const turnEvent = await waitForBroadcast(receivedMessages, 'TURN_COMPLETED');
      assert.ok(turnEvent, 'WS must receive TURN_COMPLETED event');
      assert.equal(turnEvent.event.model_id, PROVISIONAL_CONFIG.PRIMARY_MODEL);

      const completedEvent = await waitForBroadcast(receivedMessages, 'TASK_COMPLETED');
      assert.ok(completedEvent, 'WS must receive TASK_COMPLETED event');
      assert.equal(completedEvent.event.model_id, PROVISIONAL_CONFIG.PRIMARY_MODEL);

      // 5. Verify Docker resources were completely cleaned up on completion
      const sweepCheck = await daemon.sandbox.orphanSweep({ forceAll: true });
      assert.equal(sweepCheck.reapedContainers, 0, 'Normal completion must leave 0 orphaned containers');
      assert.equal(sweepCheck.reapedVolumes, 0, 'Normal completion must leave 0 orphaned volumes');

      ws.close();
    } finally {
      await daemon.shutdown();
    }
  });

  it('handles operator kill command over WebSocket, aborting in-flight task immediately and leaving no Docker leaks', async () => {
    // LLM returns failing code across turns so task stays in loop
    const mockLlm = new MockLLMClient({
      default: [invalidParserCode, invalidParserCode, invalidParserCode],
    });

    const port = basePort + 1;
    const daemon = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
      dbPath: testDbPath,
      wsPort: port,
      cadenceMs: 100,
      maxConcurrency: 1,
      llmClient: mockLlm,
    });

    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      const receivedMessages: any[] = [];

      ws.on('message', (data: import('ws').RawData) => {
        const msg = JSON.parse(data.toString());
        receivedMessages.push(msg);
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      // Queue a task run
      const run = daemon.store.createTaskRun({
        agentId: 'agent-alpha',
        taskName: 'cli-arg-parser',
      });

      // Wait until task starts running
      const startWait = Date.now();
      while (Date.now() - startWait < 15000) {
        const updated = daemon.store.getTaskRun(run.id);
        if (updated?.status === 'RUNNING') break;
        await new Promise((r) => setTimeout(r, 200));
      }

      const activeStatus = daemon.store.getTaskRun(run.id);
      assert.equal(activeStatus?.status, 'RUNNING', 'Task must be in RUNNING state before kill');

      // Capture the task's own workspace volume BEFORE the kill. Without this the
      // teardown assertion below is vacuous: "nothing dangling" also holds when
      // nothing was ever created.
      const killDockerList = (args: string[]): string[] =>
        execFileSync(dockerArgv(args).command, dockerArgv(args).args, { encoding: 'utf-8' })
          .split(/\s+/).filter(Boolean);
      let volumesBeforeKill: string[] = [];
      const volumeDeadline = Date.now() + 15_000;
      while (!volumesBeforeKill.length && Date.now() < volumeDeadline) {
        volumesBeforeKill = killDockerList(['volume', 'ls', '-q', '--filter', ownerFilter(testDbPath)]).filter(v => v.includes(run.id));
        if (!volumesBeforeKill.length) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(volumesBeforeKill.length > 0,
        'Task must own a workspace volume before the kill, or the teardown assertion proves nothing');

      // Send operator kill command via WebSocket
      const killAck = await new Promise<any>((resolve) => {
        const onMsg = (data: import('ws').RawData) => {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'COMMAND_RESULT') {
            ws.off('message', onMsg);
            resolve(parsed.result);
          }
        };
        ws.on('message', onMsg);
        ws.send(
          JSON.stringify({
            command: 'kill',
            targetId: run.id,
          })
        );
      });

      assert.equal(killAck.success, true, 'Operator kill command must return success: true');

      // Wait for task to reach ABORTED status
      const abortWait = Date.now();
      let isAborted = false;
      while (Date.now() - abortWait < 15000) {
        const updated = daemon.store.getTaskRun(run.id);
        if (updated?.status === 'ABORTED') {
          isAborted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      assert.ok(isAborted, 'Task run must transition to ABORTED in SQLite');

      // Check for TASK_ABORTED event in WS messages
      const abortedEvent = await waitForBroadcast(receivedMessages, 'TASK_ABORTED');
      assert.ok(abortedEvent, 'WS must receive TASK_ABORTED event');
      assert.equal(abortedEvent.event.model_id, PROVISIONAL_CONFIG.PRIMARY_MODEL);

      // Teardown verification: Assert container teardown on kill actually leaves nothing behind
      // Read-only verification. Deliberately NOT orphanSweep({forceAll:true}) here:
      // that is destructive, so it would clean up the very leak it claims to detect
      // (and could delete resources belonging to other tests in the suite).
      const volumesAfterKill = killDockerList(['volume', 'ls', '-q', '--filter', 'label=agent-platform=1']);
      for (const v of volumesBeforeKill) {
        assert.ok(volumesAfterKill.includes(v),
          `Abort path must retain workspace volume ${v}; found it still present after kill`);
      }
      const containersAfterKill = killDockerList(['ps', '-aq', '--filter', ownerFilter(testDbPath)]);
      assert.equal(containersAfterKill.length, 0,
        'Abort path must leave zero platform containers behind');

      ws.close();
    } finally {
      await daemon.shutdown();
    }
  });

  it('boot sweep transitions orphaned RUNNING rows to CRASHED and sweeps stale dispatched reservations to UNRECONCILED_ASSUMED_SPENT', async () => {
    // 1. Direct database state setup representing a previous daemon that died unexpectedly mid-flight
    const store1 = new AgentStore(testDbPath);
    const ledger1 = new CostLedger(testDbPath);

    const agent = store1.getAgent('agent-alpha');
    if (!agent) {
      store1.createAgent({
        id: 'agent-alpha',
        name: 'Alpha Worker',
        model_id: PROVISIONAL_CONFIG.PRIMARY_MODEL,
        budget_cap_usd: 10.0,
        current_status: 'IDLE',
      });
    }

    const run = store1.createTaskRun({
      agentId: 'agent-alpha',
      taskName: 'cli-arg-parser',
    });
    store1.startTaskRun(run.id, PROVISIONAL_CONFIG.PRIMARY_MODEL);
    store1.updateAgentStatus('agent-alpha', 'BUSY');

    // Create a dispatched reservation that expired (simulating a crash where reservation wasn't closed)
    const res = ledger1.reserve(run.id, 'agent-alpha', PROVISIONAL_CONFIG.PRIMARY_MODEL);
    ledger1.markDispatched(res.id);
    store1.getDatabase().prepare(`UPDATE cost_reservations SET expires_at = ? WHERE id = ?`).run(Date.now() - 1000, res.id);

    store1.close();
    ledger1.close();

    // 2. Boot Daemon on this database
    const port = basePort + 2;
    const daemon = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
      dbPath: testDbPath,
      wsPort: port,
      cadenceMs: 100,
      maxConcurrency: 1,
    });

    try {
      // Assert: Run transitioned to CRASHED by boot crash sweep
      const crashedRun = daemon.store.getTaskRun(run.id);
      assert.equal(crashedRun?.status, 'CRASHED', 'Orphaned RUNNING task must be transitioned to CRASHED on boot');
      assert.ok(crashedRun?.error_message?.includes('Daemon startup sweep'), 'Must carry explicit crash sweep reason');

      // Assert: Expired dispatched reservation transitioned to UNRECONCILED_ASSUMED_SPENT
      const db = daemon.store.getDatabase();
      const sweptRes = db.prepare(`SELECT * FROM cost_reservations WHERE id = ?`).get(res.id) as any;
      assert.equal(
        sweptRes?.status,
        'UNRECONCILED_ASSUMED_SPENT',
        'Stale reservation with dispatched_at must transition to UNRECONCILED_ASSUMED_SPENT on boot sweep'
      );

      // Assert: Agent status was reset from BUSY to IDLE
      const agentAfter = daemon.store.getAgent('agent-alpha');
      assert.equal(agentAfter?.current_status, 'IDLE');
    } finally {
      await daemon.shutdown();
    }
  });

  it('supports pause and resume commands for agents over WebSocket', async () => {
    const port = basePort + 4;
    const daemon = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
      dbPath: testDbPath,
      wsPort: port,
      cadenceMs: 100,
      maxConcurrency: 1,
    });

    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      // Flush welcome message first
      await new Promise((r) => setTimeout(r, 200));

      const sendCmd = (cmd: any) =>
        new Promise<any>((resolve) => {
          const handler = (data: import('ws').RawData) => {
            const parsed = JSON.parse(data.toString());
            if (parsed.type === 'COMMAND_RESULT') {
              ws.off('message', handler);
              resolve(parsed.result);
            }
          };
          ws.on('message', handler);
          ws.send(JSON.stringify(cmd));
        });

      const pauseRes = await sendCmd({ command: 'pause', targetId: 'agent-alpha' });
      assert.equal(pauseRes.success, true);
      assert.equal(daemon.store.getAgent('agent-alpha')?.current_status, 'PAUSED');

      const resumeRes = await sendCmd({ command: 'resume', targetId: 'agent-alpha' });
      assert.equal(resumeRes.success, true);
      assert.equal(daemon.store.getAgent('agent-alpha')?.current_status, 'IDLE');

      ws.close();
    } finally {
      await daemon.shutdown();
    }
  });

  it('prunes execution events older than retention cutoff', async () => {
    const port = basePort + 5;
    const daemon = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
      dbPath: testDbPath,
      wsPort: port,
      cadenceMs: 100,
      maxConcurrency: 1,
    });

    try {
      const db = daemon.store.getDatabase();
      const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
      const recentTime = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago

      // Seed a task run and old/recent events
      const run = daemon.store.createTaskRun({
        agentId: 'agent-alpha',
        taskName: 'cli-arg-parser',
      });

      db.prepare(`
        INSERT INTO execution_events (task_run_id, agent_id, model_id, event_type, turn_number, payload_json, timestamp)
        VALUES (?, ?, ?, 'OLD_EVENT', 1, '{}', ?)
      `).run(run.id, 'agent-alpha', PROVISIONAL_CONFIG.PRIMARY_MODEL, oldTime);

      db.prepare(`
        INSERT INTO execution_events (task_run_id, agent_id, model_id, event_type, turn_number, payload_json, timestamp)
        VALUES (?, ?, ?, 'RECENT_EVENT', 2, '{}', ?)
      `).run(run.id, 'agent-alpha', PROVISIONAL_CONFIG.PRIMARY_MODEL, recentTime);

      const pruned = daemon.store.pruneOldEvents(7); // 7-day cutoff
      assert.equal(pruned, 1, 'Should prune exactly 1 event older than 7 days');

      const remaining = daemon.store.getTaskEvents(run.id);
      assert.ok(remaining.some((e) => e.event_type === 'RECENT_EVENT'), 'Recent event must be retained');
      assert.ok(!remaining.some((e) => e.event_type === 'OLD_EVENT'), 'Old event must have been pruned');
    } finally {
      await daemon.shutdown();
    }
  });

  it('recovers from a REAL SIGKILL: CRASHED transition, orphan container reaped, dispatched reservation preserved as spent', async () => {
    const crashDb = path.join(process.cwd(), 'temp-crash-sigkill.db');
    const wipe = () => {
      for (const ext of ['', '-wal', '-shm']) {
        const f = `${crashDb}${ext}`;
        if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch { /* busy */ } }
      }
    };
    wipe();

    const port = basePort + 8;
    const daemonEntry = path.join(process.cwd(), 'dist', 'src', 'daemon', 'index.js');
    assert.ok(fs.existsSync(daemonEntry), `Daemon entrypoint must be built first: ${daemonEntry}`);

    const dockerList = (args: string[]): string[] => {
      const out = execFileSync(dockerArgv(args).command, dockerArgv(args).args, { encoding: 'utf-8' });
      return out.split(/\s+/).filter(Boolean);
    };
    const listContainers = () => dockerList(['ps', '-aq', '--filter', ownerFilter(crashDb)]);
    const listVolumes = () => dockerList(['volume', 'ls', '-q', '--filter', 'label=agent-platform=1']);

    const child = spawn(process.execPath, [daemonEntry], {
      env: {
        ...process.env,
        OPENHOURS_DB_PATH: crashDb,
        OPENHOURS_PORT: String(port),
        OPENHOURS_CADENCE_MS: '100',
        OPENHOURS_MAX_CONCURRENCY: '1',
        OPENHOURS_LLM_MODE: 'mock',
        OPENHOURS_LLM_MOCK_DELAY_MS: '10000',
        // The child boots in the repo root, so without this it would pick up a
        // developer's openhours.config.json and seed a different fleet than the
        // agent-alpha this test creates a run for.
        OPENHOURS_CONFIG: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });

    try {
      const bootDeadline = Date.now() + 90_000;
      while (Date.now() < bootDeadline && !log.includes('DAEMON ACTIVE')) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(log.includes('DAEMON ACTIVE'), `Child daemon did not boot:
${log}`);
      assert.ok(log.includes('MockLLMClient is active'), 'Mock mode must announce itself loudly at boot');

      const client = new AgentStore(crashDb);
      const run = client.createTaskRun({ agentId: 'agent-alpha', taskName: 'cli-arg-parser' });

      // Gate the kill on a DISPATCHED reservation, not merely on a live container:
      // the staging-helper container exists before any LLM call, so killing on
      // "a container is up" would fire before the first turn is dispatched.
      const clientDb = client.getDatabase();
      let liveAtKill: string[] = [];
      let volumesAtKill: string[] = [];
      let res: any = null;
      const runDeadline = Date.now() + 90_000;
      while (Date.now() < runDeadline) {
        if (client.getTaskRun(run.id)?.status === 'RUNNING') {
          res = clientDb
            .prepare('SELECT * FROM cost_reservations WHERE task_id = ? AND dispatched_at IS NOT NULL')
            .get(run.id) as any;
          if (res) {
            // The task volume lives for the whole task; the executor container only
            // exists between LLM calls. The volume is therefore the reliable orphan.
            volumesAtKill = listVolumes().filter((v) => v.includes(run.id));
            liveAtKill = listContainers();
            if (volumesAtKill.length > 0) break;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      assert.equal(client.getTaskRun(run.id)?.status, 'RUNNING', 'Task must be RUNNING before the kill');
      assert.ok(res, 'A dispatched turn must have written a cost reservation before the kill');
      assert.ok(res.dispatched_at, 'Reservation must carry dispatched_at before the crash');
      assert.ok(volumesAtKill.length > 0,
        'A task volume must exist at kill time, otherwise the orphan-reap assertion is vacuous');
      assert.equal(res.status, 'PENDING', 'Kill must land while the dispatch is still in flight');

      // REAL crash: no finally blocks, no WAL checkpoint, container left running.
      child.kill('SIGKILL');
      await new Promise<void>((r) => child.once('exit', () => r()));

      assert.ok(listVolumes().some((v) => volumesAtKill.includes(v)),
        'Task volume must survive SIGKILL for later inspection');

      // Age the reservation so the sweep sees it as expired. This simulates elapsed
      // time only; the dispatched_at branch is what is actually under test.
      clientDb.prepare('UPDATE cost_reservations SET expires_at = ? WHERE id = ?')
        .run(Date.now() - 1000, res.id);
      client.close();

      const daemon2 = await startDaemon({
      configPath: null, // ignore any openhours.config.json in the working directory
        dbPath: crashDb,
        wsPort: port + 1,
        cadenceMs: 100,
        maxConcurrency: 1,
        llmClient: new MockLLMClient(),
      });

      try {
        assert.equal(daemon2.store.getTaskRun(run.id)?.status, 'CRASHED',
          'A task orphaned by SIGKILL must be marked CRASHED by the boot sweep');

        const volsAfter = listVolumes();
        for (const v of volumesAtKill) {
          assert.ok(volsAfter.includes(v), `Retained workspace ${v} must survive the boot sweep`);
        }
        const consAfter = listContainers();
        for (const id of liveAtKill) {
          assert.ok(!consAfter.includes(id), `Orphan container ${id} must be reaped by the boot sweep`);
        }

        const swept = daemon2.store.getDatabase()
          .prepare('SELECT * FROM cost_reservations WHERE id = ?').get(res.id) as any;
        assert.equal(swept.status, 'UNRECONCILED_ASSUMED_SPENT',
          'A reservation dispatched before the crash must be assumed spent, never zeroed');
      } finally {
        await daemon2.shutdown();
      }
    } finally {
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      wipe();
    }
  });

});
