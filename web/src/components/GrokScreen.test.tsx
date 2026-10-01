import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokScreen } from './GrokScreen.js';
import type { Teammate } from './workspaceTypes.js';
import type { ComputerSession } from '../lib/useComputerSession.js';
import { api, type PendingEffectRow, type RoutineRow } from '../lib/transport.js';

vi.mock('./BotSystemPanel.js', () => ({ BotSystemPanel: () => <div data-testid="bot-system-panel" /> }));
vi.mock('../lib/transport.js', () => ({
  api: {
    chat: async () => ({}),
    systemAction: async () => ({ available: false, state: null }),
    // The details view reads unconfirmed posts for the "Waiting for you" marker.
    botSystem: async () => ({}),
  },
}));

const mockAgent: Teammate = {
  id: 'new-bot',
  name: 'New Bot',
  description: '',
  model: 'test-model',
  status: 'IDLE',
  budgetCapUsd: 10,
  profile: {
    shape: 'pebble',
    color: '#2C86F0',
    eyeColor: '#000000',
    eyeScale: 1.0,
    emotion: '01',
    idle: true,
    sketch: false,
    label: '',
    notifications: true,
    avatarImage: null,
  },
  flags: { pinned: false, unread: false, hidden: false, section: null },
  reactions: {},
  threadId: null,
  lastMessagePreview: null,
  lastMessageAt: null,
};

