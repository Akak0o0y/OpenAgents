import { z } from 'zod';
import {GoalResults,ResultRequirementsSchema} from './goal-results.js';
import {RoutineAttention} from './routine-attention.js';
import type { MissionService } from './missions.js';
import type { MemoryService } from './memory.js';
import type { RetentionService } from './retention.js';
import type { RunCapacity } from './run-capacity.js';
import type { BrowserTools } from './browser-tools.js';
import type { AgentStore } from './agent-store.js';
import type { RepositoryFetcher } from './repository-snapshot.js';
import { defineRepositoryWork } from './repository-work.js';
import type { ApprovalGate } from './control-plane.js';
import { setBrowserAutonomy, type BrowserAccounts } from './browser-accounts.js';
import type { WorkQuestions } from './work-questions.js';
import type { RepositoryPublication } from './repository-publication.js';
import type { Attachments } from './attachments.js';
import type { BackgroundTasks } from './background-tasks.js';
import type { PublishPolicy } from './publish-policy.js';
import type {FlowStore} from './flow-store.js';
import {describeFlow} from './flow-compile.js';
import { acknowledgeRoutine, pendingForRoutine, pendingOfDeletedRoutines } from './external-effects.js';

export function systemApi(services: { missions: MissionService; memory: MemoryService; retention: RetentionService; capacity: RunCapacity; browser?: BrowserTools; store?: AgentStore; repositories?: Pick<RepositoryFetcher, 'snapshot'>; abort: (id: string) => boolean;
  /** Accounts a bot signs in with; details are write-only here. */
  accounts?: BrowserAccounts; approvals?: ApprovalGate; questions?: WorkQuestions; publication?: RepositoryPublication; attachments?: Attachments; background?:BackgroundTasks;
  /** What internet research this installation can do, for the bot's Tools view. */
  research?: () => unknown;
  /** Must-post routines and unconfirmed posts (Stage 1). Without it the posting fields and routes are absent, as before. */
  publishPolicy?: PublishPolicy;
  flows?:FlowStore;currentFlowKey?:(routineId:string)=>string|null;
  character?: (method: string, url: URL, body: unknown, context?: { signal?: AbortSignal }) => Promise<{ status: number; body: unknown }> }) {
  /**
   * The bot's posting facts for GET /api/system (spec 6.13): every unconfirmed item of
   * its live routines, then every item of its deleted routines, and its must-post rows.
   * The UI shows a deleted routine's item on each routine whose policy origin is the
   * item's (an item with no origin on every routine), which is exactly the set
   * acknowledgeRoutine covers when the owner presses "Checked — continue" there.
   */
  const posting = (agentId: string) => {
    const { store, publishPolicy } = services;
    if (!store || !publishPolicy) return {};
    const items = [...store.listRoutines(agentId).flatMap((routine) => pendingForRoutine(store, routine.id)), ...pendingOfDeletedRoutines(store, agentId)];
    return {
      ...(services.flows?{playbackMode:services.flows.playbackMode(agentId),playbackEnabled:services.flows.playbackEnabled(agentId),flowResponseProof:services.flows.responseProof(agentId),
        flows:services.flows.list(agentId).filter(f=>f.flowKey===services.currentFlowKey?.(f.routineId!)).map(f=>({...f,steps:f.flow?describeFlow(f.flow):[]}))}:{}),
      pendingEffects: items.map(({ routineId, routineName, routineDeleted, runId, at, kind, origin, before, detail }) => ({ routineId, routineName, routineDeleted, runId, at, kind, origin, before, detail })),
      publishPolicies: publishPolicy.list(agentId).map(({ routineId, origin, required, source, evidenceRunId, createdAt, updatedAt }) => ({ routineId, origin, required, source, evidenceRunId, createdAt, updatedAt })),
    };
  };
  return async (method: string, url: URL, body: unknown, context?: { signal?: AbortSignal }): Promise<{ status: number; body: unknown }> => {
    const { missions, memory, retention, capacity, abort } = services;
    const ok = (body: unknown) => ({ status: 200, body });
    try {
      if(url.pathname==='/api/system/routine-attention'){
        if(!services.store)throw new Error('Routine storage unavailable.');const attention=new RoutineAttention(services.store);
        if(method==='GET'){const q=z.object({agent:z.string().min(1),routine:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));return ok(attention.status(q.agent,q.routine));}
        if(method==='POST'){const q=z.object({agentId:z.string().min(1),routineId:z.string().min(1),action:z.literal('resume')}).strict().parse(body);attention.resume(q.agentId,q.routineId);return ok({resumed:true});}
        return {status:405,body:{error:'Unsupported attention action.'}};
      }
      if(url.pathname==='/api/system/expected-results'||url.pathname==='/api/system/goal-results'){
        if(!services.store)throw new Error('Result storage unavailable.');const results=new GoalResults(services.store);
        if(method==='GET'){
          if(url.pathname.endsWith('/goal-results')){const q=z.object({agent:z.string().min(1),run:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));return ok(results.summary(q.agent,q.run));}
          const q=z.object({agent:z.string().min(1),routine:z.string().min(1)}).strict().parse(Object.fromEntries(url.searchParams));return ok({requirements:results.routine(q.agent,q.routine)});
        }
          if(method==='POST'&&url.pathname.endsWith('/expected-results')){const v=z.object({agentId:z.string().min(1),routineId:z.string().min(1),requirements:ResultRequirementsSchema}).strict().parse(body);return ok({requirements:results.saveRoutine(v.agentId,v.routineId,v.requirements)});}
          if(method==='POST'&&url.pathname.endsWith('/goal-results')){const v=z.object({agentId:z.string().min(1),runId:z.string().min(1),baseRevision:z.number().int().nonnegative(),reason:z.string().min(1).max(500),requirements:ResultRequirementsSchema}).strict().parse(body);return ok(results.define(v.agentId,v.runId,v.baseRevision,v.requirements,'owner',v.reason));}
        return {status:405,body:{error:'Unsupported result action.'}};
      }
      if(method==='POST'&&url.pathname==='/api/system/run-cancel'){
        const value=z.object({agentId:z.string().min(1),runId:z.string().min(1)}).strict().parse(body);
        if(services.store?.getTaskRun(value.runId)?.agent_id!==value.agentId)throw new Error('Run not found for this bot.');
        return ok({stopped:abort(value.runId)});
      }
      if(method==='GET'&&url.pathname==='/api/system/active-runs'){
        const q=z.object({agent:z.string().min(1),thread:z.string().min(1).optional()}).strict().parse(Object.fromEntries(url.searchParams));
        if(!services.store)throw new Error('Run store unavailable.');
        const runs=services.store.listTaskRuns(q.agent).filter(r=>r.status==='RUNNING'||r.status==='QUEUED');
        return ok({runs:runs.flatMap(r=>{
          const row=services.store!.getDatabase().prepare("SELECT payload_json FROM execution_events WHERE task_run_id=? AND event_type IN ('TASK_STARTED','RESOURCE_WAIT') ORDER BY id DESC LIMIT 1").get(r.id) as {payload_json:string}|undefined;
          let threadId:string|null=null;try{threadId=JSON.parse(row?.payload_json??'{}').threadId??null;}catch{}
          if(!threadId&&r.task_name.startsWith('chat:'))threadId=r.task_name.slice(5);
          if(threadId&&threadId!==q.thread)return [];
          return [{id:r.id,origin:threadId?'chat':r.routine_id?'routine':'background',status:r.status,startedAt:r.started_at}];
        })});
      }
      if (services.character && (url.pathname === '/api/system/character' || url.pathname.startsWith('/api/system/character-'))) {
        return services.character(method, url, body, context);
      }
      if (method === 'GET' && url.pathname === '/api/system') {
        const agent = z.string().min(1).parse(url.searchParams.get('agent'));
        return ok({ missions: missions.list(agent).map(({ contract_json, ...m }) => ({ ...m, contractId: JSON.parse(contract_json).id })), memory: memory.list(agent), vault: memory.vaultStatus(agent), capacity: { used: capacity.used, limit: capacity.limit }, ...(services.browser ? { browser: services.browser.status(agent) } : {}), ...(services.research ? { research: services.research() } : {}), ...posting(agent) });
      }
      if (method !== 'POST') return { status: 405, body: { error: 'Use POST for system actions.' } };
      if(['/api/system/flow-forget','/api/system/flow-playback','/api/system/flow-acknowledge'].includes(url.pathname)) {
        if(!services.flows||!services.store)throw new Error('Learned flows are unavailable.');
        if(url.pathname.endsWith('-playback')){const v=z.object({agentId:z.string().min(1),mode:z.enum(['auto','on','off'])}).strict().parse(body);return ok({mode:services.flows.setPlaybackMode(v.agentId,v.mode)});}
        const v=z.object({agentId:z.string().min(1),routineId:z.string().min(1)}).strict().parse(body);
        if(services.store.getRoutine(v.routineId)?.agent_id!==v.agentId)throw new Error('Routine belongs to another bot.');
        const key=services.currentFlowKey?.(v.routineId),flow=key?services.flows.get(v.agentId,key):null;
        if(!flow)throw new Error('No current learned flow.');
        if(url.pathname.endsWith('-forget')){services.flows.forget(v.agentId,flow.id);return ok({forgotten:true});}
        const run=services.store.getDatabase().prepare('SELECT id FROM task_runs WHERE routine_id=? AND agent_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(v.routineId,v.agentId) as {id:string}|undefined;
        if(!run)throw new Error('No routine run to acknowledge.');
        return ok({cleared:services.flows.clearAttention(v.agentId,v.routineId,run.id)});
      }
      if (url.pathname.startsWith('/api/system/browser-bridge-') || url.pathname.startsWith('/api/system/browser-connect')) {
        return { status: 410, body: { error: 'The personal-browser extension has been retired. Use the bot-owned browser sign-in flow.' } };
      }
      if (url.pathname === '/api/system/attachment-upload') {
        if (!services.attachments) throw new Error('Attachments are unavailable.');
        return ok(await services.attachments.upload(body));
      }
      if (url.pathname === '/api/system/attachment-read') {
        const value=z.object({id:z.string().uuid()}).strict().parse(body);
        if(!services.attachments)throw new Error('Attachments are unavailable.');
        return ok(services.attachments.read(value.id));
      }
      if (url.pathname === '/api/system/questions') {
        const value = z.object({ agentId: z.string() }).strict().parse(body);
        return ok({ questions: services.questions?.list(value.agentId) ?? [] });
      }
      if(url.pathname==='/api/system/background-tasks'){
        const v=z.object({agentId:z.string()}).strict().parse(body);return ok({tasks:services.background?.list(v.agentId)??[]});
      }
      if(url.pathname==='/api/system/background-continue'){
        const v=z.object({agentId:z.string(),id:z.string().uuid(),instruction:z.string().min(1).max(8000),acknowledgeUncertain:z.boolean().default(false)}).strict().parse(body);
        if(!services.background)throw new Error('Background tasks are unavailable.');return ok(services.background.continue(v.agentId,v.id,v.instruction,v.acknowledgeUncertain));
      }
      if (url.pathname === '/api/system/question-answer') {
        const value = z.object({ agentId: z.string(), id: z.string(), answer: z.string() }).strict().parse(body);
        if (!services.questions) throw new Error('Questions are unavailable.');
        return ok(services.questions.answer(value.agentId, value.id, value.answer));
      }
      if (url.pathname === '/api/system/question-cancel') {
        const value = z.object({ agentId: z.string(), id: z.string() }).strict().parse(body);
        if (!services.questions) throw new Error('Questions are unavailable.');
        services.questions.cancel(value.agentId, value.id);
        return ok({ cancelled: true });
      }
      if (url.pathname === '/api/system/browser-install') {
        if (!services.browser) throw new Error('Browser tools are not configured.');
        return ok(services.browser.install());
      }
      if (url.pathname === '/api/system/browser-live') {
        const value = z.object({ agentId: z.string().min(1) }).strict().parse(body);
        if (!services.browser) throw new Error('Browser tools are unavailable.');
        return ok(await services.browser.liveState(value.agentId));
      }
      if (url.pathname === '/api/system/browser-control') {
        const base = z.object({ agentId: z.string().min(1) });
        const value = z.discriminatedUnion('action', [
          base.extend({ action: z.literal('takeover') }).strict(), base.extend({ action: z.literal('resume') }).strict(),
          base.extend({ action: z.literal('click'), x: z.number().min(0).max(1100), y: z.number().min(0).max(760) }).strict(),
          base.extend({ action: z.literal('type'), text: z.string().min(1).max(8000) }).strict(),
          base.extend({ action: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ControlOrMeta+A']) }).strict(),
          base.extend({ action: z.literal('scroll'), delta: z.number().min(-2000).max(2000) }).strict(),
          base.extend({ action: z.literal('navigate'), url: z.string().url().max(4000) }).strict(),
          base.extend({ action: z.literal('tab'), tab: z.number().int().min(0).max(7) }).strict(),
        ]).parse(body);
        if (!services.browser) throw new Error('Browser tools are unavailable.');
        return ok(await services.browser.control(value.agentId, value));
      }
      if (url.pathname === '/api/system/browser-login-cancel') {
        if (!services.browser) throw new Error('Browser tools are not configured.');
        const value = z.object({ agentId: z.string().min(1), runId: z.string().min(1) }).strict().parse(body);
        // Cancellation remains available even after an approval expires.
        return ok(await services.browser.cancelLogin(value.agentId, value.runId));
      }
      if (['/api/system/browser-login', '/api/system/browser-login-finish', '/api/system/browser-disconnect'].includes(url.pathname)) {
        if (!services.browser) throw new Error('Browser tools are not configured.');
        const value = z.object({ agentId: z.string().min(1), url: z.string().url().max(4000).optional(), approvalId: z.string().optional(), runId: z.string().min(1).optional() }).strict().parse(body);
        const request = value.approvalId ? services.store?.getApproval(value.approvalId) : null;
        if (value.approvalId && (!request || request.agent_id !== value.agentId || request.kind !== 'account-request' || request.status !== 'PENDING')) throw new Error('That sign-in request is no longer available.');
        if (request) {
          const site = JSON.parse(request.payload_json).site;
          const loginSite = value.url ? new URL(value.url).hostname : services.browser.status(value.agentId).sessions.find(s => s.login)?.url;
          if (value.url && new URL(value.url).hostname !== site) throw new Error('Sign in on the website this bot requested.');
          if (!value.url && loginSite && new URL(loginSite).hostname !== site) throw new Error('Return to the requested website before saving.');
        }
        if (url.pathname.endsWith('browser-login')) { if (!value.url) throw new Error('Supply a login URL.'); return ok(await services.browser.beginLogin(value.agentId, value.url)); }
        if (url.pathname.endsWith('browser-login-finish')) {
          // If saving succeeded but queuing the continuation failed, retry from
          // that saved session instead of requiring the human to log in twice.
          const previouslySaved = request && services.browser.connections(value.agentId).find(c => c.site === JSON.parse(request.payload_json).site && c.updatedAt >= request.created_at);
          const result = previouslySaved && !services.browser.status(value.agentId).sessions.some(s => s.login)
            ? { saved: true, ...previouslySaved } : await services.browser.finishLogin(value.agentId, value.runId);
          if (request && result.site !== JSON.parse(request.payload_json).site) throw new Error('The saved sign-in belongs to another website.');
          const questionId = request ? JSON.parse(request.payload_json).questionId : undefined;
          if (questionId && services.questions) services.questions.answer(value.agentId, questionId, `The operator saved sign-in to ${result.site}. Verify actual account access in the browser, then continue the original request without repeating completed external actions.`);
          if (request) services.approvals?.decide(request.id, 'APPROVED', result.verified ? `Verified sign-in to ${result.site}.` : `You confirmed sign-in to ${result.site}. Access will be checked when used.`);
          return ok(result);
        }
        return ok(services.browser.disconnect(value.agentId));
      }
      if (url.pathname === '/api/system/browser-account') {
        if (!services.accounts || !services.store) throw new Error('Saved accounts are not available in this installation.');
        const value = z.object({ agentId: z.string().min(1), site: z.string().min(1).max(300), label: z.string().max(80).optional(), username: z.string().max(500), password: z.string().max(2000), approvalId: z.string().max(200).optional() }).strict().parse(body);
        // Answering the bot's request card: check it really is that request before saving.
        const request = value.approvalId ? services.store.getApproval(value.approvalId) : null;
        if (value.approvalId) {
          if (!request || request.kind !== 'account-request' || request.agent_id !== value.agentId) throw new Error('That card is not an account request from this bot.');
          if (request.status !== 'PENDING') throw new Error('That request was already answered.');
        }
        const account = await services.accounts.save(value.agentId, { site: value.site, label: value.label, username: value.username, password: value.password });
        if (request && services.approvals) services.approvals.decide(request.id, 'APPROVED', `Saved an account for ${account.site}.`);
        return ok({ account: { id: account.id, site: account.site, label: account.label, updatedAt: account.updatedAt } });
      }
      if (url.pathname === '/api/system/browser-account-delete') {
        if (!services.accounts) throw new Error('Saved accounts are not available in this installation.');
        const value = z.object({ agentId: z.string().min(1), id: z.string().min(1).max(200) }).strict().parse(body);
        return ok(services.accounts.remove(value.agentId, value.id));
      }
      if (url.pathname === '/api/system/browser-autonomy') {
        if (!services.store) throw new Error('Browser settings are not available in this installation.');
        const value = z.object({ agentId: z.string().min(1), autonomy: z.enum(['ask', 'accounts', 'always']) }).strict().parse(body);
        if (!services.store.getAgent(value.agentId)) throw new Error('Unknown bot.');
        return ok({ autonomy: setBrowserAutonomy(services.store, value.agentId, value.autonomy) });
      }
      if (url.pathname === '/api/system/repository-work') {
        if (!services.repositories || !services.store) throw new Error('Repository work is not available in this installation.');
        // Pins the snapshot commit and queues isolated work that delivers a reviewable patch; nothing is published.
        return ok(await defineRepositoryWork(services.store, services.repositories, body, AbortSignal.timeout(90_000)));
      }
      if (url.pathname === '/api/system/repository-preview') {
        const value = z.object({ runId: z.string(), base: z.string(), title: z.string() }).strict().parse(body);
        if (!services.publication) throw new Error('Repository publication is unavailable.');
        return ok(await services.publication.preview(value.runId, value.base, value.title));
      }
      if (url.pathname === '/api/system/repository-publish') {
        const value = z.object({ runId: z.string(), approvedDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(body);
        if (!services.publication) throw new Error('Repository publication is unavailable.');
        return ok(await services.publication.publish(value.runId, value.approvedDigest));
      }
      if (url.pathname === '/api/system/missions') return ok({ mission: missions.create(body) });
      if (url.pathname === '/api/system/mission-state') {
        const value = z.object({ id: z.string(), state: z.enum(['PAUSED','ACTIVE','COMPLETED','STOPPED']) }).strict().parse(body);
        const runId = missions.control(value.id, value.state);
        if (runId) abort(runId);
        return ok({ changed: true });
      }
      if (url.pathname === '/api/system/memory') {
        const value = z.object({ agentId: z.string(), key: z.string(), text: z.string() }).strict().parse(body);
        return ok({ entry: memory.save(value.agentId, { key: value.key, text: value.text }, 'operator') });
      }
      if (url.pathname === '/api/system/memory-delete') {
        const value = z.object({ agentId: z.string(), key: z.string() }).strict().parse(body);
        memory.remove(value.agentId, value.key); return ok({ removed: true });
      }
      if (url.pathname === '/api/system/routine-publish-policy') {
        // The owner's must-post switch. set() refuses a routine of another bot.
        const value = z.object({ agentId: z.string().min(1), routineId: z.string().min(1), required: z.boolean() }).strict().parse(body);
        if (!services.publishPolicy) throw new Error('Posting checks are not available in this installation.');
        return ok(services.publishPolicy.set(value.agentId, value.routineId, value.required));
      }
      if (url.pathname === '/api/system/routine-acknowledge') {
        // "Checked — continue": acknowledges every item shown on this routine and never writes a FINISHED.
        const value = z.object({ agentId: z.string().min(1), routineId: z.string().min(1) }).strict().parse(body);
        if (!services.publishPolicy || !services.store) throw new Error('Posting checks are not available in this installation.');
        return ok({ acknowledged: acknowledgeRoutine(services.store, value.agentId, value.routineId) });
      }
      if (url.pathname === '/api/system/obsidian-vault') {
        const value = z.object({ agentId: z.string().min(1), path: z.string().max(1000).nullable() }).strict().parse(body);
        return ok({ vault: memory.setVault(value.agentId, value.path) });
      }
      if (url.pathname === '/api/system/obsidian-import') {
        const value = z.object({ agentId: z.string(), file: z.string(), key: z.string() }).strict().parse(body);
        return ok({ entry: memory.importNote(value.agentId, { file: value.file, key: value.key }) });
      }
      if (url.pathname === '/api/system/obsidian-export') {
        const value = z.object({ agentId: z.string(), key: z.string() }).strict().parse(body);
        return ok(memory.exportNote(value.agentId, value.key));
      }
      if (url.pathname === '/api/system/retention') {
        const value = z.object({ days: z.number().int().min(1).max(3650), dryRun: z.boolean().default(true) }).strict().parse(body);
        return ok(await retention.clean(value.days, value.dryRun));
      }
      return { status: 404, body: { error: 'Unknown system action.' } };
    } catch (error) { return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }; }
  };
}
