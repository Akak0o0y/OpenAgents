import { useId, useState } from 'react';
import type { RunStep } from '@kernel/cortex/run-steps.js';
import { Icon } from './ui/icons.js';
import { StepRow } from './StepRow.js';

/** Shared presentation for live work and retained history. No events are discarded. */
export function ActivityTimeline({ steps, runId, onOpenFile, live = false }: {
  steps: RunStep[];
  runId?: string | null;
  onOpenFile?: (file: { path: string; runId?: string | null }) => void;
  live?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const cutoff = Math.max(0, steps.length - 5);
  // Only fold successful earlier work. Errors, waits and active actions stay visible.
  const hiddenCount = steps.filter((step, i) => i < cutoff && step.status === 'ok').length;
  const visible = showAll ? steps : steps.filter((step, i) => i >= cutoff || step.status !== 'ok');
  const completed = steps.filter(step => step.status === 'ok').length;
  const failed = steps.filter(step => step.status === 'error').length;
  return <section className="oh-activity-timeline" aria-label="Command activity">
    <div className="oh-timeline-heading">
      <span className="oh-timeline-title"><Icon name="usage" /> Activity</span>
      <span className="oh-timeline-counts">{completed} done{failed > 0 && <span className="oh-timeline-failed">{failed} failed</span>}</span>
    </div>
    {hiddenCount > 0 && <button type="button" className="oh-timeline-history" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll(!showAll)}>
      <Icon name={showAll ? 'chevronUp' : 'more'} />
      {showAll ? 'Show recent activity' : `Show ${hiddenCount} earlier completed ${hiddenCount === 1 ? 'step' : 'steps'}`}
    </button>}
    <div id={listId} className="oh-activity-steps-container" role="list" aria-label="Recorded actions" data-testid="activity-steps" tabIndex={0}>
      {visible.map(step => <div role="listitem" className="oh-timeline-item" key={step.id}>
        <StepRow step={step} defaultExpanded={step.status === 'error' || (live && step.status === 'running')} onOpenFile={onOpenFile} runId={runId} />
      </div>)}
    </div>
  </section>;
}
