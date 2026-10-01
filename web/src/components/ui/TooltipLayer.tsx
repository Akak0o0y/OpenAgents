/**
 * Upgrades every native `title` in the interface to a real tooltip.
 *
 * WHY A LAYER RATHER THAN 41 EDITS. There are forty-one `title` attributes
 * across thirteen files, and wrapping each call site would be forty-one chances
 * to change JSX structure by hand. More importantly it would only fix the ones
 * that exist today: `title="..."` is what everybody reaches for, and the next
 * one written would silently be a native tooltip again. Intercepting the
 * attribute fixes the ones there are and the ones to come.
 *
 * WHAT IT FIXES. A native `title` is drawn by the operating system - wrong
 * font, wrong colours, a delay the page cannot change - and it never appears on
 * keyboard focus at all, so every explanation attached to one is invisible to
 * anybody navigating by Tab. In an app with forty of them that is a lot of
 * hidden text.
 *
 * WHAT COSS DRAWS, AND WHAT THIS STILL DOES. The interception above is the
 * part worth keeping and is unchanged. The tooltip itself is now Coss's
 * `Tooltip`/`TooltipPopup` on Base UI, anchored to the hovered element, which
 * takes over the two things this file did worst: placement and motion. The
 * hand-written version flipped to the bottom when `rect.top < 48` and did
 * nothing about the horizontal axis, so a tooltip on a control near the right
 * edge ran off the window; Base UI flips AND shifts against the real viewport.
 * It also fades in and out rather than appearing, which at a 350ms delay is
 * the difference between a hint and a flicker.
 *
 * THE TRADE-OFF, STATED PLAINLY. This reads and temporarily removes the `title`
 * attribute on hover, which is a DOM mutation on nodes React owns. That is the
 * cost of not touching every call site. It is confined to one attribute, the
 * original is restored on leave, and if React re-renders mid-hover and puts the
 * attribute back the worst case is the OS tooltip appearing once - not a broken
 * control. Bootstrap's tooltip has worked this way for over a decade.
 */

import { useEffect, useRef, useState } from 'react';
import { Tooltip, TooltipPopup } from '@/registry/default/ui/tooltip.js';

interface Shown {
  text: string;
  /** The element the tooltip belongs to. Base UI positions against it. */
  anchor: Element;
}

/** Elements whose `title` is content rather than help, and must be left alone. */
const SKIP = new Set(['IFRAME', 'LINK', 'ABBR']);

export function TooltipLayer({ delay = 350 }: { delay?: number }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<number | null>(null);
  /** The element whose title we borrowed, and the value to give back. */
  const borrowed = useRef<{ el: Element; title: string } | null>(null);

  useEffect(() => {
    const restore = () => {
      const held = borrowed.current;
      if (held) {
        held.el.setAttribute('title', held.title);
        held.el.removeAttribute('aria-describedby');
        borrowed.current = null;
      }
    };

    const clear = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      restore();
      setShown(null);
    };

    const open = (el: Element, immediate: boolean) => {
      const title = el.getAttribute('title');
      if (!title || SKIP.has(el.tagName)) return;

      clear();
      // Taken immediately, so the OS never gets the chance to draw its own
      // while ours is waiting out the delay.
      el.removeAttribute('title');
      el.setAttribute('aria-describedby', 'grok-tooltip-live');
      borrowed.current = { el, title };

      // No coordinates computed here any more - see the note at the top about
      // what Coss's tooltip took over.
      const place = () => setShown({ text: title, anchor: el });

      if (immediate) place();
      else timer.current = window.setTimeout(place, delay);
    };

    const onOver = (event: Event) => {
      const el = (event.target as Element | null)?.closest?.('[title]');
      if (el) open(el, false);
    };
    // Focus shows it at once: somebody who tabbed here is already waiting, and
    // this is the case a native title never covers at all.
    const onFocus = (event: Event) => {
      const el = (event.target as Element | null)?.closest?.('[title]');
      if (el) open(el, true);
    };
    const onOut = (event: Event) => {
      const el = (event.target as Element | null)?.closest?.('[title], [aria-describedby]');
      if (el === borrowed.current?.el || !el) clear();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onOut, true);
    // A click has answered whatever the tooltip was explaining.
    document.addEventListener('click', clear, true);
    window.addEventListener('keydown', onKey);
    // Scrolling moves the trigger out from under a fixed-position tooltip.
    window.addEventListener('scroll', clear, true);

    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onOut, true);
      document.removeEventListener('click', clear, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', clear, true);
      clear();
    };
  }, [delay]);

  // Controls in or near the header/titlebar (within 70px of window top) must
  // place their tooltips below the control, so they never collide with or get
  // sliced by the desktop titlebar.
  const isNearTop =
    shown && typeof shown.anchor.getBoundingClientRect === 'function'
      ? shown.anchor.getBoundingClientRect().top < 70
      : false;

  return (
    <Tooltip open={shown !== null}>
      {shown && (
        <TooltipPopup
          id="grok-tooltip-live"
          // ROLE SET BY HAND, because Base UI does not set it.
          //
          // Its popup is a plain div: the tooltip relationship normally comes
          // from `Tooltip.Trigger`, which wires `aria-describedby` for you.
          // There is no Trigger here - the trigger is whichever element owned
          // the `title` - so this file supplies the description link itself
          // above, and the role has to come with it. Without it a screen
          // reader gets an unlabelled div and the text is announced as loose
          // content, or not at all.
          role="tooltip"
          anchor={shown.anchor}
          side={isNearTop ? 'bottom' : 'top'}
          className="grok-tooltip"
        >
          {shown.text}
        </TooltipPopup>
      )}
    </Tooltip>
  );
}
