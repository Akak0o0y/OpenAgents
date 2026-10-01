import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../src/daemon/agent-store.js';
import {GoalResults,contentDigest} from '../src/daemon/goal-results.js';
import {ArtifactStore} from '../src/daemon/artifacts.js';
import {RunCapacity} from '../src/daemon/run-capacity.js';
import {CombinedDecisionController,decisionDigest,unknownUsage,type Decision,type DecisionScorer} from '../src/daemon/combined-models.js';
import {combinedModelsReport,type ExperimentRun} from '../src/evals/combined-models-report.js';
import {matchWhatsAppReceipt,whatsappTarget,type WhatsAppSnapshot} from '../src/daemon/whatsapp-receipts.js';
import {RoutineAttention} from '../src/daemon/routine-attention.js';
import {PublishPolicy} from '../src/daemon/publish-policy.js';
import {xCreateTweet} from '../src/daemon/publish-probes.js';

test('result verification binds owner requirements, retained bytes, bot identity and receipt strength',()=>{
  const store=new AgentStore(':memory:');try{
    store.createAgent({id:'a',name:'Fixture',model_id:'mock',current_status:'IDLE',budget_cap_usd:0});
    store.createTaskRun({id:'r',agentId:'a',taskName:'Fixture',modelId:'mock'});
    const results=new GoalResults(store);
    results.define('a','r',0,[{id:'report',kind:'artifact',description:'Retain the report',required:true,target:'report.html',acceptance:{receipt:'created',contains:['Findings'],verifier:'artifact/1'},dependencies:[]},{id:'message',kind:'message',description:'Send report',required:true,target:'recipient',acceptance:{receipt:'delivered',verifier:'whatsapp/1',contains:[]},dependencies:['report']}],'owner','Fixture');
    assert.throws(()=>results.manifest('other','r'));
    new ArtifactStore(store).save('r',{'report.html':'<html><body>Findings</body></html>'});results.verifyArtifacts('a','r');
    assert.equal(results.summary('a','r').results[0]!.state,'verified');assert.equal(results.summary('a','r').satisfaction,'unverified');
    const a=results.start('a','r','message','recipient',contentDigest('hello'),'op');results.dispatched(a);results.recover();
    assert.equal(results.summary('a','r').results[1]!.state,'uncertain');
    assert.throws(()=>results.start('a','r','message','recipient',contentDigest('hello'),'duplicate'));
    assert.throws(()=>results.receipt(a,{verifier:'whatsapp/1',target:'recipient',digest:contentDigest('hello'),receipt:'sent',reference:'receipt',observedAt:Date.now(),account:null}));
    results.receipt(a,{verifier:'whatsapp/1',target:'recipient',digest:contentDigest('hello'),receipt:'delivered',reference:'receipt',observedAt:Date.now(),account:null});
    assert.equal(results.summary('a','r').satisfaction,'verified');
    store.getDatabase().prepare("UPDATE run_artifacts SET content='changed' WHERE task_run_id='r'").run();
    assert.equal(results.summary('a','r').satisfaction,'unverified');
    assert.equal(results.summary('a','r').results[0]!.state,'evidence-expired');
    store.createTaskRun({id:'queued',agentId:'a',taskName:'chat:test',modelId:'mock'});
    store.finishTaskRun('queued','ABORTED','Queue cancelled');assert.equal(store.getTaskRun('queued')!.status,'ABORTED');
  }finally{store.close();}
});

test('WhatsApp evidence rejects historical, wrong-target, changed-text, attachment and ambiguous messages',()=>{
  const chat=whatsappTarget('+966500000001');
  const prior={id:'prior',chat,outgoing:false,text:'prior',receipt:'sent' as const,hasAttachment:false};
  const snapshot:WhatsAppSnapshot={origin:'https://web.whatsapp.com',chat,composerText:'',composerCount:1,messages:[prior,{id:'new',chat,outgoing:true,text:'hello\nworld',receipt:'sent',hasAttachment:false}]};
  const match=(s:WhatsAppSnapshot,beforeIds:string[]=['prior'])=>matchWhatsAppReceipt({beforeIds,snapshot:s,chat,exactDigest:contentDigest('hello\nworld')});
  assert.equal(match(snapshot)?.receipt,'sent');assert.equal(match(snapshot,['new']),null);
  assert.equal(match({...snapshot,chat:'wrong'}),null);
  assert.equal(match({...snapshot,messages:[prior,{...snapshot.messages[1]!,text:'hello world'}]}),null);
  assert.equal(match({...snapshot,messages:[prior,{...snapshot.messages[1]!,hasAttachment:true}]}),null);
  assert.equal(match({...snapshot,messages:[...snapshot.messages,{...snapshot.messages[1]!,id:'other'}]}),null);
  assert.equal(match(snapshot,[]),null);
  assert.throws(()=>whatsappTarget('myself'));
});

