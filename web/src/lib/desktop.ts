/**
 * The desktop shell, seen from the interface.
 *
 * `window.openhours` exists only when the app is running inside the Electron
 * shell. Everything here degrades to "not the desktop" in a plain browser, so
 * the same bundle serves both and no component has to guard its own calls.
 */

import { useEffect, useState } from 'react';

export type Backdrop = 'acrylic' | 'vibrancy' | 'transparent' | 'none';

export interface ShellInfo {
  platform: 'win32' | 'darwin' | 'linux' | string;
  backdrop: Backdrop;
  isDev: boolean;
  daemonPort: number;
  /** Absent from shells older than the field. */
  appVersion?: string;
  versions: { electron: string; chrome: string; node: string };
  systemTheme: 'dark' | 'light';
  appTheme?: 'dark' | 'light';
}

export interface WindowState {
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

export type DaemonStatus = 'stopped' | 'checking' | 'starting' | 'running' | 'attached' | 'restarting' | 'failed';

export interface DaemonState {
  status: DaemonStatus;
  port: number;
  /** True when this app started the daemon, and therefore may stop it. */
  owned: boolean;
  detail: string | null;
  /** Automatic restarts after a crash or hang, this session. */
  restarts?: number;
}

/** Docker as the daemon reports it (src/daemon/docker-status.ts), plus the shell's view. */
export type DockerState = 'running' | 'stopped' | 'not-installed' | 'wsl-missing' | 'unknown' | 'starting' | 'preparing' | 'downloading' | 'installing' | 'setup-paused' | 'setup-failed' | 'setup-blocked' | 'restart-required';

export interface DockerStatus {
  state: DockerState;
  version: string | null;
  message: string;
  detail: string | null;
  via: string;
  checkedAt: number;
  /** Set by the desktop shell: whether Docker Desktop is installed and can be started. */
  installed?: boolean;
  canSetup?: boolean;
}

export interface DesktopSettings {
  keepRunningInBackground: boolean;
  openAtLogin: boolean;
  startDockerAutomatically: boolean;
  /** False where signing-in start cannot be registered: development, Linux. */
  canOpenAtLogin: boolean;
}

export type DesktopSettingsPatch = Partial<Omit<DesktopSettings, 'canOpenAtLogin'>>;

interface OpenAgentsBridge {
  isDesktop: true;
  info(): Promise<ShellInfo>;
  window: {
    minimize(): Promise<unknown>;
    toggleMaximize(): Promise<unknown>;
    close(): Promise<unknown>;
    onState(handler: (state: WindowState) => void): () => void;
  };
  /** Optional: absent from shells that predate global shortcut delivery. */
  keyboard?: {
    onEscape(handler: () => void): () => void;
  };
  daemon: {
    status(): Promise<{ state: DaemonState; log: string[] }>;
    restart(): Promise<DaemonState>;
    onState(handler: (state: DaemonState) => void): () => void;
    onLog(handler: (line: string) => void): () => void;
  };
  /** Optional: absent from shells that predate them. */
  docker?: {
    status(): Promise<DockerStatus | null>;
    start(): Promise<DockerStatus | null>;
    onStatus(handler: (status: DockerStatus | null) => void): () => void;
  };
  settings?: {
    get(): Promise<DesktopSettings>;
    set(patch: DesktopSettingsPatch): Promise<DesktopSettings>;
    onChange(handler: (settings: DesktopSettings) => void): () => void;
  };
  diagnostics?: {
    copy(): Promise<boolean>;
    openLogs(): Promise<boolean>;
  };
  theme: {
    setPreference?(preference: 'light' | 'dark' | 'system'): Promise<void>;
    onSystemChange(handler: (theme: 'dark' | 'light') => void): () => void;
  };
}

declare global {
  interface Window {
    openhours?: OpenAgentsBridge;
  }
}

export function desktopBridge(): OpenAgentsBridge | null {
  return typeof window !== 'undefined' && window.openhours?.isDesktop ? window.openhours : null;
}

export const isDesktop = (): boolean => desktopBridge() !== null;

/**
 * Shell info, plus the body class the stylesheet keys off.
 *
 * The class carries the backdrop that was ACTUALLY applied, not the one the
 * platform might support: on Windows 10 the acrylic request is declined, and a
 * stylesheet that assumed a blur would render unreadable text over an opaque
 * grey window.
 */
export function useShellInfo(): ShellInfo | null {
  const [info, setInfo] = useState<ShellInfo | null>(null);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let cancelled = false;
    void bridge.info().then((value) => {
      if (cancelled) return;
      setInfo(value);
      const root = document.documentElement;
      root.classList.add('oh-desktop');
      root.dataset.ohPlatform = value.platform;
      root.dataset.ohBackdrop = value.backdrop;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}

export function useWindowState(): WindowState {
  const [state, setState] = useState<WindowState>(() => ({
    maximized: false,
    fullScreen: false,
    focused: typeof document !== 'undefined' ? document.hasFocus() : true,
  }));

  useEffect(() => {
    const applyFocus = (focused: boolean) => {
      if (typeof document === 'undefined') return;
      const root = document.documentElement;
      root.dataset.ohFocused = String(focused);
      if (focused) {
        root.classList.add('oh-focused');
        root.classList.remove('oh-unfocused');
      } else {
        root.classList.remove('oh-focused');
        root.classList.add('oh-unfocused');
      }
    };

    applyFocus(typeof document !== 'undefined' ? document.hasFocus() : true);

    const onFocus = () => {
      setState((prev) => ({ ...prev, focused: true }));
      applyFocus(true);
    };
    const onBlur = () => {
      setState((prev) => ({ ...prev, focused: false }));
      applyFocus(false);
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    const bridge = desktopBridge();
    const offState = bridge
      ? bridge.window.onState((next) => {
          setState(next);
          applyFocus(next.focused);
        })
      : () => undefined;

    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      offState();
    };
  }, []);

  return state;
}

/**
 * The OS theme, as the shell reports it.
 *
 * `null` in a plain browser, where there is no shell to ask and the
 * stylesheet's own media query is the right authority. Inside the Electron
 * window it is the ONLY reliable authority: see the note on `applyTheme` in
 * preferences.ts for the disagreement this exists to settle.
 *
 * It stays live. `nativeTheme` fires on every OS change, so flipping Windows
 * between light and dark moves the app with it rather than waiting for a
 * restart.
 */
export function useSystemTheme(): 'light' | 'dark' | null {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let cancelled = false;

    void bridge.info().then((value) => {
      if (!cancelled) setTheme(value.systemTheme);
    });

    return bridge.theme.onSystemChange((next) => {
      if (!cancelled) setTheme(next);
      // The unsubscribe returned by onSystemChange runs on unmount; `cancelled`
      // only guards the info() promise, which has no unsubscribe of its own.
    });
  }, []);

  return theme;
}

export interface DaemonFeed {
  state: DaemonState | null;
  log: string[];
  restart: () => void;
  restarting: boolean;
}

/** Live daemon status and output, for the shell's own status surface. */
export function useDaemonFeed(): DaemonFeed {
  const [state, setState] = useState<DaemonState | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let cancelled = false;

    void bridge.daemon.status().then((snapshot) => {
      if (cancelled) return;
      setState(snapshot.state);
      setLog(snapshot.log);
    });

    const offState = bridge.daemon.onState(setState);
    const offLog = bridge.daemon.onLog((line) =>
      // Bounded: the daemon is chatty and this is a status surface, not an
      // archive. The full log is in the terminal that owns the process.
      setLog((current) => [...current.slice(-299), line])
    );

    return () => {
      cancelled = true;
      offState();
      offLog();
    };
  }, []);

  return {
    state,
    log,
    restarting,
    restart: () => {
      const bridge = desktopBridge();
      if (!bridge || restarting) return;
      setRestarting(true);
      void bridge.daemon
        .restart()
        .then(setState)
        .finally(() => setRestarting(false));
    },
  };
}

