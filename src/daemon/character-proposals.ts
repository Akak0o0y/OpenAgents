import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentStore } from './agent-store.js';
import type { CharacterStore, SaveCharacterOptions } from './character-store.js';
import { prepareCharacterDraft } from './character-preview.js';
import { CharacterConflictError, CharacterInvalidError, CharacterNotFoundError } from './character-schema.js';

export const descriptionHash = (value: string | null | undefined) => createHash('sha256').update(value ?? '').digest('hex');
function mergeDraft<T>(base:T,patch:Partial<T>):T {
  const result={...base} as Record<string,unknown>;
  for(const [key,value] of Object.entries(patch)) {
    if(['__proto__','prototype','constructor'].includes(key))throw new CharacterInvalidError('Invalid draft key.');
    const previous=result[key];
    result[key]=value && previous && typeof value==='object' && typeof previous==='object' && !Array.isArray(value) && !Array.isArray(previous)
      ? mergeDraft(previous,value) : value;
  }
  return result as T;
}
export function proposalChangeHash(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return descriptionHash(JSON.stringify(sort(value)));
}
export const ProposalTokenSchema = z.object({ proposalId: z.string().min(1).max(200), revision: z.number().int().positive(), changeHash: z.string().regex(/^[a-f0-9]{64}$/) });
export type ProposalToken = z.infer<typeof ProposalTokenSchema>;
export const BundleItemSchema = z.object({ key: z.string().regex(/^[a-z0-9-]{1,60}$/), kind: z.enum(['routine','posting-policy','autonomy','account-request','grant','setting']),
  selected: z.boolean(), input: z.record(z.unknown()) }).strict();
export type BundleItem = z.infer<typeof BundleItemSchema>;
export interface ProposalDraft { draft: SaveCharacterOptions; description?: string; descriptionSelected?:boolean; bundles: BundleItem[]; assumptions: string[] }
export interface CharacterProposal extends ProposalToken, ProposalDraft {
  agentId: string; runId: string; approvalId: string; baseVersion: number; expectedDescriptionSha256: string;
  status: 'open'|'applying'|'applied'|'failed'|'stale'|'superseded'|'denied'; kind: 'setup'|'change'|'growth';
  previews: unknown; previewsRevision: number | null; savedVersion: number | null; createdAt: number;
}

