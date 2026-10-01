/**
 * Live execution steps and activity reducer.
 *
 * Pure and shared between the daemon tests and the web client.
 * Converts raw execution events into structured steps showing status,
 * tool labels, execution cards, output, and diffs.
 */

export type StepStatus = 'running' | 'waiting' | 'ok' | 'error' | 'stopped';

export type StepCard = 'terminal' | 'diff' | 'read' | 'search' | 'web' | 'browser' | 'generic';

export interface RunStep {
  id: string;
  turn?: number;
  maxTurns?: number;
  tool: string;
  label: string;
  subject?: string;
  status: StepStatus;
  card: StepCard;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  output?: string;
  diff?: string;
  diffMeta?: {
    created?: boolean;
    added?: number;
    removed?: number;
    truncated?: boolean;
  };
  approvalId?: string;
}

export interface TodoItem {
  id?: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface RunActivity {
  runId: string;
  phase: string;
  plan: string[];
  todos?: TodoItem[];
  steps: RunStep[];
  lastEventId?: number;
  thinkingSince?: number;
  tokens?: {
    estimatedTokens?: number;
    lastInputTokens?: number | null;
    contextWindow?: number;
  };
}

/** The daemon's progress tool names, in the words the status strip and step rows use. */
export const TOOL_LABELS: Record<string, string> = {
  declare_results: 'Recording expected results',
  result_status: 'Checking result evidence',
  send_message: 'Sending message and checking receipt',
  reconcile_message: 'Checking an earlier message receipt',
  plan: 'Planning',
  todo_write: 'Updating checklist',
  read: 'Reading files',
  write: 'Writing files',
  edit: 'Editing file',
  list: 'Listing directory',
  glob: 'Finding files',
  grep: 'Searching code',
  diff: 'Reviewing changes',
  run: 'Running command',
  verify: 'Checking result',
  mcp: 'Tool request',
  web_read: 'Reading website',
  web_search: 'Searching the web',
  github_issues: 'Searching GitHub issues',
  browser: 'Using browser',
  start_mission: 'Starting mission',
  mission_items: 'Checking earlier issues',
  track_issue: 'Recording issue',
  answer: 'Writing answer',
  finish: 'Saving files',
  block: 'Reporting blocker',
};

export function cardForTool(tool: string): StepCard {
  switch (tool) {
    case 'run':
      return 'terminal';
    case 'write':
    case 'edit':
    case 'diff':
      return 'diff';
    case 'read':
      return 'read';
    case 'web_search':
    case 'github_issues':
    case 'list':
    case 'glob':
    case 'grep':
      return 'search';
    case 'web_read':
      return 'web';
    case 'browser':
      return 'browser';
    default:
      return 'generic';
  }
}

export function emptyRunActivity(runId = ''): RunActivity {
  return {
    runId,
    phase: 'idle',
    plan: [],
    steps: [],
  };
}

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

function parsePayload(event: { payload_json?: unknown; payload?: unknown }): Record<string, any> {
  const raw = event.payload_json ?? event.payload;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object') {
    return raw as Record<string, any>;
  }
  return {};
}

function extractSubject(tool: string, payload: Record<string, any>): string | undefined {
  if (tool === 'run' && typeof payload.command === 'string') return payload.command;
  if (tool === 'todo_write') {
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const inProg = rawItems.find((i: any) => i && i.status === 'in_progress');
    if (inProg && typeof inProg.text === 'string') return inProg.text;
    const completed = rawItems.filter((i: any) => i && i.status === 'completed').length;
    return `${completed}/${rawItems.length} completed`;
  }
  if ((tool === 'read' || tool === 'write' || tool === 'edit' || tool === 'list') && typeof payload.path === 'string') return payload.path;
  if ((tool === 'glob' || tool === 'grep') && typeof payload.pattern === 'string') return payload.pattern;
  if (tool === 'web_read' && typeof payload.url === 'string') return payload.url;
  if ((tool === 'web_search' || tool === 'github_issues') && typeof payload.query === 'string') return payload.query;
  if (tool === 'mcp') {
    const s = payload.server ? `${payload.server}/${payload.name ?? 'tool'}` : payload.name;
    if (typeof s === 'string') return s;
  }
  return typeof payload.subject === 'string'
    ? payload.subject
    : typeof payload.query === 'string'
      ? payload.query
      : typeof payload.path === 'string'
        ? payload.path
        : typeof payload.command === 'string'
          ? payload.command
          : typeof payload.url === 'string'
            ? payload.url
            : undefined;
}

