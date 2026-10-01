import type { AgentStore } from './agent-store.js';
import type { DockerSandbox } from '../kernel/docker-sandbox.js';

// Shared by the candidate scan and the revalidation inside each deletion transaction.
const ELIGIBLE = `completed_at < ? AND status IN ('COMPLETED','FAILED','ABORTED','CRASHED')
      AND id NOT IN (SELECT last_run_id FROM missions WHERE last_run_id IS NOT NULL)
      AND id NOT IN (SELECT task_run_id FROM bot_memory WHERE task_run_id IS NOT NULL)
      AND id NOT IN (SELECT task_run_id FROM execution_events WHERE event_type='EXTERNAL_ACTION_STARTED')
      AND id NOT IN (SELECT task_run_id FROM execution_events WHERE event_type='PUBLISH_ATTEMPTED')
      AND id NOT IN (SELECT task_run_id FROM agent_data WHERE category='retention' AND key='hold' AND task_run_id IS NOT NULL)
      AND id NOT IN (SELECT task_run_id FROM agent_data WHERE category='mission-resume' AND task_run_id IS NOT NULL)
      AND id NOT IN (SELECT task_run_id FROM agent_data WHERE category='retention-cleaned' AND task_run_id IS NOT NULL)`;

export class RetentionService {
  constructor(private store: AgentStore, private sandbox: Pick<DockerSandbox, 'destroyWorkspaceVolume' | 'workspaceVolumeName'>) {}
  candidates(days: number, now = Date.now()) {
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Retention must be 1–3650 days.');
    return this.store.getDatabase().prepare(`SELECT id FROM task_runs WHERE ${ELIGIBLE} ORDER BY completed_at LIMIT 100`).all(now - days * 86400000) as { id: string }[];
  }
  private eligible(id: string, cutoff: number): boolean {
    return !!this.store.getDatabase().prepare(`SELECT 1 FROM task_runs WHERE id = ? AND ${ELIGIBLE}`).get(id, cutoff);
  }
  async clean(days: number, dryRun = true, now = Date.now()) {
    const candidates = this.candidates(days, now), cutoff = now - days * 86400000;
    const cleaned: string[] = [], skipped: string[] = []; const errors: Array<{ id: string; error: string }> = [];
    if (dryRun) return { dryRun, candidates: candidates.map(c => c.id), cleaned, skipped, errors };
    for (const { id } of candidates) {
      try {
        if (!this.eligible(id, cutoff)) { skipped.push(id); continue; }
        // Derive from this installation and run, never trust an arbitrary path
        // in bot data. Docker also checks ownership and refuses active volumes.
        await this.sandbox.destroyWorkspaceVolume(this.sandbox.workspaceVolumeName(`task-${id}`));
        const db = this.store.getDatabase();
        const removed = this.store.transaction(() => {
          // Revalidated under the write lock: a Resume, hold or new reference that arrived while the volume was being
          // deleted keeps this run's records. Checked work is restaged from the database, not from the volume.
          if (!this.eligible(id, cutoff)) return false;
          db.prepare('DELETE FROM run_artifacts WHERE task_run_id=?').run(id);
          db.prepare("DELETE FROM agent_data WHERE task_run_id=? AND category IN ('checkpoints','workspaces','verified-work')").run(id);
          db.prepare("DELETE FROM execution_events WHERE task_run_id=? AND event_type NOT IN ('TASK_STARTED','TASK_COMPLETED','TASK_FAILED','WORK_REPORT','WORK_VERIFIED','WORK_ACTION','TOOL_CALL','WORK_PLAN','WORK_TODO','SUBAGENT_DELEGATED','SUBAGENT_COMPLETED')").run(id);
          const toolCallRows = db.prepare("SELECT id, payload_json FROM execution_events WHERE task_run_id=? AND event_type='TOOL_CALL'").all(id) as Array<{ id: number; payload_json: string }>;
          const updateStmt = db.prepare("UPDATE execution_events SET payload_json=? WHERE id=?");
          for (const row of toolCallRows) {
            try {
              const payload = JSON.parse(row.payload_json);
              if (typeof payload.summary === 'string' && payload.summary.length > 300) {
                payload.summary = payload.summary.slice(0, 299) + '…';
              }
              if (typeof payload.observation === 'string' && payload.observation.length > 300) {
                payload.observation = payload.observation.slice(0, 299) + '…';
              }
              delete payload.source;
              delete payload.links;
              if (payload.presentation && typeof payload.presentation === 'object') {
                delete payload.presentation.patch;
              }
              updateStmt.run(JSON.stringify(payload), row.id);
            } catch {
              // Ignore parse errors on malformed payloads
            }
          }
          this.store.setAgentData({ agentId: this.store.getTaskRun(id)!.agent_id, taskRunId: id, category: 'retention-cleaned', key: id, data: { cleanedAt: Date.now() } });
          return true;
        });
        (removed ? cleaned : skipped).push(id);
      } catch (error) { errors.push({ id, error: String(error instanceof Error ? error.message : error) }); }
    }
    return { dryRun, candidates: candidates.map(c => c.id), cleaned, skipped, errors };
  }
}
