import {createHash,randomUUID} from 'node:crypto';
import type {AgentStore} from './agent-store.js';
import {CharacterConflictError,CharacterInvalidError} from './character-schema.js';
import {CHARACTER_RISK_VERSION} from './character-risk.js';
import type {ServedIdentity} from '../evals/llm-client.js';
import {resolveReviewer} from './character-speaker.js';
export interface QualificationKey {agentId:string;authorModel:string;authorConnection:string|null;reviewerModel:string;reviewerConnection:string|null;weightsSha256:string|null;
  language:string;surface:string;characterVersion:number;riskVersion:string;rubricVersion:string;servedModelKnown:boolean;authorRequested?:string;reviewerRequested?:string}
export const qualificationKey=(key:QualificationKey)=>createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(key).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
export const auditDraw=(utteranceId:string)=>createHash('sha256').update('character-audit-v1\n'+utteranceId).digest().readUInt32BE(0)/0x100000000;
export class CharacterQualification {
  constructor(readonly store:AgentStore,private revoke:(agentId:string)=>void=()=>{}) {
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_character_qualifications (
      key_hash TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,key_json TEXT NOT NULL,
      state TEXT NOT NULL,epoch TEXT NOT NULL,epoch_at INTEGER NOT NULL,qualified_at INTEGER,labels_count INTEGER NOT NULL,
      invalidated_at INTEGER,reason TEXT);
      CREATE TABLE IF NOT EXISTS bot_character_candidate_identity(candidate_id TEXT PRIMARY KEY REFERENCES bot_character_candidates(id) ON DELETE CASCADE,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,key_hash TEXT NOT NULL,key_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_character_sampling(utterance_id TEXT PRIMARY KEY REFERENCES bot_character_utterances(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,key_hash TEXT NOT NULL,epoch TEXT NOT NULL,draw REAL NOT NULL,decision TEXT NOT NULL,reasons_json TEXT NOT NULL,probability REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_character_qualification_history(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,key_hash TEXT NOT NULL,epoch TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  ensure(key:QualificationKey) {
    if(!this.store.getAgent(key.agentId))throw new CharacterInvalidError('Bot not found.');
    const hash=qualificationKey(key),db=this.store.getDatabase();
    const activeRow=this.store.getAgentData(key.agentId,'active-evaluator','character'),active=activeRow?JSON.parse(activeRow.data_json).keyHash:null;
    if(active!==hash){
      if(active)this.invalidate(active,'identity-changed');
      if(this.get(hash))this.invalidate(hash,'identity-changed');
      this.store.setAgentData({agentId:key.agentId,category:'character',key:'active-evaluator',data:{keyHash:hash}});
    }
    db.prepare("INSERT OR IGNORE INTO bot_character_qualifications VALUES (?,?,?,'full',?,?,NULL,0,NULL,'insufficient-independent-evidence')").run(hash,key.agentId,JSON.stringify(key),randomUUID(),Date.now());
    return this.get(hash)!;
  }
  get(hash:string){return this.store.getDatabase().prepare('SELECT * FROM bot_character_qualifications WHERE key_hash=?').get(hash) as {key_hash:string;agent_id:string;key_json:string;state:'full'|'adaptive';epoch:string;epoch_at:number;qualified_at:number|null;labels_count:number;invalidated_at:number|null;reason:string|null}|undefined;}
  observeServed(agentId:string,role:'author'|'reviewer',modelId:string,connectionId:string|null,served:ServedIdentity|undefined) {
    const identity=served?.routingMode==='pinned'&&served.matchesRequested===true&&served.routedVia&&served.fallbackAttempts===0?served.routedVia:null;
    const key=`served-${role}`,row=this.store.getAgentData(agentId,key,'character'),previous=row?JSON.parse(row.data_json):null;
    const next={modelId,connectionId,identity};
    if(previous&&JSON.stringify(previous)!==JSON.stringify(next))this.invalidateAgent(agentId,'served-identity-changed');
    this.store.setAgentData({agentId,key,category:'character',data:next});
  }
  servedIdentity(agentId:string,author:{modelId:string;connectionId:string|null},reviewer:{modelId:string;connectionId:string|null}) {
    const read=(role:string,requested:typeof author)=>{const row=this.store.getAgentData(agentId,`served-${role}`,'character'),v=row?JSON.parse(row.data_json):null;return v?.modelId===requested.modelId&&v?.connectionId===requested.connectionId?v.identity as string|null:null;};
    const a=read('author',author),r=read('reviewer',reviewer);return a&&r?{author:a,reviewer:r}:null;
  }
  stamp(candidateId:string,key:QualificationKey,final=false) {this.ensure(key);this.store.getDatabase().prepare(`INSERT INTO bot_character_candidate_identity VALUES (?,?,?,?) ON CONFLICT(candidate_id) DO ${final?'UPDATE SET key_hash=excluded.key_hash,key_json=excluded.key_json':'NOTHING'}`).run(candidateId,key.agentId,qualificationKey(key),JSON.stringify(key));}
  invalidate(hash:string,reason:string) {
    const current=this.get(hash);if(!current)return;
    this.store.transaction(()=>{const now=Date.now(),epoch=randomUUID();this.store.getDatabase().prepare("UPDATE bot_character_qualifications SET state='full',epoch=?,epoch_at=?,qualified_at=NULL,labels_count=0,invalidated_at=?,reason=? WHERE key_hash=?").run(epoch,now,now,reason,hash);
      this.store.getDatabase().prepare('INSERT INTO bot_character_qualification_history VALUES (?,?,?,?,?,?)').run(randomUUID(),current.agent_id,hash,epoch,reason,now);this.revoke(current.agent_id);});
  }
  invalidateAgent(agentId:string,reason:string){for(const r of this.store.getDatabase().prepare('SELECT key_hash FROM bot_character_qualifications WHERE agent_id=?').all(agentId) as {key_hash:string}[])this.invalidate(r.key_hash,reason);}
  evidenceRemoved(ids:string[]) {for(const id of ids){const row=this.store.getDatabase().prepare('SELECT key_hash FROM bot_character_candidate_identity WHERE candidate_id=?').get(id) as {key_hash:string}|undefined;if(row)this.invalidate(row.key_hash,'evidence-removed');}}
  refresh(hash:string) {
    const current=this.get(hash);if(!current)return null;const key=JSON.parse(current.key_json) as QualificationKey;
    const rows=this.store.getDatabase().prepare(`SELECT c.exact_sha256 digest,l.label FROM bot_character_audit_labels l
      JOIN bot_character_candidates c ON c.id=l.candidate_id JOIN bot_character_candidate_identity i ON i.candidate_id=c.id
      WHERE i.key_hash=? AND l.epoch=? AND NOT EXISTS(SELECT 1 FROM bot_character_audit_labels newer WHERE newer.supersedes_id=l.id)`)
      .all(hash,current.epoch) as {digest:string;label:string}[];
    const grouped=new Map<string,Set<string>>();for(const r of rows){const labels=grouped.get(r.digest)??new Set();labels.add(r.label);grouped.set(r.digest,labels);}
    const disagreement=[...grouped.values()].some(s=>s.size>1),defect=rows.some(r=>r.label==='accept-defect');
    const count=[...grouped.values()].filter(s=>s.size===1&&s.has('accept-ok')).length;
    const qualified=key.servedModelKnown&&key.riskVersion===CHARACTER_RISK_VERSION&&!disagreement&&!defect&&count>=300;
    this.store.getDatabase().prepare('UPDATE bot_character_qualifications SET state=?,labels_count=?,qualified_at=?,reason=? WHERE key_hash=?').run(qualified?'adaptive':'full',count,qualified?(current.qualified_at??Date.now()):null,
      qualified?null:!key.servedModelKnown?'served-model-unknown':defect?'audited-defect':disagreement?'conflicting-labels':'insufficient-independent-evidence',hash);
    if(!qualified&&current.state==='adaptive')this.revoke(current.agent_id);
    return this.get(hash)!;
  }
  decide(key:QualificationKey,utteranceId:string,risk:{kind:'full'|'eligible';reasons:string[]},requested:boolean) {
    return this.store.transaction(()=>{const q=this.ensure(key),db=this.store.getDatabase();
      const prior=db.prepare('SELECT draw,key_hash,epoch FROM bot_character_sampling WHERE utterance_id=?').get(utteranceId) as {draw:number;key_hash:string;epoch:string}|undefined;
      const draw=prior?.draw??auditDraw(utteranceId);
      const qualified=requested&&risk.kind==='eligible'&&q.state==='adaptive'&&(!prior||prior.key_hash===q.key_hash&&prior.epoch===q.epoch);
      const decision=qualified?(draw<.1?'sampled':'not-sampled'):'full';
      db.prepare('INSERT INTO bot_character_sampling VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(utterance_id) DO UPDATE SET decision=excluded.decision,reasons_json=excluded.reasons_json,probability=excluded.probability')
        .run(utteranceId,key.agentId,q.key_hash,q.epoch,draw,decision,JSON.stringify(risk.reasons),qualified?.1:1);
      return {decision,keyHash:q.key_hash,epoch:q.epoch,probability:qualified?.1:1};});
  }
  assertRelease(utteranceId:string) {
    const row=this.store.getDatabase().prepare('SELECT * FROM bot_character_sampling WHERE utterance_id=?').get(utteranceId) as {decision:string;key_hash:string;epoch:string}|undefined;
    if(row?.decision==='not-sampled'){const q=this.get(row.key_hash),active=q?this.store.getAgentData(q.agent_id,'active-evaluator','character'):null;
      if(!q||q.state!=='adaptive'||q.epoch!==row.epoch||!active||JSON.parse(active.data_json).keyHash!==q.key_hash)throw new CharacterConflictError('Review qualification changed. Prepare the draft again.');
      const key=JSON.parse(q.key_json) as QualificationKey,agent=this.store.getAgent(q.agent_id),version=this.store.getDatabase().prepare('SELECT version,settings_json FROM bot_character_versions WHERE agent_id=? ORDER BY version DESC LIMIT 1').get(q.agent_id) as {version:number;settings_json:string}|undefined;
      const reviewer=agent&&version?resolveReviewer(agent,JSON.parse(version.settings_json)):null;
      const served=agent&&reviewer?this.servedIdentity(q.agent_id,{modelId:agent.model_id,connectionId:agent.connection_id??null},reviewer):null;
      if(!agent||!version||version.version!==key.characterVersion||agent.model_id!==(key.authorRequested??key.authorModel)||(agent.connection_id??null)!==key.authorConnection||!reviewer||reviewer.modelId!==(key.reviewerRequested??key.reviewerModel)||reviewer.connectionId!==key.reviewerConnection||!served||served.author!==key.authorModel||served.reviewer!==key.reviewerModel)throw new CharacterConflictError('Evaluator configuration changed. Prepare the draft again.');}
  }
  status(agentId:string){return this.store.getDatabase().prepare('SELECT key_hash,key_json,state,epoch,qualified_at,labels_count,invalidated_at,reason FROM bot_character_qualifications WHERE agent_id=? ORDER BY epoch_at DESC LIMIT 50').all(agentId);}
}
