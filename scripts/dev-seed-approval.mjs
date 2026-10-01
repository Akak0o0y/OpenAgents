/**
 * Seed an approval row, for exercising question cards against real data.
 *
 * Question cards in the workspace are rows in the daemon's `approvals` table.
 * They are created by a task that blocks on the approval gate, which needs a
 * container runtime. This script writes the same rows directly so the card can
 * be verified without one.
 *
 * FIXTURE ONLY. It writes to the dev database and prints what it wrote. Point
 * it at a real database and it will add real approval rows, so don't.
 *
 *   node scripts/dev-seed-approval.mjs [agentId]
 */

import { AgentStore } from '../dist/src/daemon/agent-store.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath =
  process.env.OPENHOURS_DB_PATH ?? path.resolve(here, '..', 'data', 'openhours-dev.db');
const agentId = process.argv[2] ?? 'ledger';

console.warn('*** FIXTURE: seeding approval rows into', dbPath);

const store = new AgentStore(dbPath);
const agent = store.getAgent(agentId);
if (!agent) {
  console.error(`No such agent "${agentId}".`);
  process.exit(1);
}

const run = store.createTaskRun({
  agentId,
  taskName: 'fixture-question',
  modelId: agent.model_id,
});
store.startTaskRun(run.id, agent.model_id);

// One unanswered question, with lettered options and a custom-answer box.
const pending = store.createApproval({
  taskRunId: run.id,
  agentId,
  kind: 'question',
  payload: {
    question: 'Which ledger should I reconcile first?',
    options: [
      { id: 'ap', label: 'Accounts payable' },
      { id: 'ar', label: 'Accounts receivable' },
      { id: 'payroll', label: 'Payroll' },
    ],
    allowCustom: true,
  },
});

// One already answered, so the completed card renders too.
const answeredRun = store.createTaskRun({
  agentId,
  taskName: 'fixture-question-done',
  modelId: agent.model_id,
});
store.startTaskRun(answeredRun.id, agent.model_id);
const answered = store.createApproval({
  taskRunId: answeredRun.id,
  agentId,
  kind: 'question',
  payload: {
    question: 'Should I include last quarter in the comparison?',
    options: [
      { id: 'yes', label: 'Yes, include Q3' },
      { id: 'no', label: 'No, this quarter only' },
    ],
  },
});
store.decideApproval(answered.id, 'APPROVED', 'Yes, include Q3');

console.log(`pending approval:  ${pending.id} (run ${run.id})`);
console.log(`answered approval: ${answered.id} (run ${answeredRun.id})`);
store.close();
