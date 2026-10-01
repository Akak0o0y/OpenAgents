/**
 * The parts of "feeling like an application" that live in the main process.
 *
 * An Electron window is a browser until you take the browser out of it. None of
 * what follows is cosmetic - each one is a specific behaviour that tells a user
 * they are looking at a web page:
 *
 *   ZOOM.          Ctrl+scroll and Ctrl+plus resize the entire interface, the
 *                  way they resize a document. No desktop application does
 *                  this; they change a font size setting instead, if at all.
 *   RELOAD.        Ctrl+R throws the interface away and rebuilds it, and there
 *                  is a visible flash while it does. Applications do not have
 *                  a reload key, and the ones that do are telling you what they
 *                  are made of.
 *   THE MENU.      Electron's stock menu is a browser's menu - Reload, Force
 *                  Reload, Toggle Developer Tools, Zoom In. Shipping it is
 *                  shipping the browser's UI as your own.
 *   CONTEXT MENU.  Electron ships none at all, which is worse than the wrong
 *                  one: right-clicking a text field in a real application
 *                  offers Cut, Copy and Paste, and here it offered nothing.
 *   GEOMETRY.      An application opens where you left it. A web page opens
 *                  wherever the browser decides.
 *
 * The developer affordances are kept in development and removed in production,
 * because in development this IS a web page and pretending otherwise wastes
 * everyone's time.
 */

import { Menu, MenuItem, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// --------------------------------------------------------------- geometry ---

/**
 * Remember where the window was.
 *
 * Stored beside the rest of the app's own state rather than in the daemon's
 * database: it is a property of this machine's screen, not of the fleet, and it
 * must be readable before anything else has started.
 */
export function windowStateStore(userDataPath) {
  const file = path.join(userDataPath, 'window-state.json');

  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!raw || typeof raw !== 'object') return null;
      const { x, y, width, height, maximized } = raw;
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      return {
        x: Number.isFinite(x) ? x : undefined,
        y: Number.isFinite(y) ? y : undefined,
        width,
        height,
        maximized: Boolean(maximized),
      };
    } catch {
      return null;
    }
  };

  /**
   * Is the remembered position still on a screen that exists?
   *
   * Unplugging a second monitor otherwise leaves the window restored to
   * coordinates nobody can see, and the app looks like it failed to launch.
   */
  const onAVisibleDisplay = (bounds) => {
    if (bounds.x === undefined || bounds.y === undefined) return false;
    return screen.getAllDisplays().some((display) => {
      const a = display.workArea;
      // A generous overlap test: the titlebar has to be reachable, not the
      // whole window visible.
      return (
        bounds.x < a.x + a.width - 80 &&
        bounds.x + bounds.width > a.x + 80 &&
        bounds.y < a.y + a.height - 40 &&
        bounds.y + bounds.height > a.y
      );
    });
  };

  return {
    /** Constructor options for the remembered geometry, or {} for a first run. */
    restore(defaults) {
      const saved = read();
      if (!saved) return defaults;
      const bounds = {
        width: Math.max(defaults.minWidth ?? 0, saved.width),
        height: Math.max(defaults.minHeight ?? 0, saved.height),
        x: saved.x,
        y: saved.y,
      };
      if (!onAVisibleDisplay(bounds)) {
        // Keep the size, drop the position, and let the OS centre it.
        return { ...defaults, width: bounds.width, height: bounds.height };
      }
      return { ...defaults, ...bounds, wasMaximized: saved.maximized };
    },

    /** Persist on move/resize/maximize, coalesced so a drag is one write. */
    track(win) {
      let timer = null;
      const save = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (win.isDestroyed()) return;
          // getNormalBounds is the un-maximized geometry, which is what should
          // come back when the window is un-maximized later.
          const bounds = win.getNormalBounds();
          const state = { ...bounds, maximized: win.isMaximized() };
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(state, null, 2));
          } catch {
            // A window that cannot remember where it was is not a reason to
            // stop working.
          }
        }, 400);
      };
      for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, save);
      win.on('close', save);
    },
  };
}

