import {createHash} from 'node:crypto';
import type {PreparedCandidate,ReviewOutput} from './character-speaker.js';
import {ReviewOutputSchema} from './character-speaker.js';
import type {TypedEvidence} from './character-evidence.js';
import {exactSha256} from './character-admission.js';
export interface BackendProvenance {backend:'hosted'|'local'|'shadow';modelId:string;weightsSha256?:string;version:string}
export interface ReviewRequest {agentId:string;candidate:PreparedCandidate;exactDigest:string;packetSha256:string;evidence:readonly TypedEvidence[];rubricVersion:string}
export interface BackendReview {review:ReviewOutput;provenance:BackendProvenance;acceptProbability:number|null;costUsd:number|null}
export interface ReviewBackend {review(input:ReviewRequest,signal:AbortSignal):Promise<BackendReview>}
export class ReviewBackendError extends Error {constructor(readonly kind:'unavailable'|'invalid'|'cancelled',message:string){super(message);}}
export function validateBackendReview(input:ReviewRequest,value:BackendReview):BackendReview {
  if(exactSha256(input.candidate.text)!==input.exactDigest)throw new ReviewBackendError('invalid','Candidate digest mismatch.');
  const review=ReviewOutputSchema.parse(value.review),p=value.acceptProbability;
  if(p!==null&&(!Number.isFinite(p)||p<0||p>1))throw new ReviewBackendError('invalid','Invalid calibration probability.');
  if(!value.provenance.modelId||!value.provenance.version)throw new ReviewBackendError('invalid','Backend identity unavailable.');
  if(value.provenance.backend!=='hosted'&&!/^[a-f0-9]{64}$/.test(value.provenance.weightsSha256??''))throw new ReviewBackendError('invalid','Weights identity unavailable.');
  return {...value,review};
}
/** The delegate retains the existing hosted prompt, accounting and parser. */
export function hostedReviewBackend(delegate:(input:ReviewRequest,signal:AbortSignal)=>Promise<BackendReview>):ReviewBackend {
  return {async review(input,signal){signal.throwIfAborted();const result=await delegate(input,signal);signal.throwIfAborted();if(result.provenance.backend!=='hosted')throw new ReviewBackendError('invalid','Wrong hosted provenance.');return validateBackendReview(input,result);}};
}
export interface LocalManifest {modelId:string;weightsSha256:string;backendVersion:string;rubricVersion:string;riskVersion:string;licenseRecord:{reviewedBy:string;reviewedAt:number;mitCompatible:boolean;license:string};hardwareId:string;datasetDigest:string}
export interface QualificationMetrics {n:number;falseAccepts:number;falseHoldRate:number|null;ece:number|null;p95Ms:number;peakBytes:number|null}
export const metricGate=(m:QualificationMetrics)=>Number.isSafeInteger(m.n)&&m.n>=300&&m.falseAccepts===0&&m.falseHoldRate!==null&&m.falseHoldRate>=0&&m.falseHoldRate<=.05&&m.ece!==null&&m.ece>=0&&m.ece<=.1&&m.p95Ms>=0&&m.p95Ms<=1000&&m.peakBytes!==null&&m.peakBytes>=0&&m.peakBytes<=1500000000;
export function localQualification(input:{manifest:LocalManifest;metrics:QualificationMetrics;synthetic:boolean;independent:boolean;heldOut:boolean;memoryScope:string;hardwareId:string;distinctDigests:number}) {
  const m=input.manifest;
  return !input.synthetic&&input.independent&&input.heldOut&&input.memoryScope==='inference-process'&&input.hardwareId===m.hardwareId&&input.distinctDigests>=300&&
    !!m.modelId&&/^[a-f0-9]{64}$/.test(m.weightsSha256)&&/^[a-f0-9]{64}$/.test(m.datasetDigest)&&!!m.backendVersion&&!!m.rubricVersion&&!!m.riskVersion&&
    !!m.licenseRecord.reviewedBy&&m.licenseRecord.reviewedAt>0&&m.licenseRecord.mitCompatible&&!!m.licenseRecord.license&&metricGate(input.metrics);
}
/** Local failure always delegates to hosted. Availability alone is not qualification. */
export async function reviewWithFallback(input:ReviewRequest,signal:AbortSignal,options:{hosted:ReviewBackend;local?:ReviewBackend;qualified:()=>boolean;onFallback:(reason:string)=>void}) {
  if(options.local&&options.qualified())try{return validateBackendReview(input,await options.local.review(input,signal));}catch(error){signal.throwIfAborted();options.onFallback(error instanceof ReviewBackendError?error.kind:'unavailable');}
  return options.hosted.review(input,signal);
}
export interface ShadowRecord {key:string;status:'ok'|'error'|'dropped';queueMs:number;inferenceMs:number|null;endToEndMs:number;result?:BackendReview;reason?:string;resourceScope:'unknown';costUsd:number|null}
export class ShadowReviewWorker {
  private used=0;private queue:Array<()=>void>=[];private controllers=new Set<AbortController>();
  private stopped=false;
  constructor(private backend:ReviewBackend,private record:(r:ShadowRecord)=>void,private concurrency=1,private queueLimit=8) {if(concurrency<1||queueLimit<0)throw new Error('Invalid shadow worker bounds.');}
  submit(input:ReviewRequest,parent:AbortSignal):void {
    const received=Date.now(),key=createHash('sha256').update(JSON.stringify([input.agentId,input.exactDigest,input.packetSha256,input.rubricVersion,input.evidence])).digest('hex');
    if(this.stopped||parent.aborted||this.used>=this.concurrency&&this.queue.length>=this.queueLimit){this.record({key,status:'dropped',queueMs:0,inferenceMs:null,endToEndMs:0,reason:this.stopped||parent.aborted?'cancelled':'queue-full',resourceScope:'unknown',costUsd:null});return;}
    const controller=new AbortController();this.controllers.add(controller);
    const start=()=>{if(this.stopped||parent.aborted){this.controllers.delete(controller);this.record({key,status:'dropped',queueMs:Date.now()-received,inferenceMs:null,endToEndMs:Date.now()-received,reason:'cancelled',resourceScope:'unknown',costUsd:null});return;}this.used++;const began=Date.now(),signal=AbortSignal.any([parent,controller.signal,AbortSignal.timeout(5000)]);
      const cancelled=new Promise<never>((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
      const inference=Promise.resolve().then(()=>{signal.throwIfAborted();return this.backend.review(input,signal);});
      void Promise.race([inference,cancelled]).then(result=>{signal.throwIfAborted();this.record({key,status:'ok',queueMs:began-received,inferenceMs:Date.now()-began,endToEndMs:Date.now()-received,result:validateBackendReview(input,result),resourceScope:'unknown',costUsd:result.costUsd});})
        .catch(()=>this.record({key,status:'error',queueMs:began-received,inferenceMs:null,endToEndMs:Date.now()-received,reason:'shadow-unavailable',resourceScope:'unknown',costUsd:null}));
      // A backend ignoring cancellation still owns its slot; a timeout cannot spawn overlapping inference.
      void inference.catch(()=>{}).finally(()=>{this.controllers.delete(controller);this.used--;this.queue.shift()?.();});};
    if(this.used<this.concurrency)start();else this.queue.push(start);
  }
  stop(){this.stopped=true;for(const c of this.controllers)c.abort();for(const drop of this.queue.splice(0))drop();}
}
