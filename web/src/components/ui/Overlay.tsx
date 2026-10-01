/**
 * Modal and popover primitives.
 *
 * Every dialog and menu in the workspace goes through these two components, so
 * the keyboard contract is written once and cannot drift between surfaces:
 *
 *   - Escape closes the innermost layer only.
 *   - Focus moves into the layer when it opens and returns to the control that
 *     opened it when it closes, including when it closes via Escape.
 *   - Tab is contained inside a modal. A popover does NOT trap tab: tabbing out
 *     of a menu dismisses it, which is what a menu anchored to a toolbar should
 *     do.
 *   - A pointer press outside dismisses.
 *
 * Layer depth is tracked in a module-level stack rather than by listening on
 * every layer, because two open dialogs both hearing the same Escape is how a
 * single keypress ends up closing the whole stack.
 */

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Separator } from '@/registry/default/ui/separator.js';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const layerStack: symbol[] = [];

/**
 * Register an open layer, and report whether it is the top one.
 *
 * Split out from `useLayer` because modals and popovers need the same ordering
 * answer but act on it differently: a popover handles Escape itself, while a
 * modal lets Base UI handle it and only needs to know whether to honour the
 * result.
 */
function useLayerOrder(open: boolean) {
  const token = useRef<symbol>(Symbol('layer'));

  useEffect(() => {
    if (!open) return;
    const id = token.current;
    layerStack.push(id);
    return () => {
      const index = layerStack.indexOf(id);
      if (index >= 0) layerStack.splice(index, 1);
    };
  }, [open]);

  return useCallback(() => layerStack[layerStack.length - 1] === token.current, []);
}

function useLayer(open: boolean, onClose: () => void) {
  const isTopLayer = useLayerOrder(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Only the top layer reacts, so Escape peels one layer at a time.
      if (!isTopLayer()) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, isTopLayer]);
}

/** Restore focus to whatever was focused before the layer opened. */
function useFocusRestore(open: boolean) {
  const previous = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    previous.current = document.activeElement as HTMLElement | null;
    return () => {
      const target = previous.current;
      // The opener can legitimately have been removed (deleting a routine from
      // its own editor), so guard rather than assume it is still in the DOM.
      if (target && document.contains(target)) target.focus();
    };
  }, [open]);
}

export interface ModalProps {
  open?: boolean;
  onClose: () => void;
  /** Accessible name. Rendered visually only when `title` is also set. */
  label: string;
  className?: string;
  /** Width/height are per-dialog; the reference sizes differ a lot. */
  style?: React.CSSProperties;
  children: ReactNode;
  /** Element to focus first. Defaults to the first focusable descendant. */
  initialFocusSelector?: string;
}

/**
 * A modal dialog, on Base UI.
 *
 * The props are unchanged from the hand-written version this replaces, and that
 * is the point: six call sites and a test file depend on this shape, and none
 * should have to care that the mechanics underneath changed.
 *
 * WHAT BASE UI DOES BETTER, and it is not a short list. The previous version
 * trapped Tab by hand, and getting that right took two attempts - the first
 * filtered candidates on `offsetParent`, which is null for everything inside a
 * `position: fixed` subtree, so the trap collapsed to one element and Tab
 * stopped moving at all. Base UI also does what the hand-written one never
 * did: locks scroll behind the dialog, marks the rest of the page inert so a
 * screen reader cannot wander out of it, and restores focus to the element that
 * opened it even when that element has since been removed.
 *
 * `initialFocusSelector` is preserved and mapped onto Base UI's `initialFocus`,
 * because several dialogs here open straight into a search field and losing
 * that would be the regression people notice first.
 */
