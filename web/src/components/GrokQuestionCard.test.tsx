/**
 * The card a bot raises when it needs an account.
 *
 * The owner wants to hand a bot the details for an account and let it sign in
 * by itself. The card is where those details are typed: they go straight to the
 * daemon (which encrypts them and approves the card), never into the
 * conversation - so the form must post them there, hide the password, and let
 * the person decline instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokQuestionCard, describeApproval, parseApproval } from './GrokQuestionCard.js';
import { api, type ApprovalRow } from '../lib/transport.js';

const row: ApprovalRow = {
  id: 'approval-1', task_run_id: 'run-1', agent_id: 'alpha', kind: 'account-request', status: 'PENDING', created_at: 1, waiting: true,
  payload_json: JSON.stringify({ site: 'github.com', reason: 'Star the repository you named.', question: 'Give Alpha an account for github.com?',
    points: ['Star the repository you named.', 'The details are encrypted on this computer. Alpha types them only on github.com and never sees them.'] }),
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'botSystem').mockResolvedValue({ browser: {sessions: []} } as never);
  vi.spyOn(api, 'systemAction').mockImplementation(async (action) => action === 'browser-login'
    ? { opened: true, desktop: true }
    : { saved: true, verified: false });
});

describe('account request card', () => {
  it('opens bot-owned sign-in with the approval and saves without claiming verification', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<GrokQuestionCard approval={parseApproval(row)} busy={false} onAnswer={onAnswer} />);
    expect(screen.getByText('Give Alpha an account for github.com?')).toBeInTheDocument();
    expect(screen.getByText(/never sees them/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();

    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', {name: 'Sign in securely'}));
    expect(api.systemAction).toHaveBeenCalledWith('browser-login', {agentId:'alpha', url:'https://github.com', approvalId:'approval-1'});
    expect(screen.getByTitle('Bot desktop — Chrome')).toHaveAttribute('src', '/api/desktop/alpha/viewer.html');
    await user.click(screen.getByRole('button', {name: 'Save sign-in'}));
    expect(api.systemAction).toHaveBeenCalledWith('browser-login-finish', {agentId:'alpha', approvalId:'approval-1'});
    expect(screen.getByText(/Sign-in saved/)).toBeInTheDocument();
    expect(screen.queryByTitle('Bot desktop — Chrome')).not.toBeInTheDocument();
    expect(screen.queryByText('Sign-in verified.')).not.toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('shows why a save failed, and declines on "Not now"', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    vi.mocked(api.systemAction).mockRejectedValueOnce(new Error('Protected storage is unavailable on this computer.'));
    render(<GrokQuestionCard approval={parseApproval(row)} busy={false} onAnswer={onAnswer} />);
    await user.click(await screen.findByRole('button', {name: 'Sign in securely'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Protected storage is unavailable on this computer.');
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onAnswer).toHaveBeenCalledWith('approval-1', 'deny');
  });

  it('describes an account request in words when the payload has no question', () => {
    expect(describeApproval('account-request', { site: 'example.org', reason: 'Download the invoice.' })).toEqual({
      title: 'Sign in to example.org?',
      points: ['Download the invoice.', 'Sign in securely in a separate window. Your session is saved only for this bot.'],
    });
  });
});
