// Run Office authoring and attachment workers using the packaged Electron Node runtime and dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import { appExecutable } from './lib/app-executable.mjs';

if (process.argv[2] !== '--child') {
  const root = path.resolve(process.argv[2] ?? 'desktop/release-harness-20260919/win-unpacked');
  const result = execFileSync(appExecutable(root), [fileURLToPath(import.meta.url), '--child', path.join(root,'resources','app')], {
    encoding:'utf8',timeout:90000,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},
  });
  assert.doesNotMatch(result, /Unable to load (?:font|CMap|WASM) data/i, 'Packaged PDF assets must load without fallback warnings.');
  process.stdout.write(result);
} else {
  const root=process.argv[3];
  const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
  const {createDocument}=await load('dist/src/daemon/document-tools.js');
  const {Attachments}=await load('dist/src/daemon/attachments.js');
  const {AgentStore}=await load('dist/src/daemon/agent-store.js');
  const {createCanvas}=createRequire(path.join(root,'package.json'))('@napi-rs/canvas');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'oh-packaged-capabilities-'));
  const store=new AgentStore(path.join(profile,'state.db'));
  store.createAgent({id:'smoke',name:'Smoke',model_id:'claude-haiku-4-5',budget_cap_usd:1,current_status:'IDLE'});
  const thread=store.createThread({agentId:'smoke'});const attachments=new Attachments(store);const results=[];
  try {
    for(const format of ['docx','xlsx','pptx']){
      const spec=format==='docx'?{paragraphs:['Packaged runtime evidence']}:format==='xlsx'?{rows:[['Evidence'],['Packaged runtime evidence']]}:{slides:[{title:'Evidence',bullets:['Packaged runtime evidence']}]};
      const doc=await createDocument({path:`sample.${format}`,format,title:'Package check',...spec});
      const uploaded=await attachments.upload({agentId:'smoke',threadId:thread.id,name:doc.path,data:doc.bytes.toString('base64')});
      assert.match(attachments.resolve('smoke',thread.id,uploaded.content).text,/Packaged runtime evidence/);
      results.push({format,bytes:doc.bytes.length,extracted:true});
    }
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afoIAAAAASUVORK5CYII=';
    const uploaded=await attachments.upload({agentId:'smoke',threadId:thread.id,name:'pixel.png',data:png});
    assert.equal(attachments.resolve('smoke',thread.id,uploaded.content).images[0].data,png);
    const canvas=createCanvas(1000,200),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1000,200);ctx.fillStyle='black';ctx.font='64px Arial';ctx.fillText('OPENAGENTS OFFLINE 12345',25,120);
    const scan=await attachments.upload({agentId:'smoke',threadId:thread.id,name:'ocr.png',data:canvas.toBuffer('image/png').toString('base64')});
    assert.match(attachments.resolve('smoke',thread.id,scan.content).text,/OPENAGENTS OFFLINE 12345/);
    const rich=await createDocument({path:'rich.xlsx',format:'xlsx',title:'Rich document',template:'executive',rows:[[2],[3],[{formula:'SUM(A1:A2)'}]],charts:[{title:'Values',type:'bar',labels:['A','B'],values:[2,3]}]});
    const richFile=await attachments.upload({agentId:'smoke',threadId:thread.id,name:'rich.xlsx',data:rich.bytes.toString('base64')});assert.match(attachments.resolve('smoke',thread.id,richFile.content).text,/SUM/);
    const stream='BT /F1 12 Tf 30 100 Td (Packaged PDF evidence) Tj ET';
    const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
    const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const pdfFile=await attachments.upload({agentId:'smoke',threadId:thread.id,name:'sample.pdf',data:Buffer.from(pdf).toString('base64')});
    assert.match(attachments.resolve('smoke',thread.id,pdfFile.content).text,/Packaged PDF evidence/);
    console.log(JSON.stringify({passed:true,node:process.version,electron:process.versions.electron,platform:process.platform,results,imageWorker:true,pdfWorker:true,offlineOcr:true,richOffice:true,isolatedProfile:profile}));
  } finally {store.close();}
}
