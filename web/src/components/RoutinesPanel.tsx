/**
 * Scheduled routines panel.
 *
 * Provides full control over background cron routines:
 *   - Live list with status, next run countdown, last run outcome
 *   - "Run now" manual trigger
 *   - Pause / resume switch
 *   - Delete
 *   - Creation form with natural-language and cron schedule validation
 *   - Historical runs inspection linked back to the Galaxy viewer
 */

import { useState, type CSSProperties, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from './ui/icons.js';
import { api, sendCommand, type RoutineRow, type TaskRunRow } from '../lib/transport.js';
import { useCortex } from '../store.js';
import { CortexEmpty, CortexPanel, Field, StatusPill, Switch, collapseMotion, statusTone } from './CortexKit.js';

function formatCountdown(nextRunAt: number): string {
  const diff = nextRunAt - Date.now();
  if (diff <= 0) return 'due now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export function RoutinesPanel({ onClose }: { onClose: () => void }) {
  const agents = useCortex((s) => s.agents);
  const routines = useCortex((s) => s.routines);
  const refreshRoutines = useCortex((s) => s.refreshRoutines);
  const selectRun = useCortex((s) => s.selectRun);

  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const [routineRuns, setRoutineRuns] = useState<TaskRunRow[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Form fields
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('every day at 9 am');
  const [timezone, setTimezone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  });
  const [promptTemplate, setPromptTemplate] = useState('');
  const [taskName, setTaskName] = useState('');
  const [catchUpPolicy, setCatchUpPolicy] = useState<'skip' | 'run_once'>('skip');

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const activeCount = routines.filter((r) => r.enabled === 1).length;

  const handleRunNow = async (routine: RoutineRow) => {
    setBusyAction(`run-${routine.id}`);
    setError(null);
    try {
      const res = await sendCommand('run_routine_now', routine.id);
      if (res && res.success === false) throw new Error(res.error ?? 'The daemon refused the run.');
      if (res?.data?.taskRunId) {
        void selectRun(res.data.taskRunId);
      }
      await refreshRoutines();
    } catch (err: any) {
      setError(`Failed to trigger routine "${routine.name}": ${err.message}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleEnabled = async (routine: RoutineRow) => {
    setBusyAction(`toggle-${routine.id}`);
    setError(null);
    try {
      await sendCommand('update_routine', routine.id, { enabled: routine.enabled ? 0 : 1 });
      await refreshRoutines();
    } catch (err: any) {
      setError(`Failed to update routine "${routine.name}": ${err.message}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleDelete = async (routine: RoutineRow) => {
    if (!confirm(`Delete routine "${routine.name}"?`)) return;
    setBusyAction(`delete-${routine.id}`);
    setError(null);
    try {
      await sendCommand('delete_routine', routine.id);
      if (selectedRoutineId === routine.id) {
        setSelectedRoutineId(null);
        setRoutineRuns([]);
      }
      await refreshRoutines();
    } catch (err: any) {
      setError(`Failed to delete routine "${routine.name}": ${err.message}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleShowRuns = async (routine: RoutineRow) => {
    if (selectedRoutineId === routine.id) {
      setSelectedRoutineId(null);
      setRoutineRuns([]);
      return;
    }
    setSelectedRoutineId(routine.id);
    setLoadingRuns(true);
    try {
      const res = await api.routineRuns(routine.id);
      setRoutineRuns(res.runs);
    } catch (err: any) {
      setError(`Could not load runs for "${routine.name}": ${err.message}`);
    } finally {
      setLoadingRuns(false);
    }
  };

  const handleCreateRoutine = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !schedule.trim() || !promptTemplate.trim()) {
      setError('Name, schedule, and instructions are required.');
      return;
    }
    const targetAgent = agentId || agents[0]?.id;
    if (!targetAgent) {
      setError('No bot selected.');
      return;
    }

    setBusyAction('create');
    setError(null);
    try {
      // The daemon's create_routine handler reads `agentId` and `prompt` from
      // the payload. This previously sent `promptTemplate` and no `agentId`, so
      // every creation was rejected with "agentId, name, schedule, and prompt
      // are required" - the command never worked from this panel.
      const result = await sendCommand('create_routine', targetAgent, {
        agentId: targetAgent,
        name: name.trim(),
        schedule: schedule.trim(),
        timezone: timezone.trim() || 'UTC',
        prompt: promptTemplate.trim(),
        taskName: taskName.trim() || undefined,
        catchUpPolicy,
      });
      if (result && result.success === false) {
        throw new Error(result.error ?? 'The daemon refused the routine.');
      }
      setName('');
      setPromptTemplate('');
      setTaskName('');
      setShowAddForm(false);
      await refreshRoutines();
    } catch (err: any) {
      setError(`Creation failed: ${err.message}`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <CortexPanel
      icon="schedule"
      title="Routines"
      subtitle={`${routines.length} scheduled · ${activeCount} active`}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className={`cx-icon-btn ${showAddForm ? 'is-on' : ''}`}
            aria-pressed={showAddForm}
            aria-label="New routine"
            title="New routine"
            onClick={() => setShowAddForm((v) => !v)}
          >
            <Icon name="add" />
          </button>
          <button
            type="button"
            className="cx-icon-btn"
            aria-label="Refresh routines"
            title="Refresh"
            onClick={() => void refreshRoutines()}
          >
            <Icon name="refresh" />
          </button>
        </>
      }
    >
      {error && (
        <div className="cx-alert" role="alert">
          <Icon name="error" size={14} motion={false} />
          <span>{error}</span>
        </div>
      )}

      <div className="cx-panel-body cx-stack">
        <AnimatePresence initial={false}>
          {showAddForm && (
            <motion.div key="form" className="cx-collapse" {...collapseMotion}>
              <form className="cx-form" onSubmit={handleCreateRoutine}>
                <div className="cx-form-title">
                  <Icon name="schedule" size={14} motion={false} />
                  New routine
                </div>
                <Field label="Bot">
                  <select className="cx-select" value={agentId || agents[0]?.id || ''} onChange={(e) => setAgentId(e.target.value)}>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name || a.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="If a run is missed">
                  <select
                    className="cx-select"
                    value={catchUpPolicy}
                    onChange={(e) => setCatchUpPolicy(e.target.value as 'skip' | 'run_once')}
                  >
                    <option value="skip">Skip it</option>
                    <option value="run_once">Run once to catch up</option>
                  </select>
                </Field>
                <Field label="Name" wide>
                  <input
                    type="text"
                    className="cx-input"
                    placeholder="Daily standup sweep"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Schedule (English or cron)">
                  <input
                    type="text"
                    className="cx-input"
                    placeholder="every day at 9 am"
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Timezone (IANA)">
                  <input
                    type="text"
                    className="cx-input"
                    placeholder="Europe/London"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  />
                </Field>
                <Field label="Task (required: a prompt alone cannot run)" wide>
                  <input
                    type="text"
                    className="cx-input"
                    placeholder="work:evidence-brief"
                    value={taskName}
                    required
                    onChange={(e) => setTaskName(e.target.value)}
                  />
                </Field>
                <Field label="Instructions" wide>
                  <textarea
                    className="cx-textarea"
                    rows={3}
                    placeholder="What to do when the routine fires…"
                    value={promptTemplate}
                    onChange={(e) => setPromptTemplate(e.target.value)}
                    required
                  />
                </Field>
                <div className="cx-form-actions">
                  <button type="button" className="cx-btn ghost" onClick={() => setShowAddForm(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="cx-btn primary" disabled={busyAction === 'create'}>
                    {busyAction === 'create' ? 'Creating…' : 'Create routine'}
                  </button>
                </div>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        {routines.length === 0 ? (
          <CortexEmpty
            icon="schedule"
            title="No routines yet"
            action={
              !showAddForm && (
                <button type="button" className="cx-btn primary" onClick={() => setShowAddForm(true)}>
                  <Icon name="add" size={14} />
                  New routine
                </button>
              )
            }
          >
            A routine runs a task for one of your bots on a schedule.
          </CortexEmpty>
        ) : (
          routines.map((r, index) => {
            const isEnabled = r.enabled === 1;
            const isSelected = selectedRoutineId === r.id;
            return (
              <article
                key={r.id}
                className={`cx-card cx-routine ${isEnabled ? '' : 'is-paused'}`}
                style={{ '--i': Math.min(index, 12) } as CSSProperties}
              >
                <header className="cx-routine-head">
                  <div className="cx-routine-title">
                    <strong>{r.name}</strong>
                    <small>
                      {agentName(r.agent_id)}
                      {r.task_name && (
                        <>
                          {' · '}
                          <code>{r.task_name}</code>
                        </>
                      )}
                    </small>
                  </div>
                  <Switch
                    checked={isEnabled}
                    disabled={busyAction === `toggle-${r.id}`}
                    label={isEnabled ? `Pause ${r.name}` : `Resume ${r.name}`}
                    onChange={() => void handleToggleEnabled(r)}
                  />
                </header>

                <div className="cx-schedule">
                  <Icon name="schedule" size={14} motion={false} />
                  <span>{r.schedule_enabled === 0 ? (r.webhook_token ? 'Webhook only' : 'Manual only') : r.human_schedule || r.cron_expression}</span>
                  <span className="cx-schedule-tz">{r.timezone}</span>
                </div>

                <div className="cx-meta-row">
                  <span className="cx-chip">
                    <Icon name="run" size={12} motion={false} />
                    {isEnabled ? (r.schedule_enabled === 0 ? 'No timetable' : `Next ${formatCountdown(r.next_run_at)}`) : 'Paused'}
                  </span>
                  <span>Last run</span>
                  {r.last_run_status ? <StatusPill status={r.last_run_status} /> : <span className="cx-chip">Never</span>}
                </div>

                <footer className="cx-actions-row">
                  <button
                    type="button"
                    className="cx-btn ghost"
                    aria-expanded={isSelected}
                    onClick={() => void handleShowRuns(r)}
                  >
                    <Icon name="chevronDown" size={13} className="cx-expand-chevron" motion={false} />
                    {isSelected ? 'Hide runs' : 'Run history'}
                  </button>
                  <div className="cx-btn-row">
                    <button
                      type="button"
                      className="cx-btn primary"
                      disabled={busyAction === `run-${r.id}`}
                      title="Trigger a run immediately"
                      onClick={() => void handleRunNow(r)}
                    >
                      <Icon name="run" size={14} />
                      {busyAction === `run-${r.id}` ? 'Starting…' : 'Run now'}
                    </button>
                    <button
                      type="button"
                      className="cx-icon-btn danger"
                      disabled={busyAction === `delete-${r.id}`}
                      aria-label={`Delete ${r.name}`}
                      title="Delete routine"
                      onClick={() => void handleDelete(r)}
                    >
                      <Icon name="remove" />
                    </button>
                  </div>
                </footer>

                <AnimatePresence initial={false}>
                  {isSelected && (
                    <motion.div key="history" className="cx-collapse" {...collapseMotion}>
                      <div className="cx-history">
                        <h4 className="cx-section-label">Run history</h4>
                        {loadingRuns ? (
                          <div className="cx-loading">
                            <span className="cx-spinner" aria-hidden="true" />
                            Loading history…
                          </div>
                        ) : routineRuns.length === 0 ? (
                          <p className="cx-muted">No recorded runs for this routine yet.</p>
                        ) : (
                          routineRuns.map((run) => (
                            <button
                              key={run.id}
                              type="button"
                              className="cx-run is-compact"
                              data-tone={statusTone(run.status)}
                              title={`Inspect run ${run.id} in the galaxy`}
                              onClick={() => void selectRun(run.id)}
                            >
                              <span className="cx-run-dot" aria-hidden="true" />
                              <span className="cx-run-text">
                                <strong>{run.task_name || run.id}</strong>
                                <small>${run.actual_cost_usd.toFixed(4)}</small>
                              </span>
                              <StatusPill status={run.status} />
                            </button>
                          ))
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </article>
            );
          })
        )}
      </div>
    </CortexPanel>
  );
}
