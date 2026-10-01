import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/transport.js';
import { BotDesktopScreen } from './BotDesktopScreen.js';

type Props = { agentId: string; site: string; approvalId?: string; disabled?: boolean; onSaved?: () => void };

/** Sign-in is owned by the bot. No extension or personal browser is involved. */
export function BrowserSignIn({ agentId, site, approvalId, disabled = false, onSaved }: Props) {
  const [opened, setOpened] = useState(false);
  const [botDesktop, setBotDesktop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const waitingForSetup = useRef(false);
  const login = useRef<{ agentId: string; runId?: string }>({ agentId });
  const acting = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  async function closeLogin(owner: { agentId: string; runId?: string }) {
    if (owner.runId) {
      await api.systemAction('browser-login-cancel', { agentId: owner.agentId, runId: owner.runId });
      owner.runId = undefined;
    }
  }
  function closeAbandoned(owner: { agentId: string; runId?: string }) {
    void closeLogin(owner).catch(() => console.warn('Abandoned sign-in cleanup failed; the daemon deadline remains active.'));
  }
  async function openBrowser(current: number) {
    const owner = login.current;
    const result = await api.systemAction('browser-login', { agentId, url: /^https?:\/\//i.test(site) ? site : `https://${site}`, approvalId });
    if (current !== generation.current) { if (result.runId) closeAbandoned({ agentId, runId: result.runId }); return; }
    if (result.preparing) {
      waitingForSetup.current = true;
      setBotDesktop(true); setMessage('Preparing your bot’s desktop and regular Chrome. First setup may take several minutes.');
      return;
    }
    owner.runId = result.runId;
    setOpened(!!result.opened); if (result.desktop) setBotDesktop(true); setMessage(result.warning ?? '');
  }
  useEffect(() => {
    let alive = true;
    const owner = { agentId, runId: undefined as string | undefined };
    login.current = owner;
    generation.current++; waitingForSetup.current = false; acting.current = false; setCancelling(false); setOpened(false); setBotDesktop(false); setBusy(false); setMessage(''); setError('');
    const refresh = async () => {
      const current = generation.current;
      try {
        const result = await api.botSystem(agentId);
        if (!alive || current !== generation.current) return;
        if (!acting.current) {
          const session = result.browser?.sessions.find(s => s.login);
          owner.runId = session?.runId;
          setOpened(!!session); setBotDesktop(!!result.browser?.desktop);
        }
        if (waitingForSetup.current) {
          const setup = result.browser?.desktopSetup;
          if (setup?.state === 'error') {
            waitingForSetup.current = false; setBusy(false); setMessage(''); setError(setup.message);
          } else if (setup?.state === 'ready') {
            waitingForSetup.current = false;
            setMessage('Opening your bot’s Chrome…');
            try { await openBrowser(current); }
            catch (cause) { if (alive && current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
            finally { if (alive && current === generation.current && !waitingForSetup.current) { acting.current = false; setBusy(false); } }
          } else if (setup?.message) setMessage(setup.message);
        }
      } catch { /* Explicit actions report errors; polling does not erase them. */ }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { alive = false; generation.current++; waitingForSetup.current = false; clearInterval(timer); closeAbandoned(owner); };
  }, [agentId, site, approvalId]);
  async function act() {
    const current = ++generation.current;
    acting.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      if (opened) {
        const result = await api.systemAction('browser-login-finish', { agentId, approvalId, ...(login.current.runId ? { runId: login.current.runId } : {}) });
        if (current !== generation.current) return;
        login.current.runId = undefined;
        setOpened(false); setMessage(result.verified ? 'Sign-in verified.' : 'Sign-in saved. The bot will check access when it uses this site.'); onSaved?.();
      } else {
        await openBrowser(current);
      }
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current === generation.current && !waitingForSetup.current) { acting.current = false; setBusy(false); } }
  }
  async function cancel() {
    const current = ++generation.current;
    waitingForSetup.current = false; acting.current = true; setCancelling(true); setBusy(true); setError('');
    try {
      await closeLogin(login.current);
      if (current !== generation.current) return;
      setOpened(false); setMessage('Sign-in cancelled. Shared desktop software preparation may continue.');
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current === generation.current) { acting.current = false; setBusy(false); setCancelling(false); } }
  }
  return <div className="oh-signin-flow">
    <p>{opened ? 'Complete sign-in in your bot’s browser, including any verification. Then save it here.' : `Sign in to ${site} in your bot’s separate browser. Passwords and verification codes stay out of chat.`}</p>
    {botDesktop && <p>The bot uses its own Linux desktop and regular Chrome—not your personal browser.</p>}
    <button type="button" disabled={disabled || busy || !site.trim()} onClick={() => void act()}>{busy ? 'Please wait…' : opened ? 'Save sign-in' : 'Sign in securely'}</button>
    {(busy || opened) && <button type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? 'Cancelling…' : 'Cancel sign-in'}</button>}
    {botDesktop && opened && <BotDesktopScreen agentId={agentId} />}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </div>;
}