export function Modal({
  open = true,
  onClose,
  label,
  className = '',
  style,
  children,
  initialFocusSelector,
}: ModalProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const isTopLayer = useLayerOrder(open);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next, details) => {
        // Base UI reports every dismissal - Escape, the backdrop, a
        // programmatic close - through this one callback.
        if (next) return;

        // ESCAPE MUST PEEL ONE LAYER, and Base UI cannot work that out alone.
        //
        // It decides whether a dialog is topmost by counting dialogs nested
        // inside it IN THE REACT TREE (`escapeKey: isTopmost` in its
        // `useDialogRoot`). Modals opened as SIBLINGS each see zero nested
        // children, so each believes it is on top and both close on one
        // keypress. GrokWorkspace renders five as siblings, and the reachable
        // case is ⌘K: the shortcut stays armed while a bot's computer is
        // fullscreen, so the search dialog opens over it as a sibling.
        //
        // It usually LOOKS correct: when focus is inside the inner popup, Base
        // UI's React `onKeyDown` calls `stopPropagation` before the event
        // reaches the two document-level listeners, so only one fires. Focus
        // outside either popup - mid-open, after a click on the backdrop - and
        // the whole stack collapses. That is exactly what the layer stack above
        // exists to prevent, so the ordering answer comes from there.
        if (details?.reason === 'escape-key' && !isTopLayer()) return;

        onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="grok-modal-backdrop grok-modal-overlay" />
        <DialogPrimitive.Viewport className="grok-modal-viewport">
          <DialogPrimitive.Popup
            ref={popupRef}
            aria-label={label}
            // NO `aria-modal` HERE, deliberately. Base UI marks everything
            // outside the dialog `aria-hidden` instead, which is the mechanism
            // that actually stops a screen reader wandering out - and unlike
            // `aria-modal` it does not depend on AT honouring the attribute.
            //
            // Checking this the obvious way is misleading, and it misled me:
            // with a dialog open, `#root` carries NO `aria-hidden` in the running
            // app, which reads like the guarantee is missing. It is not. Base UI
            // keeps the ancestor path of every `[aria-live]` element exposed so
            // queued announcements are not silenced, and the chat transcript
            // (GrokChat, `aria-live="polite"`) sits inside `#root`. So `#root`
            // stays visible to AT and the hiding is applied to its children
            // instead. Verify one level down, not at `<body>`.
            className={`grok-modal-popup ${className}`}
            style={style}
            initialFocus={
              initialFocusSelector
                ? () =>
                    popupRef.current?.querySelector<HTMLElement>(initialFocusSelector) ??
                    popupRef.current
                : undefined
            }
          >
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'point';

export interface PopoverProps {
  open?: boolean;
  onClose: () => void;
  /** The control the popover belongs to. Used for positioning and dismissal. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Absolute viewport coordinates, for context menus opened at the cursor. */
  point?: { x: number; y: number };
  placement?: PopoverPlacement;
  label: string;
  role?: 'menu' | 'dialog' | 'listbox';
  className?: string;
  width?: number;
  children: ReactNode;
  /** Set false for a picker whose own search field should keep focus flow. */
  autoFocus?: boolean;
}

export function Popover({
  open = true,
  onClose,
  anchorRef,
  point,
  placement = 'bottom-start',
  label,
  role = 'menu',
  className = '',
  width,
  children,
  autoFocus = true,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayer(open, onClose);
  useFocusRestore(open);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    // Layout size, not getBoundingClientRect(): a panel with an entrance
    // animation is measured mid-transform - scaled down - and was placed too
    // low, overlapping the very control it opened from.
    const rect = { width: panel.offsetWidth, height: panel.offsetHeight };
    const margin = 8;
    let top: number;
    let left: number;

    if (point) {
      top = point.y;
      left = point.x;
    } else {
      const anchor = anchorRef?.current?.getBoundingClientRect();
      if (!anchor) {
        setPosition({ top: margin, left: margin });
        return;
      }
      const below = placement.startsWith('bottom');
      top = below ? anchor.bottom + 6 : anchor.top - rect.height - 6;
      left = placement.endsWith('end') ? anchor.right - rect.width : anchor.left;
    }

    // Keep the panel on screen. A menu that opens half off the bottom of the
    // window is worse than one that flips.
    const maxTop = window.innerHeight - rect.height - margin;
    const maxLeft = window.innerWidth - rect.width - margin;
    setPosition({
      top: Math.max(margin, Math.min(top, Math.max(margin, maxTop))),
      left: Math.max(margin, Math.min(left, Math.max(margin, maxLeft))),
    });
  }, [open, point?.x, point?.y, placement, anchorRef, children]);

  useLayoutEffect(() => {
    if (!open || !autoFocus || position === null) return;
    const panel = panelRef.current;
    if (!panel) return;
    const target = panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    target.focus();
  }, [open, autoFocus, position !== null]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = event.target as Node;
      if (panel.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    const onFocusOut = (event: FocusEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const next = event.relatedTarget as Node | null;
      if (next && (panel.contains(next) || anchorRef?.current?.contains(next))) return;
      if (next === null) return; // focus left the document entirely; leave it open
      onClose();
    };
    window.addEventListener('mousedown', onPointerDown, true);
    panelRef.current?.addEventListener('focusout', onFocusOut);
    const panel = panelRef.current;
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      panel?.removeEventListener('focusout', onFocusOut);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={`grok-popover ${className}`}
      style={{
        position: 'fixed',
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        width,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>
  );
}

/** A menu item that behaves like one for the keyboard and screen readers. */
export function MenuItem({
  onSelect = () => undefined,
  children,
  danger = false,
  disabled = false,
  title,
  icon,
}: {
  onSelect?: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`grok-menu-item ${danger ? 'danger' : ''}`}
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      {icon !== undefined && <span className="grok-menu-icon" aria-hidden="true">{icon}</span>}
      <span className="grok-menu-label">{children}</span>
    </button>
  );
}

/**
 * Coss Separator, on Base UI.
 *
 * A divider is one line of CSS, so the reason to take the component is not the
 * drawing: it is that `Separator` renders the right role and orientation data
 * without each caller remembering to, and every divider in the app then agrees.
 */
export function MenuSeparator() {
  return <Separator className="grok-menu-separator" />;
}

/** Stable ids for label/description wiring inside these layers. */
export function useDialogIds(prefix: string) {
  const id = useId();
  return { titleId: `${prefix}-title-${id}`, descriptionId: `${prefix}-desc-${id}` };
}
