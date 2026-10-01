/**
 * The counting number.
 *
 * Two properties, both of which fail silently rather than loudly:
 *
 *   Reduced motion must render the FINAL value immediately. A regression here
 *   does not throw - it animates for someone who asked not to be animated at,
 *   which nobody testing on their own machine would notice.
 *
 *   The formatter must be applied at every step, not just at the end. Miss it
 *   and the number reads as raw digits for the whole count and snaps to a
 *   formatted string on the last frame.
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { NumberTicker } from './NumberTicker.js';

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(() => {
  setReducedMotion(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('with reduced motion', () => {
  it('renders the final value immediately, with no count', () => {
    setReducedMotion(true);
    const { rerender } = render(<NumberTicker value={1234} />);
    expect(screen.getByText('1,234')).toBeInTheDocument();
    // And a change lands at once rather than counting.
    rerender(<NumberTicker value={9999} />);
    expect(screen.getByText('9,999')).toBeInTheDocument();
  });

  it('still applies the formatter', () => {
    setReducedMotion(true);
    render(<NumberTicker value={9_200_000_000} format={(v) => `${(v / 1e9).toFixed(2)}B`} />);
    expect(screen.getByText('9.20B')).toBeInTheDocument();
  });
});

/**
 * Animation is DRIVEN here, not waited on.
 *
 * jsdom runs requestAnimationFrame off a timer, so a test that renders and
 * waits is racing a clock it does not control - which is why these were flaky
 * before. Replacing rAF with a queue the test pumps, and a `performance.now`
 * the test advances, makes the count deterministic: every assertion is about
 * the component's arithmetic rather than about how fast the machine ran.
 */
describe('with motion', () => {
  let callbacks: FrameRequestCallback[];
  let now: number;

  beforeEach(() => {
    setReducedMotion(false);
    callbacks = [];
    now = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  /** Advance the clock and run whatever frames were queued for it. */
  const advance = (ms: number) => {
    now += ms;
    const due = callbacks;
    callbacks = [];
    act(() => {
      for (const cb of due) cb(now);
    });
  };

  it('shows the value immediately on mount, without counting to it', () => {
    render(<NumberTicker value={500} duration={100} />);
    // No frames pumped at all - this is the occluded-window case, where
    // requestAnimationFrame never fires. The number must still be right.
    expect(screen.getByText('500')).toBeInTheDocument();
  });

  it('counts when the value CHANGES', () => {
    const { rerender } = render(<NumberTicker value={100} duration={100} />);
    expect(screen.getByText('100')).toBeInTheDocument();

    rerender(<NumberTicker value={200} duration={100} />);
    advance(50);
    const midway = Number(screen.getByText(/\d/).textContent!.replace(/,/g, ''));
    expect(midway).toBeGreaterThan(100);
    expect(midway).toBeLessThan(200);

    advance(50);
    expect(screen.getByText('200')).toBeInTheDocument();
  });

  it('lands on the true value even if no frame ever runs', () => {
    const { rerender } = render(<NumberTicker value={10} duration={100} />);
    rerender(<NumberTicker value={999} duration={100} />);
    // Frames are never pumped. Unmounting settles it rather than stranding it
    // part-way, which is what an occluded window would otherwise do.
    rerender(<NumberTicker value={999} duration={100} />);
    advance(200);
    expect(screen.getByText('999')).toBeInTheDocument();
  });

  it('formats every step, not only the last', () => {
    const format = vi.fn((v: number) => `${Math.round(v)} tokens`);
    const { rerender } = render(<NumberTicker value={0} duration={100} format={format} />);
    rerender(<NumberTicker value={400} duration={100} format={format} />);

    advance(50);
    // Part-way: a real intermediate value, already formatted.
    expect(screen.getByText(/ tokens$/)).toBeInTheDocument();
    const midway = Number(screen.getByText(/ tokens$/).textContent!.replace(' tokens', ''));
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(400);

    advance(50);
    expect(screen.getByText('400 tokens')).toBeInTheDocument();
  });

  it('eases out rather than moving linearly', () => {
    const { rerender } = render(<NumberTicker value={0} duration={100} />);
    rerender(<NumberTicker value={1000} duration={100} />);
    advance(50);
    // Ease-out is more than half way at the half-way point; a linear ramp
    // would be at exactly 500.
    const half = Number(screen.getByText(/\d/).textContent!.replace(/,/g, ''));
    expect(half).toBeGreaterThan(500);
  });

  it('does not animate when the value has not changed', () => {
    const { rerender } = render(<NumberTicker value={7} duration={100} />);
    rerender(<NumberTicker value={7} duration={100} />);
    expect(screen.getByText('7')).toBeInTheDocument();
  });
});
