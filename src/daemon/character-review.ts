import { z } from 'zod';
import { CharacterChangesSchema,applyCharacterChanges } from './character-changes.js';
import type { CharacterDocument,CharacterSettings } from './character-schema.js';
import { CharacterInvalidError } from './character-schema.js';
import { compileCharacterPacket } from './character-compiler.js';
import { proposalChangeHash } from './character-proposals.js';
import { normalizeClaimKey } from './character-claims.js';
import { weightedLength } from './publish-probes.js';
export const lengthBucket=(n:number):0|1|2=>n<80?0:n<160?1:2;
export interface GrowthEvidence {id:string;text:string;kind:'post'|'claim'|'edit'|'finding';voice?:number;topic?:string;
  engagement?:number|null;median?:number|null;acknowledged?:boolean;count?:number}
const outputSchema=z.object({changes:z.array(z.object({change:z.unknown(),evidenceIds:z.array(z.string().min(1)).min(1).max(8),reason:z.string().min(1).max(300)}).strict()).max(3)}).strict();
export function guardGrowth(input:{document:CharacterDocument;settings:CharacterSettings;output:unknown;evidence:GrowthEvidence[];deniedHashes:string[]}) {
  const proposed=outputSchema.parse(input.output),changes:z.infer<typeof CharacterChangesSchema>=[],reasons:string[]=[],notices:string[]=[];
  const allowed=new Set(input.settings.growth.maySuggest??[]);
  for(const entry of proposed.changes) {
    const change=CharacterChangesSchema.parse([entry.change])[0]!;
    if(change.op==='set')throw new CharacterInvalidError('Growth cannot replace document sections.');
    const path=change.collection;
    if(!allowed.has(path)&&!allowed.has(path.split('.')[0]!))throw new CharacterInvalidError('This growth section is not enabled.');
    if(!['voice.examples','voice.rules.do','voice.rules.dont','commitments','relationships','backgroundFacts','currentFocus','standards.never','standards.avoidTopics'].includes(path))throw new CharacterInvalidError('Unsupported growth change.');
    if(path.startsWith('standards.')&&change.op!=='add')throw new CharacterInvalidError('Growth can only append standards.');
    const evidence=entry.evidenceIds.map(id=>{const e=input.evidence.find(e=>e.id===id);if(!e)throw new CharacterInvalidError('Unknown growth evidence.');return e;});
    if(path.startsWith('voice.rules.')&&(change.op!=='add'||!evidence.some(e=>e.kind==='finding'&&(e.count??0)>=2)))throw new CharacterInvalidError('New voice rules need repeated review findings.');
    const item=change.item as Record<string,unknown>|undefined;
    if(path==='commitments') {
      if(item?.importance==='core'||input.document.commitments.some(c=>c.id===change.id&&c.importance==='core'))throw new CharacterInvalidError('Growth cannot change core commitments.');
      if(!evidence.some(e=>e.kind==='claim'&&e.acknowledged))throw new CharacterInvalidError('A stance update needs an acknowledged change.');
    }
    if(path==='voice.examples') {
      if(change.op!=='add'||!item)throw new CharacterInvalidError('Growth cannot replace or retire examples.');
      const post=evidence.find(e=>e.kind==='post'&&e.text===item.text&&(e.voice??0)>=4);
      if(!post)throw new CharacterInvalidError('Promotion needs the exact confirmed text and a voice score of at least four.');
      if(post.engagement!=null&&post.median!=null&&post.engagement<post.median)throw new CharacterInvalidError('Post engagement is below the comparable-age median.');
      if(post.engagement==null||post.median==null)notices.push('No engagement data; promotion uses voice evidence only.');
      change.item={...item,origin:'promoted',pinned:false,sourceId:undefined};
    }
    if(path==='backgroundFacts'&&(!item||!evidence.some(e=>e.kind==='claim'&&e.text===item.text)))throw new CharacterInvalidError('Adoption must copy the evidenced claim exactly.');
    changes.push(change);reasons.push(entry.reason);
  }
  const hash=proposalChangeHash(changes);
  if(input.deniedHashes.includes(hash))throw new CharacterInvalidError('These growth changes were recently declined.');
  const document=applyCharacterChanges(input.document,changes,[],input.settings.mode);
  // applyCharacterChanges labels free-form setup examples drafted. Growth promotions have stronger provenance.
  for(const c of changes)if(c.op==='add'&&c.collection==='voice.examples'){
    const item=c.item as {text:string};const ex=document.voice.examples.find(e=>e.text===item.text&&!input.document.voice.examples.some(old=>old.id===e.id));if(ex)ex.origin='promoted';
  }
  if(changes.some(c=>c.op==='add'&&c.collection==='voice.examples')) {
    const examples=document.voice.examples,openings=new Set(examples.map(e=>normalizeClaimKey(e.text).split(/\s+/u).slice(0,3).join(' ')));
    const buckets=new Set(examples.map(e=>lengthBucket(weightedLength(e.text))));
    const topics=new Set(examples.map(e=>input.evidence.find(p=>p.kind==='post'&&p.text===e.text)?.topic??e.tags.find(t=>input.document.purpose.topics.includes(t))??'other'));
    if(examples.length<3||openings.size<3||buckets.size<2||topics.size<2)throw new CharacterInvalidError('Not enough diverse promotion evidence yet.');
  }
  for(const surface of ['owner-chat','task-loop','public-compose','public-review'] as const)compileCharacterPacket({document,settings:input.settings,surface});
  return {document,changes,changeHash:hash,reasons,notices};
}
