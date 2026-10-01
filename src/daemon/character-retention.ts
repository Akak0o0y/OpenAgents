import type { AgentStore } from './agent-store.js';
import type { CharacterStore } from './character-store.js';
import type { CharacterAdmissions } from './character-admission.js';
import { CharacterNotFoundError } from './character-schema.js';
export class CharacterRetention {
  constructor(private store:AgentStore,private characters:CharacterStore,private admissions:CharacterAdmissions,
    private onAuditEvidenceRemoved:(ids:string[])=>void=()=>{}) {
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_character_deleted (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,utterance_id TEXT NOT NULL,publish_id TEXT,deleted_at INTEGER NOT NULL,
      PRIMARY KEY(agent_id,utterance_id));`);
  }
  prune(agentId:string,all=false,now=Date.now()) {
    if(!this.store.getAgent(agentId))throw new CharacterNotFoundError('Bot not found.');
    const months=this.characters.getLatestVersion(agentId)?.settings.retention.months??12;
    const cut=new Date(now);cut.setUTCMonth(cut.getUTCMonth()-months);
      const db=this.store.getDatabase();
    const result=this.store.transaction(()=>{
      const terminal="u.status NOT IN ('admitted','attempted','uncertain') AND NOT EXISTS(SELECT 1 FROM task_runs tr WHERE tr.id=u.run_id AND tr.status='RUNNING')";
      const pinned=`NOT EXISTS (SELECT 1 FROM bot_character_claim_occurrences o JOIN bot_character_claims c ON c.id=o.claim_id
        JOIN bot_character_candidates cc ON cc.id=o.candidate_id WHERE cc.utterance_id=u.id AND c.status IN ('adopted','disputed'))`;
      const rows=db.prepare(`SELECT u.id,u.publish_id FROM bot_character_utterances u WHERE u.agent_id=? AND ${terminal} AND ${pinned}
        AND (?=1 OR u.created_at<CASE WHEN u.status IN ('draft','held','refused','expired') THEN ? ELSE ? END) AND NOT EXISTS(SELECT 1 FROM bot_character_bundle_items b WHERE b.agent_id=u.agent_id AND b.status='pending')
        ORDER BY u.created_at LIMIT 100`).all(agentId,all?1:0,now-30*86400000,cut.getTime()) as {id:string;publish_id:string|null}[];
      const engagementRemoved=Number(db.prepare('DELETE FROM bot_character_engagement WHERE rowid IN (SELECT rowid FROM bot_character_engagement WHERE agent_id=? AND (?=1 OR observed_at<?) LIMIT 100)').run(agentId,all?1:0,cut.getTime()).changes);
      const occurrencesRemoved=Number(db.prepare(`DELETE FROM bot_character_claim_occurrences WHERE rowid IN(SELECT o.rowid FROM bot_character_claim_occurrences o JOIN bot_character_claims c ON c.id=o.claim_id JOIN bot_character_candidates cc ON cc.id=o.candidate_id JOIN bot_character_utterances u ON u.id=cc.utterance_id
        WHERE c.agent_id=? AND c.status NOT IN ('adopted','disputed') AND ${terminal} AND (?=1 OR o.created_at<?) LIMIT 100)`).run(agentId,all?1:0,cut.getTime()).changes);
      db.prepare("DELETE FROM bot_character_claims WHERE id IN (SELECT id FROM bot_character_claims c WHERE agent_id=? AND status NOT IN ('adopted','disputed') AND NOT EXISTS(SELECT 1 FROM bot_character_claim_occurrences o WHERE o.claim_id=c.id) LIMIT 100)").run(agentId);
      const compact=db.prepare(`SELECT DISTINCT cc.id FROM bot_character_candidates cc JOIN bot_character_utterances u ON u.id=cc.utterance_id
        WHERE cc.agent_id=? AND cc.created_at<? AND ${terminal} AND ${pinned} AND cc.evidence_json<>'[]' LIMIT 100`).all(agentId,now-90*86400000) as {id:string}[];
      this.onAuditEvidenceRemoved(compact.map(c=>c.id));
      for(const c of compact)db.prepare("UPDATE bot_character_candidates SET evidence_json='[]' WHERE id=?").run(c.id);
      db.prepare(`UPDATE bot_character_reviews SET extracted_json=NULL,findings_json=NULL,selection_json=NULL
        WHERE id IN(SELECT r.id FROM bot_character_reviews r JOIN bot_character_utterances u ON u.id=r.utterance_id
        WHERE r.agent_id=? AND r.created_at<? AND ${terminal} AND ${pinned} LIMIT 100)`).run(agentId,now-90*86400000);
      const nonfinal=db.prepare(`SELECT cc.id FROM bot_character_candidates cc JOIN bot_character_utterances u ON u.id=cc.utterance_id WHERE cc.agent_id=? AND cc.created_at<? AND cc.id IS NOT u.final_candidate_id AND ${terminal} AND ${pinned} LIMIT 100`).all(agentId,now-30*86400000) as {id:string}[];
      this.onAuditEvidenceRemoved(nonfinal.map(c=>c.id));for(const c of nonfinal)db.prepare('DELETE FROM bot_character_candidates WHERE id=?').run(c.id);
      const candidates:string[]=[];
      const shadowTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_character_shadow_reviews'").get();
      const shadowRemoved=shadowTable?Number(db.prepare('DELETE FROM bot_character_shadow_reviews WHERE id IN(SELECT id FROM bot_character_shadow_reviews WHERE agent_id=? AND (?=1 OR created_at<?) LIMIT 100)').run(agentId,all?1:0,now-90*86400000).changes):0;
      for(const row of rows){
        const ids=(db.prepare('SELECT id FROM bot_character_candidates WHERE utterance_id=?').all(row.id) as {id:string}[]).map(c=>c.id);
        candidates.push(...ids);this.onAuditEvidenceRemoved(ids);
        db.prepare('INSERT OR IGNORE INTO bot_character_deleted VALUES (?,?,?,?)').run(agentId,row.id,row.publish_id,now);
        db.prepare('DELETE FROM bot_character_utterances WHERE id=?').run(row.id);
      }
      db.prepare("DELETE FROM bot_character_claims WHERE id IN (SELECT id FROM bot_character_claims c WHERE agent_id=? AND status NOT IN ('adopted','disputed') AND NOT EXISTS(SELECT 1 FROM bot_character_claim_occurrences o WHERE o.claim_id=c.id) LIMIT 100)").run(agentId);
      db.prepare("DELETE FROM bot_character_proposals WHERE id IN(SELECT id FROM bot_character_proposals WHERE agent_id=? AND status IN('denied','superseded') AND updated_at<? LIMIT 100)").run(agentId,now-90*86400000);
      if(all)this.store.setAgentData({agentId,key:'review',category:'character',data:{lease:null,watermark:{utteranceCreatedAt:now,utteranceId:'',versionAt:this.characters.getLatestVersion(agentId)?.version??0},nextEligibleAt:0,failures:0,deletionBoundary:now}});
      const kept=(db.prepare("SELECT COUNT(*) AS n FROM bot_character_utterances WHERE agent_id=? AND status IN ('admitted','attempted','uncertain')").get(agentId) as any).n;
      return {removed:rows.length,keptUnresolved:kept,moreEligible:rows.length===100||engagementRemoved===100||occurrencesRemoved===100||shadowRemoved===100};
    });
    if(all)this.admissions.invalidateAgent(agentId,'version-changed');
    return result;
  }
  async deleteHistory(agentId:string,signal?:AbortSignal){let removed=0,last:ReturnType<CharacterRetention['prune']>;do{signal?.throwIfAborted();last=this.prune(agentId,true);removed+=last.removed;if(last.moreEligible)await new Promise<void>(resolve=>setImmediate(resolve));}while(last.moreEligible);return {...last,removed};}
}
