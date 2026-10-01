/**
 * The window's own chrome: a drag region, window controls, and the daemon's
 * state.
 *
 * PLATFORM CONVENTION BEATS CONSISTENCY HERE. macOS keeps its real traffic
 * lights — the shell asks for `hiddenInset`, so the system draws them and they
 * behave exactly as a Mac user expects. Windows and Linux get controls drawn
 * here, on the right, in that order. Drawing Mac-style lights on Windows would
 * look considered and be wrong every time somebody reached for the corner.
 *
 * The daemon pill is the honest part: this app runs a server, and an interface
 * that hides that is one where "nothing is loading" has no explanation. It says
 * whether the daemon is ours or one that was already running, because that
 * decides whether quitting takes it down.
 */

import { useState } from 'react';
import { Icon } from './ui/icons.js';
import {
  describeDaemon,
  desktopBridge,
  useDaemonFeed,
  useShellInfo,
  useWindowState,
} from '../lib/desktop.js';

export function DesktopChrome() {
  const info = useShellInfo();
  const windowState = useWindowState();
  const daemon = useDaemonFeed();
  // `null` means "nobody has decided yet", which is what lets a failure open
  // the panel while still letting the operator close it and have that stick.
  // A plain boolean cannot express both.
  const [logOpen, setLogOpen] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const bridge = desktopBridge();

  if (!bridge || !info) return null;

  const mac = info.platform === 'darwin';
  const status = daemon.state?.status ?? 'checking';
  const unhealthy = status === 'failed';
  // The log opens by itself on a failure: a boot that did not work is the one
  // moment the operator definitely wants to see the output.
  const showLog = logOpen ?? unhealthy;

  // What the button will ACTUALLY do, which is not always a restart. A daemon
  // this app attached to belongs to another process; the shell can only look
  // for it again. Saying "Restart" there would promise something it cannot do.
  const attached = daemon.state?.owned === false && status === 'attached';
  const restartLabel = daemon.restarting
    ? attached
      ? 'Reconnecting…'
      : 'Restarting…'
    : attached
      ? 'Reconnect'
      : status === 'failed' || status === 'stopped'
        ? 'Start daemon'
        : 'Restart daemon';
  const restartHint = attached
    ? 'Looks for the daemon again. It was started by another process, so this app cannot stop it.'
    : 'Stops the daemon this app started, then starts it again.';

  return (
    <>
      <div className={`oh-titlebar ${mac ? 'mac' : ''}`}>
        {/* The drag region. Buttons inside opt back out with -webkit-app-region:
            no-drag, or they would be undraggable AND unclickable.

            Double-click maximises. Every window manager on every desktop does
            this, so people try it without thinking - and a custom titlebar has
            to implement it, because the system one is not there to do it. Its
            absence is felt as "this window is a bit broken" rather than as a
            missing feature. */}
        <div
          className="oh-drag"
          onDoubleClick={() => void bridge.window.toggleMaximize()}
        />

        <div className="oh-titlebar-center">
          <span className="oh-title">OpenAgents</span>
        </div>

        <div className="oh-titlebar-right">
          <button
            type="button"
            className={`oh-daemon-pill ${status}`}
            onClick={() => setLogOpen((open) => !(open ?? unhealthy))}
            aria-expanded={showLog}
            title={daemon.state?.detail ?? describeDaemon(daemon.state)}
          >
            <span className={`oh-daemon-dot ${status}`} aria-hidden="true" />
            {describeDaemon(daemon.state)}
          </button>

          {!mac && (
            <div className="oh-window-controls">
              <button
                type="button"
                className="oh-window-btn"
                aria-label="Minimize"
                onClick={() => void bridge.window.minimize()}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
                </svg>
              </button>
              <button
                type="button"
                className="oh-window-btn"
                aria-label={windowState.maximized ? 'Restore' : 'Maximize'}
                onClick={() => void bridge.window.toggleMaximize()}
              >
                {windowState.maximized ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2.5 0.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" />
                    <path d="M0.5 2.5h7v7h-7z" fill="var(--oh-titlebar-fill)" stroke="currentColor" strokeWidth="1" />
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M0.5 0.5h9v9h-9z" fill="none" stroke="currentColor" strokeWidth="1" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className="oh-window-btn danger"
                aria-label="Close"
                onClick={() => void bridge.window.close()}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {showLog && (
        <aside className="oh-daemon-panel" aria-label="Daemon status">
          <header>
            <div>
              <strong>{describeDaemon(daemon.state)}</strong>
              {daemon.state?.detail && <span>{daemon.state.detail}</span>}
              {daemon.state?.owned === false && daemon.state.status === 'attached' && (
                <span>Quitting will leave it running, because this app did not start it.</span>
              )}
            </div>
            <div className="oh-daemon-actions">
              {bridge.diagnostics && (
                <>
                  <button
                    type="button"
                    className="grok-secondary-btn"
                    title="Copies versions, status and recent output. Keys and tokens are removed."
                    onClick={() => {
                      void bridge.diagnostics!.copy().then((ok) => {
                        if (!ok) return;
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 2200);
                      });
                    }}
                  >
                    {copied ? 'Copied' : 'Copy diagnostics'}
                  </button>
                  <button type="button" className="grok-secondary-btn" onClick={() => void bridge.diagnostics!.openLogs()}>
                    Open logs
                  </button>
                </>
              )}
              <button
                type="button"
                className="grok-secondary-btn"
                disabled={daemon.restarting}
                title={restartHint}
                onClick={daemon.restart}
              >
                {restartLabel}
              </button>
              <button
                type="button"
                className="grok-icon-btn"
                aria-label="Hide daemon status"
                onClick={() => setLogOpen(false)}
              >
                <Icon name="close" />
              </button>
            </div>
          </header>
          <pre>
            {daemon.log.length
              ? daemon.log.join('\n')
              : 'No output yet. A daemon that was already running logs to whichever terminal started it.'}
          </pre>
        </aside>
      )}
    </>
  );
}
