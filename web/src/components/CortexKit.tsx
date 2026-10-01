/**
 * The Cortex kit: the few pieces every Cortex panel is built from.
 *
 * Cortex used to be nine panels that each drew their own drawer, header and
 * "close" text button with inline styles, so no two looked alike and several of
 * them covered the top bar. Everything now goes through `CortexPanel` - one
 * floating glass sheet, one header shape, one close control, one entrance - and
 * the small parts below, so a panel only describes its content.
 *
 * Styles live in cortex-design.css under `.cx-root`, which also pins Cortex to
 * its dark palette: the chrome floats over a night-sky canvas, so a light panel
 * would be a white card punched out of the galaxy.
 */

import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { bandT, rampColor } from '@kernel/cortex/galaxy.js';
import type { AgentRow } from '../lib/transport.js';
import type { BotProfile } from '../lib/botProfile.js';
import { getAgentBotPersonality } from '../lib/aora-bot/index.js';
import { BotFace } from './BotFace.js';
import { Icon, type IconName } from './ui/icons.js';

/** Panels arrive on a spring and leave quickly: in is an answer, out is a dismissal. */
const PANEL_SPRING = { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 } as const;

/** Height-to-auto disclosure, for forms and histories that open inside a panel. */
export const collapseMotion = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
} as const;

export function CortexPanel({
  side = 'right',
  icon,
  leading,
  title,
  subtitle,
  label,
  actions,
  onClose,
  children,
}: {
  side?: 'left' | 'right';
  icon?: IconName;
  /** Replaces the icon tile, e.g. with a bot's face. */
  leading?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  /** The dialog's accessible name when the title is data (a bot or run name). */
  label?: string;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const offset = side === 'right' ? 32 : -32;
  const name = label ?? title;
  return (
    <motion.aside
      className={`cx-panel cx-panel-${side}`}
      role="dialog"
      aria-label={name}
      initial={{ opacity: 0, x: offset, scale: 0.985 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: offset, scale: 0.985, transition: { duration: 0.16 } }}
      transition={PANEL_SPRING}
    >
      <header className="cx-panel-head">
        {leading ?? (icon && (
          <span className="cx-panel-icon" aria-hidden="true">
            <Icon name={icon} size={16} motion={false} />
          </span>
        ))}
        <div className="cx-panel-titles">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="cx-panel-actions">
          {actions}
          <button type="button" className="cx-icon-btn" onClick={onClose} aria-label={`Close ${name}`} title="Close">
            <Icon name="close" />
          </button>
        </div>
      </header>
      {children}
    </motion.aside>
  );
}

/** A bot's face as the workspace shows it: the saved profile when there is one. */
export function CortexFace({
  agent,
  profile,
  size,
  emotion,
  status,
  idle,
  interactive = false,
}: {
  agent?: AgentRow;
  profile?: BotProfile;
  size: number;
  emotion?: string;
  status?: string;
  idle?: boolean;
  interactive?: boolean;
}) {
  return (
    <BotFace
      agent={agent}
      shape={profile?.shape}
      color={profile?.color}
      eyeColor={profile?.eyeColor}
      eyeScale={profile?.eyeScale}
      image={profile?.avatarImage ?? null}
      sketch={profile?.sketch}
      idle={idle ?? profile?.idle ?? true}
      emotion={emotion}
      status={status}
      size={size}
      interactive={interactive}
    />
  );
}

export function botColor(agent: AgentRow | undefined, profile: BotProfile | undefined): string {
  return profile?.color ?? getAgentBotPersonality(agent).color;
}

export type Tone = 'ok' | 'busy' | 'warn' | 'danger' | 'muted';

const TONE: Record<string, Tone> = {
  IDLE: 'ok',
  BUSY: 'busy',
  PAUSED: 'warn',
  DISABLED: 'muted',
  QUEUED: 'muted',
  RUNNING: 'busy',
  COMPLETED: 'ok',
  FAILED: 'danger',
  CRASHED: 'danger',
  ABORTED: 'warn',
  PENDING: 'warn',
  APPROVED: 'ok',
  DENIED: 'danger',
  EXPIRED: 'muted',
};

const STATUS_TEXT: Record<string, string> = {
  IDLE: 'Idle',
  BUSY: 'Busy',
  PAUSED: 'Paused',
  DISABLED: 'Disabled',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CRASHED: 'Crashed',
  ABORTED: 'Aborted',
  PENDING: 'Pending',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  EXPIRED: 'Expired',
};

export function statusTone(status: string | null | undefined): Tone {
  return (status && TONE[status.toUpperCase()]) || 'muted';
}

export function statusText(status: string): string {
  return STATUS_TEXT[status.toUpperCase()] ?? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

/** A status as a coloured dot and a word. Busy states pulse. */
export function StatusPill({ status, label }: { status: string; label?: string }) {
  return (
    <span className="cx-pill" data-tone={statusTone(status)}>
      <i aria-hidden="true" />
      {label ?? statusText(status)}
    </span>
  );
}

export function CortexEmpty({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="cx-empty">
      <span className="cx-empty-icon" aria-hidden="true">
        <Icon name={icon} size={18} motion={false} />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/**
 * A segmented control whose selection slides between options.
 * `id` scopes the shared layout animation so two controls never trade pills.
 */
export function Segmented<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: IconName }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="cx-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            className={`cx-segment ${on ? 'is-on' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {on && (
              <motion.span
                layoutId={`cx-segment-${id}`}
                className="cx-segment-pill"
                transition={{ type: 'spring', stiffness: 520, damping: 40 }}
              />
            )}
            {option.icon && <Icon name={option.icon} size={13} motion={false} />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  label,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="cx-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="cx-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`cx-field ${wide ? 'is-wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** "5m ago", for something that has already happened. */
export function timeAgo(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return 'not started';
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function rgbCss(color: readonly [number, number, number]): string {
  return `rgb(${Math.round(color[0] * 255)} ${Math.round(color[1] * 255)} ${Math.round(color[2] * 255)})`;
}

/**
 * The colour a layer is drawn in on the galaxy, for use in HTML.
 * The timeline's layer badges use it, so an event and the band it lit match.
 */
export function layerColor(layer: Parameters<typeof bandT>[0] | null | undefined): string {
  if (layer === null || layer === undefined) return 'var(--cx-muted)';
  return rgbCss(rampColor(bandT(layer)));
}
