import { useEffect } from 'react';
import { useCortex, type LiveAttemptState } from '../store.js';
import { emptyRunActivity, type RunActivity } from '@kernel/cortex/run-steps.js';
import type { EventRow } from './transport.js';

export interface UseRunActivityResult {
  activity: RunActivity;
  events: EventRow[];
  hasActivity: boolean;
  attempt: LiveAttemptState | null;
}

/**
 * Hook to watch a specific run and subscribe to its live RunActivity.
 * Automatically manages watcher reference counting via store's watchRun.
 */
export function useRunActivity(runId?: string | null): UseRunActivityResult {
  const live = useCortex((s) => (runId ? s.liveRuns[runId] : undefined));
  const watchRun = useCortex((s) => s.watchRun);

  useEffect(() => {
    if (!runId) return;
    return watchRun(runId);
  }, [runId, watchRun]);

  const activity = live?.activity ?? emptyRunActivity(runId ?? '');
  const events = live?.events ?? [];
  const attempt = live?.attempt ?? null;
  const hasActivity = events.length > 0 || activity.steps.length > 0 || Boolean(attempt);

  return {
    activity,
    events,
    hasActivity,
    attempt,
  };
}
