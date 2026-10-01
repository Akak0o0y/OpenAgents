import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';

const id=z.string().min(1).max(200),digest=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().nonnegative().nullable();
export const ModelUsageSchema=z.object({inputTokens:count,outputTokens:count,encoderTokens:count,cachedInputTokens:count,wireAttempts:count,
  costUsd:z.number().finite().nonnegative().nullable(),source:z.enum(['provider','gateway','tokenizer','estimated','unknown']),tokenizer:id.nullable()}).strict();
export type ModelUsage=z.infer<typeof ModelUsageSchema>;
export const unknownUsage=():ModelUsage=>({inputTokens:null,outputTokens:null,encoderTokens:null,cachedInputTokens:null,wireAttempts:null,costUsd:null,source:'unknown',tokenizer:null});
export const CandidateSchema=z.object({id,tool:id,args:z.record(z.unknown()),target:id,preconditionDigest:digest,expectedEffect:z.string().min(1).max(1000),risk:z.enum(['read','reversible','external'])}).strict();
export const DecisionSchema=z.object({schema:z.literal('decision/1'),agentId:id,runId:id,decisionId:id,subgoalId:id,family:id,language:id,
  observationId:id,observedAt:z.number().int().nonnegative(),stateDigest:digest,goalRevision:z.number().int().positive(),
  context:z.string().max(24000),candidates:z.array(CandidateSchema).min(1).max(32)}).strict().superRefine((r,c)=>{
    if(new Set(r.candidates.map(v=>v.id)).size!==r.candidates.length||r.candidates.some(v=>v.id==='escalate'))c.addIssue({code:'custom',message:'Candidate IDs must be unique and not reserved.'});
  });
export type Decision=z.infer<typeof DecisionSchema>;
export const SelectionSchema=z.object({schema:z.literal('selection/1'),requestDigest:digest,candidateId:id,
  score:z.number().finite().min(0).max(1),modelRevision:id,usage:ModelUsageSchema,truncated:z.boolean()}).strict();
export type Selection=z.infer<typeof SelectionSchema>;
/** Scores are candidate-relative measurements, never authorization or calibrated success probabilities. */
export interface DecisionScorer {readonly identity:string;readonly placement:'local'|'hosted';score(request:Decision,signal:AbortSignal):Promise<Selection>}
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
export const decisionDigest=(request:Decision)=>createHash('sha256').update(canonical(request)).digest('hex');

/** Contract endpoint, not a model-specific API. A server adapter must map Laya/CLM into selection/1. */
export class HttpDecisionScorer implements DecisionScorer {
  readonly identity:string;readonly placement:'local'|'hosted';private url:URL;
  constructor(private options:{url:string;identity:string;placement:'local'|'hosted';token?:()=>Promise<string>}){
    this.identity=options.identity;this.placement=options.placement;this.url=new URL(options.url);
    const loopback=['localhost','127.0.0.1','[::1]'].includes(this.url.hostname);
    if(this.url.username||this.url.password||this.url.search||this.url.hash||!['http:','https:'].includes(this.url.protocol)||(!loopback&&this.url.protocol!=='https:')||(options.placement==='local'&&!loopback))throw new Error('Use a configured HTTPS hosted endpoint or loopback local endpoint.');
  }
  async score(request:Decision,signal:AbortSignal){
    const token=await this.options.token?.();signal.throwIfAborted();
    const response=await fetch(this.url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(DecisionSchema.parse(request)),signal});
    if(!response.ok)throw new Error(`Decision endpoint returned HTTP ${response.status}.`);
    if(!response.body)throw new Error('Missing decision response.');
    const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
    try {for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>65536)throw new Error('Decision response exceeds limit.');chunks.push(next.value);}}
    finally{await reader.cancel().catch(()=>{});}
    return SelectionSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
}

export interface DecisionRecord {id:string;agentId:string;runId:string;decisionId:string;requestDigest:string;scorer:string;placement:'local'|'hosted';mode:'shadow'|'qualified';
  candidateId:string|null;accepted:boolean;reason:string;durationMs:number;usage:ModelUsage;at:number}
export interface DecisionCertificate {identity:string;policyVersion:string;family:string;language:string;expiresAt:number;minScore:number;maxObservationAgeMs:number;
  certificationSha256:string;independent:boolean;synthetic:boolean;allowedTools:readonly string[]}
