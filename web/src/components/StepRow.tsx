import { useId, useState } from 'react';
import type { RunStep } from '@kernel/cortex/run-steps.js';
import { Icon } from './ui/icons.js';
import { StepCard } from './stepCards.js';

export interface StepRowProps {
  step: RunStep;
  defaultExpanded?: boolean;
  onOpenFile?: (file: { path: string; runId?: string | null }) => void;
  runId?: string | null;
}

const STATUS = { running: 'Running', waiting: 'Waiting', ok: 'Done', error: 'Failed', stopped: 'Stopped' };

export function StepRow({ step, defaultExpanded = false, onOpenFile, runId }: StepRowProps) {
  // Follow live status until the reader makes an explicit disclosure choice.
  const [chosenExpansion, setChosenExpansion] = useState<boolean | null>(null);
  const expanded = chosenExpansion ?? defaultExpanded;
  const detailId = useId();
  const hasDetails = Boolean(step.output || step.diff || step.subject || step.exitCode !== undefined);
  const durationMs = step.endedAt !== undefined ? Math.max(0, step.endedAt - step.startedAt) : null;
  const durationText = durationMs === null ? null : durationMs < 60_000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.floor(durationMs / 60000)}m ${Math.floor(durationMs % 60000 / 1000)}s`;
  const isFileSubject = Boolean(step.subject && ['read', 'diff'].includes(step.card) && !/^[a-z][a-z\d+.-]*:\/\//i.test(step.subject));
  const label = step.subject ? `${step.label}: ${step.subject}` : step.label;

  const heading = <>
    <span className="oh-step-indicator" title={STATUS[step.status]} aria-hidden="true">
      <Icon name={step.status === 'running' ? 'busy' : step.status === 'waiting' ? 'schedule' : step.status === 'ok' ? 'done' : step.status === 'error' ? 'error' : 'stop'} className={step.status === 'running' ? 'oh-step-spinner' : undefined} />
    </span>
    <span className="oh-step-description">
      <span className="oh-step-label">{step.label}</span>
      {step.subject && <span className="oh-step-subject" title={step.subject}>{step.subject}</span>}
    </span>
    <span className="oh-step-meta">
      <span className="oh-step-state">{STATUS[step.status]}</span>
      {durationText && <span className="oh-step-duration">{durationText}</span>}
      {step.exitCode !== undefined && step.exitCode !== 0 && <span className="oh-step-exit-pill">exit {step.exitCode}</span>}
    </span>
    {hasDetails && <span className="oh-step-chevron" aria-hidden="true"><Icon name={expanded ? 'chevronUp' : 'chevronDown'} /></span>}
  </>;

  return (
    <div className={`oh-step-row oh-step-status-${step.status}`} data-testid="step-row" data-status={step.status} data-expanded={expanded && hasDetails}>
      <div className="oh-step-heading">
        {hasDetails ? <button type="button" className="oh-step-header oh-step-interactive" aria-label={label} aria-expanded={expanded} aria-controls={detailId} onClick={() => setChosenExpansion(!expanded)}>{heading}</button>
          : <div className="oh-step-header">{heading}</div>}
        {isFileSubject && onOpenFile && <button type="button" className="oh-step-open-file" onClick={() => onOpenFile({ path: step.subject!, runId })} aria-label={`Open ${step.subject} in workspace viewer`} title="Open file"><Icon name="open" /></button>}
      </div>
      {hasDetails && <div id={detailId} className="oh-step-body" hidden={!expanded} data-testid={expanded ? 'step-body' : undefined}>
        {expanded && <StepCard step={step} onOpenFile={onOpenFile} runId={runId} />}
      </div>}
    </div>
  );
}
