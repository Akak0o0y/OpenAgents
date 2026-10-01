import { batchCharacterPreview } from './character-batch-preview.js';
import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentStore } from './agent-store.js';
import type { CharacterStore } from './character-store.js';
import type { CharacterProposals } from './character-proposals.js';
import type { RunCapacity } from './run-capacity.js';
import type { CostLedger } from '../kernel/cost-ledger.js';
import { ProviderCallError, type ILLMClient } from '../evals/llm-client.js';
import { BudgetExceededError } from '../kernel/cost-ledger.js';
import type { ProviderRouter } from './provider-router.js';
import { modelRoute } from './provider-connections.js';
import { oneShotCall } from './one-shot-call.js';
import { prepareCharacterDraft } from './character-preview.js';
import { draftCharacter } from './character-drafter.js';
import { resolveReviewer, ReviewOutputSchema } from './character-speaker.js';
import { compileCharacterPacket } from './character-compiler.js';
import { checkCharacterRules } from './character-rules.js';
import { CharacterBusyError, CharacterInvalidError } from './character-schema.js';

export const ProposeCharacterSchema=z.object({tool:z.literal('propose_character'),step:z.enum(['start','propose']),mode:z.enum(['voice','character']).optional(),depth:z.enum(['quick','interview']).optional()}).strict();
const interviewGroups=[
  ['What should this bot do, and for whom?','Which languages and tone should it use?','Paste a few writing samples, or skip them.'],
  ['What background should this character have? Say which details are fictional.','Which beliefs should stay stable?','What should it never say or do?'],
  ['How should it respond to disagreement and uncertainty?','What should its relationships and current focus be?'],
];
interface InterviewState {group:number;waiting:boolean;sources:Array<{id:string;kind:'sample'|'interview-answer';text:string}>;lastAnswer:string|null}
const IDS=['post','reply','chat','unsupported-claim','empty-challenge'] as const;
const batch=z.array(z.object({id:z.enum(IDS),text:z.string().min(1).max(1000)}).strict()).length(5)
  .refine(a=>new Set(a.map(v=>v.id)).size===5,'Every preview ID must occur once.');
const reviewBatch=z.array(z.object({id:z.enum(IDS),review:ReviewOutputSchema}).strict()).length(5)
  .refine(a=>new Set(a.map(v=>v.id)).size===5,'Every review ID must occur once.');
/**
 * Draft, previews and review in one window. A free reasoning route answers at roughly 100 tokens/s, so three calls
 * need more than two minutes; the parent run's deadline still bounds it.
 */
const SETUP_WINDOW_MS=300_000;
const providerReasons:Record<ProviderCallError['code'],string>={OUTPUT_LIMIT:'the model ran out of output room before finishing',
  EMPTY_RESPONSE:'the model returned no answer',INVALID_RESPONSE:'the model returned an unreadable answer',TIMEOUT:'the model did not answer in time',
  CANCELLED:'the request was cancelled',NETWORK:'the model provider could not be reached',HTTP_ERROR:'the model provider refused the request',
  CONNECTION_UNAVAILABLE:'the model connection is unavailable',IDENTITY_UNVERIFIED:'the model provider could not be verified'};
