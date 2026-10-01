/**
 * A block that folds itself when it is too tall to be worth scrolling past.
 *
 * A model answer can run a full screen. In a transcript that is not just long,
 * it is DESTRUCTIVE: one answer pushes every other message out of view, and the
 * conversation stops reading as a conversation. Folding restores the shape of
 * the exchange while keeping every word one click away.
 *
 * IT MEASURES RATHER THAN GUESSES. A character count is a bad proxy - a table
 * of ten rows is short text and tall layout, a paragraph is the reverse. The
 * only thing that answers "is this too tall" is the rendered height, so the
 * fold appears after layout and never for something that already fits.
 *
 * Content that is already short never renders a control at all, which is the
 * behaviour that keeps this from becoming clutter on every two-line reply.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons.js';

interface CollapsibleProps {
  children: ReactNode;
  /** Fold anything taller than this, in pixels. */
  maxHeight?: number;
  /** Named in the button, so it says what is being expanded. */
  label?: string;
}

export function Collapsible({ children, maxHeight = 420, label = 'message' }: CollapsibleProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    const measure = () => {
      // scrollHeight is the full content height regardless of the clamp, which
      // is exactly the question being asked.
      setOverflows(el.scrollHeight > maxHeight + 24);
    };
    measure();

    // Content arrives late in two ways that both change the answer: images
    // decode, and a web font swaps in and reflows every line.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [maxHeight, children]);

  const folded = overflows && !open;

  return (
    <div className={`grok-collapsible ${folded ? 'folded' : ''}`}>
      <div
        ref={bodyRef}
        className="grok-collapsible-body"
        style={folded ? { maxHeight } : undefined}
      >
        {children}
      </div>

      {overflows && (
        <button
          type="button"
          className="grok-collapsible-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
          {open ? `Show less of this ${label}` : `Show the whole ${label}`}
        </button>
      )}
    </div>
  );
}
