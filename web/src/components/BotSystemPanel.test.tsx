/**
 * The bot overview in the details panel.
 *
 * It replaced forms nobody could use - a mission form asking for a task
 * contract and run limit, a memory form asking for note keys - so these tests
 * pin the new promise: work is asked for in chat (examples fill the composer),
 * and the panel shows what exists with only the controls that belong to it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotSystemPanel } from './BotSystemPanel.js';
import { api } from '../lib/transport.js';

const state = {
  missions: [{ id: 'm1', objective: 'Prepare release', status: 'WAITING', runs: 1, max_runs: 3, reason: 'External outcome is uncertain', last_run_id: 'run1' }],
  memory: [{ key: 'release', text: 'Release needs review', origin: 'operator', task_run_id: null }],
  vault: { configured: true },
  capacity: { used: 1, limit: 2 },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'botSystem').mockResolvedValue(state as never);
  vi.spyOn(api, 'systemAction').mockResolvedValue({});
  vi.spyOn(api, 'workResult').mockResolvedValue({ result: { report: 'Checked output', outcome: 'COMPLETED' } });
});

describe('bot overview', () => {
  it('keeps empty cards and instructional examples out of the workspace', async () => {
    vi.mocked(api.botSystem).mockResolvedValue({...state, missions:[], memory:[]} as never);
    render(<BotSystemPanel agentId="alpha" />);
    expect(screen.queryByText('Ask in chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Background work')).not.toBeInTheDocument();
    expect(screen.queryByText('What it remembers')).not.toBeInTheDocument();
    expect(screen.queryByText(/work slots/)).not.toBeInTheDocument();
  });

  it('shows background work with its progress, and reconciles a waiting mission explicitly', async () => {
    const user = userEvent.setup();
    render(<BotSystemPanel agentId="alpha" />);
    expect(await screen.findByText('Prepare release')).toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 steps')).toBeInTheDocument();
    expect(screen.getByText(/an interrupted action may already have happened/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Latest result' }));
    expect(await screen.findByText('Checked output')).toBeInTheDocument();
    expect(api.workResult).toHaveBeenCalledWith('run1');

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(api.systemAction).toHaveBeenCalledWith('mission-state', { id: 'm1', state: 'ACTIVE' });

    vi.mocked(api.botSystem).mockResolvedValue({ ...state, missions: [{ ...state.missions[0], status: 'STOPPED' }] } as never);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.systemAction).toHaveBeenCalledWith('mission-state', { id: 'm1', state: 'STOPPED' });
    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('forgets a memory note for this bot and shows a failure', async () => {
    const user = userEvent.setup();
    render(<BotSystemPanel agentId="alpha" settings />);
    expect(await screen.findByText('Release needs review')).toBeInTheDocument();
    expect(screen.getByText('You told it')).toBeInTheDocument();
    vi.mocked(api.systemAction).mockRejectedValueOnce(new Error('Memory unavailable'));
    await user.click(screen.getByRole('button', { name: /^Forget: Release needs review/ }));
    expect(api.systemAction).toHaveBeenCalledWith('memory-delete', { agentId: 'alpha', key: 'release' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Memory unavailable');
  });

  it('lists saved website access in settings and opens a secure sign-in on request', async () => {
    const user=userEvent.setup();
    vi.mocked(api.botSystem).mockResolvedValue({...state, browser:{enabled:true, ready:true, sessions:[], connections:[{site:'github.com', verified:true, updatedAt:1}]}} as never);
    render(<BotSystemPanel agentId="alpha" settings />);
    expect(await screen.findByText('github.com')).toBeInTheDocument();
    expect(screen.getByText('Verified sign-in')).toBeInTheDocument();
    await user.click(screen.getByText('Connect a website'));
    await user.type(screen.getByLabelText('Website to sign in to'), 'example.org');
    await user.click(await screen.findByRole('button', {name:'Sign in securely'}));
    expect(api.systemAction).toHaveBeenCalledWith('browser-login', {agentId:'alpha', url:'https://example.org', approvalId:undefined});
  });

  it('says the browser runs in the sandbox, lists accounts without details, adds and removes one, and sets how freely it acts', async () => {
    const user = userEvent.setup();
    const browser = { enabled: true, ready: true, installing: false, error: null, active: 0, limit: 2, sessions: [], persistenceErrors: {},
      isolation: 'sandbox', sandbox: { state: 'ready', message: 'ready', image: 'openhours-browser' }, autonomy: 'accounts',
      accounts: [{ id: 'acct-1', site: 'github.com', label: 'github.com', updatedAt: 1 }] };
    vi.mocked(api.botSystem).mockResolvedValue({ ...state, browser } as never);
    render(<BotSystemPanel agentId="alpha" settings />);

    await screen.findByText('Connected websites');
    await user.click(screen.getByText('Permissions and saved credentials'));
    expect(screen.getByText('github.com')).toBeInTheDocument();
    expect(screen.getByLabelText('When it may use forms and buttons')).toHaveValue('accounts');

    await user.selectOptions(screen.getByLabelText('When it may use forms and buttons'), 'ask');
    expect(api.systemAction).toHaveBeenCalledWith('browser-autonomy', { agentId: 'alpha', autonomy: 'ask' });

    await user.click(screen.getByText('Saved username and password'));
    expect(screen.getByLabelText('Account password')).toHaveAttribute('type', 'password');
    await user.type(screen.getByLabelText('Account website'), 'example.org');
    await user.type(screen.getByLabelText('Account username'), 'alice');
    await user.type(screen.getByLabelText('Account password'), 'pw-1');
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    expect(api.systemAction).toHaveBeenCalledWith('browser-account', { agentId: 'alpha', site: 'example.org', username: 'alice', password: 'pw-1' });
    expect(await screen.findByText(/Account saved\. The bot can sign in there now\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Account password')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Remove the account for github.com' }));
    expect(api.systemAction).toHaveBeenCalledWith('browser-account-delete', { agentId: 'alpha', id: 'acct-1' });
  });

  it('keeps browser setup details out of the daily workspace', async () => {
    vi.mocked(api.botSystem).mockResolvedValue({...state, browser:{enabled:true, ready:false, sessions:[], sandbox:{state:'downloading', message:'Downloading'}}} as never);
    render(<BotSystemPanel agentId="alpha" />);
    await screen.findByText('Prepare release');
    expect(screen.queryByText('Connected websites')).not.toBeInTheDocument();
    expect(screen.queryByText('Downloading')).not.toBeInTheDocument();
  });
});
