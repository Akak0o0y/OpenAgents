/**
 * The pieces every Settings section is built from.
 *
 * The previous Settings page was one pattern repeated: a label on the left and a
 * sentence on the right, with anything unavailable explained in that same
 * right-hand column. These separate the three things that were mixed together -
 * the control, the explanation, and the fact that something is not available -
 * so each section only has to say what it contains. Styles: settings-design.css.
 */

import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Icon, type IconName } from './ui/icons.js';

export function SettingsGroup({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="oh-set-group" aria-label={title}>
      <header className="oh-set-group-head">
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      <div className="oh-set-card">{children}</div>
    </section>
  );
}

export function SettingsRow({
  icon,
  label,
  hint,
  htmlFor,
  children,
}: {
  icon?: IconName;
  label: string;
  hint?: ReactNode;
  /** When the control is a form field, the label is a real <label> for it. */
  htmlFor?: string;
  children?: ReactNode;
}) {
  return (
    <div className="oh-set-row">
      {icon && (
        <span className="oh-set-row-icon" aria-hidden="true">
          <Icon name={icon} size={16} motion={false} />
        </span>
      )}
      <div className="oh-set-row-text">
        {htmlFor ? (
          <label className="oh-set-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="oh-set-row-label">{label}</span>
        )}
        {hint && <p className="oh-set-row-hint">{hint}</p>}
      </div>
      {children !== undefined && <div className="oh-set-row-control">{children}</div>}
    </div>
  );
}

export type SettingsTone = 'ok' | 'warn' | 'danger' | 'muted' | 'info';

/** A short status word in a pill, e.g. "Not available" or "Config file". */
export function SettingsBadge({ tone = 'muted', icon, children }: { tone?: SettingsTone; icon?: IconName; children: ReactNode }) {
  return (
    <span className="oh-set-badge" data-tone={tone}>
      {icon ? <Icon name={icon} size={12} motion={false} /> : <i aria-hidden="true" />}
      {children}
    </span>
  );
}

export function SettingsNote({ icon = 'detail', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="oh-set-note">
      <Icon name={icon} size={14} motion={false} />
      <p>{children}</p>
    </div>
  );
}

export function StatTile({
  icon,
  label,
  value,
  detail,
  tone = 'muted',
}: {
  icon: IconName;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: SettingsTone;
}) {
  return (
    <div className="oh-stat" data-tone={tone}>
      <div className="oh-stat-top">
        <span className="oh-stat-icon" aria-hidden="true">
          <Icon name={icon} size={15} motion={false} />
        </span>
        <span className="oh-stat-label">{label}</span>
      </div>
      <strong className="oh-stat-value">{value}</strong>
      {detail && <p className="oh-stat-detail">{detail}</p>}
    </div>
  );
}

/** A bar that fills to its value on mount, so a changed number is seen moving. */
export function Meter({
  value,
  max,
  label,
  tone = 'info',
}: {
  value: number;
  max: number;
  label: string;
  tone?: SettingsTone;
}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className="oh-meter"
      data-tone={tone}
      role="meter"
      aria-label={label}
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <motion.span
        initial={{ width: 0 }}
        animate={{ width: `${percent > 0 ? Math.max(percent, 1.5) : 0}%` }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}

export function SettingsSwitch({
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
      className="oh-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="oh-switch-thumb" aria-hidden="true" />
    </button>
  );
}
