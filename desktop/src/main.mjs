/**
 * OpenAgents desktop shell.
 *
 * A frameless, translucent window over the same web interface the browser
 * serves, plus lifecycle for the daemon behind it.
 *
 * MATERIALS. Windows 11 and macOS both composite a real backdrop behind a
 * window, and they do it in incompatible ways:
 *
 *   Windows 11  `backgroundMaterial: 'acrylic'` asks DWM for the system blur.
 *               It requires the window NOT to be `transparent` - the two are
 *               alternatives, not companions - and needs a fully transparent
 *               `backgroundColor` so the material is what shows through.
 *   macOS       `vibrancy` puts an NSVisualEffectView behind the web contents.
 *   Linux       Neither exists. `transparent: true` gives per-pixel alpha and
 *               depends on a compositor being present; where there is none the
 *               window simply renders opaque, which is a fine outcome.
 *
 * The renderer is told which of these it got, so the stylesheet can pick
 * surfaces that read correctly against a blur rather than assuming one.
 *
 * FOR SOMEONE WHO INSTALLED IT. Opening the app is the whole setup:
 *
 *   - The window appears at once, on a startup screen bundled with the app,
 *     and moves to the interface when the server answers. A server that
 *     cannot start is explained there, with Try again and diagnostics.
 *   - The server gets a working port by itself (ports.mjs), is restarted when
 *     it crashes or hangs (daemon.mjs), and is checked again after sleep.
 *   - Docker Desktop is started when it is installed but stopped.
 *   - Closing the window keeps routines running from the tray, unless that is
 *     switched off; starting at sign-in is available and off by default.
 *   - The database is backed up before a different version opens it, and a
 *     downgrade is confirmed first (backup.mjs).
 *   - Everything is logged to a rotated file with secrets removed (logs.mjs).
 */

import './env-bootstrap.mjs';
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, powerMonitor, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DaemonSupervisor, probe } from './daemon.mjs';
import { attachDownloads } from './downloads.mjs';
import { contentSecurityPolicy } from './content-security-policy.mjs';
import { checkUpdate, downloadUpdate } from './updates.mjs';
import {
  attachContextMenu,
  buildApplicationMenu,
  disableZoom,
  windowStateStore,
} from './chrome.mjs';
import { DESKTOP_DEFAULT_PORT } from './ports.mjs';
import { DEFAULT_SETTINGS, sanitizeSettings, settingsStore, stateStore, resolveAppTheme } from './settings.mjs';
import { LogFile, diagnosticsReport } from './logs.mjs';
import { DATABASE_FILE, backupDatabase, versionTransition } from './backup.mjs';
import { findDockerDesktop } from './docker-desktop.mjs';
import { SandboxSetup } from './sandbox-setup.mjs';
import { preserveDockerTransport } from './docker-transport.mjs';
import { createTray } from './tray.mjs';
import { chooseUserData } from './legacy-profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the application's own files live.
 *
 * In development that is the repository, two levels up from desktop/src. In an
 * installed app it is the resources/app directory. The relative step works
 * because packaging preserves the repository's layout - `dist/` and
 * `web/dist/` sit where the daemon already expects to find them.
 */
const appRoot = path.resolve(here, '..', '..');
const releaseVersion = (() => {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).releaseVersion;
    if (/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:\.\d{1,6})?$/.test(value)) return value;
  } catch { /* Fall back to Electron's package version below. */ }
  return app.getVersion();
})();
const userData = chooseUserData({ override: process.env.OPENHOURS_DATA_DIR, isPackaged: app.isPackaged, appData: app.getPath('appData') });
if (userData) app.setPath('userData', userData);

/**
 * A released build does not take debugging switches.
 *
 * A remote debugging port is remote control of the window for anything on the
 * machine that can open a socket, with no prompt. From source it stays
 * available (see launch.mjs, which warns loudly); an installed app has no
 * legitimate reason to be started that way, so it refuses rather than runs
 * exposed. The inspector switches are also disabled at build time by the
 * Electron fuses in electron-builder.yml.
 */
if (app.isPackaged) {
  const debugging = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port']
    .some((name) => app.commandLine.hasSwitch(name)) || process.argv.some((arg) => /^--(inspect|remote-debugging)/.test(arg));
  if (debugging) {
    dialog.showErrorBox('OpenAgents', 'OpenAgents does not start with debugging switches. Start it again without them.');
    app.exit(1);
  }
}

