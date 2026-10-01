import type {AgentStore} from './agent-store.js';
import {GoalResults} from './goal-results.js';

/** Only recognized preflight failures count. Model/tool failures and network outages do not. */
function code(reason:string){
  if(/No task definition registered|Routine task .* is not registered/.test(reason))return 'task-unavailable';
  if(/requires an unavailable approval gate|requires approval.*does not implement approval/.test(reason))return 'approval-unavailable';
  if(/Shared work runtime is unavailable/.test(reason))return 'runtime-unavailable';
  if(/Image input is not enabled for this model/.test(reason))return 'vision-unavailable';
  if(/Browser tools are disabled|Browser tools are not configured/.test(reason))return 'browser-unavailable';
  return null;
}
export class RoutineAttention {
  constructor(private store:AgentStore){}
  status(agentId:string,routineId:string){
    const routine=this.store.getRoutine(routineId);if(routine?.agent_id!==agentId)throw new Error('Routine not found for this bot.');
    const unresolved=new GoalResults(this.store).unresolved(agentId).filter(a=>this.store.getTaskRun(a.run_id)?.routine_id===routineId);
    if(unresolved.length)return {held:true,code:'effect-unresolved',reason:'An external effect needs read-only reconciliation before this routine can run again.',runIds:unresolved.map(a=>a.run_id)};
    const row=this.store.getAgentData(agentId,routineId,'routine-attention');
    const after=row?(JSON.parse(row.data_json) as {resumedAt:number}).resumedAt:0;
    const runs=this.store.getDatabase().prepare('SELECT id,status,error_message,completed_at,turns_taken FROM task_runs WHERE routine_id=? AND completed_at>? ORDER BY completed_at DESC,rowid DESC LIMIT 3').all(routineId,after) as unknown as {id:string;status:string;error_message:string|null;completed_at:number;turns_taken:number}[];
    const first=runs[0],failure=first?code(first.error_message??''):null;
    const held=runs.length===3&&!!failure&&runs.every(r=>r.status==='FAILED'&&r.turns_taken===0&&code(r.error_message??'')===failure);
    return {held,code:held?failure:null,reason:held?'Three runs stopped at the same prerequisite. Fix the prerequisite, then resume this routine.':null,runIds:held?runs.map(r=>r.id):[]};
  }
  resume(agentId:string,routineId:string){this.status(agentId,routineId);this.store.setAgentData({agentId,category:'routine-attention',key:routineId,data:{resumedAt:Date.now(),actor:'owner'}});}
}
