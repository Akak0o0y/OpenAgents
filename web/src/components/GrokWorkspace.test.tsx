import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokWorkspace } from './GrokWorkspace.js';
import { useCortex } from '../store.js';
import { api, sendCommand, type AgentRow } from '../lib/transport.js';
import type { Teammate } from './workspaceTypes.js';
import { saveFlags, saveProfile } from '../lib/botProfile.js';

vi.mock('../lib/transport.js', async (original) => ({
  ...await original<typeof import('../lib/transport.js')>(),
  sendCommand: vi.fn(),
  api: {
    chatThreadPreviews: vi.fn(), approvals: vi.fn(), createAgent: vi.fn(), search: vi.fn(), agentData: vi.fn(),
    providers: vi.fn().mockResolvedValue({ connections: [] }),
    // GrokScreen's details view reads unconfirmed posts; a plain function survives restoreMocks.
    botSystem: async () => ({}),
  },
}));
vi.mock('../lib/botProfile.js', async (original) => ({
  ...await original<typeof import('../lib/botProfile.js')>(),
  loadWorkspaceUiState: async () => ({ state: { profiles: {}, flags: {}, reactions: {} }, migrated: [], error: null }),
  saveProfile: vi.fn().mockResolvedValue(undefined),
  saveFlags: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/useComputerSession.js', () => ({ useComputerSession: () => ({ state: 'idle', files: [], runId: null }) }));
vi.mock('../lib/useDockerStatus.js', () => ({ useDockerStatus: () => ({}), dockerBanner: () => null }));
vi.mock('../lib/useProviderSetup.js', () => ({ useProviderSetup: () => ({ needed: false, refresh: vi.fn() }) }));
vi.mock('./BotFace.js', () => ({ BotFace: () => null, usePrefersReducedMotion: () => true }));
vi.mock('./GrokChat.js', () => ({ GrokChat: ({ onOpenDetails, navigationTarget }: { onOpenDetails: () => void; navigationTarget?: unknown }) => <><button onClick={onOpenDetails}>Open details</button><output data-testid="chat-destination">{JSON.stringify(navigationTarget)}</output></> }));
vi.mock('./BotBrowser.js', () => ({ BotBrowser: () => null }));
vi.mock('./BotSystemPanel.js', () => ({ BotSystemPanel: () => null }));
vi.mock('./GrokSidebar.js', () => ({
  GrokSidebar: ({ teammates, onSelectAgent, onCreateBot, onOpenMarketplace, onBotAction }: {
    teammates: Teammate[]; onSelectAgent: (id: string) => void; onCreateBot: () => void; onOpenMarketplace: () => void; onBotAction: (id: string, action: 'duplicate') => void;
  }) => <nav>
    {teammates.map(mate => <button key={mate.id} onClick={() => onSelectAgent(mate.id)}>{mate.name}{mate.flags.unread ? ' unread' : ''}</button>)}
    <button onClick={onCreateBot}>New bot</button>
    <button onClick={onOpenMarketplace}>Marketplace</button>
    <button onClick={() => onBotAction('second', 'duplicate')}>Duplicate second</button>
  </nav>,
}));
vi.mock('./GrokMarketplaceModal.js', () => ({
  GrokMarketplaceModal: ({ onImportBot }: { onImportBot: (template: unknown) => Promise<void> }) =>
    <button onClick={() => void onImportBot({ id: 'template', name: 'Template', content: { instructions: 'Research' }, shape: 'pebble', color: '#2C86F0' })}>Import template</button>,
}));

const agents: AgentRow[] = [
  { id: 'first', name: 'First', model_id: 'first/model', connection_id: 'first-provider', routing_mode: 'pinned', current_status: 'IDLE', budget_cap_usd: 10 },
  { id: 'second', name: 'Second', model_id: 'second/model', connection_id: 'second-provider', routing_mode: 'auto', current_status: 'IDLE', budget_cap_usd: 10 },
];
const activity = { threadId: 'thread-second', agentId: 'second', source: 'routine', at: 1 };
const emptyPreviews: Awaited<ReturnType<typeof api.chatThreadPreviews>> = { threads: [], previews: true };
const savedRecord = { record: { id: 'fixture', agent_id: 'second', key: 'fixture', category: 'ui', data_json: '{}', created_at: 1, updated_at: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.chatThreadPreviews).mockResolvedValue(emptyPreviews);
  vi.mocked(api.approvals).mockResolvedValue({ approvals: [], pending: 0, orphaned: 0 });
  vi.mocked(api.providers).mockResolvedValue({ connections: [], secretStorage: { available: true, backend: 'fixture' }, preset: { preset: 'freellmapi', name: 'Fixture', baseUrl: 'http://127.0.0.1:3001/v1' } });
  vi.mocked(api.createAgent).mockResolvedValue({ agent: agents[1] });
  vi.mocked(saveFlags).mockResolvedValue(savedRecord);
  vi.mocked(saveProfile).mockResolvedValue(savedRecord);
  useCortex.setState({ agents, selectedAgentId: 'first', taskRuns: [], routines: [], chatActivity: null,
    refreshState: vi.fn().mockResolvedValue(undefined), refreshRoutines: vi.fn().mockResolvedValue(undefined) });
});

async function mount() {
  let result!: ReturnType<typeof render>;
  await act(async () => { result = render(<GrokWorkspace onToggleGalaxyView={vi.fn()} />); });
  return result;
}

describe('workspace wiring', () => {
  it('duplicates the selected bot configuration through real creation without reusing its identity', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: 'Duplicate second' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Second copy');
    await user.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(api.createAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'second-copy', name: 'Second copy', modelId: 'second/model', connectionId: 'second-provider', routingMode: 'auto', budgetCapUsd: 10 }));
    expect(saveProfile).toHaveBeenCalledWith('second-copy', expect.any(Object));
  });

  it('opens a matched message in its exact thread rather than only selecting the bot', async () => {
    const user = userEvent.setup();
    vi.mocked(api.search).mockResolvedValue({ query: '', results: [{ kind: 'message', id: 'msg-42', title: 'An older result', agentId: 'first', threadId: 'old-thread' }], unsupported: [], truncated: false });
    await mount();
    await user.keyboard('{Control>}k{/Control}');
    await user.click(await screen.findByText('An older result'));
    expect(screen.getByTestId('chat-destination')).toHaveTextContent('old-thread');
    expect(screen.getByTestId('chat-destination')).toHaveTextContent('42');
  });

  it('opens the actual saved data record from a file search result', async () => {
    const user = userEvent.setup();
    vi.mocked(api.search).mockResolvedValue({ query: '', results: [{ kind: 'file', id: 'saved-id', title: 'Report', agentId: 'first' }], unsupported: [], truncated: false });
    vi.mocked(api.agentData).mockResolvedValue({ data: [{ ...savedRecord.record, id: 'saved-id', agent_id: 'first', key: 'report', data_json: '{"result":"Matched report content"}' }] });
    await mount();
    await user.keyboard('{Control>}k{/Control}');
    await user.click(await screen.findByText('Report'));
    expect(await screen.findByText('report.json')).toBeInTheDocument();
    expect(api.agentData).toHaveBeenCalledWith('first');
    expect(screen.getByText(/Matched report content/)).toBeInTheDocument();
  });
  it('passes the active bot provider and routing through actual creation', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole('button', { name: 'Second' }));
    await user.click(screen.getByRole('button', { name: 'New bot' }));
    await user.type(screen.getByLabelText('Name'), 'Inherited');
    await user.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(api.createAgent).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'second/model', connectionId: 'second-provider', routingMode: 'auto' }));
  });

  it('passes the active bot provider and routing through marketplace import', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    fireEvent.click(screen.getByRole('button', { name: 'Marketplace' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Import template' })); });
    expect(api.createAgent).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'second/model', connectionId: 'second-provider', routingMode: 'auto' }));
  });

  it('carries webhook intent from the real editor through the workspace command', async () => {
    const user = userEvent.setup();
    // Keep the draft mounted after the command so this assertion is independent
    // of the routine-list refresh. The daemon lifecycle is tested separately.
    vi.mocked(sendCommand).mockResolvedValue({ success: true, command: 'create_routine', targetId: 'first', data: {} });
    await mount();
    await user.click(screen.getByRole('button', { name: 'Open details' }));
    await user.click(screen.getByRole('button', { name: 'Create Routine' }));
    await user.type(screen.getByPlaceholderText('Name this routine'), 'Webhook routine');
    await user.type(screen.getByPlaceholderText('What should this routine do each time it runs?'), 'Say hello');
    await user.click(screen.getByRole('button', { name: /Add trigger/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Webhook' }));
    await user.click(screen.getByRole('button', { name: 'Create routine' }));
    expect(sendCommand).toHaveBeenCalledWith('create_routine', 'first', expect.objectContaining({ webhookEnabled: true, scheduleEnabled: false }));
  });

  for (const fail of [false, true]) {
    it(`refreshes once per activity, including ${fail ? 'failed' : 'successful'} responses and bot switching`, async () => {
      const view = await mount();
      const initialReads = vi.mocked(api.chatThreadPreviews).mock.calls.length;
      const initialApprovals = vi.mocked(api.approvals).mock.calls.length;
      const pending: Array<{ resolve: (value: typeof emptyPreviews) => void; reject: (error: Error) => void }> = [];
      vi.mocked(api.chatThreadPreviews).mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
      try {
        act(() => useCortex.setState({ chatActivity: activity }));
        expect(pending).toHaveLength(1);
        await act(async () => {
          if (fail) pending.shift()!.reject(new Error('Fixture unavailable'));
          else pending.shift()!.resolve({ threads: [] , previews: true });
        });
        expect(api.chatThreadPreviews).toHaveBeenCalledTimes(initialReads + 1);
        expect(api.approvals).toHaveBeenCalledTimes(initialApprovals + 1);
        fireEvent.click(screen.getByRole('button', { name: 'Second unread' }));
        fireEvent.click(screen.getByRole('button', { name: 'First' }));
        expect(screen.getByRole('button', { name: 'Second' })).toBeInTheDocument();
        expect(api.chatThreadPreviews).toHaveBeenCalledTimes(initialReads + 1);
        act(() => useCortex.setState({ chatActivity: { ...activity, at: 2 } }));
        expect(api.chatThreadPreviews).toHaveBeenCalledTimes(initialReads + 2);
      } finally {
        view.unmount();
        await act(async () => { for (const request of pending) request.resolve(emptyPreviews); });
      }
    });
  }
});