const isDev = process.env.OH_DEV === '1';
const devUrl = process.env.OH_DEV_URL ?? 'http://localhost:5173';
/** Started at sign-in: come up in the tray, without a window in the way. */
const startInBackground = process.argv.includes('--background');
const iconPath = path.join(here, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const startupPage = path.join(here, 'startup', 'index.html');

/**
 * The port. Development is pinned to 4001 because the Vite dev server proxies
 * there; an explicit OPENHOURS_PORT is somebody's deliberate choice. Both stay
 * strict. The installed app picks its own and remembers it.
 */
const explicitPort = (() => {
  const raw = process.env.OPENHOURS_PORT;
  if (!raw) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
})();
const portPolicy = isDev || explicitPort ? 'fixed' : 'auto';
const preferredPort = explicitPort ?? (isDev ? 4001 : DESKTOP_DEFAULT_PORT);

/** Windows 11 gained the DWM backdrop materials in build 22000. */
function windowsBuild() {
  if (process.platform !== 'win32') return 0;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(process.getSystemVersion?.() ?? '');
  return match ? Number(match[3]) : 0;
}

const backdrop =
  process.platform === 'win32'
    ? windowsBuild() >= 22000
      ? 'acrylic'
      : 'none'
    : process.platform === 'darwin'
      ? 'vibrancy'
      : 'transparent';

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {ReturnType<typeof windowStateStore> | null} */
let windowState = null;
/** @type {DaemonSupervisor | null} */
let supervisor = null;
/** @type {ReturnType<typeof createTray> | null} */
let tray = null;
/** @type {LogFile | null} */
let logFile = null;
/** @type {ReturnType<typeof settingsStore> | null} */
let settings = null;
/** @type {ReturnType<typeof stateStore> | null} */
let memory = null;
let profileDir = null;
let quitting = false;
/** Ring buffer of daemon output, so a window opened later still sees the boot. */
const logLines = [];
let daemonState = { status: 'stopped', port: preferredPort, owned: false, detail: null, restarts: 0 };
/** Docker as the shell last saw it, plus whether Docker Desktop is installed. */
let dockerStatus = null;

const canOpenAtLogin = app.isPackaged && !isDev && process.platform !== 'linux';
const currentSettings = () => settings?.read() ?? { ...DEFAULT_SETTINGS };
const secrets = () => [supervisor?.credentials?.token].filter(Boolean);

/** Everything the shell says goes to the console AND the log file. */
function shellLog(line) {
  console.log(`[shell] ${line}`);
  logFile?.write(line, 'shell');
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

shellLog(
  `platform=${process.platform} systemVersion=${process.getSystemVersion?.() ?? 'n/a'} ` +
    `build=${windowsBuild()} backdrop=${backdrop} electron=${process.versions.electron} version=${releaseVersion}`
);

let updateBusy = false;
async function offerUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  try {
    const channelPath = path.join(appRoot, 'desktop', 'update-channel.json');
    if (!fs.existsSync(channelPath)) {
      await dialog.showMessageBox({ type: 'info', message: 'No update channel is configured for this build.', detail: 'A release owner must supply a signed update feed and its public verification key before distributing updates.' });
      return;
    }
    const channel = JSON.parse(fs.readFileSync(channelPath, 'utf8'));
    const asset = await checkUpdate(channel, releaseVersion);
    if (!asset) { await dialog.showMessageBox({ message: 'This build is up to date.' }); return; }
    const decision = await dialog.showMessageBox({ message: `OpenAgents ${asset.version} is available.`, detail: 'Download its installer? The signature and installer checksum will be verified. Installation is manual; your current work will continue.', buttons: ['Cancel', 'Download verified installer'], defaultId: 0, cancelId: 0 });
    if (decision.response !== 1) return;
    const choice = await dialog.showSaveDialog({ title: 'Save update installer', defaultPath: path.join(app.getPath('downloads'), asset.filename) });
    if (choice.canceled || !choice.filePath) return;
    await downloadUpdate(asset, choice.filePath);
    shell.showItemInFolder(choice.filePath);
    await dialog.showMessageBox({ message: 'Verified installer downloaded.', detail: 'Finish or pause your work, close OpenAgents, then run the installer. Your profile is stored separately from the application.' });
  } catch (error) { dialog.showErrorBox('Update could not be completed', String(error.message ?? error)); }
  finally { updateBusy = false; }
}

// ---------------------------------------------------------------- docker --

function setDockerStatus(status) {
  dockerStatus = status ? { ...status, installed: Boolean(findDockerDesktop()) } : null;
  send('docker:status', dockerStatus);
}

let dockerCheck = null;
let sandboxSetup = null;
let setupTimer = null;
/**
 * Check Docker, and start Docker Desktop when that can help. Never awaited by
 * startup: the server does not need Docker to start, and the startup screen
 * shows this as it happens.
 */
function checkDocker({ userAsked = false } = {}) {
  if (!dockerCheck) {
    dockerCheck = (async () => {
      const { probeDocker } = await import(pathToFileURL(path.join(appRoot, 'dist', 'src', 'daemon', 'docker-status.js')).href);
      sandboxSetup ??= new SandboxSetup({ directory: profileDir, probe: () => probeDocker(), onStatus: setDockerStatus });
      await sandboxSetup.run({ automatic: currentSettings().startDockerAutomatically, retry: userAsked });
      return dockerStatus;
    })()
      .catch((error) => {
        shellLog(`Docker check failed: ${error?.message ?? error}`);
        setDockerStatus({ state: 'setup-failed', canSetup: process.platform === 'win32', message: 'Setup could not finish. Choose Retry setup.', detail: String(error?.message ?? error) });
        return dockerStatus;
      })
      .finally(() => { dockerCheck = null; });
  }
  return dockerCheck;
}

// -------------------------------------------------------------- settings --

function applyLoginItem(openAtLogin) {
  if (!canOpenAtLogin) return;
  try {
    // A portable build runs from a temporary extraction; the file the person
    // actually has is PORTABLE_EXECUTABLE_FILE. Re-applied on every launch so a
    // moved portable file keeps working.
    const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin, path: executable, args: ['--background'] });
  } catch (error) {
    shellLog(`could not update the sign-in setting: ${error?.message ?? error}`);
  }
}

