/**
 * Storage cleanup, now in Settings → Computer.
 *
 * Deleting is irreversible, so the one rule that matters survived the move: a
 * preview comes first, and the delete action does not exist until it does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StorageCleanup } from './GrokSettingsModal.js';
import { api } from '../lib/transport.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'systemAction').mockResolvedValue({});
});

describe('storage cleanup', () => {
  it('requires a preview before anything can be deleted, then reports what was cleaned', async () => {
    const user = userEvent.setup();
    render(<StorageCleanup />);
    expect(screen.queryByRole('button', { name: /^Clean/ })).not.toBeInTheDocument();

    vi.mocked(api.systemAction).mockResolvedValueOnce({ candidates: ['old-run'] });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(api.systemAction).toHaveBeenCalledWith('retention', { days: 30, dryRun: true });
    expect(await screen.findByText('1 run can be cleaned (up to 100 at a time).')).toBeInTheDocument();

    vi.mocked(api.systemAction).mockResolvedValueOnce({ cleaned: ['old-run'], errors: [] });
    await user.click(screen.getByRole('button', { name: 'Clean 1 run' }));
    expect(api.systemAction).toHaveBeenCalledWith('retention', { days: 30, dryRun: false });
    expect(await screen.findByRole('status')).toHaveTextContent('Cleaned 1 run.');
  });

  it('says so when nothing is old enough, and offers nothing to delete', async () => {
    const user = userEvent.setup();
    render(<StorageCleanup />);
    vi.mocked(api.systemAction).mockResolvedValueOnce({ candidates: [] });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Nothing is old enough to clean.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Clean/ })).not.toBeInTheDocument();
  });
});
