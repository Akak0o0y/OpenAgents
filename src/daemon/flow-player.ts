import type {AgentStore} from './agent-store.js';
import {BrowserBusy,UncertainExternalEffect,type BrowserTools} from './browser-tools.js';
import {runEvents} from './external-effects.js';
import type {PublishProbe} from './publish-probes.js';
import type {PublishRecord} from './browser-publish.js';
import {FlowStore,type FlowOutcome} from './flow-store.js';
import {compileFlow} from './flow-compile.js';
import {buildComposePrompt,parseCompose,ComposeInvalid,ComposeTimeout,type ComposeInput} from './flow-compose.js';
import {FlowMiss,FlowAccountChanged,CommitRejected,CommitNotSent,type PlayStep,type PlayResult} from './flow-types.js';
export type PlayOutcome={kind:'none';reason:string}|{kind:'done';report:string;publish:PublishRecord;composeCalls:number}|
  {kind:'blocked';reason:string;composeCalls:number}|{kind:'fallback';handoff:string;composeCalls:number;atStep:number;reason:string};
export class FlowRefused extends Error {constructor(readonly reason:'busy'|'browser-unavailable'|'account'|'account-unreadable'|'rejected'|'not-sent'|'not-approved',message:string){super(message);}}
export interface FlowSpeakResult {kind:'prepared'|'none'|'held';text?:string;pick?:{id:number;href:string};reason?:string;logicalCalls:number}
export class FlowPlayer {
  constructor(private options:{store:AgentStore;browser:Pick<BrowserTools,'play'|'trace'|'publishes'>;flows:FlowStore;probes:PublishProbe[];busyWaitMs?:number;now?:()=>number}){}
  learn(input:{agentId:string;runId:string;routineId:string;flowKey:string;emit:(type:string,payload:unknown)=>void}) {
    const {browser,flows,store}=this.options,publishes=browser.publishes(input.runId);
    if(publishes.some(p=>p.state==='confirmed'&&p.confirmedBy==='response'))flows.noteResponseProof(input.agentId,input.runId);
    if(publishes.some(p=>p.by==='flow'&&p.state==='confirmed'))return {recorded:false,reason:'played-flow'};
    if(!publishes.some(p=>p.by==='model'&&p.state==='confirmed'))return {recorded:false,reason:'no-confirmed-publish'};
    const compiled=compileFlow({trace:browser.trace(input.runId),publishes,events:runEvents(store,input.runId)});
    if(compiled.ok){flows.save({...input,flow:compiled.flow,confirmedBy:compiled.confirmedBy});return {recorded:true};}
    const p=publishes.find(p=>p.state==='confirmed')!;flows.noteRejected({...input,origin:p.origin,probe:p.probe,reason:compiled.reason});return {recorded:false,reason:compiled.reason};
  }
  async play(input:{agentId:string;runId:string;routineId:string;flowKey:string;instruction:string;persona:string|null;history:string[];
    recent:{textHashes:ReadonlySet<string>;targets:ReadonlySet<string>};signal:AbortSignal;check:()=>void;beforeCommit:()=>void;
    emit:(type:string,payload:unknown)=>void;compose:(p:{systemPrompt:string;userPrompt:string;maxTokens:number})=>Promise<string>;
    speak?:(input:ComposeInput)=>Promise<FlowSpeakResult>}):Promise<PlayOutcome> {
    const {flows,browser}=this.options,record=flows.get(input.agentId,input.flowKey),flow=record?.flow;
    if(!record||record.state!=='active'||!flow||!flows.playbackEnabled(input.agentId))return {kind:'none',reason:'No active learned flow.'};
    if(record.attention)throw new FlowRefused('account','Check the bot’s signed-in account before running these learned steps.');
    const now=this.options.now??Date.now,openUntil=now()+(this.options.busyWaitMs??90000);
    let calls=0,atStep=0,typed=false,noted=false;
    const note=(outcome:FlowOutcome,reason?:string,signedIn?:string)=>{if(!noted){flows.note(record.id,input.runId,{outcome,reason,signedIn});noted=true;}};
    flows.notePlay(record.id,input.runId);
    const play=async(step:PlayStep):Promise<PlayResult>=>{
      input.check();input.signal.throwIfAborted();
      while(true)try{return await browser.play(input.agentId,input.runId,step,input.signal);}catch(error){
        if(!(error instanceof BrowserBusy)&&!(error instanceof Error&&error.name==='BrowserOpenFailed'))throw error;
        const remaining=openUntil-now();if(remaining<5000)throw new FlowRefused(error instanceof BrowserBusy?'busy':'browser-unavailable','The bot’s browser could not become available within the opening window.');
        await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(input.signal.reason);};const timer=setTimeout(()=>{input.signal.removeEventListener('abort',stop);resolve();},5000);input.signal.addEventListener('abort',stop,{once:true});});
      }
    };
    try {
      const probe=this.options.probes.find(p=>p.id===flow.probe);if(!probe)throw new FlowMiss('target','The learned site probe is unavailable.');
      const contexts:ComposeInput['contexts']=[],candidates:NonNullable<ComposeInput['candidates']>=[];
      const pick=flow.steps.find(s=>s.kind==='pick');let checkedAccount=false;
      for(let i=0;i<flow.steps.length;i++) {
        const step=flow.steps[i];if(step.kind!=='visit')break;atStep=i;
        const next=flow.steps[i+1],r=await play({kind:'visit',url:step.url,ready:step.ready,extract:{context:step.context,account:probe.account,
          ...(next?.kind==='pick'?{candidates:{container:next.container,pattern:next.pattern,max:next.max,exclude:[]}}:{})}});
        if(!checkedAccount){checkedAccount=true;if(!r.account){note('account-unreadable');throw new FlowRefused('account-unreadable','The signed-in account could not be read.');}
          if(r.account.toLowerCase()!==flow.account.toLowerCase()){note('account-mismatch',undefined,r.account);throw new FlowRefused('account','The signed-in account differs from the learned account.');}}
        if(r.context)contexts.push({url:r.url,text:r.context});if(r.candidates)candidates.push(...r.candidates);
        input.emit('FLOW_STEP',{flowId:record.id,index:i,kind:step.kind,ms:r.ms});
      }
      if(pick&&!candidates.length)throw new ComposeInvalid('no-candidates');
      const composeInput:ComposeInput={instruction:input.instruction,persona:input.persona,history:input.history,contexts,candidates,recentTextHashes:input.recent.textHashes,op:flow.op,maxWeighted:280};
      let text:string,chosen:{id:number;href:string}|undefined;
      if(input.speak){const spoken=await input.speak(composeInput);calls+=spoken.logicalCalls;
        if(spoken.kind==='none'){if(record.lastOutcome==='none')throw new ComposeInvalid('compose-none');note('none');return {kind:'blocked',reason:spoken.reason??'No suitable post.',composeCalls:calls};}
        if(spoken.kind==='held'){note('neutral','character-held');return {kind:'fallback',reason:'character-held',atStep,composeCalls:calls,handoff:'The character draft was held before submission. Take a fresh observation and prepare a new draft within the remaining run budget.'};}
        if(!spoken.text)throw new Error('Character flow did not supply text.');text=spoken.text;chosen=spoken.pick;
      }else{
        let decision:ReturnType<typeof parseCompose>|undefined,failure:string|undefined;
        for(let attempt=0;attempt<2;attempt++) {
          input.check();const prompt=buildComposePrompt(composeInput,failure);calls++;
          const raw=await input.compose(prompt);try{decision=parseCompose(raw,composeInput);break;}catch(error){if(!(error instanceof ComposeInvalid))throw error;failure=error.message;if(attempt===1)throw error;}
        }
        if(!decision)throw new ComposeInvalid('compose-invalid');
        if(decision.kind==='none'){if(record.lastOutcome==='none')throw new ComposeInvalid('compose-none');note('none');return {kind:'blocked',reason:decision.reason,composeCalls:calls};}
        text=decision.text;chosen=decision.pick;
      }
      input.emit('FLOW_COMPOSED',{flowId:record.id,calls,candidates:candidates.length,picked:chosen?.id});
      for(let i=0;i<flow.steps.length;i++) {
        const step=flow.steps[i];atStep=i;let result:PlayResult|undefined;
        if(step.kind==='visit')continue;
        if(step.kind==='pick'){if(!chosen||!candidates.some(c=>c.id===chosen!.id&&c.href===chosen!.href))throw new FlowMiss('target','The selected post was not offered.');
          result=await play({kind:'visit',url:chosen.href,ready:step.ready,pick:{container:step.container,pattern:step.pattern,max:step.max}});
        }else if(step.kind==='fill'){result=await play({kind:'fill',target:step.target,value:text,method:'fill'});typed=true;}
        else if(step.kind==='click')result=await play(step);
        else {
          const fill=flow.steps[step.readBack];if(fill?.kind!=='fill')throw new FlowMiss('target','The recorded composer is invalid.');
          const target=chosen?new URL(chosen.href).pathname.match(/\/status\/(\d+)/)?.[1]:undefined;
          const commit:PlayStep={kind:'commit',target:step.target,page:step.page,readBack:fill.target,expectText:text,inReplyTo:target,account:flow.account,probe:flow.probe};
          input.beforeCommit();
          try{result=await play(commit);}catch(error){
            if(error instanceof FlowMiss&&error.reason==='text-mismatch')await play({kind:'fill',target:fill.target,value:text,method:'insertText'});
            else if(error instanceof FlowMiss&&error.reason==='listbox')await play({kind:'press',target:fill.target,key:'Escape'});else throw error;
            input.beforeCommit();result=await play(commit);
          }
          if(!result.publish||result.publish.state!=='confirmed')throw new UncertainExternalEffect();
          note('completed');input.emit('FLOW_STEP',{flowId:record.id,index:i,kind:'commit',outcome:'confirmed'});
          const proof=result.publish.confirmedBy==='response'?`X confirmed it: ${result.publish.postUrl??result.publish.postId} (CreateTweet, HTTP ${result.publish.status??'unknown'}).`:`Checked on the page: ${result.publish.postUrl??result.publish.postId}.`;
          return {kind:'done',publish:result.publish,composeCalls:calls,report:`${chosen?`Replied to ${chosen.href}`:'Posted'} as @${flow.account}: “${text}”. ${proof} Learned steps v${record.version} from run ${record.sourceRunId}; ${calls} model call(s).`};
        }
        input.emit('FLOW_STEP',{flowId:record.id,index:i,kind:step.kind,ms:result?.ms});
      }
      throw new FlowMiss('target','Learned steps have no commit.');
    }catch(error){
      if(error instanceof FlowAccountChanged){note(error.signedIn?'account-mismatch':'account-unreadable',undefined,error.signedIn??undefined);throw new FlowRefused(error.signedIn?'account':'account-unreadable',error.message);}
      if(error instanceof FlowMiss||error instanceof ComposeInvalid||error instanceof ComposeTimeout){const reason=error instanceof FlowMiss?error.reason:error instanceof ComposeTimeout?'compose-timeout':error.message;
        note(reason==='operator'?'neutral':'miss',reason);input.emit('FLOW_FALLBACK',{flowId:record.id,atStep,reason});
        return {kind:'fallback',reason,atStep,composeCalls:calls,handoff:`Learned steps stopped before submission at step ${atStep+1}: ${reason}. ${typed?'Text may remain in the composer. Do not submit it without checking. ':''}Take a fresh browser snapshot before continuing.`.slice(0,1500)};}
      if(error instanceof CommitRejected||error instanceof CommitNotSent){note('refused',error.message);throw new FlowRefused(error instanceof CommitRejected?'rejected':'not-sent',error.message);}
      if(error instanceof UncertainExternalEffect)note('uncertain');else note('neutral',error instanceof Error?error.name:'error');throw error;
    }
  }
}
