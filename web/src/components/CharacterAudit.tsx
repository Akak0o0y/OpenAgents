import {useEffect,useState} from 'react';
import {getJson,postJson} from '../lib/transport.js';
interface AuditItem {queueId:string;candidateId:string;text:string;exactDigest:string;evidence:string;rules:string;status:string;semantic:string|null;probability:number}
interface Qualification {key_hash:string;state:string;labels_count:number;reason:string|null;key_json:string}
interface PriorLabel {id:string;candidateId:string;text:string;label:string;reason:string}
interface BackendStatus {mode:'off'|'shadow'|'local';available:boolean;qualified:boolean;reason:string|null;shadow:Array<{record_json:string}>}
export function CharacterAudit({agentId}:{agentId:string}) {
  const [items,setItems]=useState<AuditItem[]>([]),[qualification,setQualification]=useState<Qualification[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reason,setReason]=useState(''),[reload,setReload]=useState(0);
  const [recent,setRecent]=useState<PriorLabel[]>([]),[correction,setCorrection]=useState<PriorLabel|null>(null),[backend,setBackend]=useState<BackendStatus|null>(null);
  useEffect(()=>{const c=new AbortController();setItems([]);setReason('');setCorrection(null);setBackend(null);setError('');getJson<{items:AuditItem[];qualification:Qualification[];recent:PriorLabel[]}>(`/api/system/character-audit-queue?agent=${encodeURIComponent(agentId)}&limit=10`,c.signal)
    .then(r=>{setItems(r.items);setQualification(r.qualification);setRecent(r.recent??[]);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});
    getJson<BackendStatus>(`/api/system/character-review-backend?agent=${encodeURIComponent(agentId)}`,c.signal).then(setBackend).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[agentId,reload]);
  async function label(item:{candidateId:string},value:string,supersedesId?:string){setBusy(true);setError('');try{await postJson('/api/system/character-audit-label',{agentId,candidateId:item.candidateId,label:value,reason,...(supersedesId?{supersedesId}:{}),idempotencyKey:crypto.randomUUID()});setReason('');setCorrection(null);setReload(r=>r+1);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function mode(value:BackendStatus['mode']){setBusy(true);setError('');try{setBackend(await postJson<BackendStatus>('/api/system/character-review-backend',{agentId,mode:value}));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  const first=items[0];
  return <section><h3>Independent audit</h3><p>Your labels are separate from the model’s review. Adaptive review needs 300 distinct clean accepts under the same known evaluator identity. Defects revoke qualification.</p>
    <p>Local review is unavailable until an approved backend has measured accuracy, calibration, speed, memory and licence evidence.</p>
    {backend&&<><label>Reviewer backend<select disabled={busy} value={backend.mode} onChange={e=>void mode(e.target.value as BackendStatus['mode'])}><option value="off">Hosted review</option><option value="shadow" disabled={!backend.available}>Local shadow comparison</option><option value="local" disabled={!backend.qualified}>Qualified local review</option></select></label>{backend.reason&&<p>{backend.reason}</p>}<details><summary>Shadow measurements (no release authority)</summary>{backend.shadow.map((r,i)=><pre key={i} style={{whiteSpace:'pre-wrap'}}>{r.record_json}</pre>)}</details></>}
    {qualification.map(q=><p key={q.key_hash}>{q.state==='adaptive'?'Qualified for adaptive review':'Full review'} · {q.labels_count}/300 distinct clean accepts · {q.reason??'qualified'}<details><summary>Evaluator identity</summary><pre>{q.key_json}</pre></details></p>)}
    {first?<article><blockquote style={{whiteSpace:'pre-wrap'}}>{first.text}</blockquote><p>Recorded outcome: {first.status} · semantic: {first.semantic??'unreviewed'}</p>
      <details><summary>Inspect captured evidence</summary><pre style={{whiteSpace:'pre-wrap'}}>{first.evidence}</pre></details><details><summary>Rules and exact digest</summary><pre>{first.rules}</pre><code>{first.exactDigest}</code></details>
      <label>Reason<textarea value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/></label>
      {(['accept-ok','accept-defect','hold-correct','hold-wrong'] as const).map(value=><button key={value} disabled={busy||!reason.trim()} onClick={()=>void label(first,value)}>{value.replace(/-/g,' ')}</button>)}
      <p>{items.length} candidates remain in this saved sample. Selection probability: {(first.probability*100).toFixed(1)}%.</p></article>:<p>No pending audit candidates.</p>}
    <button disabled={busy} onClick={()=>setReload(r=>r+1)}>Refresh audit queue</button>{error&&<p role="alert">{error}</p>}
    <details><summary>Recent labels and corrections</summary>{recent.map(r=><p key={r.id}>{r.text} · {r.label} · {r.reason} <button disabled={busy} onClick={()=>{setCorrection(r);setReason('');}}>Correct label</button></p>)}</details>
    {correction&&<article><p>Correcting: {correction.text}</p><label>Correction reason<textarea value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/></label>{(['accept-ok','accept-defect','hold-correct','hold-wrong'] as const).map(v=><button key={v} disabled={busy||!reason.trim()} onClick={()=>void label(correction,v,correction.id)}>{v.replace(/-/g,' ')}</button>)}<button onClick={()=>setCorrection(null)}>Cancel correction</button></article>}
  </section>;
}
