/**
 * Routine triggers -> one cron expression.
 *
 * The editor offers several typed triggers, and the daemon stores exactly ONE
 * schedule per routine. That gap is where a UI usually starts lying: it lets
 * you add three triggers, saves the first, and shows the other two anyway.
 *
 * This module closes it honestly. Triggers are combined into a single cron
 * expression when they genuinely can be - "every day at 08:00" plus "every day
 * at 17:00" is `0 8,17 * * *`, one schedule with two firing times - and when
 * they cannot, `combineTriggers` fails with a reason the editor shows instead
 * of saving something the operator did not ask for.
 *
 * The cron produced here is parsed and executed by src/daemon/cron.ts. Nothing
 * in this file schedules anything.
 */

export type ScheduleFrequency =
  | 'hourly'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'interval'
  | 'advanced'
  | 'custom';

/**
 * Event sources.
 *
 * `webhook` is REAL: the daemon exposes POST /api/webhooks/routines/:token and
 * firing it enqueues a run. The branded sources are not separate integrations -
 * every one of them sends an outbound HTTP POST, so they are configured by
 * pointing that product's webhook at the same URL. They are listed with that
 * instruction rather than as buttons that would do nothing.
 */
export const EVENT_TRIGGER_TYPES = [
  { id: 'webhook', label: 'Webhook', viaWebhook: false },
  { id: 'slack', label: 'Slack message', viaWebhook: true },
  { id: 'git', label: 'Git event', viaWebhook: true },
  { id: 'teams', label: 'Teams message', viaWebhook: true },
  { id: 'linear', label: 'Linear issue', viaWebhook: true },
  { id: 'sentry', label: 'Sentry alert', viaWebhook: true },
  { id: 'pagerduty', label: 'PagerDuty incident', viaWebhook: true },
] as const;

export type EventTriggerType = (typeof EVENT_TRIGGER_TYPES)[number]['id'];

export interface ScheduleTrigger {
  id: string;
  type: 'schedule';
  frequency: ScheduleFrequency;
  /** Minutes past midnight, one entry per firing time. */
  times: number[];
  /** 0-6, Sunday first. Used by `weekly`. */
  weekday: number;
  /** 1-31. Used by `monthly`. */
  dayOfMonth: number;
  /** Minutes between runs. Used by `interval`. */
  intervalMinutes: number;
  /** 1-12, empty means every month. Used by `advanced`. */
  months: number[];
  /** 1-31, empty means every day. Used by `advanced`. */
  days: number[];
  /** Raw expression for `custom`. */
  cron: string;
}

export interface EventTrigger {
  id: string;
  type: 'event';
  source: EventTriggerType;
}

/**
 * An event trigger carries no schedule, so it never contributes to the cron
 * expression. `webhook` is nonetheless a working trigger - it fires the routine
 * out of band - which is why it is not an error, merely scheduleless.
 */
export function isWorkingEventTrigger(trigger: RoutineTrigger): boolean {
  return trigger.type === 'event' && trigger.source === 'webhook';
}

export type RoutineTrigger = ScheduleTrigger | EventTrigger;

export const TIME_STEP_MINUTES = 15;

/**
 * Legacy sentinel, read only for records from pre-schedule_enabled daemons.
 * This IS a real date, not a safe way to disable scheduled execution.
 */
export const WEBHOOK_ONLY_CRON = '4 3 29 2 *';

/** Quarter-hour increments across a whole day, as the reference shows. */
export const TIME_OPTIONS: Array<{ value: number; label: string }> = Array.from(
  { length: (24 * 60) / TIME_STEP_MINUTES },
  (_, index) => {
    const minutes = index * TIME_STEP_MINUTES;
    return { value: minutes, label: formatTime(minutes) };
  }
);

export function formatTime(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  hourly: 'Every hour',
  daily: 'Every day',
  weekdays: 'Weekdays',
  weekly: 'Every week',
  monthly: 'Every month',
  interval: 'Interval',
  advanced: 'Advanced',
  custom: 'Custom',
};

