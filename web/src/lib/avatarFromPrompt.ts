/**
 * Avatar generation, done locally.
 *
 * There is no image model in this stack and this file does not pretend
 * otherwise. What it does is real and useful: it reads a description and picks
 * a silhouette, a colour and eye settings from it — by keyword where the
 * description names one, and by a hash of the text where it does not.
 *
 * That makes the result DETERMINISTIC ("a calm blue researcher" always gives
 * the same bot) and explainable — the UI shows which words it matched, so the
 * operator can see it is keyword matching rather than believe an image model
 * interpreted their sentence.
 */

import { BOT_COLORS, type BotProfile } from './botProfile.js';
import { ALL_SHAPES, type AoraShape } from './aora-bot/shapes.js';

export interface GeneratedAvatar {
  shape: AoraShape;
  color: string;
  eyeColor: string;
  eyeScale: number;
  sketch: boolean;
  /** Which words drove the result, for the explanation shown to the operator. */
  matched: string[];
}

/** Words that name a shape, beyond the shape's own id. */
const SHAPE_WORDS: Record<AoraShape, string[]> = {
  blob: ['blob', 'round', 'circle', 'ball', 'soft'],
  pebble: ['pebble', 'stone', 'rock', 'smooth', 'calm', 'steady'],
  squircle: ['squircle', 'square', 'box', 'solid', 'block', 'sturdy'],
  tablet: ['tablet', 'wide', 'slab', 'bar', 'flat', 'screen'],
  wedge: ['wedge', 'triangle', 'sharp', 'arrow', 'fast', 'spike'],
  hex: ['hex', 'hexagon', 'technical', 'engineer', 'precise'],
  cloud: ['cloud', 'fluffy', 'dreamy', 'creative', 'airy', 'light'],
  teardrop: ['teardrop', 'drop', 'droplet', 'flame', 'water', 'ink'],
  crystal: ['crystal', 'diamond', 'gem', 'jewel', 'rhombus', 'facet'],
  capsule: ['capsule', 'pill', 'tall', 'upright', 'column'],
  bean: ['bean', 'kidney', 'lumpy', 'friendly', 'squishy'],
  shard: ['shard', 'kite', 'blade', 'edge', 'pointed', 'keen'],
};

/** Words that name a colour, beyond the swatch label itself. */
const COLOR_WORDS: Record<string, string[]> = {
  black: ['black', 'white', 'mono', 'monochrome', 'plain', 'neutral'],
  brown: ['brown', 'earth', 'coffee', 'wood', 'warm'],
  red: ['red', 'crimson', 'urgent', 'alert', 'bold'],
  orange: ['orange', 'amber', 'sunset', 'energetic'],
  yellow: ['yellow', 'gold', 'sunny', 'bright', 'cheerful'],
  green: ['green', 'emerald', 'growth', 'finance', 'healthy'],
  cyan: ['cyan', 'teal', 'aqua', 'fresh', 'clean'],
  blue: ['blue', 'ocean', 'sky', 'trust', 'reliable', 'analytical'],
  violet: ['violet', 'purple', 'creative', 'design', 'imaginative'],
  magenta: ['magenta', 'pink', 'playful', 'marketing', 'lively'],
  gray: ['gray', 'grey', 'silver', 'quiet', 'subtle', 'ops'],
};

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    value = (value << 5) - value + text.charCodeAt(i);
    value |= 0;
  }
  return Math.abs(value);
}

/**
 * Pick the entry whose words appear in the prompt, preferring the earliest
 * mention so "a red bot, not a blue one" gives red.
 */
function pickByWords<T extends string>(
  words: string[],
  table: Record<T, string[]>,
  keys: readonly T[]
): { key: T | null; matched: string[] } {
  let best: { key: T; index: number; word: string } | null = null;
  for (const key of keys) {
    for (const candidate of table[key]) {
      const index = words.indexOf(candidate);
      if (index >= 0 && (best === null || index < best.index)) {
        best = { key, index, word: candidate };
      }
    }
  }
  return best ? { key: best.key, matched: [best.word] } : { key: null, matched: [] };
}

/**
 * Turn a description into an avatar.
 *
 * An empty prompt returns null: "Generate" with nothing typed should stay
 * disabled, not invent a bot from the empty string.
 */
export function generateAvatarFromPrompt(prompt: string): GeneratedAvatar | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;

  const words = trimmed.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const seed = hash(trimmed.toLowerCase());

  const shapePick = pickByWords(words, SHAPE_WORDS, ALL_SHAPES);
  const colourIds = BOT_COLORS.map((c) => c.id);
  const colourPick = pickByWords(
    words,
    COLOR_WORDS as Record<string, string[]>,
    colourIds
  );

  const shape = shapePick.key ?? ALL_SHAPES[seed % ALL_SHAPES.length];
  const colourId = colourPick.key ?? colourIds[(seed >> 3) % colourIds.length];
  const colour = BOT_COLORS.find((c) => c.id === colourId) ?? BOT_COLORS[0];

  // A light body needs dark eyes to stay legible, and vice versa.
  const light = ['black', 'yellow'].includes(colour.id);
  const sketch = words.includes('sketch') || words.includes('drawn') || words.includes('hand');

  return {
    shape,
    color: colour.value,
    eyeColor: light ? '#1A1A1A' : '#FFFFFF',
    // A small deterministic wobble, so two bots with different descriptions but
    // the same shape and colour still differ a little.
    eyeScale: Math.round((0.85 + ((seed >> 7) % 40) / 100) * 100) / 100,
    sketch,
    matched: [...shapePick.matched, ...colourPick.matched, ...(sketch ? ['sketch'] : [])],
  };
}

/** The profile patch a generated avatar produces. */
export function toProfilePatch(generated: GeneratedAvatar): Partial<BotProfile> {
  return {
    shape: generated.shape,
    color: generated.color,
    eyeColor: generated.eyeColor,
    eyeScale: generated.eyeScale,
    sketch: generated.sketch,
    avatarImage: null,
  };
}
