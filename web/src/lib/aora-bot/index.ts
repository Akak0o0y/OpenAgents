/**
 * aora-bot Emotion Ball Expression Engine for OpenAgents
 * Zero-dependency pure SVG + spring physics expression engine.
 */

import { EmotionBall } from './engine.js';
// Side-effect import: registers the OpenAgents silhouettes with the engine
// before anything can ask for one.
import './shapes.js';
import type { AoraShape } from './shapes.js';
import { EMOTION_SEED, EMOTION_GROUPS } from './emotions.js';
import { EB_RINGS } from './rings.js';

export interface EmotionBallOptions {
  emotion?: string;
  /**
   * Any shape id registered with the engine. The engine ships three; the six
   * OpenAgents originals are registered by `./shapes.js` at import time, so this
   * is deliberately the wider union rather than the engine's three.
   */
  shape?: AoraShape;
  color?: string;
  eyeColor?: string;
  eyeScale?: number;
  idle?: boolean | { standbyAfter?: number; sleepAfter?: number; standbyId?: string; sleepId?: string };
  autostart?: boolean;
  fallbackId?: string;
  lite?: boolean;
  label?: string;
}

export interface EmotionBallInstance {
  ball: {
    svg: SVGSVGElement;
    applyPose: (pose: any) => void;
    burst?: (count?: number) => void;
    destroy: () => void;
  };
  emotionId: string | null;
  touring: boolean;
  setEmotion: (id: string, opts?: { auto?: boolean }) => boolean;
  setGaze: (nx: number, ny: number) => EmotionBallInstance;
  clearGaze: () => EmotionBallInstance;
  setStyle: (style: { sketch?: number }) => EmotionBallInstance;
  startTour: (ids: string[], interval?: number) => void;
  stopTour: () => void;
  resetIdle: () => void;
  spin: (turns?: number, dir?: number) => EmotionBallInstance;
  bounce: () => EmotionBallInstance;
  burst: (count?: number) => EmotionBallInstance;
  setActive: (on: boolean) => void;
  renderStatic: () => void;
  destroy: () => void;
  on: (event: string, callback: (payload?: any) => void) => EmotionBallInstance;
  off: (event: string, callback: (payload?: any) => void) => EmotionBallInstance;
  handleAIMessage: (msg: string | { emotionId: string; tips?: string }) => boolean;
  registerEmotion: (raw: unknown) => { ok: boolean; id?: string; errors?: string[] };
}

export interface EmotionDefinition {
  id: string;
  name?: string;
  en?: string;
  group?: string;
  [key: string]: unknown;
}

export interface EmotionRegistry {
  register: (raw: unknown) => { ok: boolean; id?: string; errors?: string[] };
  get: (id: string) => EmotionDefinition | null;
  list: (group?: string) => EmotionDefinition[];
  groups: () => Array<{ key: string; name: string; en: string }>;
  exportConfig: () => string;
  importConfig: (json: string | unknown) => { ok: boolean; added: number; errors: string[] };
}

export function createEmotionBall(container: HTMLElement, options?: EmotionBallOptions): EmotionBallInstance {
  return EmotionBall.create(container, options);
}

export const emotionRegistry = EmotionBall.config as EmotionRegistry;

export function exportEmotionConfig(): string {
  return emotionRegistry.exportConfig();
}

export function importEmotionConfig(json: string): { ok: boolean; added: number; errors: string[] } {
  return emotionRegistry.importConfig(json);
}

export { EmotionBall, EMOTION_SEED, EMOTION_GROUPS, EB_RINGS };
export {
  BOT_SHAPES,
  EXTRA_SHAPES,
  ALL_SHAPES,
  SHAPE_LABELS,
  SHAPE_FAMILIES,
  familyOfShape,
  isBotShape,
  resolveShape,
  type AoraShape,
  type BotShape,
} from './shapes.js';

