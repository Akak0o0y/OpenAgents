import {useEffect,useState} from 'react';
import {getJson,postJson} from '../lib/transport.js';
export function RoutineAttention({agentId,routineId}:{agentId:string;routineId:string}){
  const [attention,setAttention]=useState<{held:boolean;code:string|null;reason:string|null}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const read=async()=>{try{const next=await getJson<NonNullable<typeof attention>>(`/api/system/routine-attention?agent=${encodeURIComponent(agentId)}&routine=${encodeURIComponent(routineId)}`,c.signal);if(!c.signal.aborted)setAttention(next);}catch{if(!c.signal.aborted)setError('Routine attention status is unavailable.');}finally{if(!c.signal.aborted)timer=setTimeout(read,5000);}};
    void read();return()=>{c.abort();clearTimeout(timer);};
  },[agentId,routineId]);
  async function resume(){setBusy(true);try{await postJson('/api/system/routine-attention',{agentId,routineId,action:'resume'});setAttention(null);setError('');}catch{setError('Resume could not be confirmed.');}finally{setBusy(false);}}
  return <>{attention?.held&&<section role="status"><strong>Routine needs attention · {attention.code}</strong><p>{attention.reason}</p>{attention.code!=='effect-unresolved'&&<button type="button" disabled={busy} onClick={()=>void resume()}>Prerequisite fixed — resume routine</button>}</section>}{error&&<p role="alert">{error}</p>}</>;
}
