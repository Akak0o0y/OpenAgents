import { BrowserSignIn } from './BrowserSignIn.js';
/**
 * What this bot is doing, what it knows, and how to ask for more.
 *
 * This used to be four raw forms - Browser, Missions, Memory and Obsidian,
 * Storage cleanup - asking a person for task contracts, run limits and note
 * keys. In the owner's first session nobody could tell what they were for.
 *
 * Work is now started by asking in chat: the bot fills in the details and asks
 * for approval on a card (see ApprovalGate.propose). This panel shows what
 * exists - background work, what the bot remembers, its browser - with only
 * the controls that belong to something that already exists (pause, stop,
 * forget), plus example requests that fill the composer. Storage cleanup is
 * installation-wide and lives in Settings → Computer.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/transport.js';
import { MessageBody } from './MessageBody.js';
import { Icon } from './ui/icons.js';

type SystemData = Awaited<ReturnType<typeof api.botSystem>>;
type Mission = SystemData['missions'][number];


const MISSION_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  ACTIVE: { label: 'Working', tone: 'ok' },
  PAUSED: { label: 'Paused', tone: 'muted' },
  WAITING: { label: 'Needs you', tone: 'warn' },
  COMPLETED: { label: 'Done', tone: 'ok' },
  STOPPED: { label: 'Stopped', tone: 'muted' },
};

const EMPTY_ACCOUNT = { site: '', username: '', password: '' };

/** How freely the bot uses forms and buttons. The words say what the person will experience. */
const AUTONOMY_OPTIONS = [
  { value: 'ask', label: 'Ask me on every site' },
  { value: 'accounts', label: 'Ask only where no account is saved' },
  { value: 'always', label: 'Never ask' },
] as const;

const finished = (mission: Mission) => mission.status === 'COMPLETED' || mission.status === 'STOPPED';

function originLabel(origin: string): string {
  if (origin === 'operator') return 'You told it';
  if (origin === 'model') return 'It noted this during a task';
  if (origin.startsWith('obsidian')) return 'Imported from Obsidian';
  return origin;
}

