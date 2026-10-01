import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startDaemon} from '../dist/src/daemon/index.js';
const root=process.argv[2] ? fs.realpathSync(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(),'oh-system-ui-'));
if (!path.isAbsolute(root) || !path.basename(root).startsWith('oh-system-ui-')) throw new Error('Use an explicitly named temporary UI fixture profile.');
const config=path.join(root,'config.json');const vault=path.join(root,'vault');fs.mkdirSync(vault,{recursive:true});fs.writeFileSync(path.join(vault,'Source.md'),'Synthetic release note: manual approval is pending.');
fs.writeFileSync(config,JSON.stringify({executor:'builtin',agents:[{id:'fixture',name:'System Test Bot',model:'claude-haiku-4-5',budgetUsd:10,obsidianVault:vault}],scheduler:{cadenceMs:250,maxConcurrency:2}}));
const llm={async generateCode(req){
  const turn=(req.messages.length+1)/2;
  const plan={title:'Synthetic release plan',tasks:[{id:'review',title:'Review release evidence',doneWhen:'Review report is saved',priority:1,dependsOn:[]}],limitations:['Scripted UI fixture; no real external action.']};
  const action=turn===1?{tool:'write',path:'plan.json',content:JSON.stringify(plan)}:turn===2?{tool:'verify'}:{tool:'finish',...(req.systemPrompt.includes('For finish include mission:')?{mission:{state:'complete',reason:'The requested plan was delivered with its structural checks.'}}:{})};
  return{content:JSON.stringify(action),inputTokens:10,outputTokens:10,attemptCount:1};
}};
const daemon=await startDaemon({dbPath:path.join(root,'state.db'),configPath:config,wsPort:4196,llmClient:llm,executor:'builtin'});
console.log(JSON.stringify({root,port:4196,token:JSON.parse(fs.readFileSync(path.join(root,'state.db.auth.json'),'utf8')).token}));
process.on('SIGTERM',async()=>{await daemon.shutdown();process.exit(0);});
process.on('SIGINT',async()=>{await daemon.shutdown();process.exit(0);});
