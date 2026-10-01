/**
 * Charts.
 *
 * This is shadcn/ui's charting pattern rather than its code: a thin wrapper
 * around Recharts whose only job is to bind series to CSS custom properties, so
 * a chart's colours come from the theme instead of from hex literals scattered
 * through the component that renders it. That is the part of shadcn's chart
 * worth having, and it is the part that needs no Tailwind - the rest of the
 * component is Tailwind class strings that would fight the token system this
 * app already has.
 *
 * WHAT THE CONFIG BUYS. Passing `{ input: { label: 'Input', color: '...' } }`
 * once means the tooltip, the legend and the series itself cannot disagree
 * about what a colour means. Wiring each of those separately is how a chart
 * ends up with a blue line and a green square next to it in the legend.
 *
 * The tooltip is custom because Recharts' default is a white box with a black
 * border - unreadable on this palette, and unaware of the theme.
 */

import { type ReactNode, useId } from 'react';
import { ResponsiveContainer, Tooltip } from 'recharts';
import { formatCount } from '../../lib/numbers.js';

export interface ChartSeries {
  label: string;
  /** Any CSS colour, including a var(). */
  color: string;
}

export type ChartConfig = Record<string, ChartSeries>;

interface ChartProps {
  config: ChartConfig;
  /** Recharts needs a definite height; the width comes from the container. */
  height?: number;
  className?: string;
  children: ReactNode;
  /**
   * A chart is a picture, and a picture needs a text alternative. Recharts
   * renders an SVG full of unlabelled paths, so this is the only description a
   * screen reader gets - it should state the shape and the extremes, not
   * "chart of usage".
   */
  label: string;
}

/**
 * Bind the config to CSS variables scoped to this chart.
 *
 * Every series gets `--color-<key>`, which the Recharts children reference as
 * `fill="var(--color-input)"`. Scoping them to the wrapper rather than :root is
 * what lets two charts on the same screen use the same key for different
 * colours.
 */
export function Chart({ config, height = 180, className, children, label }: ChartProps) {
  const id = useId().replace(/:/g, '');
  const vars = Object.fromEntries(
    Object.entries(config).map(([key, series]) => [`--color-${key}`, series.color])
  ) as React.CSSProperties;

  return (
    <div
      className={`grok-chart ${className ?? ''}`}
      style={vars}
      data-chart={id}
      role="img"
      aria-label={label}
    >
      <ResponsiveContainer width="100%" height={height}>
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

/**
 * What the tooltip actually reads from Recharts.
 *
 * Declared structurally rather than imported. Recharts' own tooltip generics
 * changed shape in v3 and are awkward to satisfy from a render prop; naming the
 * three fields this component uses is both accurate and stable across their
 * refactors, and a mismatch shows up here rather than as a wall of generic
 * instantiation errors.
 */
interface TooltipEntry {
  // Recharts allows a dataKey to be an accessor function, not just a field
  // name. Stringifying one would put JavaScript source in the tooltip, so the
  // lookup below falls through to `name` unless this is a plain key.
  dataKey?: string | number | ((row: never) => unknown);
  name?: string | number;
  value?: number | string;
  color?: string;
}

/** The series key for a payload entry, or '' when it cannot be determined. */
function seriesKey(entry: TooltipEntry): string {
  const key = typeof entry.dataKey === 'function' ? undefined : entry.dataKey;
  return String(key ?? entry.name ?? '');
}

interface TooltipRenderProps {
  active?: boolean;
  // `readonly`, because that is what Recharts hands the render prop and a
  // mutable array is not assignable from one.
  payload?: readonly TooltipEntry[];
  label?: string | number;
}

interface TooltipOptions {
  config: ChartConfig;
  /** Renders the value; defaults to a plain locale-formatted number. */
  format?: (value: number) => string;
  /** Renders the heading; defaults to the category label. */
  formatLabel?: (label: string) => string;
}

function TooltipBody({
  active,
  payload,
  label,
  config,
  format,
  formatLabel,
}: TooltipRenderProps & TooltipOptions) {
  if (!active || !payload?.length) return null;

  return (
    <div className="grok-chart-tooltip">
      <div className="grok-chart-tooltip-head">
        {formatLabel ? formatLabel(String(label)) : String(label)}
      </div>
      {payload.map((entry) => {
        const key = seriesKey(entry);
        const series = config[key];
        const value = typeof entry.value === 'number' ? entry.value : 0;
        return (
          <div className="grok-chart-tooltip-row" key={key}>
            <span
              className="grok-chart-swatch"
              style={{ background: series?.color ?? entry.color }}
              aria-hidden="true"
            />
            <span className="grok-chart-tooltip-label">{series?.label ?? key}</span>
            <span className="grok-chart-tooltip-value">
              {format ? format(value) : formatCount(value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Drop-in for Recharts' `<Tooltip>`, themed and using the same config. */
export function ChartTooltip({ config, format, formatLabel }: TooltipOptions) {
  return (
    <Tooltip
      // Recharts' default hover band is a grey rectangle at full opacity, which
      // on a dark surface reads as a selection rather than a hover.
      cursor={{ fill: 'var(--gk-bg-hover)' }}
      // ONE cast, at the one boundary where it belongs.
      //
      // Recharts types a payload value as `ValueType`, which includes arrays
      // and is generic over the whole chart. Widening `TooltipEntry` to match
      // it exactly means importing that generic and threading it through every
      // caller, for a component that reads three fields. Narrowing here states
      // plainly that this is the edge of Recharts' types, and `TooltipBody`
      // already treats every field as optional and checks `typeof` before use -
      // so a shape that does not match renders nothing rather than crashing.
      content={(props) => (
        <TooltipBody
          {...(props as TooltipRenderProps)}
          config={config}
          format={format}
          formatLabel={formatLabel}
        />
      )}
    />
  );
}

/** A legend that matches the tooltip, since Recharts' own does not. */
export function ChartLegend({ config }: { config: ChartConfig }) {
  return (
    <div className="grok-chart-legend">
      {Object.entries(config).map(([key, series]) => (
        <span className="grok-chart-legend-item" key={key}>
          <span
            className="grok-chart-swatch"
            style={{ background: series.color }}
            aria-hidden="true"
          />
          {series.label}
        </span>
      ))}
    </div>
  );
}
