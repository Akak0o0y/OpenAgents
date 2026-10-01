import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunStep } from '@kernel/cortex/run-steps.js';
import { StepRow } from './StepRow.js';

function makeStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step-1',
    tool: 'run',
    label: 'Running command',
    subject: 'npm test',
    card: 'terminal',
    status: 'running',
    startedAt: 1000,
    output: 'Checking the workspace',
    ...overrides,
  };
}

describe('StepRow', () => {
  it('uses a native disclosure button linked to its detail region', async () => {
    const user = userEvent.setup();
    render(<StepRow step={makeStep()} />);

    const toggle = screen.getByRole('button', { name: 'Running command: npm test' });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const detailId = toggle.getAttribute('aria-controls');
    expect(detailId).toBeTruthy();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('step-body')).toHaveAttribute('id', detailId);
    expect(screen.getByTestId('step-body')).toHaveTextContent('Checking the workspace');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('step-body')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('toggles once with %s and retains keyboard focus', async (_name, key) => {
    const user = userEvent.setup();
    render(<StepRow step={makeStep()} />);
    const toggle = screen.getByRole('button', { name: 'Running command: npm test' });

    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard(key);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('step-body')).toBeInTheDocument();
    await user.keyboard(key);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('labels a subjectless disclosure using the action label', () => {
    render(<StepRow step={makeStep({ subject: undefined, card: 'generic', label: 'Checking results' })} />);
    expect(screen.getByRole('button', { name: 'Checking results' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('gives separate rows unique disclosure targets', async () => {
    const user = userEvent.setup();
    render(<>
      <StepRow step={makeStep()} />
      <StepRow step={makeStep({ id: 'step-2', subject: 'npm run build' })} />
    </>);
    const first = screen.getByRole('button', { name: 'Running command: npm test' });
    const second = screen.getByRole('button', { name: 'Running command: npm run build' });
    expect(first.getAttribute('aria-controls')).not.toBe(second.getAttribute('aria-controls'));

    await user.click(second);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('step-body')).toHaveAttribute('id', second.getAttribute('aria-controls'));
  });

  it.each(['read', 'diff'] as const)('offers a separate file-opening action for %s cards', async (card) => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const path = 'reports/My report.md';
    render(<StepRow
      step={makeStep({ tool: card === 'read' ? 'read' : 'edit', card, label: 'Reading file', subject: path })}
      runId="run-files"
      onOpenFile={onOpenFile}
    />);

    const toggle = screen.getByRole('button', { name: `Reading file: ${path}` });
    const openFile = screen.getByRole('button', { name: /open/i });
    expect(toggle.contains(openFile)).toBe(false);
    expect(within(toggle).queryByRole('button')).not.toBeInTheDocument();
    expect(document.querySelector('button button')).not.toBeInTheDocument();

    await user.click(openFile);
    expect(onOpenFile).toHaveBeenLastCalledWith({ path, runId: 'run-files' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(onOpenFile).toHaveBeenCalledTimes(2);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard(' ');
    expect(onOpenFile).toHaveBeenCalledTimes(3);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([
    { card: 'terminal' as const, subject: './scripts/check.sh' },
    { card: 'browser' as const, subject: 'https://example.com/report.pdf' },
    { card: 'web' as const, subject: 'https://example.com/report.pdf' },
    { card: 'read' as const, subject: 'https://example.com/report.pdf' },
    { card: 'diff' as const, subject: 'https://example.com/report.pdf' },
  ])('does not offer a workspace file action for $card subject $subject', ({ card, subject }) => {
    render(<StepRow step={makeStep({ card, subject })} onOpenFile={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /open/i })).not.toBeInTheDocument();
  });

  it('follows default expansion through running, successful, and failed updates before user interaction', () => {
    const step = makeStep();
    const { rerender } = render(<StepRow step={step} defaultExpanded />);
    const toggle = screen.getByRole('button', { name: 'Running command: npm test' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    rerender(<StepRow step={{ ...step, status: 'ok', endedAt: 2000 }} defaultExpanded={false} />);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('step-body')).not.toBeInTheDocument();

    rerender(<StepRow step={{ ...step, status: 'error', endedAt: 3000, output: 'Command failed' }} defaultExpanded />);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('step-body')).toHaveTextContent('Command failed');
  });

  it('preserves a user-collapsed choice when a later update recommends expanding', async () => {
    const user = userEvent.setup();
    const step = makeStep();
    const { rerender } = render(<StepRow step={step} defaultExpanded />);
    const toggle = screen.getByRole('button', { name: 'Running command: npm test' });
    await user.click(toggle);

    rerender(<StepRow step={{ ...step, status: 'ok' }} defaultExpanded={false} />);
    rerender(<StepRow step={{ ...step, status: 'error', output: 'Command failed' }} defaultExpanded />);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('step-body')).not.toBeInTheDocument();
  });

  it('preserves a user-expanded choice when later successful output arrives', async () => {
    const user = userEvent.setup();
    const step = makeStep({ status: 'ok' });
    const { rerender } = render(<StepRow step={step} defaultExpanded={false} />);
    const toggle = screen.getByRole('button', { name: 'Running command: npm test' });
    await user.click(toggle);

    rerender(<StepRow step={{ ...step, output: 'Updated output', endedAt: 3000 }} defaultExpanded={false} />);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('step-body')).toHaveTextContent('Updated output');
  });
});
