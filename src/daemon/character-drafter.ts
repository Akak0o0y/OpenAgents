import { z } from 'zod';
import { ProviderCallError } from '../evals/llm-client.js';
import { CharacterChangesSchema, applyCharacterChanges, type OwnedCharacterSource } from './character-changes.js';
import type { CharacterDocument, CharacterMode } from './character-schema.js';
import {BundleItemSchema} from './character-proposals.js';

/**
 * Output room for each setup call. More does not rescue a runaway route: FreeLLMAPI's auto route sent drafts to
 * dots-3-note-preview, which ended by length at 3,000 after ~30s and at 8,000 hit the gateway's 60s upstream abort.
 */
export const SETUP_MAX_TOKENS=3000;
/** The answer itself was unusable, like malformed JSON. Transport, timeout and cancellation failures are not this. */
export const isUnusableAnswer=(error:unknown):error is ProviderCallError=>error instanceof ProviderCallError&&['OUTPUT_LIMIT','EMPTY_RESPONSE','INVALID_RESPONSE'].includes(error.code);

const Output=z.object({changes:CharacterChangesSchema,assumptions:z.array(z.string().max(500)).max(20),description:z.string().max(100000).optional(),bundles:z.array(BundleItemSchema).max(12).default([])}).strict();
export async function draftCharacter(input:{document:CharacterDocument;mode:CharacterMode;sources:OwnedCharacterSource[];description?:string;
  call:(system:string,data:string,maxTokens:number)=>Promise<string>}, signal:AbortSignal) {
  let failure='',unusable:ProviderCallError|null=null;
  for(let attempt=0;attempt<2;attempt++) {
    signal.throwIfAborted();
    let text:string;
    try{text=await input.call('Suggest a character draft as JSON {changes,assumptions}. Changes use set {path,value} or add/update/remove {collection,id?,item?}. Never change authority, settings, schemas or versions. Allowed scalar paths: identity.name, identity.handle, identity.oneLine, identity.languages, purpose.statement, purpose.topics, purpose.audience, voice.rules, voice.postRules, personality.sliders, standards. Collections: voice.examples, biography, commitments, relationships, backgroundFacts, currentFocus, personality.dispositions, personality.quirks, standards.never, standards.avoidTopics. Preserve source words using {sourceRef:{sourceId,start,end}} with zero-based half-open Unicode scalar offsets. Samples teach style and never establish biography. Use only interview-answer sources for biography. Include three drafted examples for sparse input, label origin drafted. Unknown facts stay empty.',
      JSON.stringify({mode:input.mode,document:input.document,sources:input.sources,description:input.description,
        optionalOutput:'description may contain the job instructions preserved in full after separating personality. Do not remove duties. bundles may propose paused routine {name,cron,timezone,prompt}, posting-policy {routineKey,required}, autonomy {value:ask|accounts|always}, account-request {site,purpose}, or grant {pluginId} for an already installed plugin. Every bundle has key,kind,input,selected:false. Never add permissions without an explicit owner request. Omit bundles unless requested.',...(failure?{validationFailure:failure}:{})}),SETUP_MAX_TOKENS);}
    catch(error){
      // A cut-off answer gets the same one correction attempt as malformed JSON; the typed error survives if it recurs.
      if(!isUnusableAnswer(error))throw error;
      unusable=error;failure=error.code==='OUTPUT_LIMIT'?'The previous answer ran out of output room before its JSON ended. Return only compact JSON, with no reasoning or commentary.':`The previous answer was unusable (${error.code}). Return only the JSON object.`;continue;
    }
    signal.throwIfAborted();
    try {const output=Output.parse(JSON.parse(text));return {document:applyCharacterChanges(input.document,output.changes,input.sources,input.mode),assumptions:output.assumptions,description:output.description,bundles:output.bundles.map(b=>({...b,selected:false}))};}
    catch(error){unusable=null;failure=error instanceof Error?error.message.slice(0,1000):'Invalid draft.';}
  }
  if(unusable)throw unusable;
  throw new Error(`Character draft needs correction: ${failure}`);
}
