/**
 * Bot provider, model and routing selection.
 *
 * A connection's model list must keep "can serve now", "only listed" and routing aliases apart, a newly chosen
 * connection must start pinned, and an alias must never be saved as pinned.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { GrokModelSelector, modelSelectionError, type ModelSelection } from './GrokModelSelector.js';
import type { ProviderConnectionRow, ProvidersBody } from '../lib/transport.js';

const api = vi.hoisted(() => ({ providers: vi.fn() }));
vi.mock('../lib/transport.js', () => ({ api }));

const SLASH_MODEL = 'meta-llama/llama-4-scout:free';

function connection(overrides: Partial<ProviderConnectionRow> = {}): ProviderConnectionRow {
  return {
    id: 'freellmapi-abc123',
    name: 'FreeLLMAPI',
    preset: 'freellmapi',
    baseUrl: 'http://127.0.0.1:3001/v1',
    enabled: true,
    hasKey: true,
    status: 'connected',
    statusMessage: '1 of 2 models can serve now.',
    checkedAt: 1,
    catalog: {
      fetchedAt: 1,
      models: [
        { id: SLASH_MODEL, usable: true, executionStatus: 'ready', virtual: false, supportsTools: true, supportsVision: null, contextWindow: null },
        { id: 'gemini-2.5-pro', usable: false, executionStatus: 'needsKey', virtual: false, supportsTools: null, supportsVision: null, contextWindow: null },
        { id: 'auto', usable: true, executionStatus: 'ready', virtual: true, supportsTools: null, supportsVision: null, contextWindow: null },
      ],
    },
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

const body = (connections: ProviderConnectionRow[]): ProvidersBody => ({
  connections,
  secretStorage: { available: true, backend: 'memory' },
  preset: { preset: 'freellmapi', name: 'FreeLLMAPI', baseUrl: 'http://127.0.0.1:3001/v1' },
});

function Harness({ initial, onChange }: { initial: ModelSelection; onChange: (next: ModelSelection) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <GrokModelSelector
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

beforeEach(() => {
  api.providers.mockReset();
  api.providers.mockResolvedValue(body([connection()]));
});

describe('model selector', () => {
  it('keeps a free-text model ID and no routing choice for bots without a connection', async () => {
    render(<Harness initial={{ modelId: 'claude-haiku-4-5', connectionId: null, routingMode: null }} onChange={vi.fn()} />);
    await screen.findByRole('option', { name: 'FreeLLMAPI' });
    expect(screen.getByLabelText('Model')).toHaveValue('claude-haiku-4-5');
    expect(screen.queryByLabelText('Routing')).not.toBeInTheDocument();
  });

  it('separates usable, listed-only and alias entries, keeps slash IDs exact and starts a new connection pinned', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ modelId: 'claude-haiku-4-5', connectionId: null, routingMode: null }} onChange={onChange} />);
    await screen.findByRole('option', { name: 'FreeLLMAPI' });

    await user.selectOptions(screen.getByLabelText('Provider'), 'freellmapi-abc123');
    expect(onChange).toHaveBeenLastCalledWith({ modelId: 'claude-haiku-4-5', connectionId: 'freellmapi-abc123', routingMode: 'pinned' });

    const model = screen.getByLabelText('Model') as HTMLSelectElement;
    const group = (label: string) => [...(model.querySelector(`optgroup[label="${label}"]`)?.querySelectorAll('option') ?? [])].map((o) => o.value);
    expect(group('Can serve now')).toEqual([SLASH_MODEL]);
    expect(group('Listed but not usable now')).toEqual(['gemini-2.5-pro']);
    expect(group('Routing aliases (automatic routing only)')).toEqual(['auto']);
    expect(screen.getByRole('option', { name: /claude-haiku-4-5 \(not in this gateway's list\)/ })).toBeInTheDocument();

    await user.selectOptions(model, SLASH_MODEL);
    expect(onChange).toHaveBeenLastCalledWith({ modelId: SLASH_MODEL, connectionId: 'freellmapi-abc123', routingMode: 'pinned' });
    expect(screen.getByLabelText('Routing')).toHaveValue('pinned');
    expect(screen.getByText(/does not guarantee exact-model pinning/)).toBeInTheDocument();
  });

  it('refuses a pinned routing alias until automatic routing is chosen explicitly', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ modelId: 'auto', connectionId: 'freellmapi-abc123', routingMode: 'pinned' }} onChange={onChange} />);
    expect(await screen.findByText(/Routing aliases need automatic routing/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Routing'), 'auto');
    expect(onChange).toHaveBeenLastCalledWith({ modelId: 'auto', connectionId: 'freellmapi-abc123', routingMode: 'auto' });
    expect(screen.queryByText(/Routing aliases need automatic routing/)).not.toBeInTheDocument();
    expect(screen.getByText(/requested and the model that actually answered/)).toBeInTheDocument();
  });

  it('validates selections without a rendered form', () => {
    expect(modelSelectionError({ modelId: ' ', connectionId: null, routingMode: null })).toBe('A model id is required.');
    expect(modelSelectionError({ modelId: 'auto:fast', connectionId: 'x', routingMode: 'pinned' })).toMatch(/automatic routing/);
    expect(modelSelectionError({ modelId: 'auto', connectionId: null, routingMode: null })).toBe('');
  });

  it('says so when connections cannot be read, and still accepts a model ID', async () => {
    api.providers.mockRejectedValue(new Error('daemon offline'));
    render(<Harness initial={{ modelId: 'claude-haiku-4-5', connectionId: null, routingMode: null }} onChange={vi.fn()} />);
    expect(await screen.findByText(/Provider connections could not be read: daemon offline/)).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toHaveValue('claude-haiku-4-5');
  });
});
