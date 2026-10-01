import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {AgentStore} from '../src/daemon/agent-store.js';
import {ArtifactStore} from '../src/daemon/artifacts.js';
import {GoalResults} from '../src/daemon/goal-results.js';
import {BrowserTools,browserAction} from '../src/daemon/browser-tools.js';
import {MemorySecretStore} from '../src/daemon/secret-store.js';
import {setBrowserAutonomy} from '../src/daemon/browser-accounts.js';

// All HTTPS requests are intercepted by the existing fixture seam; no WhatsApp account or network is used.
test('controlled document UI binds a fresh outgoing receipt to downloaded report bytes',{timeout:30000},async()=>{
  const store=new AgentStore(':memory:'),artifacts=new ArtifactStore(store),goals=new GoalResults(store);
  const report='<html><body>Fixture findings</body></html>';
  const html=`<!doctype html><html><body><div id="main"><div data-id="false_966500000001@c.us_BEFORE"><span class="selectable-text copyable-text">Earlier incoming message</span></div><footer><div contenteditable="true" role="textbox"></div></footer></div>
    <input type="file" accept="*" onchange="document.querySelector('footer').hidden=true;document.querySelector('#preview').hidden=false">
    <div id="preview" hidden><div contenteditable="true" role="textbox" id="caption"></div><button data-icon="send" onclick="sendDocument()">Send document</button></div>
    <script>function sendDocument(){const row=document.createElement('div');row.dataset.id='true_966500000001@c.us_AFTER';row.innerHTML='<span class="selectable-text copyable-text"></span><span data-icon="msg-dblcheck"></span><a data-icon="document" download="report.html">Report</a>';row.querySelector('a').href=URL.createObjectURL(new Blob([${JSON.stringify(report)}],{type:'text/html'}));row.querySelector('.selectable-text').textContent=document.querySelector('#caption').innerText;document.querySelector('#main').append(row);document.querySelector('#preview').hidden=true;document.querySelector('footer').hidden=false;}</script></body></html>`;
  store.createAgent({id:'a',name:'Fixture',model_id:'mock',current_status:'IDLE',budget_cap_usd:0});setBrowserAutonomy(store,'a','always');
  const run=store.createTaskRun({agentId:'a',taskName:'fixture'});store.startTaskRun(run.id,'mock');
  const artifact=artifacts.save(run.id,{'report.html':report})[0]!;
  goals.define('a',run.id,0,[{id:'send',kind:'message',description:'Deliver report',required:true,target:'+966500000001',acceptance:{receipt:'delivered',verifier:'whatsapp/1',attachmentPaths:['report.html']}}],'owner','Controlled fixture');
  const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser=new BrowserTools({store,artifacts,secrets:new MemorySecretStore(),testHooks:existsSync(chrome)?{fixtureExecutablePath:chrome}:undefined,fixtureRoutes:{origin:'https://web.whatsapp.com',handle:async route=>{const file=new URL(route.request().url()).pathname==='/attachment';await route.fulfill({status:200,contentType:'text/html',headers:file?{'Content-Disposition':'attachment; filename="report.html"'}:{},body:file?report:html});return true;}}});
  // Keep the controlled-fixture diagnostic when the public adapter correctly redacts uncertainty.
  const checker=(browser as any).checkWhatsAppAttachment.bind(browser);let diagnostic='';
  (browser as any).checkWhatsAppAttachment=async(...args:unknown[])=>{try{return await checker(...args);}catch(error){diagnostic=String(error);throw error;}};
  try{
    await browser.call('a',run.id,browserAction.parse({tool:'browser',action:'navigate',url:'https://web.whatsapp.com'}),new AbortController().signal);
    const receipt=await browser.sendWhatsApp('a',run.id,{resultId:'send',recipient:'+966500000001',text:'Here is the report',attachment:{artifactId:artifact.id,sourceRunId:run.id}},new AbortController().signal);
    assert.equal(receipt.state,'delivered');assert.equal(goals.summary('a',run.id).satisfaction,'verified');
    assert.equal(goals.summary('a',run.id).results[0]!.evidence.attachmentDigests[0],artifact.sha256);
  }catch(error){if(diagnostic)throw new Error(diagnostic);throw error;}finally{await browser.endRun(run.id);store.close();}
});
