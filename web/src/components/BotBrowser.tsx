import { useEffect, useState } from 'react';
import { api, type BrowserLiveState } from '../lib/transport.js';
import { GrokBotComputerLoop } from './GrokBotComputerLoop.js';
import { BotDesktopScreen } from './BotDesktopScreen.js';
import {BotDesktopObserver} from './BotDesktopObserver.js';
import { Expand } from 'lucide-react';

/** The actual Playwright viewport. Human input is serialized with bot actions server-side. */
export function BotBrowser({ agentId, agentName = 'Bot', compact = false, onExpand }: { agentId: string; agentName?: string; compact?: boolean; onExpand?: () => void }) {
  const [state, setState] = useState<BrowserLiveState | null>(null);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    setState(null); setError(''); setConnectionError(''); setAddress(''); setText(''); setLoading(true);
    const refresh = async () => {
      try {
        const result = await api.systemAction('browser-live', { agentId });
        if (alive) { setState(result.available ? result.state : null); setConnectionError(''); }
      } catch (cause) { if (alive) { setState(null); setConnectionError(cause instanceof Error ? cause.message : 'Browser connection lost.'); } }
      finally { if (alive) { setLoading(false); timer = setTimeout(() => void refresh(), 1000); } }
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [agentId]);
  async function control(action: string, values: Record<string, unknown> = {}) {
    setBusy(true); setError('');
    try {
      const result = await api.systemAction('browser-control', { agentId, action, ...values });
      setState(old => old ? { ...old, controlled: result.controlled } : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const controlling = !!state?.controlled && !compact;
  if (compact) return <section className="oh-bot-screen" aria-label="Bot browser">
    <button type="button" className="oh-bot-screen-preview" aria-label="Open browser" onClick={onExpand}>
      {state?.desktop&&!state.login ? <BotDesktopObserver key={agentId} agentId={agentId}/> : state?.screenshot && !state.login
        ? <img src={state.screenshot} alt="Live bot browser page" />
        : <span className="oh-bot-screen-placeholder">
          <GrokBotComputerLoop size={56} color="currentColor" />
          <span>{connectionError ? 'Browser unavailable' : state?.login ? 'Waiting for sign-in' : loading ? 'Connecting to browser' : 'Idle — no desktop session'}</span>
        </span>}
    </button>
    <span className="oh-bot-screen-caption"><span>{agentName}'s screen</span><button type="button" className="oh-screen-expand" onClick={onExpand}><Expand size={12}/>Open screen</button></span>
    {connectionError && <p role="alert">{connectionError}</p>}
    {state?.warning && <p role="status">{state.warning}</p>}
  </section>;
  return <section className={`oh-browser-view ${compact ? 'compact' : ''}`} aria-label="Bot browser">
    <header><strong>{state?.login ? 'Signing in' : state?.desktop ? 'Bot desktop' : 'Browser snapshots'}</strong>
      {state && !state.login && <span>{state.controlled ? 'You are in control' : state.action ? `Bot: ${state.action}` : 'Bot is browsing'}</span>}
      {compact && onExpand && <button type="button" onClick={onExpand}>Open browser</button>}
    </header>
    {(error || connectionError) && <p role="alert">{error || connectionError}</p>}
    {state?.warning && <p role="status">{state.warning}</p>}
    {!state && !error && !connectionError && <p className="oh-browser-empty">When your bot opens a website, watch it and take control here.</p>}
    {state?.login && <p>Complete sign-in in {state.desktop ? 'your bot’s Chrome below' : 'the browser window'}. Your account details stay out of chat.</p>}
    {state?.desktop && (state.login || controlling) && <BotDesktopScreen agentId={agentId} />}
    {state?.desktop&&!state.login&&!controlling&&<BotDesktopObserver key={agentId} agentId={agentId}/>}
    {state && !state.login && <>
      {!compact && <div className="oh-browser-toolbar">
        <span className="oh-browser-url" title={state.url}>{state.url}</span>
        <button type="button" disabled={busy} onClick={() => void control(state.controlled ? 'resume' : 'takeover')}>{busy ? 'Please wait…' : state.controlled ? 'Resume bot' : 'Take control'}</button>
      </div>}
      {state.screenshot && !state.desktop && <img className={controlling ? 'is-controlling' : ''} src={state.screenshot} alt="Browser page snapshot (not the full desktop)" tabIndex={controlling ? 0 : undefined}
        onClick={event => {
          if (compact) { onExpand?.(); return; }
          if (!controlling || busy) return;
          const rect = event.currentTarget.getBoundingClientRect();
          void control('click', { x: (event.clientX - rect.left) / rect.width * (state.width ?? 1100), y: (event.clientY - rect.top) / rect.height * (state.height ?? 760) });
        }} />}
      {controlling && !state.desktop && <div className="oh-browser-controls">
        <p>Click the page, then type below. The bot waits until you resume it. Stopping the task also closes this browser.</p>
        {(state.tabs?.length ?? 0) > 1 && <select aria-label="Browser tab" disabled={busy} onChange={e => void control('tab', { tab: Number(e.target.value) })} value={state.tabs?.find(t => t.url === state.url)?.index ?? 0}>{state.tabs?.map(t => <option key={t.index} value={t.index}>{t.url}</option>)}</select>}
        <form onSubmit={e => { e.preventDefault(); if (address.trim()) void control('navigate', { url: /^https?:\/\//i.test(address) ? address : `https://${address}` }); }}>
          <input aria-label="Browser address" placeholder="Go to a website" value={address} onChange={e => setAddress(e.target.value)} /><button disabled={busy || !address.trim()}>Go</button>
        </form>
        <form onSubmit={e => { e.preventDefault(); if (text) { void control('type', { text }); setText(''); } }}>
          <input type="password" autoComplete="off" aria-label="Type into browser" placeholder="Type into the selected field" value={text} onChange={e => setText(e.target.value)} /><button disabled={busy || !text}>Type</button>
        </form>
        <div className="oh-browser-keys">{['Enter', 'Tab', 'Backspace', 'Escape'].map(key => <button type="button" key={key} disabled={busy} onClick={() => void control('key', { key })}>{key}</button>)}
          <button type="button" disabled={busy} onClick={() => void control('scroll', { delta: -600 })}>Scroll up</button><button type="button" disabled={busy} onClick={() => void control('scroll', { delta: 600 })}>Scroll down</button>
        </div>
      </div>}
    </>}
  </section>;
}