function applySettings(patch) {
  const allowed = sanitizeSettings({ ...currentSettings(), ...patch });
  const next = settings.update(allowed);
  if ('openAtLogin' in (patch ?? {})) applyLoginItem(next.openAtLogin);
  if (patch?.startDockerAutomatically && dockerStatus?.state !== 'running') void checkDocker();
  send('settings:changed', { ...next, canOpenAtLogin });
  tray?.rebuild();
  return { ...next, canOpenAtLogin };
}

function buildDiagnostics() {
  logFile?.flush();
  return diagnosticsReport({
    appVersion: releaseVersion,
    packaged: app.isPackaged,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    versions: process.versions,
    platform: process.platform,
    osVersion: process.getSystemVersion?.() ?? '',
    arch: process.arch,
    dataDir: profileDir,
    daemon: daemonState,
    docker: dockerStatus,
    settings: currentSettings(),
    log: logLines.slice(-200),
  }, { secrets: secrets() });
}

const logsDir = () => path.join(app.getPath('userData'), 'logs');

/**
 * What the interface is allowed to ask the OS for.
 *
 * An allowlist, not a denylist: dictation needs the microphone and several
 * copy buttons need the clipboard, and everything else - location, USB, serial,
 * MIDI, system notifications - is something this app has no use for and should
 * not be able to prompt for.
 */
const ALLOWED_PERMISSIONS = new Set([
  'media',
  'audioCapture',
  'clipboard-read',
  'clipboard-sanitized-write',
]);

function hardenSession() {
  attachDownloads(session.defaultSession, { downloadsDirectory: app.getPath('downloads'),
    isTrusted: contents => contents === mainWindow?.webContents && isAllowedTarget(contents.getURL()),
    onComplete: result => { if (result.state !== 'completed' && result.state !== 'cancelled') dialog.showErrorBox('Download interrupted', 'The file was not saved. Please download it again.'); } });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    // Replace rather than append: two policies intersect, and a stale one from
    // the daemon would silently narrow this.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [contentSecurityPolicy({
      port: supervisor?.port ?? preferredPort, url: details.url, isDev, devUrl,
    })];
    callback({ responseHeaders: headers });
  });

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === mainWindow?.webContents && isAllowedTarget(details.requestingUrl ?? contents.getURL()) && ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    contents === mainWindow?.webContents && isAllowedTarget(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission)
  );
}

