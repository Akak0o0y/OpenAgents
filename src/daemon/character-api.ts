import { z } from 'zod';
import { CharacterPosts } from './character-posts.js';
import { CharacterProposals, ProposalTokenSchema, BundleItemSchema } from './character-proposals.js';
import type { CharacterBundles } from './character-bundles.js';
import type { CharacterClaims } from './character-claims.js';
import type { CharacterRhythm } from './character-rhythm.js';
import type { EngagementReader } from './engagement-reader.js';
import type { CharacterRetention } from './character-retention.js';
import type { CharacterGrowth } from './character-growth.js';
import {CharacterAudit,AuditDecisionSchema} from './character-audit.js';
import type {CharacterQualification} from './character-qualification.js';
import type {CharacterReviewService} from './character-review-service.js';
import type { CharacterJournal } from './character-journal.js';
import type { AgentStore } from './agent-store.js';
import type { CharacterStore, SaveCharacterOptions } from './character-store.js';
import type { ProviderConnectionService } from './provider-connections.js';
import { CharacterPreviewService, prepareCharacterDraft } from './character-preview.js';
import { compileCharacterPacket } from './character-compiler.js';
import { CharacterInvalidError, CharacterNotFoundError, DraftSourceEnvelopeSchema } from './character-schema.js';
import { TryItSituationSchema } from './character-speaker.js';
import { MODEL_PRICING } from '../kernel/types.js';

const object = z.record(z.unknown());
const draftShape = { document: object.optional(), settings: object.optional(), sources: z.array(DraftSourceEnvelopeSchema).max(80).optional() };
const baseShape = { agentId: z.string().min(1).max(200) };
const authoring = z.object(draftShape).strict();
const save = z.object({ ...baseShape, ...draftShape, baseVersion: z.number().int().nonnegative(), note: z.string().max(500).optional() }).strict();
const revert = z.object({ ...baseShape, baseVersion: z.number().int().nonnegative(), toVersion: z.number().int().positive() }).strict();
const compile = z.object({ ...baseShape, ...draftShape, surface: z.enum(['owner-chat', 'task-loop', 'public-compose', 'public-review', 'preview', 'code']),
  query: z.string().max(4000).default(''), seed: z.string().max(200).default('studio'), asOf: z.string().datetime().default('2026-09-25T00:00:00.000Z') }).strict();
const preview = z.object({ ...baseShape, draft: authoring.optional(), situation: TryItSituationSchema }).strict();

function checkDraft(draft: { document?: Record<string, unknown> }) {
  const doc = draft.document;
  if (doc && ('schema' in doc || 'version' in doc || (doc.personality && typeof doc.personality === 'object' && 'mappingVersion' in doc.personality))) {
    throw new CharacterInvalidError('Schema, version and mappingVersion are server-owned.');
  }
}

