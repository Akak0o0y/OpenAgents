/**
 * Application shortcuts.
 *
 * The property that matters most is the one that is infuriating when wrong: a
 * BARE key must not fire while somebody is typing, or the shortcut eats the
 * character mid-word. A MODIFIED key must fire everywhere, because nobody types
 * Ctrl+K into a sentence.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useHotkey } from './useHotkey.js';

afterEach(cleanup);

function press(key: string, init: Partial<KeyboardEventInit> & { target?: Element } = {}) {
  const { target, ...rest } = init;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...rest });
  (target ?? window).dispatchEvent(event);
  return event;
}

describe('a modified shortcut', () => {
  it('fires on either Control or Command', () => {
    const run = vi.fn();
    renderHook(() => useHotkey({ key: 'k', mod: true }, run));

    press('k', { ctrlKey: true });
    press('k', { metaKey: true });

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('claims the key from the browser', () => {
    renderHook(() => useHotkey({ key: 'k', mod: true }, () => undefined));
    // Ctrl+K focuses the address bar in a browser; without preventDefault the
    // app's shortcut silently loses.
    expect(press('k', { ctrlKey: true }).defaultPrevented).toBe(true);
  });

  it('fires even while typing', () => {
    const run = vi.fn();
    renderHook(() => useHotkey({ key: 'k', mod: true }, run));

    const input = document.createElement('input');
    document.body.append(input);
    press('k', { ctrlKey: true, target: input });

    expect(run).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('does not fire without the modifier', () => {
    const run = vi.fn();
    renderHook(() => useHotkey({ key: 'k', mod: true }, run));
    press('k');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('a bare shortcut', () => {
  it('is suppressed while typing, so it cannot eat the character', () => {
    const run = vi.fn();
    renderHook(() => useHotkey({ key: '/' }, run));

    const input = document.createElement('input');
    document.body.append(input);
    press('/', { target: input });

    expect(run).not.toHaveBeenCalled();
    input.remove();
  });

  it('fires outside a text field', () => {
    const run = vi.fn();
    renderHook(() => useHotkey({ key: '/' }, run));
    press('/');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('enablement', () => {
  it('does nothing while disabled', () => {
    const run = vi.fn();
    renderHook(() => useHotkey({ key: 'k', mod: true }, run, false));
    press('k', { ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    const run = vi.fn();
    const { unmount } = renderHook(() => useHotkey({ key: 'k', mod: true }, run));
    unmount();
    press('k', { ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });
});
