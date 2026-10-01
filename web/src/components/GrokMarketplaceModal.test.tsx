/**
 * Marketplace behaviour.
 *
 * Installing a plugin writes the daemon's config file, which is a real and
 * consequential thing to do. The assertions here are about what the UI must
 * NOT claim afterwards: it must not show the plugin as connected, because
 * writing config does not start a process — only a daemon restart does.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokMarketplaceModal } from './GrokMarketplaceModal.js';
import { api, type PluginRow } from '../lib/transport.js';

vi.mock('./BotFace.js', () => ({ BotFace: () => null, usePrefersReducedMotion: () => true }));

function pluginRow(over: Partial<PluginRow> = {}): PluginRow {
  return {
    name: 'filesystem',
    command: 'npx',
    args: [],
    env: {},
    callQuotaPerRun: 50,
    allowedTools: [],
    connectTimeoutMs: 15000,
    connected: false,
    tools: [],
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'plugins').mockResolvedValue({ plugins: [] });
});

function props(overrides: Partial<React.ComponentProps<typeof GrokMarketplaceModal>> = {}) {
  return {
    onClose: () => undefined,
    onImportBot: vi.fn(async () => undefined),
    existingBotIds: [] as string[],
    ...overrides,
  };
}

describe('plugins', () => {
  it('reports successful hot connection and allows reload without restarting',async()=>{
    const user=userEvent.setup();vi.spyOn(api,'installPlugin').mockResolvedValue({server:{name:'filesystem'},configPath:'/repo/config.json',restartRequired:false});const reload=vi.spyOn(api,'reloadPlugins').mockResolvedValue({});
    render(<GrokMarketplaceModal {...props()}/>);await user.click((await screen.findAllByRole('button',{name:'Add'}))[0]);expect(await screen.findByText(/configured and connected. No restart is needed/)).toBeInTheDocument();await user.click(screen.getByRole('button',{name:'Reload plugins'}));await waitFor(()=>expect(reload).toHaveBeenCalledOnce());expect(await screen.findByText('Plugins reloaded.')).toBeInTheDocument();
  });
  it('installs through the daemon and says a restart is what connects it', async () => {
    const user = userEvent.setup();
    const install = vi.spyOn(api, 'installPlugin').mockResolvedValue({
      server: { name: 'filesystem' },
      configPath: '/repo/openhours.config.json',
      restartRequired: true,
    });

    render(<GrokMarketplaceModal {...props()} />);
    await screen.findByText(/Plugins connect after they are added/);
    const addButtons = await screen.findAllByRole('button', { name: 'Add' });
    await user.click(addButtons[0]);

    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    // The command sent must be one the daemon's allowlist accepts.
    expect(install.mock.calls[0][0]).toMatchObject({ name: 'filesystem', command: 'npx' });
    expect(await screen.findByText(/Restart the daemon to start it/)).toBeInTheDocument();
    // ...and it must NOT claim the plugin is connected.
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('reports a refused install verbatim', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'installPlugin').mockRejectedValue(
      new Error('An MCP server named "filesystem" is already configured.')
    );

    render(<GrokMarketplaceModal {...props()} />);
    const addButtons = await screen.findAllByRole('button', { name: 'Add' });
    await user.click(addButtons[0]);

    expect(
      await screen.findByText('An MCP server named "filesystem" is already configured.')
    ).toBeInTheDocument();
  });

  it('offers Remove for a plugin that is already configured', async () => {
    vi.spyOn(api, 'plugins').mockResolvedValue({ plugins: [pluginRow()] });
    const uninstall = vi.spyOn(api, 'uninstallPlugin').mockResolvedValue({
      server: { name: 'filesystem' },
      configPath: '/repo/openhours.config.json',
      restartRequired: true,
    });
    const user = userEvent.setup();

    render(<GrokMarketplaceModal {...props()} />);
    const removeButtons = await screen.findAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[0]);

    await waitFor(() => expect(uninstall).toHaveBeenCalledWith('filesystem'));
    expect(await screen.findByText(/Restart the daemon to stop it/)).toBeInTheDocument();
  });

  it('surfaces a refusal to remove a server an agent still uses', async () => {
    vi.spyOn(api, 'plugins').mockResolvedValue({ plugins: [pluginRow()] });
    vi.spyOn(api, 'uninstallPlugin').mockRejectedValue(
      new Error('"filesystem" is allowlisted for agent(s) atlas.')
    );
    const user = userEvent.setup();

    render(<GrokMarketplaceModal {...props()} />);
    const removeButtons = await screen.findAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[0]);

    expect(
      await screen.findByText('"filesystem" is allowlisted for agent(s) atlas.')
    ).toBeInTheDocument();
  });

  it('shows the daemon real connection state, not a local guess', async () => {
    vi.spyOn(api, 'plugins').mockResolvedValue({
      plugins: [
        pluginRow({ name: 'filesystem', connected: true, tools: ['read', 'write'], callsUsed: 3, quota: 100 }),
        pluginRow({ name: 'git', connected: false, error: 'spawn ENOENT' }),
      ],
    });
    const user = userEvent.setup();
    render(<GrokMarketplaceModal {...props()} />);

    await user.click(await screen.findByRole('button', { name: /2 installed/ }));
    expect(await screen.findByText('filesystem')).toBeInTheDocument();
    expect(screen.getByText(/2 tools · 3\/100 calls used/)).toBeInTheDocument();
    expect(screen.getByText('spawn ENOENT')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
  });

  it('says the private-skills section is empty because there is no such surface', async () => {
    const user = userEvent.setup();
    render(<GrokMarketplaceModal {...props()} />);
    await user.click(await screen.findByRole('button', { name: /0 installed/ }));
    expect(await screen.findByText(/no skill-authoring surface/)).toBeInTheDocument();
  });

  it('opens a plugin detail with its connectors and its real configuration', async () => {
    const user = userEvent.setup();
    render(<GrokMarketplaceModal {...props()} />);
    await user.click(await screen.findByRole('button', { name: /Filesystem/ }));

    expect(await screen.findByRole('link', { name: /View Source/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /1 connector/ }));
    expect(await screen.findByText('filesystem')).toBeInTheDocument();
    expect(screen.getByText('Connector')).toBeInTheDocument();
    expect(screen.getByText(/server-filesystem/)).toBeInTheDocument();
  });

  it('surfaces a plugin-status failure instead of reporting zero installed', async () => {
    vi.spyOn(api, 'plugins').mockRejectedValue(
      new Error('This daemon was started without plugin administration support.')
    );
    const user = userEvent.setup();
    render(<GrokMarketplaceModal {...props()} />);
    await user.click(await screen.findByRole('button', { name: /installed/ }));
    expect(
      await screen.findByText('This daemon was started without plugin administration support.')
    ).toBeInTheDocument();
  });
});

describe('bots', () => {
  it('imports through the daemon and reflects the outcome', async () => {
    const user = userEvent.setup();
    const onImportBot = vi.fn(async () => undefined);
    render(<GrokMarketplaceModal {...props({ onImportBot })} />);

    await user.click(await screen.findByRole('tab', { name: 'Bots' }));
    const addButtons = await screen.findAllByRole('button', { name: 'Add' });
    await user.click(addButtons[0]);

    await waitFor(() => expect(onImportBot).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByRole('button', { name: 'Added' })).not.toHaveLength(0);
  });

  it('reports a refused import and does not mark it added', async () => {
    const user = userEvent.setup();
    const onImportBot = vi.fn(async () => {
      throw new Error('Agent "night-shift" already exists.');
    });
    render(<GrokMarketplaceModal {...props({ onImportBot })} />);

    await user.click(await screen.findByRole('tab', { name: 'Bots' }));
    const addButtons = await screen.findAllByRole('button', { name: 'Add' });
    await user.click(addButtons[0]);

    expect(await screen.findByText('Agent "night-shift" already exists.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Added' })).not.toBeInTheDocument();
  });

  it('marks a bot that already exists as added rather than offering it again', async () => {
    const user = userEvent.setup();
    render(<GrokMarketplaceModal {...props({ existingBotIds: ['night-shift'] })} />);
    await user.click(await screen.findByRole('tab', { name: 'Bots' }));
    expect(await screen.findAllByRole('button', { name: 'Added' })).not.toHaveLength(0);
  });

  it('shows all five template content tabs and says routines are not created by import', async () => {
    const user = userEvent.setup();
    render(<GrokMarketplaceModal {...props()} />);
    await user.click(await screen.findByRole('tab', { name: 'Bots' }));

    const featured = await screen.findAllByRole('button', { name: /OpenAgents/ });
    await user.click(featured[0]);

    for (const tab of ['Instructions', 'Memories', 'Skills', 'Routines', 'Integrations']) {
      expect(await screen.findByRole('button', { name: new RegExp(tab) })).toBeInTheDocument();
    }

    await user.click(screen.getByRole('button', { name: /Routines/ }));
    expect(await screen.findByText(/Importing does not create them/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Memories/ }));
    expect(await screen.findByText(/No memories are packaged/)).toBeInTheDocument();
  });
});
