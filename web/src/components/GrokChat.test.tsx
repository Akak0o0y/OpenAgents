/**
 * Conversation behaviour.
 *
 * These cover the transitions that are expensive to get wrong and invisible
 * when they are: a reply landing in the wrong bot's transcript, a failed send
 * leaving a bubble that was never stored, and a disabled control that gives no
 * reason for being disabled.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokChat } from './GrokChat.js';
import { defaultProfile } from '../lib/botProfile.js';
import { api, type ApprovalRow, type ChatMessageRow, type ProviderConnectionRow } from '../lib/transport.js';
import * as transport from '../lib/transport.js';
import { useCortex } from '../store.js';
import type { Teammate } from './workspaceTypes.js';

// The Aora engine draws with SVG and requestAnimationFrame; it is not what
// these tests are about, and rendering it in jsdom only adds noise.
vi.mock('./BotFace.js', () => ({
  BotFace: () => null,
  usePrefersReducedMotion: () => true,
}));

function teammate(id: string, name: string): Teammate {
  return {
    id,
    name,
    description: `${name} description`,
    model: 'test-model',
    status: 'IDLE',
    budgetCapUsd: 10,
    profile: defaultProfile({ id, name, model_id: 'test-model' }),
    flags: { pinned: false, unread: false, hidden: false, section: null },
    reactions: {},
    threadId: `thread-${id}`,
    lastMessagePreview: null,
    lastMessageAt: null,
  };
}

const atlas = teammate('atlas', 'Atlas');
const ledger = teammate('ledger', 'Ledger');

const noop = () => undefined;

function baseProps(overrides: Partial<React.ComponentProps<typeof GrokChat>> = {}) {
  return {
    activeAgent: atlas,
    draft: null,
    teammates: [atlas, ledger],
    approvals: [] as ApprovalRow[],
    approvalBusyId: null,
    onAnswerApproval: noop,
    onOpenDetails: noop,
    onOpenSettings: noop,
    onToggleDetails: noop,
    isDetailsOpen: true,
    onCancelDraft: noop,
    onDraftKindChange: noop,
    onDraftRecipient: noop,
    onCreateBot: noop,
    onReactionsChange: noop,
    onThreadActivity: noop,
    onShareAsTemplate: noop,
    onNotify: noop,
    ...overrides,
  };
}

function message(id: number, role: 'user' | 'assistant', content: string): ChatMessageRow {
  return { id, thread_id: 'thread-atlas', role, content, created_at: 1_700_000_000_000 + id * 1000 };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'workTasks').mockResolvedValue({ tasks: [{ id: 'cli-arg-parser', name: 'CLI parser', description: 'Build a parser', requirements: ['Parse flags'] }] });
  vi.spyOn(api, 'chatProgress').mockResolvedValue({ progress: null });
  vi.spyOn(api, 'chatThreads').mockImplementation(async (agentId?: string) => ({
    threads: [
      {
        id: `thread-${agentId}`,
        agent_id: agentId!,
        title: 'chat',
        created_at: 1,
        updated_at: 1,
      },
    ],
  }));
  vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: [] });
});

describe('model picker inside the real chat tree', () => {
  beforeEach(() => {
    vi.spyOn(api, 'providers').mockResolvedValue({ secretStorage: { available: true, backend: 'memory' }, preset: { preset: 'freellmapi', name: 'Preset', baseUrl: 'https://example.test' }, connections: [{ id: 'gateway', name: 'Gateway', enabled: true,
      catalog: { models: [{ id: 'test-model', usable: true, virtual: false }] } }] as ProviderConnectionRow[] });
  });

  it('actually removes the dialog DOM with X and Escape, and after saving Automatic', async () => {
    const user = userEvent.setup();
    const onSaveModel = vi.fn().mockResolvedValue(undefined);
    render(<GrokChat {...baseProps({ activeAgent: { ...atlas, connectionId: 'gateway', routingMode: 'pinned' }, onSaveModel })} />);
    const open = async () => {
      await user.click(screen.getByRole('button', { name: 'Choose chat model' }));
      await screen.findByRole('button', { name: 'Use this model' });
    };
    const closed = () => waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose a model' })).not.toBeInTheDocument());
    await open();
    await user.click(screen.getByRole('button', { name: 'Close model browser' }));
    await closed();
    await open();
    await user.keyboard('{Escape}');
    await closed();
    await open();
    await user.click(screen.getByRole('button', { name: /Automatic\s*Allow the provider/ }));
    await user.click(screen.getByRole('button', { name: 'Use this model' }));
    await closed();
    expect(onSaveModel).toHaveBeenCalledWith({ modelId: 'test-model', connectionId: 'gateway', routingMode: 'auto' });
  });

  it('removes a pending save dialog and does not close a subsequently reopened picker', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onSaveModel = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<GrokChat {...baseProps({ activeAgent: { ...atlas, connectionId: 'gateway' }, onSaveModel })} />);
    await user.click(screen.getByRole('button', { name: 'Choose chat model' }));
    await user.click(await screen.findByRole('button', { name: 'Use this model' }));
    await screen.findByRole('button', { name: 'Saving…' });
    await user.click(screen.getByRole('button', { name: 'Close model browser' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Choose chat model' }));
    finish();
    expect(await screen.findByRole('dialog', { name: 'Choose a model' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Use this model' })).toBeEnabled();
  });
});

describe('verified work', () => {
  it('opens the searched older thread and focuses the exact message even within the same bot', async () => {
    const threads = [{ id: 'newest', agent_id: 'atlas', title: 'New', created_at: 2, updated_at: 2 }, { id: 'older', agent_id: 'atlas', title: 'Old', created_at: 1, updated_at: 1 }];
    vi.mocked(api.chatThreads).mockResolvedValue({ threads });
    vi.mocked(api.chatMessages).mockImplementation(async id => ({ messages: [message(id === 'older' ? 42 : 43, 'user', id === 'older' ? 'Found older message' : 'Latest message')] }));
    const view = render(<GrokChat {...baseProps()} />);
    await screen.findByText('Latest message');
    view.rerender(<GrokChat {...baseProps({ navigationTarget: { threadId: 'older', messageId: '42', key: 1 } })} />);
    await screen.findByText('Found older message');
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-message-id', '42'));
    expect(api.chatMessages).toHaveBeenLastCalledWith('older');
    view.rerender(<GrokChat {...baseProps({ navigationTarget: { threadId: 'newest', messageId: '43', key: 2 } })} />);
    await screen.findByText('Latest message');
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-message-id', '43'));
  });

  it('reports a stale search conversation instead of opening an unrelated latest chat', async () => {
    render(<GrokChat {...baseProps({ navigationTarget: { threadId: 'deleted', messageId: '42', key: 1 } })} />);
    expect(await screen.findByText(/searched conversation no longer/)).toBeInTheDocument();
    expect(api.chatMessages).not.toHaveBeenCalled();
  });
  it('uses one agentic chat and reuses its request ID on an uncertain response', async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(api, 'sendChat').mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({ reply: message(2, 'assistant', 'Completed with files'), taskRunId: 'run' });
    render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');
    expect(screen.queryByRole('button', { name: /^Mode/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Message Atlas'), 'Build it');
    await user.click(screen.getByLabelText('Send message'));
    await screen.findByText('Connection lost');
    await user.click(screen.getByLabelText('Send message'));
    await screen.findByText('Completed with files');
    expect(send.mock.calls[0][3]).toBeUndefined();
    expect(send.mock.calls[1][2]).toBe(send.mock.calls[0][2]);
  });

  it('shows actual work progress and sends cancellation with the same request ID', async () => {
    const user = userEvent.setup();
    let resolve!: (value: { reply: ChatMessageRow; taskRunId: string }) => void;
    const send = vi.spyOn(api, 'sendChat').mockReturnValue(new Promise(r => { resolve = r; }));
    const cancel = vi.spyOn(api, 'cancelChat').mockResolvedValue({ stopped: true });
    vi.mocked(api.chatProgress).mockResolvedValue({ progress: { taskRunId: 'run', turn: 3, tool: 'verify', steps: ['Build and check'] } });
    render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');
    await user.type(screen.getByLabelText('Message Atlas'), 'Build it');
    await user.click(screen.getByLabelText('Send message'));
    await screen.findByText(/Checking result/);
    await user.click(screen.getByRole('button', { name: 'Stop request' }));
    expect(cancel).toHaveBeenCalledWith('thread-atlas', send.mock.calls[0][2]);
    resolve({ reply: message(2, 'assistant', 'Stopped by operator'), taskRunId: 'run' });
    await screen.findByText('Stopped by operator');
    expect(screen.queryByRole('button', { name: 'Stop request' })).not.toBeInTheDocument();
  });
});

describe('loading and empty states', () => {
  it('shows a loading state, then the empty welcome', async () => {
    let resolve!: (value: { messages: ChatMessageRow[] }) => void;
    vi.spyOn(api, 'chatMessages').mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );

    render(<GrokChat {...baseProps()} />);
    expect(await screen.findByText(/Opening conversation/)).toBeInTheDocument();

    resolve({ messages: [] });
    expect(await screen.findByText('What should Atlas work on?')).toBeInTheDocument();
  });

  it('surfaces the daemon reason when the conversation cannot be opened', async () => {
    vi.spyOn(api, 'chatThreads').mockRejectedValue(
      new Error('This daemon was started without a chat service.')
    );
    render(<GrokChat {...baseProps()} />);
    expect(
      await screen.findByText('This daemon was started without a chat service.')
    ).toBeInTheDocument();
  });
});

describe('sending', () => {
  it('appends the reply the daemon returned', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'sendChat').mockResolvedValue({
      reply: message(2, 'assistant', 'Reply from the daemon'),
      taskRunId: 'run-1',
    });

    render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');

    await user.type(screen.getByLabelText('Message Atlas'), 'hello');
    await user.click(screen.getByLabelText('Send message'));

    expect(await screen.findByText('Reply from the daemon')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('rolls the optimistic bubble back and restores the draft when the send fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'sendChat').mockRejectedValue(new Error('Budget cap reached for Atlas.'));

    render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');

    const composer = screen.getByLabelText('Message Atlas');
    await user.type(composer, 'expensive question');
    await user.click(screen.getByLabelText('Send message'));

    expect(await screen.findByText('Budget cap reached for Atlas.')).toBeInTheDocument();
    // The bubble is gone: nothing was stored, so nothing should be shown.
    // Scoped to the bubble, because the composer legitimately still holds the
    // same text and would otherwise match.
    expect(
      screen.queryByText('expensive question', { selector: '.grok-bubble' })
    ).not.toBeInTheDocument();
    // ...and the text is back in the composer, not lost.
    expect(composer).toHaveValue('expensive question');
  });

  it('does not deliver a reply to a bot the operator has switched away from', async () => {
    const user = userEvent.setup();
    let resolveSend!: (value: { reply: ChatMessageRow; taskRunId: string }) => void;
    vi.spyOn(api, 'sendChat').mockReturnValue(
      new Promise((r) => {
        resolveSend = r;
      })
    );

    const { rerender } = render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');
    await user.type(screen.getByLabelText('Message Atlas'), 'slow question');
    await user.click(screen.getByLabelText('Send message'));

    // Switch to Ledger while the reply is still in flight.
    rerender(<GrokChat {...baseProps({ activeAgent: ledger })} />);
    await screen.findByText('What should Ledger work on?');
    expect(screen.getByLabelText('Message Ledger')).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Stop request' })).not.toBeInTheDocument();

    resolveSend({
      reply: message(9, 'assistant', 'ATLAS ONLY REPLY'),
      taskRunId: 'run-1',
    });

    await waitFor(() => {
      expect(screen.queryByText('ATLAS ONLY REPLY')).not.toBeInTheDocument();
    });
  });

  it('keeps every bot composer draft separate', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');
    await user.type(screen.getByLabelText('Message Atlas'), 'atlas draft');

    rerender(<GrokChat {...baseProps({ activeAgent: ledger })} />);
    await screen.findByText('What should Ledger work on?');
    expect(screen.getByLabelText('Message Ledger')).toHaveValue('');

    rerender(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');
    expect(screen.getByLabelText('Message Atlas')).toHaveValue('atlas draft');
  });
});

describe('composer capabilities', () => {
  it('offers attachment, explaining that the text is added to the message', async () => {
    render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');

    const attach = screen.getByLabelText('Attach file');
    expect(attach).toBeEnabled();
    expect(attach).toHaveAttribute('title', expect.stringContaining('added to your message'));
  });

  it('disables dictation where the browser cannot do it, with that reason', async () => {
    // jsdom has no SpeechRecognition, which is the same situation as Firefox.
    render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');

    const voice = screen.getByLabelText('Dictate a message');
    expect(voice).toBeDisabled();
    expect(voice).toHaveAttribute('title', expect.stringContaining('no speech recognition'));
  });

  it('attaches a text file and sends its content inline', async () => {
    const user = userEvent.setup();
    const sendChat = vi.spyOn(api, 'sendChat').mockResolvedValue({
      reply: message(2, 'assistant', 'ok'),
      taskRunId: 'run-1',
    });

    render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');

    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['line one'], 'notes.txt', { type: 'text/plain' }));
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(sendChat).toHaveBeenCalled());
    const [, sent] = sendChat.mock.calls[0];
    expect(sent).toContain('Attached file: notes.txt');
    expect(sent).toContain('line one');
  });

  it('reports server validation failure for an invalid binary attachment', async () => {
    vi.spyOn(api, 'systemAction').mockImplementation(async action => {
      if(action==='attachment-upload')throw new Error('Invalid image content.');
      return {questions:[]};
    });
    const user = userEvent.setup();
    render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');

    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['\u0000binary'], 'logo.png', { type: 'image/png' }));

    expect(await screen.findByText(/Invalid image content/)).toBeInTheDocument();
    expect(screen.queryByText('logo.png', { selector: '.grok-attachment-name' })).not.toBeInTheDocument();
  });

  it('lets an attachment be removed before sending', async () => {
    const user = userEvent.setup();
    render(<GrokChat {...baseProps()} />);
    await screen.findByText('What should Atlas work on?');

    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    await screen.findByText('notes.txt');

    await user.click(screen.getByLabelText('Remove notes.txt'));
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  });
});

describe('question cards', () => {
  const approval = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
    id: 'apr-1',
    task_run_id: 'run-1',
    agent_id: 'atlas',
    kind: 'question',
    payload_json: JSON.stringify({
      question: 'Which ledger first?',
      options: [{ id: 'ap', label: 'Accounts payable' }],
    }),
    status: 'PENDING',
    created_at: 1_700_000_005_000,
    waiting: true,
    ...over,
  });

  it('renders an answerable question and reports the chosen answer', async () => {
    const user = userEvent.setup();
    const onAnswerApproval = vi.fn();
    render(<GrokChat {...baseProps({ approvals: [approval()], onAnswerApproval })} />);

    await user.click(await screen.findByRole('button', { name: /Accounts payable/ }));
    expect(onAnswerApproval).toHaveBeenCalledWith('apr-1', 'approve', 'Accounts payable');
  });

  it('disables a pending question nothing is waiting on, and explains it', async () => {
    render(<GrokChat {...baseProps({ approvals: [approval({ waiting: false })] })} />);
    expect(
      await screen.findByText(/no longer active in the daemon/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accounts payable/ })).toBeDisabled();
  });

  it('renders a decided question as completed, with no answer controls', async () => {
    render(
      <GrokChat
        {...baseProps({
          approvals: [
            approval({ status: 'APPROVED', reason: 'Accounts payable', decided_at: 1_700_000_006_000 }),
          ],
        })}
      />
    );
    const card = await screen.findByLabelText('Answered question');
    expect(within(card).getByText('Accounts payable')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('drafts', () => {
  it('offers bot creation and group chat, and never creates anything on its own', async () => {
    const user = userEvent.setup();
    const onDraftKindChange = vi.fn();
    render(
      <GrokChat
        {...baseProps({
          activeAgent: null,
          draft: { kind: 'direct', recipients: [] },
          onDraftKindChange,
        })}
      />
    );

    await user.click(screen.getByLabelText('Search or create Bots'));
    expect(await screen.findByRole('menuitem', { name: /Create new Bot/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Create group chat/ }));
    expect(onDraftKindChange).toHaveBeenCalledWith('group');
  });

  it('says plainly that group conversations are not supported', () => {
    render(
      <GrokChat {...baseProps({ activeAgent: null, draft: { kind: 'group', recipients: [] } })} />
    );
    expect(screen.getByText(/Group conversations are not supported/)).toBeInTheDocument();
  });
});

/**
 * The assistant-ui transcript.
 *
 * A second, real renderer for the same conversation, driven by
 * `useExternalStoreRuntime` over the same daemon calls. These assert the two
 * things that would make the integration a facade rather than an integration:
 * the transcript it shows is the daemon's, and sending through its composer
 * goes to the daemon's chat API - not to a local buffer that looks convincing.
 */
