/**
 * Local avatar generation.
 *
 * The claim the UI makes is "deterministic, keyword-driven, no image model".
 * These tests hold that claim to account — particularly determinism, which is
 * the whole reason it is honest to call this generation rather than a shuffle.
 */

import { describe, expect, it } from 'vitest';
import { generateAvatarFromPrompt, toProfilePatch } from './avatarFromPrompt.js';
import { BOT_COLORS } from './botProfile.js';
import { ALL_SHAPES } from './aora-bot/shapes.js';

const colourValue = (id: string) => BOT_COLORS.find((c) => c.id === id)!.value;

describe('generateAvatarFromPrompt', () => {
  it('returns nothing for an empty prompt', () => {
    expect(generateAvatarFromPrompt('')).toBeNull();
    expect(generateAvatarFromPrompt('   ')).toBeNull();
  });

  it('is deterministic: the same description always gives the same bot', () => {
    const a = generateAvatarFromPrompt('a thoughtful research assistant');
    const b = generateAvatarFromPrompt('a thoughtful research assistant');
    expect(a).toEqual(b);
  });

  it('gives different descriptions different results', () => {
    const a = generateAvatarFromPrompt('alpha');
    const b = generateAvatarFromPrompt('beta');
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('honours a named shape', () => {
    expect(generateAvatarFromPrompt('a hexagon bot')!.shape).toBe('hex');
    expect(generateAvatarFromPrompt('something cloud-like')!.shape).toBe('cloud');
    expect(generateAvatarFromPrompt('a sharp wedge')!.shape).toBe('wedge');
  });

  it('reaches the shapes added beyond the reference set', () => {
    expect(generateAvatarFromPrompt('a diamond bot')!.shape).toBe('crystal');
    expect(generateAvatarFromPrompt('a tall pill')!.shape).toBe('capsule');
    expect(generateAvatarFromPrompt('a friendly bean')!.shape).toBe('bean');
    expect(generateAvatarFromPrompt('a keen blade')!.shape).toBe('shard');
  });

  it('honours a named colour', () => {
    expect(generateAvatarFromPrompt('a red alert bot')!.color).toBe(colourValue('red'));
    expect(generateAvatarFromPrompt('calm blue')!.color).toBe(colourValue('blue'));
  });

  it('prefers the first colour mentioned, so a correction wins', () => {
    expect(generateAvatarFromPrompt('red, not blue')!.color).toBe(colourValue('red'));
    expect(generateAvatarFromPrompt('blue, not red')!.color).toBe(colourValue('blue'));
  });

  it('reads role words as a hint, not just literal colour names', () => {
    expect(generateAvatarFromPrompt('a design bot')!.color).toBe(colourValue('violet'));
    expect(generateAvatarFromPrompt('a finance bot')!.color).toBe(colourValue('green'));
  });

  it('reports which words it matched, so the UI can explain itself', () => {
    const result = generateAvatarFromPrompt('a red hexagon');
    expect(result!.matched).toContain('hexagon');
    expect(result!.matched).toContain('red');
  });

  it('reports no matches when it fell back to the hash', () => {
    const result = generateAvatarFromPrompt('zzzz qqqq');
    expect(result!.matched).toEqual([]);
    // ...and still produces something valid.
    expect(ALL_SHAPES).toContain(result!.shape);
  });

  it('always produces a shape and colour from the offered sets', () => {
    const values = BOT_COLORS.map((c) => c.value);
    for (const prompt of ['a', 'quick brown fox', 'ops bot', '12345', 'ünïcödé']) {
      const result = generateAvatarFromPrompt(prompt)!;
      expect(ALL_SHAPES, prompt).toContain(result.shape);
      expect(values, prompt).toContain(result.color);
    }
  });

  it('gives a light body dark eyes, so the face stays legible', () => {
    expect(generateAvatarFromPrompt('a black and white bot')!.eyeColor).toBe('#1A1A1A');
    expect(generateAvatarFromPrompt('a blue bot')!.eyeColor).toBe('#FFFFFF');
  });

  it('turns on sketch rendering only when asked', () => {
    expect(generateAvatarFromPrompt('a sketch bot')!.sketch).toBe(true);
    expect(generateAvatarFromPrompt('a blue bot')!.sketch).toBe(false);
  });

  it('keeps the eye scale inside the range the profile validator accepts', () => {
    for (const prompt of ['a', 'bb', 'ccc', 'a longer description entirely']) {
      const { eyeScale } = generateAvatarFromPrompt(prompt)!;
      expect(eyeScale).toBeGreaterThanOrEqual(0.5);
      expect(eyeScale).toBeLessThanOrEqual(2);
    }
  });
});

describe('toProfilePatch', () => {
  it('clears any uploaded image, because a generated avatar replaces it', () => {
    const patch = toProfilePatch(generateAvatarFromPrompt('a green pebble')!);
    expect(patch.avatarImage).toBeNull();
    expect(patch.shape).toBe('pebble');
    expect(patch.color).toBe(colourValue('green'));
  });
});
