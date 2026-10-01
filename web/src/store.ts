/**
 * Cortex client state.
 *
 * One rule shapes this store: the panel renders ONLY events the daemon actually
 * sent. There is no optimistic state, no interpolation, and no placeholder
 * activity while waiting - an empty run must look empty.
 */

import { create } from 'zustand';
import {
  activityFromEvents,
  emptyActivity,
  type CortexActivity,
} from '@kernel/cortex/layer-view.js';
import {
  reduceActivity,
  emptyRunActivity,
  type RunActivity,
} from '@kernel/cortex/run-steps.js';
import type { McpNodeInfo } from '@kernel/cortex/galaxy.js';
import {
  api,
  connect,
  subscribeRuns,
  unsubscribeRuns,
  type AgentRow,
  type ConnectionState,
  type EventRow,
  type LayerRow,
  type RoutineRow,
  type RunLiveFrame,
  type TaskRunRow,
} from './lib/transport.js';

export interface LiveAttemptState {
  attemptId: string;
  revision: number;
  text: string;
  reasoning: string;
  phase?: 'start' | 'end';
  outcome?: 'committed' | 'abandoned';
  abandoned?: boolean;
}

export interface LiveRunState {
  events: EventRow[];
  activity: RunActivity;
  watchers: number;
  attempt?: LiveAttemptState | null;
}

export function partialAnswerText(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{')) return raw;
  const match = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return raw;
}


/**
 * View settings. Rendering only - nothing here can change what the panel
 * claims about the agent, only how it is drawn.
 */
export interface ViewSettings {
  particlesPerLayer: number;
  rotate: boolean;
  reducedMotion: boolean;
  labels: 'auto' | 'all' | 'none';
  seed: number;
}

interface CortexState {
  connection: ConnectionState;
  mcp: McpNodeInfo[];
  /** Which executor the daemon is running, so the UI can refuse steer honestly. */
  executor: string | null;
  view: ViewSettings;
  setView: (patch: Partial<ViewSettings>) => void;
  agents: AgentRow[];
  taskRuns: TaskRunRow[];
  layers: LayerRow[];
  routines: RoutineRow[];
  selectedRunId: string | null;
  selectedAgentId: string | null;
  /** Explicit custom links configured for bots (e.g. agentId -> list of capability/tool IDs) */
  linkedCapabilities: Record<string, string[]>;
  events: EventRow[];
  activity: CortexActivity;
  error: string | null;
  /**
   * The last message the daemon posted into a conversation by itself - a
   * routine result, a mission step, a decided proposal. An open chat watches
   * this to refresh without a reload.
   */
  chatActivity: { threadId: string; agentId?: string | null; source: string; at: number } | null;
  liveRuns: Record<string, LiveRunState>;
  runForRequest: Record<string, string>;

  start: () => () => void;
  refreshState: () => Promise<void>;
  refreshRoutines: () => Promise<void>;
  watchRun: (runId: string) => () => void;
  selectRun: (runId: string | null) => Promise<void>;
  selectAgent: (agentId: string | null) => void;
  isCapabilityLinked: (agentId: string, capabilityId: string) => boolean;
}

function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.includes('\r')) return normalized;
  return normalized
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r');
      let result = '';
      for (const part of parts) {
        if (part.length >= result.length) {
          result = part;
        } else {
          result = part + result.slice(part.length);
        }
      }
      return result;
    })
    .join('\n');
}

/** Newest first, so the sidebar shows what is happening now at the top. */
function sortRuns(runs: TaskRunRow[]): TaskRunRow[] {
  return [...runs].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
}

