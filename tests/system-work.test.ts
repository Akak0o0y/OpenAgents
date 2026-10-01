import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { findWorkContract, DIRECT_WORK_CONTRACTS, CustomContractSchema, workTaskDefinition } from '../src/daemon/work-contract.js';
import { checkDeliverable, evidenceSource } from '../src/daemon/deliverable-checks.js';
import { MissionService, MissionDecision, validateMissionDecision } from '../src/daemon/missions.js';
import { MemoryService, compactContext } from '../src/daemon/memory.js';
import { RetentionService } from '../src/daemon/retention.js';
import { RunCapacity } from '../src/daemon/run-capacity.js';
import { ChatService } from '../src/daemon/chat.js';
import { TaskScheduler, type TaskDefinition } from '../src/daemon/scheduler.js';
import { ProviderRouter } from '../src/daemon/provider-router.js';
import { enqueueRoutine } from '../src/daemon/routine-dispatch.js';
import { readWorkResult, saveWorkResult } from '../src/daemon/work-results.js';
import { ProviderCallError, type LLMRequest } from '../src/evals/llm-client.js';
import { BrowserTools } from '../src/daemon/browser-tools.js';
import { MemorySecretStore } from '../src/daemon/secret-store.js';
import { DatabaseSync } from 'node:sqlite';
import { initDaemonSchema } from '../src/daemon/db/schema.js';

