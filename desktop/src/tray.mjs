/**
 * The tray icon.
 *
 * OpenAgents runs routines on a schedule, and a schedule means nothing if
 * closing a window stops it. So by default closing the window hides it and the
 * app keeps running here - which is only acceptable if it is obvious: the icon
 * is always present, it says what the server is doing, and Quit is one click.
 */

import { Menu, Tray, nativeImage } from 'electron';

export function describeServer(state) {
  switch (state?.status) {
    case 'running':
    case 'attached':
      return 'Server running';
    case 'checking':
    case 'starting':
      return 'Server starting…';
    case 'restarting':
      return 'Server restarting…';
    case 'failed':
      return 'Server not running';
    case 'stopped':
      return 'Server stopped';
    default:
      return 'Server status unknown';
  }
}

/**
 * @param {object} options
 * @param {string} options.iconPath
 * @param {() => { daemon: object, settings: object, canOpenAtLogin: boolean }} options.getState
 * @param {() => void} options.onOpen
 * @param {() => void} options.onRestart
 * @param {(patch: object) => void} options.onSettings
 * @param {() => void} options.onCopyDiagnostics
 * @param {() => void} options.onOpenLogs
 * @param {() => void} options.onQuit
 */
export function createTray({ iconPath, getState, onOpen, onRestart, onSettings, onCopyDiagnostics, onOpenLogs, onQuit }) {
  // On Windows the .ico goes in as a path so the shell picks its own 16px
  // frame; scaling the 256px frame down by hand looks soft at tray size.
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(process.platform === 'win32' || image.isEmpty() ? iconPath : image.resize({ width: 16, height: 16, quality: 'best' }));

  const rebuild = () => {
    const { daemon, settings, canOpenAtLogin } = getState();
    const busy = ['checking', 'starting'].includes(daemon?.status);
    tray.setToolTip(`OpenAgents — ${describeServer(daemon)}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open OpenAgents', click: onOpen },
      { type: 'separator' },
      { label: describeServer(daemon), enabled: false },
      { label: 'Restart server', enabled: !busy, click: onRestart },
      { type: 'separator' },
      {
        label: 'Keep running when the window is closed',
        type: 'checkbox',
        checked: settings.keepRunningInBackground,
        click: (item) => onSettings({ keepRunningInBackground: item.checked }),
      },
      {
        label: 'Start OpenAgents when I sign in',
        type: 'checkbox',
        checked: settings.openAtLogin,
        enabled: canOpenAtLogin,
        click: (item) => onSettings({ openAtLogin: item.checked }),
      },
      {
        label: 'Start Docker Desktop when needed',
        type: 'checkbox',
        checked: settings.startDockerAutomatically,
        click: (item) => onSettings({ startDockerAutomatically: item.checked }),
      },
      { type: 'separator' },
      { label: 'Copy diagnostics', click: onCopyDiagnostics },
      { label: 'Open logs folder', click: onOpenLogs },
      { type: 'separator' },
      { label: 'Quit OpenAgents', click: onQuit },
    ]));
  };

  // Windows convention: a click on a tray icon opens the app. The menu is the
  // right click.
  if (process.platform === 'win32') tray.on('click', onOpen);
  tray.on('double-click', onOpen);
  rebuild();

  return {
    rebuild,
    notify(title, content) {
      try {
        if (process.platform === 'win32') tray.displayBalloon({ iconType: 'info', title, content });
      } catch {
        // A balloon is a courtesy; a system that refuses it changes nothing.
      }
    },
    destroy: () => tray.destroy(),
  };
}