// ------------------------------------------------------------------- menu ---

/**
 * The application menu.
 *
 * Built from roles rather than hand-wired accelerators, because the roles are
 * what make Cut/Copy/Paste work at all on macOS - without an Edit menu those
 * keystrokes do nothing there, which is a bug people report as "copy is
 * broken". The browser items (Reload, Force Reload, Toggle DevTools, the zoom
 * family) are simply absent in production.
 */
export function buildApplicationMenu({ isDev, onAbout, onCheckUpdates, onCopyDiagnostics, onOpenLogs }) {
  const isMac = process.platform === 'darwin';

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [];

  if (isMac) {
    template.push({
      label: 'OpenAgents',
      submenu: [
        { label: 'About OpenAgents', click: onAbout },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: '&File',
    submenu: isMac ? [{ role: 'close' }] : [{ role: 'quit', label: 'Exit' }],
  });

  template.push({
    label: '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: '&View',
    submenu: [
      // Deliberately NOT reload, force-reload or the zoom family. Full screen
      // is a window state every desktop application has; the others are
      // browser controls.
      { role: 'togglefullscreen' },
      ...(isDev
        ? [
            { type: 'separator' },
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
          ]
        : []),
    ],
  });

  template.push({
    label: '&Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
    ],
  });

  template.push({
    role: 'help',
    submenu: [
      ...(isMac ? [] : [{ label: 'About OpenAgents', click: onAbout }]),
      ...(onCheckUpdates ? [{ label: 'Check for updates', click: onCheckUpdates }] : []),
      // What support asks for first. Both are safe to share: the log and the
      // diagnostics have keys, tokens and the home folder removed.
      ...(onCopyDiagnostics ? [{ type: 'separator' }, { label: 'Copy diagnostics', click: onCopyDiagnostics }] : []),
      ...(onOpenLogs ? [{ label: 'Open logs folder', click: onOpenLogs }] : []),
      { type: 'separator' },
      {
        label: 'Project on GitHub',
        click: () => void shell.openExternal('https://github.com/'),
      },
    ],
  });

  return Menu.buildFromTemplate(template);
}

// ----------------------------------------------------------- context menu ---

/**
 * A right-click menu for text.
 *
 * Only for editable fields and actual selections. Everywhere else the interface
 * has its own context menus - on a message, on a bot - and a second one
 * appearing underneath would be worse than none.
 */
export function attachContextMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();
    const hasSelection = params.selectionText.trim().length > 0;

    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'undo' }));
      menu.append(new MenuItem({ role: 'redo' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'cut', enabled: hasSelection }));
      menu.append(new MenuItem({ role: 'copy', enabled: hasSelection }));
      menu.append(new MenuItem({ role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    } else if (hasSelection) {
      menu.append(new MenuItem({ role: 'copy' }));
    } else {
      return;
    }

    if (params.linkURL) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: 'Open Link in Browser',
          click: () => void shell.openExternal(params.linkURL),
        })
      );
    }

    menu.popup();
  });
}

// ------------------------------------------------------------------- zoom ---

/**
 * Take the browser's zoom out of the window.
 *
 * Three separate mechanisms, because they are three separate code paths and
 * disabling one leaves the others: pinch zoom on a trackpad, Ctrl+scroll, and
 * the Ctrl+plus/minus/0 accelerators. The accelerators mostly disappear with
 * the stock menu, but a key handler is what makes that certain.
 */
export function disableZoom(webContents) {
  void webContents.setVisualZoomLevelLimits(1, 1);
  webContents.setZoomFactor(1);

  webContents.on('zoom-changed', () => {
    webContents.setZoomFactor(1);
  });

  webContents.on('before-input-event', (event, input) => {
    if (!input.control && !input.meta) return;
    const key = input.key;
    if (key === '+' || key === '-' || key === '=' || key === '0') {
      // Only when it is really the zoom family; Ctrl+0 is not used for anything
      // else here, and Ctrl+- likewise.
      event.preventDefault();
      webContents.setZoomFactor(1);
    }
  });
}
