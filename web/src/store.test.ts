import { test, expect, vi } from 'vitest';
import { useCortex } from './store';
import * as transport from './lib/transport';
const api = transport.api;

test('changing bot clears the old activity and ignores its late event response', async () => {
  let reject!: (error: Error) => void;
  vi.spyOn(api, 'runEvents').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  useCortex.setState({ selectedAgentId: 'a', selectedRunId: null, taskRuns: [{ id: 'run-a', agent_id: 'a' } as any] });
  const pending = useCortex.getState().selectRun('run-a');
  useCortex.getState().selectAgent('b');
  reject(new Error('old request failed')); await pending;
  expect(useCortex.getState().selectedAgentId).toBe('b');
  expect(useCortex.getState().selectedRunId).toBeNull();
  expect(useCortex.getState().events).toEqual([]);
  expect(useCortex.getState().error).toBeNull();
});

test('capability connections come only from daemon state', () => {
  useCortex.setState({ agents: [{ id: 'a', capabilities: ['tool-cost-ledger'] }, { id: 'b' }] as any });
  expect(useCortex.getState().isCapabilityLinked('a', 'tool-cost-ledger')).toBe(true);
  expect(useCortex.getState().isCapabilityLinked('a', 'mcp-any-server')).toBe(false);
  expect(useCortex.getState().isCapabilityLinked('b', 'tool-opencode')).toBe(false);
});

test('watchRun reference counting and cleanup', async () => {
  vi.spyOn(api, 'runEvents').mockResolvedValue({ runId: 'run-ref', events: [], latestEventId: null });
  useCortex.setState({ liveRuns: {} });

  const unwatch1 = useCortex.getState().watchRun('run-ref');
  expect(useCortex.getState().liveRuns['run-ref']?.watchers).toBe(1);

  const unwatch2 = useCortex.getState().watchRun('run-ref');
  expect(useCortex.getState().liveRuns['run-ref']?.watchers).toBe(2);

  unwatch1();
  expect(useCortex.getState().liveRuns['run-ref']?.watchers).toBe(1);

  unwatch2();
  expect(useCortex.getState().liveRuns['run-ref']).toBeUndefined();
});

test('socket events merge into liveRuns, deduplicate, and map requests', async () => {
  let capturedHandlers: any = null;
  vi.spyOn(transport, 'connect').mockImplementation((handlers) => {
    capturedHandlers = handlers;
    return () => { capturedHandlers = null; };
  });

  vi.spyOn(api, 'runEvents').mockResolvedValue({
    runId: 'run-chat-1',
    latestEventId: 2,
    events: [
      { id: 1, event_type: 'WORK_ACTION', payload: { tool: 'plan' }, timestamp: 100 } as any,
      { id: 2, event_type: 'TOOL_CALL', payload: { tool: 'plan', status: 'ok' }, timestamp: 200 } as any,
    ],
  });
  vi.spyOn(api, 'state').mockResolvedValue({ agents: [], taskRuns: [], serverTime: 1000 });

  useCortex.setState({ liveRuns: {}, runForRequest: {}, selectedRunId: null });
  const stop = useCortex.getState().start();
  expect(capturedHandlers).not.toBeNull();

  // Watch run-chat-1
  useCortex.getState().watchRun('run-chat-1');
  // Wait for initial backfill to resolve
  await new Promise((r) => setTimeout(r, 10));

  const state1 = useCortex.getState().liveRuns['run-chat-1'];
  expect(state1?.events).toHaveLength(2);
  expect(state1?.activity.steps).toHaveLength(1);
  expect(state1?.activity.steps[0].status).toBe('ok');

  // Emit socket event for the watched run with a new event id 3
  capturedHandlers.onEvent({
    id: 3,
    task_run_id: 'run-chat-1',
    event_type: 'WORK_ACTION',
    payload: { tool: 'run', command: 'npm test' },
    timestamp: 300,
  });

  const state2 = useCortex.getState().liveRuns['run-chat-1'];
  expect(state2?.events).toHaveLength(3);
  expect(state2?.activity.steps).toHaveLength(2);
  expect(state2?.activity.steps[1].status).toBe('running');

  // Emit duplicate socket event with id 3 - should be ignored
  capturedHandlers.onEvent({
    id: 3,
    task_run_id: 'run-chat-1',
    event_type: 'WORK_ACTION',
    payload: { tool: 'run', command: 'npm test' },
    timestamp: 300,
  });
  expect(useCortex.getState().liveRuns['run-chat-1']?.events).toHaveLength(3);

  // Emit TASK_STARTED with threadId and requestId mapping
  capturedHandlers.onEvent({
    id: 4,
    task_run_id: 'run-chat-1',
    event_type: 'TASK_STARTED',
    payload: { threadId: 'thread-alpha', requestId: 'req-123' },
    timestamp: 400,
  });
  expect(useCortex.getState().runForRequest['thread-alpha:req-123']).toBe('run-chat-1');

  stop();
});

