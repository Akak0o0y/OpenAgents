/**
 * The one way this app reports that something failed.
 *
 * WHAT IT REPLACES. Twelve copies of `<p className="grok-form-error"
 * role="alert">` - red text, one size smaller than the label above it, and
 * nothing else. It read as a footnote rather than as a failure, and when it
 * appeared under a field that was already scrolled past, it was easy to miss
 * entirely.
 *
 * Coss's Alert gives it a bordered, tinted panel and an icon, which is the
 * difference between text that happens to be red and something that looks like
 * it is telling you something. The `error` variant resolves through the token
 * bridge to `--gk-danger`, so it is this app's red, not Cal.com's.
 *
 * A LOCAL WRAPPER rather than the Alert at each call site, for the same reason
 * `Select` has one: twelve sites repeating the same icon and the same variant
 * is twelve chances to differ, and the icon in particular is the sort of thing
 * that gets left off. `role="alert"` comes from the component, so the
 * announcement survives too.
 */

import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/registry/default/ui/alert.js';
import { Icon } from './icons.js';

export function FormError({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Alert variant="error" className={`grok-form-error ${className}`.trim()}>
      {/* `motion={false}`: the gesture belongs to controls you point at. An
          error that shakes when the pointer crosses it is noise. */}
      <Icon name="error" size={16} motion={false} />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
