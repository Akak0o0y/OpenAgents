/**
 * Settings, Providers.
 *
 * The page must show connection states distinctly, send a gateway key only in the save request, keep nothing in
 * browser storage, and leave the previous configuration visible when the daemon refuses a save.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvidersSection } from './GrokProvidersSection.js';
import type { ProviderConnectionRow, ProvidersBody } from '../lib/transport.js';

const api = vi.hoisted(() => ({
  providers: vi.fn(),
  saveProvider: vi.fn(),
  testProvider: vi.fn(),
  refreshProviderModels: vi.fn(),
  removeProviderKey: vi.fn(),
  removeProvider: vi.fn(),
}));
vi.mock('../lib/transport.js', () => ({ api }));

const KEY = 'fixture-gateway-key-not-real';

function row(overrides: Partial<ProviderConnectionRow> = {}): ProviderConnectionRow {
  return {
    id: 'freellmapi-abc123',
    name: 'FreeLLMAPI',
    preset: 'freellmapi',
    baseUrl: 'http://127.0.0.1:3001/v1',
    enabled: true,
    hasKey: true,
    status: 'untested',
    statusMessage: 'Saved. Test the connection to confirm it works.',
    checkedAt: null,
    catalog: { fetchedAt: null, models: [] },
    limits: { requestsPerDay: 500, tokensPerDay: 5_000_000 },
    admissionUsed: { requestsLast24h: 0, tokensLast24h: 0 },
    dashboardUrl: 'http://127.0.0.1:3001',
    pinning: 'identity-checked-per-turn',
    usedBy: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const body = (connections: ProviderConnectionRow[], secretStorage: ProvidersBody['secretStorage'] = { available: true, backend: 'windows-dpapi' }): ProvidersBody => ({
  connections,
  secretStorage,
  preset: { preset: 'freellmapi', name: 'FreeLLMAPI', baseUrl: 'http://127.0.0.1:3001/v1' },
});

let setItem: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  setItem = vi.spyOn(Storage.prototype, 'setItem');
});
afterEach(() => setItem.mockRestore());

describe('provider connections', () => {
  it('shows each connection state distinctly', async () => {
    const states: Array<[ProviderConnectionRow['status'], string]> = [
      ['connected', 'Connected'],
      ['unreachable', 'Unreachable'],
      ['invalid_credentials', 'Invalid key'],
      ['no_usable_models', 'No usable models'],
      ['exhausted', 'Quota exhausted'],
      ['incomplete', 'Setup incomplete'],
    ];
    api.providers.mockResolvedValue(body(states.map(([status], index) => row({ id: `gw-${index}0`, name: `Gateway ${index}`, status, hasKey: status !== 'incomplete' }))));
    render(<ProvidersSection />);
    for (const [index, [status, label]] of states.entries()) {
      const region = await screen.findByRole('region', { name: `Provider connection Gateway ${index}` });
      const badge = within(region).getByText(label);
      expect(badge).toHaveAttribute('data-status', status);
    }
    expect(within(screen.getByRole('region', { name: 'Provider connection Gateway 5' })).getByText('Not set')).toBeInTheDocument();
  });

  it('adds FreeLLMAPI from the local preset, sends the key once and keeps nothing in browser storage', async () => {
    const user = userEvent.setup();
    api.providers.mockResolvedValue(body([]));
    api.saveProvider.mockResolvedValue({ connection: row() });
    render(<ProvidersSection />);

    await user.click(await screen.findByRole('button', { name: 'Add FreeLLMAPI' }));
    expect(screen.getByLabelText('Connection name')).toHaveValue('FreeLLMAPI');
    expect(screen.getByLabelText('Endpoint base URL')).toHaveValue('http://127.0.0.1:3001/v1');
    const key = screen.getByLabelText('Gateway key');
    expect(key).toHaveAttribute('type', 'password');
    await user.type(key, KEY);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(api.saveProvider).toHaveBeenCalledTimes(1);
    expect(api.saveProvider).toHaveBeenCalledWith({
      name: 'FreeLLMAPI',
      preset: 'freellmapi',
      baseUrl: 'http://127.0.0.1:3001/v1',
      enabled: true,
      apiKey: KEY,
      limits: { requestsPerDay: 500, tokensPerDay: 5_000_000 },
    });
    const region = await screen.findByRole('region', { name: 'Provider connection FreeLLMAPI' });
    expect(within(region).getByText('Stored and hidden')).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(KEY);
    expect(setItem).not.toHaveBeenCalled();
    expect(api.testProvider).not.toHaveBeenCalled();
  });

  it('keeps the form and the previous configuration when the daemon refuses a save', async () => {
    const user = userEvent.setup();
    api.providers.mockResolvedValue(body([row({ status: 'connected', statusMessage: '2 of 2 models can serve now.' })]));
    api.saveProvider.mockRejectedValue(new Error('Protected credential storage is unavailable, so the key was not saved.'));
    render(<ProvidersSection />);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Replace gateway key')).toHaveAttribute('placeholder', 'Leave empty to keep the stored key');
    await user.type(screen.getByLabelText('Replace gateway key'), KEY);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Protected credential storage is unavailable, so the key was not saved.')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Edit provider connection' })).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Provider connection FreeLLMAPI' });
    expect(within(region).getByText('Connected')).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('edits without resending the stored key unless a replacement is typed', async () => {
    const user = userEvent.setup();
    api.providers.mockResolvedValue(body([row({ status: 'connected' })]));
    api.saveProvider.mockResolvedValue({ connection: row({ name: 'Home gateway', status: 'connected' }) });
    render(<ProvidersSection />);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Connection name'));
    await user.type(screen.getByLabelText('Connection name'), 'Home gateway');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.saveProvider).toHaveBeenCalledWith(expect.not.objectContaining({ apiKey: expect.anything() }));
    expect(api.saveProvider.mock.calls[0][0]).toMatchObject({ id: 'freellmapi-abc123', name: 'Home gateway' });
  });

  it('tests a connection, blocks removal while bots use it and states a protected-storage outage', async () => {
    const user = userEvent.setup();
    api.providers.mockResolvedValue(
      body([row({ usedBy: ['atlas'] })], { available: false, backend: 'none', reason: 'Protected credential storage is not implemented for this operating system yet.' })
    );
    api.testProvider.mockResolvedValue({ connection: row({ usedBy: ['atlas'], status: 'connected', statusMessage: '1 of 3 models can serve now.' }) });
    render(<ProvidersSection />);

    expect(await screen.findByText(/not implemented for this operating system yet/)).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Provider connection FreeLLMAPI' });
    expect(within(region).getByRole('button', { name: 'Remove' })).toBeDisabled();
    await user.click(within(region).getByRole('button', { name: 'Test connection' }));
    expect(await within(region).findByText('Connected')).toBeInTheDocument();
    expect(within(region).getByText('1 of 3 models can serve now.')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Open gateway dashboard' })).toHaveAttribute('href', 'http://127.0.0.1:3001');
  });
});
