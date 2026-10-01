/**
 * Theme application.
 *
 * The bug this pins: inside the Electron window `prefers-color-scheme` was
 * reporting `light` while Windows was set to dark and Electron's own
 * `nativeTheme` correctly reported dark. "Follow system" trusted the media
 * query, so the whole app came up white on a dark desktop.
 *
 * The fix is that a RESOLVED system theme — which only the shell can supply,
 * because only the shell can ask the OS — outranks the media query. A browser
 * supplies none, the attribute comes off, and the stylesheet decides exactly
 * as before.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { applyTheme } from './preferences.js';

afterEach(() => document.documentElement.removeAttribute('data-theme'));

const attr = () => document.documentElement.getAttribute('data-theme');

describe('an explicit preference', () => {
  it('is stamped on the document and ignores what the shell reports', () => {
    applyTheme('dark', 'light');
    expect(attr()).toBe('dark');

    applyTheme('light', 'dark');
    expect(attr()).toBe('light');
  });
});

describe('"follow system"', () => {
  it('uses the theme the shell resolved from the OS', () => {
    applyTheme('system', 'dark');
    expect(attr()).toBe('dark');

    applyTheme('system', 'light');
    expect(attr()).toBe('light');
  });

  it('defers to the stylesheet when nothing resolved it', () => {
    // A plain browser: no shell to ask, and there the media query is both the
    // only signal and a reliable one.
    applyTheme('system');
    expect(attr()).toBeNull();

    applyTheme('system', null);
    expect(attr()).toBeNull();
  });

  it('clears a previously stamped theme when the shell stops answering', () => {
    applyTheme('system', 'dark');
    expect(attr()).toBe('dark');

    applyTheme('system', null);
    expect(attr()).toBeNull();
  });
});

describe('code editor theme preference', () => {
  afterEach(() => document.documentElement.removeAttribute('data-code-theme'));

  it('applies code theme attribute to document', async () => {
    const { applyCodeTheme } = await import('./preferences.js');
    applyCodeTheme('vs-dark');
    expect(document.documentElement.getAttribute('data-code-theme')).toBe('vs-dark');

    applyCodeTheme('one-dark');
    expect(document.documentElement.getAttribute('data-code-theme')).toBe('one-dark');
  });

  it('defaults to OpenAgents and remembers an alternate editor theme', async () => {
    const { defaultPreferences, readPreferences, writePreferences } = await import('./preferences.js');
    expect(defaultPreferences().codeTheme).toBe('openhours');
    expect(defaultPreferences().theme).toBe('light');

    writePreferences({ ...defaultPreferences(), codeTheme: 'monokai' });
    expect(readPreferences().codeTheme).toBe('monokai');
  });
  it('opens the redesign in light once and then respects a saved dark choice', async () => {
    const { readPreferences, writePreferences } = await import('./preferences.js');
    localStorage.setItem('openhours.preferences.v1', JSON.stringify({ theme: 'system', accountName: 'Aziz' }));
    const migrated = readPreferences();
    expect(migrated.theme).toBe('light');
    expect(migrated.accountName).toBe('Aziz');
    writePreferences({ ...migrated, theme: 'dark' });
    expect(readPreferences().theme).toBe('dark');
    localStorage.clear();
  });
});
