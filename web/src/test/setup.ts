/**
 * Test environment shims.
 *
 * jsdom does not implement `matchMedia`, `scrollIntoView`, `ResizeObserver` or
 * `clipboard`, all of which the workspace uses. They are stubbed here rather
 * than guarded in production code: the components should be allowed to assume a
 * browser, and a test harness that lacks one is the harness's problem.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => undefined);

// jsdom implements neither of these on Element. assistant-ui's thread viewport
// calls scrollTo on every render that changes the message list, so without the
// stub every test touching it throws asynchronously - passing the assertions
// while filling the run with uncaught errors.
Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => undefined);
Element.prototype.scrollBy = Element.prototype.scrollBy ?? (() => undefined);
Element.prototype.getAnimations = Element.prototype.getAnimations ?? (() => []);

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});
