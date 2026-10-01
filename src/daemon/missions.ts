import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentStore } from './agent-store.js';
import type { IWorkProducer } from './work-producer.js';
import { workTaskDefinition, type WorkContract } from './work-contract.js';
import { readWorkResult } from './work-results.js';
import type { WorkResult } from './work-runtime.js';
import { readVerifiedWork } from './work-checkpoints.js';
import { MISSION_RESUME_CATEGORY } from './internal-data.js';
import type { PreparedRepositoryWork } from './repository-work.js';
import type { RepositoryRef } from './repository-snapshot.js';
import { unmatchedStarts } from './external-effects.js';

/** agent_data category: an operator resume pinning a prior run's checked work until an attempt adopts or rejects it. */
export const MISSION_RESUME = MISSION_RESUME_CATEGORY;

/** A concrete obstacle and the observable condition that permits another attempt. */
export const MissionBlocker = z.object({ kind: z.enum(['missing_input','approval','unavailable_capability','external_dependency']), detail: z.string().trim().min(1).max(2000), resumeWhen: z.string().trim().min(1).max(2000) }).strict();
export const MissionDecision = z.object({ state: z.enum(['continue', 'wait', 'complete']), reason: z.string().min(1).max(2000), nextRequest: z.string().min(1).max(8000).optional(), nextContractId: z.string().max(80).optional(),
  blocker: MissionBlocker.optional(),
}).strict()
  .refine(d => d.state !== 'continue' || !!d.nextRequest, 'Continuing requires a concrete next request.');

/** New live decisions must explain a real wait; old stored decisions remain readable. */
export function validateMissionDecision(decision: z.infer<typeof MissionDecision>): void {
  if (decision.state === 'wait' && !decision.blocker) throw new Error('Waiting requires blocker:{kind:"missing_input"|"approval"|"unavailable_capability"|"external_dependency",detail:"specific obstacle",resumeWhen:"observable condition"}. Unfinished work that a supported contract can do is a reason to continue, not a blocker.');
  if (decision.state !== 'wait' && decision.blocker) throw new Error('A blocked mission must wait. Remove the blocker only if work can proceed.');
  if (decision.state === 'complete' && (decision.nextRequest || decision.nextContractId)) throw new Error('A complete mission cannot also request further work. Continue if a deliverable remains.');
}

export function missionDecisionSummary(decision: z.infer<typeof MissionDecision>): string {
  return `${decision.reason}${decision.blocker ? `\nWaiting for: ${decision.blocker.detail}\nResume when: ${decision.blocker.resumeWhen}` : ''}`;
}

/** The validated wait of a model-authored block: no deliverable, never a completed run. Anything else is an ordinary failure. */
export function blockedMissionWait(result: WorkResult | null): z.infer<typeof MissionDecision> | undefined {
  if (!result || result.outcome !== 'FAILED' || result.blocked?.declaredBy !== 'model' || result.artifacts.length || !result.mission?.blocker) return undefined;
  const parsed = MissionDecision.safeParse(result.mission);
  if (!parsed.success || parsed.data.state !== 'wait') return undefined;
  try { validateMissionDecision(parsed.data); return parsed.data; } catch { return undefined; }
}
const createSchema = z.object({ agentId: z.string(), objective: z.string().min(1).max(8000), contractId: z.string(),
  maxRuns: z.number().int().min(1).max(100).default(10), intervalMs: z.number().int().min(60000).max(604800000).default(300000) }).strict();
export interface MissionRow { id: string; agent_id: string; objective: string; contract_json: string; status: 'ACTIVE' | 'PAUSED' | 'WAITING' | 'COMPLETED' | 'STOPPED';
  max_runs: number; runs: number; interval_ms: number; next_at: number; last_run_id: string | null; request: string; reason: string }

