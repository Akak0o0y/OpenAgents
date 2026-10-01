import { createHash,randomUUID } from 'node:crypto';
import type { AgentStore } from './agent-store.js';
import type { CharacterStore } from './character-store.js';
import { CharacterInvalidError } from './character-schema.js';
export type SlotStatus='reserved'|'attempted'|'used'|'released';
export function nextSlotStatus(status:SlotStatus,event:string):SlotStatus {
  if(status==='reserved')return event==='attempted'?'attempted':['expired','replaced','cancelled','rejected'].includes(event)?'released':status;
  if(status==='attempted')return event==='confirmed'?'used':event==='rejected'?'released':status;
  return status;
}
const local=(now:number,zone:string)=>{
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,weekday:p.weekday.toLowerCase(),minutes:Number(p.hour)*60+Number(p.minute)};
};
export class CharacterRhythm {
  constructor(private store:AgentStore,private characters:CharacterStore){
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_character_slots (
      id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      utterance_id TEXT UNIQUE NOT NULL REFERENCES bot_character_utterances(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL,run_id TEXT NOT NULL,publish_id TEXT,local_date TEXT NOT NULL,timezone TEXT NOT NULL,
      status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS character_slots_day ON bot_character_slots(agent_id,local_date,status);
      CREATE TRIGGER IF NOT EXISTS character_slot_projection AFTER UPDATE OF status ON bot_character_utterances BEGIN
        UPDATE bot_character_slots SET status=CASE
          WHEN NEW.status='attempted' AND status='reserved' THEN 'attempted'
          WHEN NEW.status='confirmed' AND status='attempted' THEN 'used'
          WHEN NEW.status='rejected' AND status IN ('reserved','attempted') THEN 'released'
          WHEN NEW.status IN ('expired','refused','held') AND status='reserved' THEN 'released' ELSE status END,
          publish_id=COALESCE(NEW.publish_id,publish_id),updated_at=NEW.updated_at WHERE utterance_id=NEW.id;
      END;
      CREATE TABLE IF NOT EXISTS bot_character_cap_overrides (
        id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,routine_id TEXT NOT NULL,
        run_id TEXT,expires_at INTEGER NOT NULL,used_at INTEGER);`);
  }
  reserve(agentId:string,utteranceId:string,candidateId:string,runId:string,now=Date.now()) {
    return this.store.transaction(()=>{
      const version=this.characters.getLatestVersion(agentId),rhythm=version?.settings.rhythm;
      if(!version||version.mode==='off'||!rhythm)return;
      const day=local(now,version.document.identity.timezone).date,db=this.store.getDatabase();
      if(db.prepare('SELECT id FROM bot_character_slots WHERE utterance_id=?').get(utteranceId))return;
      const count=(db.prepare("SELECT COUNT(*) AS n FROM bot_character_slots WHERE agent_id=? AND local_date=? AND status<>'released'").get(agentId,day) as any).n;
      if(count>=rhythm.maxPostsPerDay){
        const override=db.prepare('SELECT id FROM bot_character_cap_overrides WHERE agent_id=? AND run_id=? AND expires_at>? AND used_at IS NULL LIMIT 1').get(agentId,runId,now) as any;
        if(!override)throw new CharacterInvalidError('Daily posting cap reached; unresolved posts count toward the cap.');
        db.prepare('UPDATE bot_character_cap_overrides SET used_at=? WHERE id=?').run(now,override.id);
      }
      db.prepare('INSERT INTO bot_character_slots VALUES (?,?,?,?,?,NULL,?,?,\'reserved\',?,?)').run(randomUUID(),agentId,utteranceId,candidateId,runId,day,version.document.identity.timezone,now,now);
    });
  }
  eligibility(agentId:string,routineId:string,source:'schedule'|'manual'|'webhook',tick:number,now=Date.now()) {
    const v=this.characters.getLatestVersion(agentId),r=v?.settings.rhythm;
    if(!v||v.mode==='off'||!r||source==='manual')return {eligible:true,reason:null};
    const current=local(now,v.document.identity.timezone),start=Number(r.activeFrom.slice(0,2))*60+Number(r.activeFrom.slice(3)),end=Number(r.activeTo.slice(0,2))*60+Number(r.activeTo.slice(3));
    const inside=start===end||(start<end?current.minutes>=start&&current.minutes<end:current.minutes>=start||current.minutes<end);
    // For an overnight interval, attribute early-morning minutes to its starting local day.
    const day=start>end&&current.minutes<end?local(now-((current.minutes+1)*60000),v.document.identity.timezone):current;
    const quiet=Array.isArray(r.quietDays)?r.quietDays:[];
    if(!inside||quiet.includes(day.weekday as any))return {eligible:false,reason:'Outside the character’s active posting window.'};
    const jitter=Number(BigInt('0x'+createHash('sha256').update(`${r.seed??''}${routineId}${day.date}`).digest('hex'))%BigInt(r.jitterMinutes+1));
    const due=source==='webhook'?tick:tick+jitter*60000;
    return {eligible:now>=due,reason:now<due?'Waiting for posting jitter.':null};
  }
  override(agentId:string,routineId:string,now=Date.now()) {
    if(this.store.getRoutine(routineId)?.agent_id!==agentId)throw new CharacterInvalidError('Routine belongs to another bot.');
    const id=randomUUID();this.store.getDatabase().prepare('INSERT INTO bot_character_cap_overrides VALUES (?,?,?,NULL,?,NULL)').run(id,agentId,routineId,now+3600000);return {id,expiresAt:now+3600000};
  }
  bindManual(agentId:string,routineId:string,runId:string,now=Date.now()) {
    this.store.getDatabase().prepare('UPDATE bot_character_cap_overrides SET run_id=? WHERE id=(SELECT id FROM bot_character_cap_overrides WHERE agent_id=? AND routine_id=? AND run_id IS NULL AND used_at IS NULL AND expires_at>? ORDER BY expires_at LIMIT 1)').run(runId,agentId,routineId,now);
  }
  summary(agentId:string,now=Date.now()) {
    if(!this.store.getAgent(agentId))throw new CharacterInvalidError('Bot not found.');
    const v=this.characters.getLatestVersion(agentId),date=local(now,v?.document.identity.timezone??'UTC').date;
    return {date,cap:v?.settings.rhythm?.maxPostsPerDay??null,slots:this.store.getDatabase().prepare('SELECT status,COUNT(*) AS count FROM bot_character_slots WHERE agent_id=? AND local_date=? GROUP BY status').all(agentId,date)};
  }
}
