/**
 * FreeLLMAPI on this computer, run by OpenAgents.
 *
 * Using FreeLLMAPI used to mean a terminal kept open and a port shared with
 * every other development tool. The daemon now finds it, starts it with
 * OpenAgents on its own quiet port bound to this computer, restarts it if it
 * stops, and keeps the FreeLLMAPI connection pointed at it (see
 * src/daemon/local-gateway.ts). This panel shows that state and the few choices
 * that belong to a person: the folder, whether it starts with OpenAgents, start
 * and stop. A daemon that does not manage a gateway answers 501, and then the
 * panel is simply absent.
 */

import { useEffect, useRef, useState } from 'react';
import { api, type LocalGatewayStatus } from '../lib/transport.js';
import { Input } from '@/registry/default/ui/input.js';
import { FormError } from './ui/FormError.js';
import { SettingsSwitch } from './SettingsKit.js';

const STATE: Record<LocalGatewayStatus['state'], { label: string; status: string }> = {
  running: { label: 'Running', status: 'connected' },
  starting: { label: 'Starting', status: 'untested' },
  stopped: { label: 'Stopped', status: 'disabled' },
  failed: { label: 'Not running', status: 'unreachable' },
  'not-found': { label: 'Not found', status: 'incomplete' },
};

export function LocalGatewayPanel({ onRunning }: { onRunning?: () => void }) {
  const [gateway, setGateway] = useState<LocalGatewayStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const lastState = useRef<LocalGatewayStatus['state'] | null>(null);
  const onRunningRef = useRef(onRunning);
  onRunningRef.current = onRunning;

  const take = (next: LocalGatewayStatus) => {
    setGateway(next);
    // Coming up can move the port; the connection list reloads to show the new address.
    if (next.state === 'running' && lastState.current !== 'running') onRunningRef.current?.();
    lastState.current = next.state;
  };

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const { gateway: next } = await api.localGateway();
        if (cancelled) return;
        take(next);
        setFolder((current) => current || next.directory || '');
        timer = window.setTimeout(() => void poll(), next.state === 'starting' ? 1500 : 8000);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [nonce]);

  if (!available || !gateway) return null;
  const view = STATE[gateway.state];

  const act = async (body: Parameters<typeof api.localGatewayAction>[0]) => {
    setBusy(true);
    setError('');
    try {
      take((await api.localGatewayAction(body)).gateway);
      setNonce((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const active = gateway.state === 'running' || gateway.state === 'starting';

  return (
    <section className="oh-set-group oh-gateway" aria-label="FreeLLMAPI on this computer">
      <header className="oh-set-group-head">
        <div>
          <h3>FreeLLMAPI on this computer</h3>
          <p>OpenAgents starts your FreeLLMAPI gateway with the app, keeps it reachable from this computer only, and points its connection at the right port.</p>
        </div>
        <span className="grok-provider-status" data-status={view.status}>{view.label}</span>
      </header>

      {gateway.message && <p className="oh-prov-message" role="status">{gateway.message}</p>}
      {error && <FormError>{error}</FormError>}

      <div className="oh-set-row">
        <div className="oh-set-row-text">
          <label className="oh-set-row-label" htmlFor="gateway-folder">Folder</label>
          <p className="oh-set-row-hint">
            {gateway.detected ? `Found automatically at ${gateway.detected}.` : 'Not found automatically. Paste the folder that holds FreeLLMAPI.'}
          </p>
        </div>
        <div className="oh-set-row-control">
          <Input
            id="gateway-folder"
            className="grok-form-input"
            value={folder}
            placeholder="C:\Users\you\Desktop\freellmapi"
            onChange={(event) => setFolder(event.target.value)}
          />
          <button
            type="button"
            className="oh-set-btn"
            disabled={busy || !folder.trim() || folder.trim() === (gateway.directory ?? '')}
            onClick={() => void act({ action: 'configure', directory: folder.trim() })}
          >
            Use this folder
          </button>
        </div>
      </div>

      <div className="oh-set-row">
        <div className="oh-set-row-text">
          <span className="oh-set-row-label">Start with OpenAgents</span>
          <p className="oh-set-row-hint">Starts whenever the OpenAgents app opens, as long as its folder is known.</p>
        </div>
        <div className="oh-set-row-control">
          <SettingsSwitch
            checked={gateway.autoStart}
            disabled={busy}
            label="Start FreeLLMAPI with OpenAgents"
            onChange={(on) => void act({ action: 'configure', autoStart: on })}
          />
        </div>
      </div>

      <div className="oh-set-row">
        <div className="oh-set-row-text">
          <span className="oh-set-row-label">Address</span>
          <p className="oh-set-row-hint">Port {gateway.port}, reachable only from this computer. It moves to a free port if another program takes this one.</p>
        </div>
        <div className="oh-set-row-control">
          <code className="oh-gateway-address">{gateway.baseUrl}</code>
        </div>
      </div>

      <div className="oh-prov-actions">
        {active ? (
          <>
            <button type="button" className="oh-set-btn" disabled={busy} onClick={() => void act({ action: 'restart' })}>Restart</button>
            <button type="button" className="oh-set-btn" disabled={busy} onClick={() => void act({ action: 'stop' })}>Stop</button>
          </>
        ) : (
          <button type="button" className="oh-set-btn primary" disabled={busy || gateway.state === 'not-found'} onClick={() => void act({ action: 'start' })}>
            Start FreeLLMAPI
          </button>
        )}
        {gateway.state === 'running' && (
          <a className="oh-set-btn" href={gateway.dashboardUrl} target="_blank" rel="noreferrer">Open its dashboard</a>
        )}
      </div>

      {gateway.log.length > 0 && (
        <details className="oh-gateway-log">
          <summary>Recent output</summary>
          <pre>{gateway.log.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}