/** Persistent finite missions. One run at a time, with explicit decisions after checked delivery. */
export class MissionService implements IWorkProducer {
  private running = false;
  constructor(private store: AgentStore, private contracts: WorkContract[], private maxQueue: number, private now = Date.now) {
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, objective TEXT NOT NULL,
      contract_json TEXT NOT NULL, status TEXT NOT NULL, max_runs INTEGER NOT NULL, runs INTEGER NOT NULL DEFAULT 0,
      interval_ms INTEGER NOT NULL, next_at INTEGER NOT NULL, last_run_id TEXT, request TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS missions_due ON missions(status, next_at);
      CREATE TABLE IF NOT EXISTS mission_items (
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, url TEXT NOT NULL,
        state TEXT NOT NULL, task_run_id TEXT NOT NULL, note TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(mission_id,url));`);
  }
  itemsForRun(runId: string) {
    const mission = this.store.getDatabase().prepare('SELECT id FROM missions WHERE last_run_id=?').get(runId) as { id: string } | undefined;
    if (!mission) throw new Error('Issue tracking is only available inside a mission step.');
    return this.store.getDatabase().prepare('SELECT url,state,task_run_id,note FROM mission_items WHERE mission_id=? ORDER BY rowid LIMIT 100').all(mission.id) as Array<{url: string; state: string; task_run_id: string; note: string}>;
  }
  trackIssue(runId: string, value: string, disposition: 'selected' | 'rejected', reason: string) {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password || !/^\/[^/]+\/[^/]+\/issues\/[1-9]\d*\/?$/.test(url.pathname)) throw new Error('Use the canonical public GitHub issue URL.');
    const key = `https://github.com${url.pathname.replace(/\/$/, '').toLowerCase()}`;
    return this.store.transaction(() => {
      const db = this.store.getDatabase();
      const mission = db.prepare("SELECT id FROM missions WHERE last_run_id=? AND status='ACTIVE'").get(runId) as { id: string } | undefined;
      if (!mission || this.store.getTaskRun(runId)?.status !== 'RUNNING') throw new Error('Issue selection requires an active mission step.');
      const existing = this.itemsForRun(runId).find(item => item.url === key);
      if (existing) return { accepted: existing.task_run_id === runId && existing.state === disposition, item: existing };
      if (this.itemsForRun(runId).length >= 100) throw new Error('This mission has reached its 100-issue tracking limit.');
      db.prepare('INSERT INTO mission_items(mission_id,url,state,task_run_id,note,updated_at) VALUES (?,?,?,?,?,?)').run(mission.id, key, disposition, runId, reason.slice(0, 1000), this.now());
      return { accepted: true, item: { url: key, state: disposition, task_run_id: runId, note: reason.slice(0, 1000) } };
    });
  }
  /** A mission may enter repository work only through an issue selected during its current running step. */
  selectedIssueForRepository(runId: string, target: Pick<RepositoryRef, 'owner' | 'repo'>) {
    const db = this.store.getDatabase();
    const mission = db.prepare("SELECT id,runs,max_runs FROM missions WHERE last_run_id=? AND status='ACTIVE'").get(runId) as { id: string; runs: number; max_runs: number } | undefined;
    if (!mission || this.store.getTaskRun(runId)?.status !== 'RUNNING') throw new Error('Repository work requires an active mission step.');
    if (mission.runs >= mission.max_runs) throw new Error('This mission has no remaining attempt for the repository change.');
    const prefix = `https://github.com/${target.owner}/${target.repo}/issues/`.toLowerCase();
    const item = (db.prepare("SELECT url,state,task_run_id,note FROM mission_items WHERE mission_id=? AND task_run_id=? AND state='selected' ORDER BY rowid").all(mission.id, runId) as Array<{ url: string; state: string; task_run_id: string; note: string }>)
      .find(candidate => candidate.url.startsWith(prefix));
    if (!item) throw new Error(`Select a captured issue from ${target.owner}/${target.repo} in this mission step before requesting repository work.`);
    return item;
  }
  /** Stages the pinned repository contract atomically with the current run's terminal result. */
  stageRepositoryStep(runId: string, prepared: PreparedRepositoryWork) {
    return this.store.transaction(() => {
      const item = this.selectedIssueForRepository(runId, prepared.target);
      const db = this.store.getDatabase();
      const mission = db.prepare("SELECT id FROM missions WHERE last_run_id=? AND status='ACTIVE'").get(runId) as { id: string };
      const pinned = prepared.snapshot.commit!;
      db.prepare('UPDATE missions SET contract_json=? WHERE id=?').run(JSON.stringify(prepared.contract), mission.id);
      db.prepare("UPDATE mission_items SET state='queued',note=?,updated_at=? WHERE mission_id=? AND url=? AND task_run_id=? AND state='selected'")
        .run(`Repository work approved at commit ${pinned}; fixed test command: ${prepared.testCommand}. Nothing is published.`, this.now(), mission.id, item.url, runId);
      return { missionId: mission.id, issue: item.url, commit: pinned };
    });
  }
  list(agentId?: string): MissionRow[] {
    const db = this.store.getDatabase();
    return (agentId ? db.prepare('SELECT * FROM missions WHERE agent_id = ? ORDER BY rowid DESC').all(agentId) : db.prepare('SELECT * FROM missions ORDER BY rowid DESC').all()) as unknown as MissionRow[];
  }
  create(input: unknown) {
    const value = createSchema.parse(input);
    if (!this.store.getAgent(value.agentId)) throw new Error('Unknown bot.');
    const contract = this.contracts.find(c => c.id === value.contractId);
    if (!contract) throw new Error('Unsupported task contract.');
    if (this.list(value.agentId).filter(m => !['COMPLETED', 'STOPPED'].includes(m.status)).length >= 20) throw new Error('Bot has reached its mission limit (20).');
    const id = randomUUID();
    this.store.getDatabase().prepare(`INSERT INTO missions(id,agent_id,objective,contract_json,status,max_runs,interval_ms,next_at,request) VALUES (?,?,?,?,'ACTIVE',?,?,?,?)`)
      .run(id, value.agentId, value.objective, JSON.stringify(contract), value.maxRuns, value.intervalMs, this.now(), value.objective);
    return this.list(value.agentId).find(m => m.id === id)!;
  }
  control(id: string, state: 'PAUSED' | 'ACTIVE' | 'COMPLETED' | 'STOPPED') {
    const mission = this.list().find(m => m.id === id);
    if (!mission) throw new Error('Mission not found.');
    if (!['PAUSED', 'ACTIVE', 'COMPLETED', 'STOPPED'].includes(state)) throw new Error('Invalid mission state.');
    if (mission.status === 'STOPPED' && state !== 'STOPPED') throw new Error('This mission was stopped. Create a new bounded mission to continue.');
    if (state === 'ACTIVE' && mission.runs >= mission.max_runs) throw new Error('Mission run limit reached. Create a new bounded mission to continue.');
    // Resume is an operator reconciliation point. It permits a new attempt,
    // never a replay of a dispatched action. The UI displays the previous run.
    const run = mission.last_run_id && this.store.getTaskRun(mission.last_run_id);
    const settled = !!run && !['QUEUED','RUNNING'].includes(run.status);
    // Resuming a wait keeps its recorded obstacle visible to the operator and the next attempt.
    const reason = state === 'ACTIVE' && mission.status === 'WAITING' ? `Operator resumed after: ${mission.reason}`.slice(0, 2000) : state === 'STOPPED' ? 'Operator stopped the mission; the objective is not marked complete.' : 'Operator set mission state.';
    this.store.transaction(() => {
      this.store.getDatabase().prepare('UPDATE missions SET status=?, reason=?, next_at=?, last_run_id=? WHERE id=?')
        .run(state, reason, this.now(), state === 'ACTIVE' && settled ? null : mission.last_run_id, id);
      // Explicit resume is the only path that offers a prior run's still-valid checks; the attempt re-validates them.
      if (state === 'ACTIVE' && run && settled && readVerifiedWork(this.store, run.id)?.state === 'verified')
        this.store.setAgentData({ agentId: mission.agent_id, taskRunId: run.id, category: MISSION_RESUME, key: id, data: { runId: run.id, requestedAt: this.now() } });
      if (state === 'COMPLETED' || state === 'STOPPED') this.store.getDatabase().prepare('DELETE FROM agent_data WHERE agent_id=? AND category=? AND key=?').run(mission.agent_id, MISSION_RESUME, id);
    });
    return run && !settled && state !== 'ACTIVE' ? run.id : null;
  }
  async start() { this.running = true; }
  async stop() { this.running = false; }
  canRun(runId: string) {
    const mission = this.store.getDatabase().prepare('SELECT status FROM missions WHERE last_run_id=?').get(runId) as { status: string } | undefined;
    return !mission || mission.status === 'ACTIVE';
  }
  async produceNextTasks(_store: AgentStore) {
    if (!this.running) return 0;
    let created = 0;
    for (const mission of this.list().reverse()) {
      if (mission.status !== 'ACTIVE') continue;
      const agent = this.store.getAgent(mission.agent_id);
      if (!agent || ['PAUSED','DISABLED'].includes(agent.current_status)) continue;
      const db = this.store.getDatabase();
      // A pin is abandoned once this mission can never start another attempt.
      const releasePin = () => db.prepare('DELETE FROM agent_data WHERE agent_id=? AND category=? AND key=?').run(mission.agent_id, MISSION_RESUME, mission.id);
      if (mission.last_run_id) {
        const run = this.store.getTaskRun(mission.last_run_id);
        if (run && ['QUEUED','RUNNING'].includes(run.status)) continue;
        const events = this.store.getTaskEvents(mission.last_run_id);
        // Keyed actionId ?? callId ?? 'external' (external-effects.ts). An emitter that sets
        // neither id pairs its STARTED and FINISHED under the shared key, as before.
        const pending = unmatchedStarts(events);
        const result = readWorkResult(this.store, mission.last_run_id);
        // Prepared records a verified step about an issue, never a claim of fixing or publishing it.
        db.prepare("UPDATE mission_items SET state=?,note=?,updated_at=? WHERE task_run_id=? AND state IN ('selected','working')").run(
          run?.status === 'COMPLETED' && result?.artifacts.length ? 'prepared' : 'blocked',
          run?.status === 'COMPLETED' && result?.artifacts.length ? 'Verified step delivered; publication is not established.' : 'Attempt stopped; inspect its evidence before further work.', this.now(), mission.last_run_id);
        const decision = result?.mission;
        const blocked = run?.status === 'FAILED' && pending.size === 0 ? blockedMissionWait(result) : undefined;
        if (run?.status === 'CRASHED' && pending.size === 0) {
          mission.reason = 'Interrupted local work; starting a fresh bounded attempt.';
        } else if (blocked) {
          db.prepare("UPDATE missions SET status='WAITING', reason=? WHERE id=?").run(missionDecisionSummary(blocked), mission.id);
          if (mission.runs >= mission.max_runs) releasePin();
          continue;
        } else if (run?.status !== 'COMPLETED' || !decision || pending.size) {
          db.prepare("UPDATE missions SET status='WAITING', reason=? WHERE id=?").run(pending.size ? 'External action outcome is uncertain. Inspect the last run and reconcile before Resume; a new attempt may repeat work.' : run?.error_message ?? 'Work stopped. Review the last run before resuming.', mission.id);
          if (mission.runs >= mission.max_runs) releasePin();
          continue;
        } else if (decision.state !== 'continue') {
          db.prepare('UPDATE missions SET status=?, reason=? WHERE id=?').run(decision.state === 'complete' ? 'COMPLETED' : 'WAITING', missionDecisionSummary(decision), mission.id);
          if (decision.state === 'complete' || mission.runs >= mission.max_runs) releasePin();
          continue;
        } else {
          const nextContract = decision.nextContractId ? this.contracts.find(c => c.id === decision.nextContractId) : JSON.parse(mission.contract_json) as WorkContract;
          if (!nextContract) {
            db.prepare("UPDATE missions SET status='WAITING', reason='The requested next contract is unavailable.' WHERE id=?").run(mission.id);
            continue;
          }
          mission.contract_json = JSON.stringify(nextContract);
          const previous = db.prepare("SELECT path,content,sha256 FROM run_artifacts WHERE task_run_id=? AND purpose='deliverable' ORDER BY path LIMIT 8").all(mission.last_run_id);
          mission.request = `${decision.nextRequest!}\nPrevious verified delivery (data):\n${JSON.stringify(previous).slice(0,16000)}`;
          mission.reason = decision.reason;
        }
        db.prepare('UPDATE missions SET last_run_id=NULL, request=?, reason=?, next_at=?, contract_json=? WHERE id=?')
          .run(mission.request, mission.reason, this.now() + mission.interval_ms, mission.contract_json, mission.id);
        continue;
      }
      if (mission.runs >= mission.max_runs) {
        db.prepare("UPDATE missions SET status='WAITING', reason='Mission run limit reached.' WHERE id=?").run(mission.id); releasePin(); continue;
      }
      if (mission.next_at > this.now()) continue;
      const count = db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE status IN ('QUEUED','RUNNING')").get() as { n: number };
      if (count.n >= this.maxQueue) break;
      db.exec('BEGIN IMMEDIATE');
      try {
        const definition = workTaskDefinition(JSON.parse(mission.contract_json), `Mission objective:\n${mission.objective}\nCurrent step:\n${mission.request}\nPrevious decision:\n${mission.reason}\nRemaining attempts: ${mission.max_runs - mission.runs}`);
        definition.work!.mission = true;
        // The step request mixes operator text with model-written decisions and deliveries; keep the operator's words separately citeable.
        definition.work!.objective = mission.objective;
        const resume = this.store.getAgentData(mission.agent_id, mission.id, MISSION_RESUME);
        const pinned = resume ? JSON.parse(resume.data_json) as { runId: string; requestedAt: number } : undefined;
        if (pinned) definition.work!.prior = { runId: pinned.runId };
        const run = this.store.createTaskRun({ agentId: agent.id, modelId: agent.model_id, taskName: `mission:${mission.id}` });
        this.store.setRunDefinition(run.id, definition);
        if (definition.work!.contract.repository) {
          db.prepare("UPDATE mission_items SET state='working',task_run_id=?,note=?,updated_at=? WHERE mission_id=? AND state='queued'")
            .run(run.id, `Repository work is running at commit ${definition.work!.contract.repository.commit ?? definition.work!.contract.repository.ref}. Nothing is published.`, this.now(), mission.id);
        }
        // The pin keeps protecting the checked work while this run awaits admission; the attempt releases it on adoption or rejection.
        if (pinned) this.store.setAgentData({ agentId: mission.agent_id, taskRunId: pinned.runId, category: MISSION_RESUME, key: mission.id, data: { ...pinned, queuedRunId: run.id } });
        db.prepare('UPDATE missions SET runs=runs+1,last_run_id=? WHERE id=?').run(run.id, mission.id);
        db.exec('COMMIT'); created++;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    return created;
  }
}