const MODEL = 'claude-haiku-4-5';
const report = { title: 'Project update', findings: [{ claim: 'Initial testing is finished.', evidence: [{ sourceId: 'request', quote: 'Initial testing is finished.' }] }], limitations: ['Supplied statement only; no external verification.'] };
const plan = { title: 'Release plan', tasks: [{ id: 'check', title: 'Check release', doneWhen: 'Release test report exists', priority: 1, dependsOn: [] }], limitations: ['No date was supplied.'] };
for (const enabled of [false, true]) {
  test(`browser prompt and tool schema respect enabled=${enabled}, independent of lazy readiness`, async () => {
    const h = fixture();
    const artifacts = new ArtifactStore(h.store);
    const browser = new BrowserTools({ store: h.store, artifacts, secrets: new MemorySecretStore(), enabled });
    const status = browser.status.bind(browser);
    browser.status = id => ({ ...status(id), ready: false });
    h.store.setAgentData({ agentId: 'alpha', category: 'browser-connection', key: 'x.com', data: { site: 'x.com', verified: false } });
    let request: LLMRequest | undefined;
    const llm = { async generateCode(req: LLMRequest) { request = req; return { content: 'Fixture answer.', inputTokens: 10, outputTokens: 10, attemptCount: 1 }; } };
    const runtime = new WorkRuntime({ ...h, llm, browser, sandbox: new DockerSandbox(), artifacts });
    const chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: llm, workRuntime: runtime, agenticChat: true });
    try {
      await chat.send(chat.createThread('alpha').id, 'Can you check the saved website?', `browser-${enabled}`);
      assert.ok(request);
      assert.equal(request.tools?.some(tool => tool.name === 'browser'), enabled);
      assert.equal(request.systemPrompt.includes('Browser actions:'), enabled);
      assert.equal(request.systemPrompt.includes('Saved website sessions:'), enabled);
      if (enabled) assert.match(request.systemPrompt, /NOT signed out or unusable/);
      else assert.match(request.systemPrompt, /Browser tools are not enabled/);
      assert.equal(browser.status().active, 0, 'prompt construction never starts a browser');
    } finally { await browser.stop(); h.close(); }
  });
}
test('conversation receives saved description and current bot-scoped runtime state, not stale health claims', async () => {
  const h = fixture();
  h.store.updateAgent('alpha', { system_prompt: 'Saved description fixture: inspect before claiming.' });
  h.store.createAgent({ id: 'other', name: 'Other', model_id: MODEL, budget_cap_usd: 1, current_status: 'IDLE' });
  const old = h.store.createTaskRun({ agentId: 'alpha', taskName: 'historical-missing-key' });
  h.store.startTaskRun(old.id, MODEL);
  h.store.finishTaskRun(old.id, 'FAILED', 'Missing OPENROUTER_API_KEY');
  const foreign = h.store.createTaskRun({ agentId: 'other', taskName: 'foreign-private-task' });
  h.store.startTaskRun(foreign.id, MODEL);
  let prompt = '';
  const llm = { async generateCode(req: LLMRequest) { prompt = req.systemPrompt; return { content: 'Fixture answer.', inputTokens: 10, outputTokens: 10, attemptCount: 1 }; } };
  const runtime = new WorkRuntime({ ...h, llm, sandbox: new DockerSandbox(), artifacts: new ArtifactStore(h.store) });
  const chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: llm, workRuntime: runtime, agenticChat: true });
  try {
    const thread = chat.createThread('alpha');
    await chat.send(thread.id, 'Can you see your description?', 'runtime-state-fixture');
    assert.match(prompt, /Saved description fixture/);
    assert.match(prompt, /"daemon":"executing this run"/);
    assert.match(prompt, /"descriptionPresent":true/);
    assert.match(prompt, /historical-missing-key/);
    assert.doesNotMatch(prompt, /foreign-private-task/);
    assert.match(prompt, /Historical failures and last-run statuses are not current health checks/);
    assert.match(prompt, /Empty initial files or memory do not mean/);
  } finally { h.close(); }
});
test('mission decisions reject contradictory completion while keeping historical waits readable',()=>{
  const legacy=MissionDecision.parse({state:'wait',reason:'Legacy wait'});
  assert.throws(()=>validateMissionDecision(legacy),/blocker/);
  assert.throws(()=>validateMissionDecision({state:'complete',reason:'Done',nextRequest:'More work'}),/further work/);
  assert.throws(()=>validateMissionDecision({state:'continue',reason:'Continue',nextRequest:'More work',blocker:{kind:'approval',detail:'Needs permission',resumeWhen:'Approved'}}),/must wait/);
  assert.doesNotThrow(()=>validateMissionDecision({state:'complete',reason:'All requested deliverables exist.'}));
});
function fixture(db = ':memory:') {
  const store = new AgentStore(db); const ledger = new CostLedger(store.getDatabase());
  if (!store.getAgent('alpha')) store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  return { store, ledger, close() { ledger.close(); store.close(); } };
}
test('deliverable acceptance rejects fabricated references, cycles, duplicate IDs and invalid deadlines', () => {
  const sources = [evidenceSource('request', 'user', 'Initial testing is finished.')];
  assert.ok(checkDeliverable('report', JSON.stringify(report), sources)['sources.json']);
  assert.ok(checkDeliverable('report', '```json\n' + JSON.stringify(report) + '\n```', sources)['sources.json']);
  assert.ok(checkDeliverable('plan', 'Here is the plan:\n' + JSON.stringify(plan) + '\nDone.', [])['plan.md']);
  for (const evidence of [{ sourceId: 'invented', quote: 'Initial testing is finished.' }, { sourceId: 'request', quote: 'Production testing passed.' }]) {
    assert.throws(() => checkDeliverable('report', JSON.stringify({ ...report, findings: [{ claim: 'Claim', evidence: [evidence] }] }), sources), /does not match/);
  }
  assert.ok(checkDeliverable('plan', JSON.stringify(plan), [])['plan.md']);
  for (const tasks of [[plan.tasks[0], plan.tasks[0]], [{ ...plan.tasks[0], dependsOn: ['check'] }], [{ ...plan.tasks[0], dependsOn: ['unknown'] }], [{ ...plan.tasks[0], due: 'tomorrow' }]]) {
    assert.throws(() => checkDeliverable('plan', JSON.stringify({ ...plan, tasks }), []));
  }
  assert.throws(() => CustomContractSchema.parse({ id: 'custom-edit', name: 'Edit', description: 'Edit', requirements: ['pass'], initialFiles: { '../escape': 'no' }, writableFiles: ['src/code.js'], testCommand: 'node test.js' }));
});
test('direct plans and scheduled reports use the same runtime and admission, preserve results and need no shell', { timeout: 10000 }, async () => {
  const h = fixture(); const capacity = new RunCapacity(1); const artifacts = new ArtifactStore(h.store); const requests: LLMRequest[] = [];
  const sandbox = new DockerSandbox();
  sandbox.createWorkspaceVolume = async () => { throw new Error('Report/plan must never create a container.'); };
  let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  const actions = [{ tool: 'write', path: 'plan.json', content: JSON.stringify(plan) }, { tool: 'verify' }, { tool: 'finish' }, { tool: 'write', path: 'report.json', content: JSON.stringify(report) }, { tool: 'verify' }, { tool: 'finish' }];
  const llm = { async generateCode(req: LLMRequest) { requests.push(req); if (requests.length === 1) await hold; return { content: JSON.stringify(actions.shift()), inputTokens: 20, outputTokens: 20, attemptCount: 1 }; } };
  const runtime = new WorkRuntime({ ...h, llm, sandbox, artifacts });
  const chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: llm, workRuntime: runtime, capacity });
  const definition = workTaskDefinition(findWorkContract('evidence-brief')!, 'Initial testing is finished.');
  const scheduler = new TaskScheduler({ agentStore: h.store, ledger: h.ledger, sandbox, providerRouter: new ProviderRouter(), llmClient: llm, workRuntime: runtime, capacity, maxConcurrency: 1, cadenceMs: 10, executor: 'builtin' });
  const thread = chat.createThread('alpha'); const send = chat.send(thread.id, 'Plan a release', 'first', 'action-plan');
  try {
    for (let i=0;i<100 && requests.length===0;i++) await delay(5);
    const routine = h.store.createRoutine({ agentId: 'alpha', name: 'Report', cronExpression: '0 9 * * *', promptTemplate: 'Initial testing is finished.', taskName: 'work:evidence-brief', nextRunAt: Date.now() });
    const run = enqueueRoutine(h.store, routine.id, { source: 'manual', definition, maxQueueDepth: 2 }).run;
    assert.equal(enqueueRoutine(h.store, routine.id, { source: 'webhook', definition, maxQueueDepth: 2 }).run.id, run.id, 'overlapping triggers coalesce');
    h.store.updateRoutine(routine.id, { prompt_template: 'Changed after queuing' });
    scheduler.start(); await delay(50);
    assert.equal(h.store.getTaskRun(run.id)?.status, 'QUEUED'); assert.equal(requests.length, 1);
    release(); assert.equal((await send).work?.outcome, 'COMPLETED');
    for (let i=0;i<500 && h.store.getTaskRun(run.id)?.status !== 'COMPLETED';i++) await delay(5);
    assert.equal(h.store.getTaskRun(run.id)?.status, 'COMPLETED');
    assert.equal(readWorkResult(h.store, run.id)?.artifacts.length, 3);
    assert.equal(h.store.getRoutine(routine.id)?.last_run_status, 'COMPLETED');
    assert.match(requests[3].messages![0].content, /Initial testing is finished/);
    assert.doesNotMatch(requests[3].messages![0].content, /Changed after queuing/);
    assert.equal(capacity.used, 0);
  } finally { release(); await chat.stop(); await scheduler.stop(); await send.catch(() => {}); h.close(); }
});
test('mission continuation is durable, finite, pause-aware and blocks uncertain external effects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'oh-mission-')); const db = path.join(root,'state.db');
  let h = fixture(db); let now = 1000000;
  let missions = new MissionService(h.store, DIRECT_WORK_CONTRACTS, 2, () => now);
  const m = missions.create({ agentId: 'alpha', objective: 'Prepare the release', contractId: 'action-plan', maxRuns: 2, intervalMs: 60000 });
  await missions.start(); assert.equal(await missions.produceNextTasks(h.store), 1); assert.equal(await missions.produceNextTasks(h.store), 0);
  const first = missions.list()[0].last_run_id!;
  missions.control(m.id,'PAUSED');
  assert.equal(missions.canRun(first),false,'a queued mission cannot dispatch while paused');
  missions.control(m.id,'ACTIVE');
  assert.equal(missions.canRun(first),true);
  h.store.startTaskRun(first);
  saveWorkResult(h.store, first, { outcome: 'COMPLETED', mission: { state: 'continue', reason: 'Need an evidence report', nextRequest: 'Prepare evidence report', nextContractId: 'evidence-brief' }, report: 'checked', artifacts: [], turns: 3, inputTokens: 3, outputTokens: 3, actualCostUsd: 0, shadowCostUsd: 0 });
  h.store.finishTaskRun(first,'COMPLETED');
  await missions.produceNextTasks(h.store); missions.control(m.id,'PAUSED'); h.close();
  h = fixture(db); missions = new MissionService(h.store,DIRECT_WORK_CONTRACTS,2,()=>now); await missions.start(); now+=60000;
  assert.equal(await missions.produceNextTasks(h.store),0,'manual pause survives reopening');
  missions.control(m.id,'ACTIVE'); assert.equal(await missions.produceNextTasks(h.store),1);
  const second = missions.list()[0].last_run_id!;
  assert.equal((h.store.getRunDefinition(second) as any).work.contract.id,'evidence-brief');
  h.store.startTaskRun(second);
  h.store.recordEvent({ task_run_id: second, agent_id: 'alpha', model_id: MODEL, event_type: 'EXTERNAL_ACTION_STARTED', payload_json: JSON.stringify({actionId:'uncertain'}), timestamp: now });
  h.store.markInFlightAsCrashed('process interrupted'); await missions.produceNextTasks(h.store);
  assert.equal(missions.list()[0].status,'WAITING'); assert.match(missions.list()[0].reason,/uncertain/);
  assert.throws(()=>missions.control(m.id,'ACTIVE'),/run limit/); h.close();
});

