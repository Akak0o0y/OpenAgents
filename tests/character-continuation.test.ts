import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../src/daemon/agent-store.js';
import {CharacterStore} from '../src/daemon/character-store.js';
import {CharacterJournal} from '../src/daemon/character-journal.js';
import {CharacterAdmissions,exactSha256} from '../src/daemon/character-admission.js';
import {CharacterProposals} from '../src/daemon/character-proposals.js';
import {CharacterClaims} from '../src/daemon/character-claims.js';
import {CharacterRhythm} from '../src/daemon/character-rhythm.js';
import {CharacterQualification,type QualificationKey} from '../src/daemon/character-qualification.js';
import {CharacterAudit} from '../src/daemon/character-audit.js';
import {CharacterReviewService} from '../src/daemon/character-review-service.js';
import {CharacterRetention} from '../src/daemon/character-retention.js';
import {EngagementReader} from '../src/daemon/engagement-reader.js';
import {RunCapacity} from '../src/daemon/run-capacity.js';
import {FlowStore} from '../src/daemon/flow-store.js';
import {CHARACTER_RISK_VERSION,classifyReviewRisk} from '../src/daemon/character-risk.js';
import {applyCharacterChanges} from '../src/daemon/character-changes.js';
import {localQualification,ShadowReviewWorker,type ReviewRequest} from '../src/daemon/character-review-backend.js';

function fixture(){
  const store=new AgentStore(':memory:');store.createAgent({id:'a',name:'Milo',model_id:'gpt-4o',current_status:'IDLE',budget_cap_usd:10});
  const characters=new CharacterStore(store),journal=new CharacterJournal({store}),proposals=new CharacterProposals(store,characters);
  const v=characters.save('a',0,{settings:{mode:'voice'},document:{identity:{oneLine:'A careful writer.'},purpose:{statement:'Explain clearly.'},voice:{examples:['One clear example.','Another useful observation.','A third careful example.'].map((text,i)=>({id:`ex-${i}`,text,surface:'post',pinned:i<2,tags:[],origin:'owner'}))}}});
  const admissions=new CharacterAdmissions({store,journal,activeVersion:id=>characters.getLatestVersion(id)});
  const qualification=new CharacterQualification(store),audit=new CharacterAudit(store,qualification,()=>0);
  const claims=new CharacterClaims(store,characters,journal),rhythm=new CharacterRhythm(store,characters),backend=new CharacterReviewService(store);
  new EngagementReader(store,characters,{} as never,new RunCapacity(1));
  const retention=new CharacterRetention(store,characters,admissions,ids=>qualification.evidenceRemoved(ids));
  const key:QualificationKey={agentId:'a',authorModel:'gpt-4o',authorConnection:null,reviewerModel:'gpt-4o',reviewerConnection:null,weightsSha256:null,language:'en',surface:'public-post',characterVersion:v.version,riskVersion:CHARACTER_RISK_VERSION,rubricVersion:'review/1',servedModelKnown:true};
  function candidate(text:string){const u=journal.createUtterance({agentId:'a',runId:'r',op:'post',version:v.version});const c=journal.recordCandidate({agentId:'a',utteranceId:u.id,attempt:1,text,exactSha256:exactSha256(text),textSha256:exactSha256(text),version:v.version,selection:{},evidence:[],rules:{}});qualification.stamp(c.id,key);journal.hold(u.id,'semantic-failed','failed');return c;}
  return {store,characters,journal,proposals,qualification,audit,claims,rhythm,backend,retention,key,candidate};
}

test('integrated storage supports exact proposal approval, nested edits and retention',t=>{
  const h=fixture();t.after(()=>h.store.close());
  h.store.createTaskRun({id:'setup',agentId:'a',taskName:'Character setup',modelId:'gpt-4o'});
  const p=h.proposals.create({agentId:'a',runId:'setup',kind:'change',value:{draft:{document:{identity:{oneLine:'A warmer writer.'}}},bundles:[],assumptions:[]}});
  const edited=h.proposals.edit('a',p,{draft:{document:{purpose:{statement:'Help explain.'}}}});
  assert.throws(()=>h.proposals.decide('a',p,'approve',[]));
  h.proposals.decide('a',edited,'approve',[]);
  assert.equal(h.characters.getLatestVersion('a')!.document.identity.oneLine,'A warmer writer.');
  assert.equal(h.characters.getLatestVersion('a')!.document.purpose.statement,'Help explain.');
  assert.equal(h.backend.status('a').qualified,false);assert.throws(()=>h.backend.configure('a','local'));
  assert.deepEqual(h.claims.page('a').items,[]);assert.equal(h.retention.prune('a').removed,0);
  const doc=h.characters.getLatestVersion('a')!.document;
  assert.equal(applyCharacterChanges(doc,[{op:'add',collection:'voice.rules.do',item:'Be clear.'}],[],'voice').voice.rules.do.length,1);
});

