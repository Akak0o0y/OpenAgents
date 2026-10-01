import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import { appExecutable } from './lib/app-executable.mjs';
const unpacked=process.argv[2];if(!unpacked||!path.isAbsolute(unpacked))throw new Error('Pass an absolute win-unpacked directory.');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'oh-packaged-runtime-'));
const appDirectory=fs.existsSync(path.join(unpacked,'resources','app'))?'app':'app.asar';
const entry=path.join(unpacked,'resources',appDirectory,'dist','src','daemon','index.js');
const env={...process.env,ELECTRON_RUN_AS_NODE:'1',OPENHOURS_CONFIG:'none',OPENHOURS_LLM_MODE:'mock',OPENHOURS_EXECUTOR:'builtin',OPENHOURS_PORT:'4197',OPENHOURS_DB_PATH:path.join(root,'state.db')};
delete env.OPENHOURS_MISSION;delete env.OPENHOURS_BACKLOG;
const child=spawn(appExecutable(unpacked),[entry],{env,cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
let log='';child.stdout.on('data',d=>log+=String(d));child.stderr.on('data',d=>log+=String(d));
const result={timestamp:new Date().toISOString(),root,unpacked,passed:false};
try{
  const deadline=Date.now()+45000;let response;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error(`Packaged daemon exited ${child.exitCode}.`);
    const authFile=`${env.OPENHOURS_DB_PATH}.auth.json`;
    if(fs.existsSync(authFile)){
      const {token}=JSON.parse(fs.readFileSync(authFile,'utf8'));const headers={Authorization:`Bearer ${token}`};
      try{
        response=await fetch('http://127.0.0.1:4197/health',{headers,signal:AbortSignal.timeout(1000)});
        if(response.ok){
          result.health=await response.json();
          const catalog=await(await fetch('http://127.0.0.1:4197/api/chat/tasks',{headers})).json();
          const system=await(await fetch('http://127.0.0.1:4197/api/system?agent=agent-alpha',{headers})).json();
          const html=await(await fetch('http://127.0.0.1:4197/',{headers})).text();
          if(!catalog.tasks?.some(t=>t.id==='evidence-brief')||!system.memory||!html.includes('/assets/'))throw new Error('Packaged task catalog, system API or UI bundle is missing.');
          if(process.env.OPENHOURS_VERIFY_BOT_DESKTOP==='1') {
            if(!system.browser?.desktop || system.browser.isolation!=='sandbox')throw new Error('Packaged daemon did not select the bot-owned desktop by default.');
            for(const file of ['Dockerfile','start.sh','gateway.mjs','computer.mjs','seccomp.json'])if(!fs.existsSync(path.join(unpacked,'resources',appDirectory,'docker','bot-desktop',file)))throw new Error('Missing packaged desktop asset: '+file);
            result.botDesktopDefault=true;
          }
          result.contracts=catalog.tasks.map(t=>t.id);result.capacity=system.capacity;result.htmlBytes=Buffer.byteLength(html);result.passed=true;break;
        }
      }catch(error){if(response?.ok)throw error;}
    }
    await new Promise(r=>setTimeout(r,300));
  }
  if(!result.passed)throw new Error('Packaged startup timed out.');
}catch(error){result.error=String(error.message??error);process.exitCode=1;}
finally{
  child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},5000).unref();});
  result.log=log;
  fs.writeFileSync(process.argv[3]??'docs/validation/2026-09-12-phase-3/packaged-runtime.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,log:undefined},null,2));
}
