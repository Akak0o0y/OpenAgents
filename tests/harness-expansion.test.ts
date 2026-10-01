import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createCanvas} from '@napi-rs/canvas';
import ExcelJS from 'exceljs';
import {unzipSync,strFromU8} from 'fflate';
import {createDocument} from '../src/daemon/document-tools.js';
import {Attachments} from '../src/daemon/attachments.js';
import {AgentStore} from '../src/daemon/agent-store.js';
import {BackgroundTasks} from '../src/daemon/background-tasks.js';
import {RepositoryFetcher,parseRepository} from '../src/daemon/repository-snapshot.js';
import {prepareRepositoryWork,queueRepositoryWork} from '../src/daemon/repository-work.js';
import {McpRegistry} from '../src/daemon/mcp-registry.js';
import {isContextOverflow,recoverOverflow} from '../src/daemon/context-budget.js';
import {formulaResults} from '../src/daemon/spreadsheet-formulas.js';

function fixture(db=':memory:'){const store=new AgentStore(db);store.createAgent({id:'bot',name:'Bot',model_id:'claude-haiku-4-5',budget_cap_usd:10,current_status:'IDLE'});return store;}
test('working-tree snapshots include edits, untracked binary and deletion, and queued bytes remain pinned',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'oh-dirty-'));const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{windowsHide:true});
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(root,'keep.txt'),'base');fs.writeFileSync(path.join(root,'deleted.txt'),'old');git('add','.');git('commit','-qm','base');
  fs.writeFileSync(path.join(root,'keep.txt'),'edited');fs.unlinkSync(path.join(root,'deleted.txt'));fs.writeFileSync(path.join(root,'image.bin'),Buffer.from([0,255,1]));fs.writeFileSync(path.join(root,'.env'),'SECRET');
  const fetcher=new RepositoryFetcher({local:{fixture:root}});const store=fixture();
  try{
    const prepared=await prepareRepositoryWork(store,fetcher,{agentId:'bot',repository:'local/fixture',workingTree:true,request:'Inspect',testCommand:'true',install:'none'},new AbortController().signal);
    assert.deepEqual(prepared.snapshot.files,{'keep.txt':'edited'});assert.equal(prepared.snapshot.binaries?.['image.bin'],'AP8B');
    queueRepositoryWork(store,prepared);fs.writeFileSync(path.join(root,'keep.txt'),'later edit');
    const saved=JSON.parse(store.getAgentData('bot',prepared.contract.repository!.snapshotKey!,'repository-snapshot')!.data_json);assert.equal(saved.files['keep.txt'],'edited');
    const firstKey=prepared.contract.repository!.snapshotKey!;
    queueRepositoryWork(store,{...prepared,target:{...prepared.target,repo:'another-alias'},snapshot:{...prepared.snapshot,commit:'e'.repeat(40)},contract:{...prepared.contract,repository:{...prepared.contract.repository!,commit:'e'.repeat(40)}}});
    assert.equal(JSON.parse(store.getAgentData('bot',firstKey,'repository-snapshot')!.data_json).commit,saved.commit,'same working bytes under a different commit must not replace the approved snapshot');
    const untracked=await fetcher.snapshot({...parseRepository('local/fixture'),workingTree:true,paths:['image.bin']},new AbortController().signal);assert.equal(untracked.binaries?.['image.bin'],'AP8B');
    assert.equal(fs.readFileSync(path.join(root,'keep.txt'),'utf8'),'later edit');
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('selected GitHub trees skip unrelated large objects and verify blob identity',async()=>{
  const data=Buffer.from('selected code'),blob=createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');const requests:string[]=[];
  const fetcher=new RepositoryFetcher({download:async url=>{requests.push(url);return Buffer.from(JSON.stringify(url.includes('/commits/')?{sha:'a'.repeat(40),commit:{tree:{sha:'b'.repeat(40)}}}:url.endsWith('/git/trees/'+'b'.repeat(40))?{tree:[{path:'huge',type:'tree',sha:'c'.repeat(40)},{path:'src',type:'tree',sha:'d'.repeat(40)}]}:url.endsWith('/git/trees/'+'d'.repeat(40))?{tree:[{path:'app.js',type:'blob',sha:blob,size:data.length,mode:'100644'}]}:{encoding:'base64',content:data.toString('base64')}));}});
  const s=await fetcher.snapshot({...parseRepository('owner/repo'),paths:['src']},new AbortController().signal);assert.deepEqual(s.files,{'src/app.js':'selected code'});assert(!requests.some(r=>r.endsWith('c'.repeat(40))));
});
test('background tasks retain checkpoints across restart, enforce ownership and require uncertain-action acknowledgement',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'oh-background-')),db=path.join(root,'state.db');let store=fixture(db);
  const parent=store.createTaskRun({agentId:'bot',taskName:'parent'});let service=new BackgroundTasks(store);const task=service.start({ownerId:'bot',parentRunId:parent.id,name:'research',request:'Research'});
  store.startTaskRun(task.runId,'claude-haiku-4-5');service.checkpoint('bot',task.id,task.runId,'Read evidence; do not resend',{'draft.md':'retained'});
  store.recordEvent({task_run_id:task.runId,agent_id:'bot',event_type:'EXTERNAL_ACTION_STARTED',payload_json:JSON.stringify({actionId:'uncertain'}),timestamp:Date.now()});store.finishTaskRun(task.runId,'CRASHED');store.close();
  store=new AgentStore(db);service=new BackgroundTasks(store);
  assert.throws(()=>service.continue('other',task.id,'Continue'),/belong/);assert.throws(()=>service.continue('bot',task.id,'Continue'),/uncertain/);
  const resumed=service.continue('bot',task.id,'I checked the action; continue without repeating it.',true);
  const work=(store.getRunDefinition(resumed.runId) as any).work;assert.deepEqual(work.questionResume.files,{'draft.md':'retained'});assert.equal(work.sponsorAgentId,'bot');assert.equal(work.delegationDepth,2);
  assert.throws(()=>service.continue('bot',task.id,'duplicate'),/existing/);store.close();fs.rmSync(root,{recursive:true,force:true});
});
test('MCP hot reload uses a new real connection, preserves quota, and retains the old connection on failure',async()=>{
  const store=fixture();const config={name:'echo',command:process.execPath,args:[path.resolve('tests/fixtures/echo-mcp-server.mjs')],callQuotaPerRun:1};const registry=new McpRegistry({agentStore:store,servers:[config],allowlist:{bot:['echo']}});
  try{await registry.start();const run=store.createTaskRun({agentId:'bot',taskName:'mcp'});await registry.call({agentId:'bot',taskRunId:run.id,server:'echo',tool:'reverse',args:{text:'before'}});
    await registry.reload([{...config,allowedTools:['reverse']}]);await assert.rejects(registry.call({agentId:'bot',taskRunId:run.id,server:'echo',tool:'reverse',args:{text:'after'}}),/quota/i);
    await assert.rejects(registry.reload([{...config,command:'nonexistent-openagents-command'}]));assert(registry.status()[0].connected);
    await registry.reload([]);assert.deepEqual(registry.status(),[]);
  }finally{await registry.stop();store.close();}
});
test('Office templates, numeric formulas and native charts produce bounded genuine document parts',async()=>{
  const book=await createDocument({path:'finance.xlsx',format:'xlsx',title:'Finance',template:'executive',rows:[['Amount'],[10],[20],[{formula:'SUM(A2:A3)*2'}]],charts:[{title:'Amounts',type:'bar',labels:['A','B'],values:[10,20]}]});
  const zip=unzipSync(book.bytes);assert.match(strFromU8(zip['xl/worksheets/sheet1.xml']),/<f>SUM\(A2:A3\)\*2<\/f><v>60<\/v>/);assert.match(strFromU8(zip['xl/charts/chart1.xml']),/<c:barChart>/);
  const xlsx=new ExcelJS.Workbook();await xlsx.xlsx.load(book.bytes as any);assert.equal(xlsx.worksheets[0].getCell('A4').result,60);
  assert.throws(()=>formulaResults([[{formula:'WEBSERVICE("https://example.com")'}]]),/Unsupported/);assert.throws(()=>formulaResults([[{formula:'A1+1'}]]),/Circular/);
  const doc=await createDocument({path:'report.docx',format:'docx',title:'Report',template:'academic',sections:[{heading:'Evidence',text:'Verified evidence'}],table:[['A','B'],['1','2']]});assert.match(strFromU8(unzipSync(doc.bytes)['word/document.xml']),/<w:tbl>/);
  const slides=await createDocument({path:'deck.pptx',format:'pptx',title:'Deck',slides:[{title:'Chart',chart:{title:'Results',type:'line',labels:['A','B'],values:[1,2]}},{title:'Comparison',bullets:['Left'],rightBullets:['Right']},{title:'Table',table:[['A','B'],['1','2']]}]});assert(unzipSync(slides.bytes)['ppt/charts/chart1.xml']);
});
test('offline OCR recognizes a real rendered image and scanned PDF',async()=>{
  const store=fixture();const thread=store.createThread({agentId:'bot'});const attachments=new Attachments(store);
  const canvas=createCanvas(1100,240),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1100,240);ctx.fillStyle='black';ctx.font='64px Arial';ctx.fillText('OPENAGENTS OFFLINE 12345',35,135);
  const png=await attachments.upload({agentId:'bot',threadId:thread.id,name:'scan.png',data:canvas.toBuffer('image/png').toString('base64')});assert.match(attachments.resolve('bot',thread.id,png.content).text,/OPENAGENTS OFFLINE 12345/);
  const jpeg=canvas.toBuffer('image/jpeg');const stream=Buffer.from('q 550 0 0 120 0 0 cm /Im0 Do Q');
  const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 550 120] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'),Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1100 /Height 240 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]),Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')])];
  let pdf=Buffer.from('%PDF-1.4\n');const offsets=[0];objects.forEach((o,i)=>{offsets.push(pdf.length);pdf=Buffer.concat([pdf,Buffer.from(`${i+1} 0 obj\n`),o,Buffer.from('\nendobj\n')]);});const xref=pdf.length;pdf=Buffer.concat([pdf,Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)]);
  const scan=await attachments.upload({agentId:'bot',threadId:thread.id,name:'scan.pdf',data:pdf.toString('base64')});assert.match(attachments.resolve('bot',thread.id,scan.content).text,/OPENAGENTS OFFLINE 12345/);store.close();
});
test('context overflow recovery preserves operator instructions and never leaves orphan tool messages',()=>{
  assert(isContextOverflow({status:400,message:'maximum context length exceeded'}));assert(!isContextOverflow({status:401,message:'unauthorized'}));
  const original='Keep the exact user requirement';const messages:any[]=[{role:'user',content:original},{role:'assistant',content:'reasoning'.repeat(1000),toolCalls:[{id:'x',name:'run',arguments:'{}'}]},{role:'tool',toolCallId:'x',content:'output'.repeat(1000)},{role:'user',content:'Preserve this steering'},{role:'assistant',content:'more reasoning'.repeat(1000)},{role:'user',content:'observation',observation:true}];
  const reduced=recoverOverflow(messages);assert.equal(reduced[0].content,original);assert(reduced.some(m=>m.content==='Preserve this steering'));assert(!reduced.some(m=>m.role==='tool'||m.toolCalls?.length));assert(JSON.stringify(reduced).length<JSON.stringify(messages).length);
});
