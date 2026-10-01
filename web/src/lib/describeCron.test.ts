/**
 * The routine list showed an older, hand-made routine as "0 * * * *". Common
 * cron shapes are put in words; anything unusual stays as written.
 */

import { describe, expect, it } from 'vitest';
import { describeCron } from './routineSchedule.js';

describe('cron in words', () => {
  it('puts the common shapes in words and leaves the rest as written', () => {
    expect(describeCron('0 * * * *')).toBe('every hour');
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes');
    expect(describeCron('30 * * * *')).toBe('every hour at :30');
    expect(describeCron('0 9 * * *')).toBe('every day at 9:00 AM');
    expect(describeCron('0 18 * * 1-5')).toBe('every weekday at 6:00 PM');
    expect(describeCron('0 9 * * 1')).toBe('every Monday at 9:00 AM');
    expect(describeCron('0 9 1 * *')).toBe('0 9 1 * *');
    expect(describeCron('not cron')).toBe('not cron');
  });
});
