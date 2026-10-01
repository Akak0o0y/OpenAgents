/**
 * Operator Console (Phase 4 thin slice).
 *
 * Served by the daemon's existing HTTP server so the slice proves the WS contract
 * end-to-end with no extra process and no build step. The Next.js control plane
 * remains the Phase 4 destination and consumes this identical protocol:
 *   SYSTEM_HELLO -> snapshot | {command,targetId} -> COMMAND_RESULT | broadcast .event
 *
 * Inlined as a string because tsc does not copy .html into dist/.
 */

export const CONSOLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OpenAgents Operator Console</title>
<link rel="icon" href="data:,"/>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a7;--accent:#5b9dff;
--ok:#3fb950;--warn:#d29922;--err:#f85149;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);
background:var(--panel);position:sticky;top:0;z-index:5}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--err)}
.dot.on{background:var(--ok)}
.meta{margin-left:auto;color:var(--dim);font:12px/1 var(--mono)}
main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px;align-items:start}
@media(max-width:900px){main{grid-template-columns:1fr}}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
margin:0;padding:10px 14px;border-bottom:1px solid var(--line)}
.body{padding:12px 14px;max-height:46vh;overflow:auto}
.card{border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-bottom:8px}
.card:last-child{margin-bottom:0}
.row{display:flex;align-items:center;gap:8px}
.name{font-weight:600}
.sub{color:var(--dim);font:12px/1.4 var(--mono);word-break:break-all}
.badge{font:11px/1 var(--mono);padding:3px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.badge.RUNNING,.badge.BUSY{color:var(--accent);border-color:var(--accent)}
.badge.COMPLETED{color:var(--ok);border-color:var(--ok)}
.badge.FAILED,.badge.CRASHED{color:var(--err);border-color:var(--err)}
.badge.ABORTED,.badge.PAUSED{color:var(--warn);border-color:var(--warn)}
button{background:transparent;border:1px solid var(--line);color:var(--fg);border-radius:5px;
padding:4px 10px;font-size:12px;cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
button.danger:hover{border-color:var(--err);color:var(--err)}
button:disabled{opacity:.35;cursor:not-allowed}
.spacer{margin-left:auto}
#log{font:12px/1.6 var(--mono);max-height:46vh;overflow:auto;padding:12px 14px}
#log div{white-space:pre-wrap;border-bottom:1px solid var(--line);padding:3px 0}
#log div:last-child{border-bottom:0}
.t{color:var(--dim)}.k{color:var(--accent)}
.empty{color:var(--dim);font-style:italic;padding:6px 0}
</style></head><body>
<header>
  <span class="dot" id="dot"></span>
  <h1>OpenAgents Operator Console</h1>
  <span class="meta" id="meta">connecting...</span>
</header>
<main>
  <section><h2>Fleet</h2><div class="body" id="fleet"><div class="empty">no agents</div></div></section>
  <section><h2>Task Runs</h2><div class="body" id="runs"><div class="empty">no task runs</div></div></section>
  <section style="grid-column:1/-1"><h2>Live Event Stream</h2><div id="log"><div class="empty">waiting for events...</div></div></section>
</main>
<script>
var ws=null, agents=[], runs=[], connected=false;
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}

function log(kind,text){
  var box=$('log'); var first=box.querySelector('.empty'); if(first)box.innerHTML='';
  var d=document.createElement('div');
  d.innerHTML='<span class="t">'+new Date().toLocaleTimeString()+'</span> <span class="k">'+esc(kind)+'</span> '+esc(text);
  box.appendChild(d);
  while(box.children.length>300)box.removeChild(box.firstChild);
  box.scrollTop=box.scrollHeight;
}
function send(command,targetId){
  if(!connected)return;
  ws.send(JSON.stringify({command:command,targetId:targetId}));
  log('COMMAND',command+' -> '+targetId);
}
function renderFleet(){
  var el=$('fleet');
  if(!agents.length){el.innerHTML='<div class="empty">no agents</div>';return}
  el.innerHTML=agents.map(function(a){
    var paused=a.current_status==='PAUSED';
    return '<div class="card"><div class="row"><span class="name">'+esc(a.name||a.id)+'</span>'+
      '<span class="badge '+esc(a.current_status)+'">'+esc(a.current_status)+'</span>'+
      '<span class="spacer"></span>'+
      '<button data-cmd="'+(paused?'resume':'pause')+'" data-id="'+esc(a.id)+'">'+(paused?'Resume':'Pause')+'</button>'+
      '</div><div class="sub">'+esc(a.id)+' · '+esc(a.model_id)+'</div></div>'}).join('');
}
function renderRuns(){
  var el=$('runs');
  if(!runs.length){el.innerHTML='<div class="empty">no task runs</div>';return}
  el.innerHTML=runs.slice().reverse().slice(0,25).map(function(r){
    var live=r.status==='RUNNING';
    return '<div class="card"><div class="row"><span class="name">'+esc(r.task_name)+'</span>'+
      '<span class="badge '+esc(r.status)+'">'+esc(r.status)+'</span>'+
      '<span class="spacer"></span>'+
      '<button class="danger" data-cmd="kill" data-id="'+esc(r.id)+'"'+(live?'':' disabled')+'>Kill</button>'+
      '</div><div class="sub">'+esc(r.id)+'<br/>'+esc(r.model_id||'-')+' · turns '+(r.turns_taken||0)+
      ' · $'+Number(r.actual_cost_usd||0).toFixed(4)+'</div></div>'}).join('');
}
document.addEventListener('click',function(e){
  var b=e.target.closest('button[data-cmd]'); if(b&&!b.disabled)send(b.dataset.cmd,b.dataset.id)});

function refresh(){
  fetch('/api/state').then(function(r){return r.json()}).then(function(s){
    agents=s.agents||[];runs=s.taskRuns||[];renderFleet();renderRuns()}).catch(function(){})
}
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
  ws.onopen=function(){connected=true;$('dot').classList.add('on');log('WS','connected')};
  ws.onclose=function(){connected=false;$('dot').classList.remove('on');
    $('meta').textContent='disconnected - retrying';log('WS','disconnected');setTimeout(connect,2000)};
  ws.onmessage=function(ev){
    var m;try{m=JSON.parse(ev.data)}catch(err){return}
    if(m.type==='SYSTEM_HELLO'){
      agents=m.payload.agents||[];runs=m.payload.taskRuns||[];renderFleet();renderRuns();
      $('meta').textContent='port '+m.payload.port+' · '+m.payload.clientCount+' client(s)';
      log('HELLO',agents.length+' agent(s), '+runs.length+' run(s)');return}
    if(m.type==='COMMAND_RESULT'){
      log(m.result.success?'OK':'FAIL',m.result.command+' '+m.result.targetId+' - '+(m.result.message||m.result.error||''));
      refresh();return}
    if(m.type==='COMMAND_ERROR'||m.type==='PARSE_ERROR'){log('ERROR',m.error);return}
    if(m.event){
      var e=m.event;
      log(e.event_type,(e.task_run_id||'')+(e.turn_number?' turn '+e.turn_number:'')+
        (e.model_id?' · '+e.model_id:''));
      refresh();return}
  };
}
connect();setInterval(refresh,3000);refresh();
</script></body></html>`;
