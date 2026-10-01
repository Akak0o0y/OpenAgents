/**
 * Number formatting for the interface.
 *
 * WHY NOT `toLocaleString()`. With no locale argument it resolves against
 * whatever the RUNTIME decides, and the runtimes disagree: Electron here
 * resolves `en-GB` and gives `1,234,567`, while Node resolves `ar-SA` and gives
 * `١٬٢٣٤٬٥٦٧`. Both are correct localisations. Neither is a decision anybody
 * made about this interface.
 *
 * That produced a real inconsistency rather than a theoretical one: a chart's
 * axis labels are built from template strings and are therefore always Latin,
 * while its tooltip went through `toLocaleString()`. The same chart could show
 * two numeral systems at once, depending on whose machine it ran on.
 *
 * So the numerals are pinned to the language the interface is actually written
 * in. This is NOT a claim that English numerals are correct for everyone - it
 * is a claim that the numbers should match the words around them. When the
 * interface is translated, this locale follows the UI language, not the OS.
 *
 * DATES FOLLOW THE SAME RULE. They used to be left to the operating system, on
 * the idea that a timestamp belongs in the reader's own conventions. On an
 * Arabic-locale Windows that produced "Answered 15م 6:46:27 ‎2026/9/": right-to-left
 * fragments inside a left-to-right English sentence, reordered into nonsense.
 * Dates now use the interface language too; the TIME ZONE is still the reader's.
 */

/** The interface's language. One place to change when it is translated. */
export const UI_LOCALE = 'en-GB';

// Built once. NumberTicker formats on every animation frame, and constructing
// an Intl.NumberFormat per call is the expensive part of doing so.
const grouped = new Intl.NumberFormat(UI_LOCALE, { maximumFractionDigits: 0 });

/** A whole number with thousands separators: `1,234,567`. */
export function formatCount(value: number): string {
  return grouped.format(Math.round(value));
}

const money = new Intl.NumberFormat(UI_LOCALE, {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/**
 * Reconciled spend, to four decimal places.
 *
 * Four rather than two because model pricing is quoted per million tokens and a
 * short conversation genuinely costs less than a cent - rounding to `$0.00`
 * would report real spend as none.
 */
export function formatUsd(value: number): string {
  return money.format(value);
}

/**
 * A large count, shortened: `9.20B`, `349.2M`, `1.3K`.
 *
 * For places where the exact figure is noise - a headline, a legend - and the
 * magnitude is the information. The precise number belongs in a tooltip.
 */
export function formatCompact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

/**
 * A count for a chart AXIS.
 *
 * Shorter than `formatCompact` on purpose: an axis label has a fixed width and
 * one that overruns is CLIPPED rather than ellipsised, which once turned
 * `900.0M` into `00.0M` and quietly changed the number by an order of
 * magnitude. No decimals above a thousand caps the widest tick at four
 * characters.
 */
export function formatAxis(value: number): string {
  if (value >= 1e9) return `${Math.round(value / 1e9)}B`;
  if (value >= 1e6) return `${Math.round(value / 1e6)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}
