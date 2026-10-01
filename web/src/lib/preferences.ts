/**
 * Browser-local preferences.
 *
 * Deliberately small. Everything about a BOT lives on the daemon (see
 * botProfile.ts); this file holds only things that are genuinely about this
 * browser: the theme, the label this operator wants shown in the sidebar, and
 * the timezone new routines should be created in.
 *
 * Every read is defensive. A browser with storage disabled, or a value written
 * by an older build, must not be able to stop the workspace rendering.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type CodeThemePreference = 'openhours' | 'vs-dark' | 'vs-light' | 'monokai' | 'github-dark' | 'one-dark';

export interface Preferences {
  theme: ThemePreference;
  codeTheme: CodeThemePreference;
  accountName: string;
  routineTimezone: string;
}

export const CODE_THEME_OPTIONS: Array<{ id: CodeThemePreference; label: string; description: string }> = [
  { id: 'openhours', label: 'OpenAgents', description: 'Our warm paper and charcoal palette. Follows the app appearance.' },
  { id: 'vs-dark', label: 'VS Code Dark+', description: 'Default dark theme matching Visual Studio Code' },
  { id: 'vs-light', label: 'VS Code Light', description: 'Clean light theme matching Visual Studio Code' },
  { id: 'monokai', label: 'Monokai', description: 'High-contrast classic developer theme' },
  { id: 'github-dark', label: 'GitHub Dark', description: 'GitHub dark modern theme' },
  { id: 'one-dark', label: 'One Dark Pro', description: 'Atom and One Dark inspired editor palette' },
];

const STORAGE_KEY = 'openhours.preferences.v1';

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultPreferences(): Preferences {
  return { theme: 'light', codeTheme: 'openhours', accountName: 'Operator', routineTimezone: systemTimezone() };
}

export function readPreferences(): Preferences {
  const fallback = defaultPreferences();
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return fallback;
    // Open the redesigned app in paper once, then respect subsequent choices.
    const theme = raw.appearanceVersion === 2 ? raw.theme : 'light';
    const codeTheme = raw.appearanceVersion === 2 ? raw.codeTheme : 'openhours';
    const validCodeTheme: CodeThemePreference =
      codeTheme === 'openhours' || codeTheme === 'vs-dark' || codeTheme === 'vs-light' || codeTheme === 'monokai' || codeTheme === 'github-dark' || codeTheme === 'one-dark'
        ? codeTheme
        : fallback.codeTheme;
    return {
      theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : fallback.theme,
      codeTheme: validCodeTheme,
      accountName:
        typeof raw.accountName === 'string' && raw.accountName.trim()
          ? raw.accountName.slice(0, 40)
          : fallback.accountName,
      routineTimezone:
        typeof raw.routineTimezone === 'string' && raw.routineTimezone.trim()
          ? raw.routineTimezone.slice(0, 64)
          : fallback.routineTimezone,
    };
  } catch {
    return fallback;
  }
}

export function writePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...preferences, appearanceVersion: 2 }));
  } catch {
    // A browser that refuses storage still gets a working session; the
    // preference simply does not survive a reload.
  }
}

/**
 * Apply the theme to the document.
 *
 * `system` normally removes the attribute entirely so the stylesheet's own
 * prefers-color-scheme rules decide, rather than this code trying to predict
 * them and getting out of step when the OS setting changes mid-session.
 *
 * THE DESKTOP SHELL IS THE EXCEPTION, and not as a nicety. Inside the Electron
 * window `prefers-color-scheme` has been observed reporting `light` while
 * Windows is set to dark and Electron's own `nativeTheme.shouldUseDarkColors`
 * correctly reports dark. "Follow system" then followed the wrong signal and
 * the whole app came up white on a dark desktop.
 *
 * So where a resolved system theme is supplied - which only the shell can do,
 * because only the shell can ask the OS - it wins over the media query. In a
 * real browser nothing is supplied, the attribute comes off, and the media
 * query decides as before; there it is the only signal there is, and it is
 * reliable.
 */
export function applyTheme(theme: ThemePreference, systemTheme?: 'light' | 'dark' | null): void {
  const root = document.documentElement;
  if (theme !== 'system') {
    root.setAttribute('data-theme', theme);
    return;
  }
  if (systemTheme === 'light' || systemTheme === 'dark') {
    root.setAttribute('data-theme', systemTheme);
    return;
  }
  root.removeAttribute('data-theme');
}

/**
 * Apply the code editor theme to the document.
 */
export function applyCodeTheme(theme: CodeThemePreference): void {
  const root = document.documentElement;
  root.setAttribute('data-code-theme', theme);
}
