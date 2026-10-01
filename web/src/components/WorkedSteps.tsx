import { useState } from 'react';
import { useRunActivity } from '../lib/useRunActivity.js';
import { Icon } from './ui/icons.js';
import { ActivityTimeline } from './ActivityTimeline.js';

export interface WorkedStepsProps {
  runId: string;
  onOpenFile?: (file: { path: string; runId?: string | null }) => void;
}

export function WorkedSteps({ runId, onOpenFile }: WorkedStepsProps) {
  const [open, setOpen] = useState(false);
  // Only watch the run and fetch events when expanded
  const { activity, events } = useRunActivity(open ? runId : null);
  const steps = activity.steps;
  const isLoading = open && events.length === 0 && steps.length === 0;

  return (
    <div className="oh-worked-steps" data-testid="worked-steps">
      <button
        type="button"
        className="oh-worked-steps-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Hide work' : 'Show work'}
      >
        <span className="oh-worked-steps-label">
          {open ? 'Hide work' : (steps.length > 0 ? `Show work (${steps.length} steps)` : 'Show work')}
        </span>
        <span className="oh-worked-steps-icon" aria-hidden="true">
          <Icon name={open ? 'chevronUp' : 'chevronDown'} />
        </span>
      </button>

      {open && (
        <div className="oh-worked-steps-content" data-testid="worked-steps-content">
          {isLoading && (
            <div className="oh-worked-steps-loading">Loading steps…</div>
          )}
          {!isLoading && steps.length === 0 && (
            <div className="oh-worked-steps-empty">No steps recorded for this task.</div>
          )}
          {steps.length > 0 && <ActivityTimeline key={runId} steps={steps} runId={runId} onOpenFile={onOpenFile} />}
        </div>
      )}
    </div>
  );
}
