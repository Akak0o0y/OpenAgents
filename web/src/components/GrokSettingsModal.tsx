/**
 * App settings.
 *
 * Only settings that correspond to something this runtime actually does. The
 * reference's account, billing, security-key, microphone and auto-update rows
 * have no counterpart in OpenAgents, so they are either absent or present and
 * plainly marked unavailable - never present and inert.
 *
 * What IS real here:
 *   General   theme (applied immediately), operator display name, the timezone
 *             new routines are created in.
 *   Computer  the executor the daemon is running and whether its sandbox is
 *             reachable, both read from the daemon.
 *   Providers the model gateways bots route through (GrokProvidersSection).
 *   Usage     reconciled model spend per bot, from /api/usage.
 *   Updates   the daemon's own version and health.
 *
 * Layout: a rail of sections with a highlight that slides to the open one, and
 * a pane whose content arrives group by group. See settings-design.css.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'framer-motion';
import { Modal } from './ui/Overlay.js';
import { api, type UsageSummaryBody } from '../lib/transport.js';
import { Icon, type IconName } from './ui/icons.js';
import { NumberTicker } from './ui/NumberTicker.js';
import { formatAxis, formatCompact, formatCount, formatUsd, UI_LOCALE } from '../lib/numbers.js';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Chart, ChartLegend, ChartTooltip, type ChartConfig } from './ui/Chart.js';
import { type ThemePreference, type CodeThemePreference, CODE_THEME_OPTIONS } from '../lib/preferences.js';
import { useDesktopSettings } from '../lib/desktop.js';
import { RingLoader } from './ui/Uiverse.js';
import { FormError } from './ui/FormError.js';
import { IconButton } from './ui/Button.js';
import { ProvidersSection } from './GrokProvidersSection.js';
import { Input } from '@/registry/default/ui/input.js';
import {
  Meter,
  SettingsBadge,
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSwitch,
  StatTile,
} from './SettingsKit.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/registry/default/ui/table.js';

export type SettingsSection = 'general' | 'computer' | 'providers' | 'usage' | 'updates';

interface GrokSettingsModalProps {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  theme: ThemePreference;
  onTheme: (theme: ThemePreference) => void;
  codeTheme?: CodeThemePreference;
  onCodeTheme?: (theme: CodeThemePreference) => void;
  accountName: string;
  onAccountName: (name: string) => void;
  routineTimezone: string;
  onRoutineTimezone: (timezone: string) => void;
  executor: string | null;
  connection: 'connecting' | 'open' | 'closed';
  /** The daemon's own explanation when a bot's workspace is unreachable. */
  sandboxReason: string | null;
}

const SECTIONS: Array<{ id: SettingsSection; label: string; hint: string; icon: IconName; description: string }> = [
  { id: 'general', label: 'General', hint: 'Profile, theme and bots', icon: 'settings', description: 'Make OpenAgents feel like your workspace.' },
  { id: 'computer', label: 'Computer', hint: 'Daemon and sandbox', icon: 'computer', description: 'Where your bots run, and whether it is reachable.' },
  { id: 'providers', label: 'Providers', hint: 'Model gateways', icon: 'link', description: 'Connect the intelligence behind your bots.' },
  { id: 'usage', label: 'Usage', hint: 'Spend and tokens', icon: 'usage', description: 'What your bots and tools have used, against which limits.' },
  { id: 'updates', label: 'Updates', hint: 'Version and health', icon: 'update', description: 'The daemon you are connected to, and how to update it.' },
];

