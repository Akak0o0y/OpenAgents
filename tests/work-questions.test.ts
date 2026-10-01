import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentStore } from '../src/daemon/agent-store.js';
import { WorkQuestions } from '../src/daemon/work-questions.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';
import { publicAgentDataApi } from '../src/daemon/internal-data.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import type { TaskDefinition } from '../src/daemon/scheduler.js';

test('questions retain work across restart; answers queue exactly one continuation without replaying prior actions', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'oh-question-')), 'test.db');
  let store = new AgentStore(file);
  store.createAgent({ id: 'bot', name: 'Bot', model_id: 'claude-haiku-4-5', budget_cap_usd: 10, current_status: 'IDLE' });
  const run = store.createTaskRun({ agentId: 'bot', taskName: 'chat' });
  store.startTaskRun(run.id, 'claude-haiku-4-5');
  let questions = new WorkQuestions(store);
  const actions = [{ tool: 'write', path: 'notes.md', content: 'Work already done' }, { tool: 'ask_user_question', question: 'Which language?', options: ['Arabic', 'English'] }];
  const runtime = new WorkRuntime({ store, ledger: new CostLedger(store.getDatabase()), artifacts: new ArtifactStore(store), sandbox: new DockerSandbox(), questions,
    llm: { async generateCode() { return { content: JSON.stringify(actions.shift()), inputTokens: 10, outputTokens: 10, attemptCount: 1 }; } } });
  const result = await runtime.execute({ taskRunId: run.id, contract: CONVERSATION_CONTRACT, request: 'Write a report', conversation: true, signal: new AbortController().signal,
    commit: result => store.finishTaskRun(run.id, result.outcome, result.report) });
  assert.equal(result.question?.state, 'pending');
  assert.match(result.report, /Waiting for your answer/);
  const id = result.question!.id;
  store.close(); store = new AgentStore(file); questions = new WorkQuestions(store);
  assert.equal(questions.list('bot')[0].id, id);
  assert.throws(() => questions.answer('other-bot', id, 'English'), /not found/);
  const first = questions.answer('bot', id, 'English');
  assert.deepEqual(questions.answer('bot', id, 'English'), first);
  assert.throws(() => questions.answer('bot', id, 'Arabic'), /differently/);
  const def = store.getRunDefinition(first.runId) as TaskDefinition;
  assert.deepEqual(def.work!.questionResume!.files, { 'notes.md': 'Work already done' });
  assert.match(def.work!.request, /Operator answer: English/);
  assert.equal(store.getTaskRun(first.runId)!.status, 'QUEUED');
  store.startTaskRun(first.runId, 'claude-haiku-4-5');
  const resumed = new WorkRuntime({ store, ledger: new CostLedger(store.getDatabase()), artifacts: new ArtifactStore(store), sandbox: new DockerSandbox(), questions,
    llm: { async generateCode(req) { assert.match(JSON.stringify(req.messages), /English/); return { content: JSON.stringify({tool:'answer',text:'Resumed in English',citations:[]}), inputTokens:10, outputTokens:10, attemptCount:1 }; } } });
  const done = await resumed.execute({ taskRunId:first.runId,contract:def.work!.contract,request:def.work!.request,resumeFiles:def.work!.questionResume!.files,conversation:true,signal:new AbortController().signal });
  assert.equal(done.outcome, 'COMPLETED');
  assert(done.artifacts.some(a => a.path === 'notes.md'));
  assert.throws(() => publicAgentDataApi(store).setAgentDataRecord({ agentId:'bot',key:id,category:'work-question',data:{} }), /owned/);
  store.close();
});

test('cancelled questions never dispatch work', () => {
  const store = new AgentStore(':memory:');
  store.createAgent({id:'bot',name:'Bot',model_id:'claude-haiku-4-5',budget_cap_usd:1,current_status:'IDLE'});
  const run = store.createTaskRun({agentId:'bot',taskName:'question'}); store.startTaskRun(run.id,'claude-haiku-4-5');
  const questions = new WorkQuestions(store);
  const question = questions.ask({agentId:'bot',runId:run.id,question:'Continue?',options:[],contract:CONVERSATION_CONTRACT,request:'Test',context:'',files:{},conversation:true});
  assert.throws(() => questions.answer('bot',question.id,'Yes'), /still saving/);
  questions.cancel('bot',question.id);
  assert.throws(() => questions.answer('bot',question.id,'Yes'), /cancelled/);
  assert.equal(store.listTaskRuns('bot').length,1); store.close();
});