test('299/300 distinct audits qualify, a defect revokes, and a correction cannot resurrect an epoch',t=>{
  const h=fixture();t.after(()=>h.store.close());const candidates=Array.from({length:300},(_,i)=>h.candidate(`Unique candidate ${i}`));
  const q=h.qualification.ensure(h.key);
  for(let i=0;i<300;i++){
    if(i%50===0)h.audit.queue('a',50);
    h.audit.label({agentId:'a',candidateId:candidates[i].id,label:'accept-ok',reason:'Independently checked fixture',idempotencyKey:`audit-${i}`});
    if(i===298)assert.equal(h.qualification.get(q.key_hash)!.state,'full');
  }
  assert.equal(h.qualification.get(q.key_hash)!.state,'adaptive');
  const prior=h.audit.history('a',candidates[0].id)[0] as {id:string};
  const defect=h.audit.label({agentId:'a',candidateId:candidates[0].id,label:'accept-defect',reason:'Correction',supersedesId:prior.id,idempotencyKey:'defect'}) as {id:string};
  assert.equal(h.qualification.get(q.key_hash)!.state,'full');
  h.audit.label({agentId:'a',candidateId:candidates[0].id,label:'accept-ok',reason:'Rechecked',supersedesId:defect.id,idempotencyKey:'corrected'});
  assert.equal(h.qualification.get(q.key_hash)!.labels_count,1);assert.equal(h.qualification.get(q.key_hash)!.state,'full');
  h.retention.prune('a',true);assert.equal(h.qualification.get(q.key_hash)!.state,'full');
});

test('flow proof recovery and per-run outcomes are durable and idempotent',t=>{
  const h=fixture();t.after(()=>h.store.close());const flows=new FlowStore(h.store);
  h.store.createRoutine({id:'routine',agentId:'a',name:'Routine',cronExpression:'0 * * * *',promptTemplate:'Post',nextRunAt:Date.now()});
  h.store.createTaskRun({id:'run',agentId:'a',taskName:'routine:ask',modelId:'gpt-4o'});
  h.store.recordEvent({agent_id:'a',task_run_id:'run',event_type:'PUBLISH_OBSERVED',payload_json:JSON.stringify({outcome:'confirmed',postId:'123'}),timestamp:Date.now()});
  assert.equal(flows.playbackEnabled('a'),true);
  flows.noteRejected({agentId:'a',routineId:'routine',flowKey:'key',origin:'https://x.com',probe:'x',runId:'run',reason:'No safe trace'});
  const f=flows.get('a','key')!;flows.note(f.id,'run',{outcome:'miss'});flows.note(f.id,'run',{outcome:'miss'});
  assert.equal(flows.get('a','key')!.consecutiveMisses,1);
});

test('risk and local qualification fail closed; a stuck shadow backend retains its bounded slot',async()=>{
  assert.equal(classifyReviewRisk({text:'I visited Rome in 2025.',op:'post',language:'en',configuredLanguages:['en'],surface:'public-post',approvedEntities:[],commitmentTopics:[],disputedKeys:[]}).kind,'full');
  assert.equal(localQualification({manifest:{} as never,metrics:{} as never,synthetic:true,independent:false,heldOut:false,memoryScope:'unknown',hardwareId:'',distinctDigests:0}),false);
  const records:unknown[]=[],controller=new AbortController();let calls=0;
  const worker=new ShadowReviewWorker({review:async()=>{calls++;return new Promise(()=>{});}},r=>records.push(r),1,0);
  const request={agentId:'a',exactDigest:'d',packetSha256:'p',rubricVersion:'r',evidence:[]} as unknown as ReviewRequest;
  worker.submit(request,controller.signal);await Promise.resolve();controller.abort();await new Promise(r=>setTimeout(r,5));
  worker.submit(request,new AbortController().signal);assert.equal(calls,1);assert.ok(records.some((r:any)=>r.reason==='queue-full'));worker.stop();
});
