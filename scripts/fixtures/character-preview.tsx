import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../web/src/tailwind.css';
import {CharacterSection} from '../../web/src/components/CharacterSection';
import {CharacterProposalCard} from '../../web/src/components/CharacterProposalCard';
import {RoutineFlow} from '../../web/src/components/RoutineFlow';
function Preview(){
  const [id,setId]=useState('');
  const [theme,setTheme]=useState('light');
  useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
  useEffect(()=>{fetch('/__fixture').then(r=>r.json()).then(r=>setId(r.proposalId));},[]);
  return <main style={{height:'100%',overflow:'auto',padding:32,background:'var(--gk-bg-transcript)',color:'var(--gk-text)'}}>
    <h1>Character Phases 2–6 · isolated smoke check</h1>
    <p>Synthetic data in memory. No daemon, account, browser automation or provider calls.</p>
    <label>Preview appearance <select value={theme} onChange={e=>setTheme(e.target.value)}><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <CharacterSection agentId="a" agentName="Milo"/>
    {id&&<CharacterProposalCard agentId="a" proposalId={id}/>}
    <RoutineFlow agentId="a" routineId="routine"/>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
