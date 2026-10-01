import {useEffect,useState} from 'react';
import {getJson,postJson} from '../lib/transport.js';
import {RunActivityCard} from './RunActivityCard.js';
import type {Teammate} from './workspaceTypes.js';

/** Discovery survives reload and does not depend on this tab's pending send promise. */
export function ActiveBotRuns({agent,threadId,exclude,onOpenFile}:{agent:Teammate;threadId:string|null;exclude:string|null;onOpenFile?:React.ComponentProps<typeof RunActivityCard>['onOpenFile']}){
  const [runs,setRuns]=useState<Array<{id:string;origin:string;status:string}>>([]),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    setRuns([]);setError('');
    const poll=async()=>{try{const value=await getJson<{runs:typeof runs}>(`/api/system/active-runs?agent=${encodeURIComponent(agent.id)}${threadId?`&thread=${encodeURIComponent(threadId)}`:''}`,controller.signal);if(!controller.signal.aborted){setRuns(value.runs);setError('');}}catch{if(!controller.signal.aborted)setError('Live work connection interrupted. Reconnecting…');}finally{if(!controller.signal.aborted)timer=setTimeout(poll,3000);}};
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[agent.id,threadId]);
  const stop=async(runId:string)=>{try{const reply=await postJson<{stopped:boolean}>('/api/system/run-cancel',{agentId:agent.id,runId});if(!reply.stopped)setError('This run has already stopped or cannot be cancelled here.');}catch{setError('Cancellation could not be confirmed.');}};
  return <section aria-label="Active bot work">{error&&<p role="status">{error}</p>}{runs.filter(r=>r.id!==exclude).map(r=><div key={r.id}><p>{r.origin==='chat'?'This conversation':r.origin==='routine'?'Scheduled bot activity':'Background bot activity'} · {r.status==='QUEUED'?'Waiting for resources':'Running'}</p><button type="button" onClick={()=>void stop(r.id)}>Stop run</button><RunActivityCard runId={r.id} agent={agent} onOpenFile={onOpenFile}/></div>)}</section>;
}