describe('the assistant-ui transcript', () => {

  it('renders the daemon transcript through assistant-ui', async () => {
    vi.spyOn(api, 'chatMessages').mockResolvedValue({
      messages: [
        message(1, 'user', 'ping'),
        message(2, 'assistant', 'pong'),
      ],
    });

    // The assistant-ui view arrives as a prop; nothing in the workspace sets it now.
    render(<GrokChat {...baseProps({ assistantView: true })} />);

    // Same rows, rendered by the other view.
    expect(await screen.findByText('ping')).toBeInTheDocument();
    expect(screen.getByText('pong')).toBeInTheDocument();
  });

  it('sends through the daemon, not into a local buffer', async () => {
    vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: [] });
    const sendChat = vi.spyOn(api, 'sendChat').mockResolvedValue({
      reply: message(9, 'assistant', 'from the daemon'),
    } as never);

    render(<GrokChat {...baseProps({ assistantView: true })} />);

    const input = await screen.findByPlaceholderText('Message Atlas');
    await userEvent.type(input, 'hello there');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(sendChat).toHaveBeenCalled());
    expect(sendChat.mock.calls[0]?.[1]).toBe('hello there');
    expect(await screen.findByText('from the daemon')).toBeInTheDocument();
  });

  it('goes back to the classic transcript, which keeps the richer actions', async () => {
    vi.spyOn(api, 'chatMessages').mockResolvedValue({
      messages: [message(1, 'assistant', 'hello')],
    });

    const { rerender } = render(<GrokChat {...baseProps({ assistantView: true })} />);
    rerender(<GrokChat {...baseProps({ assistantView: false })} />);

    // The message actions only the classic view renders.
    expect(await screen.findByRole('group', { name: 'Message actions' })).toBeInTheDocument();
  });

  it('displays a step row that transitions from running to failed with exit 1', async () => {
    let capturedHandlers: any = null;
    vi.spyOn(transport, 'connect').mockImplementation((handlers) => {
      capturedHandlers = handlers;
      return () => { capturedHandlers = null; };
    });

    let resolveSend!: (val: any) => void;
    vi.spyOn(api, 'sendChat').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; })
    );
    vi.spyOn(api, 'runEvents').mockResolvedValue({ runId: 'run-task-1', events: [], latestEventId: null });

    const user = userEvent.setup();
    const stopStore = useCortex.getState().start();
    useCortex.setState({ liveRuns: {}, runForRequest: {} });

    render(<GrokChat {...baseProps()} />);

    await screen.findByText('What should Atlas work on?');
    await user.type(screen.getByLabelText('Message Atlas'), 'run test suite');
    await user.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(api.sendChat).toHaveBeenCalled());
    const requestId = vi.mocked(api.sendChat).mock.calls[0]?.[2];
    expect(requestId).toBeDefined();

    // 1. Daemon emits TASK_STARTED mapping thread-atlas:requestId to run-task-1
    capturedHandlers.onEvent({
      id: 1,
      task_run_id: 'run-task-1',
      event_type: 'TASK_STARTED',
      payload: { threadId: 'thread-atlas', requestId },
      timestamp: 100,
    });

    // Wait for GrokChat to resolve activeRunId and mount RunActivityCard watching run-task-1
    await waitFor(() => expect(useCortex.getState().liveRuns['run-task-1']?.watchers).toBeGreaterThan(0));

    // 2. Daemon emits WORK_ACTION for running npm test
    capturedHandlers.onEvent({
      id: 2,
      task_run_id: 'run-task-1',
      event_type: 'WORK_ACTION',
      payload: { tool: 'run', command: 'npm test' },
      timestamp: 200,
    });

    // Row should appear live with 'Running command' and 'npm test'
    const stepRow = await screen.findByTestId('step-row');
    expect(within(stepRow).getByText('Running command')).toBeInTheDocument();
    expect(within(stepRow).getAllByText('npm test')).toHaveLength(2);
    expect(within(stepRow).queryByText('exit 1')).not.toBeInTheDocument();

    // 3. Daemon emits TOOL_CALL with error status and exitCode 1
    capturedHandlers.onEvent({
      id: 3,
      task_run_id: 'run-task-1',
      event_type: 'TOOL_CALL',
      payload: { tool: 'run', status: 'error', exit_code: 1, summary: '1 failed' },
      timestamp: 300,
    });

    // Step should update to failed with 'exit 1'
    expect(await within(stepRow).findAllByText('exit 1')).toHaveLength(2);

    // Resolve the send with the completed message having task_run_id
    resolveSend({
      reply: {
        ...message(10, 'assistant', 'Test failed as shown above.'),
        task_run_id: 'run-task-1',
      },
    });

    expect(await screen.findByText('Test failed as shown above.')).toBeInTheDocument();
    // Assistant message now carries WorkedSteps drawer
    expect(screen.getByRole('button', { name: /Show work/ })).toBeInTheDocument();

    stopStore();
  });
});
