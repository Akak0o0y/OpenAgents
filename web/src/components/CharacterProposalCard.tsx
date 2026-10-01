import { useEffect, useState } from 'react';
import { getJson, postJson } from '../lib/transport.js';
import type { CharacterProposal } from '@kernel/daemon/character-proposals.js';
import { Button } from './ui/Button.js';
import { CharacterStudio } from './CharacterStudio.js';

export function CharacterProposalCard({agentId,proposalId}:{agentId:string;proposalId:string}) {
  const [p,setP]=useState<CharacterProposal|null>(null),[items,setItems]=useState<any[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [editing,setEditing]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{const c=new AbortController();getJson<{proposal:CharacterProposal;items:any[]}>(`/api/system/character-proposal?agent=${encodeURIComponent(agentId)}&id=${encodeURIComponent(proposalId)}`,c.signal)
    .then(v=>{setP(v.proposal);setItems(v.items);}).catch(e=>{if(!c.signal.aborted)setError(String(e.message??e));});return()=>c.abort();},[agentId,proposalId,revision]);
  useEffect(()=>{if(p?.status!=='applying')return;const timer=setTimeout(()=>setRevision(r=>r+1),1500);return()=>clearTimeout(timer);},[p,revision]);
  async function act(kind:'edit'|'decide',extra:object){
    if(!p||busy)return;setBusy(true);setError('');
    try{const updated=await postJson<CharacterProposal>(`/api/system/character-${kind==='edit'?'proposal-edit':'decide'}`,{agentId,proposalId:p.proposalId,revision:p.revision,changeHash:p.changeHash,...extra});setP(updated);setEditing(false);setRevision(r=>r+1);}
    catch(e){setError(e instanceof Error?e.message:String(e));setRevision(r=>r+1);}finally{setBusy(false);}
  }
  if(!p)return <section aria-label="Character proposal">{error||'Loading character draft…'}</section>;
  const current=p.status==='open';
  return <section className="grok-question-card" aria-label="Character proposal">
    <h3>{p.status==='applying'?'Character saved; applying selected items…':p.status==='applied'?'Character saved':'Review character draft'}</h3>
    <p>{p.draft.document?.identity?.oneLine}</p><p>Revision {p.revision} · Based on character version {p.baseVersion}</p>
    {p.assumptions.map((a,i)=><p key={i}>{a}</p>)}
    {current&&p.previewsRevision!==p.revision&&<p role="status">Previews are stale for this revision.</p>}
    {Array.isArray(p.previews)&&p.previews.map((v:any)=><details key={v.id}><summary>{v.id} · unsent · {v.status}</summary><p>{v.text??'No valid preview.'}</p><pre>{JSON.stringify(v.review,null,2)}</pre></details>)}
    <details><summary>Full proposed character and settings</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(p.draft,null,2)}</pre></details>
    {p.description!==undefined&&<details><summary>Proposed Description</summary><p style={{whiteSpace:'pre-wrap'}}>{p.description}</p><label><input type="checkbox" checked={p.descriptionSelected??false} disabled={!current||busy} onChange={e=>void act('edit',{changes:{descriptionSelected:e.target.checked}})}/>Apply this Description change too</label></details>}
    {p.bundles.map(b=><label key={b.key} style={{display:'block'}}><input type="checkbox" checked={b.selected} disabled={!current||busy} onChange={()=>act('edit',{changes:{bundles:p.bundles.map(v=>v.key===b.key?{...v,selected:!v.selected}:v)}})}/>{b.key} ({b.kind})</label>)}
    {items.map(i=><p key={i.key}>{i.key}: {i.status}{i.error?` — ${i.error}`:''}</p>)}
    {editing&&<CharacterStudio agentId={agentId} agentName={p.draft.document?.identity?.name??'Bot'} proposal={p} onProposalSaved={setP} onClose={()=>setEditing(false)} onSaved={()=>{}}/>}
    {current&&<Button disabled={busy||editing} onClick={()=>setEditing(true)}>Edit in studio</Button>}
    {current&&<><Button disabled={busy||editing} onClick={()=>act('decide',{decision:'approve',selections:p.bundles.filter(b=>b.selected).map(b=>b.key)})}>Approve this revision</Button><Button disabled={busy} onClick={()=>act('decide',{decision:'deny',selections:[]})}>Decline</Button></>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
