import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureWebSocket as WebSocket } from './helpers/daemon-client.js';
import { DaemonWsServer } from './helpers/daemon-client.js';

test('DaemonWsServer: handshake, event broadcasting, and operator command dispatch', async () => {
  const port = 4098;
  const server = new DaemonWsServer(port);

  let commandReceived: any = null;
  server.onCommand(async (cmd) => {
    commandReceived = cmd;
    return { success: true, message: `Action ${cmd.command} executed on ${cmd.targetId}` };
  });

  await server.start();

  // 1. Connect WS client
  const client = new WebSocket(`ws://localhost:${port}`);

  const messages: any[] = [];
  client.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  await new Promise((resolve) => client.on('open', resolve));

  // Wait for SYSTEM_HELLO
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(messages.some((m) => m.type === 'SYSTEM_HELLO'));

  // 2. Broadcast an execution event
  const mockEvent = {
    id: 1,
    task_run_id: 'task-999',
    agent_id: 'agent-1',
    event_type: 'TURN_COMPLETED',
    turn_number: 1,
    payload_json: JSON.stringify({ passed: false }),
    timestamp: Date.now(),
  };
  server.broadcast(mockEvent);

  await new Promise((r) => setTimeout(r, 50));
  const broadcastMsg = messages.find((m) => m.type === 'EXECUTION_EVENT');
  assert.ok(broadcastMsg);
  assert.equal(broadcastMsg.event.task_run_id, 'task-999');
  assert.equal(broadcastMsg.event.event_type, 'TURN_COMPLETED');

  // 3. Send operator kill command from client
  client.send(
    JSON.stringify({
      command: 'kill',
      targetId: 'task-999',
    })
  );

  await new Promise((r) => setTimeout(r, 100));
  assert.ok(commandReceived);
  assert.equal(commandReceived.command, 'kill');
  assert.equal(commandReceived.targetId, 'task-999');

  const cmdResult = messages.find((m) => m.type === 'COMMAND_RESULT');
  assert.ok(cmdResult);
  assert.equal(cmdResult.result.success, true);
  assert.equal(cmdResult.result.command, 'kill');

  client.close();
  await server.close();
});