test('a checked plan continues into a checked report after database reopen', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'oh-mission-delivery-')),db=path.join(root,'state.db');
  let h=fixture(db),now=Date.now();
  const actions=[
    {tool:'write',path:'plan.json',content:JSON.stringify(plan)},{tool:'verify'},
    {tool:'finish',mission:{state:'wait',reason:'Report remains to be written.'}},
    {tool:'finish',mission:{state:'continue',reason:'Plan delivered, report remains.',nextRequest:'Report the supplied statement: Initial testing is finished.',nextContractId:'evidence-brief'}},
    {tool:'write',path:'report.json',content:JSON.stringify(report)},{tool:'verify'},
    {tool:'finish',mission:{state:'complete',reason:'Plan and quoted report are both delivered.'}},
  ];
  const llm={async generateCode(){const action=actions.shift();assert.ok(action,'No scripted extra work');return {content:JSON.stringify(action),inputTokens:10,outputTokens:10,attemptCount:1};}};
  const forbidden=async()=>{throw new Error('Plan/report must not request a Docker workspace');};
  const sandbox={createWorkspaceVolume:forbidden,stageWorkspaceFiles:forbidden,readWorkspaceFile:forbidden,executeTask:forbidden,destroyWorkspaceVolume:forbidden};
  let missions=new MissionService(h.store,DIRECT_WORK_CONTRACTS,2,()=>now);
  const id=missions.create({agentId:'alpha',objective:'Plan then quote: Initial testing is finished.',contractId:'action-plan',maxRuns:2,intervalMs:60000}).id;
  let firstRun='';
  try {
    await missions.start();await missions.produceNextTasks(h.store);
    for(let step=0;step<2;step++) {
      const runId=missions.list()[0].last_run_id!;if(step===0)firstRun=runId;
      const definition=h.store.getRunDefinition(runId) as TaskDefinition;h.store.startTaskRun(runId,MODEL);
      const runtime=new WorkRuntime({store:h.store,ledger:h.ledger,llm,sandbox,artifacts:new ArtifactStore(h.store),contracts:DIRECT_WORK_CONTRACTS});
      const result=await runtime.execute({taskRunId:runId,contract:definition.work!.contract,request:definition.work!.request,mission:true,signal:new AbortController().signal});
      assert.equal(result.outcome,'COMPLETED');saveWorkResult(h.store,runId,result);h.store.finishTaskRun(runId,'COMPLETED');
      await missions.produceNextTasks(h.store);
      if(step===0) {
        assert.equal(result.mission?.state,'continue');assert.equal(h.store.getTaskEvents(runId).filter(e=>e.event_type==='MISSION_DECISION_REJECTED').length,1);
        await missions.stop();h.close();h=fixture(db);missions=new MissionService(h.store,DIRECT_WORK_CONTRACTS,2,()=>now);await missions.start();now+=60000;
        assert.ok(readWorkResult(h.store,firstRun)?.artifacts.some(a=>a.path==='plan.json'));
        assert.equal(await missions.produceNextTasks(h.store),1);
        const next=h.store.getRunDefinition(missions.list()[0].last_run_id!) as TaskDefinition;
        assert.equal(next.work!.contract.id,'evidence-brief');assert.match(next.work!.request,/Previous verified delivery/);
      } else assert.ok(result.artifacts.some(a=>a.path==='report.json'));
    }
    const mission=missions.list().find(m=>m.id===id)!;
    assert.equal(mission.status,'COMPLETED');assert.equal(mission.runs,2);assert.equal(await missions.produceNextTasks(h.store),0);
    assert.equal(actions.length,0);
  } finally {await missions.stop();h.close();}
});

