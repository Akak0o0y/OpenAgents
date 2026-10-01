/**
 * A fenced code block, with the two things a reader actually wants from one.
 *
 * WHAT IT SAYS. Models label their fences - ```python, ```bash - and that label
 * was being parsed into a class name and then thrown away. Showing it is free
 * and it is the difference between "some code" and "a shell command you are
 * about to run".
 *
 * WHAT IT DOES. Code in a chat exists to be used somewhere else, so the only
 * interaction that matters is getting it out. Selecting a scrolling block by
 * dragging is fiddly and silently truncates at the fold; a copy button cannot.
 *
 * The copy state is deliberately transient rather than a toast: the feedback
 * belongs where the click happened, and a notification for something this small
 * is noise.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons.js';

/**
 * The text of a code fence, from React children.
 *
 * react-markdown hands over an element tree, not a string - a fence containing
 * a blank line arrives as several children. Walking it is what makes the copied
 * text match what is on screen rather than only its first paragraph.
 */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

/** `language-python` -> `python`. Absent for an unlabelled fence. */
function languageOf(node: ReactNode): string | null {
  if (typeof node !== 'object' || node === null || !('props' in node)) return null;
  const className = (node as { props?: { className?: string } }).props?.className ?? '';
  return /language-([\w-]+)/.exec(className)?.[1] ?? null;
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const language = languageOf(children);
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const copy = useCallback(() => {
    // Read from the DOM rather than the React tree: what is on screen is the
    // thing the person means, and it is already assembled.
    const text = preRef.current?.textContent ?? textOf(children);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        // A browser that refuses the clipboard is not an error worth a dialog;
        // the code is still selectable.
        setCopied(false);
      });
  }, [children]);

  return (
    <div className="grok-code">
      <div className="grok-code-head">
        <span className="grok-code-lang">{language ?? 'text'}</span>
        <button
          type="button"
          className="grok-code-copy"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          <Icon name={copied ? 'done' : 'copy'} size={13} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