/**
 * Put a config TEMPLATE next to where the real one goes.
 *
 * Not the live config: writing that would start the app with declared bots the
 * user never asked for, and would quietly become "the file I have to edit
 * around". The example is copied once so the answer to "where do I configure
 * this?" is a file sitting in the data directory, and the daemon meanwhile
 * boots on its built-in defaults.
 */
function seedConfigTemplate(dataDir) {
  const target = path.join(dataDir, 'openhours.config.example.json');
  if (fs.existsSync(target)) return;
  const source = path.join(appRoot, 'openhours.config.example.json');
  try {
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
  } catch (cause) {
    shellLog(`could not write the config template: ${cause?.message ?? cause}`);
  }
}

/** The one URL this window is allowed to be showing. */
function homeUrl() {
  return isDev ? devUrl : `http://127.0.0.1:${supervisor?.port ?? preferredPort}/`;
}

function isStartupUrl(url) {
  try {
    const target = new URL(url);
    if (target.protocol !== 'file:') return false;
    const normalise = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    return normalise(fileURLToPath(target)) === normalise(startupPage);
  } catch {
    return false;
  }
}

/**
 * Is this somewhere the app window may navigate to?
 *
 * Deliberately narrow: the bundled startup screen, and in production only the
 * daemon's own loopback origin on the port in use right now; in development
 * only the dev server's. Everything else - including another project served on
 * another local port - belongs in the user's browser, not in this frame.
 */
function isAllowedTarget(url) {
  if (isStartupUrl(url)) return true;
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (isDev) return target.origin === new URL(devUrl).origin;
  return (
    target.protocol === 'http:' &&
    (target.hostname === '127.0.0.1' || target.hostname === 'localhost') &&
    target.port === String(supervisor?.port ?? preferredPort)
  );
}

function showingInterface() {
  const current = mainWindow?.webContents.getURL();
  if (!current || isStartupUrl(current)) return false;
  try {
    return new URL(current).origin === new URL(homeUrl()).origin;
  } catch {
    return false;
  }
}

function showStartup() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.webContents.getURL();
  if (current && isStartupUrl(current)) return;
  mainWindow.loadFile(startupPage, { query: { theme: appTheme() } }).catch((error) => {
    // ERR_ABORTED is a newer navigation replacing this one, not a failure.
    if (!/ERR_ABORTED/.test(String(error?.message))) shellLog(`startup screen did not load: ${error?.message ?? error}`);
  });
}

/** How long to keep retrying a load that fails although the server answers. */
const HOME_RETRY_WINDOW_MS = 60_000;
let homeTimer = null;

/**
 * Put the window on the app, and keep trying until it is actually there.
 *
 * In production the page is served BY the daemon, so until it answers the
 * window shows the startup screen instead - never Chrome's connection-refused
 * page, and never nothing. A serving daemon calls this again (see onState).
 *
 * The navigation guard sends the window here too, and a refusal that silently
 * left the window on the page it was refusing would be a control that fails
 * open, so a failed load is retried rather than assumed final.
 */
function goHome(reason) {
  if (!mainWindow) return;
  clearTimeout(homeTimer);
  const deadline = Date.now() + HOME_RETRY_WINDOW_MS;
  shellLog(`loading the interface (${reason})`);

  const attempt = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!isDev) {
      const serving = supervisor
        && (supervisor.state.status === 'running' || supervisor.state.status === 'attached')
        && (await probe(supervisor.port, supervisor.credentials));
      if (!serving) {
        showStartup();
        if (Date.now() < deadline) homeTimer = setTimeout(attempt, 1000);
        return;
      }
    }
    try {
      if (!isDev && supervisor?.credentials) {
        await session.defaultSession.cookies.set({ url: homeUrl(), name: 'openhours_session', value: supervisor.credentials.token, httpOnly: true, sameSite: 'strict', path: '/' });
      }
      await mainWindow.loadURL(homeUrl());
    } catch {
      if (Date.now() < deadline) homeTimer = setTimeout(attempt, 600);
      else if (!isDev) showStartup();
    }
  };

  void attempt();
}