/** One line describing a daemon state, for a status pill. */
export function describeDaemon(state: DaemonState | null): string {
  switch (state?.status) {
    case 'checking':
      return 'Looking for a daemon';
    case 'starting':
      return 'Starting the daemon';
    case 'running':
      return 'Daemon running';
    case 'attached':
      return 'Attached to a running daemon';
    case 'restarting':
      return 'Restarting the daemon';
    case 'failed':
      return 'Daemon did not start';
    case 'stopped':
      return 'Daemon stopped';
    default:
      return 'Daemon status unknown';
  }
}

/**
 * The desktop app's own settings - background running, start at sign-in,
 * Docker autostart. `settings` stays null in a plain browser, where none of
 * them exist, so callers render nothing rather than inert switches.
 */
export function useDesktopSettings(): { settings: DesktopSettings | null; update: (patch: DesktopSettingsPatch) => void } {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.settings) return;
    let cancelled = false;
    void bridge.settings.get().then((value) => {
      if (!cancelled) setSettings(value);
    });
    const off = bridge.settings.onChange((value) => {
      if (!cancelled) setSettings(value);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return {
    settings,
    update: (patch) => {
      const bridge = desktopBridge();
      if (!bridge?.settings) return;
      // Optimistic: a switch that waits for a round trip feels broken.
      setSettings((current) => (current ? { ...current, ...patch } : current));
      void bridge.settings.set(patch).then(setSettings);
    },
  };
}