const CertificateSchema=z.object({identity:id,policyVersion:id,family:id,language:id,expiresAt:z.number().int().positive(),minScore:z.number().finite().min(0).max(1),maxObservationAgeMs:z.number().int().positive().max(10000),certificationSha256:digest,independent:z.literal(true),synthetic:z.literal(false),allowedTools:z.array(id).min(1).max(32)}).strict();
function freeze<T>(value:T):T {if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function readOnly(candidate:z.infer<typeof CandidateSchema>){
  if(candidate.risk!=='read')return false;
  if(candidate.tool==='browser')return ['snapshot','screenshot','tabs'].includes(String(candidate.args.action));
  if(candidate.tool==='computer')return ['screenshot','windows'].includes(String(candidate.args.action));
  return ['read','list','glob','grep','source','recall','result_status'].includes(candidate.tool);
}

/** One scorer attempt per observed subgoal; timeouts keep their physical slot until settlement. */
export class CombinedDecisionController {
  private busy=false;private seen=new Set<string>();private progress=new Map<string,{digest:string;repeats:number}>();
  constructor(private options:{scorer:DecisionScorer;mode:'shadow'|'qualified';policyVersion:string;timeoutMs:number;maxCalls:number;certificate?:DecisionCertificate;record:(record:DecisionRecord)=>void}){
    if(!Number.isSafeInteger(options.maxCalls)||options.maxCalls<1||options.maxCalls>10000||!Number.isFinite(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>10000)throw new Error('Scorer calls and timeout must be explicitly bounded.');
  }
  async choose(input:Decision,signal:AbortSignal,current:()=>{stateDigest:string;goalRevision:number}):Promise<z.infer<typeof CandidateSchema>|null>{
    const request=freeze(DecisionSchema.parse(input)),key=`${request.agentId}:${request.runId}:${request.subgoalId}:${request.observationId}`;
    signal.throwIfAborted();
    if(this.busy||this.seen.has(key)||this.seen.size>=this.options.maxCalls)return null;
    const progressKey=`${request.agentId}:${request.runId}:${request.subgoalId}`,prior=this.progress.get(progressKey);
    const repeats=prior?.digest===request.stateDigest?prior.repeats+1:0;this.progress.set(progressKey,{digest:request.stateDigest,repeats});
    if(repeats>=2)return null;
    this.seen.add(key);this.busy=true;
    const started=performance.now(),hash=decisionDigest(request),controller=new AbortController();
    const deadline=setTimeout(()=>controller.abort(new Error('Scorer deadline exceeded.')),Math.min(10000,Math.max(1,this.options.timeoutMs)));
    const combined=AbortSignal.any([signal,controller.signal]);let result:Selection|undefined,reason='scorer-failed',accepted=false;
    const pending=Promise.resolve().then(()=>this.options.scorer.score(request,combined));
    const released=pending.finally(()=>{this.busy=false;});released.catch(()=>{});
    let onAbort:()=>void=()=>{};
    try{
      result=SelectionSchema.parse(await Promise.race([pending,new Promise<never>((_,reject)=>{onAbort=()=>reject(combined.reason);combined.addEventListener('abort',onAbort,{once:true});if(combined.aborted)onAbort();})]));
      const selected=request.candidates.find(c=>c.id===result!.candidateId),certificate=this.options.certificate,live=current();
      if(result.requestDigest!==hash||result.modelRevision!==this.options.scorer.identity)reason='identity-or-request-mismatch';
      else if(result.truncated)reason='truncated-state';
      else if(result.candidateId==='escalate')reason='abstained';
      else if(!selected)reason='invalid-candidate';
      else if(live.stateDigest!==request.stateDigest||live.goalRevision!==request.goalRevision)reason='stale-state';
      else if(this.options.mode==='shadow')reason='shadow-only';
      else if(!certificate||!CertificateSchema.safeParse(certificate).success||certificate.identity!==result.modelRevision||certificate.policyVersion!==this.options.policyVersion||certificate.family!==request.family||certificate.language!==request.language||certificate.expiresAt<=Date.now())reason='unqualified';
      else if(selected.preconditionDigest!==request.stateDigest)reason='stale-candidate';
      else if(!readOnly(selected)||!certificate.allowedTools.includes(selected.tool))reason='ineligible-action';
      else if(Date.now()-request.observedAt>Math.min(10000,certificate.maxObservationAgeMs)||request.observedAt>Date.now())reason='stale-observation';
      else if(result.score<certificate.minScore)reason='below-threshold';
      else {accepted=true;reason='selected';}
      // The caller must still pass this immutable proposal through its existing tool/permission dispatcher.
      return accepted?selected!:null;
    }catch{reason=combined.aborted?'cancelled-or-timeout':'scorer-failed';return null;}
    finally{clearTimeout(deadline);combined.removeEventListener('abort',onAbort);this.options.record({id:randomUUID(),agentId:request.agentId,runId:request.runId,decisionId:request.decisionId,requestDigest:hash,scorer:this.options.scorer.identity,placement:this.options.scorer.placement,mode:this.options.mode,candidateId:result?.candidateId??null,accepted,reason,durationMs:performance.now()-started,usage:result?.usage??unknownUsage(),at:Date.now()});}
  }
}

/** Frozen measurements choose between explicitly permitted endpoints; never probe production effects. */
export function selectMeasuredScorer(candidates:Array<{scorer:DecisionScorer;eligible:boolean;verifiedSuccessLowerBound:number;p95Ms:number;qualityTarget:number}>) {
  return candidates.filter(c=>c.eligible&&Number.isFinite(c.p95Ms)&&c.p95Ms>=0&&Number.isFinite(c.qualityTarget)&&c.qualityTarget>=0&&c.qualityTarget<=1&&c.verifiedSuccessLowerBound>=c.qualityTarget&&c.verifiedSuccessLowerBound<=1)
    .sort((a,b)=>a.p95Ms-b.p95Ms||a.scorer.identity.localeCompare(b.scorer.identity))[0]?.scorer??null;
}
