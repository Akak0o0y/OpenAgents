import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {localQualification} from '../dist/src/daemon/character-review-backend.js';
const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split(/=(.*)/s).slice(0,2)));
if(!['fixture','evaluate'].includes(args.mode)||!args.input||!args.out)throw new Error('Use --mode=fixture|evaluate --input=cases.json --out=report.json. No models are downloaded or started.');
const bytes=await readFile(args.input),input=JSON.parse(bytes.toString('utf8'));
if(!Array.isArray(input.cases)||!input.cases.length)throw new Error('Provide independently labelled evaluation cases.');
const cases=input.cases,seen=new Set(),matrix={trueAccept:0,falseAccept:0,trueHold:0,falseHold:0,errors:0};
let acceptable=0,probabilitiesComplete=true;const bins=Array.from({length:10},()=>({n:0,p:0,y:0})),durations=[],cold=[],warm=[];
for(const c of cases){
  if(typeof c.digest!=='string'||!/^[a-f0-9]{64}$/.test(c.digest)||seen.has(c.digest))throw new Error('Every case needs a distinct exact SHA-256 digest.');seen.add(c.digest);
  if(!['acceptable','defective'].includes(c.label)||!['accept','hold','error'].includes(c.decision))throw new Error('Invalid independent label or backend decision.');
  const good=c.label==='acceptable';if(good)acceptable++;
  if(c.decision==='error'){matrix.errors++;if(good)matrix.falseHold++;else matrix.trueHold++;}
  else if(c.decision==='accept'){if(good)matrix.trueAccept++;else matrix.falseAccept++;}
  else if(good)matrix.falseHold++;else matrix.trueHold++;
  if(!Number.isFinite(c.endToEndMs)||c.endToEndMs<0)throw new Error('All cases, including failures, need observed end-to-end duration.');
  durations.push(c.endToEndMs);(c.cold?cold:warm).push(c.endToEndMs);
  if(!Number.isFinite(c.acceptProbability)||c.acceptProbability<0||c.acceptProbability>1)probabilitiesComplete=false;
  else {const b=bins[Math.min(9,Math.floor(c.acceptProbability*10))];b.n++;b.p+=c.acceptProbability;b.y+=good?1:0;}
}
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
const wilson=(k,n)=>{if(!n)return null;const z=1.959963984540054,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [Math.max(0,c-h),Math.min(1,c+h)];};
const peak=cases.every(c=>Number.isFinite(c.peakBytes)&&c.peakBytes>=0)?Math.max(...cases.map(c=>c.peakBytes)):null;
const metrics={n:cases.length,falseAccepts:matrix.falseAccept,falseHoldRate:acceptable?matrix.falseHold/acceptable:null,
  ece:probabilitiesComplete?bins.reduce((sum,b)=>sum+(b.n?b.n/cases.length*Math.abs(b.p/b.n-b.y/b.n):0),0):null,p95Ms:percentile(durations,.95),peakBytes:peak};
const datasetDigest=createHash('sha256').update(JSON.stringify(cases)).digest('hex');
let artifactMatch=false;if(args.weights){const hash=createHash('sha256').update(await readFile(args.weights)).digest('hex');artifactMatch=hash===input.manifest?.weightsSha256;}
const synthetic=args.mode==='fixture'||input.synthetic!==false;
const eligible=cases.every(c=>c.riskClass==='eligible'&&c.independent===true&&c.trainingOverlap===false);
const qualified=!!input.manifest&&artifactMatch&&eligible&&input.manifest.datasetDigest===datasetDigest&&localQualification({manifest:input.manifest,metrics,synthetic,
  independent:input.independent===true,heldOut:input.heldOut===true,memoryScope:input.memoryScope,hardwareId:input.hardwareId,distinctDigests:seen.size});
const report={schema:'openhours.character-qualification/1',synthetic,qualified,productionQualificationWritten:false,artifactMatch,datasetDigest,manifest:input.manifest??null,
  metrics,confusionMatrix:matrix,classCounts:{acceptable,defective:cases.length-acceptable},uncertainty95:{falseAcceptRate:wilson(matrix.falseAccept,cases.length-acceptable),falseHoldRate:wilson(matrix.falseHold,acceptable)},
  timings:{units:'ms',cold:{n:cold.length,p95:percentile(cold,.95)},warm:{n:warm.length,p95:percentile(warm,.95)}},memory:{units:'bytes',scope:input.memoryScope??'unknown',limit:1500000000},
  limitations:['Offline supplied measurements; this report does not attest the measurement source or install a backend.','Fixture results cannot enable production review.','Model artifacts and reviewed license evidence are required for eligibility.']};
await writeFile(args.out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({qualified,synthetic,n:cases.length,out:args.out}));
