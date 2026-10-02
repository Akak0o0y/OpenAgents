import type { AgentStore } from './agent-store.js';
import type { WorkResult } from './work-runtime.js';
import { readVerifiedWork } from './work-checkpoints.js';
import {GoalResults} from './goal-results.js';

function verificationSummary(status: ReturnType<GoalResults['summary']>): string {
  if (status.legacy) return 'No result checklist was recorded; goal completion is not independently verified.';
  if (status.satisfaction === 'not-required') return 'No required external result was declared for this run.';
  if (status.satisfaction === 'verified') return 'All required results have evidence.';
  return `Unresolved: ${status.results.filter(r => r.required && r.state !== 'verified')
    .map(r => `${r.description} (${r.state})`).join('; ')}`;
}

export function saveWorkResult(store: AgentStore, runId: string, result: WorkResult): void {
  const run = store.getTaskRun(runId);
  if (!run) throw new Error('Cannot save a result without its task run.');
  const goals=new GoalResults(store);goals.verifyArtifacts(run.agent_id,runId);
  const satisfaction=goals.summary(run.agent_id,runId);
  const marker='\n\n**Result verification:** ';
  const summary=verificationSummary(satisfaction);
  if(result.goalVerification&&result.report.endsWith(marker+result.goalVerification.summary))result.report=result.report.slice(0,-(marker+result.goalVerification.summary).length);
  result.goalVerification={satisfaction:satisfaction.satisfaction,revision:satisfaction.revision,summary};
  result.report+=marker+summary;
  store.setAgentData({ agentId: run.agent_id, taskRunId: runId, routineId: run.routine_id ?? undefined,
    category: 'work-results', key: runId, data: result });
}

export function readWorkResult(store: AgentStore, runId: string): WorkResult | null {
  const run = store.getTaskRun(runId);
  const row = run && store.getAgentData(run.agent_id, runId, 'work-results');
  if (!row) return null;
  let result = JSON.parse(row.data_json) as WorkResult;
  if(result.goalVerification){
    const current=new GoalResults(store).summary(run!.agent_id,runId);
    if(current.satisfaction!==result.goalVerification.satisfaction||current.revision!==result.goalVerification.revision){
      const marker='\n\n**Result verification:** ',old=marker+result.goalVerification.summary;
      if(result.report.endsWith(old))result.report=result.report.slice(0,-old.length);
      const summary=verificationSummary(current);
      result={...result,goalVerification:{satisfaction:current.satisfaction,revision:current.revision,summary},report:result.report+marker+summary};
    }
  }
  if (result.artifacts.length && !store.getDatabase().prepare('SELECT 1 FROM run_artifacts WHERE task_run_id=? LIMIT 1').get(runId)) {
    result = { ...result, report: `${result.report}\n\nDownloadable files were removed by storage cleanup. The completion record and usage remain.`, artifacts: [] };
  }
  // Older results carry no checked-work metadata and are returned unchanged.
  if (result.checkedWork?.available && readVerifiedWork(store, runId)?.state !== 'verified') {
    result = { ...result, checkedWork: { ...result.checkedWork, available: false,
      reason: 'The checked work is no longer retained: a later action invalidated it, an operator resume moved it to a later attempt, or storage cleanup removed it.' } };
  }
  return result;
}
