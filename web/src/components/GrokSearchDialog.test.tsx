/**
 * Search dialog behaviour.
 *
 * Loading, empty, failed and unsupported are four different answers and the
 * dialog must never render one as another. The abort test guards the race that
 * makes a search dialog feel broken: a slow response for an old query landing
 * after a fast one for the current query.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokSearchDialog } from './GrokSearchDialog.js';
import { api, type SearchResponseBody } from '../lib/transport.js';

vi.mock('./BotFace.js', () => ({ BotFace: () => null, usePrefersReducedMotion: () => true }));

const empty: SearchResponseBody = { query: '', results: [], unsupported: [], truncated: false };

function props(overrides: Partial<React.ComponentProps<typeof GrokSearchDialog>> = {}) {
  return {
    teammates: [],
    actions: [
      { id: 'settings-general', title: 'Settings: General', subtitle: 'Settings', run: vi.fn() },
    ],
    onClose: vi.fn(),
    onOpenResult: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('states', () => {
  it('shows skeleton rows while the daemon is answering', async () => {
    vi.spyOn(api, 'search').mockReturnValue(new Promise(() => undefined));
    render(<GrokSearchDialog {...props()} />);
    expect(await screen.findByRole('status', { name: 'Searching' })).toBeInTheDocument();
  });

  it('shows "No results" for a query that matched nothing', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({ ...empty, query: 'zz' });
    const user = userEvent.setup();
    render(<GrokSearchDialog {...props({ actions: [] })} />);
    await user.type(screen.getByLabelText(/Search bots/), 'zz');
    expect(await screen.findByText('No results')).toBeInTheDocument();
  });

  it('reports a search failure as a failure, not as no results', async () => {
    vi.spyOn(api, 'search').mockRejectedValue(
      new Error('This daemon was started without search support.')
    );
    render(<GrokSearchDialog {...props()} />);
    expect(
      await screen.findByText('This daemon was started without search support.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No results')).not.toBeInTheDocument();
  });

  it('renders daemon results with their type', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({
      ...empty,
      results: [
        { kind: 'routine', id: 'rtn-1', title: 'Morning digest', subtitle: 'every day at 8 am' },
      ],
    });
    render(<GrokSearchDialog {...props({ actions: [] })} />);
    expect(await screen.findByText('Morning digest')).toBeInTheDocument();
    expect(screen.getByText('every day at 8 am')).toBeInTheDocument();
    expect(screen.getByText('Routine')).toBeInTheDocument();
  });

  it('explains an unsupported category instead of showing it as empty', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({
      ...empty,
      unsupported: [{ kind: 'group', reason: 'This daemon has no group conversations.' }],
    });
    const user = userEvent.setup();
    render(<GrokSearchDialog {...props()} />);
    await user.click(await screen.findByRole('tab', { name: 'Groups' }));
    expect(await screen.findByText('This daemon has no group conversations.')).toBeInTheDocument();
    expect(screen.queryByText('No results')).not.toBeInTheDocument();
  });
});

describe('queries', () => {
  it('aborts an in-flight request when the query moves on', async () => {
    // The 160ms debounce absorbs fast typing, so a second request is only ever
    // issued once the first is genuinely in flight. That is the case this
    // guards: a slow answer for "de" must not land after a fast one for
    // "deploy". The mock is deliberately slower than the debounce.
    const aborted: string[] = [];
    vi.spyOn(api, 'search').mockImplementation(
      (query, _k, _l, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => aborted.push(query));
          setTimeout(() => resolve({ ...empty, query }), 600);
        })
    );
    const user = userEvent.setup();
    render(<GrokSearchDialog {...props()} />);
    const field = screen.getByLabelText(/Search bots/);

    await user.type(field, 'de');
    // Let the debounce elapse so the "de" request is actually dispatched.
    await waitFor(() => expect(api.search).toHaveBeenCalledWith('de', undefined, 20, expect.anything()));

    await user.type(field, 'ploy');
    await waitFor(() => expect(aborted).toContain('de'));
  });

  it('matches workspace actions locally, since the daemon has no such rows', async () => {
    vi.spyOn(api, 'search').mockResolvedValue(empty);
    const user = userEvent.setup();
    const run = vi.fn();
    render(<GrokSearchDialog {...props({ actions: [{ id: 'a', title: 'Settings: General', subtitle: 'Settings', run }] })} />);
    await user.click(await screen.findByRole('option', { name: /Settings: General/ }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('activates the highlighted row with the keyboard', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({
      ...empty,
      results: [{ kind: 'bot', id: 'atlas', title: 'Atlas', agentId: 'atlas' }],
    });
    const user = userEvent.setup();
    const onOpenResult = vi.fn();
    render(<GrokSearchDialog {...props({ actions: [], onOpenResult })} />);
    await screen.findByText('Atlas');
    await user.keyboard('{Enter}');
    expect(onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'atlas' }));
  });

  it('restricts the request to one kind when a tab is chosen', async () => {
    const search = vi.spyOn(api, 'search').mockResolvedValue(empty);
    const user = userEvent.setup();
    render(<GrokSearchDialog {...props()} />);
    await user.click(await screen.findByRole('tab', { name: 'Routines' }));
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(expect.any(String), ['routine'], 20, expect.anything())
    );
  });
});
