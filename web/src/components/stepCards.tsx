import type { RunStep } from '@kernel/cortex/run-steps.js';
import { Icon } from './ui/icons.js';

export function TerminalCard({ step }: { step: RunStep }) {
  const hasContent = Boolean(step.subject || step.output || step.exitCode !== undefined);
  if (!hasContent) return null;

  return (
    <div className="oh-step-card oh-step-card-terminal" data-testid="terminal-card">
      {step.subject && (
        <div className="oh-step-cmd">
          <span className="oh-step-prompt" aria-hidden="true">$</span>
          <code>{step.subject}</code>
          {step.exitCode !== undefined && step.exitCode !== 0 && (
            <span className="oh-step-exit-pill" title={`Exit code ${step.exitCode}`}>
              exit {step.exitCode}
            </span>
          )}
        </div>
      )}
      {step.output && (
        <pre className="oh-step-output" data-testid="step-output">
          <code>{step.output}</code>
        </pre>
      )}
    </div>
  );
}

export function ReadCard({
  step,
  onOpenFile,
  runId,
}: {
  step: RunStep;
  onOpenFile?: (file: { path: string; runId?: string | null }) => void;
  runId?: string | null;
}) {
  const hasContent = Boolean(step.subject || step.output);
  if (!hasContent) return null;

  return (
    <div className="oh-step-card oh-step-card-read" data-testid="read-card">
      {step.subject && (
        <div className="oh-step-file-target">
          <Icon name="file" />
          {onOpenFile ? (
            <button
              type="button"
              className="oh-step-file-link"
              onClick={() => onOpenFile({ path: step.subject!, runId })}
              title={`Open ${step.subject} in workspace viewer`}
            >
              <code>{step.subject}</code>
            </button>
          ) : (
            <code>{step.subject}</code>
          )}
        </div>
      )}
      {step.output && (
        <pre className="oh-step-output" data-testid="step-output">
          <code>{step.output}</code>
        </pre>
      )}
    </div>
  );
}

export function DiffCard({
  step,
  onOpenFile,
  runId,
}: {
  step: RunStep;
  onOpenFile?: (file: { path: string; runId?: string | null }) => void;
  runId?: string | null;
}) {
  const diffContent = step.diff || step.output;
  const hasContent = Boolean(step.subject || diffContent);
  if (!hasContent) return null;

  return (
    <div className="oh-step-card oh-step-card-diff" data-testid="diff-card">
      {step.subject && (
        <div className="oh-step-file-target">
          <span className="oh-step-file-icon" aria-hidden="true">Δ</span>
          {onOpenFile ? (
            <button
              type="button"
              className="oh-step-file-link"
              onClick={() => onOpenFile({ path: step.subject!, runId })}
              title={`Open ${step.subject} in workspace viewer`}
            >
              <code>{step.subject}</code>
            </button>
          ) : (
            <code>{step.subject}</code>
          )}
          {step.diffMeta && (
            <div className="oh-step-diff-meta" data-testid="diff-meta">
              {step.diffMeta.created && (
                <span className="oh-step-diff-pill oh-step-diff-created">
                  new
                </span>
              )}
              {typeof step.diffMeta.added === 'number' && step.diffMeta.added > 0 && (
                <span className="oh-step-diff-pill oh-step-diff-added">
                  +{step.diffMeta.added}
                </span>
              )}
              {typeof step.diffMeta.removed === 'number' && step.diffMeta.removed > 0 && (
                <span className="oh-step-diff-pill oh-step-diff-removed">
                  -{step.diffMeta.removed}
                </span>
              )}
              {step.diffMeta.truncated && (
                <span className="oh-step-diff-pill oh-step-diff-truncated">
                  (truncated)
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {diffContent && (
        <pre className="oh-step-output oh-step-diff-output" data-testid="step-output">
          <code>{diffContent}</code>
        </pre>
      )}
    </div>
  );
}

export function SearchCard({ step }: { step: RunStep }) {
  const hasContent = Boolean(step.subject || step.output);
  if (!hasContent) return null;

  return (
    <div className="oh-step-card oh-step-card-search" data-testid="search-card">
      {step.subject && (
        <div className="oh-step-search-target">
          <Icon name="search" />
          <code>{step.subject}</code>
        </div>
      )}
      {step.output && (
        <pre className="oh-step-output" data-testid="step-output">
          <code>{step.output}</code>
        </pre>
      )}
    </div>
  );
}

export function WebCard({ step }: { step: RunStep }) {
  const hasContent = Boolean(step.subject || step.output);
  if (!hasContent) return null;

  return (
    <div className="oh-step-card oh-step-card-web" data-testid="web-card">
      {step.subject && (
        <div className="oh-step-web-url">
          <Icon name="link" />
          <code>{step.subject}</code>
        </div>
      )}
      {step.output && (
        <pre className="oh-step-output" data-testid="step-output">
          <code>{step.output}</code>
        </pre>
      )}
    </div>
  );
}

export function BrowserCard({ step }: { step: RunStep }) {
  const hasContent = Boolean(step.subject || step.output);
  if (!hasContent) return null;

  return (
    <div className="oh-step-card oh-step-card-browser" data-testid="browser-card">
      {step.subject && (
        <div className="oh-step-browser-header">
          <Icon name="computer" />
          <code>{step.subject}</code>
        </div>
      )}
      {step.output && (
        <pre className="oh-step-output" data-testid="step-output">
          <code>{step.output}</code>
        </pre>
      )}
    </div>
  );
}

export function GenericCard({ step }: { step: RunStep }) {
  const hasContent = Boolean(step.subject || step.output);
  if (!hasContent) return null;

  return (
    <div className="oh-step-card oh-step-card-generic" data-testid="generic-card">
      {step.subject && (
        <div className="oh-step-generic-header">
          <code>{step.subject}</code>
        </div>
      )}
      {step.output && (
        <pre className="oh-step-output" data-testid="step-output">
          <code>{step.output}</code>
        </pre>
      )}
    </div>
  );
}

export function StepCard({
  step,
  onOpenFile,
  runId,
}: {
  step: RunStep;
  onOpenFile?: (file: { path: string; runId?: string | null }) => void;
  runId?: string | null;
}) {
  switch (step.card) {
    case 'terminal':
      return <TerminalCard step={step} />;
    case 'read':
      return <ReadCard step={step} onOpenFile={onOpenFile} runId={runId} />;
    case 'diff':
      return <DiffCard step={step} onOpenFile={onOpenFile} runId={runId} />;
    case 'search':
      return <SearchCard step={step} />;
    case 'web':
      return <WebCard step={step} />;
    case 'browser':
      return <BrowserCard step={step} />;
    case 'generic':
    default:
      return <GenericCard step={step} />;
  }
}
