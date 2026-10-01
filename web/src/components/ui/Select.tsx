/**
 * Coss's Select, with the closed state showing the LABEL again.
 *
 * THE BUG THIS EXISTS TO FIX. Base UI resolves what the trigger displays from
 * an `items` prop on the root - its own docs say "when specified, `Select.Value`
 * renders the label of the selected item instead of the raw value". Nothing
 * supplies it when the options are written as JSX children, so `Select.Value`
 * falls back to `serializeValue(value)` and the closed select shows the raw
 * value: `pebble` instead of `Pebble`, `system` instead of `Follow System`,
 * `2500` instead of `2.5s`, `en` instead of `English`.
 *
 * That is a regression I introduced. The native `<select>` elements these
 * replaced rendered the selected `<option>`'s text, because that is what a
 * browser does, and the conversion quietly dropped it. Every converted select
 * whose label differs from its value was affected - which is most of them.
 *
 * WHY A WRAPPER RATHER THAN `items` AT EACH CALL SITE. Passing `items` by hand
 * means writing every option list twice, once as JSX and once as data, and
 * nothing keeps the two in step - the failure mode is a label that silently
 * goes stale in the closed state only. Deriving `items` from the children that
 * are already there keeps one source of truth and restores exactly the
 * behaviour the native control had.
 *
 * An explicit `items` prop still wins if one is passed, so grouped or
 * dynamically-labelled selects can opt out.
 *
 * The vendored Coss file is untouched, as everything under `registry/` is: it
 * stays byte-identical to the registry so updating it is a copy and a diff.
 */

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Children, isValidElement, useMemo, type ReactNode } from 'react';
import {
  Select as CossSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/registry/default/ui/select.js';

/**
 * Walk the children for `SelectItem`s and map value -> label.
 *
 * Recursive because the items are rarely direct children: they sit inside
 * `SelectContent`, usually produced by a `.map()`, and sometimes inside a
 * group. The label is kept as a ReactNode rather than flattened to a string -
 * Base UI accepts one, and flattening would drop any markup an option carries.
 */
function collectItemLabels(
  children: ReactNode,
  into: Record<string, ReactNode> = {}
): Record<string, ReactNode> {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { value?: unknown; children?: ReactNode };
    if (child.type === SelectItem && props.value != null) {
      into[String(props.value)] = props.children;
      return;
    }
    if (props.children != null) collectItemLabels(props.children, into);
  });
  return into;
}

/**
 * The generics are Base UI's own, repeated rather than derived.
 *
 * `React.ComponentProps<typeof CossSelect>` looks like the tidy way to write
 * this and is wrong: it erases `Value`, so `onValueChange` degrades to `{}` and
 * every call site stops type-checking its own handler. Mirroring the signature
 * keeps `value`/`onValueChange` tied together as they are on the primitive.
 */
export function Select<Value, Multiple extends boolean | undefined = false>({
  children,
  items,
  ...props
}: SelectPrimitive.Root.Props<Value, Multiple>) {
  const resolved = useMemo(
    () => items ?? collectItemLabels(children),
    [items, children]
  );
  return (
    <CossSelect items={resolved} {...props}>
      {children}
    </CossSelect>
  );
}

export { SelectContent, SelectItem, SelectTrigger, SelectValue };
