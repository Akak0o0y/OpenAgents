/**
 * The Tools view in bot settings.
 *
 * Each tool says what it is for and whether it works now, with the fix when it
 * does not - and an Obsidian vault can be connected by folder, without the
 * config file the owner found nobody would open.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotToolsSection } from './BotToolsSection.js';
import { api } from '../lib/transport.js';
import { useCortex } from '../store.js';

const system = {
  missions: [],
  memory: [{ key: 'tone', text: 'Short answers', origin: 'operator', task_run_id: null }],
  vault: { configured: false, path: null, source: null },
  capacity: { used: 0, limit: 2 },
  research: { internet: 'public web search and page reading' },
  browser: { enabled: true, ready: false, installing: false, error: null, active: 0, limit: 2, sessions: [], persistenceErrors: {} },
};

const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

beforeEach(() => {
  vi.restoreAllMocks();
  useCortex.setState({ mcp: [] } as never);
  vi.spyOn(api, 'botSystem').mockResolvedValue(system as never);
  vi.spyOn(api, 'docker').mockResolvedValue({ docker: { state: 'stopped', version: null, message: 'Docker is installed but not running.', detail: null, via: 'docker', checkedAt: 1 } });
  vi.spyOn(api, 'systemAction').mockResolvedValue({});
});

describe('bot tools', () => {
  it('lists each tool with what it is for and whether it works now', async () => {
    render(<BotToolsSection agentId="alpha" agentName="Alpha" />);
    expect(await within(await screen.findByText('Web search and pages').then(() => row('Web search and pages'))).findByText('Available')).toBeInTheDocument();
    expect(within(row('Memory')).getByText('1 note')).toBeInTheDocument();
    expect(await within(row('Code sandbox')).findByText('Docker is installed but not running.')).toBeInTheDocument();
    expect(within(row('MCP servers')).getByText('None installed')).toBeInTheDocument();
    expect(within(row('MCP servers')).getByText('Install one from Marketplace → Plugins.')).toBeInTheDocument();
    expect(within(row('Browser')).getByText('Not installed')).toBeInTheDocument();
  });

  it('installs the browser from its row', async () => {
    const user = userEvent.setup();
    render(<BotToolsSection agentId="alpha" agentName="Alpha" />);
    await user.click(await within(await screen.findByText('Browser').then(() => row('Browser'))).findByRole('button', { name: 'Install' }));
    expect(api.systemAction).toHaveBeenCalledWith('browser-install', {});
  });

  it('connects an Obsidian vault by folder, and disconnects one chosen in the app', async () => {
    const user = userEvent.setup();
    render(<BotToolsSection agentId="alpha" agentName="Alpha" />);
    await user.type(await screen.findByLabelText('Obsidian vault folder'), 'C:\\Vaults\\Work');
    vi.mocked(api.botSystem).mockResolvedValue({ ...system, vault: { configured: true, path: 'C:\\Vaults\\Work', source: 'app' } } as never);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(api.systemAction).toHaveBeenCalledWith('obsidian-vault', { agentId: 'alpha', path: 'C:\\Vaults\\Work' });
    expect(await within(row('Obsidian vault')).findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('C:\\Vaults\\Work')).toBeInTheDocument();

    vi.mocked(api.botSystem).mockResolvedValue(system as never);
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(api.systemAction).toHaveBeenCalledWith('obsidian-vault', { agentId: 'alpha', path: null });
    expect(await screen.findByRole('status')).toHaveTextContent('Vault disconnected.');
  });

  it('shows a refused folder in words', async () => {
    const user = userEvent.setup();
    vi.mocked(api.systemAction).mockRejectedValueOnce(new Error('C:\\Temp does not look like an Obsidian vault'));
    render(<BotToolsSection agentId="alpha" agentName="Alpha" />);
    await user.type(await screen.findByLabelText('Obsidian vault folder'), 'C:\\Temp');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('does not look like an Obsidian vault');
  });
});