test('scheduled mission sources disclose model-generated step context and keep the operator objective citeable', { timeout: 15000 }, async () => {
  const h=fixture();let now=Date.now();
  const objective='Plan the release, then report the supplied statement: Initial testing is finished.';
  const proposed={...plan,tasks:[{id:'approve',title:'Confirm release approval with the owner',doneWhen:'Owner approval is recorded',priority:1,dependsOn:[]}]};
  const actions=[
    {tool:'write',path:'plan.json',content:JSON.stringify(proposed)},{tool:'verify'},
    {tool:'finish',mission:{state:'continue',reason:'Plan delivered; report remains.',nextRequest:'Report the supplied statement.',nextContractId:'evidence-brief'}},
    // Both quotes are valid substrings of the captured step request; only the first was supplied by the operator.
    {tool:'write',path:'report.json',content:JSON.stringify({title:'Release status',findings:[
      {claim:'Testing finished, as supplied.',evidence:[{sourceId:'request',quote:'Initial testing is finished.'}]},
      {claim:'The earlier plan proposed an approval step.',evidence:[{sourceId:'request',quote:'Confirm release approval with the owner'}]}],limitations:['Not independently verified.']})},
    {tool:'verify'},{tool:'finish',mission:{state:'complete',reason:'Plan and report delivered.'}},
  ];
  const llm={async generateCode(){const action=actions.shift();assert.ok(action,'No scripted extra work');return {content:JSON.stringify(action),inputTokens:10,outputTokens:10,attemptCount:1};}};
  const sandbox=new DockerSandbox();sandbox.createWorkspaceVolume=async()=>{throw new Error('Plan/report must not request a Docker workspace');};
  const artifacts=new ArtifactStore(h.store);
  const missions=new MissionService(h.store,DIRECT_WORK_CONTRACTS,1,()=>now);
  const runtime=new WorkRuntime({store:h.store,ledger:h.ledger,llm,sandbox,artifacts,contracts:DIRECT_WORK_CONTRACTS});
  const scheduler=new TaskScheduler({agentStore:h.store,ledger:h.ledger,sandbox,providerRouter:new ProviderRouter(),llmClient:llm,workRuntime:runtime,maxConcurrency:1,cadenceMs:10,executor:'builtin',canRun:id=>missions.canRun(id),workProducer:missions});
  const id=missions.create({agentId:'alpha',objective,contractId:'action-plan',maxRuns:2,intervalMs:60000}).id;
  const row=()=>missions.list().find(m=>m.id===id)!;
  const settle=async(done:()=>boolean)=>{for(let i=0;i<1000&&!done();i++)await delay(10);assert.ok(done(),`mission did not settle: ${row().status} ${row().reason}`);};
  try {
    await missions.start();scheduler.start();
    await settle(()=>row().runs===1&&row().last_run_id===null);
    now+=60000;
    await settle(()=>row().status==='COMPLETED');
    const [, second]=(h.store.getDatabase().prepare('SELECT id FROM task_runs WHERE task_name=? ORDER BY rowid').all(`mission:${id}`) as {id:string}[]).map(r=>r.id);
    const result=readWorkResult(h.store,second)!;assert.equal(result.outcome,'COMPLETED');
    const sources=JSON.parse(artifacts.read(second,result.artifacts.find(a=>a.path==='sources.json')!.id)!.content);
    const request=sources.find((s:any)=>s.id==='request');
    assert.match(request.text,/Confirm release approval with the owner/);
    assert.match(request.origin,/model-generated/,'model-written step context must not be labelled as user-supplied material');
    const operator=sources.find((s:any)=>s.id==='objective');
    assert.equal(operator?.text,objective);assert.match(operator.origin,/operator/i);
    assert.ok(checkDeliverable('report',JSON.stringify({...report,findings:[{claim:'Supplied.',evidence:[{sourceId:'objective',quote:'Initial testing is finished.'}]}]}),sources));
    assert.throws(()=>checkDeliverable('report',JSON.stringify({...report,findings:[{claim:'Plan text.',evidence:[{sourceId:'objective',quote:'Confirm release approval with the owner'}]}]}),sources),/does not match/);
    assert.equal(actions.length,0);
  } finally {await scheduler.stop();await missions.stop();h.close();}
});

test('a structured blocker keeps a mission waiting across reopen until the operator resumes it', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'oh-mission-blocked-')),db=path.join(root,'state.db');
  let h=fixture(db),now=Date.now();
  let missions=new MissionService(h.store,DIRECT_WORK_CONTRACTS,2,()=>now);
  const id=missions.create({agentId:'alpha',objective:'Quote the attached vendor agreement.',contractId:'evidence-brief',maxRuns:3,intervalMs:60000}).id;
  try {
    await missions.start();await missions.produceNextTasks(h.store);
    const runId=missions.list()[0].last_run_id!;h.store.startTaskRun(runId,MODEL);
    saveWorkResult(h.store,runId,{outcome:'COMPLETED',mission:{state:'wait',reason:'The agreement was not supplied.',blocker:{kind:'missing_input',detail:'Signed agreement text is absent.',resumeWhen:'The operator attaches the signed agreement text.'}},report:'checked',artifacts:[],turns:3,inputTokens:3,outputTokens:3,actualCostUsd:0,shadowCostUsd:0});
    h.store.finishTaskRun(runId,'COMPLETED');
    assert.equal(await missions.produceNextTasks(h.store),0);
    await missions.stop();h.close();h=fixture(db);missions=new MissionService(h.store,DIRECT_WORK_CONTRACTS,2,()=>now);await missions.start();
    now+=3600000;
    for(let i=0;i<3;i++)assert.equal(await missions.produceNextTasks(h.store),0,'a blocked mission never schedules itself');
    const waiting=missions.list()[0];
    assert.equal(waiting.status,'WAITING');assert.equal(waiting.runs,1);
    assert.match(waiting.reason,/Waiting for: Signed agreement text is absent\.\nResume when: The operator attaches the signed agreement text\./);
    missions.control(id,'ACTIVE');assert.equal(await missions.produceNextTasks(h.store),1,'operator resume permits one new bounded attempt');
    assert.equal(missions.list()[0].runs,2);
  } finally {await missions.stop();h.close();}
});

