/**
 * A schedule must survive being saved and reopened.
 *
 * Intervals were added to the builder without teaching the editor to read one back, so
 * "@every 40m" returned as a custom cron trigger and the editor refused its own saved
 * routine with "a cron expression needs exactly five fields". A round trip is the only
 * test that would have caught it.
 */
import { describe, expect, it } from 'vitest';
import { triggersFromRoutine } from './GrokRoutineEditor.js';
import { triggerToCron, combineTriggers, type ScheduleTrigger } from '../lib/routineSchedule.js';

const routine = (cron: string) => ({
  id: 'r1', agent_id: 'milo', name: 'n', cron_expression: cron, human_schedule: '', timezone: 'Asia/Riyadh',
  prompt_template: 'p', task_name: null, enabled: 1, schedule_enabled: 1, catch_up_policy: 'skip',
  last_run_at: null, next_run_at: Date.now(), last_run_status: null, created_at: Date.now(), webhook_token: null,
} as never);

describe('a saved schedule reopens as what was saved', () => {
  it('reads an interval back as an interval, not as broken cron', () => {
    for (const [stored, minutes] of [['@every 40m', 40], ['@every 29m', 29], ['@every 300m', 300], ['@every 2h', 120], ['@every 1d', 1440]] as const) {
      const [trigger] = triggersFromRoutine(routine(stored)) as ScheduleTrigger[];
      expect(trigger.type, stored).toBe('schedule');
      expect(trigger.frequency, stored).toBe('interval');
      expect(trigger.intervalMinutes, stored).toBe(minutes);
      // And it must still be savable, or reopening would show an error on an untouched form.
      const rebuilt = triggerToCron(trigger);
      expect(rebuilt.ok, stored).toBe(true);
    }
  });

  it('round-trips: what the editor saves is what it reopens', () => {
    for (const minutes of [7, 29, 40, 90, 300]) {
      const first = combineTriggers(triggersFromRoutine(routine(`@every ${minutes}m`)));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = combineTriggers(triggersFromRoutine(routine(first.cron)));
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.cron).toBe(first.cron);
    }
  });

  it('still reads ordinary cron, and still falls back for anything else', () => {
    const [daily] = triggersFromRoutine(routine('0 9 * * *')) as ScheduleTrigger[];
    expect(daily.frequency).toBe('daily');
    const [odd] = triggersFromRoutine(routine('not a schedule at all')) as ScheduleTrigger[];
    expect(odd.frequency).toBe('custom');
  });
});