const THEMES: Array<{ id: ThemePreference; label: string }> = [
  { id: 'system', label: 'Follow system' },
  { id: 'light', label: 'OpenAgents Light' },
  { id: 'dark', label: 'OpenAgents Dark' },
];

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function GrokSettingsModal({
  section,
  onSection,
  onClose,
  theme,
  onTheme,
  codeTheme,
  onCodeTheme,
  accountName,
  onAccountName,
  routineTimezone,
  onRoutineTimezone,
  executor,
  connection,
  sandboxReason,
}: GrokSettingsModalProps) {
  const current = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];
  const connectionTone = connection === 'open' ? 'ok' : connection === 'connecting' ? 'warn' : 'danger';
  const connectionLabel = connection === 'open' ? 'Daemon connected' : connection === 'connecting' ? 'Connecting' : 'Daemon offline';

  return (
    <Modal label="Settings" className="grok-settings-modal oh-settings" onClose={onClose}>
      <MotionConfig reducedMotion="user">
        <nav className="oh-settings-nav" aria-label="Settings sections">
          <div className="oh-settings-brand">
            <span className="oh-settings-brand-mark" aria-hidden="true">
              <img src="/openhours-icon.png" width={36} height={36} alt="" />
            </span>
            <div>
              <strong>Settings</strong>
              <small>OpenAgents workspace</small>
            </div>
          </div>
          <LayoutGroup id="oh-settings-tabs">
            <div className="oh-settings-tabs">
              {SECTIONS.map((entry) => {
                const on = entry.id === section;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`oh-settings-tab ${on ? 'is-on' : ''}`}
                    aria-current={on ? 'page' : undefined}
                    onClick={() => onSection(entry.id)}
                  >
                    {on && (
                      <motion.span
                        layoutId="oh-settings-tab-pill"
                        className="oh-settings-tab-pill"
                        transition={{ type: 'spring', stiffness: 480, damping: 40 }}
                      />
                    )}
                    <span className="oh-settings-tab-icon" aria-hidden="true">
                      <Icon name={entry.icon} size={15} />
                    </span>
                    <span className="oh-settings-tab-text">
                      <strong>{entry.label}</strong>
                      <small>{entry.hint}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
          <div className="oh-settings-status" data-tone={connectionTone}>
            <i aria-hidden="true" />
            <div>
              <strong>{connectionLabel}</strong>
              <small>{executor ? `${executor} executor` : 'Executor not reported'}</small>
            </div>
          </div>
        </nav>

        <section className="oh-settings-pane" aria-label={current.label}>
          <header className="oh-settings-head">
            <span className="oh-settings-head-icon" aria-hidden="true">
              <Icon name={current.icon} size={20} motion={false} />
            </span>
            <div className="oh-settings-head-text">
              <h2>{current.label}</h2>
              <p>{current.description}</p>
            </div>
            <IconButton onClick={onClose} aria-label="Close settings" title="Close">
              <Icon name="close" />
            </IconButton>
          </header>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              className="oh-settings-body"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
            >
              {section === 'general' && (
                <GeneralSection
                  theme={theme}
                  onTheme={onTheme}
                  codeTheme={codeTheme}
                  onCodeTheme={onCodeTheme}
                  accountName={accountName}
                  onAccountName={onAccountName}
                  routineTimezone={routineTimezone}
                  onRoutineTimezone={onRoutineTimezone}
                />
              )}
              {section === 'computer' && (
                <ComputerSection executor={executor} connection={connection} sandboxReason={sandboxReason} />
              )}
              {section === 'providers' && <ProvidersSection />}
              {section === 'usage' && <UsageSection />}
              {section === 'updates' && <UpdatesSection />}
            </motion.div>
          </AnimatePresence>
        </section>
      </MotionConfig>
    </Modal>
  );
}

function GeneralSection({
  theme,
  onTheme,
  codeTheme,
  onCodeTheme,
  accountName,
  onAccountName,
  routineTimezone,
  onRoutineTimezone,
}: Pick<
  GrokSettingsModalProps,
  'theme' | 'onTheme' | 'codeTheme' | 'onCodeTheme' | 'accountName' | 'onAccountName' | 'routineTimezone' | 'onRoutineTimezone'
>) {
  const zone = deviceTimezone();
  const desktop = useDesktopSettings();
  return (
    <>
      <SettingsGroup title="Profile" description="OpenAgents has no accounts: the daemon runs on your machine under your own provider credentials.">
        <div className="oh-set-row">
          <span className="oh-profile-avatar" aria-hidden="true">
            {(accountName.trim() || 'O').slice(0, 1).toUpperCase()}
          </span>
          <div className="oh-set-row-text">
            <label className="oh-set-row-label" htmlFor="operator-name">
              Display name
            </label>
            <p className="oh-set-row-hint">A label for this browser only. There is nothing to sign out of.</p>
          </div>
          <div className="oh-set-row-control">
            <Input
              id="operator-name"
              className="grok-form-input"
              value={accountName}
              maxLength={40}
              onChange={(event) => onAccountName(event.target.value)}
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Appearance" description="Warm paper, quiet surfaces, and the colors of OpenAgents.">
        <div className="oh-theme-options" role="radiogroup" aria-label="Theme">
          {THEMES.map((option) => {
            const on = theme === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={on}
                className="oh-theme-option"
                onClick={() => onTheme(option.id)}
              >
                <span className="oh-theme-preview" data-preview={option.id} aria-hidden="true">
                  <i />
                  <i />
                </span>
                <span className="oh-theme-label">
                  {option.label}
                  <span className="oh-theme-check" aria-hidden="true">
                    {on && <Icon name="done" size={11} motion={false} />}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <SettingsRow icon="edit" label="Code editor theme" hint="OpenAgents follows the app. Choose another palette just for code.">
          <select
            className="grok-form-input oh-code-theme-select"
            value={codeTheme ?? 'openhours'}
            onChange={(event) => onCodeTheme?.(event.target.value as CodeThemePreference)}
            aria-label="Code editor theme"
          >
            {CODE_THEME_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </SettingsRow>
        <div className={`grok-code-editor oh-editor-theme-sample theme-${codeTheme ?? 'openhours'}`} aria-label="Editor theme preview">
          <div className="grok-code-gutter" aria-hidden="true">1<br />2<br />3</div>
          <pre>{'// Made with OpenAgents\nconst greeting = "Hello, world";\nconsole.log(greeting);'}</pre>
        </div>
        <SettingsRow icon="grid" label="Language" hint="This build ships English strings only.">
          <SettingsBadge>English</SettingsBadge>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Bots" description="Defaults for new routines, and how requests are reviewed.">
        <SettingsRow
          icon="schedule"
          label="Routine timezone"
          htmlFor="tz-input"
          hint="New routines are created in this IANA zone and follow its daylight-saving rules. Existing routines keep theirs."
        >
          <Input
            id="tz-input"
            className="grok-form-input"
            value={routineTimezone}
            onChange={(event) => onRoutineTimezone(event.target.value)}
            placeholder="Europe/London"
          />
          {routineTimezone !== zone && (
            <button type="button" className="oh-set-btn ghost" title={`Use ${zone}`} onClick={() => onRoutineTimezone(zone)}>
              Use this device
            </button>
          )}
        </SettingsRow>
        <SettingsRow
          icon="ok"
          label="Auto-review"
          hint={
            <>
              Set per bot with <code>requiresApproval</code> in openhours.config.json. Pending requests appear as cards in
              the conversation.
            </>
          }
        >
          <SettingsBadge icon="file">Config file</SettingsBadge>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="System">
        {/* Desktop app only. In a browser there is no tray, no sign-in start
            and nothing to launch Docker with, so the rows are absent rather
            than present and inert. */}
        {desktop.settings && (
          <>
            <SettingsRow
              icon="schedule"
              label="Keep running in the background"
              hint="Closing the window leaves OpenAgents in the tray, so routines keep running. Quit from the tray icon."
            >
              <SettingsSwitch
                checked={desktop.settings.keepRunningInBackground}
                label="Keep running in the background"
                onChange={(on) => desktop.update({ keepRunningInBackground: on })}
              />
            </SettingsRow>
            <SettingsRow
              icon="power"
              label="Start when you sign in"
              hint={
                desktop.settings.canOpenAtLogin
                  ? 'Opens quietly in the tray when you sign in, so scheduled routines run without you opening the app.'
                  : 'Available in the installed app on Windows and macOS.'
              }
            >
              <SettingsSwitch
                checked={desktop.settings.openAtLogin}
                disabled={!desktop.settings.canOpenAtLogin}
                label="Start when you sign in"
                onChange={(on) => desktop.update({ openAtLogin: on })}
              />
            </SettingsRow>
            <SettingsRow
              icon="computer"
              label="Set up the secure workspace automatically"
              hint="OpenAgents installs missing Windows components, Docker and the managed browser, then starts them. Windows may ask for permission or a restart."
            >
              <SettingsSwitch
                checked={desktop.settings.startDockerAutomatically}
                label="Set up the secure workspace automatically"
                onChange={(on) => desktop.update({ startDockerAutomatically: on })}
              />
            </SettingsRow>
          </>
        )}
        <SettingsRow icon="dictate" label="Microphone" hint="Dictation uses your browser's speech recognition. OpenAgents has no microphone setting of its own.">
          <SettingsBadge>Browser</SettingsBadge>
        </SettingsRow>
        <SettingsRow icon="power" label="Hardware acceleration" hint="Controlled by your browser, not by OpenAgents.">
          <SettingsBadge>Browser</SettingsBadge>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function ComputerSection({
  executor,
  connection,
  sandboxReason,
}: Pick<GrokSettingsModalProps, 'executor' | 'connection' | 'sandboxReason'>) {
  return (
    <>
      <div className="oh-stat-grid">
        <StatTile
          icon="power"
          label="Daemon"
          value={connection === 'open' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Offline'}
          tone={connection === 'open' ? 'ok' : connection === 'connecting' ? 'warn' : 'danger'}
          detail="The local process your bots run in."
        />
        <StatTile
          icon="computer"
          label="Executor"
          value={executor ?? 'Unknown'}
          tone={executor ? 'info' : 'muted'}
          detail="Read from openhours.config.json at boot."
        />
        <StatTile
          icon={sandboxReason ? 'warn' : 'ok'}
          label="Sandbox"
          value={sandboxReason ? 'Unreachable' : 'No problems'}
          tone={sandboxReason ? 'warn' : 'ok'}
          detail={sandboxReason ?? 'No workspace problem reported.'}
        />
      </div>

      <SettingsGroup title="Bot computers">
        <SettingsNote icon="computer">
          A bot's computer is the container workspace its current run owns. It exists only while that run is executing;
          when a run finishes the volume is reaped, which is why a finished bot reports no computer.
        </SettingsNote>
        <SettingsRow icon="settings" label="Execution policy" hint="Read from openhours.config.json at boot. It cannot be changed from this window.">
          <SettingsBadge icon="file">Config file</SettingsBadge>
        </SettingsRow>
      </SettingsGroup>

      <StorageCleanup />
    </>
  );
}

/**
 * Installation-wide cleanup. It used to sit in every bot's panel, but it was
 * never a bot feature: it removes old files for every run on this computer.
 */
export function StorageCleanup() {
  const [days, setDays] = useState(30);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const plural = (count: number) => `${count} run${count === 1 ? '' : 's'}`;

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.systemAction('retention', { days, dryRun });
      if (dryRun) {
        setPreview(Array.isArray(result?.candidates) ? result.candidates : []);
      } else {
        const failures: Array<{ error: string }> = Array.isArray(result?.errors) ? result.errors : [];
        setPreview(null);
        setMessage(`Cleaned ${plural(Array.isArray(result?.cleaned) ? result.cleaned.length : 0)}.${failures.length ? ` ${plural(failures.length)} could not be cleaned: ${failures.map((failure) => failure.error).join(' ')}` : ''}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title="Storage"
      description="Remove old run files, temporary workspaces and detailed event logs. Results, costs, missions, memory and records of external actions are always kept."
    >
      <SettingsRow icon="remove" label="Runs older than" htmlFor="retention-days" hint="Preview first. Nothing is deleted until you confirm.">
        <Input
          id="retention-days"
          type="number"
          min={1}
          max={3650}
          className="grok-form-input oh-days-input"
          value={days}
          onChange={(event) => {
            setDays(Math.max(1, Math.min(3650, Number(event.target.value) || 1)));
            setPreview(null);
          }}
        />
        <button type="button" className="oh-set-btn" disabled={busy} onClick={() => void run(true)}>
          Preview
        </button>
      </SettingsRow>
      {preview && (
        <div className="oh-set-row">
          <p className="oh-set-row-hint">
            {preview.length === 0 ? 'Nothing is old enough to clean.' : `${plural(preview.length)} can be cleaned (up to 100 at a time).`}
          </p>
          {preview.length > 0 && (
            <button type="button" className="oh-set-btn danger" disabled={busy} onClick={() => void run(false)}>
              Clean {plural(preview.length)}
            </button>
          )}
        </div>
      )}
      {message && (
        <p className="oh-set-row-hint" role="status">
          {message}
        </p>
      )}
      {error && <FormError>{error}</FormError>}
    </SettingsGroup>
  );
}

function UsageSection() {
  const [usage, setUsage] = useState<UsageSummaryBody | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .usage()
      .then((body) => {
        if (!cancelled) setUsage(body);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Usage is unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <SettingsNote icon="busy">Reading usage…</SettingsNote>;
  if (error) return <FormError>{error}</FormError>;
  if (!usage) return null;

  const capPercent = usage.totalBudgetCapUsd > 0 ? (usage.totalSpentUsd / usage.totalBudgetCapUsd) * 100 : 0;

  return (
    <>
      <SettingsGroup title="OpenAgents spend" description={usage.billing.reason}>
        <div className="oh-usage-hero">
          <div className="oh-usage-hero-top">
            <div>
              <strong>
                $<NumberTicker value={usage.totalSpentUsd} format={formatUsd} />
              </strong>
              <small>
                {' '}
                across <NumberTicker value={usage.totalRunCount} format={formatCount} /> run
                {usage.totalRunCount === 1 ? '' : 's'}
              </small>
            </div>
            <small>of ${usage.totalBudgetCapUsd.toFixed(2)} in caps</small>
          </div>
          <Meter
            value={usage.totalSpentUsd}
            max={usage.totalBudgetCapUsd}
            label="Spend against configured caps"
            tone={capPercent > 85 ? 'warn' : 'ok'}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title="By bot">
        {usage.agents.length === 0 && <SettingsNote icon="bot">No bots yet.</SettingsNote>}
        {usage.agents.map((agent) => (
          <div key={agent.agentId} className="oh-usage-bot">
            <div>
              <strong>{agent.name}</strong>
              <small>
                {agent.runCount} run{agent.runCount === 1 ? '' : 's'}
                {agent.failedRunCount > 0 && ` · ${agent.failedRunCount} failed`}
                {(agent.unpricedCallCount ?? 0) > 0 &&
                  ` · ${agent.unpricedCallCount} gateway call${agent.unpricedCallCount === 1 ? '' : 's'} at unknown cost`}
              </small>
            </div>
            <div className="oh-meter-row">
              <div>
                <span>${agent.spentUsd.toFixed(4)}</span>
                <strong>of ${agent.budgetCapUsd.toFixed(2)}</strong>
              </div>
              <Meter
                value={agent.spentUsd}
                max={agent.budgetCapUsd}
                label={`${agent.name} spend against its cap`}
                tone={agent.budgetCapUsd > 0 && agent.spentUsd / agent.budgetCapUsd > 0.85 ? 'warn' : 'ok'}
              />
            </div>
          </div>
        ))}
      </SettingsGroup>

      {(usage.connections ?? []).length > 0 && (
        <SettingsGroup title="Gateway pools" description="What OpenAgents has sent through each provider connection in the last 24 hours.">
          {(usage.connections ?? []).map((pool) => {
            const quota = pool.gatewayQuota;
            const hasQuota = quota?.available && typeof quota.totalBudget === 'number';
            const totalBudget = quota?.totalBudget ?? 0;
            const totalUsed = quota?.totalUsed ?? 0;
            const remaining = Math.max(0, totalBudget - totalUsed);
            const models = quota?.models ?? [];
            return (
              <div key={pool.connectionId}>
                <div className="oh-usage-bot">
                  <div>
                    <strong>{pool.name}</strong>
                    <small>
                      {formatCount(pool.tokensLast24h)} of {formatCount(pool.tokensPerDay)} tokens in 24 hours
                    </small>
                  </div>
                  <div className="oh-meter-row">
                    <div>
                      <span>Requests</span>
                      <strong>
                        {pool.requestsLast24h} of {pool.requestsPerDay}
                      </strong>
                    </div>
                    <Meter value={pool.requestsLast24h} max={pool.requestsPerDay} label={`${pool.name} requests in 24 hours`} />
                  </div>
                </div>
                {hasQuota ? (
                  <>
                    <div className="oh-usage-hero">
                      <div className="oh-meter-row">
                        <div>
                          <span>Monthly token budget</span>
                          <strong>
                            {(remaining / 1_000_000).toFixed(1)}M of {(totalBudget / 1_000_000).toFixed(1)}M remaining
                          </strong>
                        </div>
                        <Meter value={totalUsed} max={totalBudget} label="Gateway token budget usage" />
                      </div>
                    </div>
                    {models.length > 0 && (
                      <div className="oh-usage-models">
                        {models.map((model) => (
                          <div key={model.id} className="oh-usage-model">
                            <span>{model.displayName || model.id}</span>
                            <span>
                              {model.totalUsed ? `${(model.totalUsed / 1_000_000).toFixed(1)}M` : '0'} /{' '}
                              {model.totalBudget ? `${(model.totalBudget / 1_000_000).toFixed(1)}M/mo` : 'Free pool'}
                              {model.rpmLimit ? ` · ${model.rpmLimit} RPM` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  quota?.reason && <SettingsNote icon="warn">{quota.reason}</SettingsNote>
                )}
              </div>
            );
          })}
        </SettingsGroup>
      )}

      <LocalUsage local={usage.local} />
    </>
  );
}

/**
 * The three kinds of token, and what each costs.
 *
 * Ordered by how much they usually are rather than alphabetically: cached reads
 * dominate a coding session by an order of magnitude, so they sit at the bottom
 * of the stack where the eye starts.
 */
const TOKEN_SERIES: ChartConfig = {
  cacheRead: { label: 'Cached', color: 'var(--gk-text-muted)' },
  input: { label: 'Input', color: 'var(--gk-focus)' },
  output: { label: 'Output', color: 'var(--gk-ok)' },
};

/** "9 Sep" - a full ISO date on every tick is unreadable at this width. */
function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString(UI_LOCALE, { day: 'numeric', month: 'short' });
}

/** The tooltip has room for the whole thing. */
function longDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString(UI_LOCALE, { weekday: 'short', day: 'numeric', month: 'long' });
}

const CHART_DAYS = 14;

/** The last n local calendar dates, oldest first, as YYYY-MM-DD. */
function lastDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${d.getFullYear()}-${month}-${day}`);
  }
  return out;
}

/**
 * Usage from the other coding tools on this machine.
 *
 * These numbers are TOKENS, not money, and the distinction is the whole point.
 * A token count is a fact the provider recorded in its own log; converting it
 * to a cost needs a price list that changes without warning, and inventing one
 * would put a confident dollar figure on screen that nobody could stand behind.
 * The daemon's own spend, shown above, is real money because the provider
 * returned it.
 */
function LocalUsage({ local }: { local: UsageSummaryBody['local'] }) {
  if (local === null) {
    return (
      <SettingsGroup title="Other coding tools">
        <div className="oh-set-note">
          {/* Uiverse (Shoh2008, MIT). The cold pass over a few hundred megabytes
              of logs is the longest wait in the app. */}
          <RingLoader label="Reading session logs" />
          <p>
            Reading this machine&rsquo;s session logs. The first pass reads every log in the window; later ones read only
            what was added.
          </p>
        </div>
      </SettingsGroup>
    );
  }

  if (local.providers.length === 0) {
    return (
      <SettingsGroup title="Other coding tools">
        <SettingsNote>No session logs found from other coding tools in the last {local.windowDays} days.</SettingsNote>
        <UnavailableList items={local.unavailable} />
      </SettingsGroup>
    );
  }

  return (
    <>
      {local.providers.map((provider) => {
        // The chart is scaled to the busiest day, so the shape of the fortnight
        // is readable whether the numbers are millions or billions.
        const peak = Math.max(1, ...provider.days.map((d) => d.totals.total));
        // Every day in the window, including the ones with nothing in them. A
        // chart of only the ACTIVE days stretches two busy days across the full
        // width and reads as constant heavy use - the gaps are the information.
        const recent = lastDays(CHART_DAYS).map((date) => {
          const day = provider.days.find((d) => d.date === date);
          return {
            date,
            input: day?.totals.input ?? 0,
            output: day?.totals.output ?? 0,
            cacheRead: day?.totals.cacheRead ?? 0,
            total: day?.totals.total ?? 0,
          };
        });
        const models = Object.entries(provider.models).sort((a, b) => b[1].total - a[1].total);

        return (
          <SettingsGroup
            key={provider.id}
            title={provider.label}
            description={
              <>
                <NumberTicker value={provider.totals.total} format={formatCompact} /> tokens · {provider.sessionCount} session
                {provider.sessionCount === 1 ? '' : 's'} · last {CHART_DAYS} days
              </>
            }
          >
            <div className="oh-usage-chart">
              <Chart
                config={TOKEN_SERIES}
                height={160}
                label={`Daily token use for ${provider.label} over the last ${CHART_DAYS} days, split by input, output and cached, peaking at ${formatCount(peak)} tokens on one day`}
              >
                <BarChart data={recent} margin={{ top: 10, right: 0, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--gk-line)" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={16}
                    tick={{ fill: 'var(--gk-text-muted)', fontSize: 10 }}
                    tickFormatter={shortDate}
                  />
                  <YAxis
                    width={44}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: 'var(--gk-text-muted)', fontSize: 10 }}
                    tickFormatter={formatAxis}
                  />
                  <ChartTooltip config={TOKEN_SERIES} format={(v) => `${formatCount(v)} tokens`} formatLabel={longDate} />
                  {/* Stacked: the three kinds are parts of one day's use, and a
                      grouped chart would hide the smaller two under cached reads. */}
                  <Bar dataKey="cacheRead" stackId="t" fill="var(--color-cacheRead)" />
                  <Bar dataKey="input" stackId="t" fill="var(--color-input)" />
                  <Bar dataKey="output" stackId="t" fill="var(--color-output)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </Chart>
              <ChartLegend config={TOKEN_SERIES} />
            </div>

            {/* A real table: four measures per model, which a screen reader can
                announce by column instead of reading four numbers in a row. */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cached</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map(([model, totals]) => (
                  <TableRow key={model}>
                    <TableCell className="font-mono">{model}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCompact(totals.input)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCompact(totals.output)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {totals.cacheRead > 0 ? formatCompact(totals.cacheRead) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatCompact(totals.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <SettingsNote icon="file">
              Read from <code>{provider.root}</code>. Token counts only — this daemon has no price list, so it does not put
              a dollar figure on them.
            </SettingsNote>
          </SettingsGroup>
        );
      })}

      {(local.unavailable.length > 0 || local.truncated) && (
        <SettingsGroup title="Not counted here">
          <UnavailableList items={local.unavailable} />
          {local.truncated && (
            <SettingsNote icon="warn">
              The scan stopped at its size limit, so these totals are partial. They will fill in on the next pass.
            </SettingsNote>
          )}
        </SettingsGroup>
      )}
    </>
  );
}

/** What could not be read, and why. Never silently omitted. */
function UnavailableList({ items }: { items: Array<{ id: string; label: string; reason: string }> }) {
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => (
        <SettingsRow key={item.id} icon="hide" label={item.label} hint={item.reason}>
          <SettingsBadge>Not counted</SettingsBadge>
        </SettingsRow>
      ))}
    </>
  );
}

function UpdatesSection() {
  const [health, setHealth] = useState<{ status: string; service: string; port: number; buildId?: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((body) => {
        if (!cancelled) setHealth(body);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'The daemon did not answer.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="oh-stat-grid is-two">
        <StatTile
          icon="power"
          label="Daemon"
          value={error ? 'Not answering' : health ? health.status : 'Checking…'}
          tone={error ? 'danger' : health ? 'ok' : 'muted'}
          detail={error || (health ? `${health.service} on port ${health.port}` : 'Asking the daemon for its health.')}
        />
        <StatTile
          icon="update"
          label="Build"
          value={health?.buildId ?? (error ? 'Unknown' : 'Checking…')}
          tone={health?.buildId ? 'ok' : 'muted'}
          detail={
            health?.buildId
              ? 'Identifies the code actually running. Two downloads with the same version number differ here when their code differs.'
              : 'The running build is identified by its code, not only by its version number.'
          }
        />
      </div>

      <SettingsGroup title="Maintenance">
        <SettingsRow icon="update" label="Automatic updates" hint="OpenAgents has no updater. Pull the repository and restart the daemon.">
          <SettingsBadge>Not available</SettingsBadge>
        </SettingsRow>
        <SettingsRow
          icon="refresh"
          label="Reset bot computer"
          hint="Workspaces are reaped automatically when a run ends, and a manual reset would destroy a running task's files."
        >
          <SettingsBadge>Not available</SettingsBadge>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
