/**
 * Cron and human schedule engine. Zero dependencies.
 *
 * Two things here are harder than they look, and both are handled explicitly
 * rather than hopefully:
 *
 * 1. TIMEZONES. "every day at 9 am" means 9 am where the operator lives, and
 *    that is a different instant in January and July. Offsets come from
 *    Intl.DateTimeFormat, so IANA zones and their DST rules are respected
 *    without shipping a timezone database.
 *
 * 2. THE DOM/DOW OR-RULE. In standard cron, when BOTH day-of-month and
 *    day-of-week are restricted, a day matches if EITHER matches - not both.
 *    `0 0 13 * 5` is "the 13th, and every Friday", not "Friday the 13th". This
 *    surprises people, so it is implemented deliberately and tested.
 *
 * Scanning is done a day at a time, then only over the hours and minutes the
 * expression actually names. Stepping minute by minute would be ~2 million
 * iterations for something like `0 9 29 2 *` (29 February).
 */

export interface ParsedSchedule {
  /** Normalised 5-field cron expression. */
  cron: string;
  /** What the operator typed, preserved for display. */
  human: string;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

const FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6 },
];

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

function named(token: string, fieldIndex: number): string {
  const lower = token.toLowerCase();
  if (fieldIndex === 3 && lower in MONTH_NAMES) return String(MONTH_NAMES[lower]);
  if (fieldIndex === 4 && lower in DAY_NAMES) return String(DAY_NAMES[lower]);
  return token;
}