test('unsupported or contradictory mission decisions stop within limits and a final continue cannot exceed the run limit', async () => {
  const h=fixture();let now=Date.now();
  const forbidden=async()=>{throw new Error('Plan/report must not request a Docker workspace');};
  const sandbox={createWorkspaceVolume:forbidden,stageWorkspaceFiles:forbidden,readWorkspaceFile:forbidden,executeTask:forbidden,destroyWorkspaceVolume:forbidden};
  const missions=new MissionService(h.store,DIRECT_WORK_CONTRACTS,2,()=>now);
  const planned=[{tool:'write',path:'plan.json',content:JSON.stringify(plan)},{tool:'verify'}];
  const execute=async(missionId:string,actions:unknown[])=>{
    assert.equal(await missions.produceNextTasks(h.store),1);
    const runId=missions.list().find(m=>m.id===missionId)!.last_run_id!;
    const definition=h.store.getRunDefinition(runId) as TaskDefinition;h.store.startTaskRun(runId,MODEL);
    const llm={async generateCode(){const action=actions.shift();assert.ok(action,'No scripted extra work');return {content:JSON.stringify(action),inputTokens:10,outputTokens:10,attemptCount:1};}};
    const runtime=new WorkRuntime({store:h.store,ledger:h.ledger,llm,sandbox,artifacts:new ArtifactStore(h.store),contracts:DIRECT_WORK_CONTRACTS});
    const result=await runtime.execute({taskRunId:runId,contract:definition.work!.contract,request:definition.work!.request,mission:true,objective:definition.work!.objective,signal:new AbortController().signal});
    saveWorkResult(h.store,runId,result);h.store.finishTaskRun(runId,result.outcome,result.outcome==='COMPLETED'?undefined:result.report);
    await missions.produceNextTasks(h.store);
    assert.equal(actions.length,0);
    return {result,events:h.store.getTaskEvents(runId),row:missions.list().find(m=>m.id===missionId)!};
  };
  try {
    await missions.start();
    const unsupported={tool:'finish',mission:{state:'continue',reason:'Deploy next.',nextRequest:'Deploy the release.',nextContractId:'deploy-production'}};
    const deploy=missions.create({agentId:'alpha',objective:'Plan, then deploy.',contractId:'action-plan',maxRuns:3,intervalMs:60000}).id;
    // Three consecutive failures now buy one recovery turn before the run is abandoned,
    // so a model that keeps failing gets six attempts rather than three. What the test
    // protects is unchanged: it still stops, still produces nothing, and still does not
    // manufacture a continuation.
    const first=await execute(deploy,[...planned,...Array(6).fill(unsupported)]);
    assert.equal(first.result.outcome,'FAILED');assert.equal(first.result.artifacts.length,0);assert.equal(first.result.turns,8);
    assert.equal(first.events.filter(e=>e.event_type==='TOOL_CALL'&&/next mission contract is unavailable/.test(e.payload_json!)).length,6);
    assert.equal(first.row.status,'WAITING');assert.equal(first.row.runs,1);

    const contradictory={tool:'finish',mission:{state:'complete',reason:'Done.',nextRequest:'Also write a report.'}};
    const planOnly=missions.create({agentId:'alpha',objective:'Plan only.',contractId:'action-plan',maxRuns:3,intervalMs:60000}).id;
    const second=await execute(planOnly,[...planned,...Array(6).fill(contradictory)]);
    assert.equal(second.result.outcome,'FAILED');assert.equal(second.result.mission,undefined);assert.equal(second.result.artifacts.length,0);
    assert.equal(second.events.filter(e=>e.event_type==='MISSION_DECISION_REJECTED').length,6);
    assert.equal(second.row.status,'WAITING');

    const lastAttempt=missions.create({agentId:'alpha',objective:'Plan, then report.',contractId:'action-plan',maxRuns:1,intervalMs:60000}).id;
    const third=await execute(lastAttempt,[...planned,{tool:'finish',mission:{state:'continue',reason:'Report remains.',nextRequest:'Write the report.',nextContractId:'evidence-brief'}}]);
    assert.equal(third.result.outcome,'COMPLETED');assert.equal(third.result.mission?.state,'continue');
    now+=3600000;
    assert.equal(await missions.produceNextTasks(h.store),0,'no run beyond the mission limit, and no retry of failed decisions');
    const limited=missions.list().find(m=>m.id===lastAttempt)!;
    assert.equal(limited.status,'WAITING');assert.equal(limited.reason,'Mission run limit reached.');assert.equal(limited.runs,1);
    assert.throws(()=>missions.control(lastAttempt,'ACTIVE'),/run limit/);
    assert.equal((h.store.getDatabase().prepare("SELECT COUNT(*) AS n FROM task_runs WHERE task_name LIKE 'mission:%'").get() as {n:number}).n,3);
    assert.equal(missions.list().filter(m=>m.status==='WAITING').length,3);
  } finally {await missions.stop();h.close();}
});

test('a model-declared mission block waits with its blocker and no deliverable across reopen until one operator resume', { timeout: 30000 }, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'oh-mission-block-')),db=path.join(root,'state.db');
  let h=fixture(db);let now=Date.now();
  const reason='The requested agreement was not supplied.';
  const blocker={kind:'missing_input' as const,detail:'The agreement to review is absent.',resumeWhen:'The operator supplies the agreement.'};
  const actions:unknown[]=[{tool:'block',reason},{tool:'block',reason,blocker}];
  let calls=0;
  const llm={async generateCode(){calls++;const action=actions.shift();assert.ok(action,'No scripted extra model call');return {content:JSON.stringify(action),inputTokens:10,outputTokens:10,attemptCount:1};}};
  const sandbox=new DockerSandbox();sandbox.createWorkspaceVolume=async()=>{throw new Error('Report must not request a Docker workspace');};
  const open=()=>{
    const missions=new MissionService(h.store,DIRECT_WORK_CONTRACTS,1,()=>now);
    const workRuntime=new WorkRuntime({store:h.store,ledger:h.ledger,llm,sandbox,artifacts:new ArtifactStore(h.store),contracts:DIRECT_WORK_CONTRACTS});
    const scheduler=new TaskScheduler({agentStore:h.store,ledger:h.ledger,sandbox,providerRouter:new ProviderRouter(),llmClient:llm,workRuntime,maxConcurrency:1,cadenceMs:10,executor:'builtin',canRun:id=>missions.canRun(id),workProducer:missions});
    return {missions,scheduler};
  };
  let {missions,scheduler}=open();
  const id=missions.create({agentId:'alpha',objective:'Quote the termination clause from the agreement the operator attached.',contractId:'evidence-brief',maxRuns:2,intervalMs:60000}).id;
  const row=()=>missions.list().find(m=>m.id===id)!;
  const runs=()=>h.store.getDatabase().prepare('SELECT id, status FROM task_runs WHERE task_name=? ORDER BY rowid').all(`mission:${id}`) as {id:string;status:string}[];
  const settle=async(done:()=>boolean)=>{for(let i=0;i<1000&&!done();i++)await delay(10);assert.ok(done(),`did not settle: ${row().status} ${row().reason}`);};
  try {
    await missions.start();scheduler.start();
    await settle(()=>row().status==='WAITING');
    await scheduler.stop();await missions.stop();
    const [first]=runs();
    assert.equal(first.status,'FAILED','a blocked run is never COMPLETED');
    assert.equal(new ArtifactStore(h.store).list(first.id).length,0);
    const saved=readWorkResult(h.store,first.id)!;
    assert.equal(saved.artifacts.length,0);
    assert.deepEqual(saved.blocked,{declaredBy:'model',reason,blocker});
    assert.deepEqual(saved.mission,{state:'wait',reason,blocker});
    assert.match(saved.report,/Waiting for: The agreement to review is absent\.\nResume when: The operator supplies the agreement\./);
    const events=h.store.getTaskEvents(first.id);
    assert.equal(events.filter(e=>e.event_type==='MISSION_DECISION_REJECTED'&&JSON.parse(e.payload_json!).via==='block').length,1,'the missing blocker was corrected');
    assert.equal(events.filter(e=>e.event_type==='WORK_BLOCKED'&&JSON.parse(e.payload_json!).declaredBy==='model').length,1);
    assert.equal(events.filter(e=>e.event_type==='ARTIFACT_CREATED').length,0);
    assert.equal(row().reason,`${reason}\nWaiting for: ${blocker.detail}\nResume when: ${blocker.resumeWhen}`);
    assert.equal(calls,2);

    h.close();h=fixture(db);({missions,scheduler}=open());
    now+=6*3600000;await missions.start();scheduler.start();await delay(200);
    assert.equal(runs().length,1,'a waiting mission never schedules itself');assert.equal(calls,2,'no model call while waiting');assert.equal(row().status,'WAITING');

    h.store.updateAgentStatus('alpha','PAUSED');missions.control(id,'ACTIVE');await delay(200);
    assert.equal(runs().length,1,'resume respects a paused bot');
    assert.match(row().reason,/^Operator resumed after: The requested agreement was not supplied\.\nWaiting for:/);
    actions.push({tool:'block',reason:'The agreement is still absent.',blocker});
    h.store.updateAgentStatus('alpha','IDLE');
    await settle(()=>runs().length===2&&row().status==='WAITING');
    await delay(200);
    assert.equal(runs().length,2,'resume permits exactly one fresh attempt');assert.equal(calls,3);
    assert.deepEqual(readWorkResult(h.store,first.id)?.blocked?.blocker,blocker,'the prior blocker record is preserved');
    assert.equal(row().runs,2);assert.throws(()=>missions.control(id,'ACTIVE'),/run limit/);
  } finally {await scheduler.stop();await missions.stop();h.close();}
});