/**
 * Normalise the `did-start-navigation` arguments.
 *
 * Electron moved this event from positional arguments to a single details
 * object, and a shell that reads the wrong shape fails open - it would decide
 * every navigation is allowed. Reading both shapes is cheap; guessing wrong is
 * a security control that silently does nothing.
 */
function navigationDetails(args) {
  const [first] = args;
  if (first && typeof first === 'object' && typeof first.url === 'string') {
    return {
      url: first.url,
      isMainFrame: first.isMainFrame !== false,
      isSameDocument: Boolean(first.isSameDocument),
    };
  }
  const [, url, isInPlace, isMainFrame] = args;
  return { url, isMainFrame: isMainFrame !== false, isSameDocument: Boolean(isInPlace) };
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApp() {
  quitting = true;
  app.quit();
}

function createWindow() {
  // Where it was last time. An application opens where you left it; a web page
  // opens wherever the browser decides.
  const geometry = windowState.restore({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 600,
  });
  const { wasMaximized, ...bounds } = geometry;

  /** @type {import('electron').BrowserWindowConstructorOptions} */
  const options = {
    ...bounds,
    show: false,
    // Without this the taskbar and Alt+Tab show Electron's own atom logo, which
    // is the single loudest "this is somebody's Electron project" signal there
    // is.
    icon: iconPath,
    title: 'OpenAgents',
    // NOT `frame: false` on Windows and macOS.
    //
    // The DWM backdrop materials are drawn into a window's NON-CLIENT area, so
    // a frameless window has nowhere to composite them: Electron accepts
    // `setBackgroundMaterial('acrylic')` without error and the window still
    // renders opaque. `titleBarStyle: 'hidden'` keeps the frame - and therefore
    // the backdrop, the resize borders and the snap behaviour - while removing
    // the caption bar, which is the part we replace.
    //
    // Linux has no such material, so there the frame goes and per-pixel
    // transparency does the work instead.
    frame: process.platform === 'linux' ? false : true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer loads a full web app over HTTP. Sandboxing it costs
      // nothing here - the preload uses only contextBridge and ipcRenderer,
      // both of which a sandboxed preload keeps - and means a script that
      // ends up on that page is confined to a renderer with no Node at all.
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // No inspector in a released build, not merely no menu item for it.
      devTools: !app.isPackaged,
    },
  };

  if (backdrop === 'acrylic') {
    // A fully transparent backgroundColor is what lets the DWM material show.
    options.backgroundColor = '#00000000';
    options.backgroundMaterial = 'acrylic';
  } else if (backdrop === 'vibrancy') {
    options.vibrancy = 'under-window';
    options.visualEffectState = 'active';
    options.backgroundColor = '#00000000';
  } else if (backdrop === 'transparent') {
    options.transparent = true;
    options.backgroundColor = '#00000000';
  } else {
    options.backgroundColor = '#faf9f6';
  }

  mainWindow = new BrowserWindow(options);
  if (process.platform === 'win32') {
    // Set the window's taskbar metadata too: an older installed shortcut can
    // otherwise supply the icon for this shared application identity.
    mainWindow.setAppDetails({ appId: 'dev.openhours.cortex', appIconPath: iconPath, appIconIndex: 0 });
  }

  if (wasMaximized) mainWindow.maximize();
  windowState.track(mainWindow);

  // Take the browser out of the window: no page zoom, and a real right-click
  // menu in text fields. See chrome.mjs for why each one matters.
  disableZoom(mainWindow.webContents);
  attachContextMenu(mainWindow.webContents);
  // `keydown` events inside a sandboxed report iframe do not bubble to the
  // workspace renderer. Relay Escape from Electron's input boundary so the
  // file viewer can always return to chat, even while the preview has focus.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && !input.isAutoRepeat) {
      mainWindow?.webContents.send('shortcut:escape');
    }
  });

  mainWindow.once('ready-to-show', () => {
    // Applying the material again after the window exists: DWM can decline the
    // constructor-time request on a frameless window, and the setter reports
    // whether it took.
    if (backdrop === 'acrylic') {
      try {
        mainWindow.setBackgroundMaterial('acrylic');
      } catch (cause) {
        shellLog(`setBackgroundMaterial failed: ${cause?.message ?? cause}`);
      }
    }
    if (!startInBackground) mainWindow?.show();
  });

  // CLOSING IS NOT QUITTING, unless the person chose that. Routines keep
  // running from the tray; the first time, the tray says so.
  mainWindow.on('close', (event) => {
    if (quitting || !tray || !currentSettings().keepRunningInBackground) return;
    event.preventDefault();
    mainWindow.hide();
    if (!memory?.read().backgroundHintShown) {
      tray.notify('OpenAgents is still running', 'Your routines keep running. Quit from the OpenAgents icon in the taskbar tray.');
      memory?.update({ backgroundHintShown: true });
    }
  });
  // Windows signing out or shutting down must not be held up by a hidden window.
  mainWindow.on('session-end', () => { quitting = true; });

  const emitWindowState = () => {
    send('window:state', {
      maximized: mainWindow.isMaximized(),
      fullScreen: mainWindow.isFullScreen(),
      focused: mainWindow.isFocused(),
    });
  };
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    mainWindow.on(event, emitWindowState);
  }

  // A link to somewhere else is a link for the user's browser, not a
  // navigation inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Link clicks and in-page navigations.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedTarget(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  // The same rule, enforced a second time and one layer lower.
  //
  // `will-navigate` covers navigations the PAGE starts. It does not fire for
  // ones started from outside it - `loadURL`, or a DevTools/CDP `Page.navigate`
  // from any process that can reach a remote debugging port. That is not
  // hypothetical: this window was found displaying an unrelated local project
  // because another tool on the machine attached to a debug port and pointed it
  // there. Nothing was damaged, but the window stopped being this application
  // while still looking like its frame, which is the part that matters.
  //
  // `did-start-navigation` fires for all of them, so the window is put back.
  mainWindow.webContents.on('did-start-navigation', (...args) => {
    const { url, isMainFrame, isSameDocument } = navigationDetails(args);
    if (!isMainFrame || isSameDocument || !url) return;
    // about:blank passes through during startup, and devtools:// is the
    // inspector itself - neither is a page swap.
    if (/^(about|devtools|chrome|chrome-extension):/.test(url)) return;
    if (isAllowedTarget(url)) return;
    shellLog(`refused navigation to ${url}`);
    goHome('refused navigation');
  });

  // A renderer that crashed takes the whole interface with it. Bring it back
  // rather than leave an empty frame.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    shellLog(`interface process ended: ${details.reason}`);
    if (details.reason !== 'clean-exit' && !quitting) setTimeout(() => goHome('interface process ended'), 1000);
  });

  goHome('startup');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

