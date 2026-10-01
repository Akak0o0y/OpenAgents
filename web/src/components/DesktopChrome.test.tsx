/**
 * Window chrome behaviour.
 *
 * Three things this has to get right, and all three were wrong or absent at
 * some point:
 *
 *   1. In a plain browser there is no shell, and the chrome must not render at
 *      all - the same bundle serves both, so a stray titlebar in a browser tab
 *      is a real failure mode.
 *   2. A daemon that failed to boot must open its own log without being asked,
 *      and must still close when the operator closes it. That needs three
 *      states, not two, and a boolean silently gave it two.
 *   3. The button must say what it will actually do. Against a daemon this app
 *      only attached to, it cannot restart anything - it can look for it again.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesktopChrome } from './DesktopChrome.js';
import type { DaemonState, ShellInfo } from '../lib/desktop.js';

const info: ShellInfo = {
  platform: 'win32',
  backdrop: 'acrylic',
  isDev: false,
  daemonPort: 4001,
  versions: { electron: '44.0.0', chrome: '152', node: '24' },
  systemTheme: 'dark',
};

function installBridge(state: DaemonState, log: string[] = []) {
  const restart = vi.fn(async () => state);
  const command = vi.fn(async (_which: string) => ({ maximized: false, fullScreen: false }));
  window.openhours = {
    isDesktop: true,
    info: async () => info,
    window: {
      minimize: () => command('minimize'),
      toggleMaximize: () => command('maximize'),
      close: () => command('close'),
      onState: () => () => undefined,
    },
    daemon: {
      status: async () => ({ state, log }),
      restart,
      onState: () => () => undefined,
      onLog: () => () => undefined,
    },
    theme: { onSystemChange: () => () => undefined },
  } as unknown as typeof window.openhours;
  return { restart, command };
}

const attached: DaemonState = {
  status: 'attached',
  port: 4001,
  owned: false,
  detail: 'Attached to a daemon already running on port 4001.',
};

const failed: DaemonState = {
  status: 'failed',
  port: 4001,
  owned: false,
  detail: 'The daemon did not answer on port 4001 within 45s.',
};

const ours: DaemonState = {
  status: 'running',
  port: 4001,
  owned: true,
  detail: 'Started a daemon on port 4001.',
};

afterEach(() => {
  delete (window as { openhours?: unknown }).openhours;
});

describe('outside the desktop shell', () => {
  it('renders nothing at all', () => {
    const { container } = render(<DesktopChrome />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the titlebar', () => {
  it('draws window controls on Windows, with accessible names', async () => {
    installBridge(attached);
    render(<DesktopChrome />);

    await screen.findByRole('button', { name: 'Minimize' });
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('leaves the window controls to macOS, which draws its own', async () => {
    installBridge(attached);
    window.openhours!.info = async () => ({ ...info, platform: 'darwin' });
    render(<DesktopChrome />);

    await screen.findByRole('button', { name: /daemon/i });
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('sends the window command the button names', async () => {
    const { command } = installBridge(attached);
    render(<DesktopChrome />);

    await userEvent.click(await screen.findByRole('button', { name: 'Minimize' }));
    expect(command).toHaveBeenCalledWith('minimize');
  });
});

describe('the daemon panel', () => {
  it('stays shut while the daemon is healthy', async () => {
    installBridge(attached);
    render(<DesktopChrome />);

    await screen.findByRole('button', { name: /Attached to a running daemon/ });
    expect(screen.queryByRole('complementary', { name: 'Daemon status' })).not.toBeInTheDocument();
  });

  it('opens itself when the daemon failed to start', async () => {
    installBridge(failed, ['! Error: listen EADDRINUSE']);
    render(<DesktopChrome />);

    const panel = await screen.findByRole('complementary', { name: 'Daemon status' });
    expect(panel).toHaveTextContent('The daemon did not answer');
    expect(panel).toHaveTextContent('EADDRINUSE');
  });

  it('closes on request even though the daemon is still failing', async () => {
    installBridge(failed);
    render(<DesktopChrome />);

    await screen.findByRole('complementary', { name: 'Daemon status' });
    await userEvent.click(screen.getByRole('button', { name: 'Hide daemon status' }));

    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Daemon status' })).not.toBeInTheDocument()
    );
  });
});

describe('the daemon action', () => {
  it('offers a reconnect, not a restart, for a daemon this app did not start', async () => {
    installBridge(attached);
    render(<DesktopChrome />);

    await userEvent.click(await screen.findByRole('button', { name: /Attached to a running daemon/ }));
    const panel = screen.getByRole('complementary', { name: 'Daemon status' });

    expect(panel).toHaveTextContent('Quitting will leave it running');
    const action = screen.getByRole('button', { name: 'Reconnect' });
    expect(action).toHaveAttribute('title', expect.stringContaining('cannot stop it'));
    expect(screen.queryByRole('button', { name: 'Restart daemon' })).not.toBeInTheDocument();
  });

  it('offers a restart for a daemon this app owns', async () => {
    installBridge(ours);
    render(<DesktopChrome />);

    await userEvent.click(await screen.findByRole('button', { name: /Daemon running/ }));
    expect(screen.getByRole('button', { name: 'Restart daemon' })).toBeInTheDocument();
    expect(
      screen.queryByText('Quitting will leave it running, because this app did not start it.')
    ).not.toBeInTheDocument();
  });

  it('offers to start one that is not running', async () => {
    installBridge(failed);
    render(<DesktopChrome />);

    await screen.findByRole('complementary', { name: 'Daemon status' });
    expect(screen.getByRole('button', { name: 'Start daemon' })).toBeInTheDocument();
  });

  it('asks the shell to act, and does not pretend to have done it itself', async () => {
    const { restart } = installBridge(ours);
    render(<DesktopChrome />);

    await userEvent.click(await screen.findByRole('button', { name: /Daemon running/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Restart daemon' }));

    expect(restart).toHaveBeenCalledTimes(1);
  });
});
