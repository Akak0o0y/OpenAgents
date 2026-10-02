import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actionSchema,parseStructuredAction} from '../src/daemon/work-actions.js';
import {availableTools} from '../src/daemon/tool-schemas.js';
import {AgentStore} from '../src/daemon/agent-store.js';
import {CostLedger} from '../src/kernel/cost-ledger.js';
import {ArtifactStore} from '../src/daemon/artifacts.js';
import {GoalResults,ResultRequirementsSchema} from '../src/daemon/goal-results.js';
import {WorkRuntime} from '../src/daemon/work-runtime.js';
import {ROUTINE_ASK_CONTRACT,ROUTINE_ASK_TASK} from '../src/daemon/work-contract.js';
import {PublishPolicy} from '../src/daemon/publish-policy.js';
import {xCreateTweet} from '../src/daemon/publish-probes.js';
import type {BrowserTools} from '../src/daemon/browser-tools.js';
import type {PublishRecord} from '../src/daemon/browser-publish.js';
import type {LLMRequest} from '../src/evals/llm-client.js';

const requirement=(receipt='created')=>({id:'report',description:'Save the requested report',required:true,target:'report.md',acceptance:{receipt,contains:[],verifier:'artifact/1'},dependencies:[]});
test('missing result kinds are inferred only from explicit receipt levels',()=>{
 for(const [receipt,kind] of Object.entries({created:'artifact',sent:'message',delivered:'message',read:'message',published:'publication',custom:'custom'})){
  const item=requirement(receipt);const action=parseStructuredAction(JSON.stringify({tool:'declare_results',requirements:[item]})).action;
  assert.equal(action.tool,'declare_results');if(action.tool==='declare_results'){assert.equal(action.requirements[0].kind,kind);assert.equal(action.requirements[0].acceptance.receipt,receipt);}
  assert.equal('kind' in item,false,'normalization does not mutate caller data');
 }
 assert.equal(ResultRequirementsSchema.safeParse([requirement()]).success,false,'stored/owner schema remains strict');
 for(const item of [{...requirement(),kind:'message'},requirement('unknown'),{...requirement(),target:undefined},{...requirement(),required:undefined}]){
  assert.equal(actionSchema.safeParse({tool:'declare_results',requirements:[item]}).success,false);
 }
});
test('finish schemas expose mission decisions only to missions without mutating cached schemas',()=>{
 const ordinary=availableTools({isScheduled:true,isConversation:true}).find(t=>t.name==='finish')!;
 assert.deepEqual(ordinary.parameters.properties,{});
 const mission=availableTools({isMission:true}).find(t=>t.name==='finish')!;
 assert.ok((mission.parameters.properties as Record<string,unknown>).mission);assert.deepEqual(mission.parameters.required,['mission']);
 assert.deepEqual(availableTools({}).find(t=>t.name==='finish')!.parameters.properties,{});
 const declaration=availableTools({}).find(t=>t.name==='declare_results')!.parameters as any;
 assert.ok(declaration.properties.requirements.items.required.includes('kind'),'provider schema still teaches the complete shape');
});

