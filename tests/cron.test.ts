/**
 * The cron and human schedule engine.
 *
 * The DST tests assert the PROPERTY that matters rather than hardcoded UTC
 * milliseconds: a 9am routine must stay 9am locally across a transition, which
 * means its UTC hour has to move. Asserting remembered offsets would test my
 * memory instead of the code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CronError,
  computeNextRun,
  describeNextRun,
  isValidCron,
  parseCron,
  parseSchedule,
  wallClockIn,
} from '../src/daemon/cron.js';

/** An instant, expressed unambiguously in UTC. */
const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

describe('cron field parsing', () => {
  it('parses the standard five fields', () => {
    const f = parseCron('0 9 * * *');
    assert.deepEqual([...f.minutes], [0]);
    assert.deepEqual([...f.hours], [9]);
    assert.equal(f.domUnrestricted, true);
    assert.equal(f.dowUnrestricted, true);
  });

  it('parses steps, ranges and lists', () => {
    assert.equal(parseCron('*/15 * * * *').minutes.size, 4);
    assert.deepEqual([...parseCron('0 9-17 * * *').hours], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert.deepEqual([...parseCron('0 0,12 * * *').hours], [0, 12]);
    assert.deepEqual([...parseCron('0 0 * * 1-5').daysOfWeek], [1, 2, 3, 4, 5]);
  });

  it('accepts month and day names, and 7 as Sunday', () => {
    assert.deepEqual([...parseCron('0 0 1 JAN *').months], [1]);
    assert.deepEqual([...parseCron('0 0 * * MON').daysOfWeek], [1]);
    assert.deepEqual([...parseCron('0 0 * * 7').daysOfWeek], [0], '7 and 0 are both Sunday');
  });

  it('expands @aliases', () => {
    assert.deepEqual([...parseCron('@daily').hours], [0]);
    assert.deepEqual([...parseCron('@hourly').minutes], [0]);
  });

  it('rejects invalid expressions with a message naming the field', () => {
    const cases: Array<[string, RegExp]> = [
      ['0 9 * *', /exactly 5 fields/],
      ['60 9 * * *', /minute must be between 0 and 59/],
      ['0 24 * * *', /hour must be between 0 and 23/],
      ['0 9 32 * *', /day-of-month must be between 1 and 31/],
      ['0 9 * 13 *', /month must be between 1 and 12/],
      ['0 9 * * 8', /day-of-week must be between 0 and 6/],
      ['*/0 * * * *', /Step in minute must be a positive integer/],
      ['0 17-9 * * *', /Range start exceeds end/],
    ];
    for (const [expr, pattern] of cases) {
      assert.throws(() => parseCron(expr), pattern, `"${expr}" must be rejected`);
    }
  });

  it('isValidCron answers without throwing', () => {
    assert.equal(isValidCron('0 9 * * *'), true);
    assert.equal(isValidCron('nonsense'), false);
  });
});

describe('human schedules', () => {
  it('rejects unconsumed language, uneven intervals and invalid meridiem hours', () => {
    // "every 50 minutes" and "every 5 hours" used to be refused because cron cannot
    // express them. They are intervals now, asserted below; what stays refused is
    // language that was never understood and times that do not exist.
    for (const input of ['weekdays except Friday at 9 am', 'every Monday at 9 am except holidays', 'daily at 9 am tomorrow', 'daily at 13 am', 'daily at 0 pm']) {
      assert.throws(() => parseSchedule(input), CronError, input);
    }
  });

  const cases: Array<[string, string]> = [
    ['every day at 9 am', '0 9 * * *'],
    ['daily at 09:00', '0 9 * * *'],
    ['every day at 9:30 pm', '30 21 * * *'],
    ['every day at 12 am', '0 0 * * *'],
    ['every day at 12 pm', '0 12 * * *'],
    ['every hour', '0 * * * *'],
    ['@hourly', '0 * * * *'],
    ['every Monday at 9:00', '0 9 * * 1'],
    ['every friday at 5 pm', '0 17 * * 5'],
    ['weekdays at 9 am', '0 9 * * 1-5'],
    ['weekends at 10am', '0 10 * * 0,6'],
    ['every 30 minutes', '*/30 * * * *'],
    ['every 30m', '*/30 * * * *'],
    ['every 2 hours', '0 */2 * * *'],
    ['every 2h', '0 */2 * * *'],
    ['@daily', '0 0 * * *'],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" -> ${expected}`, () => {
      assert.equal(parseSchedule(input).cron, expected);
    });
  }

  it('passes a cron expression straight through, keeping what was typed', () => {
    const parsed = parseSchedule('0  9 * * *');
    assert.equal(parsed.cron, '0 9 * * *', 'normalised');
    assert.equal(parsed.human, '0  9 * * *', 'original preserved for display');
  });

  it('REFUSES English it does not understand rather than guessing a schedule', () => {
    // A routine firing at a time nobody asked for is worse than one that
    // refuses to be created.
    for (const bad of ['sometime tomorrow', 'every fortnight', 'when I feel like it', '']) {
      assert.throws(() => parseSchedule(bad), CronError, `"${bad}" must be refused`);
    }
    assert.throws(() => parseSchedule('every day'), /missing a time/);
  });

  it('rejects an interval outside the supported range', () => {
    assert.throws(() => parseSchedule('every 0 minutes'), CronError);
    assert.throws(() => parseSchedule('every 99999 minutes'), /at most 31 days/);
    assert.throws(() => parseSchedule('every 800 hours'), /at most 31 days/);
  });

  it('schedules an interval cron cannot express from the previous run', () => {
    // The editor refused "every 29 minutes" outright: cron fires at fixed positions in
    // the hour, so it can only say "every N minutes" when N divides 60.
    for (const [input, cron, human] of [
      ['every 29 minutes', '@every 29m', 'Every 29 minutes'],
      ['every 50 minutes', '@every 50m', 'Every 50 minutes'],
      ['every 90 minutes', '@every 90m', 'Every 90 minutes'],
      ['every 5 hours', '@every 300m', 'Every 5 hours'],
      ['every 30 hours', '@every 1800m', 'Every 30 hours'],
    ] as const) {
      const parsed = parseSchedule(input);
      assert.equal(parsed.cron, cron, input);
      assert.equal(parsed.human, human, input);
    }

    // Intervals that do divide keep their cron form, so routines that already worked go
    // on firing on the same wall-clock minutes instead of drifting after this change.
    assert.equal(parseSchedule('every 15 minutes').cron, '*/15 * * * *');
    assert.equal(parseSchedule('every 2 hours').cron, '0 */2 * * *');

    // An interval is measured from the moment asked about, in any zone.
    const now = Date.UTC(2026, 8, 22, 13, 7, 30);
    assert.equal(computeNextRun('@every 29m', now, 'Asia/Riyadh'), now + 29 * 60_000);
    assert.equal(computeNextRun('@every 29m', now, 'UTC'), now + 29 * 60_000);

    // It is not a cron expression and must never be parsed as one.
    assert.throws(() => parseCron('@every 29m'), CronError);
    assert.equal(isValidCron('@every 29m'), false);
  });
});