export function BotSystemPanel({ agentId, settings = false }: { agentId: string; settings?: boolean }) {
  const [data, setData] = useState<SystemData | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [openResult, setOpenResult] = useState<{ missionId: string; report: string } | null>(null);
  const [signInUrl, setSignInUrl] = useState('');
  const [account, setAccount] = useState(EMPTY_ACCOUNT);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    setMessage('');
    setOpenResult(null);
    setAccount(EMPTY_ACCOUNT);
    const refresh = () =>
      api
        .botSystem(agentId)
        .then((next) => {
          if (alive) setData(next);
        })
        .catch((cause) => {
          if (alive) setError(cause instanceof Error ? cause.message : String(cause));
        });
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agentId]);

  async function act(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setData(await api.botSystem(agentId));
      if (done) setMessage(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const missions = data?.missions ?? [];
  const running = missions.filter((mission) => !finished(mission));
  const memory = data?.memory ?? [];
  const browser = data?.browser;
  const openSessions = browser?.sessions.filter((session) => session.agentId === agentId) ?? [];

  return (
    <section className="oh-bot-overview" aria-label="What this bot is doing">
      {error && <p role="alert" className="oh-overview-alert">{error}</p>}
      {message && <p role="status" className="oh-overview-note">{message}</p>}

      {!settings && missions.length > 0 && <article className="oh-overview-card" aria-label="Background work">
        <header>
          <Icon name="run" size={15} motion={false} />
          <h3>Background work</h3>
          {running.length > 0 && <span className="oh-overview-count">{running.length}</span>}
        </header>
        {missions.length === 0 ? (
          <p className="oh-overview-empty">Nothing is running. Ask for ongoing work, and it will appear here with its progress.</p>
        ) : (
          <ul className="oh-mission-list">
            {missions.map((mission) => {
              const status = MISSION_STATUS[mission.status] ?? { label: mission.status, tone: 'muted' as const };
              const progress = mission.max_runs > 0 ? Math.min(100, Math.round((mission.runs / mission.max_runs) * 100)) : 0;
              const resultOpen = openResult?.missionId === mission.id;
              return (
                <li key={mission.id} className="oh-mission" data-status={mission.status}>
                  <div className="oh-mission-head">
                    <span className="oh-pill" data-tone={status.tone}>{status.label}</span>
                    <span className="oh-mission-steps">{mission.runs} of {mission.max_runs} steps</span>
                  </div>
                  <p className="oh-mission-goal">{mission.objective}</p>
                  <div className="oh-mission-bar" aria-hidden="true">
                    <i style={{ width: `${progress}%` }} />
                  </div>
                  {mission.reason && <p className="oh-mission-reason">{mission.reason}</p>}
                  {mission.status === 'WAITING' && (
                    <p className="oh-mission-reason">Check the latest result before resuming: an interrupted action may already have happened.</p>
                  )}
                  <div className="oh-mission-actions">
                    {mission.last_run_id && (
                      <button
                        type="button"
                        disabled={busy}
                        aria-expanded={resultOpen}
                        onClick={() =>
                          resultOpen
                            ? setOpenResult(null)
                            : void act(async () => setOpenResult({ missionId: mission.id, report: (await api.workResult(mission.last_run_id!)).result.report }))
                        }
                      >
                        {resultOpen ? 'Hide result' : 'Latest result'}
                      </button>
                    )}
                    {!finished(mission) && (
                      <>
                        <button
                          type="button"
                          disabled={busy || (mission.status !== 'ACTIVE' && mission.runs >= mission.max_runs)}
                          onClick={() => void act(() => api.systemAction('mission-state', { id: mission.id, state: mission.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }))}
                        >
                          {mission.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={() => void act(() => api.systemAction('mission-state', { id: mission.id, state: 'STOPPED' }), 'Stopped. Its results so far are kept.')}
                        >
                          Stop
                        </button>
                      </>
                    )}
                  </div>
                  {resultOpen && (
                    <div className="oh-mission-result">
                      <MessageBody content={openResult.report} markdown />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </article>}

      {settings && memory.length > 0 && <article className="oh-overview-card" aria-label="What it remembers">
        <header>
          <Icon name="data" size={15} motion={false} />
          <h3>What it remembers</h3>
          {memory.length > 0 && <span className="oh-overview-count">{memory.length}</span>}
        </header>
        {memory.length === 0 ? (
          <p className="oh-overview-empty">Nothing yet. Tell it something to remember, and it will use it in later work.</p>
        ) : (
          <ul className="oh-memory-list">
            {memory.map((note) => (
              <li key={note.key} className="oh-memory">
                <div>
                  <p>{note.text}</p>
                  <small>{originLabel(note.origin)}</small>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Forget: ${note.text.slice(0, 60)}`}
                  onClick={() => void act(() => api.systemAction('memory-delete', { agentId, key: note.key }), 'Forgotten.')}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </article>}

      {settings && browser && (
        <article className="oh-overview-card" aria-label="Browser">
          <header>
            <Icon name="preview" size={15} motion={false} />
            <h3>Connected websites</h3>
          </header>
          <p>Ask in chat when a task needs a website account.</p>
          {browser.persistenceErrors?.[agentId] && <p role="alert">{browser.persistenceErrors[agentId]}</p>}
          <ul className="oh-memory-list">{(browser.connections ?? []).map(connection => <li key={connection.site}><strong>{connection.site}</strong><small>{connection.verified ? 'Verified sign-in' : 'Sign-in saved · access checked when used'}</small></li>)}</ul>
          <details><summary>Connect a website</summary>
            <input aria-label="Website to sign in to" placeholder="Website, e.g. github.com" value={signInUrl} onChange={e => setSignInUrl(e.target.value)} />
            {signInUrl.trim() && <BrowserSignIn agentId={agentId} site={signInUrl.trim()} />}
          </details>
          <details className="oh-browser-advanced"><summary>Permissions and saved credentials</summary>
          {browser.desktop ? <p>Sign out inside this bot’s Chrome to remove a website account.</p> : <button type="button" disabled={busy || openSessions.length > 0} onClick={() => void act(() => api.systemAction('browser-disconnect', { agentId }), 'Saved sign-ins removed.')}>Forget saved sign-ins</button>}
          {browser.autonomy && (
            <>
              <label className="oh-browser-autonomy">
                <span>Forms and buttons</span>
                <select
                  value={browser.autonomy}
                  disabled={busy}
                  aria-label="When it may use forms and buttons"
                  onChange={(event) => void act(() => api.systemAction('browser-autonomy', { agentId, autonomy: event.target.value }), 'Saved.')}
                >
                  {AUTONOMY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div className="oh-accounts">
                <h4>Accounts it signs in with</h4>
                {(browser.accounts ?? []).length === 0 ? (
                  <p className="oh-overview-empty">
                    None yet. When a task needs one, the bot asks in chat, and opens a secure sign-in window.
                  </p>
                ) : (
                  <ul className="oh-memory-list">
                    {(browser.accounts ?? []).map((saved) => (
                      <li key={saved.id} className="oh-memory">
                        <div>
                          <p>{saved.site}</p>
                          {saved.label !== saved.site && <small>{saved.label}</small>}
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Remove the account for ${saved.site}`}
                          onClick={() => void act(() => api.systemAction('browser-account-delete', { agentId, id: saved.id }), 'Account removed.')}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <details className="oh-basic-auth-details" style={{ marginTop: '10px' }}>
                  <summary style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--gk-muted)' }}>Saved username and password</summary>
                  <form
                    className="oh-signin-row oh-account-form"
                    style={{ marginTop: '6px' }}
                    aria-label="Add an account"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!account.site.trim() || !account.username.trim() || !account.password) return;
                      void act(async () => {
                        await api.systemAction('browser-account', { agentId, ...account });
                        setAccount(EMPTY_ACCOUNT);
                      }, 'Account saved. The bot can sign in there now.');
                    }}
                  >
                    <input type="text" inputMode="url" autoComplete="off" value={account.site} placeholder="Website, e.g. github.com" aria-label="Account website"
                      onChange={(event) => setAccount({ ...account, site: event.target.value })} />
                    <input type="text" autoComplete="off" value={account.username} placeholder="Username or email" aria-label="Account username"
                      onChange={(event) => setAccount({ ...account, username: event.target.value })} />
                    <input type="password" autoComplete="new-password" value={account.password} placeholder="Password" aria-label="Account password"
                      onChange={(event) => setAccount({ ...account, password: event.target.value })} />
                    <button type="submit" disabled={busy || !account.site.trim() || !account.username.trim() || !account.password}>Save account</button>
                  </form>
                </details>
              </div>
            </>
          )}
          </details>
        </article>
      )}

    </section>
  );
}