test('mission block corrections stay bounded; provider, cancellation, uncertain and legacy failures are never model blockers', async () => {
  const h=fixture();const now=Date.now();
  const forbidden=async()=>{throw new Error('Report must not request a Docker workspace');};
  const sandbox={createWorkspaceVolume:forbidden,stageWorkspaceFiles:forbidden,readWorkspaceFile:forbidden,executeTask:forbidden,destroyWorkspaceVolume:forbidden};
  const missions=new MissionService(h.store,DIRECT_WORK_CONTRACTS,4,()=>now);
  const blocker={kind:'approval' as const,detail:'Legal approval is required.',resumeWhen:'Legal approves the review.'};
  const begin=async(objective:string)=>{
    const id=missions.create({agentId:'alpha',objective,contractId:'evidence-brief',maxRuns:3,intervalMs:60000}).id;
    assert.equal(await missions.produceNextTasks(h.store),1);
    const runId=missions.list().find(m=>m.id===id)!.last_run_id!;h.store.startTaskRun(runId,MODEL);
    return {id,runId};
  };
  const execute=async(objective:string,generate:(controller:AbortController)=>unknown,mission=true)=>{
    const {id,runId}=await begin(objective);
    const definition=h.store.getRunDefinition(runId) as TaskDefinition;const controller=new AbortController();
    const llm={async generateCode(){return {content:JSON.stringify(await generate(controller)),inputTokens:10,outputTokens:10,attemptCount:1};}};
    const runtime=new WorkRuntime({store:h.store,ledger:h.ledger,llm,sandbox,artifacts:new ArtifactStore(h.store),contracts:DIRECT_WORK_CONTRACTS});
    const result=await runtime.execute({taskRunId:runId,contract:definition.work!.contract,request:definition.work!.request,mission,objective:definition.work!.objective,signal:controller.signal});
    saveWorkResult(h.store,runId,result);h.store.finishTaskRun(runId,result.outcome,result.outcome==='COMPLETED'?undefined:result.report);
    await missions.produceNextTasks(h.store);
    const events=h.store.getTaskEvents(runId),row=missions.list().find(m=>m.id===id)!;
    return {result,row,rejected:events.filter(e=>e.event_type==='MISSION_DECISION_REJECTED').length,declared:events.filter(e=>e.event_type==='WORK_BLOCKED').length};
  };
  const notBlocker=(x:Awaited<ReturnType<typeof execute>>)=>{assert.equal(x.result.blocked,undefined);assert.equal(x.result.mission,undefined);assert.equal(x.declared,0);assert.equal(x.row.status,'WAITING');assert.doesNotMatch(x.row.reason,/Resume when/);};
  try {
    await missions.start();
    const missing=await execute('Review the agreement.',()=>({tool:'block',reason:'Agreement absent.'}));
    // Six, not three: a run now gets one turn to change approach before being abandoned.
    // Bounded is what matters here, and notBlocker still proves nothing was manufactured.
    assert.equal(missing.result.outcome,'FAILED');assert.equal(missing.result.turns,6);assert.equal(missing.rejected,6);notBlocker(missing);
    const malformed=await execute('Review the agreement again.',()=>({tool:'block',reason:'Agreement absent.',blocker:{kind:'someday',detail:'x',resumeWhen:'y'}}));
    assert.equal(malformed.result.outcome,'FAILED');assert.equal(malformed.result.turns,6);notBlocker(malformed);
    const provider=await execute('Review with an unavailable provider.',()=>{throw new ProviderCallError('HTTP_ERROR','Upstream error from the provider.',{status:502});});
    assert.equal(provider.result.outcome,'FAILED');assert.match(provider.result.report,/Upstream error/);notBlocker(provider);
    const cancelled=await execute('Review, then cancel.',controller=>{controller.abort();return {tool:'block',reason:'Agreement absent.',blocker};});
    assert.equal(cancelled.result.outcome,'ABORTED');notBlocker(cancelled);

    const plain=await execute('Plain non-mission request.',()=>({tool:'block',reason:'Need repair'}),false);
    assert.equal(plain.result.outcome,'FAILED');assert.deepEqual(plain.result.blocked,{declaredBy:'model',reason:'Need repair'});assert.equal(plain.result.mission,undefined);assert.match(plain.result.report,/Need repair/);

    const legacy=await begin('Historical plain block.');
    saveWorkResult(h.store,legacy.runId,{outcome:'FAILED',report:'Blocked: Source-based report\n\nAgreement absent.',artifacts:[],turns:1,inputTokens:1,outputTokens:1,actualCostUsd:0,shadowCostUsd:0});
    h.store.finishTaskRun(legacy.runId,'FAILED','Blocked: Source-based report\n\nAgreement absent.');
    await missions.produceNextTasks(h.store);
    assert.equal(missions.list().find(m=>m.id===legacy.id)!.status,'WAITING');assert.match(missions.list().find(m=>m.id===legacy.id)!.reason,/^Blocked: Source-based report/);

    const uncertain=await begin('Blocked after an uncertain external action.');
    h.store.recordEvent({task_run_id:uncertain.runId,agent_id:'alpha',model_id:MODEL,event_type:'EXTERNAL_ACTION_STARTED',payload_json:JSON.stringify({actionId:'uncertain'}),timestamp:now});
    saveWorkResult(h.store,uncertain.runId,{outcome:'FAILED',blocked:{declaredBy:'model',reason:'Wait.',blocker},mission:{state:'wait',reason:'Wait.',blocker},report:'Blocked',artifacts:[],turns:1,inputTokens:1,outputTokens:1,actualCostUsd:0,shadowCostUsd:0});
    h.store.finishTaskRun(uncertain.runId,'FAILED','Blocked');
    await missions.produceNextTasks(h.store);
    assert.match(missions.list().find(m=>m.id===uncertain.id)!.reason,/External action outcome is uncertain/,'uncertain external effects keep precedence');
  } finally {await missions.stop();h.close();}
});

