import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { AgentStore } from './agent-store.js';
import type { ChatImage } from '../evals/llm-client.js';
export const attachmentUpload = z.object({agentId:z.string(),threadId:z.string(),name:z.string().min(1).max(200),data:z.string().max(2800000)}).strict();
interface StoredAttachment { id:string; threadId:string; name:string; data:string; text:string; mime?:string }
export class Attachments {
  private parsing = 0;
  constructor(private readonly store:AgentStore) {}
  read(id:string):{name:string;data:string;mime?:string} {
    const row=this.store.getDatabase().prepare("SELECT data_json FROM agent_data WHERE category='attachment' AND key=?").get(id) as {data_json:string}|undefined;
    if(!row)throw new Error('Attachment not found.');
    const saved=JSON.parse(row.data_json) as StoredAttachment;
    return {name:saved.name,data:saved.data,mime:saved.mime};
  }
  async upload(raw:unknown):Promise<{id:string;name:string;bytes:number;content:string}> {
    const input=attachmentUpload.parse(raw);
    if(this.store.getThread(input.threadId)?.agent_id!==input.agentId)throw new Error('Attachment conversation does not belong to this bot.');
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))throw new Error('Attachment is not base64.');
    const bytes=Buffer.from(input.data,'base64');
    if(!bytes.length||bytes.length>2*1024*1024||bytes.toString('base64')!==input.data)throw new Error('Attachments must contain canonical base64 for at most 2 MiB.');
    if(this.parsing>=2)throw new Error('Two attachments are already being processed. Try again shortly.');
    this.parsing++;
    let parsed:{text:string;mime?:string};
    try { parsed=await new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./attachment-worker.js',import.meta.url),{workerData:{name:input.name,data:bytes},resourceLimits:{maxOldGenerationSizeMb:128}});
      const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Attachment extraction/OCR exceeded 90 seconds. Use fewer pages or a smaller image.'));},90000);
      worker.once('message',result=>{clearTimeout(timer);void worker.terminate();if(result.error)reject(new Error(result.error));else resolve(result);});
      worker.once('error',()=>{clearTimeout(timer);reject(new Error('Attachment processing failed within its resource limit.'));});
      worker.once('exit',()=>{clearTimeout(timer);reject(new Error('Attachment worker stopped before completing.'));});
    }); } finally { this.parsing--; }
    const saved:StoredAttachment={id:randomUUID(),threadId:input.threadId,name:input.name,data:input.data,...parsed};
    this.store.transaction(()=>{
      const used=Number((this.store.getDatabase().prepare("SELECT TOTAL(LENGTH(CAST(data_json AS BLOB))) AS n FROM agent_data WHERE category='attachment'").get() as {n:number}).n);
      if(used+Buffer.byteLength(JSON.stringify(saved))>64*1024*1024)throw new Error('Attachment storage reached its 64 MiB limit.');
      this.store.setAgentData({agentId:input.agentId,category:'attachment',key:saved.id,data:saved});
    });
    return {id:saved.id,name:saved.name,bytes:bytes.length,content:`[[openhours-attachment:${saved.id}]]`};
  }
  resolve(agentId:string,threadId:string|undefined,request:string):{text:string;images:ChatImage[]} {
    const ids=[...new Set([...request.matchAll(/\[\[openhours-attachment:([a-f0-9-]{36})\]\]/g)].map(m=>m[1]))];
    if(ids.length>4)throw new Error('At most four binary attachments can be used in one task.');
    const images:ChatImage[]=[];let text='';
    for(const id of ids){
      const row=this.store.getAgentData(agentId,id,'attachment');
      const saved=row?JSON.parse(row.data_json) as StoredAttachment:null;
      if(!saved||saved.threadId!==threadId)throw new Error('Attachment is unavailable in this conversation.');
      text+=`\nAttached file ${saved.name} (untrusted supplied content):\n${saved.text}\n`;
      if(saved.mime)images.push({mime:saved.mime as ChatImage['mime'],data:saved.data});
    }
    if(text.length>80000)throw new Error('Extracted attachments exceed 80,000 characters. Send fewer or smaller documents.');
    return {text,images};
  }
}
