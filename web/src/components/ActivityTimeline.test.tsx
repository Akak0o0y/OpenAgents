import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunStep } from '@kernel/cortex/run-steps.js';
import { ActivityTimeline } from './ActivityTimeline.js';

const steps = (): RunStep[] => Array.from({ length: 60 }, (_, i) => ({
  id: `step-${i}`, tool: 'browser', label: `Action ${i + 1}`, subject: `page-${i + 1}`,
  card: 'browser', status: i === 2 ? 'error' : i === 59 ? 'running' : 'ok',
  startedAt: i * 1000, output: i === 2 ? 'A retained failure' : 'Observed page',
}));

describe('ActivityTimeline', () => {
  it('folds only earlier successes, preserves errors and current work, and restores every step', async () => {
    const user = userEvent.setup();
    render(<ActivityTimeline steps={steps()} live />);
    expect(screen.getAllByTestId('step-row')).toHaveLength(6);
    expect(screen.getByText('A retained failure')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Action 60: page-60' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('58 done')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 54 earlier completed steps' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
    expect(within(screen.getByRole('list')).getAllByTestId('step-row')[0]).toHaveTextContent('Action 1');
    await user.click(screen.getByRole('button', { name: 'Show recent activity' }));
    expect(screen.getAllByTestId('step-row')).toHaveLength(6);
    expect(screen.getByText('A retained failure')).toBeVisible();
  });

  it('keeps waiting and stopped earlier steps visible without calling them done', () => {
    const history = steps(); history[0].status = 'waiting'; history[1].status = 'stopped';
    render(<ActivityTimeline steps={history} />);
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('56 done')).toBeInTheDocument();
  });
});
