/**
 * The bridge between the shell and the interface.
 *
 * Deliberately narrow. The renderer loads a full web app over HTTP; giving it
 * Node access would mean any script that ends up on that page has the
 * filesystem. `contextIsolation` stays on and this file exposes a handful of
 * named operations and nothing else — no `require`, no `ipcRenderer`, no
 * arbitrary channel names.
 *
 * The same bridge serves the startup screen (desktop/src/startup), which is
 * what lets that page show the server's progress before the interface exists.
 *
 * CommonJS on purpose: Electron preload scripts are not ESM unless the window
 * opts in, and a preload that fails to parse fails silently, leaving the app
 * looking like a plain browser page.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Wrap a subscription so the renderer gets an unsubscribe, not a raw emitter. */
function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('openhours', {
  /** Marks this as the desktop shell. The web build leaves it undefined. */
  isDesktop: true,

  /** Platform, backdrop material actually applied, versions. */
  info: () => ipcRenderer.invoke('shell:info'),

  window: {
    minimize: () => ipcRenderer.invoke('window:command', 'minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:command', 'maximize'),
    close: () => ipcRenderer.invoke('window:command', 'close'),
    onState: (handler) => subscribe('window:state', handler),
  },

  keyboard: {
    onEscape: (handler) => subscribe('shortcut:escape', handler),
  },

  daemon: {
    status: () => ipcRenderer.invoke('daemon:status'),
    restart: () => ipcRenderer.invoke('daemon:restart'),
    onState: (handler) => subscribe('daemon:state', handler),
    onLog: (handler) => subscribe('daemon:log', handler),
  },

  /** Docker, as the shell sees it - including whether it can start Docker Desktop. */
  docker: {
    status: () => ipcRenderer.invoke('docker:status'),
    start: () => ipcRenderer.invoke('docker:start'),
    onStatus: (handler) => subscribe('docker:status', handler),
  },

  /** The app's own settings: background running, sign-in start, Docker autostart. */
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChange: (handler) => subscribe('settings:changed', handler),
  },

  diagnostics: {
    copy: () => ipcRenderer.invoke('diagnostics:copy'),
    openLogs: () => ipcRenderer.invoke('diagnostics:open-logs'),
  },

  theme: {
    setPreference: (preference) => ipcRenderer.invoke('theme:preference', preference),
    onAppearanceChange: (handler) => subscribe('theme:appearance', handler),
    onSystemChange: (handler) => subscribe('theme:system', handler),
  },
});