export const useCortex = create<CortexState>((set, get) => ({
  connection: 'connecting',
  mcp: [],
  chatActivity: null,
  executor: null,
  view: {
    particlesPerLayer: 1400,
    rotate: true,
    reducedMotion: false,
    labels: 'auto',
    seed: 0x5eed,
  },
  setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),
  agents: [],
  taskRuns: [],
  layers: [],
  routines: [],
  selectedRunId: null,
  selectedAgentId: null,
  linkedCapabilities: {},
  events: [],
  activity: emptyActivity(),
  liveRuns: {},
  runForRequest: {},
  error: null,

  watchRun(runId: string) {
    if (!runId) return () => {};
    subscribeRuns([runId]);
    const existing = get().liveRuns[runId];
    if (!existing) {
      set((s) => ({
        liveRuns: {
          ...s.liveRuns,
          [runId]: {
            events: [],
            activity: emptyRunActivity(runId),
            watchers: 1,
          },
        },
      }));
    } else {
      set((s) => ({
        liveRuns: {
          ...s.liveRuns,
          [runId]: {
            ...existing,
            watchers: existing.watchers + 1,
          },
        },
      }));
    }

    const currentLive = get().liveRuns[runId];
    const since = currentLive?.activity.lastEventId;
    void api.runEvents(runId, since).then(({ events }) => {
      const cur = get().liveRuns[runId];
      if (!cur || cur.watchers <= 0 || !events.length) return;
      const seen = new Set(cur.events.map((e) => e.id).filter((id): id is number => typeof id === 'number'));
      const newEvents = events.filter((e) => typeof e.id !== 'number' || !seen.has(e.id));
      if (!newEvents.length) return;
      let activity = cur.activity;
      for (const ev of newEvents) {
        activity = reduceActivity(activity, ev);
      }
      const merged = [...cur.events, ...newEvents];
      const capped = merged.length > 3000 ? merged.slice(-3000) : merged;
      set((s) => {
        const r = s.liveRuns[runId];
        if (!r) return s;
        return {
          liveRuns: {
            ...s.liveRuns,
            [runId]: { ...r, events: capped, activity },
          },
        };
      });
    }).catch(() => undefined);

    return () => {
      const active = get().liveRuns[runId];
      if (!active) return;
      if (active.watchers <= 1) {
        unsubscribeRuns([runId]);
        set((s) => {
          const { [runId]: _, ...rest } = s.liveRuns;
          return { liveRuns: rest };
        });
      } else {
        set((s) => ({
          liveRuns: {
            ...s.liveRuns,
            [runId]: {
              ...active,
              watchers: active.watchers - 1,
            },
          },
        }));
      }
    };
  },

  selectAgent(agentId) {
    set({ selectedAgentId: agentId, selectedRunId: null, events: [], activity: emptyActivity(), error: null });
  },

  isCapabilityLinked(agentId, capabilityId) {
    return get().agents.find(agent => agent.id === agentId)?.capabilities?.includes(capabilityId) ?? false;
  },

  async refreshRoutines() {
    try {
      const { routines } = await api.routines();
      set({ routines });
    } catch {
      // Ignored if daemon does not expose routines yet
    }
  },

  async refreshState() {
    const { agents, taskRuns } = await api.state();
    set((s) => ({
      agents,
      linkedCapabilities: Object.fromEntries(agents.map(a => [a.id, a.capabilities ?? []])),
      taskRuns: sortRuns(taskRuns),
      selectedAgentId: s.selectedAgentId ?? agents[0]?.id ?? null,
    }));
  },

  start() {
    // HTTP reconciliation gives the UI a useful fleet even when the live socket
    // is reconnecting. The WebSocket remains authoritative for live events.
    void get().refreshState().catch(() => undefined);

    api.layers()
      .then(({ layers }) => set({ layers }))
      .catch((err) => set({ error: `Could not load the layer taxonomy: ${err.message}` }));

    // Load initial routines
    void get().refreshRoutines();

    // MCP status decides whether those bodies are drawn connected. A failure to
    // read it leaves `mcp` empty, which renders the "none configured"
    // placeholder - honest, because we genuinely do not know of any.
    api.mcp()
      .then(({ servers }) => set({ mcp: servers }))
      .catch(() => undefined);

    return connect({
      onState: (connection) => set({ connection }),

      onLive: (frame: RunLiveFrame) => {
        const { runId } = frame;
        if (!runId) return;
        const live = get().liveRuns[runId];
        if (!live || live.watchers <= 0) return;

        if (frame.kind === 'snapshot') {
          const attempts = frame.attempts ?? [];
          const latest = attempts.length > 0 ? attempts[attempts.length - 1] : null;
          const steps = [...live.activity.steps];
          for (const call of frame.calls) {
            const idx = steps.findIndex((s) => s.id === call.callId);
            if (idx !== -1) {
              steps[idx] = { ...steps[idx], output: collapseCarriageReturns(call.tail) };
            }
          }

          set((s) => {
            const cur = s.liveRuns[runId];
            if (!cur) return s;
            return {
              liveRuns: {
                ...s.liveRuns,
                [runId]: {
                  ...cur,
                  activity: { ...cur.activity, steps },
                  attempt: latest ? {
                    attemptId: latest.attemptId,
                    revision: latest.revision,
                    text: latest.text,
                    reasoning: latest.reasoning ?? '',
                  } : cur.attempt,
                },
              },
            };
          });
          return;
        }

        if (frame.kind === 'attempt') {
          if (frame.phase === 'start') {
            set((s) => {
              const cur = s.liveRuns[runId];
              if (!cur) return s;
              return {
                liveRuns: {
                  ...s.liveRuns,
                  [runId]: {
                    ...cur,
                    attempt: {
                      attemptId: frame.attemptId,
                      revision: frame.revision,
                      text: '',
                      reasoning: '',
                      phase: 'start',
                    },
                  },
                },
              };
            });
          } else if (frame.phase === 'end') {
            set((s) => {
              const cur = s.liveRuns[runId];
              if (!cur || !cur.attempt) return s;
              if (cur.attempt.attemptId === frame.attemptId && cur.attempt.revision === frame.revision) {
                return {
                  liveRuns: {
                    ...s.liveRuns,
                    [runId]: {
                      ...cur,
                      attempt: {
                        ...cur.attempt,
                        phase: 'end',
                        outcome: frame.outcome,
                        abandoned: frame.outcome === 'abandoned',
                      },
                    },
                  },
                };
              }
              return s;
            });
          }
          return;
        }

        if (frame.kind === 'chunk') {
          const chunk = frame.chunk;
          if (!chunk) return;
          set((s) => {
            const cur = s.liveRuns[runId];
            if (!cur || !cur.attempt) return s;
            if (cur.attempt.attemptId !== frame.attemptId || cur.attempt.revision !== frame.revision) return s;

            let nextText = cur.attempt.text;
            let nextReasoning = cur.attempt.reasoning;

            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              nextText += chunk.text;
            } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
              nextReasoning += chunk.text;
            } else {
              return s;
            }

            return {
              liveRuns: {
                ...s.liveRuns,
                [runId]: {
                  ...cur,
                  attempt: {
                    ...cur.attempt,
                    text: nextText,
                    reasoning: nextReasoning,
                  },
                },
              },
            };
          });
          return;
        }

        const callId = 'callId' in frame ? frame.callId : undefined;
        const steps = [...live.activity.steps];
        let stepIdx = -1;
        if (callId) {
          stepIdx = steps.findIndex((s) => s.id === callId);
        }
        if (stepIdx === -1) {
          for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].status === 'running') {
              stepIdx = i;
              break;
            }
          }
        }

        if (stepIdx === -1) return;

        const step = { ...steps[stepIdx] };
        let newOutput = step.output ?? '';

        const tail = 'tail' in frame && typeof frame.tail === 'string' ? frame.tail : undefined;
        const chunk = 'chunk' in frame && typeof frame.chunk === 'string' ? frame.chunk : undefined;
        const data = 'data' in frame && typeof (frame as { data?: unknown }).data === 'string' ? (frame as { data: string }).data : undefined;
        const exitCode = 'exitCode' in frame ? (frame as { exitCode?: number | null }).exitCode : undefined;

        if (typeof tail === 'string') {
          newOutput = collapseCarriageReturns(tail);
        } else if (typeof chunk === 'string') {
          newOutput = collapseCarriageReturns(newOutput + chunk);
        } else if (typeof data === 'string') {
          newOutput = collapseCarriageReturns(newOutput + data);
        }

        const MAX_OUTPUT_BYTES = 64 * 1024;
        if (newOutput.length > MAX_OUTPUT_BYTES) {
          newOutput = newOutput.slice(-MAX_OUTPUT_BYTES);
        }
        step.output = newOutput;

        if (exitCode !== undefined && exitCode !== null) {
          step.exitCode = exitCode;
        }

        steps[stepIdx] = step;

        set((s) => {
          const cur = s.liveRuns[runId];
          if (!cur) return s;
          return {
            liveRuns: {
              ...s.liveRuns,
              [runId]: {
                ...cur,
                activity: {
                  ...cur.activity,
                  steps,
                },
              },
            },
          };
        });
      },

      onHello: ({ agents, taskRuns, executor, routines }) => {
        set((s) => ({
          agents,
          linkedCapabilities: Object.fromEntries(agents.map(a => [a.id, a.capabilities ?? []])),
          taskRuns: sortRuns(taskRuns),
          executor: executor ?? null,
          routines: routines ?? s.routines,
          selectedAgentId: s.selectedAgentId ?? agents[0]?.id ?? null,
        }));
        void api.mcp().then(({ servers }) => set({ mcp: servers })).catch(() => set({ mcp: [] }));
        // Auto-select whatever is running, so opening the page mid-run shows the
        // brain thinking rather than an empty panel.
        if (!get().selectedRunId) {
          const running = taskRuns.find((r) => r.status === 'RUNNING' && r.agent_id === get().selectedAgentId);
          if (running) void get().selectRun(running.id);
        }

        // Backfill active watched runs on reconnect
        const activeWatched = get().liveRuns;
        for (const [rid, live] of Object.entries(activeWatched)) {
          if (live.watchers > 0) {
            const since = live.activity.lastEventId;
            void api.runEvents(rid, since).then(({ events }) => {
              const cur = get().liveRuns[rid];
              if (!cur || cur.watchers <= 0 || !events.length) return;
              const seen = new Set(cur.events.map((e) => e.id).filter((id): id is number => typeof id === 'number'));
              const newEvents = events.filter((e) => typeof e.id !== 'number' || !seen.has(e.id));
              if (!newEvents.length) return;
              let activity = cur.activity;
              for (const ev of newEvents) {
                activity = reduceActivity(activity, ev);
              }
              const merged = [...cur.events, ...newEvents];
              const capped = merged.length > 3000 ? merged.slice(-3000) : merged;
              set((s) => {
                const r = s.liveRuns[rid];
                if (!r) return s;
                return {
                  liveRuns: {
                    ...s.liveRuns,
                    [rid]: { ...r, events: capped, activity },
                  },
                };
              });
            }).catch(() => undefined);
          }
        }
      },

      onEvent: (event) => {
        const state = get();

        // A lifecycle event changes a run's status, so refresh the list. This is
        // a read of the daemon's truth, not a local guess at the new status.
        if (event.event_type.startsWith('TASK_') || event.event_type.startsWith('ROUTINE_')) {
          api.state()
            .then(({ agents, taskRuns }) =>
              set((s) => ({
                agents,
                taskRuns: sortRuns(taskRuns),
                selectedAgentId: s.selectedAgentId ?? agents[0]?.id ?? null,
              }))
            )
            .catch(() => undefined);
          if (event.event_type.startsWith('ROUTINE_')) {
            void get().refreshRoutines();
          }
        }

        // A post was sent, proven or held back, or the owner checked an unconfirmed
        // one: a routine's held state and its run badges may have changed.
        if (event.event_type.startsWith('PUBLISH_') || event.event_type === 'EXTERNAL_ACTION_ACKNOWLEDGED') {
          void get().refreshRoutines();
        }

        if (event.event_type === 'TASK_STARTED') {
          const raw = (event as { payload_json?: unknown; payload?: unknown }).payload_json ?? (event as { payload?: unknown }).payload;
          try {
            const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (payload && payload.threadId && payload.requestId && event.task_run_id) {
              const key = `${payload.threadId}:${payload.requestId}`;
              set((s) => ({ runForRequest: { ...s.runForRequest, [key]: event.task_run_id } }));
            }
          } catch {
            /* ignore malformed payload */
          }
        }

        if (event.event_type === 'CHAT_REPLY') {
          const raw = (event as { payload_json?: unknown; payload?: unknown }).payload_json ?? (event as { payload?: unknown }).payload;
          try {
            const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (payload && typeof payload.threadId === 'string') {
              const agentId = (payload.agentId as string | undefined) ?? (event.agent_id as string | undefined) ?? null;
              set({ chatActivity: { threadId: payload.threadId, agentId, source: String(payload.source ?? 'chat'), at: Date.now() } });
            }
          } catch {
            /* A malformed payload names no conversation to refresh. */
          }
        }

        // Live activity for watched runs (processed before Cortex selectedRunId filter)
        if (event.task_run_id && state.liveRuns[event.task_run_id]) {
          const live = state.liveRuns[event.task_run_id];
          if (live.watchers > 0) {
            const isDuplicate = typeof event.id === 'number' && live.events.some((e) => e.id === event.id);
            if (!isDuplicate) {
              const activity = reduceActivity(live.activity, event);
              const events = [...live.events, event];
              const capped = events.length > 3000 ? events.slice(-3000) : events;
              const clearAttempt = event.event_type === 'TASK_RUN_ENDED' || (event.event_type === 'CHAT_REPLY' && live.attempt?.phase === 'end');
              set((s) => ({
                liveRuns: {
                  ...s.liveRuns,
                  [event.task_run_id]: {
                    ...live,
                    events: capped,
                    activity,
                    attempt: clearAttempt ? null : live.attempt,
                  },
                },
              }));
            }
          }
        }

        if (event.task_run_id !== state.selectedRunId) return;
        const events = [...state.events, event];
        set({ events, activity: activityFromEvents(events) });
      },
    });
  },

  async selectRun(runId) {
    const prev = get().selectedRunId;
    if (prev && prev !== runId && (!get().liveRuns[prev] || get().liveRuns[prev].watchers <= 0)) {
      unsubscribeRuns([prev]);
    }
    if (runId === null) {
      set({ selectedRunId: null, events: [], activity: emptyActivity(), error: null });
      return;
    }
    subscribeRuns([runId]);
    const run = get().taskRuns.find((r) => r.id === runId);
    set({
      selectedRunId: runId,
      selectedAgentId: run ? run.agent_id : get().selectedAgentId,
      events: [],
      activity: emptyActivity(),
      error: null,
    });
    try {
      const { events } = await api.runEvents(runId);
      // Guard against a slow response for a run the operator has since left.
      if (get().selectedRunId !== runId) return;
      set({ events, activity: activityFromEvents(events) });
    } catch (err: any) {
      if (get().selectedRunId === runId) set({ error: `Could not load events for ${runId}: ${err.message}` });
    }
  },
}));