/** Expand one cron field into the exact set of values it matches. */
export function parseField(raw: string, fieldIndex: number): Set<number> {
  const { name, min, max } = FIELD_RANGES[fieldIndex];
  const out = new Set<number>();

  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) throw new CronError(`Empty value in ${name} field: "${raw}"`);

    const [rangePart, stepPart] = piece.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronError(`Step in ${name} must be a positive integer, got "${stepPart}"`);
      }
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((t) => Number(named(t.trim(), fieldIndex)));
      lo = a;
      hi = b;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new CronError(`Invalid range in ${name}: "${rangePart}"`);
      }
      if (lo > hi) throw new CronError(`Range start exceeds end in ${name}: "${rangePart}"`);
    } else {
      const value = Number(named(rangePart.trim(), fieldIndex));
      if (!Number.isInteger(value)) {
        throw new CronError(`Invalid ${name} value: "${rangePart}"`);
      }
      lo = value;
      // A bare value with a step means "from here to the end", e.g. 5/15.
      hi = stepPart !== undefined ? max : value;
    }

    if (lo < min || hi > max) {
      throw new CronError(`${name} must be between ${min} and ${max}, got "${piece}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  if (out.size === 0) throw new CronError(`${name} field matches nothing: "${raw}"`);
  return out;
}

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when the field was literally `*`, which drives the DOM/DOW OR-rule. */
  domUnrestricted: boolean;
  dowUnrestricted: boolean;
}

/**
 * A plain repeating interval, which cron cannot express.
 *
 * Cron fires at fixed positions in the hour, so it can only say "every N minutes" when N
 * divides 60 - "every 29 minutes" was rejected outright. An interval is measured from the
 * previous run instead, which is what people mean when they say it.
 */
const EVERY = /^@every\s+(\d{1,5})\s*(m|min|minutes?|h|hours?|d|days?)$/i;
const MAX_INTERVAL_MINUTES = 60 * 24 * 31;

export function intervalMinutes(expression: string): number | undefined {
  const match = EVERY.exec(expression.trim());
  if (!match) return undefined;
  const unit = match[2].toLowerCase()[0];
  const minutes = Number(match[1]) * (unit === 'h' ? 60 : unit === 'd' ? 1440 : 1);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_INTERVAL_MINUTES) {
    throw new CronError(`An interval must be between 1 minute and 31 days; got "${expression}".`);
  }
  return minutes;
}

export function describeInterval(minutes: number): string {
  if (minutes % 1440 === 0 && minutes >= 1440) return `Every ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0 && minutes >= 60) return `Every ${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function parseCron(expression: string): CronFields {
  // An interval is not a cron expression and must be resolved before this point.
  if (EVERY.test(expression.trim())) {
    throw new CronError(`"${expression}" is an interval, not a cron expression. Use computeNextRun, which understands both.`);
  }
  const normalised = ALIASES[expression.trim().toLowerCase()] ?? expression;
  const parts = normalised.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `A cron expression needs exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${expression}"`
    );
  }

  // Day-of-week 7 is Sunday in many crons; normalise before parsing.
  const dowRaw = parts[4].replace(/\b7\b/g, '0');

  return {
    minutes: parseField(parts[0], 0),
    hours: parseField(parts[1], 1),
    daysOfMonth: parseField(parts[2], 2),
    months: parseField(parts[3], 3),
    daysOfWeek: parseField(dowRaw, 4),
    domUnrestricted: parts[2].trim() === '*',
    dowUnrestricted: dowRaw.trim() === '*',
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Human schedules
// ---------------------------------------------------------------------------

function to24Hour(hour: number, meridiem?: string): number {
  if (!meridiem) return hour;
  if (hour < 1 || hour > 12) throw new CronError('An am/pm hour must be between 1 and 12.');
  const m = meridiem.toLowerCase();
  if (m.startsWith('p')) return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour;
}

/** Re-emit a cron expression in canonical 5-field form. */
function canonicalCron(expression: string): string {
  const normalised = ALIASES[expression.trim().toLowerCase()] ?? expression;
  return normalised.trim().split(/\s+/).join(' ');
}

/**
 * Accept either a cron expression or plain English and return both forms.
 *
 * Unrecognised English is REJECTED rather than silently defaulting to some
 * schedule. A routine that runs at a time nobody asked for is worse than one
 * that refuses to be created.
 */
export function parseSchedule(input: string): ParsedSchedule {
  const human = input.trim();
  if (!human) throw new CronError('Schedule is empty.');

  const lower = human.toLowerCase();

  if (lower in ALIASES) return { cron: ALIASES[lower], human };
  if (isValidCron(human)) return { cron: canonicalCron(human), human };

  // An interval already written as @every passes straight through.
  const explicit = intervalMinutes(human);
  if (explicit !== undefined) return { cron: `@every ${explicit}m`, human: describeInterval(explicit) };

  // every N minutes. An interval that divides the hour keeps its cron form, so schedules
  // that already worked keep firing on the same wall-clock minutes. One that does not -
  // "every 29 minutes" - becomes a true interval instead of being refused.
  const everyMinutes = lower.match(/^every\s+(\d+)\s*(?:minutes?|mins?|m)$/);
  if (everyMinutes) {
    const n = Number(everyMinutes[1]);
    if (n < 1) throw new CronError('An interval must be at least one minute.');
    if (n > 60 * 24 * 31) throw new CronError('An interval may be at most 31 days.');
    if (n < 60 && 60 % n === 0) return { cron: `*/${n} * * * *`, human };
    return { cron: `@every ${n}m`, human: describeInterval(n) };
  }

  // every N hours, with the same rule.
  const everyHours = lower.match(/^every\s+(\d+)\s*(?:hours?|hrs?|h)$/);
  if (everyHours) {
    const n = Number(everyHours[1]);
    if (n < 1) throw new CronError('An interval must be at least one hour.');
    if (n > 24 * 31) throw new CronError('An interval may be at most 31 days.');
    if (n < 24 && 24 % n === 0) return { cron: `0 */${n} * * *`, human };
    return { cron: `@every ${n * 60}m`, human: describeInterval(n * 60) };
  }

  if (/^every\s+(hour|hourly)$/.test(lower)) return { cron: '0 * * * *', human };
  if (/^every\s+minute$/.test(lower)) return { cron: '* * * * *', human };

  const timePattern = String.raw`at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;
  const atTime = new RegExp(`${timePattern}$`);

  // weekdays / weekends [at TIME]
  const weekendMatch = lower.match(new RegExp(`^(weekdays?|weekends?)(?:\\s+${timePattern})?$`));
  if (weekendMatch) {
    const time = lower.match(atTime);
    const hour = time ? to24Hour(Number(time[1]), time[3]) : 9;
    const minute = time && time[2] ? Number(time[2]) : 0;
    if (hour > 23 || minute > 59) throw new CronError(`"${human}" is not a valid time of day.`);
    const dow = weekendMatch[1].startsWith('weekday') ? '1-5' : '0,6';
    return { cron: `${minute} ${hour} * * ${dow}`, human };
  }

  // every <weekday> [at TIME]
  const dayMatch = lower.match(
    new RegExp(`^every\\s+([a-z]+day|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:\\s+${timePattern})?$`)
  );
  if (dayMatch && dayMatch[1] in DAY_NAMES) {
    const dow = DAY_NAMES[dayMatch[1]];
    const time = lower.match(atTime);
    const hour = time ? to24Hour(Number(time[1]), time[3]) : 9;
    const minute = time && time[2] ? Number(time[2]) : 0;
    if (hour > 23 || minute > 59) throw new CronError(`"${human}" is not a valid time of day.`);
    return { cron: `${minute} ${hour} * * ${dow}`, human };
  }

  // every day / daily at TIME
  if (new RegExp(`^(every\\s+day|daily)(?:\\s+${timePattern})?$`).test(lower)) {
    const time = lower.match(atTime);
    if (!time) throw new CronError(`"${human}" is missing a time, e.g. "every day at 9 am".`);
    const hour = to24Hour(Number(time[1]), time[3]);
    const minute = time[2] ? Number(time[2]) : 0;
    if (hour > 23 || minute > 59) throw new CronError(`"${human}" is not a valid time of day.`);
    return { cron: `${minute} ${hour} * * *`, human };
  }

  throw new CronError(
    `Could not understand schedule "${human}". Use a cron expression like "0 9 * * *", ` +
      `or one of: "every day at 9 am", "every Monday at 9:00", "weekdays at 9am", ` +
      `"every 30 minutes", "every 2 hours", "@daily".`
  );
}

// ---------------------------------------------------------------------------
// Timezone-aware next-run computation
// ---------------------------------------------------------------------------

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      });
    } catch {
      throw new CronError(`Unknown timezone: "${timeZone}". Use an IANA name like "Europe/London".`);
    }
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Wall-clock fields for an instant, as seen in the given timezone. */
export function wallClockIn(instantMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // Some ICU versions render midnight as hour 24; normalise it.
  const hour = Number(get('hour')) % 24;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** Offset of a timezone at a given instant, in ms (positive = east of UTC). */
function offsetAt(instantMs: number, timeZone: string): number {
  const w = wallClockIn(instantMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0);
  // Minute truncation is fine: cron never resolves finer than a minute.
  return asUtc - Math.floor(instantMs / 60000) * 60000;
}

/**
 * Convert a wall-clock time in a timezone to an instant.
 *
 * DST makes this genuinely ambiguous twice a year, and both cases are resolved
 * deliberately:
 *  - SPRING FORWARD (the time does not exist, e.g. 02:30): returns the instant
 *    just after the jump, so a 02:30 routine still fires that day rather than
 *    silently being skipped.
 *  - FALL BACK (the time happens twice): returns the FIRST occurrence, so the
 *    routine runs once, not twice.
 */
export function instantFromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Two passes converge for every real-world offset, including 45-minute zones.
  let guess = naive - offsetAt(naive, timeZone);
  guess = naive - offsetAt(guess, timeZone);

  const check = wallClockIn(guess, timeZone);
  if (check.hour === hour && check.minute === minute && check.day === day) return guess;

  // Non-existent local time (spring forward). Walk forward to the first instant
  // at or after the requested wall clock.
  for (let extra = 1; extra <= 180; extra++) {
    const candidate = guess + extra * 60_000;
    const w = wallClockIn(candidate, timeZone);
    const afterTarget =
      w.day > day || (w.day === day && (w.hour > hour || (w.hour === hour && w.minute >= minute)));
    if (afterTarget) return candidate;
  }
  return guess;
}

function dayMatches(fields: CronFields, w: WallClock): boolean {
  if (!fields.months.has(w.month)) return false;

  const domHit = fields.daysOfMonth.has(w.day);
  const dowHit = fields.daysOfWeek.has(w.weekday);

  // The classic cron OR-rule: with both restricted, EITHER matching is enough.
  if (fields.domUnrestricted && fields.dowUnrestricted) return true;
  if (fields.domUnrestricted) return dowHit;
  if (fields.dowUnrestricted) return domHit;
  return domHit || dowHit;
}

/**
 * The next instant strictly after `from` matching the expression.
 *
 * Throws rather than looping forever on an expression that can never fire, such
 * as `0 0 30 2 *` - 30 February. A schedule that silently never runs is the
 * worst possible outcome for a routine an operator believes is armed.
 */
export function computeNextRun(
  expression: string,
  from: number = Date.now(),
  timeZone = 'UTC'
): number {
  // An interval counts from now, so it needs no calendar arithmetic and no time zone:
  // "every 29 minutes" means 29 minutes after the last run, wherever the owner lives.
  const interval = intervalMinutes(expression);
  if (interval !== undefined) return from + interval * 60_000;
  const fields = parseCron(expression);
  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);

  // Start from the minute after `from`, so a schedule never returns "now".
  const start = Math.floor(from / 60_000) * 60_000 + 60_000;
  const startWall = wallClockIn(start, timeZone);

  // 4 years covers every real expression including 29 February.
  const MAX_DAYS = 366 * 4;
  let cursor = { year: startWall.year, month: startWall.month, day: startWall.day };

  for (let dayOffset = 0; dayOffset <= MAX_DAYS; dayOffset++) {
    if (dayOffset > 0) {
      // Step a calendar day using UTC arithmetic on the wall-clock date. Noon
      // avoids DST edges shifting the date underneath us.
      const next = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day, 12));
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
      };
    }

    // A rolled-over date such as 31 April does not exist; skip it.
    const probe = instantFromWallClock(cursor.year, cursor.month, cursor.day, 12, 0, timeZone);
    const probeWall = wallClockIn(probe, timeZone);
    if (probeWall.day !== cursor.day || probeWall.month !== cursor.month) continue;

    if (!dayMatches(fields, probeWall)) continue;

    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = instantFromWallClock(
          cursor.year,
          cursor.month,
          cursor.day,
          hour,
          minute,
          timeZone
        );
        if (candidate >= start) return candidate;
      }
    }
  }

  throw new CronError(
    `"${expression}" has no next occurrence within 4 years (in ${timeZone}). ` +
      `Check for an impossible date such as 30 February.`
  );
}

/** Human-readable countdown, for dashboards. */
export function describeNextRun(nextRunAt: number, now = Date.now()): string {
  const deltaMs = nextRunAt - now;
  if (deltaMs <= 0) return 'due now';
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}
