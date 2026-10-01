import type {AgentStore} from './agent-store.js';
import type {CharacterStore} from './character-store.js';
import {resolveReviewer} from './character-speaker.js';
export class CharacterDrift {
  constructor(private store:AgentStore,private characters:CharacterStore,private notify:(agentId:string,runId:string,text:string)=>void){}
  check(agentId:string) {
    const version=this.characters.getLatestVersion(agentId),agent=this.store.getAgent(agentId);if(!version||version.mode==='off'||!agent)return null;
    const reviewer=resolveReviewer(agent,version.settings);
    const rows=this.store.getDatabase().prepare(`SELECT u.id,u.run_id,r.reviewer_model,r.reviewer_connection_id,r.reviewer_prompt_version,r.scores_json,i.key_hash
      FROM bot_character_utterances u JOIN bot_character_reviews r ON r.candidate_id=u.final_candidate_id
      LEFT JOIN bot_character_candidate_identity i ON i.candidate_id=u.final_candidate_id
      WHERE u.agent_id=? AND u.version=? AND u.status='confirmed' AND u.semantic='passed' AND r.verdict='pass'
      AND r.reviewer_model=? AND r.reviewer_connection_id IS ?
      AND r.id=(SELECT id FROM bot_character_reviews WHERE candidate_id=u.final_candidate_id AND verdict='pass' ORDER BY call_no DESC LIMIT 1)
      ORDER BY u.created_at DESC,u.id DESC LIMIT 50`).all(agentId,version.version,reviewer.modelId,reviewer.connectionId) as any[];
    if(!rows.length)return null;
    const key=JSON.stringify([version.version,reviewer.modelId,reviewer.connectionId,rows[0].reviewer_prompt_version,rows[0].key_hash??'served-unknown']);
    const current=rows.filter(r=>r.reviewer_prompt_version===rows[0].reviewer_prompt_version&&r.key_hash===rows[0].key_hash).slice(0,10);
    const scores=current.map(r=>JSON.parse(r.scores_json??'{}').voice).filter(v=>Number.isInteger(v)&&v>=1&&v<=5);
    if(scores.length<10)return {key,n:scores.length,average:null};
    const average=scores.reduce((a,b)=>a+b,0)/10;
    return this.store.transaction(()=>{
      const raw=this.store.getAgentData(agentId,'drift','character'),old=raw?JSON.parse(raw.data_json):{},state=old.key===key?old:{key,alertedAt:null,recoveredAt:null};
      if(average<3.5&&(!state.alertedAt||state.recoveredAt)){
        state.alertedAt=Date.now();state.recoveredAt=null;
        this.notify(agentId,current[0].run_id,'My last ten reviewed posts averaged below 3.5 for voice. You can inspect them and use Review now in Character → Growth.');
      }else if(average>=3.5&&state.alertedAt&&!state.recoveredAt)state.recoveredAt=Date.now();
      const result={...state,n:10,average};this.store.setAgentData({agentId,key:'drift',category:'character',data:result});return result;
    });
  }
}
