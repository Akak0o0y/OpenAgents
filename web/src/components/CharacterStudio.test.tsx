import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CharacterStudio } from './CharacterStudio.js';
import { characterClient } from '../lib/character.js';

vi.mock('../lib/character.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/character.js')>();
  return { ...actual, characterClient: { get: vi.fn(), save: vi.fn(), revert: vi.fn(), compile: vi.fn(), preview: vi.fn() } };
});
const response = () => ({ version: 1, document: { schema: 'openhours.character/1', identity: { name: 'Milo', oneLine: '', languages: ['en'], timezone: 'UTC' },
  purpose: { statement: '', audience: '', topics: [], success: [] }, voice: { examples: [], rules: { casing: 'normal', emoji: 'sometimes', signatureWords: [], do: [], dont: [] }, postRules: { length: { min: 40, max: 280 }, hashtags: 0, links: 'sometimes' }, avoidPhrases: [], aiPhrasing: true },
  personality: { sliders: { curious: 3, organised: 3, outgoing: 3, agreeable: 3, sensitive: 3 }, humour: 'none', quirks: [], dispositions: [], mappingVersion: 'openhours.sliders/1' }, standards: { never: [], avoidTopics: [] },
  commitments: [], biography: [], relationships: [], backgroundFacts: [], currentFocus: [], notes: 'hidden preserved note' },
  settings: { mode: 'off', checks: { reviewer: null, outage: 'rules-only', sampling: 'all', inventedDetails: 'everyday-only' }, growth: { review: 'off', readEngagement: false }, retention: { months: 12 } }, reviewerOptions: [], versions: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(characterClient.get).mockResolvedValue(response() as any);
  vi.mocked(characterClient.compile).mockResolvedValue({ packet: { stable: '', data: '', meta: { stableChars: 0, dataChars: 0, omissions: [] } },
    inspection: { label: 'Sample context', warning: 'The Description may also describe personality.', prompts: [{ mode: 'native', system: 'Full unsplit Description', messages: [{ role: 'user', content: 'Sample request' }] }] } } as any);
});

it('loads persisted data, saves explicitly and preserves hidden fields', async () => {
  vi.mocked(characterClient.save).mockResolvedValue({ version: 2 } as any);
  render(<CharacterStudio agentId="a" agentName="Milo" onClose={() => {}} onSaved={() => {}} />);
  await screen.findByLabelText('Character name');
  fireEvent.change(screen.getByLabelText('Character name'), { target: { value: 'New Milo' } });
  expect(characterClient.save).not.toHaveBeenCalled();
  expect(characterClient.preview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save character' }));
  await waitFor(() => expect(characterClient.save).toHaveBeenCalled());
  const args = vi.mocked(characterClient.save).mock.calls[0];
  expect(args[0]).toBe('a'); expect(args[1]).toBe(1);
  expect(args[2].document?.identity?.name).toBe('New Milo');
  expect(args[2].document?.notes).toBe('hidden preserved note');
  expect(args[2].document).not.toHaveProperty('schema');
});

it('keeps draft edits on conflict and offers comparison before reload', async () => {
  vi.mocked(characterClient.save).mockRejectedValue(Object.assign(new Error('Changed elsewhere'), { status: 409 }));
  render(<CharacterStudio agentId="a" agentName="Milo" onClose={() => {}} onSaved={() => {}} />);
  fireEvent.change(await screen.findByLabelText('Character name'), { target: { value: 'Local draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save character' }));
  await screen.findByText('Changed elsewhere');
  expect(screen.getByLabelText('Character name')).toHaveValue('Local draft');
  expect(screen.getByRole('button', { name: 'Compare with saved version' })).toBeVisible();
});

it('shows full prompt inspection and paid unsent Try it only after an explicit click', async () => {
  vi.mocked(characterClient.preview).mockResolvedValue({ ok: false, semanticState: 'unchecked-invalid', candidateText: 'Unsent example',
    ruleResult: { hardPass: true, hardFindings: [], advisoryFindings: [] }, logicalCalls: 2, wireAttempts: null,
    usage: { costUsd: null, cachedTokens: null, inputTokens: 20, outputTokens: 10 } } as any);
  render(<CharacterStudio agentId="a" agentName="Milo" onClose={() => {}} onSaved={() => {}} />);
  await screen.findByLabelText('Character name');
  fireEvent.click(screen.getByRole('tab', { name: 'Inspect & try' }));
  fireEvent.click(screen.getByRole('button', { name: 'Inspect draft (free)' }));
  await screen.findByText('Full unsplit Description');
  expect(characterClient.preview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Try it — uses model budget' }));
  await screen.findByText('Unsent example');
  expect(screen.getByText(/unchecked-invalid/)).toBeVisible();
  expect(screen.getByText(/Cost: unavailable/)).toBeVisible();
});

it('aborts a paid preview and ignores its late response after switching bots', async () => {
  let resolve!: (value: any) => void;
  vi.mocked(characterClient.preview).mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = render(<CharacterStudio agentId="a" agentName="Milo" onClose={() => {}} onSaved={() => {}} />);
  await screen.findByLabelText('Character name');
  fireEvent.click(screen.getByRole('tab', { name: 'Inspect & try' }));
  fireEvent.click(screen.getByRole('button', { name: 'Try it — uses model budget' }));
  const signal = vi.mocked(characterClient.preview).mock.calls[0][3]!;
  view.rerender(<CharacterStudio agentId="b" agentName="Other bot" onClose={() => {}} onSaved={() => {}} />);
  await screen.findByLabelText('Character name');
  expect(signal.aborted).toBe(true);
  resolve({ candidateText: 'Late response must not appear' });
  await waitFor(() => expect(screen.queryByText('Late response must not appear')).toBeNull());
});

it('keeps newlines while editing lists and protects dirty close', async () => {
  const close = vi.fn();
  render(<CharacterStudio agentId="a" agentName="Milo" onClose={close} onSaved={() => {}} />);
  await screen.findByLabelText('Character name');
  const topics = screen.getByLabelText('Topics (one per line)');
  fireEvent.change(topics, { target: { value: 'First topic\n' } });
  expect(topics).toHaveValue('First topic\n');
  fireEvent.change(topics, { target: { value: 'First topic\nSecond topic' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(topics).toHaveValue('First topic\nSecond topic');
});

it('inspects a historical version before an explicit CAS revert', async () => {
  vi.mocked(characterClient.get).mockResolvedValue({ ...response(), versions: [{ version: 1, origin: 'studio', createdAt: 100, note: null }] } as any);
  render(<CharacterStudio agentId="a" agentName="Milo" onClose={() => {}} onSaved={() => {}} />);
  await screen.findByLabelText('Character name');
  fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
  vi.mocked(characterClient.get).mockResolvedValueOnce({ ...response(), selected: { version: 1, document: response().document, settings: response().settings } } as any);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect version 1' }));
  await screen.findByRole('button', { name: 'Revert to version 1' });
  expect(characterClient.revert).not.toHaveBeenCalled();
  vi.mocked(characterClient.revert).mockResolvedValue({ version: 2 } as any);
  fireEvent.click(screen.getByRole('button', { name: 'Revert to version 1' }));
  await waitFor(() => expect(characterClient.revert).toHaveBeenCalledWith('a', 1, 1, expect.any(AbortSignal)));
});
