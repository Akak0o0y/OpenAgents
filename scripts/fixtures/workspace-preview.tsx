import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../web/src/tailwind.css';
import {GrokScreen} from '../../web/src/components/GrokScreen';
import {AvatarStudio} from '../../web/src/components/AvatarStudio';
import {defaultProfile} from '../../web/src/lib/botProfile';
import type {DetailsState, Teammate} from '../../web/src/components/workspaceTypes';
import type {RoutineRow} from '../../web/src/lib/transport';

function Preview() {
  const [theme,setTheme]=useState('light');
  const [details,setDetails]=useState<DetailsState>({open:true,view:'settings',routineId:null});
  const [notice,setNotice]=useState('');
  const [studio,setStudio]=useState(false);
  const [agent,setAgent]=useState<Teammate>({id:'demo',name:'Milo',description:'Research carefully, explain clearly and turn useful ideas into finished work.',model:'demo-model',status:'IDLE',budgetCapUsd:10,profile:defaultProfile({id:'demo',name:'Milo',model_id:'demo-model'}),flags:{pinned:false,unread:false,hidden:false,section:null},reactions:{},threadId:null,lastMessagePreview:null,lastMessageAt:null});
  const [routines,setRoutines]=useState<RoutineRow[]>([{id:'morning',agent_id:'demo',name:'Morning research brief',cron_expression:'0 8 * * *',human_schedule:'Every day at 8:00 AM',timezone:'Asia/Riyadh',prompt_template:'Research the most useful AI developments and save a short report with sources.',enabled:1,catch_up_policy:'skip',next_run_at:Date.now()+3600000,created_at:1,updated_at:1},{id:'weekly',agent_id:'demo',name:'Weekly reading list',cron_expression:'0 10 * * 5',human_schedule:'Every Friday at 10:00 AM',timezone:'Asia/Riyadh',prompt_template:'Prepare a reading list.',enabled:0,catch_up_policy:'skip',next_run_at:Date.now()+86400000,created_at:1,updated_at:1}]);
  useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
  return <main style={{height:'100dvh',display:'flex',background:'var(--gk-bg-transcript)',color:'var(--gk-text)'}}>
    <section style={{flex:1,padding:32,minWidth:0,overflow:'auto'}}><h1>Workspace design preview</h1><p>Synthetic data only. No daemon, accounts or real runs.</p><label>Appearance <select value={theme} onChange={e=>setTheme(e.target.value)}><option value="light">Light</option><option value="dark">Dark</option></select></label><p><button onClick={()=>setDetails({open:true,view:'settings',routineId:null})}>Bot settings</button> · <button onClick={()=>setDetails({open:true,view:'details',routineId:null})}>Workspace</button> · <button onClick={()=>setDetails({open:true,view:'routine',routineId:'morning'})}>Routine</button></p>{notice&&<p role="status">{notice}</p>}</section>
    <GrokScreen agent={agent} details={details} computer={{files:[],runId:null} as any} routines={routines} routinesError={null} routinesLoading={false} profileError={null}
      onClose={()=>setNotice('Preview panel stays open. No real workspace was changed.')}
      onSetView={(view,routineId=null)=>setDetails({open:true,view,routineId})}
      onUpdateProfile={patch=>setAgent(a=>({...a,profile:{...a.profile,...patch}}))}
      onSaveAgent={async patch=>setAgent(a=>({...a,name:patch.name??a.name,model:patch.modelId??a.model,description:patch.systemPrompt??a.description,budgetCapUsd:patch.budgetCapUsd??a.budgetCapUsd}))}
      onOpenStudio={()=>setStudio(true)}
      onSaveRoutine={async(draft,cron)=>{setRoutines(current=>current.map(r=>r.id===draft.id?{...r,name:draft.name,prompt_template:draft.instruction,cron_expression:cron}:r));setNotice('Saved in this preview only.');}}
      onDeleteRoutine={async()=>setNotice('Deletion is disabled in this preview.')}
      onTestRunRoutine={async()=>setNotice('No run was started. This is an isolated preview.')}
      onSetRoutineEnabled={async(id,enabled)=>setRoutines(current=>current.map(r=>r.id===id?{...r,enabled:enabled?1:0}:r))}
      onSetRoutineWebhook={async()=>setNotice('Webhooks are disabled in this preview.')}/>
    {studio&&<AvatarStudio name={agent.name} profile={agent.profile} onSave={async profile=>setAgent(a=>({...a,profile}))} onClose={()=>setStudio(false)}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