/** Setup stopped before any proposal existed. `cause` keeps the typed original. */
export class CharacterSetupError extends Error {
  override readonly name='CharacterSetupError';
  constructor(readonly code:string,readonly reason:string,options:{cause:unknown}){super(`Character setup did not complete: ${reason} (${code}).`,options);}
}
/** Why setup failed, in words the owner and the chat model can act on. Never includes model output. */
export function setupFailure(error:unknown):{code:string;reason:string}{
  if(error instanceof CharacterSetupError)return {code:error.code,reason:error.reason};
  if(error instanceof ProviderCallError)return {code:error.code,reason:providerReasons[error.code]};
  if(error instanceof BudgetExceededError)return {code:'BUDGET',reason:'the bot budget does not cover the setup calls'};
  if(error instanceof CharacterBusyError)return {code:'BUSY',reason:error.message};
  if(error instanceof CharacterInvalidError)return {code:'INVALID',reason:error.message.slice(0,300)};
  if(error instanceof Error&&error.message.startsWith('Character draft needs correction'))return {code:'DRAFT_INVALID',reason:'the drafted character failed validation twice'};
  return {code:'FAILED',reason:(error instanceof Error?error.message:String(error)).slice(0,300)};
}
export class CharacterSetup {
  constructor(private options:{store:AgentStore;characters:CharacterStore;proposals:CharacterProposals;capacity:RunCapacity;ledger:CostLedger;llm:ILLMClient;providerRouter?:ProviderRouter}){}
  private interview(agentId:string,request:string,history:readonly {role:string;content:string}[]) {
    const row=this.options.store.getAgentData(agentId,'setup-interview','character');if(!row)return null;const state=JSON.parse(row.data_json) as InterviewState;
    const group=interviewGroups[state.group],hash=createHash('sha256').update(request).digest('hex');
    // Only bind an owner response after the assistant actually displayed this server-issued group.
    const lastAssistant=[...history].reverse().find(m=>m.role==='assistant')?.content??'';
    if(state.waiting&&group&&hash!==state.lastAnswer&&group.every(q=>lastAssistant.includes(q))){
      if(Array.from(request).length>4000)throw new CharacterInvalidError('Interview answers must fit 4,000 characters.');
      state.sources.push({id:`draft:interview-${state.group}`,kind:state.group===0?'sample':'interview-answer',text:request});state.group++;state.waiting=false;state.lastAnswer=hash;
      this.options.store.setAgentData({agentId,category:'character',key:'setup-interview',data:state});
    }return state;
  }
  start(input?:{agentId:string;depth?:'quick'|'interview';request:string;history:readonly {role:string;content:string}[]}){
    if(input?.depth==='interview'){
      const state=this.interview(input.agentId,input.request,input.history)??{group:0,waiting:false,sources:[],lastAnswer:null};
      const questions=interviewGroups[state.group]??[];state.waiting=questions.length>0;
      this.options.store.setAgentData({agentId:input.agentId,category:'character',key:'setup-interview',data:state});
      return {status:'ok',summary:questions.length?'Ask this group verbatim, then wait for the owner. Call start with depth interview after their answer. They may skip or request a draft at any time.':'Interview complete. Call propose to create the approval card.',questions,asked:Math.min(8,interviewGroups.slice(0,state.group+1).flat().length)};
    }
    return {status:'ok',summary:'Create a draft for owner approval. Quick setup is the default; ask at most one optional question. For an owner-requested interview call start with depth interview. Samples teach style only. Call propose when ready. No settings have changed.',modes:['voice','character']};
  }
  async propose(input:{agentId:string;parentRunId:string;deadlineAt:number;mode:'voice'|'character';request:string;history:readonly {role:string;content:string}[];signal:AbortSignal}) {
    const {store,characters,proposals,capacity,ledger,llm}=this.options;
    const base=prepareCharacterDraft(store,characters,input.agentId),runId=`character-setup-${randomUUID()}`;
    const release=capacity.acquireChild(input.parentRunId,runId);if(!release)throw new CharacterBusyError('A character preview is already using this work slot.');
    const signal=AbortSignal.any([input.signal,AbortSignal.timeout(Math.max(1,Math.min(SETUP_WINDOW_MS,input.deadlineAt-Date.now())))]);
    let calls=0,knownUsd=0,unknownCalls=0,inputTokens=0,outputTokens=0;
    try {
      store.createTaskRun({id:runId,agentId:input.agentId,taskName:'Character setup previews (unsent)',modelId:base.agent.model_id});
      store.startTaskRun(runId,base.agent.model_id,{executor:'character-preview',origin:'setup-child',parentRunId:input.parentRunId});
      const call=async(systemPrompt:string,userPrompt:string,maxTokens:number,reviewing=false)=>{
        signal.throwIfAborted();if(calls>=4)throw new CharacterInvalidError('Setup call limit reached.');
        const reviewer=resolveReviewer(base.agent,base.settings), modelId=reviewing?reviewer.modelId:base.agent.model_id;
        const route=modelRoute(store,{...base.agent,model_id:modelId,connection_id:reviewing?reviewer.connectionId:base.agent.connection_id});
        if(this.options.providerRouter&&!this.options.providerRouter.canSchedule(route.key).allowed)throw new CharacterBusyError('Selected model unavailable.');
        const result=await oneShotCall({ledger,llm,taskId:runId,agentId:input.agentId,modelId,budgetCapUsd:store.getAgent(input.agentId)!.budget_cap_usd,
          route,systemPrompt,userPrompt,maxTokens,signal,purpose:reviewing?'character-setup-review':'character-setup',
          emit:(type,payload)=>store.recordEvent({task_run_id:runId,agent_id:input.agentId,model_id:modelId,event_type:type,payload_json:JSON.stringify(payload),timestamp:Date.now()}),onAccounting:a=>{
            calls+=a.usage.logicalCalls;knownUsd+=a.usage.costUsd??0;unknownCalls+=a.usage.costUsd===null?a.usage.logicalCalls:0;
            inputTokens+=a.usage.inputTokens;outputTokens+=a.usage.outputTokens;store.updateTaskRunProgress(runId,calls,knownUsd,0);
          }});return result.content;
      };
      // The model cannot substitute its own purported owner evidence.
      const sources=[...input.history.filter(m=>m.role==='user').slice(-8).map(m=>m.content),input.request]
        .map((text,i)=>({id:`draft:owner-${i}`,kind:'sentence' as const,text}));
      const interview=this.interview(input.agentId,input.request,input.history),allSources=[...sources,...(interview?.sources??[])];
      const drafted=await draftCharacter({document:base.document,mode:input.mode,sources:allSources,description:base.agent.system_prompt??'',call},signal);
      const settings={...base.settings,mode:input.mode};
      const previews=await batchCharacterPreview({document:drafted.document,settings,seed:runId,call,signal});
      signal.throwIfAborted();
      const proposal=proposals.create({agentId:input.agentId,runId:input.parentRunId,value:{draft:{document:drafted.document,settings,
        sources:allSources.map(s=>({handle:s.id,kind:s.kind,text:s.text}))},bundles:drafted.bundles,assumptions:drafted.assumptions,
        ...(drafted.description!==undefined?{description:drafted.description,descriptionSelected:false}:{})},previews});
      store.finishTaskRun(runId,'COMPLETED',undefined,{unsent:true,proposalId:proposal.proposalId});
      return {proposal,runId,usage:{logicalCalls:calls,knownUsd,unknownCalls,inputTokens,outputTokens}};
    }catch(error){
      const windowClosed=signal.aborted&&!input.signal.aborted,failure=windowClosed?{code:'TIMEOUT',reason:'the setup window closed'}:setupFailure(error);
      if(store.getTaskRun(runId)?.status==='RUNNING')store.finishTaskRun(runId,signal.aborted?'ABORTED':'FAILED',`Character setup did not complete: ${failure.reason} (${failure.code}).`);
      throw input.signal.aborted?error:new CharacterSetupError(failure.code,failure.reason,{cause:error});
    }
    finally{release();}
  }
}