export class CharacterProposals {
  constructor(readonly store: AgentStore, readonly characters: CharacterStore, private now = Date.now) {
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_character_proposals (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL, approval_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      revision INTEGER NOT NULL, change_hash TEXT NOT NULL, base_version INTEGER NOT NULL,
      description_hash TEXT NOT NULL, draft_json TEXT NOT NULL, previews_json TEXT, previews_revision INTEGER,
      saved_version INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS character_proposals_agent ON bot_character_proposals(agent_id,status);
      CREATE TABLE IF NOT EXISTS bot_character_proposal_revisions (
        proposal_id TEXT NOT NULL REFERENCES bot_character_proposals(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, change_hash TEXT NOT NULL, draft_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(proposal_id,revision));
      CREATE TABLE IF NOT EXISTS bot_character_bundle_items (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL REFERENCES bot_character_proposals(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL, kind TEXT NOT NULL, selected INTEGER NOT NULL, input_json TEXT NOT NULL,
        status TEXT NOT NULL, result_json TEXT, error TEXT, updated_at INTEGER NOT NULL, UNIQUE(proposal_id,item_key));`);
  }
  get(agentId: string, id: string): CharacterProposal {
    const r = this.store.getDatabase().prepare('SELECT * FROM bot_character_proposals WHERE id=? AND agent_id=?').get(id, agentId) as any;
    if (!r) throw new CharacterNotFoundError('Character proposal not found for this bot.');
    return { ...JSON.parse(r.draft_json), proposalId:r.id, agentId:r.agent_id, runId:r.run_id, approvalId:r.approval_id,
      revision:r.revision, changeHash:r.change_hash, baseVersion:r.base_version, expectedDescriptionSha256:r.description_hash,
      status:r.status, kind:r.kind, previews:r.previews_json ? JSON.parse(r.previews_json) : null,
      previewsRevision:r.previews_revision, savedVersion:r.saved_version, createdAt:r.created_at };
  }
  open(agentId: string) {
    const r = this.store.getDatabase().prepare("SELECT id FROM bot_character_proposals WHERE agent_id=? AND status='open' ORDER BY created_at DESC LIMIT 1").get(agentId) as any;
    return r ? this.get(agentId,r.id) : null;
  }
  private validate(agentId: string, value: ProposalDraft): ProposalDraft {
    const bundles = z.array(BundleItemSchema).max(12).parse(value.bundles);
    if (new Set(bundles.map(b => b.key)).size !== bundles.length) throw new CharacterInvalidError('Duplicate bundle item.');
    const assumptions = z.array(z.string().max(500)).max(20).parse(value.assumptions);
    if (value.description !== undefined) z.string().max(100_000).parse(value.description);
    const prepared = prepareCharacterDraft(this.store, this.characters, agentId, value.draft);
    return { draft:{document:prepared.document,settings:prepared.settings,sources:prepared.sources}, bundles, assumptions,
      ...(value.description !== undefined ? {description:value.description,descriptionSelected:value.descriptionSelected===true} : {}) };
  }
  create(input: {agentId:string;runId:string;kind?: CharacterProposal['kind'];value:ProposalDraft;previews?:unknown}) {
    const run = this.store.getTaskRun(input.runId);
    if (!run || run.agent_id !== input.agentId) throw new CharacterInvalidError('Proposal run belongs to another bot.');
    const value = this.validate(input.agentId,input.value), id = randomUUID(), kind = input.kind ?? 'setup';
    return this.store.transaction(() => {
      value.draft=this.characters.retainDraftSources(input.agentId,value.draft);
      const prior=this.store.getDatabase().prepare("SELECT id FROM bot_character_proposals WHERE agent_id=? AND status='open' AND ((kind='growth')=?) ORDER BY created_at DESC LIMIT 1").get(input.agentId,kind==='growth'?1:0) as {id:string}|undefined;
      const open=prior?this.get(input.agentId,prior.id):null;
      if (open?.kind === 'growth' && kind === 'growth') throw new CharacterConflictError('A growth proposal is already open.');
      if (open && open.kind !== 'growth' && kind !== 'growth') {
        this.store.getDatabase().prepare("UPDATE bot_character_proposals SET status='superseded' WHERE id=?").run(open.proposalId);
        this.store.decideApproval(open.approvalId,'DENIED','superseded');
      }
      const token = {proposalId:id,revision:1,changeHash:proposalChangeHash(value)};
      const approval = this.store.createApproval({taskRunId:input.runId,agentId:input.agentId,kind:'character-change',payload:token});
      const base = this.characters.getLatestVersion(input.agentId)?.version ?? 0, now = this.now();
      this.store.getDatabase().prepare(`INSERT INTO bot_character_proposals VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?,NULL,?,?)`)
        .run(id,input.agentId,input.runId,approval.id,kind,1,token.changeHash,base,descriptionHash(this.store.getAgent(input.agentId)!.system_prompt),
          JSON.stringify(value),input.previews === undefined ? null : JSON.stringify(input.previews),input.previews === undefined ? null : 1,now,now);
      this.store.getDatabase().prepare('INSERT INTO bot_character_proposal_revisions VALUES (?,?,?,?,?)').run(id,1,token.changeHash,JSON.stringify(value),now);
      return this.get(input.agentId,id);
    });
  }
  private check(agentId: string, token: ProposalToken) {
    ProposalTokenSchema.parse(token);
    const p = this.get(agentId,token.proposalId);
    if (p.status !== 'open' || p.revision !== token.revision || p.changeHash !== token.changeHash) throw new CharacterConflictError(`Proposal ${p.status}; reload the current revision.`);
    return p;
  }
  edit(agentId: string, token: ProposalToken, changes: Partial<ProposalDraft>) {
    return this.store.transaction(() => {
      const p = this.check(agentId,token);
      const draft = changes.draft ? mergeDraft(p.draft, changes.draft) : p.draft;
      const value = this.validate(agentId,{...p,...changes,draft});
      value.draft=this.characters.retainDraftSources(agentId,value.draft);
      const revision=p.revision+1, hash=proposalChangeHash(value), now=this.now();
      this.store.getDatabase().prepare('UPDATE bot_character_proposals SET draft_json=?,revision=?,change_hash=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(value),revision,hash,now,p.proposalId);
      this.store.getDatabase().prepare('INSERT INTO bot_character_proposal_revisions VALUES (?,?,?,?,?)').run(p.proposalId,revision,hash,JSON.stringify(value),now);
      return this.get(agentId,p.proposalId);
    });
  }
  decide(agentId: string, token: ProposalToken, decision: 'approve'|'deny', selections: string[]) {
    let stale = false;
    const result = this.store.transaction(() => {
      const p=this.check(agentId,token), db=this.store.getDatabase();
      if (decision === 'deny') {
        db.prepare("UPDATE bot_character_proposals SET status='denied',updated_at=? WHERE id=?").run(this.now(),p.proposalId);
        this.store.decideApproval(p.approvalId,'DENIED','Owner declined character changes.'); return this.get(agentId,p.proposalId);
      }
      const expected=p.bundles.filter(b=>b.selected).map(b=>b.key).sort();
      if (JSON.stringify([...new Set(selections)].sort()) !== JSON.stringify(expected)) throw new CharacterConflictError('Selections changed. Save the card revision before approving.');
      const agent=this.store.getAgent(agentId)!;
      if ((this.characters.getLatestVersion(agentId)?.version ?? 0) !== p.baseVersion || descriptionHash(agent.system_prompt) !== p.expectedDescriptionSha256) {
        db.prepare("UPDATE bot_character_proposals SET status='stale',updated_at=? WHERE id=?").run(this.now(),p.proposalId);
        this.store.decideApproval(p.approvalId,'DENIED','stale'); stale=true; return p;
      }
      const sources=[...(p.draft.sources ?? [])];
      if (p.description !== undefined&&p.descriptionSelected) sources.push({handle:`draft:original-${p.proposalId}`,kind:'description-original',text:agent.system_prompt ?? ''});
      const saved=this.characters.save(agentId,p.baseVersion,{...p.draft,sources,origin:p.kind==='growth'?'review':'chat',approvalId:p.approvalId,proposalId:p.proposalId});
      if (p.description !== undefined&&p.descriptionSelected) this.store.updateAgent(agentId,{system_prompt:p.description});
      for(const b of p.bundles) db.prepare('INSERT INTO bot_character_bundle_items VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?)')
        .run(randomUUID(),agentId,p.proposalId,b.key,b.kind,b.selected?1:0,JSON.stringify(b.input),b.selected?'pending':'skipped',this.now());
      db.prepare("UPDATE bot_character_proposals SET status=?,saved_version=?,updated_at=? WHERE id=?")
        .run(expected.length?'applying':'applied',saved.version,this.now(),p.proposalId);
      this.store.decideApproval(p.approvalId,'APPROVED','Exact character revision approved.');
      return this.get(agentId,p.proposalId);
    });
    if (stale) {
      // Rebase only the proposal, never the active character or the decided approval.
      this.create({agentId,runId:result.runId,kind:result.kind,value:{draft:result.draft,bundles:result.bundles,assumptions:[...result.assumptions.slice(0,19),'The previous card was stale. Review this rebased draft.'],description:result.description}});
      throw new CharacterConflictError('Character or Description changed; a fresh proposal is available.');
    }
    return result;
  }
  items(agentId:string,id:string) {
    this.get(agentId,id);
    return this.store.getDatabase().prepare('SELECT item_key AS key,kind,selected,status,result_json,error FROM bot_character_bundle_items WHERE proposal_id=? ORDER BY rowid').all(id);
  }
  restore(agentId:string,sourceId:string,expected?:string) {
    const source=this.characters.getSource(agentId,sourceId), agent=this.store.getAgent(agentId);
    if (!source || source.kind!=='description-original' || !agent) throw new CharacterNotFoundError('Original Description not found for this bot.');
    const current=agent.system_prompt ?? '', hash=descriptionHash(current);
    if(expected!==undefined) this.store.transaction(()=>{
      if(descriptionHash(this.store.getAgent(agentId)!.system_prompt)!==expected) throw new CharacterConflictError('Description changed. Reload the comparison.');
      this.store.updateAgent(agentId,{system_prompt:source.text});
    });
    return {sourceId,before:current,after:source.text,expectedCurrentSha256:hash};
  }
}
