import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RunActivityCard } from './RunActivityCard.js';
import { useCortex } from '../store.js';
import { defaultProfile } from '../lib/botProfile.js';
import type { Teammate } from './workspaceTypes.js';

vi.mock('./BotFace.js', () => ({
  BotFace: () => <div data-testid="bot-face" />,
  usePrefersReducedMotion: () => true,
}));

function makeAgent(id: string, name: string): Teammate {
  return {
    id,
    name,
    description: `${name} desc`,
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

const atlas = makeAgent('atlas', 'Atlas');

describe('RunActivityCard', () => {
  beforeEach(() => {
    useCortex.setState({ liveRuns: {} });
  });

  it('renders thinking state when there are no steps', () => {
    render(<RunActivityCard runId="run-1" agent={atlas} />);

    expect(screen.getByTestId('run-activity-card')).toBeInTheDocument();
    expect(screen.getByText('Atlas is thinking')).toBeInTheDocument();
    expect(screen.getByTestId('bot-face')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-steps')).not.toBeInTheDocument();
  });

  it('renders plan items and steps when present', () => {
    useCortex.setState({
      liveRuns: {
        'run-1': {
          events: [],
          activity: {
            runId: 'run-1',
            phase: 'running',
            plan: ['Analyze codebase', 'Execute tests'],
            steps: [
              {
                id: 'step-1',
                turn: 1,
                tool: 'run',
                label: 'Running command',
                subject: 'npm test',
                status: 'running',
                card: 'terminal',
                startedAt: 1000,
              },
            ],
          },
          watchers: 1,
        },
      },
    });

    render(<RunActivityCard runId="run-1" agent={atlas} />);

    expect(screen.getByText('Task plan (2 items)')).toBeInTheDocument();
    expect(screen.getByText('Analyze codebase')).toBeInTheDocument();
    expect(screen.getByText('Execute tests')).toBeInTheDocument();

    const stepsContainer = screen.getByTestId('activity-steps');
    expect(within(stepsContainer).getByText('Running command')).toBeInTheDocument();
    expect(within(stepsContainer).getAllByText('npm test')).toHaveLength(2); // In header and in terminal card
  });

  it('displays step failure exit code and output when step is failed', () => {
    useCortex.setState({
      liveRuns: {
        'run-2': {
          events: [],
          activity: {
            runId: 'run-2',
            phase: 'failed',
            plan: [],
            steps: [
              {
                id: 'step-err',
                turn: 1,
                tool: 'run',
                label: 'Running command',
                subject: 'npm test',
                status: 'error',
                card: 'terminal',
                startedAt: 1000,
                endedAt: 2500,
                exitCode: 1,
                output: 'FAIL test/example.test.ts',
              },
            ],
          },
          watchers: 1,
        },
      },
    });

    render(<RunActivityCard runId="run-2" agent={atlas} />);

    expect(screen.getAllByText('exit 1')).not.toHaveLength(0);
    expect(screen.getByText('FAIL test/example.test.ts')).toBeInTheDocument();
  });

  it('shows progress without exposing raw reasoning when an attempt is thinking', () => {
    useCortex.setState({
      liveRuns: {
        'run-think': {
          events: [],
          activity: {
            runId: 'run-think',
            phase: 'running',
            plan: [],
            steps: [],
          },
          watchers: 1,
          attempt: {
            attemptId: 'run-think:1',
            revision: 1,
            text: '',
            reasoning: 'First I need to check the filesystem structure.',
          },
        },
      },
    });

    render(<RunActivityCard runId="run-think" agent={atlas} />);

    expect(screen.getByText('Working on the next step…')).toBeInTheDocument();
    expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument();
    expect(screen.queryByText('First I need to check the filesystem structure.')).not.toBeInTheDocument();
  });

  it('renders streaming text and extracts partial answer from JSON', () => {
    useCortex.setState({
      liveRuns: {
        'run-stream': {
          events: [],
          activity: {
            runId: 'run-stream',
            phase: 'running',
            plan: [],
            steps: [],
          },
          watchers: 1,
          attempt: {
            attemptId: 'run-stream:1',
            revision: 1,
            text: '{"tool":"answer","text":"Here is the solution to your issue.',
            reasoning: '',
          },
        },
      },
    });

    render(<RunActivityCard runId="run-stream" agent={atlas} />);

    expect(screen.getByTestId('streaming-text')).toBeInTheDocument();
    expect(screen.getByText('Here is the solution to your issue.')).toBeInTheDocument();
  });

  it('renders abandoned notice when attempt is marked abandoned', () => {
    useCortex.setState({
      liveRuns: {
        'run-abandoned': {
          events: [],
          activity: {
            runId: 'run-abandoned',
            phase: 'running',
            plan: [],
            steps: [],
          },
          watchers: 1,
          attempt: {
            attemptId: 'run-abandoned:1',
            revision: 1,
            text: 'Should be discarded',
            reasoning: '',
            abandoned: true,
          },
        },
      },
    });

    render(<RunActivityCard runId="run-abandoned" agent={atlas} />);

    expect(screen.getByTestId('abandoned-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('streaming-text')).not.toBeInTheDocument();
  });

  it('renders step counter badge with Step X of Y when maxTurns is present', () => {
    useCortex.setState({
      liveRuns: {
        'run-step-counter': {
          events: [],
          activity: {
            runId: 'run-step-counter',
            phase: 'running',
            plan: [],
            steps: [
              {
                id: 'step-3',
                turn: 3,
                maxTurns: 60,
                tool: 'edit',
                label: 'Editing file',
                subject: 'src/app.ts',
                status: 'running',
                card: 'diff',
                startedAt: 1000,
              },
            ],
          },
          watchers: 1,
        },
      },
    });

    render(<RunActivityCard runId="run-step-counter" agent={atlas} />);

    const counter = screen.getByTestId('step-counter');
    expect(counter).toBeInTheDocument();
    expect(counter).toHaveTextContent('Step 3 of 60');
  });

  it('renders todos checklist when activity.todos is present', () => {
    useCortex.setState({
      liveRuns: {
        'run-todos': {
          events: [],
          activity: {
            runId: 'run-todos',
            phase: 'running',
            plan: ['Old plan item'],
            todos: [
              { id: '1', text: 'First task', status: 'completed' },
              { id: '2', text: 'Second task', status: 'in_progress' },
              { id: '3', text: 'Third task', status: 'pending' },
            ],
            steps: [],
          },
          watchers: 1,
        },
      },
    });

    render(<RunActivityCard runId="run-todos" agent={atlas} />);

    const checklist = screen.getByTestId('activity-checklist');
    expect(checklist).toBeInTheDocument();
    expect(within(checklist).getByText('Checklist (1/3 completed)')).toBeInTheDocument();
    expect(within(checklist).getByText('First task')).toBeInTheDocument();
    expect(within(checklist).getByText('Second task')).toBeInTheDocument();
    expect(within(checklist).getByText('Third task')).toBeInTheDocument();
    // Old plan details should not be rendered when todos exist
    expect(screen.queryByText(/Task plan/)).not.toBeInTheDocument();
  });

  it('renders token meter with percentage and compact format tooltip when tokens info is present', () => {
    useCortex.setState({
      liveRuns: {
        'run-token-meter': {
          events: [],
          activity: {
            runId: 'run-token-meter',
            phase: 'running',
            plan: [],
            steps: [],
            tokens: {
              estimatedTokens: 45000,
              lastInputTokens: null,
              contextWindow: 100000,
            },
          },
          watchers: 1,
        },
      },
    });

    render(<RunActivityCard runId="run-token-meter" agent={atlas} />);

    const meter = screen.getByTestId('token-meter');
    expect(meter).toBeInTheDocument();
    expect(within(meter).getByText('45%')).toBeInTheDocument();
    expect(meter.getAttribute('title')).toContain('45%');
    expect(meter.getAttribute('title')).toContain('100K');
  });

  it('renders token meter with warn and danger tone classes at >= 70% and >= 85%', () => {
    // 75% -> oh-token-warn
    useCortex.setState({
      liveRuns: {
        'run-warn': {
          events: [],
          activity: {
            runId: 'run-warn',
            phase: 'running',
            plan: [],
            steps: [],
            tokens: {
              estimatedTokens: 75000,
              lastInputTokens: null,
              contextWindow: 100000,
            },
          },
          watchers: 1,
        },
      },
    });

    const { rerender } = render(<RunActivityCard runId="run-warn" agent={atlas} />);
    const warnFill = document.querySelector('.oh-token-meter-fill');
    expect(warnFill).toHaveClass('oh-token-warn');
    expect(warnFill).not.toHaveClass('oh-token-danger');

    // 90% -> oh-token-danger
    useCortex.setState({
      liveRuns: {
        'run-danger': {
          events: [],
          activity: {
            runId: 'run-danger',
            phase: 'running',
            plan: [],
            steps: [],
            tokens: {
              estimatedTokens: 90000,
              lastInputTokens: null,
              contextWindow: 100000,
            },
          },
          watchers: 1,
        },
      },
    });

    rerender(<RunActivityCard runId="run-danger" agent={atlas} />);
    const dangerFill = document.querySelector('.oh-token-meter-fill');
    expect(dangerFill).toHaveClass('oh-token-danger');
  });
});

