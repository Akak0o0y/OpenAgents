import { randomUUID } from 'node:crypto';
import type { AgentStore } from './agent-store.js';
import type { CharacterStore } from './character-store.js';
import type { BrowserTools } from './browser-tools.js';
import type { RunCapacity } from './run-capacity.js';
import { CharacterBusyError,CharacterNotFoundError } from './character-schema.js';
export function parseEngagement(value:string|null):{value:number|null;hidden:boolean;parseFailed:boolean} {
  if(value===null||value.trim()==='')return {value:null,hidden:false,parseFailed:false};
  if(value.trim()==='—')return {value:null,hidden:true,parseFailed:false};
  const normal=value.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6f0)).replace(/٬/g,',').replace(/٫/g,'.');
  const match=normal.match(/(?:^|\s)(\d[\d,]*(?:\.\d+)?)\s*(K|M|ألف|مليون)?(?:\s|$)/i);
  if(!match)return {value:null,hidden:false,parseFailed:true};
  const factor=/^(k|ألف)$/i.test(match[2]??'')?1000:/^(m|مليون)$/i.test(match[2]??'')?1000000:1;
  const n=Number(match[1].replace(/,/g,''))*factor;
  return {value:Number.isFinite(n)?Math.round(n):null,hidden:false,parseFailed:!Number.isFinite(n)};
}
export class EngagementReader {
  constructor(private store:AgentStore,private characters:CharacterStore,private browser:BrowserTools,private capacity:RunCapacity){
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_character_engagement (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,platform TEXT NOT NULL,post_id TEXT NOT NULL,
      account_handle TEXT NOT NULL,observed_at INTEGER NOT NULL,age_bucket INTEGER,metrics_json TEXT NOT NULL,
      PRIMARY KEY(agent_id,platform,post_id,observed_at));`);
  }
  private record(agentId:string,posts:Awaited<ReturnType<BrowserTools['readOwnRecentPosts']>>,now:number) {
    this.store.transaction(()=>{
      for(const p of posts){
        const at=p.postedAt?Date.parse(p.postedAt):NaN;
        // Associate by the confirmed platform post ID and observed account, never by similar text.
        const own=this.store.getDatabase().prepare("SELECT id,post_url FROM bot_character_utterances WHERE agent_id=? AND status='confirmed' AND post_url LIKE ?").all(agentId,`%/status/${p.postId}`) as {id:string;post_url:string}[];
        if(!own.some(u=>{try{const url=new URL(u.post_url);return ['x.com','www.x.com'].includes(url.hostname)&&url.pathname.split('/')[1]?.toLowerCase()===p.accountHandle.toLowerCase();}catch{return false;}}))continue;
        this.store.getDatabase().prepare('DELETE FROM bot_character_engagement WHERE agent_id=? AND platform=\'x\' AND post_id=? AND lower(account_handle)<>lower(?)').run(agentId,p.postId,p.accountHandle);
        this.store.getDatabase().prepare('INSERT OR IGNORE INTO bot_character_engagement VALUES (?,\'x\',?,?,?,?,?)').run(agentId,p.postId,p.accountHandle,now,
          Number.isFinite(at)?Math.max(0,Math.floor((now-at)/86400000)):null,JSON.stringify(Object.fromEntries(Object.entries(p.metrics).map(([k,v])=>[k,parseEngagement(v)]))));
      }
      this.store.setAgentData({agentId,key:'engagement',category:'character',data:{lastAttemptAt:now,lastSuccessAt:now,failures:0,pausedReason:null}});
    });
  }
  private failed(agentId:string,now:number) {const row=this.store.getAgentData(agentId,'engagement','character'),old=row?JSON.parse(row.data_json):{};this.store.setAgentData({agentId,key:'engagement',category:'character',data:{...old,lastAttemptAt:now,failures:(old.failures??0)+1,pausedReason:'Own-account read unavailable.'}});}
  async prephase(agentId:string,runId:string,signal:AbortSignal) {
    const version=this.characters.getLatestVersion(agentId);if(!version||version.mode==='off'||!version.settings.growth.readEngagement)return;
    const row=this.store.getAgentData(agentId,'engagement','character'),state=row?JSON.parse(row.data_json):{},now=Date.now(),backoff=[6,12,24][Math.min(2,Math.max(0,(state.failures??0)-1))]*3600000;
    if(now-(state.failures?state.lastAttemptAt:state.lastSuccessAt??0)<backoff)return;
    try{this.record(agentId,await this.browser.readOwnRecentPosts({agentId,runId,signal,limit:40}),now);}catch{this.failed(agentId,now);signal.throwIfAborted();}
  }
  async read(agentId:string,signal:AbortSignal,metrics=false) {
    const agent=this.store.getAgent(agentId);if(!agent)throw new CharacterNotFoundError('Bot not found.');
    const id=`character-read-${randomUUID()}`,release=this.capacity.acquire(id);if(!release)throw new CharacterBusyError('All work slots are busy.');
    const now=Date.now();
    try{
      this.store.createTaskRun({id,agentId,taskName:metrics?'Read own post engagement':'Import own post samples',modelId:agent.model_id});this.store.startTaskRun(id,agent.model_id,{executor:'character-reader'});
      const posts=await this.browser.readOwnRecentPosts({agentId,runId:id,limit:metrics?40:20,signal});
      const sources=metrics?[]:this.characters.importPostSources(agentId,posts);
      if(metrics)this.record(agentId,posts,now);
      this.store.finishTaskRun(id,'COMPLETED',undefined,{readOnly:true,count:posts.length});
      return {runId:id,count:posts.length,sources,metricsRead:metrics};
    }catch(error){
      if(this.store.getTaskRun(id)?.status==='RUNNING')this.store.finishTaskRun(id,signal.aborted?'ABORTED':'FAILED','Own-account read unavailable.');
      if(metrics)this.failed(agentId,now);
      throw error;
    }finally{try{await this.browser.endRun(id);}finally{release();}}
  }
}
