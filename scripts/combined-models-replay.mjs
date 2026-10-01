// Explicit offline-state replay against one operator-configured endpoint. Never executes tools.
import fs from 'node:fs';
import {DecisionSchema,HttpDecisionScorer,CombinedDecisionController} from '../dist/src/daemon/combined-models.js';
const [input,output,url,identity,placement]=process.argv.slice(2);
if(!input||!output||!url||!identity||!['local','hosted'].includes(placement))throw new Error('Usage: node scripts/combined-models-replay.mjs states.jsonl output.jsonl URL PINNED_IDENTITY local|hosted');
if(fs.statSync(input).size>16*1024*1024)throw new Error('Replay input exceeds 16 MiB.');
const rows=fs.readFileSync(input,'utf8').split(/\r?\n/).filter(Boolean).map(v=>JSON.parse(v));
if(rows.length>1000)throw new Error('Replay limit is 1000 explicitly supplied records.');
for(const row of rows){DecisionSchema.parse(row.decision);if(!Array.isArray(row.acceptableIds)||!row.acceptableIds.length||row.acceptableIds.some(id=>id!=='escalate'&&!row.decision.candidates.some(c=>c.id===id)))throw new Error('Each record needs valid independent acceptableIds labels.');}
const file=fs.openSync(output,'wx');
const scorer=new HttpDecisionScorer({url,identity,placement,token:async()=>process.env.OPENHOURS_RESEARCH_TOKEN??''});
try{for(const row of rows){
  let timedOut=false;
  // Labels never enter the scorer request. Replay cannot certify counterfactual task success.
  const controller=new CombinedDecisionController({scorer,mode:'shadow',policyVersion:'replay/1',timeoutMs:10000,maxCalls:1,record:record=>{timedOut=record.reason==='cancelled-or-timeout';fs.writeSync(file,JSON.stringify({schema:'decision-replay/1',lineage:row.lineage??null,split:row.split??'pilot',synthetic:row.synthetic!==false,record,selectionCorrect:record.candidateId!==null&&row.acceptableIds.includes(record.candidateId),executionBasedTaskSuccess:null})+'\n');}});
  await controller.choose(row.decision,AbortSignal.timeout(11000),()=>({stateDigest:row.decision.stateDigest,goalRevision:row.decision.goalRevision}));
  if(timedOut)throw new Error('Replay stopped after timeout; reconcile endpoint work before restarting. Partial records are preserved.');
}}finally{fs.closeSync(file);}
console.log('Shadow replay saved. No actions executed; no whole-task effectiveness claim.');
