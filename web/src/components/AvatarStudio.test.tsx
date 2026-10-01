import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AvatarStudio } from './AvatarStudio.js';
import type { BotProfile } from '../lib/botProfile.js';

vi.mock('./BotFace.js', () => ({ BotFace: () => null, usePrefersReducedMotion: () => true }));
const profile: BotProfile = { shape: 'pebble', color: '#2C86F0', eyeColor: '#FFFFFF', emotion: '02', sketch: false, eyeScale: 1, idle: true, label: '', notifications: false, avatarImage: null };

describe('avatar studio', () => {
  it('previews a variation without saving, and Cancel leaves the saved profile untouched', async () => {
    const user = userEvent.setup(); const onSave = vi.fn(); const onClose = vi.fn();
    render(<AvatarStudio name="Atlas" profile={profile} onSave={onSave} onClose={onClose} />);
    await user.click(screen.getByText('Have a look in mind? Start with words.'));
    await user.type(screen.getByLabelText('Start with a description'), 'a calm green researcher');
    await user.click(screen.getByRole('button', { name: 'Create a variation' }));
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close avatar studio' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(profile.color).toBe('#2C86F0');
  });

  it('saves the full identity and closes only after the server accepts it', async () => {
    const user = userEvent.setup(); const onSave = vi.fn().mockResolvedValue(undefined); const onClose = vi.fn();
    render(<AvatarStudio name="Atlas" profile={profile} onSave={onSave} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Save identity' }));
    expect(onSave).toHaveBeenCalledWith(profile);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('retains the draft and reports a failed save', async () => {
    const user = userEvent.setup(); const onClose = vi.fn();
    render(<AvatarStudio name="Atlas" profile={profile} onSave={vi.fn().mockRejectedValue(new Error('Profile storage is offline'))} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Save identity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Profile storage is offline');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save identity' })).toBeEnabled();
  });

  it('keeps an audition out of the saved profile unless made the default', async () => {
    const user = userEvent.setup(); const onSave = vi.fn().mockResolvedValue(undefined);
    render(<AvatarStudio name="Atlas" profile={profile} onSave={onSave} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Expressions' }));
    await user.click(screen.getByRole('button', { name: 'Preview Happy' }));
    expect(screen.getByText('Preview only')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save identity' }));
    expect(onSave).toHaveBeenLastCalledWith(profile);
    await user.click(screen.getByRole('button', { name: 'Make default' }));
    await user.click(screen.getByRole('button', { name: 'Save identity' }));
    expect(onSave).toHaveBeenLastCalledWith({ ...profile, emotion: '10' });
  });
});
