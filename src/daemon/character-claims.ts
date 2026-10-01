import { randomUUID } from 'node:crypto';
import type { AgentStore } from './agent-store.js';
import type { CharacterStore } from './character-store.js';
import type { CharacterJournal } from './character-journal.js';
import { CharacterInvalidError, CharacterNotFoundError } from './character-schema.js';
import { ReviewOutputSchema } from './character-speaker.js';
import { characterCasefold } from './character-casefold.js';
export const normalizeClaimKey=(text:string)=>characterCasefold(text).replace(/\s+/gu,' ').trim();
export class CharacterClaims {
  constructor(private store:AgentStore,private characters:CharacterStore,private journal:CharacterJournal) {
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_character_claims (
      id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,kind TEXT NOT NULL,
      subject TEXT NOT NULL,predicate TEXT NOT NULL,value TEXT NOT NULL,normalized_key TEXT NOT NULL,
      source_utterance_id TEXT NOT NULL,status TEXT NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,count INTEGER NOT NULL,
      UNIQUE(agent_id,normalized_key));
      CREATE TABLE IF NOT EXISTS bot_character_claim_occurrences (
        claim_id TEXT NOT NULL REFERENCES bot_character_claims(id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES bot_character_candidates(id) ON DELETE CASCADE,span_json TEXT,created_at INTEGER NOT NULL,
        PRIMARY KEY(claim_id,candidate_id));
      CREATE TABLE IF NOT EXISTS bot_character_claim_projections (
        candidate_id TEXT NOT NULL REFERENCES bot_character_candidates(id) ON DELETE CASCADE,extraction_index INTEGER NOT NULL,
        PRIMARY KEY(candidate_id,extraction_index));
      CREATE INDEX IF NOT EXISTS character_claims_recall ON bot_character_claims(agent_id,status,last_at);`);
  }
  project(agentId:string,utteranceId:string) {
    const u=this.journal.get(agentId,utteranceId);
    if(!u||u.status!=='confirmed'||u.semantic!=='passed'||!u.finalCandidateId)return;
    const candidate=this.journal.candidates(u.id).find(c=>c.id===u.finalCandidateId)!;
    const review=this.journal.reviews(u.id).filter(r=>r.candidateId===candidate.id&&r.verdict==='pass').at(-1);
    if(!review?.extracted)return;
    const parsed=ReviewOutputSchema.safeParse({verdict:'pass',scores:review.scores,findings:review.findings,extracted:review.extracted});
    if(!parsed.success)return;
    const e=parsed.data.extracted, items=[...e.claims,...e.stances.map(s=>({kind:'stance',subject:s.topic,predicate:'position',value:s.position,span:s.span})),
      ...e.relations.map(r=>({kind:'relation',subject:r.handle,predicate:'relation',value:r.note,span:r.span}))];
    this.store.transaction(()=>{
      const db=this.store.getDatabase();
      items.forEach((item,index)=>{
        if(db.prepare('SELECT 1 FROM bot_character_claim_projections WHERE candidate_id=? AND extraction_index=?').get(candidate.id,index))return;
        db.prepare('INSERT INTO bot_character_claim_projections VALUES (?,?)').run(candidate.id,index);
        const span=item.span;
        if(span&&(!span.every(Number.isSafeInteger)||span[0]<0||span[1]<=span[0]||span[1]>Array.from(candidate.text).length))return;
        if(!span)return; // An ungrounded extraction cannot become a remembered assertion.
        if(Array.from(item.subject+item.predicate+item.value).length>600)return;
        const key=JSON.stringify([item.kind,item.subject,item.predicate,item.value].map(normalizeClaimKey));
        let row=db.prepare('SELECT id FROM bot_character_claims WHERE agent_id=? AND normalized_key=?').get(agentId,key) as any;
        if(!row){row={id:randomUUID()};db.prepare('INSERT INTO bot_character_claims VALUES (?,?,?,?,?,?,?, ?,\'provisional\',?,?,0)').run(row.id,agentId,item.kind,item.subject,item.predicate,item.value,key,u.id,candidate.createdAt,candidate.createdAt);}
        db.prepare('INSERT OR IGNORE INTO bot_character_claim_occurrences VALUES (?,?,?,?)').run(row.id,candidate.id,JSON.stringify(span),candidate.createdAt);
        db.prepare('UPDATE bot_character_claims SET count=(SELECT COUNT(*) FROM bot_character_claim_occurrences WHERE claim_id=?),last_at=MAX(last_at,?) WHERE id=?').run(row.id,candidate.createdAt,row.id);
        const others=(db.prepare("SELECT id,value,subject,predicate FROM bot_character_claims WHERE agent_id=? AND kind=? AND id<>? AND status NOT IN ('dismissed','superseded')").all(agentId,item.kind,row.id) as any[])
          .filter(o=>normalizeClaimKey(o.subject)===normalizeClaimKey(item.subject)&&normalizeClaimKey(o.predicate)===normalizeClaimKey(item.predicate));
        const acknowledged=item.kind==='stance' && parsed.data.findings.some(f=>f.code==='STANCE_CHANGE_ACKNOWLEDGED' && f.span && f.span[0]<=span[0] && f.span[1]>=span[1]);
        if(acknowledged){
          for(const other of others)db.prepare("UPDATE bot_character_claims SET status='superseded' WHERE id=? AND status<>'adopted'").run(other.id);
          return;
        }
        if(others.some(o=>normalizeClaimKey(o.value)!==normalizeClaimKey(item.value))){
          db.prepare("UPDATE bot_character_claims SET status='disputed' WHERE id=? AND status<>'adopted'").run(row.id);
          for(const other of others)db.prepare("UPDATE bot_character_claims SET status='disputed' WHERE id=? AND status NOT IN ('adopted','dismissed','superseded')").run(other.id);
        }
      });
      db.prepare('INSERT OR IGNORE INTO bot_character_claim_projections VALUES (?, -1)').run(candidate.id);
    });
  }
  list(agentId:string,query='',limit=50) {
    if(!this.store.getAgent(agentId))throw new CharacterNotFoundError('Bot not found.');
    const words=query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>2).slice(0,8);
    const where=words.length?' AND ('+words.map(()=>"lower(subject||' '||predicate||' '||value) LIKE ? ESCAPE '\\'").join(' OR ')+')':'';
    const params=words.map(w=>'%'+w.replace(/[\\%_]/g,'\\$&')+'%');
    return this.store.getDatabase().prepare(`SELECT * FROM bot_character_claims WHERE agent_id=? AND status NOT IN ('dismissed','superseded')${where} ORDER BY last_at DESC,id LIMIT ?`).all(agentId,...params,Math.min(50,Math.max(1,limit))) as any[];
  }
  page(agentId:string,query='',cursor?:string) {
    if(!this.store.getAgent(agentId))throw new CharacterNotFoundError('Bot not found.');
    const db=this.store.getDatabase();let at=Number.MAX_SAFE_INTEGER,id='';
    if(cursor){const row=this.owned(agentId,cursor);at=row.last_at;id=row.id;}
    const words=normalizeClaimKey(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0,8);
    const rows=db.prepare(`SELECT * FROM bot_character_claims WHERE agent_id=? AND status NOT IN ('dismissed','superseded') AND (last_at<? OR(last_at=? AND id>?)) ORDER BY last_at DESC,id LIMIT 500`).all(agentId,at,at,id) as any[];
    const matched=rows.filter(c=>!words.length||words.some(w=>normalizeClaimKey(`${c.subject} ${c.predicate} ${c.value}`).includes(w))),items=matched.slice(0,50);
    return {items,nextCursor:matched.length>50?items.at(-1)!.id:rows.length===500?rows.at(-1)!.id:null};
  }
  occurrences(agentId:string,id:string){this.owned(agentId,id);return this.store.getDatabase().prepare(`SELECT o.span_json,o.created_at,c.text,c.utterance_id FROM bot_character_claim_occurrences o JOIN bot_character_candidates c ON c.id=o.candidate_id WHERE o.claim_id=? AND c.agent_id=? ORDER BY o.created_at DESC LIMIT 20`).all(id,agentId);}
  repair(limit=100){const rows=this.store.getDatabase().prepare(`SELECT u.agent_id,u.id FROM bot_character_utterances u WHERE u.status='confirmed' AND u.semantic='passed' AND NOT EXISTS(SELECT 1 FROM bot_character_claim_projections p WHERE p.candidate_id=u.final_candidate_id) ORDER BY u.created_at DESC LIMIT ?`).all(limit) as {agent_id:string;id:string}[];for(const r of rows)this.project(r.agent_id,r.id);}
  dismiss(agentId:string,id:string){this.owned(agentId,id);this.store.getDatabase().prepare("UPDATE bot_character_claims SET status='dismissed' WHERE id=? AND agent_id=?").run(id,agentId);return {id,status:'dismissed'};}
  private owned(agentId:string,id:string){const r=this.store.getDatabase().prepare('SELECT * FROM bot_character_claims WHERE id=? AND agent_id=?').get(id,agentId) as any;if(!r)throw new CharacterNotFoundError('Claim not found.');return r;}
  adopt(agentId:string,id:string,baseVersion:number,provenance:'owner-attested'|'fictional'|'verified') {
    return this.store.transaction(()=>{
      const c=this.owned(agentId,id),v=this.characters.getLatestVersion(agentId);
      if(!v)throw new CharacterInvalidError('Save a character first.');
      if(c.status==='adopted')return {id,version:v.version,status:'adopted'};
      if(c.status==='disputed'||v.document.commitments.some(k=>k.importance==='core' && normalizeClaimKey(k.topic)===normalizeClaimKey(c.subject)))
        throw new CharacterInvalidError('Resolve this conflict in the studio before adopting it.');
      const text=`${c.subject} ${c.predicate} ${c.value}`;
      if(Array.from(text).length>500)throw new CharacterInvalidError('Shorten this fact in the studio before adopting it.');
      const saved=this.characters.save(agentId,baseVersion,{document:{backgroundFacts:[...v.document.backgroundFacts,{id:`claim-${id}`,text,keys:[c.subject.slice(0,40)],provenance,always:false}]},origin:'studio'});
      this.store.getDatabase().prepare("UPDATE bot_character_claims SET status='adopted' WHERE id=?").run(id);
      return {id,version:saved.version,status:'adopted'};
    });
  }
}