test('backfill on reconnect updates active watched runs', async () => {
  let capturedHandlers: any = null;
  vi.spyOn(transport, 'connect').mockImplementation((handlers) => {
    capturedHandlers = handlers;
    return () => { capturedHandlers = null; };
  });

  const runEventsSpy = vi.spyOn(api, 'runEvents');
  runEventsSpy.mockResolvedValueOnce({ runId: 'run-recon', events: [], latestEventId: null }); // initial watchRun call

  useCortex.setState({ liveRuns: {}, selectedRunId: null });
  const stop = useCortex.getState().start();

  useCortex.getState().watchRun('run-recon');
  await new Promise((r) => setTimeout(r, 10));

  // Simulate socket reconnect (onHello) with new events returned by backfill
  runEventsSpy.mockResolvedValueOnce({
    runId: 'run-recon',
    latestEventId: 10,
    events: [
      { id: 10, event_type: 'WORK_ACTION', payload: { tool: 'read' }, timestamp: 500 } as any,
    ],
  });

  capturedHandlers.onHello({ agents: [], taskRuns: [] });
  await new Promise((r) => setTimeout(r, 10));

  const state = useCortex.getState().liveRuns['run-recon'];
  expect(state?.events).toHaveLength(1);
  expect(state?.activity.steps).toHaveLength(1);
  expect(state?.activity.steps[0].tool).toBe('read');

  stop();
});

test('cortex path remains unchanged by liveRuns activity', async () => {
  let capturedHandlers: any = null;
  vi.spyOn(transport, 'connect').mockImplementation((handlers) => {
    capturedHandlers = handlers;
    return () => { capturedHandlers = null; };
  });
  vi.spyOn(api, 'runEvents').mockResolvedValue({ runId: 'chat-run-xyz', events: [], latestEventId: null });
  vi.spyOn(api, 'state').mockResolvedValue({ agents: [], taskRuns: [], serverTime: 1000 });

  useCortex.setState({
    selectedRunId: 'cortex-active-run',
    events: [],
    liveRuns: {},
  });

  const stop = useCortex.getState().start();
  // Watch a different chat run
  useCortex.getState().watchRun('chat-run-xyz');

  // Event for chat run should NOT affect cortex selectedRunId events
  capturedHandlers.onEvent({
    id: 1,
    task_run_id: 'chat-run-xyz',
    event_type: 'WORK_ACTION',
    payload: { tool: 'read' },
    timestamp: 100,
  });

  expect(useCortex.getState().events).toHaveLength(0);
  expect(useCortex.getState().liveRuns['chat-run-xyz']?.events).toHaveLength(1);

  // Event for cortex-active-run SHOULD update cortex events
  capturedHandlers.onEvent({
    id: 2,
    task_run_id: 'cortex-active-run',
    event_type: 'WORK_ACTION',
    payload: { tool: 'plan' },
    timestamp: 200,
  });

  expect(useCortex.getState().events).toHaveLength(1);
  expect(useCortex.getState().events[0].id).toBe(2);

  stop();
});

test('publish and acknowledgement events refresh the routines; other run events do not', async () => {
  let capturedHandlers: any = null;
  vi.spyOn(transport, 'connect').mockImplementation((handlers) => {
    capturedHandlers = handlers;
    return () => { capturedHandlers = null; };
  });
  vi.spyOn(api, 'state').mockResolvedValue({ agents: [], taskRuns: [], serverTime: 1000 });
  const routines = vi.spyOn(api, 'routines').mockResolvedValue({ routines: [] });
  useCortex.setState({ liveRuns: {}, selectedRunId: null, events: [] });
  const stop = useCortex.getState().start();
  await new Promise((r) => setTimeout(r, 10));
  routines.mockClear(); // start() loads the routines once

  const socketEvent = (id: number, event_type: string, payload: Record<string, unknown>) =>
    capturedHandlers.onEvent({ id, task_run_id: 'run-post', agent_id: 'milo', event_type, payload_json: JSON.stringify(payload), timestamp: 1000 + id });
  socketEvent(1, 'WORK_ACTION', { tool: 'browser', action: 'click' });
  expect(routines).not.toHaveBeenCalled();
  socketEvent(2, 'PUBLISH_OBSERVED', { publishId: 'pub-1', outcome: 'confirmed', settledAt: 1002 });
  expect(routines).toHaveBeenCalledTimes(1);
  socketEvent(3, 'EXTERNAL_ACTION_ACKNOWLEDGED', { key: 'act-1', kind: 'action', by: 'operator', at: 1003 });
  expect(routines).toHaveBeenCalledTimes(2);

  stop();
});

