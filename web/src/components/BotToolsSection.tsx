/**
 * What this bot can use, in one place.
 *
 * Its tools used to be scattered where nobody would look: MCP servers behind
 * the Marketplace and a config file, the Obsidian vault only in
 * openhours.config.json, the browser in a panel of forms, Docker nowhere at
 * all. Each is listed here with what it is for, whether it works right now,
 * and - when it does not - the one thing that fixes it. All of it can also be
 * done by asking in chat; this is where to check.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/transport.js';
import type { DockerStatus } from '../lib/desktop.js';
import { useCortex } from '../store.js';
import { Icon, type IconName } from './ui/icons.js';

type SystemData = Awaited<ReturnType<typeof api.botSystem>>;
type Tone = 'ok' | 'warn' | 'off';

const AUTONOMY_WORDS = {
  ask: 'asks before using forms on any site',
  accounts: 'asks only where no account is saved',
  always: 'uses websites without asking',
} as const;

interface ToolRow {
  id: string;
  icon: IconName;
  name: string;
  purpose: string;
  tone: Tone;
  state: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export function BotToolsSection({ agentId, agentName }: { agentId: string; agentName: string }) {
  const mcp = useCortex((state) => state.mcp);
  const [system, setSystem] = useState<SystemData | null>(null);
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [vaultPath, setVaultPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    setSystem(null);
    setError('');
    setMessage('');
    api.botSystem(agentId).then((next) => { if (alive) setSystem(next); }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    api.docker().then((body) => { if (alive) setDocker(body.docker); }).catch(() => undefined);
    return () => { alive = false; };
  }, [agentId]);

  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setSystem(await api.botSystem(agentId));
      setMessage(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const research = system?.research as { internet?: unknown } | undefined;
  const internet = typeof research?.internet === 'string' ? research.internet : null;
  const internetOn = Boolean(internet && !/not configured|disabled|turned off/i.test(internet));
  const browser = system?.browser;
  const vault = system?.vault;
  const connectedServers = mcp.filter((server) => server.connected);

  const rows: ToolRow[] = [
    {
      id: 'web', icon: 'search', name: 'Web search and pages',
      purpose: 'Finds and reads public web pages, and quotes what it cites.',
      tone: !system ? 'off' : internetOn ? 'ok' : 'off', state: !system ? 'Checking…' : internetOn ? 'Available' : 'Turned off',
    },
    {
      id: 'github', icon: 'link', name: 'GitHub',
      purpose: 'Searches issues and prepares tested changes to public repositories. Nothing is published.',
      tone: !system ? 'off' : internetOn ? 'ok' : 'off', state: !system ? 'Checking…' : internetOn ? 'Available' : 'Needs web access',
    },
    {
      id: 'browser', icon: 'preview', name: 'Browser',
      purpose: 'Opens websites in its own browser, signs in with the accounts you give it, and fills forms.',
      tone: !browser ? 'off' : browser.ready ? 'ok' : 'warn',
      state: !system ? 'Checking…' : !browser ? 'Not available' : !browser.enabled ? 'Turned off' : browser.desktop ? ({ stopped: 'Starts on demand · Bot desktop', starting: 'Starting bot desktop…', ready: 'Ready · Bot desktop', error: 'Desktop needs attention' }[browser.desktop.state]) : browser.ready ? (browser.isolation === 'sandbox' ? 'Ready · Docker sandbox' : 'Ready') : browser.installing ? 'Installing…' : 'Not installed',
      detail: browser?.enabled && browser.autonomy
        ? [
            `${browser.accounts?.length ?? 0} saved account${browser.accounts?.length === 1 ? '' : 's'}`,
            AUTONOMY_WORDS[browser.autonomy],
            browser.desktop?.message,
            browser.sandbox && browser.sandbox.state !== 'ready' && browser.sandbox.state !== 'idle' ? browser.sandbox.message : null,
          ].filter(Boolean).join(' · ')
        : undefined,
      action: browser?.enabled && !browser.desktop && !browser.ready && !browser.installing ? { label: 'Install', run: () => void act(() => api.systemAction('browser-install', {}), 'Installing the browser.') } : undefined,
    },
    {
      id: 'sandbox', icon: 'computer', name: 'Code sandbox',
      purpose: 'Runs code and tests in an isolated Docker container that cannot reach your files.',
      tone: docker?.state === 'running' ? 'ok' : docker ? 'warn' : 'off',
      state: docker?.state === 'running' ? 'Ready' : docker ? 'Docker is not ready' : 'Checking…',
      detail: docker && docker.state !== 'running' ? docker.message : undefined,
    },
    {
      id: 'memory', icon: 'data', name: 'Memory',
      purpose: 'Keeps notes between conversations and recalls them when they are relevant.',
      tone: system ? 'ok' : 'off', state: system ? `${system.memory.length} note${system.memory.length === 1 ? '' : 's'}` : 'Checking…',
    },
    {
      id: 'mcp', icon: 'grid', name: 'MCP servers',
      purpose: 'Extra tools from programs you install, such as file systems or databases.',
      tone: connectedServers.length ? 'ok' : mcp.length ? 'warn' : 'off',
      state: mcp.length === 0 ? 'None installed' : `${connectedServers.length} of ${mcp.length} connected`,
      detail: mcp.length
        ? mcp.map((server) => `${server.name}${server.connected ? ` (${server.tools.length} tools)` : ' (not connected)'}`).join(', ')
        : 'Install one from Marketplace → Plugins.',
    },
  ];

  return (
    <section className="oh-tools" aria-label="Tools">
      <header>
        <h3>Tools</h3>
        <p>What {agentName} can use right now. You can also ask in chat, for example “connect my Obsidian vault”.</p>
      </header>
      {error && <p role="alert" className="oh-overview-alert">{error}</p>}
      {message && <p role="status" className="oh-overview-note">{message}</p>}

      <ul className="oh-tools-list">
        {rows.map((row) => (
          <li key={row.id} className="oh-tool" data-tone={row.tone}>
            <span className="oh-tool-icon" aria-hidden="true"><Icon name={row.icon} size={15} motion={false} /></span>
            <div className="oh-tool-text">
              <div className="oh-tool-head">
                <strong>{row.name}</strong>
                <span className="oh-tool-state">{row.state}</span>
              </div>
              <p>{row.purpose}</p>
              {row.detail && <small>{row.detail}</small>}
            </div>
            {row.action && (
              <button type="button" className="oh-tool-action" disabled={busy} onClick={row.action.run}>{row.action.label}</button>
            )}
          </li>
        ))}

        <li className="oh-tool" data-tone={vault?.configured ? 'ok' : 'off'}>
          <span className="oh-tool-icon" aria-hidden="true"><Icon name="file" size={15} motion={false} /></span>
          <div className="oh-tool-text">
            <div className="oh-tool-head">
              <strong>Obsidian vault</strong>
              <span className="oh-tool-state">{!system ? 'Checking…' : vault?.configured ? 'Connected' : 'Not connected'}</span>
            </div>
            <p>Reads notes from your vault into memory and saves new notes into it. Existing notes are never overwritten.</p>
            {vault?.configured && (
              <small>
                {vault.path}
                {vault.source === 'config' ? ' (set in openhours.config.json)' : ''}
              </small>
            )}
            {system && !vault?.configured && (
              <form
                className="oh-signin-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  const folder = vaultPath.trim();
                  if (!folder) return;
                  void act(async () => {
                    await api.systemAction('obsidian-vault', { agentId, path: folder });
                    setVaultPath('');
                  }, 'Vault connected.');
                }}
              >
                <input
                  type="text"
                  value={vaultPath}
                  placeholder="C:\Users\you\Documents\My vault"
                  aria-label="Obsidian vault folder"
                  onChange={(event) => setVaultPath(event.target.value)}
                />
                <button type="submit" disabled={busy || !vaultPath.trim()}>Connect</button>
              </form>
            )}
          </div>
          {vault?.configured && vault.source === 'app' && (
            <button
              type="button"
              className="oh-tool-action"
              disabled={busy}
              onClick={() => void act(() => api.systemAction('obsidian-vault', { agentId, path: null }), 'Vault disconnected.')}
            >
              Disconnect
            </button>
          )}
        </li>
      </ul>
    </section>
  );
}