nativeTheme.on('updated', () => {
  send('theme:system', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  send('theme:appearance', appTheme());
});

function appTheme() {
  return resolveAppTheme(currentSettings().themePreference, nativeTheme.shouldUseDarkColors);
}

// ------------------------------------------------------------------- IPC ---

function requireSender(event) {
  if (event.sender !== mainWindow?.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isAllowedTarget(event.senderFrame.url)) throw new Error('Untrusted IPC sender.');
}

ipcMain.handle('shell:info', (event) => { requireSender(event); return ({
  platform: process.platform,
  backdrop,
  isDev,
  daemonPort: supervisor?.port ?? preferredPort,
  appVersion: releaseVersion,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  appTheme: appTheme(),
}); });

ipcMain.handle('theme:preference', (event, preference) => {
  requireSender(event);
  if (!['light', 'dark', 'system'].includes(preference)) throw new Error('Invalid theme preference.');
  if (currentSettings().themePreference !== preference) settings.update({ themePreference: preference });
  send('theme:appearance', appTheme());
});

ipcMain.handle('daemon:status', (event) => { requireSender(event); return ({ state: daemonState, log: logLines.slice(-200) }); });
ipcMain.handle('daemon:restart', async (event) => {
  requireSender(event);
  return supervisor ? supervisor.restart() : daemonState;
});

ipcMain.handle('docker:status', (event) => { requireSender(event); return dockerStatus; });
ipcMain.handle('docker:start', async (event) => { requireSender(event); return checkDocker({ userAsked: true }); });

ipcMain.handle('settings:get', (event) => { requireSender(event); return { ...currentSettings(), canOpenAtLogin }; });
ipcMain.handle('settings:set', (event, patch) => {
  requireSender(event);
  if (!patch || typeof patch !== 'object') throw new Error('Settings must be an object.');
  return applySettings(patch);
});

ipcMain.handle('diagnostics:copy', (event) => { requireSender(event); clipboard.writeText(buildDiagnostics()); return true; });
ipcMain.handle('diagnostics:open-logs', async (event) => {
  requireSender(event);
  logFile?.flush();
  fs.mkdirSync(logsDir(), { recursive: true });
  const error = await shell.openPath(logsDir());
  return !error;
});

ipcMain.handle('window:command', (_event, command) => {
  requireSender(_event);
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!target) return null;
  switch (command) {
    case 'minimize':
      target.minimize();
      break;
    case 'maximize':
      if (target.isMaximized()) target.unmaximize();
      else target.maximize();
      break;
    case 'close':
      target.close();
      break;
    default:
      break;
  }
  return { maximized: target.isMaximized(), fullScreen: target.isFullScreen() };
});