test('legacy publication requirements retain Stage 1 proof and repeated preflight holds are per routine',()=>{
  const store=new AgentStore(':memory:');try{
    store.createAgent({id:'a',name:'Fixture',model_id:'mock',current_status:'IDLE',budget_cap_usd:0});
    const routine=store.createRoutine({agentId:'a',name:'Fixture',cronExpression:'0 * * * *',humanSchedule:'Hourly',timezone:'UTC',promptTemplate:'Fixture',nextRunAt:Date.now()});
    new PublishPolicy(store,[xCreateTweet()]).set('a',routine.id,true);
    const results=new GoalResults(store);assert.equal(results.saveRoutine('a',routine.id,[])[0]!.id,'legacy-publication');
    store.createTaskRun({id:'publish',agentId:'a',taskName:'Fixture',modelId:'mock',routineId:routine.id});
    results.define('a','publish',0,results.routine('a',routine.id),'runtime','Snapshot');
    store.transaction(()=>results.publicationEvent('a','publish','PUBLISH_ATTEMPTED',{publishId:'post',by:'flow',origin:'https://x.com',exactDigest:contentDigest('exact\npost')},'fixture'));
    results.recover();assert.equal(results.summary('a','publish').results[0]!.state,'uncertain');
    results.publicationEvent('a','publish','PUBLISH_OBSERVED',{publishId:'post',outcome:'confirmed',postId:'123'});
    assert.equal(results.summary('a','publish').satisfaction,'verified');
    const attention=new RoutineAttention(store);
    for(let n=0;n<3;n++){const id=`fail${n}`;store.createTaskRun({id,agentId:'a',taskName:'Fixture',modelId:'mock',routineId:routine.id});store.startTaskRun(id);store.finishTaskRun(id,'FAILED','Shared work runtime is unavailable.');}
    assert.equal(attention.status('a',routine.id).held,true);attention.resume('a',routine.id);assert.equal(attention.status('a',routine.id).held,false);
  }finally{store.close();}
});

test('qualification rejects invalid thresholds and writes disguised as read candidates',async()=>{
  const records:any[]=[];
  const certificate={identity:'mock',policyVersion:'1',family:'observe',language:'en',expiresAt:Date.now()+10000,minScore:.9,maxObservationAgeMs:1000,certificationSha256:'f'.repeat(64),independent:true,synthetic:false,allowedTools:['browser']};
  const scorer:DecisionScorer={identity:'mock',placement:'local',async score(r){assert.ok(Object.isFrozen(r.candidates[0]!.args));return {schema:'selection/1',requestDigest:decisionDigest(r),candidateId:'read',score:1,modelRevision:'mock',usage:unknownUsage(),truncated:false};}};
  const choose=async(cert:typeof certificate,action:string)=>{const r={...decision,observedAt:Date.now(),candidates:[{...decision.candidates[0]!,args:{action}}]};const c=new CombinedDecisionController({scorer,certificate:cert,mode:'qualified',policyVersion:'1',timeoutMs:100,maxCalls:1,record:r=>records.push(r)});return c.choose(r,new AbortController().signal,()=>({stateDigest:r.stateDigest,goalRevision:1}));};
  assert.equal(await choose({...certificate,minScore:NaN},'snapshot'),null);assert.equal(records.at(-1).reason,'unqualified');
  assert.equal(await choose(certificate,'click'),null);assert.equal(records.at(-1).reason,'ineligible-action');
  assert.equal((await choose(certificate,'snapshot'))?.id,'read');
});

test('resource admission keeps two bots independent, queues one bot and cancels without owning a slot',async()=>{
  const c=new RunCapacity(2),a=await c.wait('a1','a',new AbortController().signal),ac=new AbortController();
  const pending=c.wait('a2','a',ac.signal);const rejection=assert.rejects(pending);ac.abort();await rejection;
  const b=await c.wait('b1','b',new AbortController().signal);assert.equal(c.used,2);
  const next=c.wait('a3','a',new AbortController().signal);a();const release=await next;assert.equal(c.used,2);release();b();assert.equal(c.used,0);
});

