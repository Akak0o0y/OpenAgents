import { MessageBody } from './MessageBody.js';
import { RoutineFlow } from './RoutineFlow.js';
import {ExpectedResults} from './ExpectedResults.js';
import {GoalResultChecklist} from './GoalResultChecklist.js';
import { UI_LOCALE } from '../lib/numbers.js';
/**
 * The routine editor, in the right-hand panel.
 *
 * Everything on this screen is connected to the daemon's routine engine:
 * saving creates or updates a row, Active toggles `enabled`, Test run enqueues
 * a real task, Delete removes the row, and Run history is read back from
 * `/api/routines/:id/runs` rather than remembered locally.
 *
 * The two honest edges:
 *
 *  - EVENT TRIGGERS (Slack, Git, Teams, Linear, Sentry, PagerDuty, Webhook)
 *    are offered because the reference offers them, and are disabled with a
 *    reason because nothing in this daemon receives those events. They cannot
 *    be added to a routine at all, rather than being added and silently ignored.
 *  - MULTIPLE TRIGGERS are supported as far as one cron expression can express
 *    them (see lib/routineSchedule.ts). When two triggers cannot be folded into
 *    one schedule the editor refuses to save and says why.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { MenuItem, MenuSeparator, Popover } from './ui/Overlay.js';
import { Icon } from './ui/icons.js';
import { daemonOrigin, isLoopback } from '../lib/daemonOrigin.js';
import {
  EVENT_TRIGGER_TYPES,
  FREQUENCY_LABELS,
  MONTH_LABELS,
  TIME_OPTIONS,
  WEEKDAY_LABELS,
  combineTriggers,
  describeTrigger,
  formatTime,
  WEBHOOK_ONLY_CRON,
  isWorkingEventTrigger,
  newEventTrigger,
  newScheduleTrigger,
  triggerToCron,
  type RoutineTrigger,
  type ScheduleFrequency,
  type ScheduleTrigger,
} from '../lib/routineSchedule.js';
import { api, type PendingEffectRow, type PublishPolicyRow, type RoutineRow, type TaskRunRow } from '../lib/transport.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/Select.js';
import { Switch } from '@/registry/default/ui/switch.js';
import { Spinner } from '@/registry/default/ui/spinner.js';
import { FormError } from './ui/FormError.js';
import { Button, IconButton } from './ui/Button.js';
import { Input } from '@/registry/default/ui/input.js';
import { Textarea } from '@/registry/default/ui/textarea.js';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/registry/default/ui/empty.js';

export interface RoutineDraft {
  id: string | null;
  /** True when the routine should have a live webhook URL. */
  webhookEnabled: boolean;
  scheduleEnabled: boolean;
  name: string;
  instruction: string;
  taskName?: string;
  triggers: RoutineTrigger[];
  enabled: boolean;
  timezone: string;
}

