/**
 * The fleet: every bot, and every run.
 *
 * Previously each bot was a card with its own "pause / resume / face view" row
 * of text buttons, so six bots meant eighteen identical buttons and the runs
 * list started below the fold. Now a bot is one line; choosing it opens its
 * controls - the face preview, its traits, pause and resume - in place, for
 * that bot only. Runs can be filtered, and a running one carries its own stop
 * control.
 *
 * Commands still go through the daemon's WS commands, and a refused command is
 * shown in the panel, never swallowed: a pause that failed must not look like
 * one that worked.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { runLabel } from '../lib/runLabels.js';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { useCortex } from '../store.js';
import { sendCommand, type TaskRunRow } from '../lib/transport.js';
import { getAgentBotPersonality } from '../lib/aora-bot/index.js';
import type { BotProfile } from '../lib/botProfile.js';
import { Icon } from './ui/icons.js';
import {
  CortexEmpty,
  CortexFace,
  CortexPanel,
  Segmented,
  StatusPill,
  botColor,
  collapseMotion,
  statusTone,
  timeAgo,
} from './CortexKit.js';

const EMOTION_PREVIEWS = [
  { id: '02', label: 'Idle' },
  { id: '30', label: 'Thinking' },
  { id: '33', label: 'Done' },
  { id: '34', label: 'Alert' },
  { id: '00', label: 'Asleep' },
];

type RunFilter = 'all' | 'active' | 'done' | 'failed';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
] as const;

function inFilter(run: TaskRunRow, filter: RunFilter): boolean {
  if (filter === 'active') return run.status === 'RUNNING' || run.status === 'QUEUED';
  if (filter === 'done') return run.status === 'COMPLETED';
  if (filter === 'failed') return run.status === 'FAILED' || run.status === 'CRASHED' || run.status === 'ABORTED';
  return true;
}

export function FleetSidebar({
  profiles,
  onPick,
  onClose,
}: {
  profiles: Record<string, BotProfile>;
  onPick?: () => void;
  onClose: () => void;
}) {
  const { agents, taskRuns, selectedRunId, selectRun, connection, selectedAgentId, selectAgent } = useCortex();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewEmotions, setPreviewEmotions] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<RunFilter>('all');

  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const runs = useMemo(() => taskRuns.filter((run) => inFilter(run, filter)).slice(0, 40), [taskRuns, filter]);
  const running = taskRuns.filter((run) => run.status === 'RUNNING').length;

  const act = async (command: 'pause' | 'resume' | 'kill', id: string, what: string) => {
    setBusy(id);
    setError(null);
    try {
      const result = await sendCommand(command, id);
      if (result && result.success === false) throw new Error(result.error ?? 'The daemon refused the command.');
    } catch (cause) {
      setError(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <CortexPanel
      side="left"
      icon="group"
      title="Fleet"
      subtitle={`${agents.length} bot${agents.length === 1 ? '' : 's'} · ${running} running`}
      onClose={onClose}
    >
      <div className="cx-panel-toolbar">
        <span className="cx-conn" data-tone={connection === 'open' ? 'ok' : connection === 'connecting' ? 'warn' : 'danger'}>
          <i aria-hidden="true" />
          {connection === 'open' ? 'Daemon connected' : connection === 'connecting' ? 'Connecting to the daemon' : 'Daemon offline'}
        </span>
      </div>

      {error && (
        <div className="cx-alert" role="alert">
          <Icon name="error" size={14} motion={false} />
          <span>{error}</span>
        </div>
      )}

      <div className="cx-panel-body">
        <section className="cx-section">
          <h3 className="cx-section-label">Bots</h3>
          {agents.length === 0 ? (
            <CortexEmpty icon="bot" title="No bots">
              Add one to openhours.config.json, or create one in the workspace.
            </CortexEmpty>
          ) : (
            <LayoutGroup id="cx-fleet">
              <ul className="cx-bot-list">
                {agents.map((agent, index) => {
                  const selected = agent.id === selectedAgentId;
                  const profile = profiles[agent.id];
                  const color = botColor(agent, profile);
                  const emotion = previewEmotions[agent.id];
                  return (
                    <li
                      key={agent.id}
                      className={`cx-bot ${selected ? 'is-selected' : ''}`}
                      style={{ '--row-color': color, '--i': index } as CSSProperties}
                    >
                      <button type="button" className="cx-bot-main" aria-pressed={selected} onClick={() => selectAgent(agent.id)}>
                        {selected && (
                          <motion.span
                            layoutId="cx-fleet-highlight"
                            className="cx-bot-highlight"
                            transition={{ type: 'spring', stiffness: 480, damping: 40 }}
                          />
                        )}
                        <span className="cx-bot-face">
                          <CortexFace agent={agent} profile={profile} emotion={emotion} size={36} idle={selected} />
                        </span>
                        <span className="cx-bot-text">
                          <strong>{agent.name}</strong>
                          <small>{agent.model_id}</small>
                        </span>
                        <StatusPill status={agent.current_status} />
                      </button>

                      <AnimatePresence initial={false}>
                        {selected && (
                          <motion.div key="controls" className="cx-collapse" {...collapseMotion}>
                            <div className="cx-bot-expand">
                              <div className="cx-bot-hero">
                                <CortexFace agent={agent} profile={profile} emotion={emotion} size={72} interactive />
                                <div className="cx-traits">
                                  <span className="cx-chip">{profile?.shape ?? getAgentBotPersonality(agent).shape}</span>
                                  <span className="cx-chip">
                                    <i className="cx-swatch" style={{ background: color }} aria-hidden="true" />
                                    {color}
                                  </span>
                                  <span className="cx-chip">Budget ${agent.budget_cap_usd}</span>
                                </div>
                              </div>
                              <div className="cx-chip-row" role="group" aria-label={`Preview ${agent.name}'s expressions`}>
                                {EMOTION_PREVIEWS.map((preview) => (
                                  <button
                                    key={preview.id}
                                    type="button"
                                    className="cx-chip"
                                    aria-pressed={emotion === preview.id}
                                    onClick={() => setPreviewEmotions((current) => ({ ...current, [agent.id]: preview.id }))}
                                  >
                                    {preview.label}
                                  </button>
                                ))}
                                {emotion && (
                                  <button
                                    type="button"
                                    className="cx-chip is-quiet"
                                    onClick={() =>
                                      setPreviewEmotions((current) => {
                                        const next = { ...current };
                                        delete next[agent.id];
                                        return next;
                                      })
                                    }
                                  >
                                    Reset
                                  </button>
                                )}
                              </div>
                              <div className="cx-btn-row">
                                <button
                                  type="button"
                                  className="cx-btn"
                                  disabled={busy === agent.id}
                                  onClick={() => void act('pause', agent.id, `Pausing ${agent.name}`)}
                                >
                                  <Icon name="pause" size={14} />
                                  Pause
                                </button>
                                <button
                                  type="button"
                                  className="cx-btn"
                                  disabled={busy === agent.id}
                                  onClick={() => void act('resume', agent.id, `Resuming ${agent.name}`)}
                                >
                                  <Icon name="run" size={14} />
                                  Resume
                                </button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </li>
                  );
                })}
              </ul>
            </LayoutGroup>
          )}
        </section>

        <section className="cx-section">
          <div className="cx-section-head">
            <h3 className="cx-section-label">Runs</h3>
            <Segmented id="run-filter" label="Filter runs" value={filter} options={FILTERS} onChange={setFilter} />
          </div>
          {runs.length === 0 ? (
            <CortexEmpty icon="run" title={taskRuns.length === 0 ? 'Nothing has run yet' : 'No runs match'}>
              {taskRuns.length === 0 ? 'Runs appear here as your bots work.' : 'Try another filter.'}
            </CortexEmpty>
          ) : (
            <ul className="cx-run-list">
              {runs.map((run, index) => {
                const on = run.id === selectedRunId;
                const isRunning = run.status === 'RUNNING';
                return (
                  <li
                    key={run.id}
                    className={`cx-run-item ${isRunning ? 'has-kill' : ''}`}
                    style={{ '--i': Math.min(index, 16) } as CSSProperties}
                  >
                    <button
                      type="button"
                      className={`cx-run ${on ? 'is-on' : ''}`}
                      data-tone={statusTone(run.status)}
                      aria-pressed={on}
                      onClick={() => {
                        void selectRun(run.id);
                        onPick?.();
                      }}
                    >
                      <span className="cx-run-dot" aria-hidden="true" />
                      <span className="cx-run-text">
                        <strong title={run.task_name}>{runLabel(run.task_name)}</strong>
                        <small>
                          {names.get(run.agent_id) ?? run.agent_id} · {timeAgo(run.started_at)}
                        </small>
                      </span>
                      <StatusPill status={run.status} />
                    </button>
                    {isRunning && (
                      <button
                        type="button"
                        className="cx-icon-btn danger cx-run-kill"
                        disabled={busy === run.id}
                        aria-label={`Kill ${runLabel(run.task_name)}`}
                        title="Kill run"
                        onClick={() => void act('kill', run.id, `Stopping ${runLabel(run.task_name)}`)}
                      >
                        <Icon name="stop" size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </CortexPanel>
  );
}
