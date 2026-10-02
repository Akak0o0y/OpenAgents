import {useEffect,useState} from 'react';
import {getJson} from '../lib/transport.js';
export function GoalResultChecklist({agentId,runId}:{agentId:string;runId:string}){
  const [data,setData]=useState<{satisfaction:string;legacy:boolean;results:Array<{id:string;description:string;state:string;evidence?:{receipt:string;verifier:string;reference:string;observedAt:number;account:string|null}|null}>}|null>(null);
  useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const read=async()=>{try{const next=await getJson<NonNullable<typeof data>>(`/api/system/goal-results?agent=${encodeURIComponent(agentId)}&run=${encodeURIComponent(runId)}`,controller.signal);if(!controller.signal.aborted)setData(next);}catch{if(!controller.signal.aborted)setData(null);}finally{if(!controller.signal.aborted)timer=setTimeout(read,5000);}};
    void read();return()=>{controller.abort();clearTimeout(timer);};
  },[agentId,runId]);
  if(!data)return <p>Result verification unavailable.</p>;
  if(data.legacy)return <p>No result checklist recorded — completion is not independently verified.</p>;
  if(data.satisfaction==='not-required')return <p>No required external result was declared for this run.</p>;
  return <section aria-label="Result checklist"><strong>{data.satisfaction==='verified'?'Required results verified':'Results still need evidence'}</strong><ul>{data.results.map(r=><li key={r.id}>{r.description} · {r.state}{r.evidence&&<details><summary>Evidence · {r.evidence.receipt}</summary><p>{r.evidence.verifier} · {new Date(r.evidence.observedAt).toLocaleString()}</p><p>Reference: {r.evidence.reference}</p>{r.evidence.receipt!=='created'&&<p>{r.evidence.account?`Account: ${r.evidence.account}`:'Account identity unavailable'}</p>}</details>}</li>)}</ul></section>;
}