test('recalled notes have immutable citeable snapshots with provenance and bot scope', async () => {
  const h=fixture();const memory=new MemoryService(h.store);
  memory.save('alpha',{key:'release-note',text:'Initial testing is finished.'},'operator');
  h.store.createAgent({id:'beta',name:'Other bot',model_id:MODEL,budget_cap_usd:1,current_status:'IDLE'});
  memory.save('beta',{key:'release-secret',text:'Release secret from another bot.'},'operator');
  let turn=0,sourceId='',seen='';
  const llm={async generateCode(req:LLMRequest){
    let action:unknown;
    turn++;
    if(turn===1){seen=req.userPrompt;action={tool:'recall',query:'release'};}
    else if(turn===2){
      const recalled=JSON.parse(req.userPrompt).summary;assert.equal(recalled.length,1);sourceId=recalled[0].sourceId;assert.match(sourceId,/^memory-[a-f0-9]{24}$/);
      memory.save('alpha',{key:'release-note',text:'Changed after capture.'},'operator');action={tool:'compact'};
    } else if(turn===3)action={tool:'source',id:sourceId};
    else if(turn===4){assert.equal(JSON.parse(req.userPrompt).source.text,'Initial testing is finished.');action={tool:'write',path:'report.json',content:JSON.stringify({...report,findings:[{claim:'The note says testing finished.',evidence:[{sourceId,quote:'Initial testing is finished.'}]}]})};}
    else if(turn===5)action={tool:'verify'};else action={tool:'finish'};
    return {content:JSON.stringify(action),inputTokens:10,outputTokens:10,attemptCount:1};
  }};
  const forbidden=async()=>{throw new Error('Report must not use Docker');};
  const artifacts=new ArtifactStore(h.store);
  const runtime=new WorkRuntime({store:h.store,ledger:h.ledger,llm,memory,artifacts,sandbox:{createWorkspaceVolume:forbidden,stageWorkspaceFiles:forbidden,readWorkspaceFile:forbidden,executeTask:forbidden,destroyWorkspaceVolume:forbidden}});
  const run=h.store.createTaskRun({agentId:'alpha',taskName:'memory-report'});h.store.startTaskRun(run.id,MODEL);
  try{
    const result=await runtime.execute({taskRunId:run.id,contract:findWorkContract('evidence-brief')!,request:'Summarize the release note as an unverified note.',signal:new AbortController().signal});
    assert.equal(result.outcome,'COMPLETED');assert.doesNotMatch(seen,/another bot|release-secret/);
    const sourceFile=artifacts.read(run.id,result.artifacts.find(a=>a.path==='sources.json')!.id)!;
    const snapshot=JSON.parse(sourceFile.content).find((s:any)=>s.id===sourceId);
    assert.equal(snapshot.text,'Initial testing is finished.');assert.match(snapshot.origin,/operator; unverified note/);
    assert.doesNotMatch(sourceFile.content,/Changed after capture|another bot/);
  }finally{h.close();}
});
test('scoped memory, compaction, vault boundaries and retention preserve active and referenced evidence', async () => {
  const h=fixture(); const root=fs.mkdtempSync(path.join(os.tmpdir(),'oh-vault-'));
  h.store.createAgent({id:'beta',name:'Beta',model_id:MODEL,budget_cap_usd:10,current_status:'IDLE'});
  const memory=new MemoryService(h.store,{alpha:root}); new MissionService(h.store,DIRECT_WORK_CONTRACTS,2);
  memory.save('alpha',{key:'release',text:'Release requires review'},'operator');
  assert.equal(memory.recall('beta','release').length,0); assert.equal(memory.recall('alpha','release').length,1);
  fs.writeFileSync(path.join(root,'Note.md'),'Original vault note'); memory.importNote('alpha',{file:'Note.md',key:'vault'});
  assert.throws(()=>memory.importNote('alpha',{file:'../Note.md',key:'bad'}),/relative/);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'oh-vault-outside-'));fs.writeFileSync(path.join(outside,'Secret.md'),'Outside the vault');
  fs.symlinkSync(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>memory.importNote('alpha',{file:'linked/Secret.md',key:'bad'}),/outside/);
  assert.throws(()=>memory.importNote('beta',{file:'Note.md',key:'bad'}),/configured/);
  const exported=memory.exportNote('alpha','vault'); assert.equal(fs.readFileSync(path.join(root,'Note.md'),'utf8'),'Original vault note'); assert.ok(fs.existsSync(path.join(root,exported.file)));
  const messages=[{role:'user' as const,content:'Immutable objective'},...Array.from({length:16},(_,i)=>({role:'user' as const,content:`observation ${i}`,observation:true}))];
  const compact=compactContext(messages,{verified:true}); assert.equal(compact[0].content,'Immutable objective'); assert.equal(compact.at(-1)?.content,'observation 15'); assert.equal(compact.length,8);
  const steered=compactContext([messages[0],{role:'user',content:'Exact operator correction'},...messages.slice(1)],{verified:true});assert(steered.some(m=>m.content==='Exact operator correction'));
  const old=h.store.createTaskRun({agentId:'alpha',taskName:'old'});h.store.startTaskRun(old.id);h.store.finishTaskRun(old.id,'COMPLETED');
  assert.throws(()=>memory.save('alpha',{key:'release',text:'Overwrite operator'},'model-note',old.id),/cannot overwrite/);
  assert.throws(()=>memory.save('beta',{key:'cross-bot',text:'Wrong owner'},'model-note',old.id),/another bot/);
  assert.throws(()=>new ArtifactStore(h.store,1).save(old.id,{'too-large.txt':'two bytes or more'}),/storage limit/);
  assert.equal(new ArtifactStore(h.store).list(old.id).length,0,'capacity rejection does not persist a partial artifact');
  h.store.getDatabase().prepare('UPDATE task_runs SET completed_at=? WHERE id=?').run(Date.now()-40*86400000,old.id);
  new ArtifactStore(h.store).save(old.id,{'old.txt':'old'});
  h.store.setAgentData({agentId:'alpha',category:'retention',key:'hold',data:{note:'No run specified'}});
  let deleted=0;const retention=new RetentionService(h.store,{workspaceVolumeName:id=>id,destroyWorkspaceVolume:async()=>{deleted++;}});
  assert.equal((await retention.clean(30)).candidates.length,1); assert.equal(deleted,0);
  memory.save('alpha',{key:'keep',text:'Keep evidence'},'model-note',old.id); assert.equal((await retention.clean(30,false)).cleaned.length,0);
  memory.remove('alpha','keep'); assert.equal((await retention.clean(30,false)).cleaned.length,1); assert.equal(new ArtifactStore(h.store).list(old.id).length,0);
  assert.equal((await retention.clean(30)).candidates.length,0,'cleaned runs cannot keep occupying the next batch');
  const next=h.store.createTaskRun({agentId:'alpha',taskName:'next-old'});h.store.startTaskRun(next.id);h.store.finishTaskRun(next.id,'COMPLETED');
  h.store.getDatabase().prepare('UPDATE task_runs SET completed_at=? WHERE id=?').run(Date.now()-40*86400000,next.id);
  assert.deepEqual((await retention.clean(30)).candidates,[next.id],'later batches progress to new candidates');
  assert.ok(h.store.getTaskRun(old.id),'result row remains'); h.close();
});

