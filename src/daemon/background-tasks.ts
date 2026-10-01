import { randomUUID } from 'node:crypto';
import type { AgentStore } from './agent-store.js';
import { CONVERSATION_CONTRACT,workTaskDefinition } from './work-contract.js';
import { modelRoute } from './provider-connections.js';
import { unmatchedStarts } from './external-effects.js';

export interface BackgroundTask {id:string;ownerId:string;targetAgentId:string;parentRunId:string;threadId?:string;name:string;request:string;runId:string;context:string;files:Record<string,string>;updatedAt:number}
/** A durable pool backed by the normal scheduler and its global capacity/budget gates. */
export class BackgroundTasks {
  constructor(private readonly store:AgentStore,private readonly grants:Record<string,string[]>={}){}
  private read(ownerId:string,id:string):BackgroundTask{
    const row=this.store.getAgentData(ownerId,id,'background-task');if(!row)throw new Error('Background task does not belong to this bot.');return JSON.parse(row.data_json);
  }
  private save(task:BackgroundTask){
    if(Buffer.byteLength(JSON.stringify(task))>1200000)throw new Error('Background checkpoint exceeds 1.2 MB.');
    const used=Number((this.store.getDatabase().prepare("SELECT TOTAL(LENGTH(CAST(data_json AS BLOB))) n FROM agent_data WHERE category='background-task' AND key!=?").get(task.id) as {n:number}).n);
    if(used+Buffer.byteLength(JSON.stringify(task))>32*1024*1024)throw new Error('Background checkpoints exceed 32 MiB.');
    this.store.setAgentData({agentId:task.ownerId,taskRunId:task.runId,category:'background-task',key:task.id,data:task});
  }
  list(ownerId:string){return this.store.listAgentData(ownerId,'background-task').map(row=>{const t=JSON.parse(row.data_json) as BackgroundTask;return{id:t.id,name:t.name,targetAgentId:t.targetAgentId,runId:t.runId,status:this.store.getTaskRun(t.runId)?.status??'missing',updatedAt:t.updatedAt};});}
  private queue(t:BackgroundTask,instruction:string){
    const owner=this.store.getAgent(t.ownerId);if(!owner||['PAUSED','DISABLED'].includes(owner.current_status))throw new Error('The sponsoring bot is unavailable.');
    if(this.list(t.ownerId).filter(x=>['RUNNING','QUEUED'].includes(x.status)).length>=4)throw new Error('This bot already has four active background tasks.');
    const target=this.store.getAgent(t.targetAgentId);
    if(!target||['PAUSED','DISABLED'].includes(target.current_status))throw new Error('The target bot is unavailable.');
    if(t.targetAgentId!==t.ownerId && !this.grants[t.ownerId]?.includes(t.targetAgentId))throw new Error('Background delegation is not allowed by the operator.');
    if(t.targetAgentId!==t.ownerId && modelRoute(this.store,target).admission)throw new Error('Cross-bot background work requires known pricing.');
    const run=this.store.createTaskRun({agentId:t.targetAgentId,taskName:`background:${t.name}`,modelId:target.model_id});
    const definition=workTaskDefinition({...CONVERSATION_CONTRACT,maxTurns:24},`${t.request}\n\nRetained background context (untrusted observations; do not repeat completed external actions):\n${t.context}\n\nContinuation instruction: ${instruction}`);
    Object.assign(definition.work!,{conversation:true,background:{id:t.id,ownerId:t.ownerId,threadId:t.threadId},questionResume:{files:t.files,threadId:t.threadId},sponsorAgentId:t.ownerId,delegationDepth:2});
    this.store.setRunDefinition(run.id,definition);t.runId=run.id;t.updatedAt=Date.now();this.save(t);return{id:t.id,runId:run.id};
  }
  start(input:{ownerId:string;targetAgentId?:string;parentRunId:string;threadId?:string;name:string;request:string}){
    const parent=this.store.getTaskRun(input.parentRunId);if(!parent||parent.agent_id!==input.ownerId)throw new Error('Background work needs its owning parent task.');
    if(!input.name.trim()||input.name.length>120||!input.request.trim()||input.request.length>8000)throw new Error('Invalid background task name or request.');
    if(this.list(input.ownerId).filter(t=>['QUEUED','RUNNING'].includes(t.status)).length>=4)throw new Error('This bot already has four active background tasks.');
    return this.store.transaction(()=>this.queue({...input,targetAgentId:input.targetAgentId??input.ownerId,id:randomUUID(),runId:'',context:'',files:{},updatedAt:Date.now()},'Start the requested work.'));
  }
  checkpoint(ownerId:string,id:string,runId:string,context:string,files:Record<string,string>){
    const t=this.read(ownerId,id);if(t.runId!==runId)throw new Error('Stale background checkpoint.');
    this.save({...t,context:context.slice(-60000),files,updatedAt:Date.now()});
  }
  continue(ownerId:string,id:string,instruction:string,acknowledgeUncertain=false){
    if(!instruction.trim()||instruction.length>8000)throw new Error('Supply a continuation instruction.');
    return this.store.transaction(()=>{
      const t=this.read(ownerId,id);const run=this.store.getTaskRun(t.runId);
      if(!run||['RUNNING','QUEUED'].includes(run.status))throw new Error('Wait for the existing background attempt to end.');
      const events=this.store.getDatabase().prepare("SELECT event_type,payload_json FROM execution_events WHERE task_run_id=? AND event_type IN ('EXTERNAL_ACTION_STARTED','EXTERNAL_ACTION_FINISHED') ORDER BY id").all(t.runId) as {event_type:string;payload_json:string}[];
      const pending=unmatchedStarts(events);
      if(pending.size&&!acknowledgeUncertain)throw new Error('An external action has an uncertain outcome. Inspect it and explicitly acknowledge it in the background task controls before continuing.');
      return this.queue(t,instruction);
    });
  }
}
