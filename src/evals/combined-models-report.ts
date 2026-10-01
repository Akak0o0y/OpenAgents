import {z} from 'zod';
import {ModelUsageSchema} from '../daemon/combined-models.js';
const id=z.string().min(1).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const ExperimentRunSchema=z.object({schema:z.literal('combined-run/1'),experimentId:id,taskId:id,lineage:id,pairId:id,arm:z.enum(['A','B','C','D','E']),
  split:z.enum(['pilot','train','calibration','certification']),language:id,concurrentBots:z.number().int().min(1).max(2),seed:z.number().int(),synthetic:z.boolean(),
  manifest:z.object({sourceRevision:id,dirtySourceSha256:hash,taskSha256:hash,policySha256:hash,evaluatorVersion:id,hardware:id,runtime:id,models:z.array(id).min(1),tokenizers:z.array(id).min(1),precision:id,endpointPlacement:z.enum(['local','hosted','mixed']),cacheState:z.enum(['cold','warm']),order:z.number().int().nonnegative()}).strict(),
  deadlineMs:z.number().positive().finite(),elapsedMs:z.number().nonnegative().finite(),verifiedAtMs:z.number().nonnegative().finite().nullable(),
  requiredOutcomes:z.number().int().positive(),verifiedOutcomes:z.number().int().nonnegative(),falseCompletion:z.boolean(),wrongEffect:z.boolean(),duplicateEffect:z.boolean(),
  humanInterventions:z.number().int().nonnegative(),fallbacks:z.number().int().nonnegative(),
  calls:z.array(z.object({id,role:z.enum(['planner','candidate-builder','scorer','grounder','verifier','recovery','compaction']),model:id,durationMs:z.number().finite().nonnegative(),status:z.enum(['ok','failed','cancelled']),usage:ModelUsageSchema}).strict()).max(10000)
}).strict().superRefine((r,c)=>{if(r.verifiedOutcomes>r.requiredOutcomes||r.verifiedAtMs!==null&&(r.verifiedOutcomes!==r.requiredOutcomes||r.verifiedAtMs>r.elapsedMs))c.addIssue({code:'custom',message:'Inconsistent independently verified outcomes/timing.'});if(new Set(r.calls.map(c=>c.id)).size!==r.calls.length)c.addIssue({code:'custom',message:'Duplicate call IDs.'});});
export type ExperimentRun=z.infer<typeof ExperimentRunSchema>;
const complete=(r:ExperimentRun)=>r.verifiedAtMs!==null&&r.verifiedAtMs<=r.deadlineMs&&!r.falseCompletion&&!r.wrongEffect&&!r.duplicateEffect;
const completionTime=(r:ExperimentRun)=>complete(r)?r.verifiedAtMs!:r.deadlineMs;
const mean=(n:number[])=>n.reduce((a,b)=>a+b,0)/n.length;
function quantile(n:number[],p:number){const sorted=[...n].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]??null;}
function wilson(success:number,n:number){const z=1.959963984540054,d=1+z*z/n,p=success/n,m=(p+z*z/(2*n))/d,r=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [m-r,m+r];}
function tokenSummary(runs:ExperimentRun[]){
  const calls=runs.flatMap(r=>r.calls),keys=['inputTokens','outputTokens','encoderTokens','cachedInputTokens','wireAttempts','costUsd'] as const;
  return Object.fromEntries(keys.map(key=>{const known=calls.filter(c=>c.usage[key]!==null&&!['estimated','unknown'].includes(c.usage.source)),subtotal=known.reduce((n,c)=>n+c.usage[key]!,0),total=known.length===calls.length?subtotal:null,successes=runs.filter(complete).length;return [key,{knownSubtotal:subtotal,unknownCalls:calls.length-known.length,total,perAttemptedTask:total===null?null:total/runs.length,allUsagePerVerifiedTask:total===null||!successes?null:total/successes}];}));
}
/** Task-lineage cluster bootstrap, resampling paired lineages (never individual decision steps). */
function pairedInterval(pairs:Array<{lineage:string;difference:number}>,seed=42){
  const groups=[...new Set(pairs.map(p=>p.lineage))].map(k=>pairs.filter(p=>p.lineage===k).map(p=>p.difference));
  if(groups.length<20)return {method:'paired-lineage-bootstrap/1',clusters:groups.length,interval95:null,reason:'Fewer than 20 independent lineages; uncertainty not estimated.'};
  let state=seed>>>0;const random=()=>{state=(1664525*state+1013904223)>>>0;return state/4294967296;};const draws=[];
  for(let b=0;b<2000;b++){const sample=[];for(let i=0;i<groups.length;i++)sample.push(...groups[Math.floor(random()*groups.length)]!);draws.push(mean(sample));}
  return {method:'paired-lineage-bootstrap/1',clusters:groups.length,interval95:[quantile(draws,.025),quantile(draws,.975)],reason:null};
}
export function combinedModelsReport(input:unknown[]){
  if(!input.length||input.length>100000)throw new Error('Supply 1–100000 experiment runs.');
  const runs=input.map(v=>ExperimentRunSchema.parse(v));
  if(new Set(runs.map(r=>r.experimentId)).size!==1)throw new Error('One frozen experiment per report.');
  if(new Set(runs.map(r=>r.split)).size!==1)throw new Error('Do not pool pilot, training, calibration and certification results.');
  const unique=new Set<string>(),lineageSplit=new Map<string,string>();
  for(const r of runs){const key=`${r.pairId}:${r.arm}`;if(unique.has(key))throw new Error('Duplicate paired arm.');unique.add(key);const split=lineageSplit.get(r.lineage);if(split&&split!==r.split)throw new Error('Task lineage leaks across splits.');lineageSplit.set(r.lineage,r.split);}
  const arms=[...new Set(runs.map(r=>r.arm))].sort().map(arm=>{
    const rows=runs.filter(r=>r.arm===arm),ok=rows.filter(complete),times=rows.map(r=>complete(r)?r.verifiedAtMs!:Infinity),deadlines=new Set(rows.map(r=>r.deadlineMs));
    const groups=[...new Set(rows.map(r=>`${r.language}/${r.concurrentBots}/${r.split}/${r.manifest.cacheState}`))];
    return {arm,runs:rows.length,verified:ok.length,verifiedRate:ok.length/rows.length,descriptiveWilson95:wilson(ok.length,rows.length),wilsonWarning:'Descriptive only; assumes independent tasks. Use paired lineage uncertainty for comparisons.',
      falseCompletion:rows.filter(r=>r.falseCompletion).length,wrongEffects:rows.filter(r=>r.wrongEffect).length,duplicateEffects:rows.filter(r=>r.duplicateEffect).length,
      p50VerifiedMs:deadlines.size===1&&Number.isFinite(quantile(times,.5))?quantile(times,.5):null,p95VerifiedMs:deadlines.size===1&&Number.isFinite(quantile(times,.95))?quantile(times,.95):null,
      restrictedMeanUncompletedMs:deadlines.size===1?mean(rows.map(completionTime)):null,
      completionCurve:deadlines.size===1?[0,.25,.5,.75,1].map(f=>({tMs:rows[0]!.deadlineMs*f,completedFraction:rows.filter(r=>complete(r)&&r.verifiedAtMs!<=rows[0]!.deadlineMs*f).length/rows.length})):null,
      usage:tokenSummary(rows),usageByModelTokenizer:[...new Set(rows.flatMap(r=>r.calls.map(c=>`${c.model}/${c.usage.tokenizer??'unknown'}`)))].map(key=>({key,usage:tokenSummary(rows.map(r=>({...r,calls:r.calls.filter(c=>`${c.model}/${c.usage.tokenizer??'unknown'}`===key)})))})),logicalCalls:rows.reduce((n,r)=>n+r.calls.length,0),fallbacks:rows.reduce((n,r)=>n+r.fallbacks,0),
      successfulOnlyP95Ms:quantile(ok.map(r=>r.verifiedAtMs!),.95),
      slices:groups.map(key=>{const slice=rows.filter(r=>`${r.language}/${r.concurrentBots}/${r.split}/${r.manifest.cacheState}`===key);return {key,runs:slice.length,verified:slice.filter(complete).length,usage:tokenSummary(slice)};})};
  });
  const comparisons=arms.filter(a=>a.arm!=='A').flatMap(arm=>['A',...(['C','D','E'].includes(arm.arm)&&arms.some(a=>a.arm==='B')?['B']:[])].map(baselineArm=>{
    const pairs=runs.filter(r=>r.arm===arm.arm).map(treatment=>({treatment,baseline:runs.find(b=>b.arm===baselineArm&&b.pairId===treatment.pairId)}));
    const matched=pairs.filter((p):p is {treatment:ExperimentRun;baseline:ExperimentRun}=>!!p.baseline);
    for(const {baseline:b,treatment:t} of matched)if(b.taskId!==t.taskId||b.lineage!==t.lineage||b.seed!==t.seed||b.deadlineMs!==t.deadlineMs||b.language!==t.language||b.concurrentBots!==t.concurrentBots||b.split!==t.split||b.synthetic!==t.synthetic||b.manifest.taskSha256!==t.manifest.taskSha256||b.manifest.evaluatorVersion!==t.manifest.evaluatorVersion||b.manifest.sourceRevision!==t.manifest.sourceRevision||b.manifest.dirtySourceSha256!==t.manifest.dirtySourceSha256||b.manifest.hardware!==t.manifest.hardware||b.manifest.cacheState!==t.manifest.cacheState)throw new Error('Paired runs have incompatible task/environment conditions.');
    const delta=matched.map(({baseline,treatment})=>({lineage:baseline.lineage,difference:Number(complete(treatment))-Number(complete(baseline))}));
    const latency=matched.map(({baseline,treatment})=>({lineage:baseline.lineage,difference:completionTime(treatment)-completionTime(baseline)}));
    return {arm:arm.arm,baselineArm,pairedRuns:matched.length,unmatched:pairs.length-matched.length,successDifference:matched.length?mean(delta.map(v=>v.difference)):null,
      successUncertainty:pairedInterval(delta),restrictedTimeDifferenceMs:matched.length?mean(latency.map(v=>v.difference)):null,timeUncertainty:pairedInterval(latency)};
  }));
  return {schema:'combined-report/1',experimentId:runs[0]!.experimentId,synthetic:runs.some(r=>r.synthetic),promotion:'not-authorized',
    warnings:['This report cannot certify deployment. Freeze sample size, hypotheses, cluster method, margins and multiplicity before certification.','Different tokenizers and encoder/generation tokens are not equivalent compute. Cached tokens are a subset of input tokens; do not add twice.','Calls with unknown usage/cost prevent exact total or savings claims. Local hardware cost is not inferred from token counts.','Successful-only latency excludes failures; use verified completion curves and restricted times for effectiveness.'],arms,comparisons};
}
