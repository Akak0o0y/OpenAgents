import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {chromium} from 'playwright';
import {startDaemon} from '../dist/src/daemon/index.js';
const out=path.resolve('docs/validation/2026-09-20-daily-use');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'oh-daily-ui-'));let release;const hold=new Promise(r=>release=r);let turn=0;
const daemon=await startDaemon({configPath:null,dbPath:path.join(profile,'state.db'),wsPort:4198,docker:false,cadenceMs:1000,sandbox:{orphanSweep:async()=>({reapedContainers:0,reapedVolumes:0}),workspaceVolumeName:n=>n,workspaceVolumeExists:async()=>false},llmClient:{async generateCode(req){turn++; if(turn===1)return{content:JSON.stringify({tool:'browser',action:'navigate',url:'https://example.com'}),inputTokens:1,outputTokens:1,attemptCount:1};await hold;return{content:JSON.stringify({tool:'answer',text:'Browser demonstration completed.',citations:[]}),inputTokens:1,outputTokens:1,attemptCount:1};}}});
const auth=JSON.parse(fs.readFileSync(path.join(profile,'state.db.auth.json'),'utf8'));const origin='http://127.0.0.1:4198';
const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark'});await context.addCookies([{name:'openhours_session',value:auth.token,url:origin}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 const agent=daemon.store.listAgents()[0];const thread=daemon.chat.createThread(agent.id);const pending=daemon.chat.send(thread.id,'Open example.com so I can watch the browser.','daily-ui');
 await page.goto(origin);await page.getByRole('button',{name:'Show details',exact:true}).waitFor({timeout:30000});
 await page.getByRole('button',{name:'Show details',exact:true}).click();
 await page.getByRole('img',{name:'Live bot browser page'}).waitFor({timeout:40000});
 if(await page.getByRole('button',{name:/^Mode:/}).count())throw new Error('Mode selector remains');
 await page.screenshot({path:path.join(out,'workspace.png'),fullPage:true});
 await page.getByRole('button',{name:'Open browser',exact:true}).click();
 await page.getByRole('button',{name:'Take control',exact:true}).click();await page.getByRole('button',{name:'Resume bot',exact:true}).waitFor();
 await page.screenshot({path:path.join(out,'browser-control.png'),fullPage:true});
 await page.getByRole('button',{name:'Resume bot',exact:true}).click();await page.getByRole('button',{name:'Exit fullscreen'}).click();
 await page.getByRole('button',{name:'Bot settings',exact:true}).first().click();await page.getByRole('heading',{name:'Connected websites'}).waitFor();
 await page.getByRole('heading',{name:'Connected websites'}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'settings.png'),fullPage:true});
 await page.setViewportSize({width:1000,height:740});await page.getByRole('heading',{name:'Connected websites'}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'settings-compact.png'),fullPage:true});
 release();await pending;
 if(errors.length)throw new Error(errors.join('\n'));
 fs.writeFileSync(path.join(out,'ui.json'),JSON.stringify({passed:true,actualDaemon:true,scriptedModel:true,liveBrowser:true,errors},null,2));console.log('DAILY_UI_PASSED');
}finally{release();await browser.close();await daemon.shutdown();}
