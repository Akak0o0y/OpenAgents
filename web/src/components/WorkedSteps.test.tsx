import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkedSteps } from './WorkedSteps.js';
import { useCortex } from '../store.js';
import { api } from '../lib/transport.js';

describe('WorkedSteps', () => {
  beforeEach(() => {
    useCortex.setState({ liveRuns: {} });
    vi.restoreAllMocks();
  });

  it('renders collapsed button initially and does not load events', () => {
    const runEventsSpy = vi.spyOn(api, 'runEvents').mockResolvedValue({ runId: 'run-finished', events: [], latestEventId: null });

    render(<WorkedSteps runId="run-finished" />);

    expect(screen.getByRole('button', { name: 'Show work' })).toBeInTheDocument();
    expect(screen.queryByTestId('worked-steps-content')).not.toBeInTheDocument();
    expect(runEventsSpy).not.toHaveBeenCalled();
  });

  it('loads events and expands when clicked', async () => {
    const user = userEvent.setup();
    let resolveEvents!: (val: { runId: string; events: any[]; latestEventId: number | null }) => void;
    vi.spyOn(api, 'runEvents').mockImplementation(
      () => new Promise((resolve) => { resolveEvents = resolve; })
    );

    render(<WorkedSteps runId="run-100" />);

    const button = screen.getByRole('button', { name: 'Show work' });
    await user.click(button);

    // Watcher is attached and backfill is in flight
    expect(screen.getByText('Loading steps…')).toBeInTheDocument();

    // Resolve backfill with steps
    resolveEvents({
      runId: 'run-100',
      latestEventId: 2,
      events: [
        {
          id: 1,
          task_run_id: 'run-100',
          event_type: 'WORK_ACTION',
          payload: { tool: 'write', path: 'src/index.ts' },
          timestamp: 100,
        },
        {
          id: 2,
          task_run_id: 'run-100',
          event_type: 'TOOL_CALL',
          payload: { tool: 'write', status: 'ok', summary: 'Wrote 42 bytes' },
          timestamp: 200,
        },
      ],
    });

    // Content should show the completed step
    await screen.findByText('Writing files');
    expect(screen.getByText('src/index.ts')).toBeInTheDocument();
  });

  it('collapses and un-watches when clicked again', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'runEvents').mockResolvedValue({ runId: 'run-toggle', events: [], latestEventId: null });

    render(<WorkedSteps runId="run-toggle" />);

    const button = screen.getByRole('button', { name: 'Show work' });
    await user.click(button);

    expect(screen.getByTestId('worked-steps-content')).toBeInTheDocument();
    expect(useCortex.getState().liveRuns['run-toggle']).toBeDefined();

    // Click again to collapse
    await user.click(screen.getByRole('button', { name: 'Hide work' }));
    expect(screen.queryByTestId('worked-steps-content')).not.toBeInTheDocument();
    expect(useCortex.getState().liveRuns['run-toggle']).toBeUndefined();
  });
});
