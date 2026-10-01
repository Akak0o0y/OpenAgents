/**
 * The tooltip layer.
 *
 * The properties that matter are the two a native `title` gets wrong: it must
 * appear on KEYBOARD FOCUS, and the OS one must not also appear. The second is
 * only true if the attribute is actually taken off the element while ours is
 * up - and put back afterwards, because it is the only copy of that text.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { TooltipLayer } from './TooltipLayer.js';

function harness() {
  return render(
    <>
      <button title="Delete this bot" aria-label="Delete">
        x
      </button>
      <TooltipLayer delay={0} />
    </>
  );
}

afterEach(cleanup);

describe('keyboard access', () => {
  it('shows on focus, which a native title never does', async () => {
    harness();
    fireEvent.focusIn(screen.getByRole('button'));

    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Delete this bot');
  });

  it('describes the trigger, so a screen reader reads the two together', async () => {
    harness();
    const button = screen.getByRole('button');
    fireEvent.focusIn(button);

    await screen.findByRole('tooltip');
    expect(button).toHaveAttribute('aria-describedby', 'grok-tooltip-live');
  });
});

describe('the native tooltip', () => {
  it('is suppressed while ours is shown', async () => {
    harness();
    const button = screen.getByRole('button');
    fireEvent.focusIn(button);

    await screen.findByRole('tooltip');
    // Both would otherwise appear, one of them drawn by the OS.
    expect(button).not.toHaveAttribute('title');
  });

  it('is given back afterwards - it is the only copy of that text', async () => {
    harness();
    const button = screen.getByRole('button');
    fireEvent.focusIn(button);
    await screen.findByRole('tooltip');

    fireEvent.focusOut(button);

    await waitFor(() => expect(button).toHaveAttribute('title', 'Delete this bot'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

describe('dismissal', () => {
  it('closes on Escape', async () => {
    harness();
    fireEvent.focusIn(screen.getByRole('button'));
    await screen.findByRole('tooltip');

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    // And the attribute is restored even on this path.
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Delete this bot');
  });

  it('closes on click, because the question has been answered', async () => {
    harness();
    const button = screen.getByRole('button');
    fireEvent.focusIn(button);
    await screen.findByRole('tooltip');

    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });
});

describe('what it leaves alone', () => {
  it('ignores elements with no title', async () => {
    render(
      <>
        <button aria-label="Plain">x</button>
        <TooltipLayer delay={0} />
      </>
    );
    fireEvent.focusIn(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
