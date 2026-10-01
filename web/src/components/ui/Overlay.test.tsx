/**
 * The keyboard contract for every dialog and menu.
 *
 * Written against the primitives rather than each surface, because that is the
 * point of having primitives: if these hold, Escape, focus containment and
 * focus restoration hold everywhere.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { MenuItem, Modal, Popover } from './Overlay.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/registry/default/ui/select.js';

describe('Modal', () => {
  it('exposes its accessible name and hides the rest of the page', async () => {
    const outside = document.createElement('main');
    outside.innerHTML = '<button>outside</button>';
    document.body.append(outside);

    render(
      <Modal label="Search" onClose={() => undefined}>
        <button>inside</button>
      </Modal>
    );
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeInTheDocument();

    // The MODAL GUARANTEE, asserted rather than the attribute that usually
    // stands in for it. Base UI deliberately does not set `aria-modal` and
    // marks everything outside the dialog `aria-hidden` instead, which is what
    // actually stops assistive tech wandering out.
    await waitFor(() => expect(outside).toHaveAttribute('aria-hidden', 'true'));
    outside.remove();
  });

  it('hides the app behind it, but keeps live regions announceable', async () => {
    // THE SHAPE OF THE REAL APP, because the simple version above hides a
    // surprise. Checking the running app showed `#root` with no `aria-hidden`
    // while a dialog was open, which looks exactly like a missing guarantee.
    //
    // It is not one. Base UI keeps the ancestor path of every `[aria-live]`
    // element exposed so queued announcements are not silenced, and this app
    // has one inside `#root`: the chat transcript in GrokChat. So `#root` stays
    // visible to AT and its children are hidden instead.
    //
    // This test pins both halves. If a future version hides the live region,
    // announcements go silent; if it stops hiding the workspace, a screen
    // reader can walk out of the dialog. Both are regressions, and looking only
    // at `<body>`'s children catches neither.
    const root = document.createElement('div');
    root.id = 'root';
    root.innerHTML =
      '<div class="app"><button>workspace</button></div>' +
      '<div class="log" role="log" aria-live="polite">transcript</div>';
    document.body.append(root);
    const host = document.createElement('div');
    root.append(host);

    render(
      <Modal label="Settings" onClose={() => undefined}>
        <button>inside</button>
      </Modal>,
      { container: host }
    );

    const app = root.querySelector('.app')!;
    const log = root.querySelector('.log')!;
    await waitFor(() => expect(app).toHaveAttribute('aria-hidden', 'true'));
    expect(root).not.toHaveAttribute('aria-hidden');
    expect(log).not.toHaveAttribute('aria-hidden');
    root.remove();
  });

  it('moves focus inside on open', async () => {
    render(
      <Modal label="Search" onClose={() => undefined}>
        <button>first</button>
        <button>second</button>
      </Modal>
    );
    // Base UI moves focus AFTER mount, once the popup is in the document -
    // which is why this waits rather than asserting synchronously.
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());
  });

  it('honours initialFocusSelector', async () => {
    render(
      <Modal label="Search" onClose={() => undefined} initialFocusSelector="input">
        <button>first</button>
        <input aria-label="query" />
      </Modal>
    );
    await waitFor(() => expect(screen.getByLabelText('query')).toHaveFocus());
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal label="Search" onClose={onClose}>
        <button>inside</button>
      </Modal>
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click outside the panel but not inside it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal label="Search" onClose={onClose}>
        <button>inside</button>
      </Modal>
    );
    await user.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(document.querySelector('.grok-modal-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('contains Tab within the dialog', async () => {
    const user = userEvent.setup();
    render(
      <Modal label="Search" onClose={() => undefined}>
        <button>first</button>
        <button>last</button>
      </Modal>
    );
    // Focus lands asynchronously; the trap is only meaningful once it has.
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());
    await user.tab();
    await waitFor(() => expect(screen.getByText('last')).toHaveFocus());

    // Wrapping forward from the last element returns to the first.
    //
    // Base UI traps Tab with focus-GUARD sentinels - hidden spans either side
    // of the content that catch focus and send it back - rather than by
    // cancelling the keystroke. So focus lands on a guard for a tick before it
    // arrives, and asserting synchronously catches it mid-bounce. The
    // guarantee being tested is unchanged: focus never leaves the dialog.
    await user.tab();
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());

    // ...and backwards from the first returns to the last.
    await user.tab({ shift: true });
    await waitFor(() => expect(screen.getByText('last')).toHaveFocus());
  });

  it('restores focus to the control that opened it', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          {open && (
            <Modal label="Search" onClose={() => setOpen(false)}>
              <button>inside</button>
            </Modal>
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByText('opener');
    await user.click(opener);
    await waitFor(() => expect(screen.getByText('inside')).toHaveFocus());
    await user.keyboard('{Escape}');
    // Restoration is Base UI's now, and also asynchronous.
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('Escape closes only the innermost layer', async () => {
    const user = userEvent.setup();
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Modal label="Outer" onClose={closeOuter}>
          <button>outer button</button>
        </Modal>
        <Modal label="Inner" onClose={closeInner}>
          <button>inner button</button>
        </Modal>
      </>
    );
    // Focus is deliberately moved OUT of both popups first.
    //
    // With focus inside the inner dialog this passes even when the ordering is
    // broken: Base UI's React `onKeyDown` calls `stopPropagation` on the way up
    // and the document-level listeners never run, so only one dialog hears the
    // key by accident. Blur first and both listeners fire, which is the case
    // that actually collapsed the stack.
    await waitFor(() => expect(screen.getByText('inner button')).toHaveFocus());
    (document.activeElement as HTMLElement | null)?.blur();

    await user.keyboard('{Escape}');
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });
});

describe('Popover', () => {
  function MenuHarness({ onClose = () => undefined }: { onClose?: () => void }) {
    const anchor = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={anchor}>anchor</button>
        <Popover anchorRef={anchor} label="Actions" onClose={onClose}>
          <MenuItem onSelect={() => undefined}>Pin</MenuItem>
          <MenuItem onSelect={() => undefined} disabled title="No delete endpoint">
            Delete
          </MenuItem>
        </Popover>
      </>
    );
  }

  it('renders as a named menu of menu items', () => {
    render(<MenuHarness />);
    const menu = screen.getByRole('menu', { name: 'Actions' });
    expect(menu).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('keeps an unsupported action disabled and explained', () => {
    render(<MenuHarness />);
    const item = screen.getByRole('menuitem', { name: 'Delete' });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', 'No delete endpoint');
  });

  it('closes on Escape and on an outside pointer press', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <>
        <div data-testid="outside">outside</div>
        <MenuHarness onClose={onClose} />
      </>
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not close when the anchor itself is pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MenuHarness onClose={onClose} />);
    await user.click(screen.getByText('anchor'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('a select inside a modal', () => {
  // THIRTEEN SELECTS NOW LIVE INSIDE DIALOGS - settings, the routine editor,
  // the avatar gallery - so Escape has two plausible meanings at any moment and
  // the wrong one loses the operator's work. The select must eat the first
  // press; only once it is closed does the dialog get one.
  it('Escape closes the select, then the dialog - one layer per press', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal label="Settings" onClose={onClose}>
        <Select value="a" onValueChange={() => undefined}>
          <SelectTrigger aria-label="Theme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Alpha</SelectItem>
            <SelectItem value="b">Beta</SelectItem>
          </SelectContent>
        </Select>
      </Modal>
    );

    await user.click(screen.getByLabelText('Theme'));
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
