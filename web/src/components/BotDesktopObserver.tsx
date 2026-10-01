import {useEffect,useState} from 'react';

/** Authenticated output-only stream. No keyboard, pointer or clipboard channel exists. */
export function BotDesktopObserver({agentId}:{agentId:string}){
  const [frame,setFrame]=useState<string|null>(null),[last,setLast]=useState(0),[now,setNow]=useState(Date.now()),[error,setError]=useState(false);
  useEffect(()=>{
    setFrame(null);setLast(0);setError(false);
    let events:EventSource|null=null;
    const connect=()=>{events?.close();events=null;if(document.hidden)return;
      events=new EventSource(`/api/desktop/${encodeURIComponent(agentId)}/observe`);
      events.onmessage=event=>{try{const data=JSON.parse(event.data);if(typeof data.image==='string'&&data.image.startsWith('data:image/jpeg;base64,')){setFrame(data.image);setLast(Date.now());setError(false);}}catch{setError(true);}};
      events.onerror=()=>setError(true);
    };
    connect();document.addEventListener('visibilitychange',connect);
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>{events?.close();clearInterval(timer);document.removeEventListener('visibilitychange',connect);};
  },[agentId]);
  const age=last?now-last:Infinity;
  return <div className="oh-desktop-observer" aria-label="Read-only bot desktop" style={{position:'relative',width:'100%'}}>
    {frame&&<img src={frame} alt="Bot desktop including its actual pointer" style={{width:'100%',display:'block',opacity:age>3000?.5:1}}/>}
    <span role="status">{error?'Unavailable — desktop stream disconnected':!last?'Connecting to desktop':age>10000?'Disconnected':age>3000?'Stale frame':'Live · view only'}{last?` · last frame ${new Date(last).toLocaleTimeString()}`:''}</span>
  </div>;
}