test('a message with an attachment requires independent byte evidence, not its filename',()=>{
  const store=new AgentStore(':memory:');try{
    store.createAgent({id:'a',name:'Fixture',model_id:'mock',current_status:'IDLE',budget_cap_usd:0});store.createTaskRun({id:'r',agentId:'a',taskName:'Fixture',modelId:'mock'});
    const goals=new GoalResults(store),digest=contentDigest('report bytes');
    new ArtifactStore(store).save('r',{'report.html':'report bytes'});
    goals.define('a','r',0,[{id:'message',kind:'message',description:'Send HTML',target:'+966500000001',required:true,acceptance:{receipt:'sent',verifier:'whatsapp/1',attachmentPaths:['report.html']}}],'owner','Fixture');
    const attempt=goals.start('a','r','message','+966500000001',contentDigest('caption'),'attachment');goals.saveAttemptContext(attempt,{chat:'966500000001@c.us',beforeIds:['prior'],attachment:{path:'report.html',digest}});goals.dispatched(attempt);
    const receipt={verifier:'whatsapp/1',target:'+966500000001',digest:contentDigest('caption'),receipt:'sent' as const,reference:'outgoing-message',observedAt:Date.now(),account:null};
    assert.throws(()=>goals.receipt(attempt,receipt));assert.throws(()=>goals.receipt(attempt,{...receipt,attachmentDigests:[contentDigest('wrong bytes')]}));
    goals.receipt(attempt,{...receipt,attachmentDigests:[digest]});assert.equal(goals.summary('a','r').satisfaction,'verified');
    store.finishTaskRun('r','ABORTED','Fixture ended');new ArtifactStore(store).edit('r','report.html','new report bytes','report bytes');assert.equal(goals.summary('a','r').satisfaction,'unverified');
  }finally{store.close();}
});

const decision:Decision={schema:'decision/1',agentId:'a',runId:'r',decisionId:'d',subgoalId:'s',family:'observe',language:'en',observationId:'o',observedAt:Date.now(),stateDigest:'a'.repeat(64),goalRevision:1,context:'Fixture',candidates:[{id:'read',tool:'browser',args:{action:'snapshot'},target:'tab',preconditionDigest:'a'.repeat(64),expectedEffect:'Read current page',risk:'read'}]};
test('a scorer cannot dispatch in shadow, reuse observations, or replace the offered candidate',async()=>{
  let calls=0;const records:any[]=[];
  const scorer:DecisionScorer={identity:'fixture@1',placement:'local',async score(r){calls++;return {schema:'selection/1',requestDigest:decisionDigest(r),candidateId:'read',score:.99,modelRevision:'fixture@1',usage:unknownUsage(),truncated:false};}};
  const controller=new CombinedDecisionController({scorer,mode:'shadow',policyVersion:'1',timeoutMs:100,maxCalls:3,record:r=>records.push(r)});
  const current=()=>({stateDigest:decision.stateDigest,goalRevision:1});
  assert.equal(await controller.choose(decision,new AbortController().signal,current),null);
  assert.equal(await controller.choose(decision,new AbortController().signal,current),null);assert.equal(calls,1);assert.equal(records[0].reason,'shadow-only');
  const bad=new CombinedDecisionController({scorer:{...scorer,score:async r=>({...await scorer.score(r,new AbortController().signal),candidateId:'invented'})},mode:'qualified',policyVersion:'1',timeoutMs:100,maxCalls:1,record:r=>records.push(r)});
  assert.equal(await bad.choose(decision,new AbortController().signal,current),null);assert.equal(records[1].reason,'invalid-candidate');
});

test('research summaries include failures, preserve unknown usage, and refuse split leakage',()=>{
  const make=(pairId:string,arm:'A'|'C',verified:boolean):ExperimentRun=>({schema:'combined-run/1',experimentId:'fixture',taskId:pairId,lineage:pairId,pairId,arm,split:'pilot',language:'ar',concurrentBots:2,seed:1,synthetic:true,
    manifest:{sourceRevision:'fixture',dirtySourceSha256:'a'.repeat(64),taskSha256:'b'.repeat(64),policySha256:'c'.repeat(64),evaluatorVersion:'fixture/1',hardware:'fixture',runtime:'node',models:['mock'],tokenizers:['mock'],precision:'fixture',endpointPlacement:'local',cacheState:'warm',order:arm==='A'?0:1},deadlineMs:1000,elapsedMs:verified?100:200,verifiedAtMs:verified?100:null,requiredOutcomes:1,verifiedOutcomes:verified?1:0,falseCompletion:false,wrongEffect:false,duplicateEffect:false,humanInterventions:0,fallbacks:0,calls:[{id:'call',role:'scorer',model:'mock',durationMs:10,status:'ok',usage:unknownUsage()}]});
  const report=combinedModelsReport([make('1','A',true),make('1','C',false),make('2','A',true),make('2','C',true)]);
  assert.equal(report.arms[1]!.p95VerifiedMs,null);assert.equal(report.arms[1]!.restrictedMeanUncompletedMs,550);
  assert.equal(report.arms[1]!.usage.inputTokens!.total,null);assert.equal(report.comparisons[0]!.successDifference,-.5);assert.equal(report.comparisons[0]!.successUncertainty.interval95,null);
  assert.throws(()=>combinedModelsReport([make('1','A',true),{...make('1','C',true),split:'certification'}]));
  assert.equal(report.promotion,'not-authorized');
});