describe('computeNextRun', () => {
  it('finds the next daily occurrence in UTC', () => {
    const from = utc(2026, 6, 15, 8, 0);
    const next = computeNextRun('0 9 * * *', from, 'UTC');
    assert.equal(next, utc(2026, 6, 15, 9, 0));
  });

  it('rolls to tomorrow when today has passed', () => {
    const next = computeNextRun('0 9 * * *', utc(2026, 6, 15, 10, 0), 'UTC');
    assert.equal(next, utc(2026, 6, 16, 9, 0));
  });

  it('never returns the instant it was given', () => {
    // Otherwise a routine that just ran would be due again immediately and
    // would fire in a tight loop.
    const exact = utc(2026, 6, 15, 9, 0);
    assert.equal(computeNextRun('0 9 * * *', exact, 'UTC'), utc(2026, 6, 16, 9, 0));
  });

  it('honours day-of-week', () => {
    // 2026-06-15 is a Monday.
    const next = computeNextRun('0 9 * * 1', utc(2026, 6, 15, 10, 0), 'UTC');
    assert.equal(wallClockIn(next, 'UTC').weekday, 1);
    assert.equal(next, utc(2026, 6, 22, 9, 0), 'the following Monday');
  });

  it('handles 29 February without brute-forcing four years of minutes', () => {
    const started = Date.now();
    const next = computeNextRun('0 9 29 2 *', utc(2026, 3, 1), 'UTC');
    const w = wallClockIn(next, 'UTC');
    assert.equal(w.month, 2);
    assert.equal(w.day, 29);
    assert.equal(w.year, 2028, 'the next leap year');
    assert.ok(Date.now() - started < 3000, 'must not take seconds to answer');
  });

  it('THROWS on a schedule that can never fire', () => {
    // Silently never running is the worst outcome for a routine the operator
    // believes is armed.
    assert.throws(() => computeNextRun('0 0 30 2 *', utc(2026, 1, 1), 'UTC'), /no next occurrence/);
  });

  it('applies the classic DOM/DOW OR-rule, not AND', () => {
    // `0 0 13 * 5` is "the 13th, AND every Friday" - not "Friday the 13th".
    const next = computeNextRun('0 0 13 * 5', utc(2026, 6, 15, 12, 0), 'UTC');
    const w = wallClockIn(next, 'UTC');
    assert.ok(w.weekday === 5 || w.day === 13, 'either condition is enough');
    assert.ok(next < utc(2026, 7, 13), 'an AND reading would skip to July');
  });

  it('rejects an unknown timezone by name', () => {
    assert.throws(() => computeNextRun('0 9 * * *', Date.now(), 'Mars/Olympus'), /Unknown timezone/);
  });
});

