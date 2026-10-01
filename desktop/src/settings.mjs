/**
 * The desktop app's own settings and memory.
 *
 * Two files, on purpose:
 *
 *   desktop-settings.json  choices a person made - keep running in the
 *                          background, start at sign-in, start Docker.
 *   desktop-state.json     what the app remembers for itself - the port it
 *                          last used, the version that last opened this
 *                          profile, hints it has already shown.
 *
 * Neither belongs in the daemon's database: both must be readable before the
 * daemon exists, and the port is how the app finds the daemon at all.
 *
 * Every read is defensive and every write is atomic. A half-written or
 * hand-edited file must degrade to defaults, never stop the app opening.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  /**
   * On by default. Routines are the point of a bot that works while you are
   * away; closing a window is not a request to stop them. The tray says it is
   * still running, and Quit is always one click away.
   */
  keepRunningInBackground: true,
  /**
   * Off by default. Registering itself to run at sign-in is something an app
   * should be asked to do - and an unsigned app that quietly adds an autorun
   * entry is exactly what antivirus heuristics look for.
   */
  openAtLogin: false,
  /** Docker Desktop is started when the sandbox needs it and it is stopped. */
  startDockerAutomatically: true,
  themePreference: 'light',
});

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

export function resolveAppTheme(preference, systemDark) {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference === 'dark' ? 'dark' : 'light';
}

function readJson(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Write through a temporary file and rename, so a crash mid-write leaves the old file. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function sanitizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    if (typeof DEFAULT_SETTINGS[key] === 'boolean' && typeof raw?.[key] === 'boolean') settings[key] = raw[key];
  }
  if (['light', 'dark', 'system'].includes(raw?.themePreference)) settings.themePreference = raw.themePreference;
  return settings;
}

export function sanitizeState(raw) {
  const state = {};
  if (Number.isInteger(raw?.port) && raw.port > 0 && raw.port <= 65535) state.port = raw.port;
  if (typeof raw?.lastVersion === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}/.test(raw.lastVersion)) state.lastVersion = raw.lastVersion;
  if (typeof raw?.backgroundHintShown === 'boolean') state.backgroundHintShown = raw.backgroundHintShown;
  return state;
}

function store(file, sanitize) {
  let cached = null;
  return {
    file,
    read() {
      if (!cached) cached = sanitize(readJson(file));
      return { ...cached };
    },
    /** Merge, sanitise, persist. A write that fails keeps the change in memory for this session. */
    update(patch) {
      cached = sanitize({ ...this.read(), ...patch });
      try {
        writeJsonAtomic(file, cached);
      } catch (error) {
        console.log(`[shell] could not save ${path.basename(file)}: ${error?.message ?? error}`);
      }
      return { ...cached };
    },
  };
}

export function settingsStore(dataDir) {
  return store(path.join(dataDir, 'desktop-settings.json'), sanitizeSettings);
}

export function stateStore(dataDir) {
  return store(path.join(dataDir, 'desktop-state.json'), sanitizeState);
}