function harness(actions:Record<string,unknown>[],native:boolean,required?:boolean,records:PublishRecord[]=[],existing=false){
 const store=new AgentStore(':memory:');const ledger=new CostLedger(store.getDatabase());const model='claude-haiku-4-5';
 store.createAgent({id:'alpha',name:'Fixture',model_id:model,budget_cap_usd:10,current_status:'IDLE'});
 const routine=store.createRoutine({agentId:'alpha',name:'Fixture',cronExpression:'0 10 * * *',promptTemplate:'Save the requested report.',nextRunAt:Date.now()});
 const policy=required===undefined?undefined:new PublishPolicy(store,[xCreateTweet()]);if(policy)policy.set('alpha',routine.id,required!);
 const goals=new GoalResults(store);if(existing)goals.saveRoutine('alpha',routine.id,[{...requirement(),kind:'artifact'}]);
 const run=store.createTaskRun({agentId:'alpha',taskName:ROUTINE_ASK_TASK,routineId:routine.id});store.startTaskRun(run.id,model);
 const requests:LLMRequest[]=[];
 const llm={async generateCode(request:LLMRequest){requests.push({...request,messages:structuredClone(request.messages)});const action=actions.shift();assert.ok(action,'Unexpected model turn');const {tool,...args}=action;return native?{content:'',toolCalls:[{id:'call-'+requests.length,name:String(tool),arguments:JSON.stringify(args)}],inputTokens:10,outputTokens:10,attemptCount:1}:{content:JSON.stringify(action),inputTokens:10,outputTokens:10,attemptCount:1};}};
 const unavailable=async()=>{throw Error('No Docker in this fixture');};
 const browser={status:()=>({enabled:false}),waitForOperator:async()=>{},endRun:async()=>{},setRunPolicy:()=>{},clearRunPolicy:()=>{},publishes:()=>records,closeOutPublishes:async()=>records} as unknown as BrowserTools;
 const runtime=new WorkRuntime({store,ledger,llm,artifacts:new ArtifactStore(store),browser,publishPolicy:policy,sandbox:{createWorkspaceVolume:unavailable,stageWorkspaceFiles:unavailable,readWorkspaceFile:unavailable,executeTask:unavailable,destroyWorkspaceVolume:unavailable}});
 return {store,goals,run,requests,execute:()=>runtime.execute({taskRunId:run.id,contract:ROUTINE_ASK_CONTRACT,request:'Save the requested report.',conversation:true,scheduled:{routineId:routine.id},signal:new AbortController().signal}),
  calls:()=>store.getTaskEvents(run.id).filter(e=>e.event_type==='TOOL_CALL').map(e=>JSON.parse(e.payload_json!)),close:()=>{ledger.close();store.close();}};
}
const write={tool:'write',path:'report.md',content:'Verified local fixture report.'};
const finish={tool:'finish',mission:{state:'complete',reason:'The local report is verified.'}};
for(const native of [false,true]){
 const mode=native?'native':'JSON';
 test(`${mode}: omitted kinds keep an existing routine checklist, including after external actions`,async()=>{
  const h=harness([{tool:'declare_results',requirements:[requirement()]},{tool:'block',reason:'Fixture stops.'}],native,undefined,[],true);
  h.store.recordEvent({task_run_id:h.run.id,agent_id:'alpha',event_type:'EXTERNAL_ACTION_STARTED',payload_json:'{}',timestamp:Date.now()});
  try{await h.execute();const call=h.calls().find(c=>c.tool==='declare_results');assert.equal(call.status,'ok');assert.match(call.summary,/already has its result checklist/);assert.equal(h.goals.manifest('alpha',h.run.id)!.revision,1);}finally{h.close();}
 });
 test(`${mode}: an accidental mission field does not block a verified routine finish`,async()=>{
  const h=harness([write,{tool:'verify'},finish],native);
  try{const result=await h.execute();assert.equal(result.outcome,'COMPLETED',result.report);assert.equal(result.mission,undefined);assert.ok(h.store.getTaskEvents(h.run.id).some(e=>e.event_type==='WORK_ACTION_NORMALIZED'));}finally{h.close();}
 });
 test(`${mode}: dropping mission metadata never bypasses verification`,async()=>{
  const h=harness([finish,{tool:'block',reason:'No verified work.'}],native);
  try{const result=await h.execute();assert.notEqual(result.outcome,'COMPLETED');assert.match(h.calls()[0].summary,/fixed checks must pass/);}finally{h.close();}
 });
 test(`${mode}: required publication is visible before work and a draft cannot complete it`,async()=>{
  const h=harness([{tool:'result_status'},write,{tool:'verify'},finish,{tool:'block',reason:'The account needs human sign-in; no post was submitted.'}],native,true);
  try{const result=await h.execute();assert.notEqual(result.outcome,'COMPLETED');assert.match(JSON.stringify(h.requests[0].messages),/publication.*required.*true/);const status=h.calls().find(c=>c.tool==='result_status').publication;assert.equal(status.required,true);assert.equal(status.canComplete,false);assert.equal(status.blocker,'none');assert.match(h.calls().find(c=>c.tool==='finish').summary,/no post was confirmed/);}finally{h.close();}
 });
 test(`${mode}: owner draft-only policy permits a verified draft with no post`,async()=>{
  const h=harness([{tool:'result_status'},write,{tool:'verify'},finish],native,false);
  try{const result=await h.execute();assert.equal(result.outcome,'COMPLETED',result.report);assert.equal(h.calls()[0].publication.required,false);}finally{h.close();}
 });
 test(`${mode}: an uncertain send remains unconfirmed even when posting is optional`,async()=>{
  const h=harness([{tool:'result_status'},{tool:'answer',text:'Done.',citations:[]},{tool:'block',reason:'The send is uncertain. Do not send again.'}],native,false,[{state:'unobserved',origin:'https://x.com',probe:xCreateTweet().id} as PublishRecord]);
  try{const result=await h.execute();assert.notEqual(result.outcome,'COMPLETED');assert.equal(h.calls()[0].publication.blocker,'unconfirmed');assert.match(h.calls().find(c=>c.tool==='answer').summary,/do not post again/);}finally{h.close();}
 });
}
