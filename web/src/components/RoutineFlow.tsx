import {useEffect,useState} from 'react';
import {getJson,postJson} from '../lib/transport.js';
type Snapshot={playbackMode?:'auto'|'on'|'off';playbackEnabled?:boolean;flows?:Array<{routineId:string;version:number;state:string;account:string|null;attention:string|null;lastReason:string|null;steps:string[]}>};
export function RoutineFlow({agentId,routineId}:{agentId:string;routineId:string}) {
  const [state,setState]=useState<Snapshot>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [rhythm,setRhythm]=useState<{date:string;cap:number|null;slots:Array<{status:string;count:number}>}|null>(null),[override,setOverride]=useState(false);
  useEffect(()=>{const c=new AbortController();getJson<Snapshot>(`/api/system?agent=${encodeURIComponent(agentId)}`,c.signal).then(setState).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[agentId,routineId,revision]);
  useEffect(()=>{const c=new AbortController();getJson<typeof rhythm>(`/api/system/character-rhythm?agent=${encodeURIComponent(agentId)}`,c.signal).then(setRhythm).catch(()=>{});return()=>c.abort();},[agentId,routineId,revision]);
  async function action(path:string,body:object){setBusy(true);setError('');try{await postJson('/api/system/'+path,{agentId,...body});setRevision(r=>r+1);return true;}catch(e){setError(e instanceof Error?e.message:String(e));return false;}finally{setBusy(false);}}
  const flow=state.flows?.find(f=>f.routineId===routineId);
  if(!state.playbackMode)return null;
  return <details><summary>Learned browser steps{flow?` · ${flow.state} v${flow.version}`:''}</summary>
    <label>Playback for this bot<select disabled={busy} value={state.playbackMode} onChange={e=>void action('flow-playback',{mode:e.target.value})}><option value="auto">Automatic after a response-confirmed post</option><option value="on">On</option><option value="off">Off</option></select></label>
    <p>{state.playbackEnabled?'Proven steps can be reused.':'Runs use the regular model loop and can still learn.'}</p>
    {rhythm?.cap!=null&&<p>{rhythm.slots.filter(s=>['reserved','attempted','used'].includes(s.status)).reduce((n,s)=>n+s.count,0)} / {rhythm.cap} daily post slots ({rhythm.date}). <button disabled={busy||override} onClick={()=>void action('character-rhythm',{routineId}).then(saved=>{if(saved)setOverride(true);})}>Allow next manual run over daily cap</button>{override&&' Permission lasts one hour and applies to one manual run.'}</p>}
    {flow&&<><p>Recorded account: {flow.account?`@${flow.account}`:'unavailable'}</p><ol>{flow.steps.map((s,i)=><li key={i}>{s}</li>)}</ol>{flow.lastReason&&<p>{flow.lastReason}</p>}
      {flow.attention&&<><p>Check the bot’s signed-in account before continuing.</p><button disabled={busy} onClick={()=>void action('flow-acknowledge',{routineId})}>I checked the account</button></>}
      <button disabled={busy} onClick={()=>void action('flow-forget',{routineId})}>Forget learned steps</button></>}
    {error&&<p role="alert">{error}</p>}
  </details>;
}