let counter = 0;
export function newScheduleTrigger(frequency: ScheduleFrequency = 'daily'): ScheduleTrigger {
  counter += 1;
  return {
    id: `trigger-${Date.now()}-${counter}`,
    type: 'schedule',
    frequency,
    times: [8 * 60],
    weekday: 1,
    dayOfMonth: 1,
    intervalMinutes: 60,
    months: [],
    days: [],
    cron: '0 8 * * *',
  };
}

export function newEventTrigger(source: EventTriggerType): EventTrigger {
  counter += 1;
  return { id: `trigger-${Date.now()}-${counter}`, type: 'event', source };
}

interface CronParts {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

function partsToCron(parts: CronParts): string {
  return `${parts.minute} ${parts.hour} ${parts.dayOfMonth} ${parts.month} ${parts.dayOfWeek}`;
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

export interface TriggerCron {
  ok: true;
  /** Absent for an interval, which has no cron fields and so cannot be merged with any
   * other schedule: "every 29 minutes" and "daily at 9am" have no single expression. */
  parts?: CronParts;
  cron: string;
  human: string;
}

export interface TriggerCronError {
  ok: false;
  reason: string;
}

/** One trigger's cron, or why it has none. */
export function triggerToCron(trigger: RoutineTrigger): TriggerCron | TriggerCronError {
  if (trigger.type === 'event') {
    if (trigger.source === 'webhook') {
      return {
        ok: false,
        reason:
          'A webhook fires this routine on demand, so it has no schedule of its own. ' +
          'Add a schedule trigger too if it should also run on a timetable.',
      };
    }
    const label = EVENT_TRIGGER_TYPES.find((t) => t.id === trigger.source)?.label ?? trigger.source;
    return {
      ok: false,
      reason:
        `${label} has no dedicated integration here. Point its outgoing webhook at this routine's ` +
        `webhook URL instead - it is the same mechanism.`,
    };
  }

  const times = sortedUnique(trigger.times).filter((t) => t >= 0 && t < 24 * 60);
  const minutes = times.map((t) => t % 60);
  const hours = times.map((t) => Math.floor(t / 60));
  if (['daily', 'weekdays', 'weekly', 'monthly', 'advanced'].includes(trigger.frequency)
    && sortedUnique(minutes).length * sortedUnique(hours).length !== times.length) {
    return { ok: false, reason: 'These times would create extra runs in a single cron schedule. Use times with the same minutes, or separate routines.' };
  }

  switch (trigger.frequency) {
    case 'hourly':
      return finish({ minute: String(minutes[0] ?? 0), hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
        `Every hour at :${String(minutes[0] ?? 0).padStart(2, '0')}`);

    case 'daily':
      if (!times.length) return { ok: false, reason: 'Pick at least one time of day.' };
      return finish(
        { minute: joinList(minutes), hour: joinList(hours), dayOfMonth: '*', month: '*', dayOfWeek: '*' },
        `Every day at ${times.map(formatTime).join(', ')}`
      );

    case 'weekdays':
      if (!times.length) return { ok: false, reason: 'Pick at least one time of day.' };
      return finish(
        { minute: joinList(minutes), hour: joinList(hours), dayOfMonth: '*', month: '*', dayOfWeek: '1-5' },
        `Weekdays at ${times.map(formatTime).join(', ')}`
      );

    case 'weekly':
      if (!times.length) return { ok: false, reason: 'Pick at least one time of day.' };
      if (trigger.weekday < 0 || trigger.weekday > 6) return { ok: false, reason: 'Pick a day of the week.' };
      return finish(
        {
          minute: joinList(minutes),
          hour: joinList(hours),
          dayOfMonth: '*',
          month: '*',
          dayOfWeek: String(trigger.weekday),
        },
        `Every ${WEEKDAY_LABELS[trigger.weekday]} at ${times.map(formatTime).join(', ')}`
      );

    case 'monthly':
      if (!times.length) return { ok: false, reason: 'Pick at least one time of day.' };
      if (trigger.dayOfMonth < 1 || trigger.dayOfMonth > 31) {
        return { ok: false, reason: 'The day of the month must be between 1 and 31.' };
      }
      return finish(
        {
          minute: joinList(minutes),
          hour: joinList(hours),
          dayOfMonth: String(trigger.dayOfMonth),
          month: '*',
          dayOfWeek: '*',
        },
        `Day ${trigger.dayOfMonth} of every month at ${times.map(formatTime).join(', ')}`
      );

    case 'interval': {
      // Cron fires at fixed positions in the hour, so it can only say "every N minutes"
      // when N divides 60. An interval that does not - 29 minutes, 45 minutes, 7 hours -
      // is measured from the previous run instead, which is what people mean by it.
      const n = trigger.intervalMinutes;
      if (!Number.isInteger(n) || n < 1) return { ok: false, reason: 'The interval must be a whole number of minutes.' };
      if (n > 60 * 24 * 31) return { ok: false, reason: 'An interval may be at most 31 days.' };
      // Intervals that divide evenly keep their cron form, so existing routines carry on
      // firing on the same wall-clock minutes rather than drifting after this change.
      if (n < 60 && 60 % n === 0) {
        return finish({ minute: `*/${n}`, hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
          `Every ${n} minutes`);
      }
      if (n >= 60 && n % 60 === 0 && n / 60 < 24 && 24 % (n / 60) === 0) {
        return finish({ minute: '0', hour: `*/${n / 60}`, dayOfMonth: '*', month: '*', dayOfWeek: '*' },
          `Every ${n / 60} hours`);
      }
      return { ok: true, cron: `@every ${n}m`, human: describeInterval(n) };
    }

    case 'advanced': {
      if (!times.length) return { ok: false, reason: 'Add at least one time.' };
      const months = sortedUnique(trigger.months).filter((m) => m >= 1 && m <= 12);
      const days = sortedUnique(trigger.days).filter((d) => d >= 1 && d <= 31);
      return finish(
        {
          minute: joinList(minutes),
          hour: joinList(hours),
          dayOfMonth: days.length ? joinList(days) : '*',
          month: months.length ? joinList(months) : '*',
          dayOfWeek: '*',
        },
        [
          months.length ? months.map((m) => MONTH_LABELS[m - 1]).join(', ') : 'Any month',
          days.length ? `days ${days.join(', ')}` : 'every day',
          `at ${times.map(formatTime).join(', ')}`,
        ].join(' · ')
      );
    }

    case 'custom': {
      const expression = trigger.cron.trim();
      const fields = expression.split(/\s+/);
      if (fields.length !== 5) {
        return { ok: false, reason: 'A cron expression needs exactly five fields: minute hour day month weekday.' };
      }
      return finish(
        {
          minute: fields[0],
          hour: fields[1],
          dayOfMonth: fields[2],
          month: fields[3],
          dayOfWeek: fields[4],
        },
        expression
      );
    }

    default:
      return { ok: false, reason: 'Unknown trigger type.' };
  }
}

function joinList(values: number[]): string {
  return sortedUnique(values).join(',');
}

function describeInterval(minutes: number): string {
  if (minutes % 1440 === 0 && minutes >= 1440) return `Every ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0 && minutes >= 60) return `Every ${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function finish(parts: CronParts, human: string): TriggerCron {
  return { ok: true, parts, cron: partsToCron(parts), human };
}

export interface CombinedSchedule {
  ok: true;
  cron: string;
  scheduleEnabled: boolean;
  human: string;
  /** Triggers that carry no schedule and were left out, with their reasons. */
  ignored: Array<{ trigger: RoutineTrigger; reason: string }>;
}

export interface CombineError {
  ok: false;
  reason: string;
  ignored: Array<{ trigger: RoutineTrigger; reason: string }>;
}

/**
 * Fold every schedule trigger into one cron expression.
 *
 * Two triggers combine when they differ ONLY in minute and hour and the union
 * adds no unintended time pairs. Anything
 * else - a daily trigger next to a weekly one - is refused, because there is no
 * single five-field expression that means both without also meaning things the
 * operator did not ask for.
 */
export function combineTriggers(triggers: RoutineTrigger[]): CombinedSchedule | CombineError {
  const ignored: Array<{ trigger: RoutineTrigger; reason: string }> = [];
  const schedules: TriggerCron[] = [];

  for (const trigger of triggers) {
    const result = triggerToCron(trigger);
    if (result.ok) schedules.push(result);
    else if (trigger.type === 'schedule') return { ok: false, reason: result.reason, ignored };
    else ignored.push({ trigger, reason: result.reason });
  }

  // An interval runs from its own last run, so it has no cron fields to merge with
  // another schedule. Saying so is better than silently dropping one of them.
  const intervals = schedules.filter(schedule => !schedule.parts);
  if (intervals.length > 0) {
    if (schedules.length > 1) {
      return { ok: false, reason: `“${intervals[0].human}” runs on its own interval and cannot be combined with another schedule. Keep it on its own, or use times of day for all of them.`, ignored };
    }
    return { ok: true, cron: intervals[0].cron, scheduleEnabled: true, human: intervals[0].human, ignored };
  }

  if (schedules.length === 0) {
    // A webhook-only routine is legitimate: it runs when something calls it and
    // never on a timetable. Keep a valid placeholder for the existing schema;
    // scheduleEnabled, not the placeholder date, prevents scheduler dispatch.
    if (triggers.some(isWorkingEventTrigger)) {
      return {
        ok: true,
        cron: '0 0 * * *',
        scheduleEnabled: false,
        human: 'Only when its webhook is called',
        ignored: ignored.filter(({ trigger }) => !isWorkingEventTrigger(trigger)),
      };
    }
    return {
      ok: false,
      reason:
        ignored.length > 0
          ? 'None of these triggers can run on this daemon. Add a schedule trigger.'
          : 'Add at least one trigger so the routine knows when to run.',
      ignored,
    };
  }

  // Every interval returned above, so everything left has cron fields to merge. Saying so
  // in the type keeps the merging below honest rather than reaching for `!`.
  const cronSchedules = schedules.filter((s): s is TriggerCron & { parts: CronParts } => !!s.parts);
  const first = cronSchedules[0];
  const sameShape = cronSchedules.every(
    (s) =>
      s.parts.dayOfMonth === first.parts.dayOfMonth &&
      s.parts.month === first.parts.month &&
      s.parts.dayOfWeek === first.parts.dayOfWeek
  );

  if (!sameShape) {
    return {
      ok: false,
      reason:
        'These triggers run on different days, and this daemon stores one schedule per routine. ' +
        'Keep the triggers that share a day pattern here and create a second routine for the rest.',
      ignored,
    };
  }

  // A wildcard hour (hourly) unioned with explicit hours is still the wildcard.
  const anyWildcardHour = cronSchedules.some((s) => s.parts.hour === '*');
  const stepped = cronSchedules.find((s) => s.parts.hour.includes('/') || s.parts.minute.includes('/'));
  if (stepped && cronSchedules.length > 1) {
    return {
      ok: false,
      reason:
        'An interval trigger cannot be combined with another trigger in one schedule. ' +
        'Give the interval its own routine.',
      ignored,
    };
  }

  if (cronSchedules.length > 1) {
    // Only merge simple lists/wildcards, and prove the Cartesian product of
    // the merged fields equals the original union. Never drop custom ranges.
    const expand = (field: string, size: number): number[] | null => {
      if (field === '*') return Array.from({ length: size }, (_, n) => n);
      if (!/^\d+(,\d+)*$/.test(field)) return null;
      const values = sortedUnique(field.split(',').map(Number));
      return values.every(n => n >= 0 && n < size) ? values : null;
    };
    const pairs = new Set<number>();
    const mergedMinutes = new Set<number>();
    const mergedHours = new Set<number>();
    for (const schedule of cronSchedules) {
      const m = expand(schedule.parts.minute, 60);
      const h = expand(schedule.parts.hour, 24);
      if (!m || !h) return { ok: false, reason: 'Keep complex custom schedules in separate routines.', ignored };
      for (const minute of m) {
        mergedMinutes.add(minute);
        for (const hour of h) { mergedHours.add(hour); pairs.add(hour * 60 + minute); }
      }
    }
    if (pairs.size !== mergedMinutes.size * mergedHours.size) {
      return { ok: false, reason: 'Combining these triggers would create extra runs. Keep them in separate routines.', ignored };
    }
    return {
      ok: true,
      cron: partsToCron({ ...first.parts, minute: joinList([...mergedMinutes]), hour: anyWildcardHour ? '*' : joinList([...mergedHours]) }),
      scheduleEnabled: true,
      human: cronSchedules.map(s => s.human).join(' · '),
      ignored: ignored.filter(({ trigger }) => !isWorkingEventTrigger(trigger)),
    };
  }

  const minutes = sortedUnique(
    cronSchedules.flatMap((s) => s.parts.minute.split(',').map(Number)).filter((n) => Number.isFinite(n))
  );
  const hours = sortedUnique(
    cronSchedules
      .filter((s) => s.parts.hour !== '*')
      .flatMap((s) => s.parts.hour.split(',').map(Number))
      .filter((n) => Number.isFinite(n))
  );

  const cron = partsToCron({
    minute: cronSchedules.length === 1 ? first.parts.minute : minutes.join(','),
    hour: anyWildcardHour ? '*' : cronSchedules.length === 1 ? first.parts.hour : hours.join(','),
    dayOfMonth: first.parts.dayOfMonth,
    month: first.parts.month,
    dayOfWeek: first.parts.dayOfWeek,
  });

  return {
    ok: true,
    cron,
    scheduleEnabled: true,
    human: cronSchedules.map((s) => s.human).join(' · '),
    ignored: ignored.filter(({ trigger }) => !isWorkingEventTrigger(trigger)),
  };
}

/** One line summarising a trigger for its row header. */
export function describeTrigger(trigger: RoutineTrigger): string {
  const result = triggerToCron(trigger);
  if (result.ok) return result.human;
  if (trigger.type === 'event') {
    return EVENT_TRIGGER_TYPES.find((t) => t.id === trigger.source)?.label ?? trigger.source;
  }
  return 'Incomplete schedule';
}

/**
 * Words for a stored cron expression.
 *
 * Routines made in the editor keep a human schedule; older or hand-made ones
 * have only cron, and the routine list showed "0 * * * *". Common shapes are
 * put in words; anything unusual is shown as written rather than guessed.
 */
export function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, day, month, weekday] = parts;
  if (day !== '*' || month !== '*') return expression;
  const every = minute.match(/^\*\/(\d+)$/);
  if (every && hour === '*' && weekday === '*') return `every ${every[1]} minutes`;
  if (/^\d+$/.test(minute) && hour === '*' && weekday === '*') return minute === '0' ? 'every hour' : `every hour at :${minute.padStart(2, '0')}`;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return expression;
  const time = formatTime(Number(hour) * 60 + Number(minute));
  if (weekday === '*') return `every day at ${time}`;
  if (weekday === '1-5') return `every weekday at ${time}`;
  if (/^[0-6]$/.test(weekday)) return `every ${WEEKDAY_LABELS[Number(weekday)]} at ${time}`;
  return expression;
}