/**
 * Generated personalities.
 *
 * Every silhouette in the parity set is represented, so a fleet of bots reads
 * as a fleet rather than three repeated characters. `gem` is excluded: it is an
 * Aora extra that the picker keeps out of the parity swatches, and generating
 * it would put a shape on screen that the operator cannot re-select.
 */
const PALETTES: Array<{ color: string; eyeColor: string; shape: AoraShape }> = [
  { color: '#2C86F0', eyeColor: '#FFFFFF', shape: 'blob' },
  { color: '#1FB973', eyeColor: '#FFFFFF', shape: 'pebble' },
  { color: '#8A5CF0', eyeColor: '#FFFFFF', shape: 'squircle' },
  { color: '#F2A324', eyeColor: '#1A1A1A', shape: 'tablet' },
  { color: '#EC3F97', eyeColor: '#FFFFFF', shape: 'wedge' },
  { color: '#16B3A4', eyeColor: '#FFFFFF', shape: 'hex' },
  { color: '#F0384B', eyeColor: '#FFFFFF', shape: 'cloud' },
  { color: '#F5701A', eyeColor: '#FFFFFF', shape: 'teardrop' },
  { color: '#8C6239', eyeColor: '#FFFFFF', shape: 'crystal' },
  { color: '#7A7F87', eyeColor: '#FFFFFF', shape: 'bean' },
  { color: '#16B3A4', eyeColor: '#FFFFFF', shape: 'capsule' },
  { color: '#F0384B', eyeColor: '#FFFFFF', shape: 'shard' },
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Deterministically generates a consistent bot face personality (shape & color palette)
 * based on agent id and model so every agent has a unique visual character.
 */
export function getAgentBotPersonality(agent?: string | { id?: string; name?: string; model_id?: string }): {
  shape: AoraShape;
  color: string;
  eyeColor: string;
} {
  if (!agent) {
    return PALETTES[0];
  }
  if (typeof agent === 'string') {
    const idx = hashString(agent) % PALETTES.length;
    return PALETTES[idx];
  }
  if (!agent.id) {
    return PALETTES[0];
  }
  const key = `${agent.id}:${agent.name ?? ''}:${agent.model_id ?? ''}`;
  const idx = hashString(key) % PALETTES.length;
  return PALETTES[idx];
}

/**
 * Maps agent or task execution status to an appropriate EmotionBall emotion ID.
 *
 * ID catalog reference:
 * - 00: Sleep (eyes shut, zzz particles)
 * - 01: Wake up
 * - 02: Idle calm (glances around)
 * - 03: Curious
 * - 04: Spacing out
 * - 30: Thinking (head tilt, halo ribbon)
 * - 31: Receiving task
 * - 32: Busy / Processing
 * - 33: Done / Celebrate (ribbon spin & confetti burst)
 * - 34: Error (flashing alarm red)
 * - 35: Listening / Waiting for prompt
 * - 36: Network loading
 */
export function getAgentEmotion(
  status?: string,
  options?: { isChatting?: boolean; isThinking?: boolean; hasError?: boolean; isSuccess?: boolean }
): string {
  if (options?.hasError) return '34';
  if (options?.isSuccess) return '33';
  if (options?.isThinking) return '30';
  if (options?.isChatting) return '35';

  const s = (status || '').toUpperCase();
  switch (s) {
    case 'RUNNING':
    case 'BUSY':
      return '30'; // Thinking with orbiting ribbon
    case 'QUEUED':
      return '35'; // Waiting attentively
    case 'COMPLETED':
      return '33'; // Done & celebratory
    case 'FAILED':
    case 'CRASHED':
      return '34'; // Glitch alarm red
    case 'PAUSED':
    case 'ABORTED':
      return '04'; // Spacing out
    case 'DISABLED':
      return '00'; // Sleeping with zzz
    case 'IDLE':
    default:
      return '02'; // Calm breathing idle
  }
}