test('retention never offers a run that sent a post (PUBLISH_ATTEMPTED) for cleanup', async () => {
  const h = fixture();
  try {
    // ELIGIBLE reads the missions and bot_memory tables, which these services create.
    new MissionService(h.store, DIRECT_WORK_CONTRACTS, 2);
    new MemoryService(h.store);
    const cutoff = Date.now() - 40 * 86400000;
    const finished = (taskName: string, completedAt: number, publishes: boolean) => {
      const run = h.store.createTaskRun({ agentId: 'alpha', taskName });
      h.store.startTaskRun(run.id);
      // The run's only external fact is the post: no EXTERNAL_ACTION_STARTED, which is exempt already.
      if (publishes) {
        h.store.recordEvent({ task_run_id: run.id, agent_id: 'alpha', event_type: 'PUBLISH_ATTEMPTED', timestamp: completedAt - 1000,
          payload_json: JSON.stringify({ publishId: `pub-${run.id}`, by: 'model', probe: 'x.com/create-tweet', op: 'reply', origin: 'https://x.com', sentAt: completedAt - 1000 }) });
      }
      h.store.finishTaskRun(run.id, 'COMPLETED');
      h.store.getDatabase().prepare('UPDATE task_runs SET completed_at=? WHERE id=?').run(completedAt, run.id);
      return run;
    };
    const posted = finished('posted', cutoff - 1000, true);
    const plain = finished('plain', cutoff, false);
    const retention = new RetentionService(h.store, { workspaceVolumeName: id => id, destroyWorkspaceVolume: async () => {} });
    assert.deepEqual((await retention.clean(30)).candidates, [plain.id], 'dedupe and pending facts live in the posting run');
    assert.deepEqual((await retention.clean(30, false)).cleaned, [plain.id]);
    assert.ok(h.store.getTaskEvents(posted.id).some(e => e.event_type === 'PUBLISH_ATTEMPTED'), 'the post record is kept');
  } finally { h.close(); }
});

test('idx_task_runs_routine is created after the routine_id migration, on a legacy database and idempotently', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // task_runs exactly as schema.ts:163-175 creates it: no routine_id column.
    db.exec(`CREATE TABLE task_runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), task_name TEXT NOT NULL, model_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED', 'CRASHED')),
      turns_taken INTEGER NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0.0, shadow_cost_usd REAL NOT NULL DEFAULT 0.0,
      error_message TEXT, started_at INTEGER, completed_at INTEGER)`);
    const columns = () => (db.prepare('PRAGMA table_info(task_runs)').all() as Array<{ name: string }>).map(c => c.name);
    const routineIndexes = () => (db.prepare('PRAGMA index_list(task_runs)').all() as Array<{ name: string }>).map(i => i.name).filter(name => name === 'idx_task_runs_routine');
    assert.equal(columns().includes('routine_id'), false, 'the fixture starts without the column');
    initDaemonSchema(db);
    assert.equal(columns().includes('routine_id'), true, 'the migration added the column');
    assert.deepEqual(routineIndexes(), ['idx_task_runs_routine']);
    assert.deepEqual((db.prepare("PRAGMA index_info('idx_task_runs_routine')").all() as Array<{ name: string }>).map(c => c.name), ['routine_id']);
    initDaemonSchema(db);
    assert.deepEqual(routineIndexes(), ['idx_task_runs_routine'], 'a second run changes nothing');
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM task_runs WHERE routine_id = ?').all('rtn-1') as Array<{ detail: string }>;
    assert.match(plan.map(p => p.detail).join('\n'), /idx_task_runs_routine/);
  } finally { db.close(); }
});
