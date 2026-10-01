/**
 * Application keyboard shortcuts.
 *
 * WHY A HOOK AND NOT A `keydown` IN EACH COMPONENT. A shortcut is global by
 * nature - ⌘K has to work while the focus is in the composer, in the sidebar,
 * or nowhere at all - so it belongs on the window, and every listener on the
 * window has to be removed again. Doing that once, correctly, is cheaper than
 * doing it in each component that wants a key.
 *
 * MODIFIER NAMING. `mod` is Command on macOS and Control everywhere else. Both
 * are the platform's "application shortcut" key, and hard-coding either one
 * makes the app feel foreign on the other.
 */

import { useEffect, useRef } from 'react';

export interface Hotkey {
  /** A single character, compared case-insensitively, or a named key. */
  key: string;
  /** Command on macOS, Control elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

function matches(event: KeyboardEvent, hotkey: Hotkey): boolean {
  const mod = event.metaKey || event.ctrlKey;
  if (Boolean(hotkey.mod) !== mod) return false;
  if (Boolean(hotkey.shift) !== event.shiftKey) return false;
  if (Boolean(hotkey.alt) !== event.altKey) return false;
  return event.key.toLowerCase() === hotkey.key.toLowerCase();
}

/**
 * Is the person typing?
 *
 * A shortcut WITH a modifier is safe everywhere - nobody types ⌘K into a
 * sentence. A bare key is not: `/` or `n` as a shortcut would swallow those
 * characters mid-word, which is the single most infuriating thing a keyboard
 * shortcut can do. So bare keys are suppressed in text entry and modified ones
 * are not.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * Run `handler` when the hotkey is pressed anywhere in the window.
 *
 * `enabled` exists so a shortcut can be registered unconditionally - hooks
 * cannot be - while only being live when it makes sense, such as suppressing
 * ⌘K while a modal already owns the screen.
 */
export function useHotkey(hotkey: Hotkey, handler: () => void, enabled = true): void {
  // The handler is kept in a ref so a caller passing an inline arrow function
  // does not re-bind the listener on every render.
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!matches(event, hotkey)) return;
      if (!hotkey.mod && !hotkey.alt && isTyping(event.target)) return;
      // Claimed before the browser sees it: Ctrl+K is "focus the address bar"
      // in a browser tab, and without this the app's shortcut silently loses.
      event.preventDefault();
      latest.current();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkey.key, hotkey.mod, hotkey.shift, hotkey.alt, enabled]);
}

/** The modifier's name, for showing a shortcut in the interface. */
export function modLabel(): string {
  const mac =
    typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  return mac ? '⌘' : 'Ctrl';
}
