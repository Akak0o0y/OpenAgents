import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CharacterSection } from './CharacterSection.js';
import { characterClient } from '../lib/character.js';
vi.mock('../lib/character.js', () => ({ characterClient: { get: vi.fn() } }));
vi.mock('./CharacterStudio.js', () => ({ CharacterStudio: ({ agentId, onSaved }: { agentId: string; onSaved: () => void }) => <button onClick={onSaved}>Save for {agentId}</button> }));
it('opens the selected bot studio and refreshes without closing it after save', async () => {
  vi.mocked(characterClient.get).mockResolvedValue({ version: 1, settings: { mode: 'off' } } as any);
  render(<CharacterSection agentId="milo" agentName="Milo" />);
  await screen.findByText(/Version 1/);
  fireEvent.click(screen.getByRole('button', { name: 'Open character studio' }));
  vi.mocked(characterClient.get).mockResolvedValue({ version: 2, settings: { mode: 'voice' } } as any);
  fireEvent.click(screen.getByRole('button', { name: 'Save for milo' }));
  await waitFor(() => expect(screen.getByText(/Version 2/)).toBeVisible());
  expect(screen.getByRole('button', { name: 'Save for milo' })).toBeVisible();
});
