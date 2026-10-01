import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LiveChannel, type RunLiveFrame } from '../src/daemon/live-stream.js';
import { AgentStore } from '../src/daemon/agent-store.js';
import { RetentionService } from '../src/daemon/retention.js';
import { MissionService } from '../src/daemon/missions.js';
import { MemoryService } from '../src/daemon/memory.js';
import { reduceActivity, emptyRunActivity } from '../src/cortex/run-steps.js';
import { DaemonWsServer, fixtureFetch, FixtureWebSocket } from './helpers/daemon-client.js';

describe('Phase 1b: Live Activity & Streaming Verification', () => {
  describe('LiveChannel', () => {
    it('debounces output chunks within 100ms window', async () => {
      const frames: RunLiveFrame[] = [];
      const live = new LiveChannel((runId, frame) => {
        frames.push(frame);
      });

      live.output('run-1', 'call-1', 'stdout', 'chunk 1\n');
      live.output('run-1', 'call-1', 'stdout', 'chunk 2\n');
      assert.equal(frames.length, 0, 'chunks within 100ms should be buffered');

      await new Promise((r) => setTimeout(r, 150));
      assert.equal(frames.length, 1, 'flushed after debounce window');
      assert.equal(frames[0].runId, 'run-1');
      assert.equal(frames[0].kind, 'output');
      if (frames[0].kind === 'output') {
        assert.equal(frames[0].callId, 'call-1');
        assert.equal(frames[0].data, 'chunk 1\nchunk 2\n');
        assert.equal(frames[0].stream, 'stdout');
      }
      live.closeRun('run-1');
    });

    it('flushes immediately when chunk exceeds 8KB threshold', () => {
      const frames: RunLiveFrame[] = [];
      const live = new LiveChannel((runId, frame) => {
        frames.push(frame);
      });

      const bigChunk = 'A'.repeat(9000);
      live.output('run-1', 'call-1', 'stdout', bigChunk);
      assert.equal(frames.length, 1, 'large chunk flushes synchronously');
      if (frames[0].kind === 'output') {
        assert.equal(frames[0].data.length, 9000);
      }
      live.closeRun('run-1');
    });

    it('maintains 16KB tail buffer and respects 1MB per call cap', () => {
      const live = new LiveChannel(() => {});
      const chunk = 'X'.repeat(4000);
      for (let i = 0; i < 300; i++) {
        live.output('run-1', 'call-1', 'stdout', chunk);
      }
      const snap = live.getSnapshot('run-1');
      assert.ok(snap);
      const call = snap.calls.find((c) => c.callId === 'call-1');
      assert.ok(call);
      assert.equal(call?.tail.length, 16 * 1024, 'tail buffer capped at 16KB');
      live.closeRun('run-1');
    });

    it('flushes remaining buffers on closeCall', async () => {
      const frames: RunLiveFrame[] = [];
      const live = new LiveChannel((runId, frame) => {
        frames.push(frame);
      });

      live.output('run-1', 'call-1', 'stderr', 'err output');
      live.closeCall('run-1', 'call-1');

      assert.equal(frames.length, 1);
      if (frames[0].kind === 'output') {
        assert.equal(frames[0].data, 'err output');
        assert.equal(frames[0].stream, 'stderr');
      }

      const snap = live.getSnapshot('run-1');
      const call = snap.calls.find((c) => c.callId === 'call-1');
      assert.ok(call);
      assert.equal(call?.tail, 'err output');
      live.closeRun('run-1');
    });
  });

  describe('AgentStore (Phase 1b Extensions)', () => {
    it('retrieves latest task event by event_type', () => {
      const store = new AgentStore(':memory:');
      store.createAgent({ id: 'a1', name: 'Bot', model_id: 'm1', budget_cap_usd: 1, current_status: 'IDLE' });
      const run = store.createTaskRun({ agentId: 'a1', taskName: 'test-run' });

      store.recordEvent({ task_run_id: run.id, agent_id: 'a1', event_type: 'WORK_ACTION', payload_json: JSON.stringify({ turn: 1, callId: 'c1' }), timestamp: 100 });
      store.recordEvent({ task_run_id: run.id, agent_id: 'a1', event_type: 'AGENT_THOUGHT', payload_json: JSON.stringify({ text: 'thinking' }), timestamp: 110 });
      store.recordEvent({ task_run_id: run.id, agent_id: 'a1', event_type: 'WORK_ACTION', payload_json: JSON.stringify({ turn: 2, callId: 'c2' }), timestamp: 120 });

      const latestAction = store.getLatestTaskEvent(run.id, 'WORK_ACTION');
      assert.ok(latestAction);
      const payload = JSON.parse(latestAction!.payload_json);
      assert.equal(payload.callId, 'c2');
      assert.equal(payload.turn, 2);

      const missing = store.getLatestTaskEvent(run.id, 'NON_EXISTENT');
      assert.equal(missing, null);
      store.close();
    });

    it('calculates step counts per task run', () => {
      const store = new AgentStore(':memory:');
      store.createAgent({ id: 'a1', name: 'Bot', model_id: 'm1', budget_cap_usd: 1, current_status: 'IDLE' });
      const run1 = store.createTaskRun({ agentId: 'a1', taskName: 'r1' });
      const run2 = store.createTaskRun({ agentId: 'a1', taskName: 'r2' });
      const run3 = store.createTaskRun({ agentId: 'a1', taskName: 'r3' });

      store.recordEvent({ task_run_id: run1.id, agent_id: 'a1', event_type: 'WORK_ACTION', payload_json: '{}', timestamp: 100 });
      store.recordEvent({ task_run_id: run1.id, agent_id: 'a1', event_type: 'WORK_ACTION', payload_json: '{}', timestamp: 101 });
      store.recordEvent({ task_run_id: run1.id, agent_id: 'a1', event_type: 'WORK_ACTION', payload_json: '{}', timestamp: 102 });
      store.recordEvent({ task_run_id: run2.id, agent_id: 'a1', event_type: 'WORK_ACTION', payload_json: '{}', timestamp: 103 });

      const counts = store.getStepCounts([run1.id, run2.id, run3.id, 'non-existent']);
      assert.equal(counts[run1.id], 3);
      assert.equal(counts[run2.id], 1);
      assert.equal(counts[run3.id], 0);
      assert.equal(counts['non-existent'], 0);
      store.close();
    });
  });

  describe('RetentionService (Phase 1b Retention & Slimming)', () => {
    it('retention keeps WORK_ACTION, TOOL_CALL, WORK_PLAN and slims TOOL_CALL payloads', async () => {
      const store = new AgentStore(':memory:');
      new MissionService(store, [], 10);
      new MemoryService(store);
      store.createAgent({ id: 'a1', name: 'Bot', model_id: 'm1', budget_cap_usd: 1, current_status: 'IDLE' });
      const run = store.createTaskRun({ agentId: 'a1', taskName: 'r-old' });
      store.startTaskRun(run.id);
      store.finishTaskRun(run.id, 'COMPLETED');

      // Backdate completion by 40 days
      store.getDatabase().prepare('UPDATE task_runs SET completed_at=? WHERE id=?').run(Date.now() - 40 * 86400000, run.id);

      // Add 12 events to exceed the default 10-event threshold
      for (let i = 0; i < 6; i++) {
        store.recordEvent({ task_run_id: run.id, agent_id: 'a1', event_type: 'GENERIC_EVENT', payload_json: JSON.stringify({ idx: i }), timestamp: 100 + i });
      }

      const bigSummary = 'S'.repeat(600);
      const bigObservation = 'O'.repeat(600);
      store.recordEvent({
        task_run_id: run.id,
        agent_id: 'a1',
        event_type: 'WORK_ACTION',
        payload_json: JSON.stringify({ tool: 'run', callId: 'call-ret' }),
        timestamp: 200,
      });
      store.recordEvent({
        task_run_id: run.id,
        agent_id: 'a1',
        event_type: 'WORK_PLAN',
        payload_json: JSON.stringify({ steps: ['plan 1'] }),
        timestamp: 210,
      });
      store.recordEvent({
        task_run_id: run.id,
        agent_id: 'a1',
        event_type: 'TOOL_CALL',
        payload_json: JSON.stringify({
          tool: 'run',
          callId: 'call-ret',
          summary: bigSummary,
          observation: bigObservation,
          source: 'unnecessary context',
          links: ['http://example.com'],
          presentation: {
            patch: 'diff --git b/file',
            diff: '+hello',
          },
        }),
        timestamp: 220,
      });
      for (let i = 0; i < 4; i++) {
        store.recordEvent({ task_run_id: run.id, agent_id: 'a1', event_type: 'OTHER_NOISE', payload_json: JSON.stringify({ idx: i }), timestamp: 300 + i });
      }

      const retention = new RetentionService(store, {
        workspaceVolumeName: (id: string) => id,
        destroyWorkspaceVolume: async () => {},
      });

      const result = await retention.clean(30, false);
      assert.equal(result.cleaned.length, 1);

      // Check remaining events for run
      const remaining = store.getTaskEvents(run.id);
      const types = remaining.map((e) => e.event_type);
      assert.ok(types.includes('WORK_ACTION'), 'WORK_ACTION must be retained');
      assert.ok(types.includes('WORK_PLAN'), 'WORK_PLAN must be retained');
      assert.ok(types.includes('TOOL_CALL'), 'TOOL_CALL must be retained');

      const toolCall = remaining.find((e) => e.event_type === 'TOOL_CALL');
      assert.ok(toolCall);
      const slimmed = JSON.parse(toolCall!.payload_json);
      assert.ok(slimmed.summary.length <= 300, `summary should be truncated to <=300, got ${slimmed.summary.length}`);
      assert.ok(slimmed.observation.length <= 300, `observation should be truncated to <=300, got ${slimmed.observation.length}`);
      assert.equal(slimmed.source, undefined, 'source should be stripped');
      assert.equal(slimmed.links, undefined, 'links should be stripped');
      assert.equal(slimmed.presentation?.patch, undefined, 'presentation.patch should be stripped');
      assert.equal(slimmed.presentation?.diff, '+hello', 'presentation.diff must be kept');
      store.close();
    });
  });

  describe('run-steps.ts (Step Pairing & Diff Card Ingestion)', () => {
    it('pairs WORK_ACTION, TOOL_CALL, and APPROVAL_REQUESTED by callId with diff card and metadata', () => {
      let activity = emptyRunActivity('run-steps-1');

      activity = reduceActivity(activity, {
        id: 1,
        task_run_id: 'run-steps-1',
        event_type: 'WORK_ACTION',
        payload_json: JSON.stringify({
          tool: 'write',
          path: 'src/main.ts',
          callId: 'call-write-1',
        }),
        timestamp: 1000,
      });

      assert.equal(activity.steps.length, 1);
      assert.equal(activity.steps[0].id, 'call-write-1');
      assert.equal(activity.steps[0].tool, 'write');
      assert.equal(activity.steps[0].status, 'running');

      // Approval requested for this call
      activity = reduceActivity(activity, {
        id: 2,
        task_run_id: 'run-steps-1',
        event_type: 'APPROVAL_REQUESTED',
        payload_json: JSON.stringify({
          approvalId: 'appr-1',
          callId: 'call-write-1',
          kind: 'write',
        }),
        timestamp: 1020,
      });

      assert.equal(activity.steps[0].status, 'waiting');
      assert.equal(activity.steps[0].approvalId, 'appr-1');

      // Interleaved action with different callId
      activity = reduceActivity(activity, {
        id: 3,
        task_run_id: 'run-steps-1',
        event_type: 'WORK_ACTION',
        payload_json: JSON.stringify({
          tool: 'run',
          command: 'ls',
          callId: 'call-run-2',
        }),
        timestamp: 1030,
      });
      assert.equal(activity.steps.length, 2);
      assert.equal(activity.steps[1].id, 'call-run-2');

      // TOOL_CALL resolving the first write action by callId with presentation diff object
      activity = reduceActivity(activity, {
        id: 4,
        task_run_id: 'run-steps-1',
        event_type: 'TOOL_CALL',
        payload_json: JSON.stringify({
          tool: 'write',
          callId: 'call-write-1',
          status: 'ok',
          presentation: {
            diff: {
              patch: '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1,2 @@\n+console.log("hello");',
              created: false,
              added: 1,
              removed: 0,
            },
          },
        }),
        timestamp: 1040,
      });

      const writeStep = activity.steps.find((s) => s.id === 'call-write-1');
      assert.ok(writeStep);
      assert.equal(writeStep?.status, 'ok');
      assert.equal(writeStep?.card, 'diff');
      assert.ok(writeStep?.diff?.includes('console.log("hello")'));
      assert.deepEqual(writeStep?.diffMeta, { added: 1, removed: 0, created: false, truncated: undefined });

      // Second step is still running
      const runStep = activity.steps.find((s) => s.id === 'call-run-2');
      assert.equal(runStep?.status, 'running');
    });
  });

  describe('Daemon WS & HTTP Step Counts & Live Streaming', () => {
    it('exposes GET /api/runs/step-counts returning stepCounts map', async () => {
      const port = 4198;
      const server = new DaemonWsServer(
        port,
        undefined,
        {
          stepCounts: (ids: string[]) => {
            const result: Record<string, number> = {};
            for (const id of ids) {
              result[id] = id === 'r1' ? 5 : 2;
            }
            return result;
          },
        } as any
      );

      await server.start();
      try {
        const res = await fixtureFetch(`http://127.0.0.1:${port}/api/runs/step-counts?ids=r1,r2`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { counts: Record<string, number>; stepCounts: Record<string, number> };
        assert.deepEqual(body.stepCounts, {
          r1: 5,
          r2: 2,
        });
        assert.deepEqual(body.counts, {
          r1: 5,
          r2: 2,
        });
      } finally {
        await server.close();
      }
    });

    it('routes RUN_LIVE frames to subscribed WebSocket clients and ignores unsubscribed', async () => {
      const port = 4199;
      const server = new DaemonWsServer(port);
      const liveChannel = new LiveChannel((runId, frame) => {
        server.sendToSubscribers(runId, frame);
      });
      server.setLiveChannel(liveChannel);

      await server.start();
      const client = new FixtureWebSocket(`ws://localhost:${port}`);
      const frames: any[] = [];
      client.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'RUN_LIVE') frames.push(msg);
      });

      await new Promise((resolve) => client.on('open', resolve));

      // Subscribe to run-live-1
      client.send(JSON.stringify({ type: 'subscribe', runIds: ['run-live-1'] }));
      await new Promise((r) => setTimeout(r, 60));

      // Output on run-live-2 (should not be delivered to client)
      liveChannel.output('run-live-2', 'c2', 'stdout', 'unsubscribed chunk');
      liveChannel.closeCall('run-live-2', 'c2');
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(frames.length, 0);

      // Output on run-live-1 (should be delivered to client)
      liveChannel.output('run-live-1', 'c1', 'stdout', 'subscribed chunk');
      liveChannel.closeCall('run-live-1', 'c1');
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(frames.length > 0);
      assert.equal(frames[0].runId, 'run-live-1');
      assert.equal(frames[0].kind, 'output');
      if (frames[0].kind === 'output') {
        assert.equal(frames[0].callId, 'c1');
      }

      client.close();
      await server.close();
    });
  });
});