interface GrokRoutineEditorProps {
  agentId: string;
  routine: RoutineRow | null;
  onBack: () => void;
  onClose: () => void;
  onSave: (draft: RoutineDraft, cron: string) => Promise<void>;
  onDelete: (routineId: string) => Promise<void>;
  onTestRun: (routineId: string) => Promise<void>;
  onSetEnabled: (routineId: string, enabled: boolean) => Promise<void>;
  /** Issue, rotate or revoke the routine's webhook token. */
  onSetWebhook: (routineId: string, enabled: boolean, rotate?: boolean) => Promise<void>;
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Rebuild editable triggers from a stored cron expression and webhook token. */
export function triggersFromRoutine(routine: RoutineRow | null): RoutineTrigger[] {
  if (!routine) return [];
  // A token means a live webhook URL, so the trigger row has to come back or
  // the operator would see no sign of a URL that still fires this routine.
  const webhook: RoutineTrigger[] = routine.webhook_token ? [newEventTrigger('webhook')] : [];
  if (routine.schedule_enabled === 0 || (routine.schedule_enabled === undefined && routine.cron_expression.trim() === WEBHOOK_ONLY_CRON)) return webhook;
  // An interval is not a cron expression and has no five fields. Without this it came
  // back as a "custom" cron trigger holding "@every 40m", which the editor then refused
  // as invalid cron - a routine that saved correctly could not be reopened.
  const interval = /^@every\s+(\d{1,5})\s*(m|min|minutes?|h|hours?|d|days?)$/i.exec(routine.cron_expression.trim());
  if (interval) {
    const unit = interval[2].toLowerCase()[0];
    const minutes = Number(interval[1]) * (unit === 'h' ? 60 : unit === 'd' ? 1440 : 1);
    return [...webhook, { ...newScheduleTrigger('interval'), intervalMinutes: minutes }];
  }
  const fields = routine.cron_expression.trim().split(/\s+/);
  if (fields.length !== 5) return [...webhook, { ...newScheduleTrigger('custom'), cron: routine.cron_expression }];
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const simpleList = (value: string) =>
    /^\d+(,\d+)*$/.test(value) ? value.split(',').map(Number) : null;
  const minutes = simpleList(minute);
  const hours = simpleList(hour);

  if (minutes && hours && dayOfMonth === '*' && month === '*') {
    const times: number[] = [];
    for (const h of hours) for (const m of minutes) times.push(h * 60 + m);
    if (dayOfWeek === '*') {
      return [...webhook, { ...newScheduleTrigger('daily'), times }];
    }
    if (dayOfWeek === '1-5') {
      return [...webhook, { ...newScheduleTrigger('weekdays'), times }];
    }
    const weekday = Number(dayOfWeek);
    if (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
      return [...webhook, { ...newScheduleTrigger('weekly'), times, weekday }];
    }
  }
  if (minutes && hours && dayOfWeek === '*' && month === '*' && /^\d+$/.test(dayOfMonth)) {
    const times: number[] = [];
    for (const h of hours) for (const m of minutes) times.push(h * 60 + m);
    return [...webhook, { ...newScheduleTrigger('monthly'), times, dayOfMonth: Number(dayOfMonth) }];
  }
  if (minutes && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return [...webhook, { ...newScheduleTrigger('hourly'), times: minutes }];
  }
  // Anything else round-trips as a custom expression rather than being
  // approximated into a preset that would silently change the schedule.
  return [...webhook, { ...newScheduleTrigger('custom'), cron: routine.cron_expression }];
}

export function GrokRoutineEditor({
  agentId,
  routine,
  onBack,
  onClose,
  onSave,
  onDelete,
  onTestRun,
  onSetEnabled,
  onSetWebhook,
}: GrokRoutineEditorProps) {
  const [name, setName] = useState(routine?.name ?? '');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [runReport, setRunReport] = useState('');
  /** The run whose result was asked for last, so a slow reply cannot overwrite a newer choice. */
  const resultRequest = useRef<string | null>(null);
  const [instruction, setInstruction] = useState(routine?.prompt_template ?? '');
  const [triggers, setTriggers] = useState<RoutineTrigger[]>(() => triggersFromRoutine(routine));
  const [webhookCopied, setWebhookCopied] = useState(false);
  // Resolved rather than assumed: see lib/daemonOrigin.ts. `undefined` means
  // "still asking", `null` means "could not be established" - and those are
  // different things to show.
  const [origin, setOrigin] = useState<string | null | undefined>(undefined);
  const [enabled, setEnabled] = useState(routine ? routine.enabled === 1 : true);
  const [timezone, setTimezone] = useState(() => routine?.timezone ?? localTimezone());
  const [addOpen, setAddOpen] = useState(false);
  const [scheduleSubmenu, setScheduleSubmenu] = useState(false);
  const [busy, setBusy] = useState<'save' | 'delete' | 'test' | 'toggle' | null>(null);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<TaskRunRow[] | null>(null);
  const [runsError, setRunsError] = useState('');
  const [runsLoading, setRunsLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Posting facts (spec 10.1) are read from GET /api/system, never inferred in the browser.
  const [posting, setPosting] = useState<PostingState>(POSTING_LOADING);
  const [postingVersion, setPostingVersion] = useState(0);
  const [postingBusy, setPostingBusy] = useState<'policy' | 'acknowledge' | null>(null);
  const [postingError, setPostingError] = useState('');
  const [confirmContinue, setConfirmContinue] = useState(false);
  // Turning must-post on makes every run fail unless it posts, so it asks first; turning it off does not.
  const [confirmMustPost, setConfirmMustPost] = useState(false);
  const selectedStatus = runs?.find(run => run.id === selectedRun)?.status;
  const selectedError = runs?.find(run => run.id === selectedRun)?.error_message;
  useEffect(() => {
    let alive = true;
    if (!selectedRun) return;
    if (selectedStatus === 'QUEUED' || selectedStatus === 'RUNNING') {
      setRunReport(`Task ${selectedStatus.toLowerCase()}. A result will appear when it finishes.`);
      return;
    }
    setRunReport('Loading result…');
    api.workResult(selectedRun).then(r => { if (alive) setRunReport(r.result.report); })
      .catch(e => { if (alive) setRunReport(selectedError ?? e.message); });
    return () => { alive = false; };
  }, [selectedRun, selectedStatus, selectedError]);


  useEffect(() => {
    let cancelled = false;
    void daemonOrigin().then((value) => {
      if (!cancelled) setOrigin(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const webhookUrl =
    origin && routine?.webhook_token
      ? `${origin}/api/webhooks/routines/${routine.webhook_token}`
      : null;
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setName(routine?.name ?? '');
    setTimezone(routine?.timezone ?? localTimezone());
    setSelectedRun(null);
    setInstruction(routine?.prompt_template ?? '');
    setTriggers(triggersFromRoutine(routine));
    setWebhookCopied(false);
    setEnabled(routine ? routine.enabled === 1 : true);
    setError('');
    setConfirmDelete(false);
    setPosting(POSTING_LOADING);
    setPostingError('');
    setConfirmContinue(false);
    setConfirmMustPost(false);
  }, [routine?.id]);

  // Run history is read from the daemon, never accumulated in the browser.
  useEffect(() => {
    if (!routine) {
      setRuns([]);
      setRunsError('');
      return;
    }
    let cancelled = false;
    const routineId = routine.id;
    setRunsLoading(true);
    setRunsError('');
    const refresh = () => api
      .routineRuns(routineId)
      .then((result) => {
        if (cancelled) return;
        setRuns(result.runs);
      })
      .catch((cause) => {
        if (cancelled) return;
        setRuns(null);
        setRunsError(cause instanceof Error ? cause.message : 'Run history could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setRunsLoading(false);
      });
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      clearInterval(timer);
      cancelled = true;
    };
  }, [routine?.id, routine?.last_run_at]);

  // The must-post policy and unconfirmed posts, re-read on the run history's 3 s cadence
  // and after each posting action (postingVersion).
  useEffect(() => {
    if (!routine) return;
    let cancelled = false;
    const load = () => api
      .botSystem(agentId)
      .then((system) => {
        if (!cancelled) setPosting({ status: 'ready', pendingEffects: system.pendingEffects ?? [], publishPolicies: system.publishPolicies ?? [] });
      })
      .catch((cause) => {
        if (!cancelled) setPosting((current) => ({ ...current, status: 'error', error: cause instanceof Error ? cause.message : 'Posting checks could not be loaded.' }));
      });
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentId, routine?.id, routine?.last_run_at, postingVersion]);

  const combined = useMemo(() => combineTriggers(triggers), [triggers]);
  const nameError = !name.trim() ? 'Give the routine a name.' : '';
  const instructionError = !instruction.trim() ? 'Describe what should run each time.' : '';
  const canSave = !nameError && !instructionError && combined.ok && busy === null;

  // Posting (spec 10.1). A deleted routine's item is shown on each routine whose policy
  // origin is its origin, and one with no origin (the bot's desktop) on every routine:
  // exactly the items "Checked — continue" acknowledges here (external-effects.ts).
  const currentRoutineId = routine?.id ?? null;
  const policy = currentRoutineId ? posting.publishPolicies.find((row) => row.routineId === currentRoutineId) ?? null : null;
  const ownGroups = currentRoutineId
    ? pendingGroups(posting.pendingEffects.filter((item) => !item.routineDeleted && item.routineId === currentRoutineId))
    : [];
  const deletedGroups = currentRoutineId
    ? pendingGroups(posting.pendingEffects.filter((item) => item.routineDeleted && (item.origin === undefined || item.origin === policy?.origin)))
    : [];

  /** "Open run" and run links: show that run's saved result, also for a run of a deleted routine. */
  function openRun(runId: string) {
    resultRequest.current = runId;
    setSelectedRun(runId);
  }

  async function setMustPost(required: boolean) {
    if (!routine) return;
    const routineId = routine.id;
    setPostingBusy('policy');
    setPostingError('');
    try {
      const record = (await api.systemAction('routine-publish-policy', { agentId, routineId, required })) as PublishPolicyRow;
      const row: PublishPolicyRow = { routineId: record.routineId, origin: record.origin, required: record.required, source: record.source,
        evidenceRunId: record.evidenceRunId, createdAt: record.createdAt, updatedAt: record.updatedAt };
      setPosting((current) => ({ ...current, publishPolicies: [...current.publishPolicies.filter((existingRow) => existingRow.routineId !== routineId), row] }));
    } catch (cause) {
      setPostingError(cause instanceof Error ? cause.message : 'The daemon rejected that action.');
    } finally {
      setPostingBusy(null);
    }
  }

  async function acknowledge() {
    if (!routine) return;
    setPostingBusy('acknowledge');
    setPostingError('');
    try {
      await api.systemAction('routine-acknowledge', { agentId, routineId: routine.id });
      setConfirmContinue(false);
      // Re-read rather than guess: the daemon decides which items it acknowledged.
      setPostingVersion((version) => version + 1);
    } catch (cause) {
      setPostingError(cause instanceof Error ? cause.message : 'The daemon rejected that action.');
    } finally {
      setPostingBusy(null);
    }
  }

  function patchTrigger(id: string, patch: Partial<ScheduleTrigger>) {
    setTriggers((current) =>
      current.map((trigger) =>
        trigger.id === id && trigger.type === 'schedule' ? { ...trigger, ...patch } : trigger
      )
    );
  }

  async function run(kind: 'save' | 'delete' | 'test' | 'toggle', action: () => Promise<void>) {
    setBusy(kind);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The daemon rejected that action.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grok-routine-editor oh-routine-studio">
      <header className="grok-panel-header">
        <IconButton onClick={onBack} aria-label="Back to routines" title="Back to routines">
          <Icon name="back" />
        </IconButton>
        <h2 className="grok-panel-title">Routine</h2>
        <IconButton onClick={onClose} aria-label="Close details" title="Close details">
          <Icon name="expand" />
        </IconButton>
      </header>

      <div className="grok-routine-toolbar">
        <label className="grok-switch-inline">
          <Switch
            checked={enabled}
            disabled={busy !== null}
            onCheckedChange={(next) => {
              setEnabled(next);
              if (routine) void run('toggle', () => onSetEnabled(routine.id, next));
            }}
          />
          <span>Active</span>
        </label>
        <div className="grok-routine-toolbar-actions">
          <Button kind="secondary" disabled={!routine || busy !== null} title={routine ? 'Delete this routine' : 'Save the routine before it can be deleted.'} onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
          <Button kind="secondary" disabled={!routine || busy !== null} title={ routine ? 'Queue a run of this routine now' : 'Save the routine before it can be test-run.' } onClick={() => routine && void run('test', () => onTestRun(routine.id))}
          >
            {busy === 'test' ? 'Queuing…' : 'Test run'}
          </Button>
        </div>
      </div>

      {confirmDelete && routine && (
        <div className="grok-inline-confirm" role="alertdialog" aria-label="Confirm delete">
          <p>Delete “{routine.name}”? Its run history stays, but it will never run again.</p>
          <div>
            <button
              type="button"
              className="grok-danger-btn"
              disabled={busy !== null}
              onClick={() => void run('delete', () => onDelete(routine.id))}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete routine'}
            </button>
            <Button kind="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="grok-routine-body">
        <div className="oh-panel-intro"><span className="oh-studio-eyebrow">Recurring work</span><h3>{routine?'Shape the routine':'A little work, on repeat'}</h3><p>Set the task, choose when it runs and define the result.</p></div>
        <section className="oh-settings-card oh-routine-definition"><div className="oh-section-heading"><h3>The task</h3><p>One clear instruction for each run.</p></div>
        <label className="grok-form-group">
          <span className="grok-form-label">Name</span>
          <Input
            className="grok-form-input"
            value={name}
            maxLength={120}
            placeholder="Name this routine"
            aria-invalid={Boolean(nameError)}
            onChange={(event) => setName(event.target.value)}
          />
          {nameError && <span className="grok-field-error">{nameError}</span>}
        </label>

        <label className="grok-form-group">
          <span className="grok-form-label">Instruction</span>
          <Textarea
            className="grok-form-textarea"
            rows={4}
            value={instruction}
            placeholder="What should this routine do each time it runs?"
            aria-invalid={Boolean(instructionError)}
            onChange={(event) => setInstruction(event.target.value)}
          />
          {instructionError && <span className="grok-field-error">{instructionError}</span>}
        </label>

        </section>
        <section className="grok-trigger-section oh-settings-card" aria-label="When to run">
          <h3 className="grok-form-label">When to run</h3>
          <div className="grok-trigger-box">
            {triggers.map((trigger) => (
              <TriggerRow
                key={trigger.id}
                trigger={trigger}
                onChange={(patch) => patchTrigger(trigger.id, patch)}
                onRemove={() => {
                  setTriggers((current) => current.filter((t) => t.id !== trigger.id));
                  // Removing the webhook trigger revokes its token, so a URL
                  // that has left the building stops working straight away.
                  if (isWorkingEventTrigger(trigger) && routine) {
                    void run('save', () => onSetWebhook(routine.id, false));
                  }
                }}
                webhook={
                  isWorkingEventTrigger(trigger) && routine?.webhook_token
                    ? {
                        url: webhookUrl,
                        resolving: origin === undefined,
                        loopback: origin !== undefined && origin !== null && isLoopback(origin),
                        copied: webhookCopied,
                        onCopy: () => {
                          if (!webhookUrl) return;
                          void navigator.clipboard
                            .writeText(webhookUrl)
                            .then(() => setWebhookCopied(true))
                            .catch(() => setWebhookCopied(false));
                        },
                        onRotate: () => void run('save', () => onSetWebhook(routine.id, true, true)),
                      }
                    : undefined
                }
              />
            ))}

            <button
              ref={addRef}
              type="button"
              className="grok-add-trigger"
              onClick={() => {
                setScheduleSubmenu(false);
                setAddOpen(true);
              }}
              aria-haspopup="menu"
            >
              <Icon name="add" />
              {triggers.length ? 'Add another' : 'Add trigger'}
            </button>
          </div>

          <div className="grok-schedule-preview">
            {combined.ok ? (
              <>
                Timezone: {timezone}. <details><summary>Schedule expression</summary><code>{combined.cron}</code></details>
              </>
            ) : (
              <span className="grok-field-error">{combined.reason}</span>
            )}
          </div>
          {combined.ignored.map(({ trigger, reason }) => (
            <p key={trigger.id} className="grok-field-error" role="status">
              {reason}
            </p>
          ))}
        </section>

        {error && (
          <FormError>
            {error}
          </FormError>
        )}

        <Button kind="primary" disabled={!canSave} onClick={() =>
            combined.ok &&
            void run('save', () =>
              onSave(
                {
                  id: routine?.id ?? null,
                  name: name.trim(),
                  instruction: instruction.trim(),
                  taskName: 'routine:ask',
                  triggers,
                  enabled,
                  timezone,
                  webhookEnabled: triggers.some(isWorkingEventTrigger),
                  scheduleEnabled: combined.scheduleEnabled,
                },
                combined.cron
              )
            )
          }
        >
          {busy === 'save' ? 'Saving…' : routine ? 'Save routine' : 'Create routine'}
        </Button>

        {routine && (ownGroups.length > 0 || deletedGroups.length > 0) && (
          <section className="grok-pending-banner" aria-label="Unconfirmed posts">
            {ownGroups.map((group) => (
              <div key={group.runId} className="grok-pending-item">
                <p>{group.origin ? `A run at ${localTime(group.at)} submitted something on x.com whose result was never confirmed. This routine is waiting until you check the account.` : group.detail}</p>
                {group.before && <p className="grok-field-hint">This run is from before OpenAgents checked posts, so only the click was recorded.</p>}
                <Button kind="secondary" onClick={() => openRun(group.runId)}>
                  Open run
                </Button>
              </div>
            ))}
            {deletedGroups.map((group) => (
              <div key={group.runId} className="grok-pending-item">
                <p>
                  {!group.origin
                    ? group.detail
                    : ownGroups.length > 0
                      ? `Also never confirmed: run ${shortRunId(group.runId)} of the deleted routine “${group.routineName}” at ${localTime(group.at)} clicked on x.com. It does not hold this routine.`
                      : `Run ${shortRunId(group.runId)} of the deleted routine “${group.routineName}” at ${localTime(group.at)} clicked on x.com and its result was never confirmed. Nothing is waiting on it.`}
                </p>
                {group.before && <p className="grok-field-hint">This run is from before OpenAgents checked posts, so only the click was recorded.</p>}
                <Button kind="secondary" onClick={() => openRun(group.runId)}>
                  Open run
                </Button>
              </div>
            ))}
            <Button kind="primary" disabled={postingBusy !== null} onClick={() => setConfirmContinue(true)}>
              Checked — continue
            </Button>
            {confirmContinue && (
              <div className="grok-inline-confirm" role="alertdialog" aria-label="Confirm checked">
                <p>Continue only after checking the account on x.com: the next run may post.</p>
                {deletedGroups.map((group) => (
                  <p key={group.runId}>{`This also marks run ${shortRunId(group.runId)} of the deleted routine “${group.routineName}” as checked.`}</p>
                ))}
                <div>
                  <Button kind="primary" disabled={postingBusy !== null} onClick={() => void acknowledge()}>
                    Continue
                  </Button>
                  <Button kind="secondary" onClick={() => setConfirmContinue(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        {routine && policy && (
          <section className="grok-posting-section oh-settings-card" aria-label="Posting">
            <h3 className="grok-form-label">Existing publication requirement</h3>
            <label className="grok-switch-inline">
              <Switch
                checked={policy?.required ?? false}
                disabled={posting.status !== 'ready' || postingBusy !== null}
                onCheckedChange={(next) => { if (next) setConfirmMustPost(true); else void setMustPost(false); }}
              />
              <span>This routine must post on x.com</span>
            </label>
            {confirmMustPost && (
              <div className="grok-inline-confirm" role="alertdialog" aria-label="Confirm required posting">
                <p>Every run must confirm a post on x.com, or it fails. Turn this on only if the task above asks for a post.</p>
                <div>
                  <Button kind="primary" disabled={postingBusy !== null} onClick={() => { setConfirmMustPost(false); void setMustPost(true); }}>
                    Require a post
                  </Button>
                  <Button kind="secondary" onClick={() => setConfirmMustPost(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {posting.status === 'ready' && <PostingReason policy={policy} onOpenRun={openRun} />}
            {posting.status === 'error' && <FormError>{posting.error}</FormError>}
            {postingError && <FormError>{postingError}</FormError>}
          </section>
        )}

        {routine&&<ExpectedResults agentId={agentId} routineId={routine.id}/>}
        {routine&&policy&&<RoutineFlow agentId={agentId} routineId={routine.id}/>}
        <section className="grok-run-history" aria-label="Run history">
          <div className="oh-section-heading"><span className="oh-studio-eyebrow">Activity</span><h3>Run history</h3><p>What happened, what it cost and the result.</p></div>
          {!routine && <p className="grok-empty-note">Save the routine to start a history.</p>}
          {routine && runsLoading && (
            <p className="grok-empty-note">
              <Spinner className="grok-spinner-icon" /> Loading run history…
            </p>
          )}
          {routine && !runsLoading && runsError && (
            <FormError>
              {runsError}
            </FormError>
          )}
          {routine && !runsLoading && !runsError && runs?.length === 0 && (
            <Empty className="grok-empty-note">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Icon name="schedule" motion={false} />
                </EmptyMedia>
                <EmptyTitle>No runs yet</EmptyTitle>
                <EmptyDescription>
                  Runs appear here once the schedule fires or you run it by hand.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {routine && !runsLoading && !runsError && !!runs?.length && (
            <ul className="grok-run-list">
              {runs.map((taskRun) => (
                <li key={taskRun.id}>
                  <span className={`grok-run-status ${runStatusLabel(taskRun).toLowerCase()}`}>{runStatusLabel(taskRun)}</span>
                  <span className="grok-run-time">
                    {taskRun.started_at
                      ? new Date(taskRun.started_at).toLocaleString(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short' })
                      : 'not started'}
                  </span>
                  <button
                    type="button"
                    className={selectedRun === taskRun.id ? 'is-selected' : undefined}
                    aria-pressed={selectedRun === taskRun.id}
                    onClick={() => {
                      if (selectedRun === taskRun.id) {
                        setSelectedRun(null);
                        resultRequest.current = null;
                        return;
                      }
                      // Before this the button only set a placeholder and never
                      // asked the daemon for the result, so every run showed
                      // "Loading result…" forever.
                      setSelectedRun(taskRun.id);
                      setRunReport('Loading result…');
                      resultRequest.current = taskRun.id;
                      void api
                        .workResult(taskRun.id)
                        .then((body) => {
                          if (resultRequest.current === taskRun.id) setRunReport(body.result.report);
                        })
                        .catch((cause) => {
                          if (resultRequest.current !== taskRun.id) return;
                          setRunReport(
                            taskRun.error_message
                              ? `**This run ${taskRun.status.toLowerCase()}.** ${taskRun.error_message}`
                              : taskRun.status === 'QUEUED' || taskRun.status === 'RUNNING'
                                ? 'This run has not finished yet.'
                                : `No result was saved for this run.${cause instanceof Error ? ` ${cause.message}` : ''}`
                          );
                        });
                    }}
                  >
                    {selectedRun === taskRun.id ? 'Hide result' : 'View result'}
                  </button>
                  <span className="grok-run-cost">{taskRun.actual_cost_usd>0?`$${taskRun.actual_cost_usd.toFixed(4)}`:'Cost not established'}</span>
                  {taskRun.error_message&&<p className="grok-field-hint oh-run-error">{taskRun.error_message.slice(0,240)}</p>}
                  <RunBadges run={taskRun} policy={policy} />
                </li>
              ))}
            </ul>
          )}
          {selectedRun && <article aria-label="Run result"><GoalResultChecklist agentId={agentId} runId={selectedRun}/><MessageBody content={runReport} markdown /></article>}
        </section>
      </div>

      {addOpen && (
        <Popover
          anchorRef={addRef}
          placement="bottom-start"
          label="Add a trigger"
          width={230}
          onClose={() => {
            setAddOpen(false);
            setScheduleSubmenu(false);
          }}
        >
          {!scheduleSubmenu ? (
            <>
              <MenuItem icon={<Icon name="schedule" />} onSelect={() => setScheduleSubmenu(true)}>
                On a schedule <Icon name="forward" size={14} />
              </MenuItem>
              <MenuSeparator />
              {EVENT_TRIGGER_TYPES.map((type) => (
                <MenuItem
                  key={type.id}
                  icon={<Icon name="power" />}
                  disabled={type.viaWebhook}
                  title={
                    type.viaWebhook
                      ? `${type.label} has no dedicated integration. Add a Webhook trigger and point ${type.label.split(' ')[0]} at its URL.`
                      : 'Give this routine a URL that fires it when something POSTs to it.'
                  }
                  onSelect={() => {
                    if (type.viaWebhook) return;
                    setTriggers((current) =>
                      current.some(isWorkingEventTrigger) ? current : [...current, newEventTrigger('webhook')]
                    );
                    setAddOpen(false);
                    setScheduleSubmenu(false);
                  }}
                >
                  {type.label}
                </MenuItem>
              ))}
              <p className="grok-menu-empty">
                Slack, Git, Teams, Linear, Sentry and PagerDuty all send outbound
                webhooks — add a Webhook trigger and point them at its URL.
              </p>
            </>
          ) : (
            <>
              {(['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'interval', 'advanced'] as ScheduleFrequency[]).map(
                (frequency) => (
                  <MenuItem
                    key={frequency}
                    onSelect={() => {
                      setTriggers((current) => [...current, newScheduleTrigger(frequency)]);
                      setAddOpen(false);
                      setScheduleSubmenu(false);
                    }}
                  >
                    {FREQUENCY_LABELS[frequency]}
                  </MenuItem>
                )
              )}
            </>
          )}
        </Popover>
      )}
    </div>
  );
}

function TriggerRow({
  trigger,
  onChange,
  onRemove,
  webhook,
}: {
  trigger: RoutineTrigger;
  onChange: (patch: Partial<ScheduleTrigger>) => void;
  onRemove: () => void;
  webhook?: {
    /** Null while the daemon's origin is being resolved, or if it could not be. */
    url: string | null;
    resolving: boolean;
    loopback: boolean;
    copied: boolean;
    onCopy: () => void;
    onRotate: () => void;
  };
}) {
  const result = triggerToCron(trigger);

  if (trigger.type === 'event') {
    const working = isWorkingEventTrigger(trigger);
    return (
      <div className={`grok-trigger-row ${working ? '' : 'invalid'}`}>
        <div className="grok-trigger-summary">
          <Icon name="power" />
          <span>{working ? 'Webhook' : describeTrigger(trigger)}</span>
          <button type="button" aria-label="Remove trigger" onClick={onRemove}>
            <Icon name="close" />
          </button>
        </div>
        {working ? (
          webhook ? (
            <div className="grok-webhook-box">
              <code className="grok-webhook-url">
                {webhook.url ?? (webhook.resolving ? 'Finding the daemon…' : 'Daemon address unavailable')}
              </code>
              <div className="grok-webhook-actions">
                <Button kind="secondary" disabled={!webhook.url} onClick={webhook.onCopy}>
                  {webhook.copied ? 'Copied' : 'Copy URL'}
                </Button>
                <Button kind="secondary" onClick={webhook.onRotate}>
                  Rotate
                </Button>
              </div>
              <p className="grok-field-hint">
                POST to this URL to run the routine now. The token is the whole
                credential — rotating it revokes the old URL immediately. A
                routine that is not Active will not fire.
              </p>
              {webhook.loopback && (
                <p className="grok-field-hint">
                  This address is on this machine only. A service on the
                  internet cannot reach it without a tunnel or a port you have
                  deliberately exposed.
                </p>
              )}
              {webhook.url === null && !webhook.resolving && (
                <p className="grok-field-error">
                  The daemon did not report the port it is listening on, so the
                  URL cannot be composed here. It is
                  <code> /api/webhooks/routines/&lt;token&gt;</code> on whichever
                  address serves the daemon.
                </p>
              )}
            </div>
          ) : (
            <p className="grok-field-hint">
              Save the routine to issue its webhook URL.
            </p>
          )
        ) : (
          !result.ok && <p className="grok-field-error">{result.reason}</p>
        )}
      </div>
    );
  }

  const showTimes = trigger.frequency !== 'interval' && trigger.frequency !== 'custom';

  return (
    <div className="grok-trigger-row">
      <div className="grok-trigger-summary">
        <Icon name="schedule" />
        <span>{describeTrigger(trigger)}</span>
        <button type="button" aria-label="Remove trigger" onClick={onRemove}>
          <Icon name="close" />
        </button>
      </div>

      <div className="grok-trigger-controls">
        <label className="grok-visually-hidden" htmlFor={`freq-${trigger.id}`}>
          Frequency
        </label>
        <Select
          value={trigger.frequency}
          onValueChange={(value) => value && onChange({ frequency: value as ScheduleFrequency })}
        >
          <SelectTrigger id={`freq-${trigger.id}`} className="grok-mini-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
          {(Object.keys(FREQUENCY_LABELS) as ScheduleFrequency[]).map((frequency) => (
            <SelectItem key={frequency} value={frequency}>
              {FREQUENCY_LABELS[frequency]}
            </SelectItem>
          ))}
          </SelectContent>
        </Select>

        {trigger.frequency === 'weekly' && (
          <Select
            value={String(trigger.weekday)}
            onValueChange={(value) => value && onChange({ weekday: Number(value) })}
          >
            <SelectTrigger className="grok-mini-select" aria-label="Day of week">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
            {WEEKDAY_LABELS.map((label, index) => (
              <SelectItem key={label} value={String(index)}>
                {label}
              </SelectItem>
            ))}
            </SelectContent>
          </Select>
        )}

        {trigger.frequency === 'monthly' && (
          <Select
            value={String(trigger.dayOfMonth)}
            onValueChange={(value) => value && onChange({ dayOfMonth: Number(value) })}
          >
            <SelectTrigger className="grok-mini-select" aria-label="Day of month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
              <SelectItem key={day} value={String(day)}>
                Day {day}
              </SelectItem>
            ))}
            </SelectContent>
          </Select>
        )}

        {trigger.frequency === 'interval' && (
          <label className="grok-inline-field">
            Every
            <Input
              type="number"
              min={1}
              max={1380}
              className="grok-mini-input"
              aria-label="Interval in minutes"
              value={trigger.intervalMinutes}
              onChange={(event) => onChange({ intervalMinutes: Number(event.target.value) })}
            />
            minutes
          </label>
        )}

        {trigger.frequency === 'custom' && (
          <Input
            type="text"
            className="grok-mini-input wide"
            aria-label="Cron expression"
            placeholder="0 9 * * 1-5"
            value={trigger.cron}
            onChange={(event) => onChange({ cron: event.target.value })}
          />
        )}

        {showTimes && trigger.frequency !== 'advanced' && (
          <>
            <span className="grok-inline-word">at</span>
            <Select
              value={String(trigger.times[0] ?? 0)}
              onValueChange={(value) => value && onChange({ times: [Number(value)] })}
            >
              <SelectTrigger className="grok-mini-select" aria-label="Time of day">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
              {TIME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
              </SelectContent>
            </Select>
          </>
        )}
      </div>

      {trigger.frequency === 'advanced' && (
        <div className="grok-advanced-schedule">
          <div className="grok-advanced-row">
            <span>Months</span>
            <Select
              value={trigger.months.length === 1 ? String(trigger.months[0]) : 'any'}
              onValueChange={(value) =>
                onChange({ months: value && value !== 'any' ? [Number(value)] : [] })
              }
            >
              <SelectTrigger className="grok-mini-select" aria-label="Months">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
              <SelectItem value="any">Any month</SelectItem>
              {MONTH_LABELS.map((label, index) => (
                <SelectItem key={label} value={String(index + 1)}>
                  {label}
                </SelectItem>
              ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grok-advanced-row">
            <span>Days</span>
            <Select
              value={trigger.days.length === 1 ? String(trigger.days[0]) : 'any'}
              onValueChange={(value) =>
                onChange({ days: value && value !== 'any' ? [Number(value)] : [] })
              }
            >
              <SelectTrigger className="grok-mini-select" aria-label="Days">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
              <SelectItem value="any">Every day</SelectItem>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                <SelectItem key={day} value={String(day)}>
                  Day {day}
                </SelectItem>
              ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grok-advanced-row">
            <span>Time</span>
            <span className="grok-inline-word">At times</span>
          </div>

          {trigger.times.map((time, index) => (
            <div className="grok-advanced-row" key={`${time}-${index}`}>
              <Select
                value={String(time)}
                onValueChange={(value) => {
                  if (!value) return;
                  const times = [...trigger.times];
                  times[index] = Number(value);
                  onChange({ times });
                }}
              >
                <SelectTrigger className="grok-mini-select" aria-label={`Time ${index + 1}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                {TIME_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
                </SelectContent>
              </Select>
              {trigger.times.length > 1 && (
                <IconButton aria-label={`Remove ${formatTime(time)}`} onClick={() => onChange({ times: trigger.times.filter((_, i) => i !== index) })}
                >
                  <Icon name="close" />
                </IconButton>
              )}
            </div>
          ))}

          <button
            type="button"
            className="grok-add-trigger small"
            onClick={() =>
              onChange({
                times: [...trigger.times, Math.min(23 * 60 + 45, (trigger.times.at(-1) ?? 0) + 60)],
              })
            }
          >
            <Icon name="add" /> Add time
          </button>
        </div>
      )}

      {!result.ok && <p className="grok-field-error">{result.reason}</p>}
    </div>
  );
}

// ---- Posting (spec 10.1) ----

interface PostingState {
  status: 'loading' | 'ready' | 'error';
  pendingEffects: PendingEffectRow[];
  publishPolicies: PublishPolicyRow[];
  error?: string;
}

const POSTING_LOADING: PostingState = { status: 'loading', pendingEffects: [], publishPolicies: [] };

/** One banner line per run: a run's click and its post are one thing for the owner to check. */
interface PendingGroup {
  runId: string;
  routineName: string;
  at: number;
  origin?: string;
  before: boolean;
  detail: string;
}

function pendingGroups(items: readonly PendingEffectRow[]): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const item of items) {
    const group = groups.get(item.runId);
    if (!group) {
      groups.set(item.runId, { runId: item.runId, routineName: item.routineName, at: item.at, origin: item.origin, before: item.before, detail: item.detail });
      continue;
    }
    group.at = Math.min(group.at, item.at);
    group.origin = group.origin ?? item.origin;
  }
  return [...groups.values()];
}

const localTime = (at: number) => new Date(at).toLocaleString(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

/** The short form the owner knows a run by: `run-1790074518658-wveu4` reads as `wveu4`. */
function shortRunId(runId: string): string {
  return /^run-\d+-([a-z0-9]+)$/i.exec(runId)?.[1] ?? runId;
}

function RunLink({ runId, onOpen }: { runId: string; onOpen: (runId: string) => void }) {
  return (
    <a
      href={`#${runId}`}
      title={runId}
      onClick={(event) => {
        event.preventDefault();
        onOpen(runId);
      }}
    >
      {shortRunId(runId)}
    </a>
  );
}

/** Why the switch is where it is. "x.com" is fixed wording, whatever the probe origin. */
function PostingReason({ policy, onOpenRun }: { policy: PublishPolicyRow | null; onOpenRun: (runId: string) => void }) {
  if (!policy) return <p className="grok-field-hint">Off: this routine has never posted on x.com, so it may finish without posting.</p>;
  const run = policy.evidenceRunId ? <RunLink runId={policy.evidenceRunId} onOpen={onOpenRun} /> : null;
  if (policy.source === 'history') {
    return <p className="grok-field-hint">On because run {run} clicked on x.com. Runs of this routine finish only with a confirmed post.</p>;
  }
  if (policy.source === 'observed') {
    return <p className="grok-field-hint">On because run {run} sent a post to x.com. Runs of this routine finish only with a confirmed post.</p>;
  }
  const date = new Date(policy.updatedAt).toLocaleDateString(UI_LOCALE, { dateStyle: 'medium' });
  return policy.required
    ? <p className="grok-field-hint">On: set by you on {date}. Runs of this routine finish only with a confirmed post.</p>
    : <p className="grok-field-hint">Off: set by you on {date}. This routine may finish without posting.</p>;
}

type RunBadge = { label: string; tone: 'ok' | 'warn' | 'bad'; href?: string };

/** A web address to link a post to; anything else is shown unlinked. */
function webHref(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/** The run-history badges for one run, from the runs API's `publish` and the routine's policy row. */
function runBadges(run: TaskRunRow, policy: PublishPolicyRow | null): RunBadge[] {
  const badges: RunBadge[] = [];
  const publish = run.publish;
  const confirmed = publish?.state === 'confirmed' || publish?.state === 'confirmed-page';
  if (publish) {
    const href = webHref(publish.postUrl);
    if (confirmed && publish.by === 'operator') badges.push({ label: 'Posted by you', tone: 'ok' });
    else if (publish.state === 'confirmed') badges.push(href ? { label: 'Posted ✓', tone: 'ok', href } : { label: 'Posted ✓', tone: 'ok' });
    else if (publish.state === 'confirmed-page') badges.push({ label: 'Posted ✓ (checked on page)', tone: 'ok' });
    else if (publish.state === 'rejected') badges.push({ label: 'X refused', tone: 'bad' });
    else badges.push({ label: 'Unconfirmed post', tone: 'warn' });
    if (publish.heldBack === 'budget') badges.push({ label: 'Held back a second post', tone: 'warn' });
  }
  // A must-post routine that completed without a confirmed post. A run that started
  // before the policy row existed was never checked, so it is not called a failure (gqw8h).
  if (run.status === 'COMPLETED' && !confirmed && policy?.required) {
    badges.push({ label: (run.started_at ?? 0) >= policy.createdAt ? 'Completed, no confirmed post' : 'Completed, post not checked', tone: 'warn' });
  }
  return badges;
}

function RunBadges({ run, policy }: { run: TaskRunRow; policy: PublishPolicyRow | null }) {
  const badges = runBadges(run, policy);
  if (!badges.length) return null;
  return (
    <span className="grok-run-badges">
      {badges.map((badge) =>
        badge.href ? (
          <a key={badge.label} className={`grok-run-badge ${badge.tone}`} href={badge.href} target="_blank" rel="noreferrer">
            {badge.label}
          </a>
        ) : (
          <span key={badge.label} className={`grok-run-badge ${badge.tone}`}>
            {badge.label}
          </span>
        )
      )}
    </span>
  );
}

/** A FAILED run whose model itself declared the block reads BLOCKED (spec decision 3). */
function runStatusLabel(run: TaskRunRow): string {
  return run.status === 'FAILED' && run.blocked ? 'BLOCKED' : run.status;
}