describe('GrokScreen desktop preview', () => {
  it('keeps the browser card usable when a code workspace is unavailable', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const computer: ComputerSession = {
      state: 'unreachable',
      files: [],
      reason: null,
      runId: null,
      retrying: false,
      retry,
    };

    render(
      <GrokScreen
        agent={mockAgent}
        details={{ open: true, view: 'details', routineId: null }}
        computer={computer}
        routines={[]}
        routinesError={null}
        routinesLoading={false}
        profileError={null}
        onClose={vi.fn()}
        onSetView={vi.fn()}
        onUpdateProfile={vi.fn()}
        onSaveAgent={vi.fn()}
        onSaveRoutine={vi.fn()}
        onDeleteRoutine={vi.fn()}
        onTestRunRoutine={vi.fn()}
        onSetRoutineEnabled={vi.fn()}
        onSetRoutineWebhook={vi.fn()}
      />
    );

    expect(screen.queryByText(/Can't reach/)).not.toBeInTheDocument();
    expect(await screen.findByText('Idle — no desktop session')).toBeInTheDocument();
    expect(screen.getByText("New Bot's screen")).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name:'Open browser'}));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });

  it('shows the browser connection state separately from a starting code workspace', async () => {
    const computer: ComputerSession = {
      state: 'starting',
      files: [],
      reason: null,
      runId: 'run-1',
      retrying: false,
      retry: vi.fn(),
    };

    render(
      <GrokScreen
        agent={mockAgent}
        details={{ open: true, view: 'details', routineId: null }}
        computer={computer}
        routines={[]}
        routinesError={null}
        routinesLoading={false}
        profileError={null}
        onClose={vi.fn()}
        onSetView={vi.fn()}
        onUpdateProfile={vi.fn()}
        onSaveAgent={vi.fn()}
        onSaveRoutine={vi.fn()}
        onDeleteRoutine={vi.fn()}
        onTestRunRoutine={vi.fn()}
        onSetRoutineEnabled={vi.fn()}
        onSetRoutineWebhook={vi.fn()}
      />
    );

    expect(screen.getByText('Connecting to browser')).toBeInTheDocument();
    expect(await screen.findByText('Idle — no desktop session')).toBeInTheDocument();
  });

  it('shows the idle bot screen when no code workspace is required', async () => {
    const computer: ComputerSession = {
      state: 'not-required',
      files: [],
      reason: 'No computer workspace needed',
      runId: 'run-2',
      retrying: false,
      retry: vi.fn(),
    };

    render(
      <GrokScreen
        agent={mockAgent}
        details={{ open: true, view: 'details', routineId: null }}
        computer={computer}
        routines={[]}
        routinesError={null}
        routinesLoading={false}
        profileError={null}
        onClose={vi.fn()}
        onSetView={vi.fn()}
        onUpdateProfile={vi.fn()}
        onSaveAgent={vi.fn()}
        onSaveRoutine={vi.fn()}
        onDeleteRoutine={vi.fn()}
        onTestRunRoutine={vi.fn()}
        onSetRoutineEnabled={vi.fn()}
        onSetRoutineWebhook={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: "Open browser" })).toBeInTheDocument();
    expect(await screen.findByText('Idle — no desktop session')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('does not invent browser activity merely because an agent is busy', async () => {
    const computer: ComputerSession = {
      state: 'idle',
      files: [],
      reason: null,
      runId: 'run-3',
      retrying: false,
      retry: vi.fn(),
    };

    render(
      <GrokScreen
        agent={{ ...mockAgent, status: 'BUSY' }}
        details={{ open: true, view: 'details', routineId: null }}
        computer={computer}
        routines={[]}
        routinesError={null}
        routinesLoading={false}
        profileError={null}
        onClose={vi.fn()}
        onSetView={vi.fn()}
        onUpdateProfile={vi.fn()}
        onSaveAgent={vi.fn()}
        onSaveRoutine={vi.fn()}
        onDeleteRoutine={vi.fn()}
        onTestRunRoutine={vi.fn()}
        onSetRoutineEnabled={vi.fn()}
        onSetRoutineWebhook={vi.fn()}
      />
    );

    expect(await screen.findByText('Idle — no desktop session')).toBeInTheDocument();
    expect(screen.queryByAltText('Live bot browser page')).not.toBeInTheDocument();
  });

  it('renders GrokFileViewer when details.view is file', () => {
    render(
      <GrokScreen
        agent={mockAgent}
        details={{
          open: true,
          view: 'file',
          routineId: null,
          selectedFile: { path: 'index.html', content: '<h1>Hello World</h1>' },
        }}
        computer={{ state: 'idle', files: [], reason: null, runId: null, retrying: false, retry: vi.fn() }}
        routines={[]}
        routinesError={null}
        routinesLoading={false}
        profileError={null}
        onClose={vi.fn()}
        onSetView={vi.fn()}
        onUpdateProfile={vi.fn()}
        onSaveAgent={vi.fn()}
        onSaveRoutine={vi.fn()}
        onDeleteRoutine={vi.fn()}
        onTestRunRoutine={vi.fn()}
        onSetRoutineEnabled={vi.fn()}
        onSetRoutineWebhook={vi.fn()}
      />
    );

    expect(screen.getByText('index.html')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /preview/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /code/i })).toBeInTheDocument();
  });

  it('calls onOpenFile when a workspace file item is clicked in computer view', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const computer: ComputerSession = {
      state: 'connected',
      files: ['index.html', 'styles.css'],
      reason: null,
      runId: 'run-42',
      retrying: false,
      retry: vi.fn(),
    };

    render(
      <GrokScreen
        agent={mockAgent}
        details={{ open: true, view: 'details', routineId: null }}
        computer={computer}
        routines={[]}
        routinesError={null}
        routinesLoading={false}
        profileError={null}
        onClose={vi.fn()}
        onSetView={vi.fn()}
        onUpdateProfile={vi.fn()}
        onSaveAgent={vi.fn()}
        onSaveRoutine={vi.fn()}
        onDeleteRoutine={vi.fn()}
        onTestRunRoutine={vi.fn()}
        onSetRoutineEnabled={vi.fn()}
        onSetRoutineWebhook={vi.fn()}
        onOpenFile={onOpenFile}
      />
    );

    await user.click(screen.getByText('Files (2)'));
    const fileButton = screen.getByRole('button', {name:'index.html'});
    expect(fileButton).toBeInTheDocument();
    await user.click(fileButton);
    expect(onOpenFile).toHaveBeenCalledWith({ path: 'index.html', runId: 'run-42' });
  });

  it('marks a routine held by its own unconfirmed post, and none that only lists a deleted routine’s', async () => {
    const routineRow = (id: string, name: string): RoutineRow => ({
      id, agent_id: 'new-bot', name, cron_expression: '*/15 * * * *', timezone: 'UTC', prompt_template: `Run ${name}`,
      enabled: 1, schedule_enabled: 1, catch_up_policy: 'skip', next_run_at: Date.UTC(2026, 8, 24, 9, 0), created_at: 1, updated_at: 1,
    });
    const item = (routineId: string, routineName: string, routineDeleted: boolean, runId: string): PendingEffectRow => ({
      routineId, routineName, routineDeleted, runId, at: Date.UTC(2026, 8, 22, 10, 56, 50), kind: 'action', origin: 'https://x.com', before: true,
      detail: `Not started: run ${runId} at 2026-09-22 10:56 UTC submitted something on x.com whose result was never confirmed. Check the account, then choose “Checked — continue” on this routine.`,
    });
    const botSystem = vi.spyOn(api, 'botSystem').mockResolvedValue({
      missions: [], memory: [], vault: { configured: false }, capacity: { used: 0, limit: 2 }, publishPolicies: [],
      pendingEffects: [item('rtn-viral', 'viral-life', false, 'run-1790074518658-wveu4'), item('rtn-gone', 'Milo life', true, 'run-1789974004374-yf8vs')],
    });

    render(
      <GrokScreen
        agent={mockAgent}
        details={{ open: true, view: 'details', routineId: null }}
        computer={{ state: 'idle', files: [], reason: null, runId: null, retrying: false, retry: vi.fn() }}
        routines={[routineRow('rtn-viral', 'viral-life'), routineRow('rtn-honest', 'honest-tweet')]}
        routinesError={null}
        routinesLoading={false}
        profileError={null}
        onClose={vi.fn()}
        onSetView={vi.fn()}
        onUpdateProfile={vi.fn()}
        onSaveAgent={vi.fn()}
        onSaveRoutine={vi.fn()}
        onDeleteRoutine={vi.fn()}
        onTestRunRoutine={vi.fn()}
        onSetRoutineEnabled={vi.fn()}
        onSetRoutineWebhook={vi.fn()}
      />
    );

    const marker = await screen.findByText('Waiting for you');
    expect(marker).toHaveAttribute('title', 'An unconfirmed post needs checking');
    expect(screen.getByRole('button', { name: /viral-life/ })).toContainElement(marker);
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /honest-tweet/ })).not.toHaveTextContent('Waiting for you');
    expect(botSystem).toHaveBeenCalledWith('new-bot');
  });
});
