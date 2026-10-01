import {useEffect,useState} from 'react';
import {getJson,postJson} from '../lib/transport.js';
export function CharacterGrowth({agentId,dirty}:{agentId:string;dirty:boolean}) {
  const [state,setState]=useState<{posts:number;edits:number;eligible:boolean;failures:number;nextEligibleAt:number;lease:unknown}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{const c=new AbortController();getJson<typeof state>(`/api/system/character-growth?agent=${encodeURIComponent(agentId)}`,c.signal).then(setState).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[agentId,dirty,busy]);
  async function review(){setBusy(true);setError('');try{const r=await postJson<{started:boolean;proposalId?:string;failed?:boolean}>('/api/system/character-growth',{agentId});setNotice(r.failed?'Review did not complete; retry is delayed.':r.proposalId?'A proposal is ready in your chat.':r.started?'Review complete; no changes proposed.':'No eligible review yet.');}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  return <section><p>Growth creates proposals for you to approve. It requires ten new confirmed posts or three saved owner edits.</p>
    {state&&<p>{state.posts} new posts · {state.edits} owner edits{state.lease?' · Review running':''}{state.failures>0?` · Retry after ${new Date(state.nextEligibleAt).toLocaleString()}`:''}</p>}
    <button disabled={busy||dirty||!state?.eligible} onClick={()=>void review()}>Review now</button>
    {dirty&&<p>Save your settings before requesting a review.</p>}{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
  </section>;
}
