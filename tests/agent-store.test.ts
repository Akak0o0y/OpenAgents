import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';

test('AgentStore: CRUD operations for agents', () => {
  const store = new AgentStore(':memory:');

  // 1. Create agent
  const agent = store.createAgent({
    id: 'agent-1',
    name: 'Alpha Agent',
    model_id: 'anthropic/claude-haiku-4.5',
    budget_cap_usd: 5.00,
    current_status: 'IDLE',
  });
  assert.equal(agent.id, 'agent-1');
  assert.equal(agent.name, 'Alpha Agent');
  assert.equal(agent.current_status, 'IDLE');

  // 2. Get agent
  const fetched = store.getAgent('agent-1');
  assert.ok(fetched);
  assert.equal(fetched.name, 'Alpha Agent');
  assert.equal(fetched.budget_cap_usd, 5.00);

  // 3. Update status
  store.updateAgentStatus('agent-1', 'BUSY');
  assert.equal(store.getAgent('agent-1')?.current_status, 'BUSY');

  const updated = store.updateAgent('agent-1', {
    name: 'Build Agent',
    model_id: 'openrouter/auto',
    system_prompt: 'Build and verify focused changes.',
    budget_cap_usd: 12.5,
  });
  assert.equal(updated.name, 'Build Agent');
  assert.equal(updated.current_status, 'BUSY', 'identity edits must not reset lifecycle status');
  assert.equal(store.getAgent('agent-1')?.system_prompt, 'Build and verify focused changes.');
  assert.throws(() => store.updateAgent('missing', { name: 'Nope' }), /does not exist/);

  // 4. List agents
  const list = store.listAgents();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'agent-1');

  store.close();
});

test('AgentStore: Task run state machine transitions (QUEUED -> RUNNING -> COMPLETED/FAILED/ABORTED)', () => {
  const store = new AgentStore(':memory:');

  store.createAgent({
    id: 'agent-1',
    name: 'Alpha Agent',
    model_id: 'anthropic/claude-haiku-4.5',
    budget_cap_usd: 5.00,
    current_status: 'IDLE',
  });

  // 1. Create task run in QUEUED
  const run1 = store.createTaskRun({
    agentId: 'agent-1',
    taskName: 'cli-arg-parser',
  });
  assert.equal(run1.status, 'QUEUED');
  assert.equal(run1.turns_taken, 0);

  // 2. Start task run (QUEUED -> RUNNING)
  store.startTaskRun(run1.id);
  const running = store.getTaskRun(run1.id);
  assert.equal(running?.status, 'RUNNING');
  assert.ok(running?.started_at !== null);
  assert.equal(store.getAgent('agent-1')?.current_status, 'BUSY');

  // 3. Reject invalid transition (cannot start RUNNING task again)
  assert.throws(() => store.startTaskRun(run1.id), /Invalid state transition/);

  // 4. Progress update
  store.updateTaskRunProgress(run1.id, 3, 0.012, 0.036);
  const progressed = store.getTaskRun(run1.id);
  assert.equal(progressed?.turns_taken, 3);
  assert.equal(progressed?.actual_cost_usd, 0.012);

  // 5. Finish task run (RUNNING -> COMPLETED)
  store.finishTaskRun(run1.id, 'COMPLETED');
  const completed = store.getTaskRun(run1.id);
  assert.equal(completed?.status, 'COMPLETED');
  assert.ok(completed?.completed_at !== null);
  assert.equal(store.getAgent('agent-1')?.current_status, 'IDLE');

  // 6. Reject invalid transition (cannot finish completed task)
  assert.throws(() => store.finishTaskRun(run1.id, 'FAILED'), /Invalid state transition/);

  // 7. Verify ABORTED and FAILED paths
  const run2 = store.createTaskRun({ agentId: 'agent-1', taskName: 'task-aborted' });
  store.startTaskRun(run2.id);
  store.finishTaskRun(run2.id, 'ABORTED', 'Operator killed task');
  assert.equal(store.getTaskRun(run2.id)?.status, 'ABORTED');
  assert.equal(store.getTaskRun(run2.id)?.error_message, 'Operator killed task');

  const run3 = store.createTaskRun({ agentId: 'agent-1', taskName: 'task-failed' });
  store.startTaskRun(run3.id);
  store.finishTaskRun(run3.id, 'FAILED', 'Tests failed after max turns');
  assert.equal(store.getTaskRun(run3.id)?.status, 'FAILED');

  store.close();
});

test('AgentStore: Boot recovery sweep differentiates CRASHED from FAILED', () => {
  const store = new AgentStore(':memory:');

  store.createAgent({
    id: 'agent-1',
    name: 'Crash Agent',
    model_id: 'anthropic/claude-haiku-4.5',
    budget_cap_usd: 5.00,
    current_status: 'IDLE',
  });

  // Task 1: Completed normally
  const run1 = store.createTaskRun({ agentId: 'agent-1', taskName: 'normal-run' });
  store.startTaskRun(run1.id);
  store.finishTaskRun(run1.id, 'COMPLETED');

  // Task 2: Failed task logic normally
  const run2 = store.createTaskRun({ agentId: 'agent-1', taskName: 'failed-run' });
  store.startTaskRun(run2.id);
  store.finishTaskRun(run2.id, 'FAILED', 'Agent made bad code');

  // Task 3: In-flight when daemon dies (RUNNING)
  const run3 = store.createTaskRun({ agentId: 'agent-1', taskName: 'in-flight-run' });
  store.startTaskRun(run3.id);
  assert.equal(store.getAgent('agent-1')?.current_status, 'BUSY');

  // Boot sweep runs
  const sweptCount = store.markInFlightAsCrashed('Daemon startup crash recovery');
  assert.equal(sweptCount, 1);

  // Task 1 and 2 remain COMPLETED and FAILED
  assert.equal(store.getTaskRun(run1.id)?.status, 'COMPLETED');
  assert.equal(store.getTaskRun(run2.id)?.status, 'FAILED');

  // Task 3 is now distinctly CRASHED
  const crashed = store.getTaskRun(run3.id);
  assert.equal(crashed?.status, 'CRASHED');
  assert.equal(crashed?.error_message, 'Daemon startup crash recovery');
  assert.ok(crashed?.completed_at !== null);

  // Agent status reset to IDLE
  assert.equal(store.getAgent('agent-1')?.current_status, 'IDLE');

  // Verify events recorded
  const events = store.getTaskEvents(run3.id);
  assert.ok(events.some(e => e.event_type === 'TASK_CRASHED'));

  store.close();
});
