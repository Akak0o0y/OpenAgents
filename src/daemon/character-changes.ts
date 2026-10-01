import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { CharacterInvalidError, validateCharacterDocument, type CharacterDocument, type CharacterMode } from './character-schema.js';

const paths = ['identity.name','identity.handle','identity.oneLine','identity.languages','purpose.statement','purpose.topics','purpose.audience',
  'voice.rules','voice.postRules','personality.sliders','personality.dispositions','personality.quirks','standards'] as const;
const collections = ['voice.examples','voice.rules.do','voice.rules.dont','biography','commitments','relationships','backgroundFacts','currentFocus','personality.dispositions','personality.quirks','standards.never','standards.avoidTopics'] as const;
export const CharacterChangesSchema = z.array(z.discriminatedUnion('op',[
  z.object({op:z.literal('set'),path:z.enum(paths),value:z.unknown()}).strict(),
  ...(['add','update','remove'] as const).map(op=>z.object({op:z.literal(op),collection:z.enum(collections),id:z.string().max(200).optional(),item:z.unknown().optional()}).strict()),
])).max(40);
export type OwnedCharacterSource = {id:string;kind:string;text:string};
export function resolveSourceSpan(text:string,start:number,end:number,cap:number):string {
  const points=Array.from(text);
  if(![start,end,cap].every(Number.isSafeInteger)||start<0||end<start||end>points.length||cap<0) throw new CharacterInvalidError('invalid-source-span');
  if(end-start>cap) throw new CharacterInvalidError('source-too-long');
  return points.slice(start,end).join('');
}
export function applyCharacterChanges(document:CharacterDocument, input:unknown, sources:readonly OwnedCharacterSource[], mode:CharacterMode) {
  const changes=CharacterChangesSchema.parse(input), result=structuredClone(document) as any;
  const rejectKeys=(value:unknown):void=>{
    if(value&&typeof value==='object') for(const [k,v] of Object.entries(value)) {
      if(['__proto__','prototype','constructor'].includes(k)) throw new CharacterInvalidError('Unsupported object key.'); rejectKeys(v);
    }
  };
  rejectKeys(input);
  const locate=(path:string)=>{const keys=path.split('.'),key=keys.pop()!;let parent=result;for(const k of keys)parent=parent[k];if(!parent)throw new CharacterInvalidError('Unknown document path.');return {parent,key};};
  const resolve=(item:any,collection:string):any=>{
    if(!item||typeof item!=='object') return item;
    if(Array.isArray(item)) return item.map(v=>resolve(v,collection));
    if('sourceRef' in item) {
      const ref=z.object({sourceId:z.string(),start:z.number().int().nonnegative(),end:z.number().int().nonnegative()}).strict().parse(item.sourceRef);
      if(Object.keys(item).length!==1) throw new CharacterInvalidError('A source reference cannot carry replacement text.');
      const s=sources.find(s=>s.id===ref.sourceId); if(!s)throw new CharacterInvalidError('Unknown or foreign source.');
      if(collection==='biography'&&s.kind!=='interview-answer')throw new CharacterInvalidError('Samples do not establish biography.');
      return resolveSourceSpan(s.text,ref.start,ref.end,collection==='voice.examples'?600:collection==='biography'?700:collection==='standards.avoidTopics'?80:120);
    }
    return Object.fromEntries(Object.entries(item).map(([k,v])=>[k,resolve(v,collection)]));
  };
  for(const c of changes) {
    const path=c.op==='set'?c.path:c.collection, {parent,key}=locate(path);
    if(c.op==='set'){parent[key]=resolve(c.value,path);continue;}
    const list=parent[key];if(!Array.isArray(list))throw new CharacterInvalidError('Collection is not an array.');
    const scalar=path.startsWith('standards.')||path.startsWith('voice.rules.')||path==='personality.quirks'||list.some((v:unknown)=>typeof v==='string');
    const ids=list.map((v:any,i:number)=>scalar?`${path}:${i}`:v.id);
    const index=c.id?ids.indexOf(c.id):-1;
    if(c.op!=='add'&&index<0)throw new CharacterInvalidError('Unknown proposal item ID.');
    if(c.op==='remove'){list.splice(index,1);continue;}
    if(path==='biography'&&(!c.item||typeof c.item!=='object'||!('text' in c.item)||!c.item.text||typeof c.item.text!=='object'||!('sourceRef' in c.item.text)))throw new CharacterInvalidError('Biography must cite an owner answer.');
    let item=resolve(c.item,path);
    if(path==='voice.examples'&&item&&typeof item==='object'){
      const ref=(c.item as any)?.text?.sourceRef;
      item={...item,origin:ref?'owner':'drafted',...(ref?{sourceId:ref.sourceId}:{})};
    }
    if(item===undefined)throw new CharacterInvalidError('Missing collection item.');
    if(!scalar){if(!item||typeof item!=='object'||Array.isArray(item))throw new CharacterInvalidError('Invalid collection item.');item={...item,id:c.op==='add'?(c.id??randomUUID()):c.id};}
    if(c.op==='add'){if(c.id&&ids.includes(c.id))throw new CharacterInvalidError('Duplicate item ID.');list.push(item);}else list[index]=scalar?item:{...list[index],...item};
  }
  return validateCharacterDocument(result,mode);
}