/**
 * Pure reducer accumulating events for a single task run into RunActivity.
 */
export function reduceActivity(state: RunActivity, event: any): RunActivity {
  if (!event || !event.event_type) return state;

  // Deduplication: skip if event ID was already processed
  if (
    typeof event.id === 'number' &&
    typeof state.lastEventId === 'number' &&
    event.id <= state.lastEventId
  ) {
    return state;
  }

  const lastEventId = typeof event.id === 'number'
    ? Math.max(state.lastEventId ?? 0, event.id)
    : state.lastEventId;

  const runId = state.runId || event.task_run_id || '';
  const payload = parsePayload(event);
  const ts = typeof event.timestamp === 'number' ? event.timestamp : Date.now();

  switch (event.event_type) {
    case 'RESOURCE_WAIT':
      return {...state,phase:'waiting',lastEventId};
    case 'TASK_STARTED': {
      return {
        ...state,
        runId,
        phase: 'running',
        lastEventId,
      };
    }

    case 'WORK_PLAN': {
      const plan = Array.isArray(payload.steps)
        ? payload.steps.map(String)
        : Array.isArray(payload.plan)
          ? payload.plan.map(String)
          : state.plan;
      return {
        ...state,
        plan,
        lastEventId,
      };
    }

    case 'WORK_TODO': {
      const rawItems = Array.isArray(payload.items) ? payload.items : [];
      const todos: TodoItem[] = rawItems
        .filter((item: any) => item && typeof item.text === 'string')
        .map((item: any, idx: number) => ({
          id: typeof item.id === 'string' ? item.id : String(idx + 1),
          text: String(item.text),
          status: item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending',
        }));
      return {
        ...state,
        todos,
        lastEventId,
      };
    }

    case 'HISTORY_APPENDED': {
      const estimatedTokens = typeof payload.estimatedTokens === 'number' ? payload.estimatedTokens : undefined;
      const lastInputTokens = typeof payload.lastInputTokens === 'number' || payload.lastInputTokens === null ? payload.lastInputTokens : undefined;
      const contextWindow = typeof payload.contextWindow === 'number' ? payload.contextWindow : undefined;
      return {
        ...state,
        tokens: (estimatedTokens !== undefined || contextWindow !== undefined) ? {
          estimatedTokens,
          lastInputTokens,
          contextWindow,
        } : state.tokens,
        lastEventId,
      };
    }

    case 'PROVIDER_CALL': {
      const isAttempt = payload.phase === 'attempt' || payload.status === 'attempt';
      const isEnded = payload.phase === 'complete' || payload.phase === 'failed' || payload.status === 'complete' || payload.status === 'failed';
      return {
        ...state,
        thinkingSince: isAttempt ? ts : isEnded ? undefined : state.thinkingSince,
        lastEventId,
      };
    }

    case 'WORK_ACTION': {
      const tool = String(payload.tool || 'action');
      const label = TOOL_LABELS[tool] ?? (tool.charAt(0).toUpperCase() + tool.slice(1));
      const card = cardForTool(tool);
      const subject = extractSubject(tool, payload);
      const stepId = String(payload.callId || `step-${state.steps.length + 1}-${event.id ?? ts}`);

      const newStep: RunStep = {
        id: stepId,
        turn: event.turn_number ?? payload.turn,
        maxTurns: payload.maxTurns,
        tool,
        label,
        subject,
        status: 'running',
        card,
        startedAt: ts,
      };

      return {
        ...state,
        runId,
        phase: 'running',
        steps: [...state.steps, newStep],
        lastEventId,
      };
    }

    case 'TOOL_CALL': {
      let openIndex = -1;
      if (payload.callId) {
        openIndex = state.steps.findIndex((s: RunStep) => s.id === payload.callId);
      }
      if (openIndex === -1) {
        openIndex = findLastIndex(
          state.steps,
          (s: RunStep) => s.status === 'running' || s.status === 'waiting'
        );
      }

      const exitCode =
        typeof payload.exitCode === 'number'
          ? payload.exitCode
          : typeof payload.exit_code === 'number'
            ? payload.exit_code
            : undefined;

      const isError =
        (typeof exitCode === 'number' && exitCode !== 0) ||
        payload.status === 'error' ||
        payload.status === 'failed';

      if (openIndex === -1) {
        if (payload.notRun) {
          return {
            ...state,
            lastEventId,
          };
        }
        // A TOOL_CALL with no open step is a standalone error step ('invalid')
        const invalidStep: RunStep = {
          id: String(payload.callId || `step-${state.steps.length + 1}-${event.id ?? ts}`),
          turn: event.turn_number ?? payload.turn,
          tool: 'invalid',
          label: 'Invalid tool call',
          subject: typeof payload.summary === 'string' ? payload.summary : 'Unexpected tool call without action',
          status: 'error',
          card: 'generic',
          startedAt: ts,
          endedAt: ts,
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
          output: typeof payload.summary === 'string' ? payload.summary : String(payload.error ?? 'Invalid tool call'),
        };

        return {
          ...state,
          steps: [...state.steps, invalidStep],
          lastEventId,
        };
      }

      const updatedSteps = [...state.steps];
      const openStep = updatedSteps[openIndex];
      const presDiff = payload.presentation?.diff;
      const diff =
        typeof presDiff === 'string'
          ? presDiff
          : (presDiff?.patch ??
            (payload.diff ? (typeof payload.diff === 'string' ? payload.diff : payload.diff.patch) : openStep.diff));
      const diffMeta =
        typeof presDiff === 'object' && presDiff !== null
          ? {
              created: presDiff.created ?? payload.presentation?.diffMeta?.created,
              added: presDiff.added ?? payload.presentation?.diffMeta?.added,
              removed: presDiff.removed ?? payload.presentation?.diffMeta?.removed,
              truncated: presDiff.truncated ?? payload.presentation?.diffMeta?.truncated,
            }
          : (payload.presentation?.diffMeta ?? openStep.diffMeta);
      const card = (presDiff || diff) ? 'diff' : openStep.card;

      updatedSteps[openIndex] = {
        ...openStep,
        card,
        status: isError ? 'error' : 'ok',
        endedAt: ts,
        exitCode,
        output: typeof payload.summary === 'string' ? payload.summary : typeof payload.output === 'string' ? payload.output : openStep.output,
        diff,
        diffMeta,
      };

      return {
        ...state,
        steps: updatedSteps,
        lastEventId,
      };
    }

    case 'APPROVAL_REQUESTED': {
      let openIndex = -1;
      if (payload.callId) {
        openIndex = state.steps.findIndex((s: RunStep) => s.id === payload.callId);
      }
      if (openIndex === -1) {
        openIndex = findLastIndex(state.steps, (s: RunStep) => s.status === 'running');
      }
      if (openIndex === -1) return { ...state, lastEventId };

      const updatedSteps = [...state.steps];
      updatedSteps[openIndex] = {
        ...updatedSteps[openIndex],
        status: 'waiting',
        approvalId: String(payload.approvalId || payload.id || ''),
      };

      return {
        ...state,
        steps: updatedSteps,
        lastEventId,
      };
    }

    case 'WORK_REPORT': {
      let openIndex = -1;
      if (payload.callId) {
        openIndex = state.steps.findIndex((s: RunStep) => s.id === payload.callId);
      }
      if (openIndex === -1) {
        openIndex = findLastIndex(
          state.steps,
          (s: RunStep) => s.status === 'running' || s.status === 'waiting'
        );
      }
      if (openIndex === -1) return { ...state, lastEventId };

      const openStep = state.steps[openIndex];
      const closable = ['answer', 'finish', 'start_mission', 'proposal'].includes(openStep.tool);

      if (closable) {
        const updatedSteps = [...state.steps];
        updatedSteps[openIndex] = {
          ...openStep,
          status: 'ok',
          endedAt: ts,
          output: typeof payload.outcome === 'string' ? payload.outcome : openStep.output,
        };
        return {
          ...state,
          steps: updatedSteps,
          lastEventId,
        };
      }

      return { ...state, lastEventId };
    }

    case 'TASK_COMPLETED':
    case 'TASK_FAILED':
    case 'TASK_ABORTED':
    case 'TASK_CRASHED': {
      const phase =
        event.event_type === 'TASK_COMPLETED'
          ? 'completed'
          : event.event_type === 'TASK_FAILED'
            ? 'failed'
            : event.event_type === 'TASK_ABORTED'
              ? 'aborted'
              : 'crashed';

      // Turns any running or waiting step into stopped
      const steps = state.steps.map((step) => {
        if (step.status === 'running' || step.status === 'waiting') {
          return {
            ...step,
            status: 'stopped' as StepStatus,
            endedAt: ts,
          };
        }
        return step;
      });

      return {
        ...state,
        phase,
        steps,
        thinkingSince: undefined,
        lastEventId,
      };
    }

    default:
      return {
        ...state,
        lastEventId,
      };
  }
}
