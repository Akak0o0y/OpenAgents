import {useEffect,useState} from 'react';
import {api} from '../lib/transport.js';
type Task={id:string;name:string;status:string;runId:string};
export function BackgroundTasks({agentId}:{agentId:string}){
  const [tasks,setTasks]=useState<Task[]>([]),[instruction,setInstruction]=useState<Record<string,string>>({}),[ack,setAck]=useState<Record<string,boolean>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let disposed=false;const refresh=async()=>{try{const r=await api.systemAction('background-tasks',{agentId});if(!disposed)setTasks(r?.tasks??[]);}catch(e){if(!disposed)setError(String(e));}};void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{disposed=true;clearInterval(timer);};},[agentId]);
  async function resume(t:Task){setBusy(true);setError('');try{await api.systemAction('background-continue',{agentId,id:t.id,instruction:instruction[t.id],acknowledgeUncertain:!!ack[t.id]});setTasks(old=>old.map(x=>x.id===t.id?{...x,status:'QUEUED'}:x));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  if(!tasks.length)return null;
  return <details className="grok-question-card"><summary>Background tasks ({tasks.length})</summary>{tasks.map(t=><article key={t.id}><strong>{t.name}</strong><p>{t.status} · Run {t.runId}</p>{!['RUNNING','QUEUED'].includes(t.status)&&<form onSubmit={e=>{e.preventDefault();void resume(t);}}><label>Continue with instructions<textarea value={instruction[t.id]??''} maxLength={8000} onChange={e=>setInstruction(old=>({...old,[t.id]:e.target.value}))}/></label><label><input type="checkbox" checked={!!ack[t.id]} onChange={e=>setAck(old=>({...old,[t.id]:e.target.checked}))}/>I inspected any uncertain external actions before continuing.</label><button disabled={busy||!instruction[t.id]?.trim()}>Continue task</button></form>}</article>)}{error&&<p role="alert">{error}</p>}</details>;
}