// --------------------------------------------------------------- lifecycle --

/**
 * Protect the profile across versions: back up before a different version
 * opens it, and confirm a downgrade first. Returns false to stop the launch.
 */
async function protectProfile() {
  if (isDev) return true;
  const version = releaseVersion;
  const lastVersion = memory.read().lastVersion;
  const transition = versionTransition(lastVersion, version);
  if (transition === 'same') return true;
  const database = path.join(profileDir, DATABASE_FILE);
  if (transition === 'downgrade') {
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: 'OpenAgents',
      message: `This profile was last opened by OpenAgents ${lastVersion}.`,
      detail: `You are starting ${version}, which is older. An older version may not understand data saved by a newer one. A backup of your data is taken before continuing.`,
      buttons: ['Quit', 'Continue with this version'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response !== 1) return false;
  }
  // No recorded version but a database present is an upgrade from a build
  // that predates this record - exactly the case worth a backup.
  if (fs.existsSync(database)) {
    try {
      const result = backupDatabase({ dataDir: profileDir, fromVersion: lastVersion ?? 'earlier', toVersion: version });
      shellLog(result.status === 'created' ? `backed up the database to ${result.file}` : `database backup skipped: ${result.reason}`);
    } catch (error) {
      shellLog(`database backup failed: ${error?.message ?? error}`);
    }
  }
  return true;
}