export function characterApi(options: { store: AgentStore; characters: CharacterStore; previews?: CharacterPreviewService;
  journal?: CharacterJournal;
  proposals?: CharacterProposals;
  bundles?: CharacterBundles;
  claims?: CharacterClaims;
  rhythm?: CharacterRhythm;
  reader?: EngagementReader;
  retention?: CharacterRetention;
  growth?: CharacterGrowth;
  audit?:CharacterAudit;qualification?:CharacterQualification;
  reviewService?:CharacterReviewService;
  connections?: ProviderConnectionService;
  inspect?: (input: { agentId: string; document: ReturnType<typeof prepareCharacterDraft>['document']; settings: ReturnType<typeof prepareCharacterDraft>['settings']; query: string; seed: string; asOf: string }) => unknown;
}) {
  return async (method: string, url: URL, body?: unknown, context?: { signal?: AbortSignal }): Promise<{ status: number; body: unknown }> => {
    try {
      if(url.pathname==='/api/system/character-original-descriptions') {
        if(method!=='GET')return {status:405,body:{error:'Use GET.'}};
        const q=z.object({agent:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));
        if(!options.store.getAgent(q.agent))throw new CharacterNotFoundError('Bot not found.');
        return {status:200,body:{items:options.characters.getSources(q.agent,'description-original').slice(0,20).map(s=>({id:s.id,text:s.text}))}};
      }
      if(url.pathname==='/api/system/character-review-backend') {
        if(!options.reviewService)return {status:503,body:{error:'Review backend service unavailable.'}};
        if(method==='GET'){const q=z.object({agent:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));return {status:200,body:options.reviewService.status(q.agent)};}
        if(method==='POST'){const q=z.object({agentId:z.string().min(1),mode:z.enum(['off','shadow','local'])}).strict().parse(body);return {status:200,body:options.reviewService.configure(q.agentId,q.mode)};}
        return {status:405,body:{error:'Use GET or POST.'}};
      }
      if(url.pathname==='/api/system/character-audit-queue') {
        if(method!=='GET')return {status:405,body:{error:'Use GET.'}};
        if(!options.audit||!options.qualification)return {status:503,body:{error:'Audit service unavailable.'}};
        const q=z.object({agent:z.string().min(1),limit:z.coerce.number().int().min(1).max(50).default(20),key:z.string().max(100).optional(),cursor:z.string().max(200).optional(),language:z.string().max(30).optional(),surface:z.string().max(30).optional()}).strict().parse(Object.fromEntries(url.searchParams));
        return {status:200,body:{...options.audit.queue(q.agent,q.limit,q.key,q.cursor,q.language,q.surface),qualification:options.qualification.status(q.agent),recent:options.audit.recent(q.agent)}};
      }
      if(url.pathname==='/api/system/character-audit-label') {
        if(method!=='POST')return {status:405,body:{error:'Use POST.'}};
        if(!options.audit)return {status:503,body:{error:'Audit service unavailable.'}};
        return {status:200,body:options.audit.label(AuditDecisionSchema.parse(body))};
      }
      if(url.pathname==='/api/system/character-audit-history') {
        if(method!=='GET')return {status:405,body:{error:'Use GET.'}};
        if(!options.audit)return {status:503,body:{error:'Audit service unavailable.'}};
        const q=z.object({agent:z.string().min(1),candidate:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));return {status:200,body:{items:options.audit.history(q.agent,q.candidate)}};
      }
      if(url.pathname==='/api/system/character-growth') {
        if(!options.growth)return {status:503,body:{error:'Growth review unavailable.'}};
        if(method==='GET'){const q=z.object({agent:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));return {status:200,body:options.growth.status(q.agent)};}
        if(method==='POST'){const v=z.object({agentId:z.string().min(1)}).strict().parse(body);return {status:200,body:await options.growth.signal(v.agentId)};}
        return {status:405,body:{error:'Use GET or POST.'}};
      }
      if(url.pathname==='/api/system/character-delete-history') {
        if(method!=='POST')return {status:405,body:{error:'Use POST.'}};
        if(!options.retention)return {status:503,body:{error:'Character retention unavailable.'}};
        const v=z.object({agentId:z.string().min(1)}).strict().parse(body);
        return {status:200,body:await options.retention.deleteHistory(v.agentId,context?.signal)};
      }
      if(url.pathname==='/api/system/character-claims') {
        if(!options.claims)return {status:503,body:{error:'Character memory unavailable.'}};
        if(method==='GET'){const q=z.object({agent:z.string().min(1),query:z.string().max(400).default(''),cursor:z.string().max(200).optional(),id:z.string().max(200).optional()}).strict().parse(Object.fromEntries(url.searchParams));return {status:200,body:q.id?{items:options.claims.occurrences(q.agent,q.id)}:options.claims.page(q.agent,q.query,q.cursor)};}
        if(method==='POST'){
          const v=z.object({agentId:z.string().min(1),id:z.string().min(1),action:z.enum(['dismiss','adopt']),baseVersion:z.number().int().nonnegative().optional(),provenance:z.enum(['owner-attested','fictional','verified']).optional()}).strict().parse(body);
          if(v.action==='adopt'&&(v.baseVersion===undefined||!v.provenance))throw new CharacterInvalidError('Adoption requires version and provenance.');
          return {status:200,body:v.action==='dismiss'?options.claims.dismiss(v.agentId,v.id):options.claims.adopt(v.agentId,v.id,v.baseVersion!,v.provenance!)};
        }
        return {status:405,body:{error:'Use GET or POST.'}};
      }
      if(url.pathname==='/api/system/character-rhythm') {
        if(!options.rhythm)return {status:503,body:{error:'Character rhythm unavailable.'}};
        if(method==='GET'){const q=z.object({agent:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));return {status:200,body:options.rhythm.summary(q.agent)};}
        if(method==='POST'){const v=z.object({agentId:z.string().min(1),routineId:z.string().min(1)}).strict().parse(body);return {status:200,body:options.rhythm.override(v.agentId,v.routineId)};}
        return {status:405,body:{error:'Use GET or POST.'}};
      }
      if(url.pathname==='/api/system/character-import-posts'||url.pathname==='/api/system/character-read-engagement') {
        if(method!=='POST')return {status:405,body:{error:'Use POST.'}};
        if(!options.reader)return {status:503,body:{error:'Own-account reader unavailable. Paste samples instead.'}};
        const v=z.object({agentId:z.string().min(1)}).strict().parse(body);
        return {status:200,body:await options.reader.read(v.agentId,context?.signal??new AbortController().signal,url.pathname.endsWith('-engagement'))};
      }
      if (['character-proposal','character-decide','character-proposal-edit','character-description-restore'].some(p=>url.pathname==='/api/system/'+p)) {
        const proposals=options.proposals;
        if(!proposals)return {status:503,body:{error:'Character proposals unavailable.'}};
        if(method==='GET') {
          if(url.pathname.endsWith('-proposal')) {
            const q=z.object({agent:z.string().min(1),id:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));
            return {status:200,body:{proposal:proposals.get(q.agent,q.id),items:proposals.items(q.agent,q.id)}};
          }
          if(url.pathname.endsWith('-restore')) {
            const q=z.object({agent:z.string().min(1),sourceId:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));
            return {status:200,body:proposals.restore(q.agent,q.sourceId)};
          }
          return {status:405,body:{error:'Use POST.'}};
        }
        if(method!=='POST')return {status:405,body:{error:'Use GET or POST.'}};
        if(url.pathname.endsWith('-decide')) {
          const v=ProposalTokenSchema.extend({agentId:z.string().min(1),decision:z.enum(['approve','deny']),selections:z.array(z.string()).max(12)}).strict().parse(body);
          const decided=proposals.decide(v.agentId,v,v.decision,v.selections);
          if(decided.status==='applying'&&options.bundles) await options.bundles.applyPending(decided.proposalId,context?.signal??new AbortController().signal);
          return {status:200,body:proposals.get(v.agentId,v.proposalId)};
        }
        if(url.pathname.endsWith('-edit')) {
          const v=ProposalTokenSchema.extend({agentId:z.string().min(1),changes:z.object({draft:authoring.optional(),description:z.string().max(100000).optional(),descriptionSelected:z.boolean().optional(),bundles:z.array(BundleItemSchema).max(12).optional()}).strict()}).strict().parse(body);
          return {status:200,body:proposals.edit(v.agentId,v,v.changes as Parameters<CharacterProposals['edit']>[2])};
        }
        if(url.pathname.endsWith('-restore')) {
          const v=z.object({agentId:z.string().min(1),sourceId:z.string().min(1),expectedCurrentSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(body);
          return {status:200,body:proposals.restore(v.agentId,v.sourceId,v.expectedCurrentSha256)};
        }
        return {status:405,body:{error:'Use GET.'}};
      }
      if (['character-posts', 'character-post', 'character-metrics', 'character-promote'].some(p => url.pathname === '/api/system/' + p)) {
        if (!options.journal) return { status: 503, body: { error: 'Post history unavailable.' } };
        const posts = new CharacterPosts(options.store, options.characters, options.journal);
        if (url.pathname.endsWith('-promote')) {
          if (method !== 'POST') return { status: 405, body: { error: 'Use POST.' } };
          const v = z.object({ agentId: z.string().min(1), baseVersion: z.number().int().nonnegative(), utteranceId: z.string().min(1) }).strict().parse(body);
          return { status: 200, body: posts.promote(v.agentId, v.baseVersion, v.utteranceId) };
        }
        if (method !== 'GET') return { status: 405, body: { error: 'Use GET.' } };
        const q = Object.fromEntries(url.searchParams);
        if (url.pathname.endsWith('-posts')) {
          const v = z.object({ agent: z.string().min(1), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(1000).optional() }).strict().parse(q);
          return { status: 200, body: posts.list(v.agent, v.limit, v.cursor) };
        }
        if (url.pathname.endsWith('-post')) {
          const v = z.object({ agent: z.string().min(1), id: z.string().min(1).max(200) }).strict().parse(q);
          return { status: 200, body: posts.detail(v.agent, v.id) };
        }
        const v = z.object({ agent: z.string().min(1), version: z.coerce.number().int().positive() }).strict().parse(q);
        return { status: 200, body: posts.metrics(v.agent, v.version) };
      }
      if (url.pathname === '/api/system/character') {
        if (method !== 'GET') return { status: 405, body: { error: 'Use GET for character inspection.' } };
        const query = z.object({ agent: z.string().min(1), versions: z.coerce.number().int().min(1).max(50).optional(),
          version: z.coerce.number().int().positive().optional() }).strict().parse(Object.fromEntries(url.searchParams));
        const draft = prepareCharacterDraft(options.store, options.characters, query.agent);
        const active = options.characters.getLatestVersion(query.agent);
        const selected = query.version ? options.characters.getVersion(query.agent, query.version) : undefined;
        if (query.version && !selected) throw new CharacterNotFoundError('Character version not found for this bot.');
        const packet = compileCharacterPacket({ document: draft.document, settings: draft.settings, surface: 'owner-chat' });
        const reviewerOptions = (options.connections?.list() ?? []).filter(c => c.enabled && c.hasKey).flatMap(c =>
          c.catalog.models.filter(m => m.usable !== false).map(m => ({ modelId: m.id, connectionId: c.id,
            label: `${c.name} / ${m.id}`, price: MODEL_PRICING[m.id] ?? null, availability: m.usable === true ? 'available' : 'unknown' })));
        return { status: 200, body: { version: draft.version, active, document: draft.document, settings: draft.settings,
          summary: { mode: draft.settings.mode, savedAt: active?.created_at ?? null }, meters: packet.meta, openProposal: options.proposals?.open(query.agent) ?? null,
          reviewerOptions, ...(selected ? { selected } : {}), ...(query.versions ? { versions: options.characters.getHistory(query.agent, { limit: query.versions })
            .map(({ version, origin, created_at, note }) => ({ version, origin, createdAt: created_at, note })) } : {}) } };
      }
      if (!['character-save', 'character-revert', 'character-compile', 'character-preview'].some(action => url.pathname === `/api/system/${action}`)) {
        return { status: 404, body: { error: 'Unknown character action.' } };
      }
      if (method !== 'POST') return { status: 405, body: { error: 'Use POST for character actions.' } };
      if (url.search) throw new CharacterInvalidError('Unexpected action query parameters.');
      if (url.pathname.endsWith('-save')) {
        const value = save.parse(body); checkDraft(value);
        prepareCharacterDraft(options.store, options.characters, value.agentId, value as SaveCharacterOptions);
        return { status: 200, body: options.characters.save(value.agentId, value.baseVersion, value as SaveCharacterOptions) };
      }
      if (url.pathname.endsWith('-revert')) {
        const value = revert.parse(body);
        return { status: 200, body: options.characters.revert(value.agentId, value.baseVersion, value.toVersion) };
      }
      if (url.pathname.endsWith('-compile')) {
        const value = compile.parse(body); checkDraft(value);
        const draft = prepareCharacterDraft(options.store, options.characters, value.agentId, value as SaveCharacterOptions);
        const { query, seed, asOf, surface } = value;
        const packet = compileCharacterPacket({ ...draft, surface, query, seed, asOf });
        return { status: 200, body: { packet, inputs: { query, seed, asOf, surface },
          inspection: options.inspect?.({ agentId: value.agentId, document: draft.document, settings: draft.settings, query, seed, asOf }) ?? null } };
      }
      const value = preview.parse(body); checkDraft(value.draft ?? {});
      prepareCharacterDraft(options.store, options.characters, value.agentId, value.draft as SaveCharacterOptions);
      if (!options.previews) return { status: 503, body: { error: 'Character preview service unavailable.' } };
      return { status: 200, body: await options.previews.preview({ ...value, draft: value.draft as SaveCharacterOptions, signal: context?.signal }) };
    } catch (error) {
      if (error instanceof z.ZodError) return { status: 400, body: { error: 'Invalid character request.', code: 'CharacterInvalid',
        issues: error.issues.map(i => `${i.path.join('.')}: ${i.message}`) } };
      if (error && typeof error === 'object' && 'status' in error && 'code' in error && typeof error.status === 'number') {
        return { status: error.status, body: { error: error instanceof Error ? error.message : 'Character request failed.',
          code: error.code, ...('currentVersion' in error ? { currentVersion: error.currentVersion } : {}),
          ...('issues' in error ? { issues: error.issues } : {}) } };
      }
      return { status: context?.signal?.aborted ? 499 : 500, body: { error: context?.signal?.aborted ? 'Preview cancelled.' : 'Character request failed.' } };
    }
  };
}
