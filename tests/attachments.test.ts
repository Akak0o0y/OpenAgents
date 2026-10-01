import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { Attachments } from '../src/daemon/attachments.js';
import { createDocument } from '../src/daemon/document-tools.js';
import { buildOpenAIMessages, buildAnthropicMessages } from '../src/evals/llm-client.js';
import { contextChars } from '../src/daemon/context-budget.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afoIAAAAASUVORK5CYII=';
function fixture(){const store=new AgentStore(':memory:');store.createAgent({id:'bot',name:'Bot',model_id:'claude-haiku-4-5',budget_cap_usd:10,current_status:'IDLE'});const thread=store.createThread({agentId:'bot'});return{store,thread,attachments:new Attachments(store)};}
test('binary attachments extract real document text, retain original bytes and enforce thread ownership',async()=>{
  const h=fixture();
  const doc=await createDocument({path:'report.docx',format:'docx',title:'Report',paragraphs:['Recorded evidence']});
  const saved=await h.attachments.upload({agentId:'bot',threadId:h.thread.id,name:'report.docx',data:doc.bytes.toString('base64')});
  assert.match(h.attachments.resolve('bot',h.thread.id,saved.content).text,/Recorded evidence/);
  assert.equal(h.attachments.read(saved.id).data,doc.bytes.toString('base64'));
  assert.throws(()=>h.attachments.resolve('bot','other-thread',saved.content),/unavailable/);
  assert.throws(()=>h.attachments.resolve('other-bot',h.thread.id,saved.content),/unavailable/);
  await assert.rejects(h.attachments.upload({agentId:'bot',threadId:h.thread.id,name:'x.png',data:'not base64'}),/base64/);
  h.store.close();
});
test('vision uses typed image blocks and a model opt-in; base64 never becomes prompt text',async()=>{
  const h=fixture();const file=await h.attachments.upload({agentId:'bot',threadId:h.thread.id,name:'pixel.png',data:PNG});
  const supplied=h.attachments.resolve('bot',h.thread.id,file.content);
  assert.equal(supplied.images[0].mime,'image/png');
  const req={modelId:'claude-haiku-4-5',systemPrompt:'s',userPrompt:'Look',messages:[{role:'user' as const,content:'Look',images:supplied.images}]};
  assert.equal(buildOpenAIMessages(req)[0].content[1].image_url.url,`data:image/png;base64,${PNG}`);
  assert.equal(buildAnthropicMessages(req)[0].content[1].source.data,PNG);
  assert(contextChars('',req.messages)>20000);
  const run=h.store.createTaskRun({agentId:'bot',taskName:'vision'});h.store.startTaskRun(run.id,'claude-haiku-4-5');
  let calls=0;const opts={store:h.store,ledger:new CostLedger(h.store.getDatabase()),artifacts:new ArtifactStore(h.store),sandbox:new DockerSandbox(),attachments:h.attachments,
    llm:{async generateCode(request:any){calls++;assert.equal(request.messages[0].images[0].data,PNG);assert(!request.messages[0].content.includes(PNG));return{content:JSON.stringify({tool:'answer',text:'Image received',citations:[]}),inputTokens:10,outputTokens:10,attemptCount:1};}}};
  const input={taskRunId:run.id,threadId:h.thread.id,contract:CONVERSATION_CONTRACT,request:file.content,conversation:true,signal:new AbortController().signal};
  await assert.rejects(new WorkRuntime(opts).execute(input),/not enabled/);assert.equal(calls,0);
  const result=await new WorkRuntime({...opts,visionModels:['claude-haiku-4-5']}).execute(input);
  assert.equal(result.outcome,'COMPLETED');assert.equal(calls,1);h.store.close();
});
test('PDF extraction returns page text through the bounded worker',async()=>{
  const h=fixture();
  const stream='BT /F1 12 Tf 30 100 Td (Hello PDF) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const file=await h.attachments.upload({agentId:'bot',threadId:h.thread.id,name:'sample.pdf',data:Buffer.from(pdf).toString('base64')});
  assert.match(h.attachments.resolve('bot',h.thread.id,file.content).text,/Hello PDF/);h.store.close();
});
