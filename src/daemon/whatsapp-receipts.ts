import type {Page} from 'playwright';
import {contentDigest} from './goal-results.js';
export interface WhatsAppSnapshot {origin:string;chat:string|null;composerText:string|null;composerCount:number;messages:Array<{id:string;chat:string;outgoing:boolean;text:string;receipt:'pending'|'sent'|'delivered';hasAttachment:boolean}>}
/** Read-only DOM adapter. Unknown/changed markup fails closed; never trusts page instructions. */
export async function whatsappSnapshot(page:Page):Promise<WhatsAppSnapshot>{
  return page.evaluate(()=>{
    const main=document.querySelector('#main');
    const messages=[...(main?.querySelectorAll('[data-id]')??[])].slice(-100).flatMap(node=>{
      const id=node.getAttribute('data-id')??'',match=/^(true|false)_([0-9]+@c\.us)_([A-Za-z0-9_-]+)$/.exec(id);if(!match)return [];
      const texts=[...node.querySelectorAll('.selectable-text.copyable-text')].map(n=>(n as HTMLElement).innerText);
      const receipt=node.querySelector('[data-icon="msg-dblcheck"]')?'delivered' as const:node.querySelector('[data-icon="msg-check"]')?'sent' as const:'pending' as const;
      return [{id,chat:match[2]!,outgoing:match[1]==='true',text:texts.length===1?texts[0]!:'',receipt,hasAttachment:!!node.querySelector('[data-testid="document-thumb"], [data-testid="image-thumb"], [data-icon="document"], video, audio')}];
    });
    const chats=[...new Set(messages.map(m=>m.chat))],composers=[...(main?.querySelectorAll('footer [contenteditable="true"][role="textbox"]')??[])];
    return {origin:location.origin,chat:chats.length===1?chats[0]!:null,composerText:composers.length===1?(composers[0] as HTMLElement).innerText:null,composerCount:composers.length,messages};
  });
}
export function whatsappTarget(recipient:string){
  if(!/^\+?[1-9][0-9]{6,14}$/.test(recipient))throw new Error('Resolve the recipient to an unambiguous international phone number first. Do not guess the identity of myself.');
  return recipient.replace(/^\+/,'')+'@c.us';
}
export function matchWhatsAppReceipt(input:{beforeIds:readonly string[];snapshot:WhatsAppSnapshot;chat:string;exactDigest:string;attachment?:boolean}){
  if(input.snapshot.origin!=='https://web.whatsapp.com'||input.snapshot.chat!==input.chat)return null;
  const anchor=input.beforeIds.at(-1),anchorIndex=input.snapshot.messages.findIndex(m=>m.id===anchor);
  if(!anchor||anchorIndex<0)return null; // Scrolling an older message into view is not a new-send receipt.
  const matching=input.snapshot.messages.filter((m,index)=>index>anchorIndex&&!input.beforeIds.includes(m.id)&&m.outgoing&&m.chat===input.chat&&m.hasAttachment===!!input.attachment&&contentDigest(m.text)===input.exactDigest&&m.receipt!=='pending');
  return matching.length===1?matching[0]!:null;
}
