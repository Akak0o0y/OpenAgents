import type { AgentStore } from './agent-store.js';
import { VERIFIED_WORK_CATEGORY } from './artifacts.js';

/** agent_data category: an operator resume pinning a prior run's checked work until an attempt adopts or rejects it. */
export const MISSION_RESUME_CATEGORY = 'mission-resume';
export const WORK_RESULTS_CATEGORY = 'work-results';

/**
 * Categories owned by runtime services. Saved results decide mission continuation, checked work decides
 * finish eligibility, pins and cleanup markers decide retention, and workspace records name Docker volumes.
 * The public data API may read them but must never create, replace or delete them.
 */
export const INTERNAL_DATA_CATEGORIES: ReadonlySet<string> = new Set([
  'character',
  'browser-flow',
  'goal-results',
  'routine-attention',
  WORK_RESULTS_CATEGORY, VERIFIED_WORK_CATEGORY, MISSION_RESUME_CATEGORY, 'checkpoints', 'workspaces', 'retention-cleaned', 'work-question', 'delegation', 'repository-publication', 'attachment', 'repository-snapshot', 'background-task',
]);

export class ProtectedDataError extends Error {
  override readonly name = 'ProtectedDataError';
}

/** Bot data as exposed to authenticated operators: ordinary categories are editable, runtime-owned ones are read-only. */
export function publicAgentDataApi(store: AgentStore) {
  const refuse = (category: string) => {
    throw new ProtectedDataError(`Category "${category}" is owned by the OpenAgents runtime and cannot be changed through the data API.`);
  };
  return {
    agentData: (agentId?: string, category?: string) => store.listAgentData(agentId, category),
    getAgentDataRecord: (agentId: string, key: string, category?: string) => store.getAgentData(agentId, key, category),
    setAgentDataRecord: (params: { agentId: string; key: string; category?: string; data: unknown }) => {
      const category = params.category ?? 'general';
      if (INTERNAL_DATA_CATEGORIES.has(category)) refuse(category);
      return store.setAgentData({ agentId: params.agentId, key: params.key, category, data: params.data });
    },
    deleteAgentDataRecord: (id: string) => {
      const row = store.getAgentDataById(id);
      if (row && INTERNAL_DATA_CATEGORIES.has(row.category)) refuse(row.category);
      return store.deleteAgentData(id);
    },
  };
}
