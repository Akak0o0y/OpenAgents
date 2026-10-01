import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, officeEntries } from '../src/daemon/document-tools.js';
import ExcelJS from 'exceljs';
import { AgentStore } from '../src/daemon/agent-store.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';

test('Office authoring produces real packages with readable content and literal spreadsheet cells', async () => {
  const word=await createDocument({path:'report.docx',format:'docx',title:'Report',paragraphs:['Hello world','Arabic: مرحبا']});
  assert.match(Buffer.from(officeEntries(word.bytes)['word/document.xml']).toString(),/Hello world/);
  const sheet=await createDocument({path:'data.xlsx',format:'xlsx',title:'Data',rows:[['Name','Value'],['=1+1',3]]});
  const workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(sheet.bytes as any);
  assert.equal(workbook.worksheets[0].getCell('A2').value,'=1+1');
  assert.equal(workbook.worksheets[0].getCell('B2').value,3);
  const slides=await createDocument({path:'slides.pptx',format:'pptx',title:'Deck',slides:[{title:'First',bullets:['Real slide content']}]});
  assert.match(Buffer.from(officeEntries(slides.bytes)['ppt/slides/slide1.xml']).toString(),/Real slide content/);
  await assert.rejects(createDocument({path:'../evil.docx',format:'docx',title:'x',paragraphs:['x']}),/relative workspace/);
  await assert.rejects(createDocument({path:'fake.pdf',format:'docx',title:'x',paragraphs:['x']}),/match its format/);
});

test('runtime delivers binary documents atomically with their answer, and rollback removes them', async () => {
  for (const ending of ['answer','finish']) for (const fail of [false,true]) {
    const store=new AgentStore(':memory:'); const artifacts=new ArtifactStore(store);
    store.createAgent({id:'bot',name:'Bot',model_id:'claude-haiku-4-5',budget_cap_usd:10,current_status:'IDLE'});
    const run=store.createTaskRun({agentId:'bot',taskName:'doc'}); store.startTaskRun(run.id,'claude-haiku-4-5');
    const steps:unknown[]=[{tool:'create_document',path:'report.docx',format:'docx',title:'Report',paragraphs:['Checked document']},...(ending==='finish'?[{tool:'verify'},{tool:'finish'}]:[{tool:'answer',text:'Prepared the document.',citations:[]}])];
    const runtime=new WorkRuntime({store,artifacts,ledger:new CostLedger(store.getDatabase()),sandbox:new DockerSandbox(),
      llm:{async generateCode(){return {content:JSON.stringify(steps.shift()),inputTokens:1,outputTokens:1,attemptCount:1};}},
      onFinalizeStage:stage=>{if(fail&&stage==='artifacts-saved')throw new Error('Injected rollback');}});
    const result=await runtime.execute({taskRunId:run.id,contract:CONVERSATION_CONTRACT,request:'Create a report',conversation:true,signal:new AbortController().signal});
    if(fail){assert.equal(result.outcome,'FAILED');assert.equal(artifacts.list(run.id).length,0);}
    else{assert.equal(result.outcome,'COMPLETED');const doc=result.artifacts.find(a=>a.path==='report.docx')!;assert(doc);assert.equal(artifacts.read(run.id,doc.id)?.encoding,'base64');assert.match(result.report,/report.docx/);}
    store.close();
  }
});
