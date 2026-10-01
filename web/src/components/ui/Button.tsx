/**
 * The app's buttons, on Coss.
 *
 * WHY A WRAPPER. Coss names its variants after appearance - `default`,
 * `outline`, `ghost`, `destructive`. This app names controls after their JOB -
 * the primary action of a dialog, the quiet one beside it, the icon-only one in
 * a toolbar. Mapping once here means a call site says what the button is FOR,
 * and changing what "secondary" looks like everywhere stays one edit.
 *
 * It also keeps the blast radius of the swap small: fifty-odd call sites did
 * not have to learn Coss's vocabulary, and if Coss's variant names change the
 * translation table absorbs it.
 *
 * WHAT COMES WITH IT beyond the styling. `loading` renders a spinner inside the
 * button and sets `aria-disabled` - this app previously spelled that out as
 * `disabled={busy} {busy ? 'Saving…' : 'Save'}` in each place, which lost the
 * label while it worked. `render` lets a link carry button styling without a
 * button wrapping an anchor.
 *
 * PREFLIGHT IS NOT LOADED in this app (see tailwind.css), and Coss's button
 * assumes it. What preflight would have supplied is `background: transparent`
 * and `border: 0` on `<button>`; the old galaxy stylesheet sets both to
 * something else on the bare element. Utilities win over the `app` layer, so
 * every property Coss sets is safe - the one it does NOT set is the inherited
 * `font`, which is why `font-sans` is pinned below.
 */

import { Button as CossButton } from '@/registry/default/ui/button.js';
import * as React from 'react';
import type { ComponentProps } from 'react';

type CossButtonProps = ComponentProps<typeof CossButton>;

/** What the button is for, not what it looks like. */
export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

const VARIANT: Record<ButtonKind, NonNullable<CossButtonProps['variant']>> = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
  link: 'link',
};

export interface ButtonProps extends Omit<CossButtonProps, 'variant'> {
  kind?: ButtonKind;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ kind = 'secondary', className = '', ...props }, ref) {
    return (
      <CossButton
        ref={ref}
        variant={VARIANT[kind]}
        className={`font-sans ${className}`.trim()}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export type IconButtonProps = Omit<ButtonProps, 'kind' | 'size'> & {
  'aria-label': string;
  title?: string;
};

/** An icon-only button. Square, quiet, and it must still carry a label. */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ className = '', ...props }, ref) {
    return <Button ref={ref} kind="ghost" size="icon" className={className} {...props} />;
  }
);
IconButton.displayName = 'IconButton';
