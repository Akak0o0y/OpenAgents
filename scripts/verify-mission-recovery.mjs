import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
import {AgentStore} from '../dist/src/daemon/agent-store.js';
import {MissionService} from '../dist/src/daemon/missions.js';
import {DIRECT_WORK_CONTRACTS} from '../dist/src/daemon/work-contract.js';

const childMode=process.argv[2]==='--child';
const root=childMode?process.argv[3]:fs.mkdtempSync(path.join(os.tmpdir(),'oh-recovery-'));
const db=path.join(root,'state.db');
if(childMode){
  const store=new AgentStore(db);const missions=new MissionService(store,DIRECT_WORK_CONTRACTS,10);
  for(const id of ['safe','uncertain','paused']){
    store.createAgent({id,name:id,model_id:'claude-haiku-4-5',budget_cap_usd:10,current_status:'IDLE'});
    missions.create({agentId:id,objective:`Recovery fixture ${id}`,contractId:'action-plan',maxRuns:3,intervalMs:60000});
  }
  await missions.start();await missions.produceNextTasks(store);
  for(const m of missions.list()){
    store.startTaskRun(m.last_run_id);
    if(m.agent_id==='paused')missions.control(m.id,'PAUSED');
    if(m.agent_id==='uncertain')store.recordEvent({task_run_id:m.last_run_id,agent_id:m.agent_id,model_id:'claude-haiku-4-5',event_type:'EXTERNAL_ACTION_STARTED',payload_json:JSON.stringify({actionId:'not-settled'}),timestamp:Date.now()});
  }
  console.log('DURABLE_READY');setInterval(()=>{},1000);
}else{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--child',root],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let killed=false;let stderr='';child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  child.stdout.on('data',d=>{if(String(d).includes('DURABLE_READY')){killed=true;child.kill('SIGKILL');}});
  const termination=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
  assert.ok(killed,stderr||'Child did not reach durable checkpoint.');
  const store=new AgentStore(db);assert.equal(store.markInFlightAsCrashed('Force-killed fixture'),3);
  let now=Date.now();const missions=new MissionService(store,DIRECT_WORK_CONTRACTS,10,()=>now);await missions.start();
  assert.equal(await missions.produceNextTasks(store),0);now+=60001;assert.equal(await missions.produceNextTasks(store),1);
  const states=missions.list().map(m=>({agent:m.agent_id,status:m.status,runs:m.runs,reason:m.reason}));
  assert.equal(states.find(m=>m.agent==='safe').runs,2);assert.equal(states.find(m=>m.agent==='uncertain').status,'WAITING');assert.equal(states.find(m=>m.agent==='paused').status,'PAUSED');
  const output={timestamp:new Date().toISOString(),platform:process.platform,termination,root,states,passed:true};
  fs.writeFileSync('docs/validation/2026-09-12-phase-3/recovery.json',JSON.stringify(output,null,2));store.close();console.log(JSON.stringify(output,null,2));
}