describe('timezones and daylight saving', () => {
  it('keeps a 9am routine at 9am LOCAL on both sides of a DST change', () => {
    // The property that matters. Asserting remembered UTC offsets would test my
    // memory; asserting the local wall clock tests the engine.
    const tz = 'America/New_York';
    const winter = computeNextRun('0 9 * * *', utc(2026, 1, 15, 0, 0), tz);
    const summer = computeNextRun('0 9 * * *', utc(2026, 7, 15, 0, 0), tz);

    assert.equal(wallClockIn(winter, tz).hour, 9, 'winter local hour');
    assert.equal(wallClockIn(summer, tz).hour, 9, 'summer local hour');

    // ...and the UTC hour MUST differ, or the timezone is being ignored.
    assert.notEqual(
      new Date(winter).getUTCHours(),
      new Date(summer).getUTCHours(),
      'same UTC hour year-round means DST was not applied at all'
    );
  });

  it('works the same way in a southern-hemisphere zone', () => {
    const tz = 'Australia/Sydney';
    const jan = computeNextRun('0 9 * * *', utc(2026, 1, 15), tz);
    const jul = computeNextRun('0 9 * * *', utc(2026, 7, 15), tz);
    assert.equal(wallClockIn(jan, tz).hour, 9);
    assert.equal(wallClockIn(jul, tz).hour, 9);
    assert.notEqual(new Date(jan).getUTCHours(), new Date(jul).getUTCHours());
  });

  it('supports a half-hour offset zone', () => {
    const tz = 'Asia/Kolkata'; // UTC+5:30, no DST
    const next = computeNextRun('0 9 * * *', utc(2026, 6, 15, 0, 0), tz);
    const w = wallClockIn(next, tz);
    assert.equal(w.hour, 9);
    assert.equal(w.minute, 0);
    assert.equal(new Date(next).getUTCMinutes(), 30, 'a 5:30 offset shifts the UTC minute');
  });

  it('SPRING FORWARD: a routine at a non-existent local time still fires that day', () => {
    // On 2026-03-08 in New York, 02:30 never happens. Skipping to the next day
    // would silently drop a run; the engine fires just after the jump instead.
    const tz = 'America/New_York';
    const next = computeNextRun('30 2 * * *', utc(2026, 3, 8, 5, 0), tz);
    const w = wallClockIn(next, tz);
    assert.equal(w.day, 8, 'must not skip the day entirely');
    assert.ok(w.hour >= 2, `fired at ${w.hour}:${w.minute} local`);
  });

  it('FALL BACK: an ambiguous local time runs once, not twice', () => {
    // On 2026-11-01 in New York, 01:30 happens twice. The engine returns the
    // first, so the routine does not double-fire.
    const tz = 'America/New_York';
    const first = computeNextRun('30 1 * * *', utc(2026, 11, 1, 0, 0), tz);
    const w = wallClockIn(first, tz);
    assert.equal(w.hour, 1);
    assert.equal(w.minute, 30);

    const second = computeNextRun('30 1 * * *', first, tz);
    assert.equal(wallClockIn(second, tz).day, 2, 'the repeated hour must not trigger a second run');
  });

  it('UTC and a fixed-offset zone agree when there is no DST', () => {
    const a = computeNextRun('0 12 * * *', utc(2026, 6, 15), 'UTC');
    const b = computeNextRun('0 12 * * *', utc(2026, 6, 15), 'Etc/UTC');
    assert.equal(a, b);
  });
});

describe('describeNextRun', () => {
  it('reads naturally at each scale', () => {
    const now = utc(2026, 6, 15, 9, 0);
    assert.equal(describeNextRun(now + 60_000, now), 'in 1 minute');
    assert.equal(describeNextRun(now + 25 * 60_000, now), 'in 25 minutes');
    assert.equal(describeNextRun(now + 3 * 3_600_000, now), 'in 3 hours');
    assert.equal(describeNextRun(now + 5 * 86_400_000, now), 'in 5 days');
    assert.equal(describeNextRun(now - 1000, now), 'due now');
  });
});

