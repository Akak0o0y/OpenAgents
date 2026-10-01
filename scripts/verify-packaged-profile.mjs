import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import { appExecutable } from './lib/app-executable.mjs';

const [oldDirectory,newDirectory,output]=process.argv.slice(2);
const restartOnly=process.argv.includes('--restart-only');
if(!oldDirectory||!newDirectory||!output||![oldDirectory,newDirectory].every(path.isAbsolute))throw new Error('Pass absolute old/new unpacked directories and an evidence JSON path.');
if(restartOnly)assert.equal(path.resolve(oldDirectory),path.resolve(newDirectory),'Restart-only mode requires the same application directory.');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'oh-profile-transition-'));
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const evidence={timestamp:new Date().toISOString(),profile,port,scope:restartOnly?'Same-version packaged daemon restart and profile persistence; not an upgrade or NSIS installation.':'Packaged daemon application-file replacement and reopen; not NSIS installation or a versioned upgrade.',boots:[],passed:false};
let child,log='',expectedProfile,missionId;
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Profile transitions need a changed runtime, not necessarily a changed mission
// module. Browser/provider-only releases legitimately keep missions unchanged.
const implementationHash=app=>createHash('sha256').update(
  ['daemon/missions.js','daemon/work-runtime.js','daemon/browser-tools.js','evals/llm-client.js']
    .map(relative=>`${relative}:${hash(path.join(app,'dist','src',relative))}`).join('\n')
).digest('hex');
async function stop(){
  if(!child||child.exitCode!==null)return;
  const process=child;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{process.kill('SIGKILL');reject(new Error('Packaged process did not stop.'));},7000);
    process.once('exit',()=>{clearTimeout(timer);resolve();});process.kill('SIGTERM');
  });
}
try {
  for(const [index,directory] of [oldDirectory,newDirectory,newDirectory].entries()) {
    const executable=appExecutable(directory), app=path.join(directory,'resources','app');
    const env={...process.env,ELECTRON_RUN_AS_NODE:'1',OPENHOURS_CONFIG:'none',OPENHOURS_LLM_MODE:'mock',OPENHOURS_EXECUTOR:'builtin',OPENHOURS_PORT:String(port),OPENHOURS_DB_PATH:path.join(profile,'state.db')};
    for(const key of ['OPENHOURS_MISSION','OPENHOURS_BACKLOG','OPENROUTER_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','OPENCODE_API_KEY'])delete env[key];
    log='';child=spawn(executable,[path.join(app,'dist','src','daemon','index.js')],{env,cwd:profile,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let spawnError;child.on('error',error=>{spawnError=error;});
    const collect=d=>{log=(log+String(d)).slice(-32000);};child.stdout.on('data',collect);child.stderr.on('data',collect);
    let headers,health;const deadline=Date.now()+45000;
    while(Date.now()<deadline) {
      if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error(`Packaged daemon exited ${child.exitCode}.`);
      const authPath=path.join(profile,'state.db.auth.json');
      if(fs.existsSync(authPath)) {
        headers={Authorization:`Bearer ${JSON.parse(fs.readFileSync(authPath,'utf8')).token}`};
        try {const res=await fetch(`http://127.0.0.1:${port}/health`,{headers,signal:AbortSignal.timeout(1000)});if(res.ok){health=await res.json();break;}} catch {}
      }
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.ok(health,'Packaged health deadline');
    const api=async(route,body)=>{
      const res=await fetch(`http://127.0.0.1:${port}${route}`,{method:body?'POST':'GET',headers:{...headers,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
      assert.equal(res.status,200,route);return res.json();
    };
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/system?agent=agent-alpha`,{signal:AbortSignal.timeout(1000)})).status,401);
    if(index===0) {
      expectedProfile=health.profileId;
      await api('/api/system/memory',{agentId:'agent-alpha',key:'transition-note',text:'Synthetic note must survive replacing application files.'});
      const result=await api('/api/system/missions',{agentId:'agent-alpha',objective:'Synthetic paused release review',contractId:'action-plan',maxRuns:2,intervalMs:60000});
      missionId=result.mission.id;await api('/api/system/mission-state',{id:missionId,state:'PAUSED'});
    } else assert.equal(health.profileId,expectedProfile);
    const state=await api('/api/system?agent=agent-alpha');
    assert.equal(state.memory.find(note=>note.key==='transition-note')?.text,'Synthetic note must survive replacing application files.');
    assert.equal(state.missions.find(m=>m.id===missionId)?.status,'PAUSED');
    evidence.boots.push({directory,profileId:health.profileId,executableSha256:hash(executable),implementationSha256:implementationHash(app),missionImplementationSha256:hash(path.join(app,'dist','src','daemon','missions.js')),memoryPreserved:true,missionPaused:true,unauthorizedStatus:401});
    await stop();child=undefined;
  }
  if(!restartOnly)assert.notEqual(evidence.boots[0].implementationSha256,evidence.boots[1].implementationSha256,'Must test different implementation snapshots.');
  evidence.passed=true;
} catch(error){evidence.error=String(error.message??error);evidence.log=log;process.exitCode=1;}
finally {
  try{await stop();}catch(error){evidence.stopError=String(error);process.exitCode=1;evidence.passed=false;}
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}
