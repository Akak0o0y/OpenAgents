import {randomUUID,createHash} from 'node:crypto';
import type {AgentStore} from './agent-store.js';
import {CharacterInvalidError} from './character-schema.js';
import {CHARACTER_RISK_VERSION} from './character-risk.js';
import {ShadowReviewWorker,localQualification,validateBackendReview,type ReviewBackend,type ReviewRequest,type BackendReview,type ShadowRecord} from './character-review-backend.js';

export interface LocalReviewInstallation {
  backend:ReviewBackend;
  evidence:Parameters<typeof localQualification>[0];
}
/** Adapters are explicitly installed by the host. This service never downloads or launches a model. */
export class CharacterReviewService {
  private shadow:ShadowReviewWorker|null;
  private localBusy=false;
  private stopped=false;
  private abort=new AbortController();
  constructor(private store:AgentStore,private installation?:LocalReviewInstallation) {
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_character_shadow_reviews(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,candidate_digest TEXT NOT NULL,record_json TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    this.shadow=installation?new ShadowReviewWorker(installation.backend,record=>this.recordShadow(record)):null;
  }
  private pending=new Map<string,{agentId:string;digest:string}>();
  private recordShadow(record:ShadowRecord){const owner=this.pending.get(record.key);if(!owner)return;this.pending.delete(record.key);
    if(this.stopped)return;
    try{const raw=this.store.getAgentData(owner.agentId,'review','character'),boundary=raw?JSON.parse(raw.data_json).deletionBoundary:0;if(boundary&&boundary>=Date.now()-record.endToEndMs)return;
      this.store.getDatabase().prepare('INSERT INTO bot_character_shadow_reviews VALUES (?,?,?,?,?)').run(randomUUID(),owner.agentId,owner.digest,JSON.stringify(record),Date.now());}catch{/* Diagnostic persistence never changes a live review outcome. */}}
  private mode(agentId:string):'off'|'shadow'|'local' {const row=this.store.getAgentData(agentId,'review-backend','character');return row?JSON.parse(row.data_json).mode:'off';}
  qualified(rubric?:string) {const e=this.installation?.evidence;return !!e&&localQualification(e)&&e.manifest.riskVersion===CHARACTER_RISK_VERSION&&(!rubric||e.manifest.rubricVersion===rubric);}
  status(agentId:string) {
    if(!this.store.getAgent(agentId))throw new CharacterInvalidError('Bot not found.');
    return {mode:this.mode(agentId),available:!!this.installation,qualified:this.qualified(),manifest:this.installation?.evidence.manifest??null,
      reason:!this.installation?'No local reviewer installed.':!this.qualified()?'Independent accuracy, calibration, hardware or licence evidence is incomplete.':null,
      shadow:this.store.getDatabase().prepare('SELECT record_json,created_at FROM bot_character_shadow_reviews WHERE agent_id=? ORDER BY created_at DESC LIMIT 20').all(agentId)};
  }
  configure(agentId:string,mode:'off'|'shadow'|'local') {
    this.status(agentId);if(mode!=='off'&&!this.installation)throw new CharacterInvalidError('No local reviewer installed.');
    if(mode==='local'&&!this.qualified())throw new CharacterInvalidError('Local reviewer is not qualified.');
    this.store.setAgentData({agentId,category:'character',key:'review-backend',data:{mode}});return this.status(agentId);
  }
  async local(input:ReviewRequest,parent:AbortSignal,eligible:boolean,onAttempt:()=>void):Promise<BackendReview|null> {
    if(this.stopped||this.localBusy||!eligible||this.mode(input.agentId)!=='local'||!this.qualified(input.rubricVersion)||!this.installation)return null;
    const signal=AbortSignal.any([parent,this.abort.signal,AbortSignal.timeout(1000)]);signal.throwIfAborted();
    this.localBusy=true;onAttempt();
    const inference=Promise.resolve().then(()=>this.installation!.backend.review(input,signal));
    void inference.catch(()=>{}).finally(()=>{this.localBusy=false;});
    let onAbort:()=>void=()=>{};
    const cancelled=new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
    let result:BackendReview;
    try{result=validateBackendReview(input,await Promise.race([inference,cancelled]));}finally{signal.removeEventListener('abort',onAbort);}
    signal.throwIfAborted();
    const m=this.installation.evidence.manifest;
    if(result.provenance.backend!=='local'||result.provenance.modelId!==m.modelId||result.provenance.weightsSha256!==m.weightsSha256||result.provenance.version!==m.backendVersion)throw new Error('Local reviewer identity changed.');
    return result;
  }
  shadowReview(input:ReviewRequest,signal:AbortSignal) {
    if(this.stopped||this.mode(input.agentId)!=='shadow'||!this.shadow)return;
    const key=shadowKey(input);if(this.pending.has(key))return;
    this.pending.set(key,{agentId:input.agentId,digest:input.exactDigest});this.shadow.submit(structuredClone(input),signal);
  }
  stop(){this.stopped=true;this.abort.abort();this.shadow?.stop();this.pending.clear();}
}
function shadowKey(input:ReviewRequest){return createHash('sha256').update(JSON.stringify([input.agentId,input.exactDigest,input.packetSha256,input.rubricVersion,input.evidence])).digest('hex');}
