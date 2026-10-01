import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelBrowser } from './ModelBrowser.js';
import type { ProviderConnectionRow } from '../lib/transport.js';

const connections = [{
  id: 'gateway', name: 'Research gateway', enabled: true,
  catalog: { models: [
    { id: 'openai/research', usable: true, virtual: false, supportsTools: true, supportsVision: false, contextWindow: 128000 },
    { id: 'vision-model', usable: null, virtual: false, supportsTools: null, supportsVision: true, contextWindow: null },
    { id: 'offline-model', usable: false, virtual: false, supportsTools: false, supportsVision: false, contextWindow: null },
    { id: 'auto', usable: true, virtual: true, supportsTools: null, supportsVision: null, contextWindow: null },
  ] },
}, { id: 'disabled', name: 'Disabled gateway', enabled: false, catalog: { models: [{ id: 'hidden-model', usable: true }] } }] as ProviderConnectionRow[];
const value = { modelId: 'openai/research', connectionId: 'gateway', routingMode: 'pinned' as const };

describe('model browser', () => {
  it('filters real capabilities and searches across a provider catalog without inventing availability', async () => {
    const user = userEvent.setup();
    render(<ModelBrowser value={value} connections={connections} onChange={vi.fn()} onClose={vi.fn()} />);
    const catalog = within(screen.getByRole('region', { name: 'Model catalog' }));
    expect(catalog.queryByText('hidden-model')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Vision' }));
    expect(catalog.getByText('vision-model')).toBeInTheDocument();
    expect(catalog.queryByText('openai/research')).not.toBeInTheDocument();
    expect(catalog.getByText('Availability not reported')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Available' }));
    expect(catalog.queryByText('vision-model')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Search models'), 'research');
    expect(catalog.getByText('openai/research')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Search models'));
    await user.type(screen.getByLabelText('Search models'), 'missing');
    expect(screen.getByText('No matching models')).toBeInTheDocument();
  });

  it('keeps selection local until Apply and refuses an alias until automatic routing is explicit', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(); const onClose = vi.fn();
    render(<ModelBrowser value={value} connections={connections} onChange={onChange} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /auto\s*Automatic routing alias/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Use this model' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Automatic\s*Allow the provider/ }));
    await user.click(screen.getByRole('button', { name: 'Use this model' }));
    expect(onChange).toHaveBeenCalledWith({ modelId: 'auto', connectionId: 'gateway', routingMode: 'auto' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('preserves exact slash IDs and keeps the picker open on a save failure', async () => {
    const user = userEvent.setup(); const onClose = vi.fn();
    const onChange = vi.fn().mockRejectedValue(new Error('Provider refused the change'));
    render(<ModelBrowser value={value} connections={connections} onChange={onChange} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Use this model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider refused the change');
    expect(onChange).toHaveBeenCalledWith(value);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close model browser' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a production-sized catalog responsive and always allows dismissal', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const large = [{
      id: 'large', name: 'Large gateway', enabled: true,
      catalog: { models: Array.from({ length: 445 }, (_, index) => ({ id: `model-${index + 1}`, usable: true })) },
    }] as ProviderConnectionRow[];
    render(<ModelBrowser value={{ modelId: 'model-445', connectionId: 'large', routingMode: 'pinned' }} connections={large} onChange={vi.fn()} onClose={onClose} />);
    const catalog = within(screen.getByRole('region', { name: 'Model catalog' }));
    expect(catalog.getAllByRole('button', { name: /model-/ })).toHaveLength(61); // first page plus the selected model
    expect(catalog.getByRole('button', { name: 'Show 60 more models' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close model browser' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('can be closed while a model save is still pending', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onChange = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onClose = vi.fn();
    render(<ModelBrowser value={value} connections={connections} onChange={onChange} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Use this model' }));
    await user.click(screen.getByRole('button', { name: 'Close model browser' }));
    expect(onClose).toHaveBeenCalledOnce();
    finish();
  });
});
