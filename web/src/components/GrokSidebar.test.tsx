/**
 * Sidebar behaviour.
 *
 * The two things the previous sidebar got wrong: it filtered bots in place
 * instead of opening the search dialog, and its "snippet" was the bot's role
 * text rather than a message. Both are asserted here.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from '@/registry/default/ui/sidebar.js';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokSidebar } from './GrokSidebar.js';
import { defaultProfile } from '../lib/botProfile.js';
import type { ConversationFlags } from '../lib/botProfile.js';
import type { Teammate } from './workspaceTypes.js';

vi.mock('./BotFace.js', () => ({ BotFace: () => null, usePrefersReducedMotion: () => true }));

function mate(id: string, name: string, over: Partial<Teammate> = {}): Teammate {
  return {
    id,
    name,
    description: `${name} role text`,
    model: 'test-model',
    status: 'IDLE',
    budgetCapUsd: 10,
    profile: defaultProfile({ id, name, model_id: 'test-model' }),
    flags: { pinned: false, unread: false, hidden: false, section: null } as ConversationFlags,
    reactions: {},
    threadId: `thread-${id}`,
    lastMessagePreview: null,
    lastMessageAt: null,
    ...over,
  };
}

function props(overrides: Partial<React.ComponentProps<typeof GrokSidebar>> = {}) {
  return {
    teammates: [mate('atlas', 'Atlas')],
    activeAgentId: 'atlas',
    draft: null,
    connection: 'open' as const,
    accountName: 'Operator',
    computerBanner: null,
    updateAvailable: false,
    onSelectAgent: vi.fn(),
    onOpenSearch: vi.fn(),
    onNewChat: vi.fn(),
    onSelectDraft: vi.fn(),
    onOpenMarketplace: vi.fn(),
    onOpenAccountMenu: vi.fn(),
    onBotAction: vi.fn(),
    ...overrides,
  };
}

describe('brand', () => {
  it('names the product OpenAgents', () => {
    render(<GrokSidebar {...props()} />);
    expect(screen.getByText('OpenAgents')).toBeTruthy();
  });
});

describe('rows', () => {
  it('shows the real last message, not the bot role text', () => {
    render(
      <GrokSidebar
        {...props({
          teammates: [
            mate('atlas', 'Atlas', {
              lastMessagePreview: 'The rollback step is missing.',
              lastMessageAt: Date.now(),
            }),
          ],
        })}
      />
    );
    expect(screen.getByText('The rollback step is missing.')).toBeInTheDocument();
    expect(screen.queryByText('Atlas role text')).not.toBeInTheDocument();
  });

  it('says so when a bot has no messages yet', () => {
    render(<GrokSidebar {...props()} />);
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });

  it('renders unread badge when a bot has unread flag', () => {
    render(
      <GrokSidebar
        {...props({
          teammates: [
            mate('atlas', 'Atlas', {
              flags: { pinned: false, unread: true, hidden: false, section: null },
            }),
          ],
        })}
      />
    );
    expect(screen.getByLabelText('Unread')).toBeInTheDocument();
  });

  it('marks the active row for assistive technology', () => {
    render(<GrokSidebar {...props()} />);
    expect(screen.getByRole('button', { name: /Atlas/ })).toHaveAttribute('aria-current', 'page');
  });

  it('orders pinned bots first', () => {
    render(
      <GrokSidebar
        {...props({
          teammates: [
            mate('atlas', 'Atlas', { lastMessageAt: 200 }),
            mate('ledger', 'Ledger', {
              lastMessageAt: 100,
              flags: { pinned: true, unread: false, hidden: false, section: null },
            }),
          ],
        })}
      />
    );
    const names = screen.getAllByText(/Atlas|Ledger/).map((n) => n.textContent);
    expect(names[0]).toContain('Ledger');
  });

  it('hides a hidden bot but says how many are hidden', () => {
    render(
      <GrokSidebar
        {...props({
          teammates: [
            mate('atlas', 'Atlas'),
            mate('ledger', 'Ledger', {
              flags: { pinned: false, unread: false, hidden: true, section: null },
            }),
          ],
        })}
      />
    );
    expect(screen.queryByText('Ledger')).not.toBeInTheDocument();
    expect(screen.getByText(/1 hidden from this list/)).toBeInTheDocument();
  });

  it('groups bots under a named section', () => {
    render(
      <GrokSidebar
        {...props({
          teammates: [
            mate('ledger', 'Ledger', {
              flags: { pinned: false, unread: false, hidden: false, section: 'Finance' },
            }),
          ],
        })}
      />
    );
    expect(screen.getByText('Finance')).toBeInTheDocument();
  });
});

describe('search', () => {
  it('opens the search dialog instead of filtering the list', async () => {
    const user = userEvent.setup();
    const onOpenSearch = vi.fn();
    render(<GrokSidebar {...props({ onOpenSearch })} />);
    const search = screen.getByRole('button', { name: /Search/ });
    expect(search).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(search);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });
});

describe('context menu', () => {
  it('offers every observed action, with Delete marked destructive', async () => {
    const user = userEvent.setup();
    render(<GrokSidebar {...props()} />);
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: /Atlas/ }) });

    const menu = await screen.findByRole('menu', { name: /Actions for Atlas/ });
    for (const label of [
      'Pin',
      'Move to new section',
      'Mark as Unread',
      'Edit Profile',
      'Duplicate',
      'Copy conversation ID',
      'Hide from sidebar',
      'Delete',
    ]) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument();
    }

    const del = within(menu).getByRole('menuitem', { name: 'Delete' });
    expect(del).toBeEnabled();
    expect(del).toHaveClass('danger');
    expect(del).toHaveAttribute('title', expect.stringContaining('every conversation, routine and run'));
  });

  it('routes Delete to the workspace rather than deleting from the menu', async () => {
    const user = userEvent.setup();
    const onBotAction = vi.fn();
    render(<GrokSidebar {...props({ onBotAction })} />);
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: /Atlas/ }) });
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    // The menu asks; the workspace confirms and calls the daemon.
    expect(onBotAction).toHaveBeenCalledWith('atlas', 'delete');
  });

  it('reports the chosen action to the workspace', async () => {
    const user = userEvent.setup();
    const onBotAction = vi.fn();
    render(<GrokSidebar {...props({ onBotAction })} />);
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: /Atlas/ }) });
    await user.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    expect(onBotAction).toHaveBeenCalledWith('atlas', 'pin');
  });

  it('reflects current state in the toggle labels', async () => {
    const user = userEvent.setup();
    render(
      <GrokSidebar
        {...props({
          teammates: [
            mate('atlas', 'Atlas', {
              flags: { pinned: true, unread: true, hidden: false, section: null },
            }),
          ],
        })}
      />
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: /Atlas/ }) });
    expect(await screen.findByRole('menuitem', { name: 'Unpin' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mark as Read' })).toBeInTheDocument();
  });
});

describe('states', () => {
  it('shows the unreachable-computer banner with a working retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <GrokSidebar
        {...props({
          computerBanner: { message: "Can't reach your computer", onRetry, retrying: false },
        })}
      />
    );
    expect(screen.getByText("Can't reach your computer")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables retry while a retry is in flight', () => {
    render(
      <GrokSidebar
        {...props({
          computerBanner: { message: "Can't reach your computer", onRetry: vi.fn(), retrying: true },
        })}
      />
    );
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
  });

  it('labels the banner button with what it does, and keeps the full fix as a hint', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(
      <GrokSidebar
        {...props({
          computerBanner: {
            message: 'Connect a model provider',
            hint: 'Your bots need a model provider to answer. Add one in Settings, Providers.',
            actionLabel: 'Set up',
            busyLabel: 'Opening…',
            onRetry,
            retrying: false,
          },
        })}
      />
    );
    expect(screen.getByRole('status')).toHaveAttribute('title', 'Your bots need a model provider to answer. Add one in Settings, Providers.');
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <GrokSidebar
        {...props({
          computerBanner: { message: "Docker isn't running", actionLabel: 'Start Docker', busyLabel: 'Starting…', onRetry, retrying: true },
        })}
      />
    );
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
  });

  it('distinguishes an offline daemon from an empty fleet', () => {
    const { rerender } = render(<GrokSidebar {...props({ teammates: [], connection: 'closed' })} />);
    expect(screen.getByText(/daemon is offline/)).toBeInTheDocument();
    rerender(<GrokSidebar {...props({ teammates: [], connection: 'open' })} />);
    expect(screen.getByText(/No bots yet/)).toBeInTheDocument();
  });

  it('shows an unsent draft as its own row', () => {
    render(<GrokSidebar {...props({ draft: { kind: 'group', recipients: [] }, activeAgentId: null })} />);
    expect(screen.getByText('New group chat')).toBeInTheDocument();
  });
});

describe('the Coss sidebar parts this file uses', () => {
  // Two things that broke when these were adopted, and that no rendering test
  // catches because jsdom applies no CSS.
  it('tailwind-merge drops flex-col when flex-row is passed', () => {
    const { container } = render(
      <SidebarHeader className="grok-sidebar-header flex-row items-center justify-between" />
    );
    const cls = container.querySelector('[data-slot=sidebar-header]')!.className;
    expect(cls).toContain('flex-row');
    expect(cls).not.toContain('flex-col');
  });

  it('renders real list elements, which is why the reset is needed', () => {
    const { container } = render(
      <SidebarMenu>
        <SidebarMenuItem>row</SidebarMenuItem>
      </SidebarMenu>
    );
    expect(container.querySelector('[data-slot=sidebar-menu]')!.tagName).toBe('UL');
    expect(container.querySelector('[data-slot=sidebar-menu-item]')!.tagName).toBe('LI');
  });
});
