import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {AgentStore} from './agent-store.js';

export const ResultRequirementSchema=z.object({id:z.string().min(1).max(100),kind:z.enum(['artifact','message','publication','custom']),description:z.string().min(1).max(1000),required:z.boolean(),target:z.string().min(1).max(1000),
  acceptance:z.object({receipt:z.enum(['created','sent','delivered','read','published','custom']),contains:z.array(z.string().min(1).max(200)).max(20).default([]),verifier:z.string().min(1).max(100),attachmentPaths:z.array(z.string().min(1).max(200)).max(1).optional()}).strict(),dependencies:z.array(z.string().min(1).max(100)).max(20).default([])}).strict();
export const ResultRequirementsSchema=z.array(ResultRequirementSchema).max(20).superRefine((items,ctx)=>{
  const ids=new Set(items.map(i=>i.id));if(ids.size!==items.length)ctx.addIssue({code:'custom',message:'Result IDs must be unique.'});
  for(const i of items)if(i.dependencies.some(d=>!ids.has(d)||d===i.id))ctx.addIssue({code:'custom',message:'Invalid result dependency.'});
  for(const i of items)if(i.kind==='artifact'&&i.acceptance.receipt!=='created'||i.kind==='publication'&&i.acceptance.receipt!=='published'||i.kind==='message'&&!['sent','delivered','read'].includes(i.acceptance.receipt)||i.kind==='custom'&&i.acceptance.receipt!=='custom')ctx.addIssue({code:'custom',message:'Receipt must match result kind.'});
  const walk=(id:string,seen:Set<string>):boolean=>{if(seen.has(id))return false;const next=new Set(seen).add(id);return (items.find(i=>i.id===id)?.dependencies??[]).every(d=>walk(d,next));};
  if(items.some(i=>!walk(i.id,new Set())))ctx.addIssue({code:'custom',message:'Result dependencies must not cycle.'});
});
export type ResultRequirement=z.infer<typeof ResultRequirementSchema>;
export const contentDigest=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
type Attempt={id:string;result_id:string;state:string;target:string;digest:string;receipt_json:string|null};
export class GoalResults {
  constructor(private store:AgentStore){store.getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS goal_result_manifests(run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,revision INTEGER NOT NULL,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,requirements_json TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,revision));
    CREATE TABLE IF NOT EXISTS goal_result_attempts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,revision INTEGER NOT NULL,result_id TEXT NOT NULL,operation_key TEXT NOT NULL UNIQUE,target TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,receipt_json TEXT,created_at INTEGER NOT NULL,FOREIGN KEY(run_id,revision) REFERENCES goal_result_manifests(run_id,revision) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS goal_result_attempt_context(attempt_id TEXT PRIMARY KEY REFERENCES goal_result_attempts(id) ON DELETE CASCADE,context_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_result_account_scope(attempt_id TEXT PRIMARY KEY REFERENCES goal_result_attempts(id) ON DELETE CASCADE,account_key TEXT NOT NULL);
  `);}
  routine(agentId:string,routineId:string):ResultRequirement[]{
    if(this.store.getRoutine(routineId)?.agent_id!==agentId)throw new Error('Routine not found for this bot.');
    const saved=this.store.getAgentData(agentId,`results:${routineId}`,'goal-results');
    const items:ResultRequirement[]=saved?ResultRequirementsSchema.parse(JSON.parse(saved.data_json)):[];
    const db=this.store.getDatabase();
    const hasPolicy=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='routine_publish_policy'").get();
    const policy=hasPolicy?db.prepare('SELECT origin FROM routine_publish_policy WHERE routine_id=? AND agent_id=? AND required=1').get(routineId,agentId) as {origin:string}|undefined:undefined;
    // The authoritative legacy policy remains enforced by Stage 1. It cannot be removed by editing this projection.
    const generic=items.filter(r=>r.id!=='legacy-publication');
    return policy?[...generic,{id:'legacy-publication',kind:'publication',description:'Existing required publication',required:true,target:policy.origin,acceptance:{receipt:'published',contains:[],verifier:'stage1/1'},dependencies:[]}]:generic;
  }
  saveRoutine(agentId:string,routineId:string,input:unknown){const prior=this.routine(agentId,routineId),requirements=ResultRequirementsSchema.parse(input).filter(r=>r.id!=='legacy-publication');if(prior.some(r=>r.id==='legacy-publication')&&requirements.length>19)throw new Error('Reserve one result for the existing publication requirement.');this.store.setAgentData({agentId,category:'goal-results',key:`results:${routineId}`,data:requirements});return this.routine(agentId,routineId);}
  manifest(agentId:string,runId:string){
    if(this.store.getTaskRun(runId)?.agent_id!==agentId)throw new Error('Run not found for this bot.');
    const row=this.store.getDatabase().prepare('SELECT * FROM goal_result_manifests WHERE run_id=? ORDER BY revision DESC LIMIT 1').get(runId) as {revision:number;requirements_json:string}|undefined;
    return row?{revision:row.revision,requirements:ResultRequirementsSchema.parse(JSON.parse(row.requirements_json))}:null;
  }
  define(agentId:string,runId:string,baseRevision:number,requirements:unknown,actor:'owner'|'runtime',reason:string){
    const items=ResultRequirementsSchema.parse(requirements);
    return this.store.transaction(()=>{const prior=this.manifest(agentId,runId);if((prior?.revision??0)!==baseRevision)throw new Error('Result manifest changed. Reload before amending.');
      if(actor==='runtime'&&prior)throw new Error('Runtime cannot amend required results.');
      const revision=baseRevision+1;this.store.getDatabase().prepare('INSERT INTO goal_result_manifests VALUES(?,?,?,?,?,?,?)').run(runId,revision,agentId,JSON.stringify(items),actor,reason.slice(0,500),Date.now());return {revision,requirements:items};});
  }
  start(agentId:string,runId:string,resultId:string,target:string,digest:string,operationKey:string,accountKey?:string){
    return this.store.transaction(()=>{
    const manifest=this.manifest(agentId,runId),requirement=manifest?.requirements.find(r=>r.id===resultId);
    if(!manifest||!requirement||requirement.target!==target||!/^[a-f0-9]{64}$/.test(digest))throw new Error('Attempt does not match the current expected result.');
    if(this.store.getDatabase().prepare("SELECT 1 FROM goal_result_attempts WHERE run_id=? AND result_id=? AND (state IN ('pending','dispatched','uncertain') OR (state='verified' AND (revision=? OR ?!='artifact')))").get(runId,resultId,manifest.revision,requirement.kind))throw new Error('Reconcile the existing result before another attempt.');
    if(requirement.kind!=='artifact'&&this.store.getDatabase().prepare("SELECT 1 FROM goal_result_attempts a JOIN goal_result_manifests m ON m.run_id=a.run_id AND m.revision=a.revision WHERE m.agent_id=? AND a.target=? AND a.state IN ('pending','dispatched','uncertain')").get(agentId,target))throw new Error('Another unresolved attempt for this bot and destination must be reconciled first.');
    if(accountKey&&this.store.getDatabase().prepare("SELECT 1 FROM goal_result_account_scope s JOIN goal_result_attempts a ON a.id=s.attempt_id WHERE s.account_key=? AND a.target=? AND a.state IN ('pending','dispatched','uncertain')").get(accountKey,target))throw new Error('This external account and destination has an unresolved attempt in another run.');
    const id=randomUUID();this.store.getDatabase().prepare('INSERT INTO goal_result_attempts VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,runId,manifest.revision,resultId,operationKey,target,digest,'pending',null,Date.now());
    if(accountKey)this.store.getDatabase().prepare('INSERT INTO goal_result_account_scope VALUES(?,?)').run(id,accountKey);
    return id;});
  }
  dispatched(id:string){const changed=this.store.getDatabase().prepare("UPDATE goal_result_attempts SET state='dispatched' WHERE id=? AND state='pending'").run(id);if(!changed.changes)throw new Error('Attempt is not pending.');}
  uncertain(id:string){this.store.getDatabase().prepare("UPDATE goal_result_attempts SET state='uncertain' WHERE id=? AND state='dispatched'").run(id);}
  failedBeforeDispatch(id:string){this.store.getDatabase().prepare("UPDATE goal_result_attempts SET state='failed' WHERE id=? AND state='pending'").run(id);}
  recover(){this.store.getDatabase().exec("UPDATE goal_result_attempts SET state='uncertain' WHERE state='dispatched'; UPDATE goal_result_attempts SET state='failed' WHERE state='pending';");}
  saveAttemptContext(id:string,context:{chat:string;beforeIds:string[];attachment?:{path:string;digest:string}}){
    const row=this.store.getDatabase().prepare("SELECT 1 FROM goal_result_attempts WHERE id=? AND state='pending'").get(id);
    if(!row||context.beforeIds.length>100)throw new Error('Only a pending attempt can record its bounded pre-send observation.');
    this.store.getDatabase().prepare('INSERT INTO goal_result_attempt_context VALUES(?,?)').run(id,JSON.stringify(context));
  }
  unresolved(agentId:string){return this.store.getDatabase().prepare("SELECT a.*,c.context_json FROM goal_result_attempts a JOIN goal_result_manifests m ON m.run_id=a.run_id AND m.revision=a.revision LEFT JOIN goal_result_attempt_context c ON c.attempt_id=a.id WHERE m.agent_id=? AND a.state IN ('pending','dispatched','uncertain')").all(agentId) as unknown as (Attempt&{run_id:string;revision:number;context_json:string|null})[];}
  /** Stage 1 remains the independent publication verifier. This projection never changes its normalized dedupe hash. */
  publicationEvent(agentId:string,runId:string,type:string,payload:unknown,knownAccount?:string){
    const p=payload as {publishId:string;by?:string;origin?:string;exactDigest?:string;inReplyTo?:string;outcome?:string;postId?:string;postUrl?:string;settledAt?:number};
    if(type==='PUBLISH_ATTEMPTED'&&p.exactDigest&&p.by!=='operator'){
      const manifest=this.manifest(agentId,runId);if(!manifest)return;
      const matches=manifest.requirements.filter(r=>r.kind==='publication'&&r.acceptance.verifier==='stage1/1'&&(r.target===p.origin||!!p.inReplyTo&&r.target===`${p.origin}/i/status/${p.inReplyTo}`));
      if(matches.length===1){const id=this.start(agentId,runId,matches[0]!.id,matches[0]!.target,p.exactDigest,`publish:${p.publishId}`,knownAccount?`${p.origin}:${knownAccount.toLowerCase()}`:undefined);this.dispatched(id);}
    }else if(type==='PUBLISH_OBSERVED'){
      const attempt=this.store.getDatabase().prepare('SELECT * FROM goal_result_attempts WHERE run_id=? AND operation_key=?').get(runId,`publish:${p.publishId}`) as Attempt|undefined;
      if(!attempt)return;
      const account=this.store.getDatabase().prepare('SELECT account_key FROM goal_result_account_scope WHERE attempt_id=?').get(attempt.id) as {account_key:string}|undefined;
      if(p.outcome==='confirmed'&&p.postId)this.receipt(attempt.id,{verifier:'stage1/1',target:attempt.target,digest:attempt.digest,receipt:'published',reference:p.postUrl??p.postId,observedAt:Date.now(),account:account?.account_key??null});
      else if(p.outcome==='rejected')this.store.getDatabase().prepare("UPDATE goal_result_attempts SET state='failed' WHERE id=? AND state IN ('dispatched','uncertain')").run(attempt.id);
      else this.uncertain(attempt.id);
    }
  }
  /** Verifies retained bytes; this is a read-only verification attempt, never a claimed delivery. */
  verifyArtifacts(agentId:string,runId:string){
    const manifest=this.manifest(agentId,runId);if(!manifest)return;
    for(const r of manifest.requirements.filter(r=>r.kind==='artifact'&&r.acceptance.verifier==='artifact/1'&&r.acceptance.receipt==='created')){
      if(this.store.getDatabase().prepare("SELECT 1 FROM goal_result_attempts WHERE run_id=? AND revision=? AND result_id=? AND state='verified'").get(runId,manifest.revision,r.id))continue;
      const artifact=this.store.getDatabase().prepare("SELECT id,content,sha256,encoding FROM run_artifacts WHERE task_run_id=? AND path=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(runId,r.target) as {id:string;content:string;sha256:string;encoding:string}|undefined;
      if(!artifact||artifact.encoding==='base64'||!artifact.content.trim()||contentDigest(artifact.content)!==artifact.sha256||r.acceptance.contains.some(text=>!artifact.content.includes(text)))continue;
      if(/\.html?$/i.test(r.target)&&(!/<html[\s>]/i.test(artifact.content)||!/<body[\s>]/i.test(artifact.content)||!/<\/html>/i.test(artifact.content)))continue;
      const id=this.start(agentId,runId,r.id,r.target,artifact.sha256,`artifact-check:${runId}:${manifest.revision}:${r.id}:${artifact.id}`);this.dispatched(id);
      this.receipt(id,{verifier:'artifact/1',target:r.target,digest:artifact.sha256,receipt:'created',reference:artifact.id,observedAt:Date.now(),account:null});
    }
  }
  /** Internal verifier only; deliberately absent from the HTTP API and model tool schemas. */
  receipt(id:string,evidence:{verifier:string;target:string;digest:string;receipt:'created'|'sent'|'delivered'|'read'|'published';reference:string;observedAt:number;account:string|null;attachmentDigests?:string[]}){
    const db=this.store.getDatabase(),attempt=db.prepare('SELECT * FROM goal_result_attempts WHERE id=?').get(id) as (Attempt&{run_id:string;revision:number;created_at:number})|undefined;
    if(!attempt||!['dispatched','uncertain'].includes(attempt.state))throw new Error('No dispatched attempt to verify.');
    const row=db.prepare('SELECT requirements_json FROM goal_result_manifests WHERE run_id=? AND revision=?').get(attempt.run_id,attempt.revision) as {requirements_json:string};
    const requirement=ResultRequirementsSchema.parse(JSON.parse(row.requirements_json)).find(r=>r.id===attempt.result_id)!;
    if(requirement.acceptance.attachmentPaths?.length){
      const saved=db.prepare('SELECT context_json FROM goal_result_attempt_context WHERE attempt_id=?').get(id) as {context_json:string}|undefined;
      const attachment=saved?(JSON.parse(saved.context_json) as {attachment?:{path:string;digest:string}}).attachment:undefined;
      if(!attachment||requirement.acceptance.attachmentPaths[0]!==attachment.path||evidence.attachmentDigests?.length!==1||evidence.attachmentDigests[0]!==attachment.digest)throw new Error('Attachment bytes were not independently verified.');
    }else if(evidence.attachmentDigests?.length)throw new Error('Unexpected attachment evidence.');
    const rank={created:0,sent:1,delivered:2,read:3,published:1,custom:99};
    if(evidence.target!==attempt.target||evidence.digest!==attempt.digest||evidence.verifier!==requirement.acceptance.verifier||!evidence.reference||!Number.isFinite(evidence.observedAt)||evidence.observedAt<attempt.created_at||evidence.observedAt>Date.now()+1000||rank[evidence.receipt]<rank[requirement.acceptance.receipt]||((requirement.kind==='publication')!==(evidence.receipt==='published'))||(requirement.kind==='artifact'&&evidence.receipt!=='created')||(requirement.kind==='message'&&!['sent','delivered','read'].includes(evidence.receipt))||requirement.kind==='custom')throw new Error('Receipt does not satisfy the expected result.');
    db.prepare("UPDATE goal_result_attempts SET state='verified',receipt_json=? WHERE id=?").run(JSON.stringify(evidence),id);
  }
  summary(agentId:string,runId:string){
    const manifest=this.manifest(agentId,runId);if(!manifest)return {satisfaction:'unverified',legacy:true,revision:0,results:[]};
    const attempts=this.store.getDatabase().prepare('SELECT * FROM goal_result_attempts WHERE run_id=? AND revision=? ORDER BY created_at DESC').all(runId,manifest.revision) as unknown as Attempt[];
    const expired=new Set<string>();
    for(const r of manifest.requirements.filter(r=>r.kind==='artifact')){
      const attempt=attempts.find(a=>a.result_id===r.id&&a.state==='verified');if(!attempt)continue;
      const evidence=attempt.receipt_json?JSON.parse(attempt.receipt_json):null;
      const artifact=evidence?this.store.getDatabase().prepare('SELECT content,sha256,encoding FROM run_artifacts WHERE id=? AND task_run_id=? AND path=?').get(evidence.reference,runId,r.target) as {content:string;sha256:string;encoding:string}|undefined:undefined;
      const latest=this.store.getDatabase().prepare('SELECT sha256 FROM run_artifacts WHERE task_run_id=? AND path=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(runId,r.target) as {sha256:string}|undefined;
      if(!artifact||artifact.encoding==='base64'||artifact.sha256!==attempt.digest||contentDigest(artifact.content)!==attempt.digest||latest?.sha256!==attempt.digest)expired.add(r.id);
    }
    for(const r of manifest.requirements.filter(r=>r.acceptance.attachmentPaths?.length)){
      const attempt=attempts.find(a=>a.result_id===r.id&&a.state==='verified');if(!attempt)continue;
      const evidence=attempt.receipt_json?JSON.parse(attempt.receipt_json):null;
      const latest=this.store.getDatabase().prepare('SELECT content,sha256,encoding FROM run_artifacts WHERE task_run_id=? AND path=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(runId,r.acceptance.attachmentPaths![0]!) as {content:string;sha256:string;encoding:string}|undefined;
      if(!latest||latest.encoding==='base64'||contentDigest(latest.content)!==evidence?.attachmentDigests?.[0])expired.add(r.id);
    }
    const verified=new Set(attempts.filter(a=>a.state==='verified'&&!expired.has(a.result_id)).map(a=>a.result_id));
    let changed=true;while(changed){changed=false;for(const r of manifest.requirements)if(verified.has(r.id)&&r.dependencies.some(d=>!verified.has(d))){verified.delete(r.id);changed=true;}}
    const results=manifest.requirements.map(r=>{const attempt=attempts.find(a=>a.result_id===r.id);return {...r,state:expired.has(r.id)?'evidence-expired':verified.has(r.id)?'verified':attempt?.state==='verified'?'blocked':attempt?.state==='dispatched'?'running':attempt?.state??'pending',evidence:attempt?.receipt_json?JSON.parse(attempt.receipt_json):null};});
    const required=results.filter(r=>r.required);
    return {satisfaction:required.length===0?'not-required':required.every(r=>r.state==='verified')?'verified':'unverified',legacy:false,revision:manifest.revision,results};
  }
}
