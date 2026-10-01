/**
 * Bot settings behaviour.
 *
 * Profile, intelligence and appearance are separate sections. Server-owned
 * fields retain explicit saving; profile controls save on change.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokBotSettings } from './GrokBotSettings.js';
import { defaultProfile } from '../lib/botProfile.js';
import type { Teammate } from './workspaceTypes.js';

vi.mock('./BotFace.js', () => ({ BotFace: () => null, usePrefersReducedMotion: () => true }));

const agent: Teammate = {
  id: 'atlas',
  name: 'Atlas',
  description: 'Maps a codebase.',
  model: 'test-model',
  status: 'IDLE',
  budgetCapUsd: 10,
  profile: defaultProfile({ id: 'atlas', name: 'Atlas', model_id: 'test-model' }),
  flags: { pinned: false, unread: false, hidden: false, section: null },
  reactions: {},
  threadId: 'thread-atlas',
  lastMessagePreview: null,
  lastMessageAt: null,
};

function props(overrides: Partial<React.ComponentProps<typeof GrokBotSettings>> = {}) {
  return {
    agent,
    onUpdateProfile: vi.fn(),
    onSaveAgent: vi.fn(async () => undefined),
    profileError: null as string | null,
    ...overrides,
  };
}

beforeEach(() => vi.restoreAllMocks());

describe('layout', () => {
  it('shows only the observed fields at the top level', () => {
    render(<GrokBotSettings {...props()} />);
    expect(screen.getByLabelText(/^Name$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Label \(optional\)/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Description$/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Notifications')).not.toBeInTheDocument();

    // Model, budget and the Aora extras must be behind the disclosure.
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Budget cap/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Default emotion/)).not.toBeInTheDocument();
  });

  it('groups model and appearance controls in their own sections', async () => {
    const user = userEvent.setup();
    render(<GrokBotSettings {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Model & budget' }));
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByLabelText(/Budget cap/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Default emotion/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await user.click(screen.getByRole('button', { name: /Expressions/ }));
    expect(screen.getByLabelText(/Default emotion/)).toBeInTheDocument();
    // The licence line now says the silhouettes are ours and only the engine
    // is third-party; a refactor that drops that statement should fail here.
    expect(screen.getByText(/OpenAgents-original geometry/)).toBeInTheDocument();
    expect(screen.getByText(/separately licensable/)).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('keeps Save inert until something actually changed', async () => {
    const user = userEvent.setup();
    render(<GrokBotSettings {...props()} />);
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();

    await user.type(screen.getByLabelText(/^Name$/), '!');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('refuses to save an empty name and says why', async () => {
    const user = userEvent.setup();
    const onSaveAgent = vi.fn(async () => undefined);
    render(<GrokBotSettings {...props({ onSaveAgent })} />);
    await user.clear(screen.getByLabelText(/^Name$/));
    expect(screen.getByText('A bot needs a name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    expect(onSaveAgent).not.toHaveBeenCalled();
  });

  it('reports a daemon refusal instead of appearing to have saved', async () => {
    const user = userEvent.setup();
    const onSaveAgent = vi.fn(async () => {
      throw new Error('name must contain 1-80 characters.');
    });
    render(<GrokBotSettings {...props({ onSaveAgent })} />);
    await user.type(screen.getByLabelText(/^Name$/), ' II');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('name must contain 1-80 characters.')).toBeInTheDocument();
  });

  it('writes labels straight through without exposing an inactive notifications switch', async () => {
    const user = userEvent.setup();
    const onUpdateProfile = vi.fn();
    render(<GrokBotSettings {...props({ onUpdateProfile })} />);

    await user.type(screen.getByLabelText(/Label \(optional\)/), 'ops');
    expect(onUpdateProfile).toHaveBeenCalledWith({ label: 'o' });

    expect(screen.queryByLabelText('Notifications')).not.toBeInTheDocument();
  });

  it('surfaces a profile save failure passed down from the workspace', () => {
    render(<GrokBotSettings {...props({ profileError: 'Could not save: daemon offline' })} />);
    expect(screen.getByText('Could not save: daemon offline')).toBeInTheDocument();
  });
});

describe('avatar popover', () => {
  it('offers all eight parity shapes and eleven colours', async () => {
    const user = userEvent.setup();
    render(<GrokBotSettings {...props()} />);
    await user.click(screen.getByLabelText('Change avatar'));

    for (const shape of ['Blob', 'Pebble', 'Squircle', 'Tablet', 'Wedge', 'Hex', 'Cloud', 'Teardrop']) {
      expect(screen.getByRole('button', { name: shape })).toBeInTheDocument();
    }
    // Gem is an Aora extra and must not appear among the parity swatches.
    expect(screen.queryByRole('button', { name: 'Gem' })).not.toBeInTheDocument();

    for (const colour of ['Black', 'Brown', 'Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Violet', 'Magenta', 'Gray']) {
      expect(screen.getByRole('button', { name: colour })).toBeInTheDocument();
    }
  });

  it('applies a shape choice and clears any uploaded image', async () => {
    const user = userEvent.setup();
    const onUpdateProfile = vi.fn();
    render(<GrokBotSettings {...props({ onUpdateProfile })} />);
    await user.click(screen.getByLabelText('Change avatar'));
    await user.click(screen.getByRole('button', { name: 'Hex' }));
    expect(onUpdateProfile).toHaveBeenCalledWith({ shape: 'hex', avatarImage: null });
  });

  it('keeps Generate disabled until something is described', async () => {
    const user = userEvent.setup();
    render(<GrokBotSettings {...props()} />);
    await user.click(screen.getByLabelText('Change avatar'));
    await user.click(screen.getByRole('tab', { name: 'Generate' }));

    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await user.type(screen.getByLabelText('Describe your avatar'), 'a red hexagon');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it('generates an avatar locally and says which words it matched', async () => {
    const user = userEvent.setup();
    const onUpdateProfile = vi.fn();
    render(<GrokBotSettings {...props({ onUpdateProfile })} />);
    await user.click(screen.getByLabelText('Change avatar'));
    await user.click(screen.getByRole('tab', { name: 'Generate' }));
    await user.type(screen.getByLabelText('Describe your avatar'), 'a red hexagon');
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    expect(onUpdateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ shape: 'hex', avatarImage: null })
    );
    expect(await screen.findByText(/Matched/)).toBeInTheDocument();
  });

  it('states that generation is local, not an image model', async () => {
    const user = userEvent.setup();
    render(<GrokBotSettings {...props()} />);
    await user.click(screen.getByLabelText('Change avatar'));
    await user.click(screen.getByRole('tab', { name: 'Generate' }));
    expect(screen.getByText(/not by an image model/)).toBeInTheDocument();
  });

  it('offers a real upload target', async () => {
    const user = userEvent.setup();
    render(<GrokBotSettings {...props()} />);
    await user.click(screen.getByLabelText('Change avatar'));
    await user.click(screen.getByRole('tab', { name: 'Upload' }));
    expect(screen.getByText('Drag, drop, or paste an image')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse files' })).toBeEnabled();
  });

  it('rejects a non-image drop rather than storing it', async () => {
    const user = userEvent.setup();
    const onUpdateProfile = vi.fn();
    render(<GrokBotSettings {...props({ onUpdateProfile })} />);
    await user.click(screen.getByLabelText('Change avatar'));
    await user.click(screen.getByRole('tab', { name: 'Upload' }));

    // Dropped rather than chosen through the file input: the input carries
    // accept="image/*", so the browser filters that path for us, and drag/drop
    // is the route a wrong file can actually arrive by.
    const zone = screen.getByText('Drag, drop, or paste an image').closest('.grok-dropzone')!;
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['not an image'], 'notes.txt', { type: 'text/plain' })] },
    });

    await waitFor(() => expect(screen.getByText('That file is not an image.')).toBeInTheDocument());
    expect(onUpdateProfile).not.toHaveBeenCalled();
  });

  it('rejects an oversized image with the limit in the message', async () => {
    const user = userEvent.setup();
    const onUpdateProfile = vi.fn();
    render(<GrokBotSettings {...props({ onUpdateProfile })} />);
    await user.click(screen.getByLabelText('Change avatar'));
    await user.click(screen.getByRole('tab', { name: 'Upload' }));

    const zone = screen.getByText('Drag, drop, or paste an image').closest('.grok-dropzone')!;
    const huge = new File([new Uint8Array(600 * 1024)], 'huge.png', { type: 'image/png' });
    fireEvent.drop(zone, { dataTransfer: { files: [huge] } });

    await waitFor(() => expect(screen.getByText(/Images must be under 512KB/)).toBeInTheDocument());
    expect(onUpdateProfile).not.toHaveBeenCalled();
  });
});
