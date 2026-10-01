import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, test, expect, beforeEach } from 'vitest';
import { CharacterPosts } from './CharacterPosts.js';
import { characterClient } from '../lib/character.js';
vi.mock('../lib/character.js', () => ({ characterClient: { posts: vi.fn(), post: vi.fn(), metrics: vi.fn(), promote: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(characterClient.posts).mockResolvedValue({ items: [{ id: 'u', status: 'confirmed', semantic: 'unchecked-unavailable', statusReason: null,
    op: 'post', replyTo: null, postUrl: null, version: 1, createdAt: 1, updatedAt: 1, finalCandidate: { id: 'c', text: 'A thought', similarity: null,
      scores: null, reviewer: { model: 'same', connectionId: null, sameAsAuthor: true } }, calls: { logical: 2, wire: null },
    tokens: { input: 5, output: 2, cached: 'unavailable' }, cost: { knownUsd: 0.01, unknownCalls: 1 } }], nextCursor: null });
  vi.mocked(characterClient.metrics).mockResolvedValue({ version: 1, n: 0, mean: null, reviseRate: 0, holdRate: 0,
    costPerConfirmed: { knownUsd: null, unknownCalls: 1 }, coverage: { passed: 0, unchecked: 1, outOfScope: 0, held: 0, pending: 0, other: 0 },
    cachedTokens: 'unavailable', storage: { usedBytes: 80, quotaBytes: 100 } });
});
test('posts show unchecked and unknown usage honestly, warn about storage and prohibit promotion of dirty drafts', async () => {
  render(<CharacterPosts agentId="a" agentName="Milo" version={1} dirty onSaved={() => {}} />);
  await screen.findByText('A thought');
  expect(screen.getByText(/unchecked-unavailable/)).toBeTruthy();
  expect(screen.getByText(/unknown cost/)).toBeTruthy();
  expect(screen.getByText(/Milo is checking his own writing/)).toBeTruthy();
  expect(screen.getByText(/History is nearly full/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Use as example' }) as HTMLButtonElement).disabled).toBe(true);
});
test('promotion uses the exact base version and refreshes only after success', async () => {
  const saved = vi.fn(); vi.mocked(characterClient.promote).mockResolvedValue({ version: 2, exampleId: 'example' });
  render(<CharacterPosts agentId="a" agentName="Milo" version={1} dirty={false} onSaved={saved} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Use as example' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(characterClient.promote).toHaveBeenCalledWith('a', 1, 'u', expect.any(AbortSignal));
});