// A second instance should raise the first window, not start a second daemon.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    // Windows groups taskbar buttons and picks the icon by this id. Without it
    // the app inherits Electron's, and pinning it to the taskbar pins Electron.
    if (process.platform === 'win32') app.setAppUserModelId('dev.openhours.cortex');

    const dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    logFile = new LogFile(logsDir(), { secrets });
    settings = settingsStore(dataDir);
    memory = stateStore(dataDir);
    // The database and config belong to the USER, not to the installation.
    // An installed app's directory is read-only for a normal account, and
    // anything written beside the binary is lost on the next update.
    profileDir = isDev ? (process.env.OPENHOURS_DATA_DIR ?? path.join(appRoot, 'data')) : dataDir;
    if (!isDev && currentSettings().startDockerAutomatically) process.env.OPENHOURS_AUTO_SETUP = '1';
    seedConfigTemplate(dataDir);

    if (!(await protectProfile())) {
      quitting = true;
      app.exit(0);
      return;
    }

    windowState = windowStateStore(dataDir);

    supervisor = new DaemonSupervisor({
      appRoot,
      requiredBrowserRuntime: 'bot-desktop-v1',
      dataDir: profileDir,
      // The development daemon deliberately runs from the profile directory so
      // relative config and workspace paths stay inside that profile. Point it at
      // the repository credential file explicitly instead of depending on cwd.
      envFile: isDev && fs.existsSync(path.join(appRoot, '.env')) ? path.join(appRoot, '.env') : undefined,
      port: preferredPort,
      portPolicy,
      rememberedPort: portPolicy === 'auto' ? memory.read().port ?? null : null,
      onPortChosen: (port) => { if (portPolicy === 'auto') memory.update({ port }); },
      onLog: (line) => {
        logLines.push(line);
        if (logLines.length > 500) logLines.shift();
        // Echoed as well as forwarded. The in-app panel is the right place to
        // read this normally, but a daemon that fails BEFORE the window can
        // show it leaves nothing behind at all.
        console.log(`[daemon] ${line}`);
        logFile?.write(line, 'daemon');
        send('daemon:log', line);
      },
      onState: (state) => {
        daemonState = state;
        shellLog(`daemon ${state.status}${state.detail ? `: ${state.detail}` : ''}`);
        send('daemon:state', state);
        tray?.rebuild();
        if (state.status !== 'running' && state.status !== 'attached') return;
        if (!isDev && memory.read().lastVersion !== releaseVersion) memory.update({ lastVersion: releaseVersion });
        // A serving daemon is the moment a window on the startup screen - or
        // stranded on a page the guard refused - can move to the interface.
        if (mainWindow && !showingInterface()) goHome('daemon is serving');
      },
    });
    daemonState = supervisor.state;

    Menu.setApplicationMenu(
      buildApplicationMenu({
        isDev,
        onCheckUpdates: () => { void offerUpdate(); },
        onCopyDiagnostics: () => { clipboard.writeText(buildDiagnostics()); },
        onOpenLogs: () => { fs.mkdirSync(logsDir(), { recursive: true }); void shell.openPath(logsDir()); },
        onAbout: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: 'OpenAgents',
            message: `OpenAgents ${releaseVersion}`,
            detail:
              `Electron ${process.versions.electron}\n` +
              `Chromium ${process.versions.chrome}\n` +
              `Node ${process.versions.node}\n\n` +
              `Server port ${supervisor?.port ?? preferredPort}`,
            buttons: ['OK'],
          });
        },
      })
    );

    hardenSession();

    try {
      tray = createTray({
        iconPath,
        getState: () => ({ daemon: daemonState, settings: currentSettings(), canOpenAtLogin }),
        onOpen: showWindow,
        onRestart: () => { void supervisor.restart(); },
        onSettings: (patch) => { applySettings(patch); },
        onCopyDiagnostics: () => { clipboard.writeText(buildDiagnostics()); tray?.notify('Diagnostics copied', 'Keys and tokens were removed. Paste them into your report.'); },
        onOpenLogs: () => { fs.mkdirSync(logsDir(), { recursive: true }); void shell.openPath(logsDir()); },
        onQuit: quitApp,
      });
    } catch (error) {
      // No tray (some Linux desktops): closing the window quits, as it always did.
      tray = null;
      shellLog(`no tray icon: ${error?.message ?? error}`);
    }

    applyLoginItem(currentSettings().openAtLogin);
    createWindow();
    if (!isDev) {
      try {
        const { probeDocker } = await import(pathToFileURL(path.join(appRoot, 'dist/src/daemon/docker-status.js')).href);
        const { resolveDockerHost } = await import(pathToFileURL(path.join(appRoot, 'dist/src/kernel/docker-host.js')).href);
        await preserveDockerTransport({ directory: profileDir, previousVersion: memory.read().lastVersion,
          probeLegacy: () => probeDocker(resolveDockerHost({ ...process.env, OPENHOURS_WSL_DISTRO: 'Ubuntu-22.04' }), 15_000, true),
          probeNative: () => probeDocker(resolveDockerHost({ ...process.env, OPENHOURS_WSL_DISTRO: undefined }), 15_000, true) });
      } catch (error) { shellLog(`Docker transport selection: ${error.message}`); }
    }
    // Started after the window so the person watches it come up rather than
    // staring at nothing for the boot's several seconds.
    void supervisor.start();
    void checkDocker();
    setupTimer = setInterval(() => {
      if (!quitting && currentSettings().startDockerAutomatically) void checkDocker();
    }, 60_000);
    setupTimer.unref();

    // After sleep the server may be gone or wedged; ask now, not in a minute.
    powerMonitor.on('resume', () => { shellLog('computer resumed'); void supervisor.checkNow(); void checkDocker(); });
    powerMonitor.on('unlock-screen', () => { void supervisor.checkNow(); });

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    if (tray && currentSettings().keepRunningInBackground && !quitting) return;
    app.quit();
  });

  app.on('before-quit', (event) => {
    quitting = true;
    clearInterval(setupTimer);
    // Stop even a daemon we did not start the clock on: a pending restart must
    // not spawn one while the app is on its way out.
    if (!supervisor || supervisor.stopping) {
      tray?.destroy();
      tray = null;
      logFile?.close();
      return;
    }
    event.preventDefault();
    void supervisor.stop().finally(() => {
      tray?.destroy();
      tray = null;
      logFile?.close();
      app.quit();
    });
  });
}
