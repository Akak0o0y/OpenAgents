import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { api, type TaskRunRow } from './transport.js';
import { useComputerSession } from './useComputerSession.js';

afterEach(() => vi.restoreAllMocks());
it('does not confuse a crashed browser sign-in with a missing Docker code workspace', async () => {
  const probe = vi.spyOn(api, 'workspace').mockRejectedValue(new Error('No retained workspace'));
  const run = { id: 'login-run', task_name: 'browser-login', status: 'CRASHED' } as TaskRunRow;
  const { result } = renderHook(() => useComputerSession('alpha', run));
  await waitFor(() => expect(result.current.state).toBe('not-required'));
  expect(probe).not.toHaveBeenCalled();
  expect(result.current.reason).toBeNull();
});
it('shows a completed plan without a workspace as normal, but retains genuine workspace errors', async () => {
  const probe = vi.spyOn(api, 'workspace').mockResolvedValue({ available: false, required: false, reason: 'This plan needs no computer workspace.' });
  const run = { id: 'plan-run', status: 'COMPLETED' } as TaskRunRow;
  const { result, rerender } = renderHook(({ latest }) => useComputerSession('alpha', latest), { initialProps: { latest: run } });
  await waitFor(() => expect(result.current.state).toBe('not-required'));
  expect(result.current.reason).toContain('needs no computer');
  probe.mockRejectedValueOnce(new Error('Docker workspace was removed.'));
  rerender({ latest: { ...run, id: 'code-run' } });
  await waitFor(() => expect(result.current.state).toBe('unreachable'));
  expect(result.current.reason).toContain('was removed');
});
