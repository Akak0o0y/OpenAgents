/**
 * Routine editor behaviour.
 *
 * The states that matter: a blank editor that cannot be saved and says why,
 * event triggers that are visibly unavailable rather than silently ignored,
 * run history in its loading / empty / failed forms, and Delete and Test run
 * disabled until there is something to delete or run.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrokRoutineEditor, type RoutineDraft } from './GrokRoutineEditor.js';
import { api, type PendingEffectRow, type PublishPolicyRow, type RoutineRow, type TaskRunRow } from '../lib/transport.js';
import { UI_LOCALE } from '../lib/numbers.js';
import { resetDaemonOrigin } from '../lib/daemonOrigin.js';

const noop = async () => undefined;

function props(overrides: Partial<React.ComponentProps<typeof GrokRoutineEditor>> = {}) {
  return {
    agentId: 'atlas',
    routine: null as RoutineRow | null,
    onBack: () => undefined,
    onClose: () => undefined,
    onSave: vi.fn(noop),
    onDelete: vi.fn(noop),
    onTestRun: vi.fn(noop),
    onSetEnabled: vi.fn(noop),
    onSetWebhook: vi.fn(async (_id: string, _enabled: boolean, _rotate?: boolean) => undefined),
    ...overrides,
  };
}

const existing: RoutineRow = {
  id: 'rtn-1',
  agent_id: 'atlas',
  name: 'Morning digest',
  cron_expression: '0 8 * * *',
  human_schedule: 'every day at 8 am',
  timezone: 'UTC',
  prompt_template: 'Summarise overnight changes.',
  enabled: 1,
  catch_up_policy: 'skip',
  next_run_at: 1_800_000_000_000,
  created_at: 1,
  updated_at: 1,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'workTasks').mockResolvedValue({ tasks: [
    { id: 'evidence-brief', name: 'Source-based report', description: 'Quotes checked', requirements: [] },
    { id: 'action-plan', name: 'Action plan', description: 'Dependencies checked', requirements: [] },
  ] });
  vi.spyOn(api, 'routineRuns').mockResolvedValue({ runs: [] });
  // Posting facts come from GET /api/system; by default this bot has none.
  vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem());
  // The webhook URL names the DAEMON, not whatever served the page, so the
  // editor asks /health for the port. See lib/daemonOrigin.ts.
  resetDaemonOrigin();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => ({
      ok: true,
      json: async () => {
        const url = String(input);
        if (url.includes('/expected-results')) return { requirements: [] };
        if (url.includes('/goal-results')) return { satisfaction: 'unverified', legacy: true, results: [] };
        if (url.includes('/routine-attention')) return { held: false, code: null, reason: null };
        return { status: 'HEALTHY', service: 'openhours-daemon', port: 4001 };
      },
    }))
  );
});

describe('a blank editor', () => {
  it('round trips webhook-only intent without resurrecting its placeholder schedule', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(noop);
    render(<GrokRoutineEditor {...props({ routine: { ...existing, schedule_enabled: 0, webhook_token: 'tok-123' }, onSave })} />);
    expect(screen.getAllByRole('button', { name: 'Remove trigger' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save routine' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ scheduleEnabled: false, webhookEnabled: true }), expect.any(String));
  });

  it('keeps an explicitly enabled leap-day timetable', () => {
    render(<GrokRoutineEditor {...props({ routine: { ...existing, cron_expression: '4 3 29 2 *', schedule_enabled: 1, webhook_token: 'tok-123' } })} />);
    expect(screen.getAllByRole('button', { name: 'Remove trigger' })).toHaveLength(2);
  });
  it('uses each routine timezone when switching routines without unmounting', async () => {
    const onSave = vi.fn(noop);
    const view = render(<GrokRoutineEditor {...props({ routine: existing, onSave })} />);
    view.rerender(<GrokRoutineEditor {...props({ routine: { ...existing, id: 'rtn-2', timezone: 'Asia/Riyadh' }, onSave })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save routine' }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'rtn-2', timezone: 'Asia/Riyadh' }), expect.any(String));
    view.rerender(<GrokRoutineEditor {...props({ routine: existing, onSave })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save routine' }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: existing.id, timezone: 'UTC' }), expect.any(String));
  });

  it('does not offer task types and saves instructions through the conversational runner', async () => {
    const onSave = vi.fn(noop);
    render(<GrokRoutineEditor {...props({ routine: { ...existing, task_name: 'work:evidence-brief' }, onSave })} />);
    expect(screen.queryByLabelText('What each run does')).not.toBeInTheDocument();
    expect(api.workTasks).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save routine' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ taskName: 'routine:ask', instruction: existing.prompt_template }), expect.any(String)));
  });
  it('cannot be saved, and names every missing field', () => {
    render(<GrokRoutineEditor {...props()} />);
    expect(screen.getByText('Give the routine a name.')).toBeInTheDocument();
    expect(screen.getByText('Describe what should run each time.')).toBeInTheDocument();
    expect(screen.getByText('Add at least one trigger so the routine knows when to run.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create routine' })).toBeDisabled();
  });

  it('disables Delete and Test run until the routine exists', () => {
    render(<GrokRoutineEditor {...props()} />);
    const del = screen.getByRole('button', { name: 'Delete' });
    const test = screen.getByRole('button', { name: 'Test run' });
    expect(del).toBeDisabled();
    expect(test).toBeDisabled();
    expect(test).toHaveAttribute('title', expect.stringContaining('Save the routine'));
  });

  it('says there is no history to show yet', () => {
    render(<GrokRoutineEditor {...props()} />);
    expect(screen.getByText('Save the routine to start a history.')).toBeInTheDocument();
  });
});

describe('triggers', () => {
  it('offers Webhook as a working trigger and the branded sources as pointers to it', async () => {
    const user = userEvent.setup();
    render(<GrokRoutineEditor {...props()} />);
    await user.click(screen.getByRole('button', { name: /Add trigger/ }));

    const webhook = screen.getByRole('menuitem', { name: 'Webhook' });
    expect(webhook).toBeEnabled();

    for (const label of [
      'Slack message',
      'Git event',
      'Teams message',
      'Linear issue',
      'Sentry alert',
      'PagerDuty incident',
    ]) {
      const item = screen.getByRole('menuitem', { name: label });
      expect(item, `${label} should be offered`).toBeInTheDocument();
      expect(item, `${label} should be disabled`).toBeDisabled();
      expect(item).toHaveAttribute('title', expect.stringContaining('point'));
    }
  });

  it('adds a webhook trigger and says the URL arrives on save', async () => {
    const user = userEvent.setup();
    render(<GrokRoutineEditor {...props()} />);
    await user.click(screen.getByRole('button', { name: /Add trigger/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Webhook' }));

    expect(screen.getByText('Webhook')).toBeInTheDocument();
    expect(screen.getByText(/Save the routine to issue its webhook URL/)).toBeInTheDocument();
  });

  it('shows the live URL for a routine that already has a token', async () => {
    render(
      <GrokRoutineEditor
        {...props({ routine: { ...existing, webhook_token: 'tok-123' } })}
      />
    );
    // The port comes from the daemon, not from the page: served by Vite in dev,
    // window.location.origin would name the dev server instead.
    expect(
      await screen.findByText('http://localhost:4001/api/webhooks/routines/tok-123')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeInTheDocument();
  });

  it('says a loopback webhook is only reachable from this machine', async () => {
    render(
      <GrokRoutineEditor {...props({ routine: { ...existing, webhook_token: 'tok-123' } })} />
    );
    expect(await screen.findByText(/on this machine only/i)).toBeInTheDocument();
  });

  it('refuses to compose a URL it could not establish, rather than guessing one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    render(
      <GrokRoutineEditor {...props({ routine: { ...existing, webhook_token: 'tok-123' } })} />
    );

    expect(await screen.findByText(/did not report the port/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeDisabled();
    expect(screen.queryByText(/tok-123/)).not.toBeInTheDocument();
  });

  it('asks the daemon to issue a webhook when one is saved', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_draft: RoutineDraft, _cron: string) => undefined);
    render(<GrokRoutineEditor {...props({ routine: existing, onSave })} />);

    await user.click(screen.getByRole('button', { name: /Add another/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Webhook' }));
    await user.click(screen.getByRole('button', { name: 'Save routine' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].webhookEnabled).toBe(true);
  });

  it('revokes the token when the webhook trigger is removed', async () => {
    const user = userEvent.setup();
    const onSetWebhook = vi.fn(async () => undefined);
    render(
      <GrokRoutineEditor
        {...props({ routine: { ...existing, webhook_token: 'tok-123' }, onSetWebhook })}
      />
    );
    const rows = screen.getAllByRole('button', { name: 'Remove trigger' });
    await user.click(rows[0]);
    await waitFor(() => expect(onSetWebhook).toHaveBeenCalledWith('rtn-1', false));
  });

  it('offers the documented schedule presets behind "On a schedule"', async () => {
    const user = userEvent.setup();
    render(<GrokRoutineEditor {...props()} />);
    await user.click(screen.getByRole('button', { name: /Add trigger/ }));
    await user.click(screen.getByRole('menuitem', { name: /On a schedule/ }));

    for (const label of ['Every hour', 'Every day', 'Weekdays', 'Every week', 'Every month', 'Interval', 'Advanced']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it('adds a daily trigger and shows the cron it will be saved as', async () => {
    const user = userEvent.setup();
    render(<GrokRoutineEditor {...props()} />);
    await user.click(screen.getByRole('button', { name: /Add trigger/ }));
    await user.click(screen.getByRole('menuitem', { name: /On a schedule/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Every day' }));

    expect(screen.getByText('Every day at 8:00 AM')).toBeInTheDocument();
    expect(screen.getByText('0 8 * * *')).toBeInTheDocument();
  });

  it('refuses to save two triggers that cannot become one schedule', async () => {
    const user = userEvent.setup();
    render(<GrokRoutineEditor {...props()} />);

    const addSchedule = async (preset: string) => {
      await user.click(screen.getByRole('button', { name: /Add (trigger|another)/ }));
      await user.click(screen.getByRole('menuitem', { name: /On a schedule/ }));
      await user.click(screen.getByRole('menuitem', { name: preset }));
    };
    await addSchedule('Every day');
    await addSchedule('Every week');

    expect(await screen.findByText(/run on different days/)).toBeInTheDocument();
  });
});

describe('an existing routine', () => {
  it('rebuilds its trigger from the stored cron expression', async () => {
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    expect(screen.getByDisplayValue('Morning digest')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Summarise overnight changes.')).toBeInTheDocument();
    expect(screen.getByText('Every day at 8:00 AM')).toBeInTheDocument();
  });

  it('sends the composed cron to the daemon on save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_draft: RoutineDraft, _cron: string) => undefined);
    render(<GrokRoutineEditor {...props({ routine: existing, onSave })} />);

    const name = screen.getByDisplayValue('Morning digest');
    await user.clear(name);
    await user.type(name, 'Evening digest');
    await user.click(screen.getByRole('button', { name: 'Save routine' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [draft, cron] = onSave.mock.calls[0];
    expect(draft.name).toBe('Evening digest');
    expect(draft.id).toBe('rtn-1');
    expect(cron).toBe('0 8 * * *');
  });

  it('asks before deleting, and only then calls the daemon', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(noop);
    render(<GrokRoutineEditor {...props({ routine: existing, onDelete })} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Confirm delete' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete routine' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('rtn-1'));
  });

  it('reports a daemon refusal instead of appearing to have saved', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new Error('Agent "atlas" does not exist.');
    });
    render(<GrokRoutineEditor {...props({ routine: existing, onSave })} />);
    await user.click(screen.getByRole('button', { name: 'Save routine' }));
    expect(await screen.findByText('Agent "atlas" does not exist.')).toBeInTheDocument();
  });
});

describe('run history', () => {
  it('shows a loading state, then the empty state', async () => {
    let resolve!: (value: { runs: [] }) => void;
    vi.spyOn(api, 'routineRuns').mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    expect(screen.getByText(/Loading run history/)).toBeInTheDocument();
    resolve({ runs: [] });
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
  });

  it('lists real runs with their status and cost', async () => {
    vi.spyOn(api, 'routineRuns').mockResolvedValue({
      runs: [
        {
          id: 'run-1',
          agent_id: 'atlas',
          task_name: 'routine-rtn-1',
          model_id: 'test-model',
          status: 'FAILED',
          turns_taken: 1,
          actual_cost_usd: 0.0125,
          started_at: 1_700_000_000_000,
          completed_at: 1_700_000_060_000,
        },
      ],
    });
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    expect(await screen.findByText('FAILED')).toBeInTheDocument();
    expect(screen.getByText('$0.0125')).toBeInTheDocument();
  });

  it('surfaces a history failure rather than showing an empty list', async () => {
    vi.spyOn(api, 'routineRuns').mockRejectedValue(
      new Error('This daemon was started without routine support.')
    );
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    expect(
      await screen.findByText('This daemon was started without routine support.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument();
  });
});

// ---- Posting (spec 10.1) ----

type BotSystem = Awaited<ReturnType<typeof api.botSystem>>;
const WVEU4 = 'run-1790074518658-wveu4';
const YF8VS = 'run-1789974004374-yf8vs';
const CLICK_AT = Date.UTC(2026, 8, 22, 10, 56, 50);
const GONE_AT = Date.UTC(2026, 8, 21, 7, 2, 0);
const POLICY_AT = Date.UTC(2026, 8, 24, 6, 0, 0);
const SET_AT = Date.UTC(2026, 8, 24, 12, 30, 0);

function postingSystem(extra: Pick<BotSystem, 'pendingEffects' | 'publishPolicies'> = {}): BotSystem {
  return { missions: [], memory: [], vault: { configured: false }, capacity: { used: 0, limit: 2 }, ...extra };
}

function policyRow(extra: Partial<PublishPolicyRow> = {}): PublishPolicyRow {
  return { routineId: 'rtn-1', origin: 'https://x.com', required: true, source: 'history', evidenceRunId: WVEU4, createdAt: POLICY_AT, updatedAt: POLICY_AT, ...extra };
}

function pendingItem(extra: Partial<PendingEffectRow> = {}): PendingEffectRow {
  const runId = extra.runId ?? WVEU4;
  return {
    routineId: 'rtn-1', routineName: 'Morning digest', routineDeleted: false, runId, at: CLICK_AT, kind: 'action', origin: 'https://x.com', before: false,
    detail: `Not started: run ${runId} at 2026-09-22 10:56 UTC submitted something on x.com whose result was never confirmed. Check the account, then choose “Checked — continue” on this routine.`,
    ...extra,
  };
}

const goneItem = (extra: Partial<PendingEffectRow> = {}) =>
  pendingItem({ routineId: 'rtn-gone', routineName: 'Milo life', routineDeleted: true, runId: YF8VS, at: GONE_AT, before: true, ...extra });

function taskRun(id: string, status: TaskRunRow['status'], startedAt: number, extra: Partial<TaskRunRow> = {}): TaskRunRow {
  return { id, agent_id: 'atlas', task_name: 'routine:ask', model_id: 'test-model', status, turns_taken: 2, actual_cost_usd: 0.001, started_at: startedAt, completed_at: startedAt + 60_000, ...extra };
}

const localTime = (at: number) => new Date(at).toLocaleString(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const localDate = (at: number) => new Date(at).toLocaleDateString(UI_LOCALE, { dateStyle: 'medium' });
/** The paragraph whose whole text, a run link included, is exactly this. */
const paragraph = (text: string) => screen.getByText((_content, element) => element?.tagName === 'P' && element.textContent === text);

