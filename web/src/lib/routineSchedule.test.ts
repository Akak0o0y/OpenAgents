/**
 * Trigger -> cron.
 *
 * The failure this file exists to prevent: the editor accepting triggers it
 * cannot actually store, and the operator finding out when the routine runs at
 * a time nobody asked for.
 */

import { describe, expect, it } from 'vitest';
import {
  combineTriggers,
  newEventTrigger,
  newScheduleTrigger,
  triggerToCron,
  type ScheduleTrigger,
} from './routineSchedule.js';

const daily = (times: number[]): ScheduleTrigger => ({ ...newScheduleTrigger('daily'), times });

describe('triggerToCron', () => {
  it('builds a daily expression from one time', () => {
    const result = triggerToCron(daily([8 * 60]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cron).toBe('0 8 * * *');
      expect(result.human).toBe('Every day at 8:00 AM');
    }
  });

  it('rejects time pairs that would create extra runs', () => {
    const result = triggerToCron(daily([8 * 60 + 30, 17 * 60]));
    expect(result.ok).toBe(false);
    expect(triggerToCron(daily([480, 510, 1020, 1050])).ok).toBe(true);
  });

  it('avoids the uneven midnight reset by not using cron for those intervals', () => {
    // `0 */5 * * *` fires at 00:00 05:00 ... 20:00 and then again at 00:00 - a 4-hour
    // gap. These used to be refused for that reason; they are now true intervals, which
    // simply do not reset at midnight, so the flaw is gone rather than forbidden.
    for (const hours of [5, 7, 9, 23]) {
      const result = triggerToCron({ ...newScheduleTrigger('interval'), intervalMinutes: hours * 60 });
      expect(result.ok, `${hours}h must be expressible`).toBe(true);
      if (result.ok) expect(result.cron).toBe(`@every ${hours * 60}m`);
    }
    // Hours that divide a day keep their cron form and fire on the same wall-clock hours.
    for (const hours of [1, 2, 3, 4, 6, 8, 12]) {
      const result = triggerToCron({ ...newScheduleTrigger('interval'), intervalMinutes: hours * 60 });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.cron).toBe(hours === 1 ? '0 */1 * * *' : `0 */${hours} * * *`);
    }
  });

  it('uses the standard weekday range for Weekdays', () => {
    const result = triggerToCron({ ...newScheduleTrigger('weekdays'), times: [9 * 60] });
    expect(result.ok && result.cron).toBe('0 9 * * 1-5');
  });

  it('pins a weekly trigger to its chosen day', () => {
    const result = triggerToCron({ ...newScheduleTrigger('weekly'), times: [9 * 60], weekday: 3 });
    expect(result.ok && result.cron).toBe('0 9 * * 3');
  });

  it('pins a monthly trigger to its chosen date', () => {
    const result = triggerToCron({ ...newScheduleTrigger('monthly'), times: [6 * 60], dayOfMonth: 15 });
    expect(result.ok && result.cron).toBe('0 6 15 * *');
  });

  it('expresses an interval cron cannot, instead of refusing it', () => {
    // 7 does not divide 60, so `*/7` would fire at :00 :07 ... :56 and then jump to :00 -
    // a 4-minute gap nobody asked for. Rather than refusing, it becomes a true interval
    // measured from the previous run, which is what "every 7 minutes" means.
    for (const [minutes, human] of [[7, 'Every 7 minutes'], [29, 'Every 29 minutes'], [90, 'Every 90 minutes']] as const) {
      const result = triggerToCron({ ...newScheduleTrigger('interval'), intervalMinutes: minutes });
      expect(result.ok, `${minutes} minutes must be accepted`).toBe(true);
      if (result.ok) {
        expect(result.cron).toBe(`@every ${minutes}m`);
        expect(result.human).toBe(human);
        // An interval has no cron fields, so it must not claim any.
        expect(result.parts).toBeUndefined();
      }
    }
  });

  it('refuses an interval outside the supported range', () => {
    expect(triggerToCron({ ...newScheduleTrigger('interval'), intervalMinutes: 0 }).ok).toBe(false);
    expect(triggerToCron({ ...newScheduleTrigger('interval'), intervalMinutes: 60 * 24 * 40 }).ok).toBe(false);
  });

  it('accepts an interval that does divide an hour', () => {
    const result = triggerToCron({ ...newScheduleTrigger('interval'), intervalMinutes: 15 });
    expect(result.ok && result.cron).toBe('*/15 * * * *');
  });

  it('keeps the cron form for intervals that divide evenly, so existing routines do not drift', () => {
    const even = triggerToCron({ ...newScheduleTrigger('interval'), intervalMinutes: 120 });
    expect(even.ok).toBe(true);
    if (even.ok) expect(even.cron).toBe('0 */2 * * *');
    // 90 minutes divides neither an hour nor a day, so it becomes an interval.
    const uneven = triggerToCron({ ...newScheduleTrigger('interval'), intervalMinutes: 90 });
    expect(uneven.ok).toBe(true);
    if (uneven.ok) expect(uneven.cron).toBe('@every 90m');
  });

  it('builds an advanced expression from months, days and times', () => {
    const result = triggerToCron({
      ...newScheduleTrigger('advanced'),
      months: [1, 7],
      days: [1, 15],
      times: [8 * 60, 20 * 60],
    });
    expect(result.ok && result.cron).toBe('0 8,20 1,15 1,7 *');
  });

  it('treats empty advanced months and days as wildcards', () => {
    const result = triggerToCron({ ...newScheduleTrigger('advanced'), times: [8 * 60] });
    expect(result.ok && result.cron).toBe('0 8 * * *');
  });

  it('requires a custom expression to have five fields', () => {
    const bad = triggerToCron({ ...newScheduleTrigger('custom'), cron: '0 9 * *' });
    expect(bad.ok).toBe(false);
    const good = triggerToCron({ ...newScheduleTrigger('custom'), cron: '0 9 * * 1-5' });
    expect(good.ok && good.cron).toBe('0 9 * * 1-5');
  });

  it('has no schedule for a webhook trigger, and says why that is fine', () => {
    const result = triggerToCron(newEventTrigger('webhook'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/fires this routine on demand/);
  });

  it('points a branded source at the webhook rather than pretending to integrate', () => {
    const result = triggerToCron(newEventTrigger('slack'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Point its outgoing webhook/);
  });

  it('refuses a daily trigger with no time at all', () => {
    expect(triggerToCron(daily([])).ok).toBe(false);
  });
});

describe('combineTriggers', () => {
  it('refuses cross-product times, wildcard expansion and complex custom merges', () => {
    expect(combineTriggers([daily([510]), daily([1020])]).ok).toBe(false);
    expect(combineTriggers([newScheduleTrigger('hourly'), daily([510])]).ok).toBe(false);
    expect(combineTriggers([{ ...newScheduleTrigger('custom'), cron: '0 8-10 * * *' }, daily([1020])]).ok).toBe(false);
  });

  it('does not silently discard an invalid schedule beside a valid trigger', () => {
    expect(combineTriggers([daily([]), daily([480])]).ok).toBe(false);
    expect(combineTriggers([daily([]), newEventTrigger('webhook')]).ok).toBe(false);
  });

  it('refuses to save with no triggers', () => {
    const result = combineTriggers([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Add at least one trigger/);
  });

  it('unions two daily triggers into a single schedule', () => {
    const result = combineTriggers([daily([8 * 60]), daily([17 * 60])]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cron).toBe('0 8,17 * * *');
  });

  it('refuses to merge triggers that run on different days', () => {
    const result = combineTriggers([
      daily([8 * 60]),
      { ...newScheduleTrigger('weekly'), times: [8 * 60], weekday: 1 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/different days/);
  });

  it('refuses to merge an interval with anything else', () => {
    const result = combineTriggers([
      { ...newScheduleTrigger('interval'), intervalMinutes: 30 },
      daily([8 * 60]),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/interval trigger cannot be combined/);
  });

  it('reports an unusable event trigger while still saving the schedule ones', () => {
    const result = combineTriggers([daily([8 * 60]), newEventTrigger('git')]);
    expect(result.ok).toBe(true);
    expect(result.ignored).toHaveLength(1);
    expect(result.ignored[0].reason).toMatch(/Git event/);
  });

  it('explicitly disables the timetable for a webhook-only routine', () => {
    // A routine that only ever runs when something calls it is legitimate, and
    // the daemon still requires a cron expression on the row.
    const result = combineTriggers([newEventTrigger('webhook')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scheduleEnabled).toBe(false);
      expect(result.human).toMatch(/webhook is called/);
      expect(result.ignored).toHaveLength(0);
    }
  });

  it('fails when every trigger is one this daemon cannot run', () => {
    const result = combineTriggers([newEventTrigger('slack')]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/None of these triggers can run/);
  });

  it('combines a webhook with a schedule, keeping the schedule', () => {
    const result = combineTriggers([daily([8 * 60]), newEventTrigger('webhook')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cron).toBe('0 8 * * *');
      expect(result.scheduleEnabled).toBe(true);
      expect(result.ignored).toHaveLength(0);
    }
  });
});
