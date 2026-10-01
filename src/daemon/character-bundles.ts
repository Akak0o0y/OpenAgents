import { z } from 'zod';
import { CharacterProposals } from './character-proposals.js';
import { setBrowserAutonomy,normaliseSite } from './browser-accounts.js';
import type { PublishPolicy } from './publish-policy.js';
import { parseCron, computeNextRun } from './cron.js';
import {ROUTINE_ASK_TASK} from './work-contract.js';
export const bundleOperationKey=(proposalId:string,itemKey:string)=>JSON.stringify([proposalId,itemKey]);
export class CharacterBundles {
  private active=new Set<string>();
  constructor(private proposals:CharacterProposals,private policy:PublishPolicy,private grant?:(agentId:string,pluginId:string)=>Promise<void>){}
  async applyPending(proposalId:string,signal:AbortSignal) {
    if(this.active.has(proposalId))return;
    this.active.add(proposalId);
    const store=this.proposals.store,db=store.getDatabase();
    try {
      const rows=db.prepare("SELECT * FROM bot_character_bundle_items WHERE proposal_id=? AND status='pending' ORDER BY rowid").all(proposalId) as any[];
      for(const row of rows) {
        signal.throwIfAborted();
        try {
          const input=JSON.parse(row.input_json),opKey=bundleOperationKey(proposalId,row.item_key);
          let result:unknown;
          if(row.kind==='grant') {
            const v=z.object({pluginId:z.string().min(1).max(200)}).strict().parse(input);
            if(!this.grant)throw new Error('Installed-plugin grant service unavailable.');
            await this.grant(row.agent_id,v.pluginId);result={pluginId:v.pluginId};
          } else result=store.transaction(()=>{
            const prior=store.getAgentData(row.agent_id,opKey,'character');
            if(prior)return JSON.parse(prior.data_json);
            let value:unknown;
            if(row.kind==='routine') {
              const v=z.object({name:z.string().min(1).max(100),cron:z.string().min(1).max(100),timezone:z.string().default('UTC'),prompt:z.string().min(1).max(4000)}).strict().parse(input);
              parseCron(v.cron);
              const r=store.createRoutine({agentId:row.agent_id,name:v.name,cronExpression:v.cron,timezone:v.timezone,promptTemplate:v.prompt,taskName:ROUTINE_ASK_TASK,enabled:false,nextRunAt:computeNextRun(v.cron,Date.now(),v.timezone)});
              value={routineId:r.id,paused:true};
            }else if(row.kind==='posting-policy') {
              const v=z.object({routineKey:z.string().min(1),required:z.boolean()}).strict().parse(input);
              const previous=store.getAgentData(row.agent_id,bundleOperationKey(proposalId,v.routineKey),'character');
              if(!previous)throw new Error('The paused routine must be created first.');
              const {routineId}=JSON.parse(previous.data_json);value=this.policy.set(row.agent_id,routineId,v.required);
            }else if(row.kind==='autonomy') {
              const v=z.object({value:z.enum(['ask','accounts','always'])}).strict().parse(input);
              setBrowserAutonomy(store,row.agent_id,v.value);value={autonomy:v.value};
            }else if(row.kind==='account-request') {
              const v=z.object({site:z.string().min(1).max(2000),purpose:z.string().max(500)}).strict().parse(input);
              const p=this.proposals.get(row.agent_id,proposalId);
              const site=normaliseSite(v.site);
              const card=store.createApproval({taskRunId:p.runId,agentId:row.agent_id,kind:'account-request',payload:{site,reason:v.purpose,question:`Sign in to ${site}?`,points:[v.purpose]}});
              value={approvalId:card.id,message:'Waiting for you to sign in.'};
            }else throw new Error('This setting must be saved in the reviewed character draft.');
            store.setAgentData({agentId:row.agent_id,key:opKey,category:'character',data:value});return value;
          });
          db.prepare("UPDATE bot_character_bundle_items SET status='applied',result_json=?,updated_at=? WHERE id=? AND status='pending'").run(JSON.stringify(result),Date.now(),row.id);
        }catch(error){db.prepare("UPDATE bot_character_bundle_items SET status='failed',error=?,updated_at=? WHERE id=?").run(error instanceof Error?error.message.slice(0,500):'Could not apply item.',Date.now(),row.id);}
      }
      const states=db.prepare('SELECT status FROM bot_character_bundle_items WHERE proposal_id=?').all(proposalId) as {status:string}[];
      db.prepare('UPDATE bot_character_proposals SET status=?,updated_at=? WHERE id=? AND status=\'applying\'')
        .run(states.some(s=>s.status==='pending')?'applying':states.some(s=>s.status==='failed')?'failed':'applied',Date.now(),proposalId);
    }finally{this.active.delete(proposalId);}
  }
  async recover(signal:AbortSignal) {
    const rows=this.proposals.store.getDatabase().prepare("SELECT id FROM bot_character_proposals WHERE status='applying'").all() as {id:string}[];
    for(const row of rows)await this.applyPending(row.id,signal);
  }
}
