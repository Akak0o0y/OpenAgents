import {createHash,randomUUID} from 'node:crypto';
import type {AgentStore} from './agent-store.js';
import type {FlowV1} from './flow-types.js';
export type PlaybackMode='auto'|'on'|'off';
export type FlowOutcome='completed'|'miss'|'refused'|'uncertain'|'account-unreadable'|'account-mismatch'|'none'|'neutral';
export interface FlowRecord {id:string;agentId:string;routineId:string|null;flowKey:string;origin:string;probe:string;op:string|null;account:string|null;
  state:'learning'|'active'|'stale';attention:'account'|null;attentionDetail:string|null;version:number;flow:FlowV1|null;confirmedBy:'response'|'page'|null;
  sourceRunId:string|null;plays:number;completions:number;consecutiveMisses:number;consecutiveRefusals:number;consecutiveAccountFailures:number;
  lastOutcome:string|null;lastReason:string|null;lastRunId:string|null;createdAt:number;updatedAt:number}
export const flowKeyFor=(routineId:string,contractId:string,operatorRequest:string)=>`routine:${routineId}:`+createHash('sha256').update(contractId+'\n'+operatorRequest).digest('hex').slice(0,16);
export class FlowStore {
  private proofSearched=new Set<string>();
  constructor(private store:AgentStore){store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS browser_flows (
    id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    flow_key TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(agent_id,flow_key));
    CREATE TABLE IF NOT EXISTS browser_flow_runs(flow_id TEXT NOT NULL REFERENCES browser_flows(id) ON DELETE CASCADE,run_id TEXT NOT NULL,played INTEGER NOT NULL DEFAULT 0,noted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(flow_id,run_id));`);}
  get(agentId:string,key:string):FlowRecord|null {const r=this.store.getDatabase().prepare('SELECT record_json FROM browser_flows WHERE agent_id=? AND flow_key=?').get(agentId,key) as {record_json:string}|undefined;return r?JSON.parse(r.record_json):null;}
  list(agentId:string):FlowRecord[]{return (this.store.getDatabase().prepare('SELECT record_json FROM browser_flows WHERE agent_id=?').all(agentId) as {record_json:string}[]).map(r=>JSON.parse(r.record_json));}
  forRoutine(agentId:string,routineId:string){return this.list(agentId).filter(f=>f.routineId===routineId);}
  private byId(id:string){const r=this.store.getDatabase().prepare('SELECT record_json FROM browser_flows WHERE id=?').get(id) as {record_json:string}|undefined;if(!r)throw new Error('Flow not found.');return JSON.parse(r.record_json) as FlowRecord;}
  private write(r:FlowRecord){r.updatedAt=Date.now();this.store.getDatabase().prepare('INSERT INTO browser_flows VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(r.id,r.agentId,r.routineId,r.flowKey,JSON.stringify(r));return r;}
  private event(r:FlowRecord,runId:string,type:string,payload:unknown){this.store.recordEvent({agent_id:r.agentId,task_run_id:runId,event_type:type,payload_json:JSON.stringify(payload),timestamp:Date.now()});}
  private owned(agentId:string,routineId:string,runId?:string){if(this.store.getRoutine(routineId)?.agent_id!==agentId||(runId&&this.store.getTaskRun(runId)?.agent_id!==agentId))throw new Error('Flow owner mismatch.');}
  private initial(i:{agentId:string;routineId:string;flowKey:string;origin:string;probe:string}):FlowRecord{return {id:randomUUID(),...i,op:null,account:null,state:'learning',attention:null,attentionDetail:null,version:0,flow:null,confirmedBy:null,sourceRunId:null,plays:0,completions:0,consecutiveMisses:0,consecutiveRefusals:0,consecutiveAccountFailures:0,lastOutcome:null,lastReason:null,lastRunId:null,createdAt:Date.now(),updatedAt:Date.now()};}
  save(i:{agentId:string;routineId:string;flowKey:string;runId:string;flow:FlowV1;confirmedBy:'response'|'page'}) {
    this.owned(i.agentId,i.routineId,i.runId);
    return this.store.transaction(()=>{const r=this.get(i.agentId,i.flowKey)??this.initial({...i,origin:i.flow.origin,probe:i.flow.probe});
      this.store.getDatabase().prepare('DELETE FROM browser_flows WHERE agent_id=? AND routine_id=? AND flow_key<>?').run(i.agentId,i.routineId,i.flowKey);
      Object.assign(r,{flow:i.flow,origin:i.flow.origin,probe:i.flow.probe,op:i.flow.op,account:i.flow.account,version:r.version+1,state:'active',sourceRunId:i.runId,confirmedBy:i.confirmedBy,attention:null,attentionDetail:null,consecutiveMisses:0,consecutiveRefusals:0,consecutiveAccountFailures:0});
      this.write(r);this.event(r,i.runId,'FLOW_RECORDED',{flowId:r.id,version:r.version,flow:r.flow});return r;});
  }
  noteRejected(i:{agentId:string;routineId:string;flowKey:string;origin:string;probe:string;runId:string;reason:string}) {
    this.owned(i.agentId,i.routineId,i.runId);this.store.transaction(()=>{const r=this.get(i.agentId,i.flowKey)??this.initial(i);
      this.store.getDatabase().prepare('DELETE FROM browser_flows WHERE agent_id=? AND routine_id=? AND flow_key<>?').run(i.agentId,i.routineId,i.flowKey);
      r.lastReason=i.reason;this.write(r);this.event(r,i.runId,'FLOW_REJECTED',{reason:i.reason,flowId:r.id});});
  }
  notePlay(id:string,runId:string){this.store.transaction(()=>{const r=this.byId(id);this.owned(r.agentId,r.routineId!,runId);const db=this.store.getDatabase();db.prepare('INSERT OR IGNORE INTO browser_flow_runs(flow_id,run_id) VALUES (?,?)').run(id,runId);
    if(db.prepare('UPDATE browser_flow_runs SET played=1 WHERE flow_id=? AND run_id=? AND played=0').run(id,runId).changes){r.plays++;this.write(r);this.event(r,runId,'FLOW_PLAYBACK_STARTED',{flowId:id,version:r.version});}});}
  note(id:string,runId:string,o:{outcome:FlowOutcome;reason?:string;signedIn?:string}) {
    return this.store.transaction(()=>{const r=this.byId(id);this.owned(r.agentId,r.routineId!,runId);const db=this.store.getDatabase();db.prepare('INSERT OR IGNORE INTO browser_flow_runs(flow_id,run_id) VALUES (?,?)').run(id,runId);
      if(!db.prepare('UPDATE browser_flow_runs SET noted=1 WHERE flow_id=? AND run_id=? AND noted=0').run(id,runId).changes)return r;
      if(['completed','miss','refused','uncertain','account-unreadable'].includes(o.outcome)) {
        r.consecutiveMisses=o.outcome==='miss'?r.consecutiveMisses+1:0;r.consecutiveRefusals=['refused','uncertain'].includes(o.outcome)?r.consecutiveRefusals+1:0;r.consecutiveAccountFailures=o.outcome==='account-unreadable'?r.consecutiveAccountFailures+1:0;
        if(o.outcome==='completed')r.completions++;
        if(r.consecutiveMisses>=3||r.consecutiveRefusals>=2||r.consecutiveAccountFailures>=3)r.state='stale';
      }
      if(o.outcome==='account-mismatch'){r.attention='account';r.attentionDetail=o.signedIn??null;this.event(r,runId,'FLOW_ATTENTION',{flowId:id,state:'set'});}
      r.lastOutcome=o.outcome;r.lastReason=o.reason??null;r.lastRunId=runId;return this.write(r);
    });
  }
  heldForAttention(agentId:string,routineId:string,key:string){const r=this.get(agentId,key);return r?.routineId===routineId&&r.state==='active'&&r.attention&&this.playbackEnabled(agentId)?r:null;}
  clearAttention(agentId:string,routineId:string,runId:string){this.owned(agentId,routineId,runId);return this.store.transaction(()=>{let n=0;for(const r of this.forRoutine(agentId,routineId))if(r.attention){r.attention=null;r.attentionDetail=null;this.write(r);this.event(r,runId,'FLOW_ATTENTION',{flowId:r.id,state:'cleared',by:'operator'});n++;}return n;});}
  forget(agentId:string,id:string){const r=this.byId(id);if(r.agentId!==agentId)throw new Error('Flow owner mismatch.');r.flow=null;r.state='learning';r.attention=null;r.attentionDetail=null;r.lastReason='Forgotten by the owner';this.write(r);}
  playbackMode(agentId:string):PlaybackMode{const r=this.store.getAgentData(agentId,'playback','browser-flow');return r?JSON.parse(r.data_json).mode:'auto';}
  setPlaybackMode(agentId:string,mode:PlaybackMode){if(!['auto','on','off'].includes(mode)||!this.store.getAgent(agentId))throw new Error('Invalid playback setting.');this.store.setAgentData({agentId,category:'browser-flow',key:'playback',data:{mode}});return mode;}
  noteResponseProof(agentId:string,runId:string){if(this.store.getTaskRun(runId)?.agent_id!==agentId)throw new Error('Flow proof owner mismatch.');if(!this.responseProof(agentId))this.store.setAgentData({agentId,category:'browser-flow',key:'response-proof',data:{runId,at:Date.now()}});}
  responseProof(agentId:string):{runId:string;at:number}|null {
    const r=this.store.getAgentData(agentId,'response-proof','browser-flow');if(r)return JSON.parse(r.data_json);
    if(this.proofSearched.has(agentId))return null;this.proofSearched.add(agentId);
    const events=this.store.getDatabase().prepare("SELECT task_run_id,payload_json,timestamp FROM execution_events WHERE agent_id=? AND event_type='PUBLISH_OBSERVED' ORDER BY timestamp DESC LIMIT 1000").all(agentId) as {task_run_id:string;payload_json:string;timestamp:number}[];
    for(const event of events){try{const p=JSON.parse(event.payload_json);if(p.outcome!=='confirmed'||!p.postId)continue;const proof={runId:event.task_run_id,at:event.timestamp};this.store.setAgentData({agentId,category:'browser-flow',key:'response-proof',data:proof});return proof;}catch{continue;}}
    return null;
  }
  playbackEnabled(agentId:string){const mode=this.playbackMode(agentId);return mode==='on'||mode==='auto'&&!!this.responseProof(agentId);}
}
