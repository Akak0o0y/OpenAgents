import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
import {AgentStore} from '../dist/src/daemon/agent-store.js';import {CostLedger} from '../dist/src/kernel/cost-ledger.js';import {DockerSandbox} from '../dist/src/kernel/docker-sandbox.js';
import {ChatService} from '../dist/src/daemon/chat.js';import {WorkRuntime} from '../dist/src/daemon/work-runtime.js';import {ArtifactStore} from '../dist/src/daemon/artifacts.js';import {RunCapacity} from '../dist/src/daemon/run-capacity.js';
import {DaemonWsServer} from '../dist/src/daemon/ws-server.js';import {readWorkResult} from '../dist/src/daemon/work-results.js';

const duration=Number(process.argv[2]??600000);if(!Number.isFinite(duration)||duration<1000||duration>3600000)throw new Error('Duration must be 1 second–1 hour.');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'oh-soak-'));const db=path.join(root,'state.db');
const store=new AgentStore(db);const ledger=new CostLedger(store.getDatabase());const artifacts=new ArtifactStore(store);const capacity=new RunCapacity(3);const memorySamples=[];
let active=0,peak=0,calls=0;const started=Date.now();let completed=0,replayed=0,httpReads=0,unauthorized=0;
store.createAgent({id:'soak',name:'Soak',model_id:'claude-haiku-4-5',budget_cap_usd:100,current_status:'IDLE'});
const llm={async generateCode(req){calls++;active++;peak=Math.max(peak,active);try{await delay(15,undefined,{signal:req.signal});const turn=(req.messages.length+1)/2;const plan={title:'Synthetic plan',tasks:[{id:'check',title:'Check release',priority:1,dependsOn:[],doneWhen:'Report saved'}],limitations:['Synthetic local load fixture.']};return{content:JSON.stringify(turn===1?{tool:'write',path:'plan.json',content:JSON.stringify(plan)}:turn===2?{tool:'verify'}:{tool:'finish'}),inputTokens:10,outputTokens:10,attemptCount:1};}finally{active--;}}};
const runtime=new WorkRuntime({store,ledger,llm,sandbox:new DockerSandbox(),artifacts});const chat=new ChatService({agentStore:store,ledger,llmClient:llm,workRuntime:runtime,capacity});
const server=new DaemonWsServer(0,()=>({}),{getRunEvents:id=>store.getTaskEvents(id),getRunWorkspace:async()=>({available:false,reason:'No shell for plans'}),readRunFile:async()=>({available:false,reason:'No shell for plans'}),approvals:()=>[],mcpStatus:()=>[],artifacts:id=>artifacts.list(id),artifact:(run,id)=>artifacts.read(run,id),workResult:id=>readWorkResult(store,id)});
server.setChatApi({listThreads:()=>chat.listThreads(),createThread:id=>chat.createThread(id),getMessages:id=>chat.getMessages(id),send:(...args)=>chat.send(...args),abortRequest:(...args)=>chat.abortRequest(...args),listTasks:()=>[]});
await server.start();
const port=server.boundPort;const base=`http://127.0.0.1:${port}`;const headers={Authorization:`Bearer ${server.authToken}`,'Content-Type':'application/json'};
const threads=Array.from({length:3},()=>chat.createThread('soak'));let round=0,lastSample=0;let failure;
try{
  if(!port)throw new Error('Server has no bound port accessor.');
  while(Date.now()-started<duration){
    await Promise.all(threads.map(async(thread,i)=>{
      const url=`${base}/api/chat/threads/${thread.id}/messages`;const init={method:'POST',headers,body:JSON.stringify({message:`Prepare plan ${round}-${i}`,requestId:`soak-${round}-${i}`,taskId:'action-plan'})};
      const response=await fetch(url,init);assert.equal(response.status,200);const result=await response.json();assert.equal(result.work.outcome,'COMPLETED');completed++;
      const a=result.work.artifacts[0];const download=await fetch(base+a.downloadUrl,{headers});assert.equal(download.status,200);assert.ok((await download.text()).length>0);httpReads++;
      if(round%10===0){const before=calls;const replay=await(await fetch(url,init)).json();assert.equal(replay.taskRunId,result.taskRunId);replayed++;}
      const events=await fetch(`${base}/api/runs/${result.taskRunId}/events`,{headers});assert.equal(events.status,200);await events.arrayBuffer();httpReads++;
    }));
    if(round%10===0){const denied=await fetch(`${base}/api/chat/tasks`);assert.equal(denied.status,401);await denied.arrayBuffer();unauthorized++;}
    assert.equal(capacity.used,0);assert.equal(active,0);assert.equal(peak<=3,true);
    if(Date.now()-lastSample>=60000){lastSample=Date.now();memorySamples.push({elapsedMs:Date.now()-started,completed,rssBytes:process.memoryUsage().rss,heapBytes:process.memoryUsage().heapUsed,databaseBytes:fs.statSync(db).size});console.log(JSON.stringify(memorySamples.at(-1)));}
    round++;await delay(1000);
  }
}catch(error){failure=String(error.stack??error);process.exitCode=1;}
finally{
  await chat.stop();await server.close();ledger.close();store.close();
  const reopened=new AgentStore(db);const durable=reopened.listTaskRuns().filter(r=>r.status==='COMPLETED').length;assert.equal(durable,completed);reopened.close();
  const result={timestamp:new Date().toISOString(),platform:process.platform,node:process.version,elapsedMs:Date.now()-started,root,completed,replayed,httpReads,unauthorized,modelCalls:calls,peakConcurrentModelCalls:peak,capacityLimit:capacity.limit,memorySamples,durableCompleted:durable,passed:!failure,failure};
  fs.writeFileSync(process.argv[3] ?? 'docs/validation/2026-09-12-phase-3/soak.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
