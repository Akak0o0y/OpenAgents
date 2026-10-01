/**
 * Posting event lines (spec 10.1). The titles are fixed text; a line never shows a
 * text hash, a reply target or a publish id.
 */
import { describe, expect, it } from 'vitest';
import { describeEvent } from './describeEvent.js';
import type { EventRow } from './transport.js';

const POST_URL = 'https://x.com/example_account/status/1234567890123456789';
const HASH = 'a'.repeat(64);
const TARGET = '2102311000000000001';

function event(event_type: string, payload: Record<string, unknown> | string): EventRow {
  return {
    id: 1, task_run_id: 'run-1790074518658-wveu4', agent_id: 'milo', event_type,
    payload_json: typeof payload === 'string' ? payload : JSON.stringify(payload), timestamp: Date.UTC(2026, 8, 22, 10, 56, 50),
  };
}

describe('posting event lines', () => {
  it('names a sent post and never shows its hash, reply target or ids', () => {
    const line = describeEvent(event('PUBLISH_ATTEMPTED', {
      publishId: 'pub-1', actionId: 'act-1', by: 'model', probe: 'x.com/create-tweet', op: 'reply', origin: 'https://x.com', textSha256: HASH, inReplyTo: TARGET, sentAt: 1,
    }));
    expect(line).toEqual({ title: 'Sent a post to x.com' });
    expect(JSON.stringify(line)).not.toMatch(new RegExp(`${HASH}|${TARGET}|pub-1|act-1`));
  });

  it('titles each response verdict', () => {
    expect(describeEvent(event('PUBLISH_OBSERVED', { publishId: 'pub-1', outcome: 'confirmed', postId: '1234567890123456789', postUrl: POST_URL, settledAt: 2 })))
      .toEqual({ title: 'x.com confirmed the post', link: { href: POST_URL, label: 'Open' } });
    expect(describeEvent(event('PUBLISH_OBSERVED', { publishId: 'pub-1', outcome: 'rejected', reason: 'code 187', errorCodes: [187], settledAt: 2 })))
      .toEqual({ title: 'x.com refused the post', detail: 'code 187' });
    expect(describeEvent(event('PUBLISH_OBSERVED', { publishId: 'pub-1', outcome: 'unobserved', reason: 'timeout', settledAt: 2 })))
      .toEqual({ title: 'Post not confirmed', detail: 'timeout' });
  });

  it('titles each page-check verdict', () => {
    expect(describeEvent(event('PUBLISH_RECONCILED', { publishId: 'pub-1', verdict: 'present', postUrl: POST_URL, by: 'page-check' })))
      .toEqual({ title: 'Found the post on the page', link: { href: POST_URL, label: 'Open' } });
    expect(describeEvent(event('PUBLISH_RECONCILED', { publishId: 'pub-1', verdict: 'not-found', by: 'page-check' })))
      .toEqual({ title: 'Post not found on the page' });
  });

  it('titles each held-back reason, and falls back without throwing for one it does not know', () => {
    const reasons = ['budget', 'duplicate-text', 'duplicate-target', 'expected-mismatch', 'internal', 'rate-limit', 'constructor'];
    const titles = Object.fromEntries(reasons.map((reason) =>
      [reason, describeEvent(event('PUBLISH_REFUSED', { probe: 'x.com/create-tweet', op: 'reply', reason, by: 'model' })).title]));
    expect(titles).toEqual({
      budget: 'Held back a second post',
      'duplicate-text': 'Held back a repeated post',
      'duplicate-target': 'Held back a repeated post',
      'expected-mismatch': 'Held back a post that did not match',
      internal: 'Held back a post after an internal error',
      'rate-limit': 'Held back a post',
      constructor: 'Held back a post',
    });
    expect(() => describeEvent(event('PUBLISH_REFUSED', 'not json'))).not.toThrow();
    expect(describeEvent(event('PUBLISH_REFUSED', 'not json')).title).toBe('Held back a post');
  });

  it('titles the owner’s acknowledgement', () => {
    expect(describeEvent(event('EXTERNAL_ACTION_ACKNOWLEDGED', { key: 'act-1', kind: 'action', by: 'operator', at: 3 }))).toEqual({ title: 'Owner checked it' });
  });

  it('titles character refusals and never shows hashes or ids', () => {
    const line = describeEvent(event('CHARACTER_REFUSED', {
      reason: 'character-unadmitted', utteranceId: 'utt-1', textSha256: HASH,
    }));
    expect(line).toEqual({ title: 'Held back text not prepared in character' });
    expect(JSON.stringify(line)).not.toMatch(new RegExp(`${HASH}|utt-1`));

    expect(describeEvent(event('PUBLISH_REFUSED', { reason: 'character-unadmitted' })).title)
      .toBe('Held back a post not prepared in character');
    expect(describeEvent(event('PUBLISH_REFUSED', { reason: 'character-unverifiable' })).title)
      .toBe('Held back a post that could not be matched exactly');
  });

  it('describes the recorded post outcome', () => {
    const line = describeEvent(event('CHARACTER_POSTED', { utteranceId: 'utt-1', publishId: 'pub-1', status: 'confirmed' }));
    expect(line).toEqual({ title: 'Recorded post outcome' });
  });
});
