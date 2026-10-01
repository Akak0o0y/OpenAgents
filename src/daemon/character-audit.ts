import {randomUUID,randomInt} from 'node:crypto';
import {z} from 'zod';
import type {AgentStore} from './agent-store.js';
import {CharacterQualification} from './character-qualification.js';
import {CharacterConflictError,CharacterInvalidError,CharacterNotFoundError} from './character-schema.js';
export type AuditLabel='accept-ok'|'accept-defect'|'hold-correct'|'hold-wrong';
export const AuditDecisionSchema=z.object({agentId:z.string().min(1),candidateId:z.string().min(1),label:z.enum(['accept-ok','accept-defect','hold-correct','hold-wrong']),reason:z.string().trim().min(1).max(2000),supersedesId:z.string().optional(),idempotencyKey:z.string().min(1).max(200)}).strict();
export class CharacterAudit {
  constructor(private store:AgentStore,private qualification:CharacterQualification,private random=()=>randomInt(0,0x100000000)/0x100000000) {
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_character_audit_queue(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,candidate_id TEXT NOT NULL REFERENCES bot_character_candidates(id) ON DELETE CASCADE,probability REAL NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER,UNIQUE(agent_id,candidate_id));
      CREATE TABLE IF NOT EXISTS bot_character_audit_labels(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,candidate_id TEXT NOT NULL REFERENCES bot_character_candidates(id) ON DELETE CASCADE,
        evaluator_identity TEXT NOT NULL,exact_digest TEXT NOT NULL,label TEXT NOT NULL,adjudicator_type TEXT NOT NULL,adjudicator_id TEXT NOT NULL,reason TEXT NOT NULL,sampled_probability REAL NOT NULL,created_at INTEGER NOT NULL,supersedes_id TEXT UNIQUE,epoch TEXT NOT NULL,idempotency_key TEXT NOT NULL,UNIQUE(agent_id,idempotency_key));`);
  }
  queue(agentId:string,limit=20,key?:string,cursor?:string,language?:string,surface?:string) {
    if(!this.store.getAgent(agentId))throw new CharacterNotFoundError('Bot not found.');
    limit=Math.min(50,Math.max(1,limit));const db=this.store.getDatabase();
    return this.store.transaction(()=>{
      const filter=" AND (? IS NULL OR json_extract(i.key_json,'$.language')=?) AND (? IS NULL OR json_extract(i.key_json,'$.surface')=?)",filters=[language??null,language??null,surface??null,surface??null];
      const pending=(db.prepare(`SELECT q.id,q.candidate_id,q.created_at FROM bot_character_audit_queue q JOIN bot_character_candidate_identity i ON i.candidate_id=q.candidate_id WHERE q.agent_id=? AND q.completed_at IS NULL AND (? IS NULL OR i.key_hash=?) ${filter} ORDER BY q.created_at,q.id`).all(agentId,key??null,key??null,...filters) as {id:string;candidate_id:string;created_at:number}[]);
      if(!cursor&&pending.length<limit){
        const eligible=db.prepare(`SELECT c.id FROM bot_character_candidates c JOIN bot_character_candidate_identity i ON i.candidate_id=c.id
          WHERE c.agent_id=? AND (? IS NULL OR i.key_hash=?) ${filter}
          AND EXISTS(SELECT 1 FROM bot_character_utterances u WHERE u.id=c.utterance_id AND u.status NOT IN ('draft','admitted','attempted'))
          AND NOT EXISTS(SELECT 1 FROM bot_character_audit_queue q WHERE q.candidate_id=c.id)`).all(agentId,key??null,key??null,...filters) as {id:string}[];
        const count=Math.min(limit-pending.length,eligible.length),probability=eligible.length?count/eligible.length:1;
        for(let i=0;i<count;i++){const j=i+Math.min(eligible.length-i-1,Math.floor(this.random()*(eligible.length-i)));[eligible[i],eligible[j]]=[eligible[j],eligible[i]];
          const id=randomUUID(),created_at=Date.now();db.prepare('INSERT INTO bot_character_audit_queue VALUES (?,?,?,?,?,NULL)').run(id,agentId,eligible[i].id,probability,created_at);pending.push({id,candidate_id:eligible[i].id,created_at});}
      }
      pending.sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id));
      let remaining=pending;
      if(cursor){const anchor=db.prepare('SELECT created_at,id FROM bot_character_audit_queue WHERE id=? AND agent_id=?').get(cursor,agentId) as {created_at:number;id:string}|undefined;
        if(!anchor)throw new CharacterInvalidError('Audit cursor is stale.');remaining=pending.filter(p=>p.created_at>anchor.created_at||p.created_at===anchor.created_at&&p.id>anchor.id);}
      const selected=remaining.slice(0,limit),items=selected.map(row=>db.prepare(`SELECT q.id queueId,q.probability,c.id candidateId,c.text,c.exact_sha256 exactDigest,c.evidence_json evidence,c.rules_json rules,i.key_hash keyHash,i.key_json evaluatorIdentity,u.status,u.semantic
        FROM bot_character_audit_queue q JOIN bot_character_candidates c ON c.id=q.candidate_id JOIN bot_character_candidate_identity i ON i.candidate_id=c.id JOIN bot_character_utterances u ON u.id=c.utterance_id WHERE q.id=? AND q.agent_id=?`).get(row.id,agentId));
      return {items,nextCursor:remaining.length>limit?selected.at(-1)?.id??null:null};
    });
  }
  label(input:z.infer<typeof AuditDecisionSchema>) {
    const v=AuditDecisionSchema.parse(input),db=this.store.getDatabase();
    return this.store.transaction(()=>{
      const prior=db.prepare('SELECT * FROM bot_character_audit_labels WHERE agent_id=? AND idempotency_key=?').get(v.agentId,v.idempotencyKey) as any;
      if(prior){if(prior.candidate_id!==v.candidateId||prior.label!==v.label||prior.reason!==v.reason||prior.supersedes_id!==(v.supersedesId??null))throw new CharacterConflictError('Idempotency key already used for another audit.');return prior;}
      const candidate=db.prepare('SELECT c.exact_sha256,i.key_hash,i.key_json FROM bot_character_candidates c JOIN bot_character_candidate_identity i ON i.candidate_id=c.id WHERE c.id=? AND c.agent_id=?').get(v.candidateId,v.agentId) as {exact_sha256:string;key_hash:string;key_json:string}|undefined;
      if(!candidate)throw new CharacterNotFoundError('Owned candidate evidence is unavailable.');
      const queue=db.prepare('SELECT probability FROM bot_character_audit_queue WHERE agent_id=? AND candidate_id=?').get(v.agentId,v.candidateId) as {probability:number}|undefined;if(!queue)throw new CharacterInvalidError('Select the candidate through the audit queue first.');
      const effective=db.prepare('SELECT l.id FROM bot_character_audit_labels l WHERE l.agent_id=? AND l.candidate_id=? AND NOT EXISTS(SELECT 1 FROM bot_character_audit_labels n WHERE n.supersedes_id=l.id)').get(v.agentId,v.candidateId) as {id:string}|undefined;
      if((effective?.id??undefined)!==v.supersedesId)throw new CharacterConflictError('The current audit changed. Reload its history.');
      const id=randomUUID(),q=this.qualification.get(candidate.key_hash)!;
      db.prepare('INSERT INTO bot_character_audit_labels VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,v.agentId,v.candidateId,candidate.key_json,candidate.exact_sha256,v.label,'owner','local-owner',v.reason,queue.probability,Date.now(),v.supersedesId??null,q.epoch,v.idempotencyKey);
      db.prepare('UPDATE bot_character_audit_queue SET completed_at=? WHERE candidate_id=? AND agent_id=?').run(Date.now(),v.candidateId,v.agentId);
      if(v.label==='accept-defect')this.qualification.invalidate(candidate.key_hash,'audited-defect');else this.qualification.refresh(candidate.key_hash);
      return {id,label:v.label,adjudicatorType:'owner',adjudicatorId:'local-owner'};
    });
  }
  history(agentId:string,candidateId:string){return this.store.getDatabase().prepare('SELECT id,label,reason,adjudicator_type,adjudicator_id,created_at,supersedes_id FROM bot_character_audit_labels WHERE agent_id=? AND candidate_id=? ORDER BY created_at,id').all(agentId,candidateId);}
  recent(agentId:string){if(!this.store.getAgent(agentId))throw new CharacterNotFoundError('Bot not found.');return this.store.getDatabase().prepare(`SELECT l.id,l.label,l.reason,l.candidate_id candidateId,c.text FROM bot_character_audit_labels l JOIN bot_character_candidates c ON c.id=l.candidate_id WHERE l.agent_id=? AND NOT EXISTS(SELECT 1 FROM bot_character_audit_labels n WHERE n.supersedes_id=l.id) ORDER BY l.created_at DESC,l.id DESC LIMIT 20`).all(agentId);}
}
