import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokNewBotScreen } from './GrokNewBotScreen.js';

vi.mock('./BotFace.js', () => ({ BotFace: () => null, usePrefersReducedMotion: () => true }));
vi.mock('../lib/transport.js', () => ({ api: { providers: async () => ({ connections: [{ id: 'gateway', name: 'Test gateway', enabled: true, catalog: { models: [{ id: 'vendor/exact-model', usable: true, virtual: false, contextWindow: 128000, supportsTools: true, supportsVision: null }] } }] }) } }));

describe('bot creation', () => {
  it('preserves the default provider and routing without opening the model selector', async () => {
    const user = userEvent.setup();
    const onGetStarted = vi.fn().mockResolvedValue(undefined);
    const selection = { modelId: 'vendor/exact-model', connectionId: 'gateway', routingMode: 'auto' as const };
    render(<GrokNewBotScreen defaultSelection={selection} onGetStarted={onGetStarted} onBackToExisting={vi.fn()} hasExistingAgents />);
    await user.type(screen.getByLabelText('Name'), 'Inherited bot');
    await user.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(onGetStarted).toHaveBeenCalledWith(expect.objectContaining(selection));
  });

  it('creates the chosen identity with the exact model, provider and explicit routing', async () => {
    const user = userEvent.setup(); const onGetStarted = vi.fn().mockResolvedValue(undefined);
    render(<GrokNewBotScreen onGetStarted={onGetStarted} onBackToExisting={vi.fn()} hasExistingAgents />);
    expect(screen.queryByText('Give the bot a name.')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'My Researcher');
    await user.click(screen.getByRole('button', { name: /INTELLIGENCE/ }));
    await user.click(await screen.findByRole('button', { name: /vendor\/exact-model/ }));
    await user.click(screen.getByRole('button', { name: 'Use this model' }));
    await user.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(onGetStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'my-researcher', name: 'My Researcher', modelId: 'vendor/exact-model', connectionId: 'gateway', routingMode: 'pinned', shape: 'pebble', color: '#2C86F0' }));
  });

  it('blocks a duplicate identity and reports a creation failure without losing the form', async () => {
    const user = userEvent.setup();
    render(<GrokNewBotScreen onGetStarted={vi.fn().mockRejectedValue(new Error('Creation refused'))} onBackToExisting={vi.fn()} hasExistingAgents existingIds={['atlas']} />);
    await user.type(screen.getByLabelText('Name'), 'Atlas');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Create bot' })).toBeDisabled();
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Researcher');
    await user.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(await screen.findByText('Creation refused')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Researcher');
  });
});