describe('posting', () => {
  it('shows the must-post switch with the reason for each kind of policy row', async () => {
    const cases: Array<[PublishPolicyRow | null, boolean, string]> = [
      [null, false, 'Off: this routine has never posted on x.com, so it may finish without posting.'],
      [policyRow(), true, 'On because run wveu4 clicked on x.com. Runs of this routine finish only with a confirmed post.'],
      [policyRow({ source: 'observed', evidenceRunId: 'run-1790160000000-k3p9q' }), true, 'On because run k3p9q sent a post to x.com. Runs of this routine finish only with a confirmed post.'],
      [policyRow({ source: 'owner', required: true, evidenceRunId: null, updatedAt: SET_AT }), true, `On: set by you on ${localDate(SET_AT)}. Runs of this routine finish only with a confirmed post.`],
      [policyRow({ source: 'owner', required: false, evidenceRunId: null, updatedAt: SET_AT }), false, `Off: set by you on ${localDate(SET_AT)}. This routine may finish without posting.`],
    ];
    for (const [row, on, text] of cases) {
      vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ publishPolicies: row ? [row] : [] }));
      const view = render(<GrokRoutineEditor {...props({ routine: existing })} />);
      if (!row) {
        await waitFor(() => expect(api.botSystem).toHaveBeenCalled());
        expect(screen.queryByRole('switch', { name: 'This routine must post on x.com' })).not.toBeInTheDocument();
        view.unmount();
        continue;
      }
      expect(await screen.findByRole('heading', { name: 'Existing publication requirement' })).toBeInTheDocument();
      await waitFor(() => expect(paragraph(text)).toBeInTheDocument());
      const toggle = screen.getByRole('switch', { name: 'This routine must post on x.com' });
      if (on) expect(toggle).toBeChecked();
      else expect(toggle).not.toBeChecked();
      view.unmount();
    }
  });

  it('switches must-post through the daemon and opens the evidence run from its link', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ publishPolicies: [policyRow()] }));
    const action = vi.spyOn(api, 'systemAction').mockResolvedValue({
      ...policyRow({ source: 'owner', required: false, updatedAt: SET_AT }), agentId: 'atlas', probe: 'x.com/create-tweet',
    });
    const result = vi.spyOn(api, 'workResult').mockResolvedValue({ result: { report: 'Clicked Post on x.com; the result was never confirmed.', outcome: 'FAILED' } });
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    await waitFor(() => expect(paragraph('On because run wveu4 clicked on x.com. Runs of this routine finish only with a confirmed post.')).toBeInTheDocument());

    const link = screen.getByRole('link', { name: 'wveu4' });
    expect(link).toHaveAttribute('title', WVEU4);
    await user.click(link);
    await waitFor(() => expect(result).toHaveBeenCalledWith(WVEU4));
    expect(await screen.findByText('Clicked Post on x.com; the result was never confirmed.')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'This routine must post on x.com' }));
    await waitFor(() => expect(action).toHaveBeenCalledWith('routine-publish-policy', { agentId: 'atlas', routineId: 'rtn-1', required: false }));
    await waitFor(() => expect(paragraph(`Off: set by you on ${localDate(SET_AT)}. This routine may finish without posting.`)).toBeInTheDocument());
    expect(screen.getByRole('switch', { name: 'This routine must post on x.com' })).not.toBeChecked();
  });

  // 2026-10-02: a draft-only routine's switch was turned on with one click and every run then failed. Turning
  // posting on now asks first; turning it off stays one click.
  it('asks before requiring a post, and sends nothing when cancelled', async () => {
    const user = userEvent.setup();
    const off = policyRow({ source: 'owner', required: false, evidenceRunId: null, updatedAt: SET_AT });
    vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ publishPolicies: [off] }));
    const action = vi.spyOn(api, 'systemAction').mockResolvedValue({ ...off, required: true, agentId: 'atlas', probe: 'x.com/create-tweet' });
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    const toggle = await screen.findByRole('switch', { name: 'This routine must post on x.com' });

    await user.click(toggle);
    const confirm = await screen.findByRole('alertdialog', { name: 'Confirm required posting' });
    expect(within(confirm).getByText(/Every run must confirm a post on x\.com, or it fails/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog', { name: 'Confirm required posting' })).not.toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Confirm required posting' })).getByRole('button', { name: 'Require a post' }));
    await waitFor(() => expect(action).toHaveBeenCalledWith('routine-publish-policy', { agentId: 'atlas', routineId: 'rtn-1', required: true }));
  });

  it('shows the pending banner, opens the run, and acknowledges only after confirmation', async () => {
    const user = userEvent.setup();
    const system = vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ pendingEffects: [pendingItem()], publishPolicies: [policyRow()] }));
    const result = vi.spyOn(api, 'workResult').mockResolvedValue({ result: { report: 'The Post click timed out.', outcome: 'FAILED' } });
    const action = vi.spyOn(api, 'systemAction').mockResolvedValue({ acknowledged: 1 });
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    const banner = await screen.findByRole('region', { name: 'Unconfirmed posts' });
    expect(within(banner).getByText(`A run at ${localTime(CLICK_AT)} submitted something on x.com whose result was never confirmed. This routine is waiting until you check the account.`)).toBeInTheDocument();
    expect(within(banner).queryByText('This run is from before OpenAgents checked posts, so only the click was recorded.')).not.toBeInTheDocument();

    await user.click(within(banner).getByRole('button', { name: 'Open run' }));
    await waitFor(() => expect(result).toHaveBeenCalledWith(WVEU4));
    expect(await screen.findByText('The Post click timed out.')).toBeInTheDocument();

    await user.click(within(banner).getByRole('button', { name: 'Checked — continue' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm checked' });
    expect(within(confirm).getByText('Continue only after checking the account on x.com: the next run may post.')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog', { name: 'Confirm checked' })).not.toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();

    system.mockResolvedValue(postingSystem({ publishPolicies: [policyRow()] }));
    await user.click(within(banner).getByRole('button', { name: 'Checked — continue' }));
    await user.click(within(screen.getByRole('alertdialog', { name: 'Confirm checked' })).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(action).toHaveBeenCalledWith('routine-acknowledge', { agentId: 'atlas', routineId: 'rtn-1' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unconfirmed posts' })).not.toBeInTheDocument());
  });

  it('explains an item recorded before OpenAgents checked posts', async () => {
    vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ pendingEffects: [pendingItem({ before: true })], publishPolicies: [policyRow()] }));
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    const banner = await screen.findByRole('region', { name: 'Unconfirmed posts' });
    expect(within(banner).getByText('This run is from before OpenAgents checked posts, so only the click was recorded.')).toBeInTheDocument();
  });

  it('lists a deleted routine’s item on a routine of the same origin, and names it in the confirmation', async () => {
    const user = userEvent.setup();
    const action = vi.spyOn(api, 'systemAction').mockResolvedValue({ acknowledged: 2 });
    vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ pendingEffects: [pendingItem({ before: true }), goneItem()], publishPolicies: [policyRow()] }));
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    const banner = await screen.findByRole('region', { name: 'Unconfirmed posts' });
    expect(within(banner).getByText(`A run at ${localTime(CLICK_AT)} submitted something on x.com whose result was never confirmed. This routine is waiting until you check the account.`)).toBeInTheDocument();
    expect(within(banner).getByText(`Also never confirmed: run yf8vs of the deleted routine “Milo life” at ${localTime(GONE_AT)} clicked on x.com. It does not hold this routine.`)).toBeInTheDocument();
    expect(within(banner).getAllByRole('button', { name: 'Open run' })).toHaveLength(2);

    await user.click(within(banner).getByRole('button', { name: 'Checked — continue' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm checked' });
    expect(within(confirm).getByText('This also marks run yf8vs of the deleted routine “Milo life” as checked.')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(action).toHaveBeenCalledWith('routine-acknowledge', { agentId: 'atlas', routineId: 'rtn-1' }));
  });

  it('says nothing is waiting when only a deleted routine’s item is listed, and opens that run', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ pendingEffects: [goneItem()], publishPolicies: [policyRow()] }));
    const result = vi.spyOn(api, 'workResult').mockResolvedValue({ result: { report: 'Milo life clicked on x.com.', outcome: 'FAILED' } });
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    const banner = await screen.findByRole('region', { name: 'Unconfirmed posts' });
    expect(within(banner).getByText(`Run yf8vs of the deleted routine “Milo life” at ${localTime(GONE_AT)} clicked on x.com and its result was never confirmed. Nothing is waiting on it.`)).toBeInTheDocument();
    expect(within(banner).queryByText(/This routine is waiting until you check the account/)).not.toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Checked — continue' })).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Open run' }));
    await waitFor(() => expect(result).toHaveBeenCalledWith(YF8VS));
    expect(await screen.findByText('Milo life clicked on x.com.')).toBeInTheDocument();
  });

  it('shows a deleted routine’s x.com item only where the policy is on x.com, and a desktop item on every routine', async () => {
    vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ pendingEffects: [goneItem()], publishPolicies: [] }));
    const view = render(<GrokRoutineEditor {...props({ routine: existing })} />);
    await waitFor(() => expect(api.botSystem).toHaveBeenCalled());
    expect(screen.queryByRole('switch', { name: 'This routine must post on x.com' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Unconfirmed posts' })).not.toBeInTheDocument();
    view.unmount();

    const desktop = `Not started: run ${YF8VS} at 2026-09-21 07:02 UTC acted on this bot's desktop and its result was never confirmed. Check the desktop, then choose “Checked — continue” on this routine.`;
    vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ pendingEffects: [goneItem({ origin: undefined, detail: desktop })], publishPolicies: [] }));
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    const banner = await screen.findByRole('region', { name: 'Unconfirmed posts' });
    expect(within(banner).getByText(desktop)).toBeInTheDocument();
  });

  it('labels each run by its post, and completed runs of a must-post routine without one', async () => {
    const url = (id: string) => `https://x.com/example_account/status/${id}`;
    vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ publishPolicies: [policyRow()] }));
    vi.spyOn(api, 'routineRuns').mockResolvedValue({ runs: [
      taskRun('run-1790200000001-posta', 'COMPLETED', POLICY_AT + 1000, { publish: { state: 'confirmed', by: 'model', postUrl: url('1234567890123456789'), heldBack: null } }),
      taskRun('run-1790200000002-pageb', 'COMPLETED', POLICY_AT + 2000, { publish: { state: 'confirmed-page', by: 'model', postUrl: url('2102311235647680763'), heldBack: null } }),
      taskRun('run-1790200000003-handc', 'COMPLETED', POLICY_AT + 3000, { publish: { state: 'confirmed', by: 'operator', postUrl: url('2102311235647680764'), heldBack: 'budget' } }),
      taskRun('run-1790200000004-refdd', 'FAILED', POLICY_AT + 4000, { publish: { state: 'rejected', by: 'model', heldBack: null } }),
      taskRun('run-1790200000005-hunge', 'FAILED', POLICY_AT + 5000, { publish: { state: 'unconfirmed', by: 'model', heldBack: null } }),
      taskRun('run-1790200000006-baref', 'COMPLETED', POLICY_AT + 6000),
      taskRun('run-1790200000007-oldgg', 'COMPLETED', POLICY_AT - 60_000),
    ] });
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    await screen.findByText('Completed, no confirmed post');
    const rows = within(screen.getByRole('region', { name: 'Run history' })).getAllByRole('listitem');
    expect(rows).toHaveLength(7);
    expect(within(rows[0]).getByRole('link', { name: 'Posted ✓' })).toHaveAttribute('href', url('1234567890123456789'));
    expect(within(rows[1]).getByText('Posted ✓ (checked on page)')).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('link')).not.toBeInTheDocument();
    expect(within(rows[2]).getByText('Posted by you')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Held back a second post')).toBeInTheDocument();
    expect(within(rows[3]).getByText('X refused')).toBeInTheDocument();
    expect(within(rows[4]).getByText('Unconfirmed post')).toBeInTheDocument();
    expect(within(rows[5]).getByText('Completed, no confirmed post')).toBeInTheDocument();
    expect(within(rows[6]).getByText('Completed, post not checked')).toBeInTheDocument();
    for (const row of rows.slice(0, 5)) expect(within(row).queryByText(/^Completed, /)).not.toBeInTheDocument();
  });

  it('does not flag completed runs once the owner switched must-post off', async () => {
    vi.spyOn(api, 'botSystem').mockResolvedValue(postingSystem({ publishPolicies: [policyRow({ source: 'owner', required: false, updatedAt: SET_AT })] }));
    vi.spyOn(api, 'routineRuns').mockResolvedValue({ runs: [taskRun('run-1790200000006-baref', 'COMPLETED', POLICY_AT + 6000)] });
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    await waitFor(() => expect(paragraph(`Off: set by you on ${localDate(SET_AT)}. This routine may finish without posting.`)).toBeInTheDocument());
    expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
    expect(screen.queryByText(/^Completed, /)).not.toBeInTheDocument();
  });

  it('shows BLOCKED for a run the model itself blocked, and FAILED otherwise', async () => {
    vi.spyOn(api, 'routineRuns').mockResolvedValue({ runs: [
      taskRun('run-1790200000008-blokh', 'FAILED', POLICY_AT + 8000, { blocked: true }),
      taskRun('run-1790200000009-failj', 'FAILED', POLICY_AT + 9000),
    ] });
    render(<GrokRoutineEditor {...props({ routine: existing })} />);
    expect(await screen.findByText('BLOCKED')).toHaveClass('grok-run-status', 'blocked');
    expect(screen.getAllByText('FAILED')).toHaveLength(1);
  });
});
