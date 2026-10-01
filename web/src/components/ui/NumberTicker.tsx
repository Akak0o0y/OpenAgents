/**
 * A number that counts to its value instead of appearing at it.
 *
 * Adapted from Magic UI's NumberTicker (magicui.design, MIT). Theirs is a
 * Tailwind component that animates an integer with a spring and writes the
 * result straight into a span; this one takes a formatter, because every number
 * it is used on here is a token count that has to read as `9.20B` rather than
 * `9,203,847,112`.
 *
 * WHY THIS ONE EARNS ITS PLACE. Most of Magic UI is decoration - meteors,
 * sparkles, aurora text - and decoration is exactly what this palette is not
 * for. A counting number is different: it draws the eye to the figure that
 * CHANGED, which on a usage screen is the one thing you came to look at. The
 * motion carries information.
 *
 * It respects `prefers-reduced-motion` by simply rendering the final value.
 * There is no reduced version of this animation worth having - the number is
 * the point, and the count is the flourish.
 *
 * WHICH IS WHY IT STARTS AT THE VALUE, not at zero. An earlier version began at
 * zero and climbed on mount, and its failure mode was showing `0` forever:
 * Chromium suspends requestAnimationFrame in an occluded window, so a figure
 * opened behind another window never counted and never arrived. A flourish that
 * can silently replace the number with a wrong one is not worth having either.
 *
 * So the first render is the truth, and the count happens when the value
 * CHANGES - which is also when it carries information, because the movement is
 * then pointing at what is different rather than decorating what was always
 * there.
 */

import { useEffect, useRef, useState } from 'react';
import { formatCount } from '../../lib/numbers.js';

interface NumberTickerProps {
  value: number;
  /** How the value is rendered at every step, not just at the end. */
  format?: (value: number) => string;
  /** Total duration in ms. */
  duration?: number;
  className?: string;
}

/**
 * Ease-out cubic.
 *
 * Chosen over a spring: a spring overshoots, and a number that goes past its
 * value and comes back reads as a glitch rather than a flourish when the value
 * is a real quantity someone might be reading as it settles.
 */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function NumberTicker({
  value,
  format = formatCount,
  duration = 900,
  className,
}: NumberTickerProps) {
  // The truth, immediately. Everything below only ever animates away from a
  // correct number towards another correct number.
  const [shown, setShown] = useState(value);
  const frame = useRef<number | null>(null);
  /** What the last completed render showed, and where the next count starts. */
  const from = useRef(value);

  useEffect(() => {
    const origin = from.current;
    if (value === origin) return;

    if (prefersReducedMotion()) {
      from.current = value;
      setShown(value);
      return;
    }

    const start = performance.now();
    const delta = value - origin;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setShown(origin + delta * easeOut(t));
      if (t < 1) {
        frame.current = requestAnimationFrame(step);
      } else {
        from.current = value;
      }
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // An unmount or a new value mid-count leaves `from` at the target rather
      // than at whatever frame it reached, so the next count starts from a
      // number that was actually displayed and settled.
      from.current = value;
      setShown(value);
    };
  }, [value, duration]);

  return (
    // Tabular figures, so the text does not reflow on every frame as digits
    // of different widths pass through.
    <span className={className} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {format(shown)}
    </span>
  );
}
