import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceActivity,
  emptyRunActivity,
  type RunActivity,
} from '../src/cortex/run-steps.js';

describe('reduceActivity', () => {
  it('handles a standard ok run lifecycle', () => {
    let activity = emptyRunActivity('run-1');

    activity = reduceActivity(activity, {
      id: 1,
      task_run_id: 'run-1',
      event_type: 'TASK_STARTED',
      timestamp: 1000,
    });
    assert.equal(activity.phase, 'running');

    activity = reduceActivity(activity, {
      id: 2,
      task_run_id: 'run-1',
      event_type: 'WORK_PLAN',
      payload_json: JSON.stringify({ steps: ['Step 1: Check git', 'Step 2: Run tests'] }),
      timestamp: 1010,
    });
    assert.deepEqual(activity.plan, ['Step 1: Check git', 'Step 2: Run tests']);

    activity = reduceActivity(activity, {
      id: 3,
      task_run_id: 'run-1',
      event_type: 'WORK_ACTION',
      payload_json: JSON.stringify({ tool: 'run', command: 'git status', callId: 'call-1' }),
      timestamp: 1020,
    });
    assert.equal(activity.steps.length, 1);
    assert.equal(activity.steps[0].tool, 'run');
    assert.equal(activity.steps[0].label, 'Running command');
    assert.equal(activity.steps[0].subject, 'git status');
    assert.equal(activity.steps[0].card, 'terminal');
    assert.equal(activity.steps[0].status, 'running');

    activity = reduceActivity(activity, {
      id: 4,
      task_run_id: 'run-1',
      event_type: 'TOOL_CALL',
      payload_json: JSON.stringify({ tool: 'run', status: 'ok', exitCode: 0, summary: 'On branch main\nnothing to commit' }),
      timestamp: 1050,
    });
    assert.equal(activity.steps.length, 1);
    assert.equal(activity.steps[0].status, 'ok');
    assert.equal(activity.steps[0].exitCode, 0);
    assert.equal(activity.steps[0].endedAt, 1050);
    assert.equal(activity.steps[0].output, 'On branch main\nnothing to commit');

    activity = reduceActivity(activity, {
      id: 5,
      task_run_id: 'run-1',
      event_type: 'TASK_COMPLETED',
      timestamp: 1100,
    });
    assert.equal(activity.phase, 'completed');
  });

  it('marks a step as error when tool call fails or returns non-zero exit code', () => {
    let activity = emptyRunActivity('run-2');

    activity = reduceActivity(activity, {
      id: 1,
      task_run_id: 'run-2',
      event_type: 'WORK_ACTION',
      payload_json: JSON.stringify({ tool: 'run', command: 'npm test', callId: 'call-err' }),
      timestamp: 2000,
    });

    activity = reduceActivity(activity, {
      id: 2,
      task_run_id: 'run-2',
      event_type: 'TOOL_CALL',
      payload_json: JSON.stringify({ tool: 'run', status: 'error', exitCode: 1, summary: 'FAIL tests/app.test.ts' }),
      timestamp: 2050,
    });

    assert.equal(activity.steps.length, 1);
    assert.equal(activity.steps[0].status, 'error');
    assert.equal(activity.steps[0].exitCode, 1);
    assert.equal(activity.steps[0].output, 'FAIL tests/app.test.ts');
  });

  it('creates an invalid step when a TOOL_CALL arrives without an open WORK_ACTION', () => {
    let activity = emptyRunActivity('run-3');

    activity = reduceActivity(activity, {
      id: 1,
      task_run_id: 'run-3',
      event_type: 'TOOL_CALL',
      payload_json: JSON.stringify({ tool: 'invalid', status: 'error', summary: 'The model returned an empty reply and was asked again.' }),
      timestamp: 3000,
    });

    assert.equal(activity.steps.length, 1);
    assert.equal(activity.steps[0].tool, 'invalid');
    assert.equal(activity.steps[0].status, 'error');
    assert.equal(activity.steps[0].label, 'Invalid tool call');
    assert.equal(activity.steps[0].output, 'The model returned an empty reply and was asked again.');
  });

  it('ignores notRun TOOL_CALL events without an open step', () => {
    let activity = emptyRunActivity('run-not-run');

    activity = reduceActivity(activity, {
      id: 1,
      task_run_id: 'run-not-run',
      event_type: 'TOOL_CALL',
      payload_json: JSON.stringify({ tool: 'web_search', status: 'error', notRun: true, summary: 'Only the first of 3 tool calls ran. Send one tool call per turn.' }),
      timestamp: 3000,
    });

    assert.equal(activity.steps.length, 0);
  });

  it('closes answer and finish steps on WORK_REPORT', () => {
    let activity = emptyRunActivity('run-4');

    activity = reduceActivity(activity, {
      id: 1,
      task_run_id: 'run-4',
      event_type: 'WORK_ACTION',
      payload_json: JSON.stringify({ tool: 'answer', text: 'Here is the answer' }),
      timestamp: 4000,
    });
    assert.equal(activity.steps[0].status, 'running');

    activity = reduceActivity(activity, {
      id: 2,
      task_run_id: 'run-4',
      event_type: 'WORK_REPORT',
      payload_json: JSON.stringify({ outcome: 'Delivered conversation answer' }),
      timestamp: 4050,
    });
    assert.equal(activity.steps[0].status, 'ok');
    assert.equal(activity.steps[0].output, 'Delivered conversation answer');
    assert.equal(activity.steps[0].endedAt, 4050);
  });

  it('handles an approval wait state', () => {
    let activity = emptyRunActivity('run-5');

    activity = reduceActivity(activity, {
      id: 1,
      task_run_id: 'run-5',
      event_type: 'WORK_ACTION',
      payload_json: JSON.stringify({ tool: 'run', command: 'rm -rf dist' }),
      timestamp: 5000,
    });

    activity = reduceActivity(activity, {
      id: 2,
      task_run_id: 'run-5',
      event_type: 'APPROVAL_REQUESTED',
      payload_json: JSON.stringify({ approvalId: 'appr-123', kind: 'command' }),
      timestamp: 5010,
    });

    assert.equal(activity.steps[0].status, 'waiting');
    assert.equal(activity.steps[0].approvalId, 'appr-123');

    activity = reduceActivity(activity, {
      id: 3,
      task_run_id: 'run-5',
      event_type: 'TOOL_CALL',
      payload_json: JSON.stringify({ tool: 'run', status: 'ok', exitCode: 0, summary: 'Approved and executed' }),
      timestamp: 5090,
    });

    assert.equal(activity.steps[0].status, 'ok');
  });

  it('turns running and waiting steps into stopped on TASK_ABORTED, FAILED, or CRASHED', () => {
    let activity = emptyRunActivity('run-6');

    activity = reduceActivity(activity, {
      id: 1,
      task_run_id: 'run-6',
      event_type: 'WORK_ACTION',
      payload_json: JSON.stringify({ tool: 'run', command: 'sleep 100' }),
      timestamp: 6000,
    });
    assert.equal(activity.steps[0].status, 'running');

    activity = reduceActivity(activity, {
      id: 2,
      task_run_id: 'run-6',
      event_type: 'TASK_ABORTED',
      timestamp: 6050,
    });

    assert.equal(activity.phase, 'aborted');
    assert.equal(activity.steps[0].status, 'stopped');
    assert.equal(activity.steps[0].endedAt, 6050);
  });

  it('skips duplicate events based on event.id', () => {
    let activity = emptyRunActivity('run-7');

    activity = reduceActivity(activity, {
      id: 10,
      task_run_id: 'run-7',
      event_type: 'WORK_ACTION',
      payload_json: JSON.stringify({ tool: 'read', path: 'file.txt' }),
      timestamp: 7000,
    });
    assert.equal(activity.steps.length, 1);
    assert.equal(activity.lastEventId, 10);

    // Duplicate event id
    activity = reduceActivity(activity, {
      id: 10,
      task_run_id: 'run-7',
      event_type: 'WORK_ACTION',
      payload_json: JSON.stringify({ tool: 'read', path: 'file.txt' }),
      timestamp: 7001,
    });
    assert.equal(activity.steps.length, 1);

    // Lower event id
    activity = reduceActivity(activity, {
      id: 5,
      task_run_id: 'run-7',
      event_type: 'WORK_ACTION',
      payload_json: JSON.stringify({ tool: 'read', path: 'other.txt' }),
      timestamp: 6999,
    });
    assert.equal(activity.steps.length, 1);
  });

  it('toggles thinking on PROVIDER_CALL attempt and complete', () => {
    let activity = emptyRunActivity('run-8');

    activity = reduceActivity(activity, {
      id: 1,
      task_run_id: 'run-8',
      event_type: 'PROVIDER_CALL',
      payload_json: JSON.stringify({ phase: 'attempt' }),
      timestamp: 8000,
    });
    assert.equal(activity.thinkingSince, 8000);

    activity = reduceActivity(activity, {
      id: 2,
      task_run_id: 'run-8',
      event_type: 'PROVIDER_CALL',
      payload_json: JSON.stringify({ phase: 'complete' }),
      timestamp: 8050,
    });
    assert.equal(activity.thinkingSince, undefined);
  });
});
