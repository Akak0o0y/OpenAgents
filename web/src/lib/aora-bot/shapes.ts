/**
 * Bot silhouettes — all OpenAgents originals.
 *
 * WHY THIS FILE EXISTS AT ALL. The Aora engine ships three character
 * silhouettes (blob, wedge, gem) whose licence makes them permanently
 * non-commercial: unlike the engine and the emotion data, no commercial licence
 * is offered for them and none ever will be. Editing them would not help — a
 * modified silhouette is a derivative work and inherits the same restriction.
 *
 * So none of them are used. Every shape below is generated here from a formula:
 * a superellipse, a stadium, a rounded polygon, a union of disks, the classic
 * teardrop curve. Those are mathematical primitives, not anyone's artwork, so the results
 * are independent creations carrying no third-party terms. `registerShapes()`
 * writes them into the engine's shape table, which ships empty.
 *
 * What REMAINS Aora's is the expression engine and the emotion data — the state
 * machine, spring interpolation, eye rings, keyframes. That is a different
 * licence class: free for non-commercial use and commercially licensable. See
 * THIRD_PARTY_NOTICES.md.
 *
 * The engine consumes a shape as a closed 100-point polygon in its coordinate
 * system (viewBox -15 -15 259 259, centre 114.2705) plus a face fit. Defining
 * each as an "is this point inside" predicate and sampling it keeps the
 * definition readable and tunable by one number instead of 600 decimals.
 */

import { EB_RINGS } from './rings.js';

/**
 * The eight shapes the picker offers by default. The identifiers match the
 * vocabulary of the desktop reference; the geometry behind each is ours.
 */
export const BOT_SHAPES = [
  'blob',
  'pebble',
  'squircle',
  'tablet',
  'wedge',
  'hex',
  'cloud',
  'teardrop',
] as const;

export type BotShape = (typeof BOT_SHAPES)[number];

/** Four more OpenAgents silhouettes, beyond the reference's eight. */
export const EXTRA_SHAPES = ['crystal', 'capsule', 'bean', 'shard'] as const;

export type ExtraShape = (typeof EXTRA_SHAPES)[number];

export type AoraShape = BotShape | ExtraShape;

export const ALL_SHAPES: AoraShape[] = [...BOT_SHAPES, ...EXTRA_SHAPES];

/**
 * Shapes that existed in an earlier build and no longer do.
 *
 * `gem` was the Aora engine's third silhouette and has been replaced by
 * `crystal`, an original of the same character. A stored profile still naming
 * it is migrated rather than reset, so a bot that used it keeps a diamond
 * instead of silently reverting to the default round one.
 */
export const SHAPE_ALIASES: Record<string, AoraShape> = { gem: 'crystal' };

export function isBotShape(value: unknown): value is AoraShape {
  return typeof value === 'string' && (ALL_SHAPES as string[]).includes(value);
}

/** Resolve a stored value, following aliases. Returns null when unrecognised. */
export function resolveShape(value: unknown): AoraShape | null {
  if (typeof value !== 'string') return null;
  if (isBotShape(value)) return value;
  return SHAPE_ALIASES[value] ?? null;
}

const HEAD_C = 114.2705;
const RING_POINTS = 100;

type Inside = (x: number, y: number) => boolean;

// --------------------------------------------------------------- primitives --

function insideSuperellipse(a: number, b: number, n: number): Inside {
  return (x, y) => Math.pow(Math.abs(x / a), n) + Math.pow(Math.abs(y / b), n) <= 1;
}

function insideRoundedRect(hw: number, hh: number, r: number): Inside {
  const radius = Math.min(r, hw, hh);
  return (x, y) => {
    const dx = Math.abs(x) - (hw - radius);
    const dy = Math.abs(y) - (hh - radius);
    if (dx <= 0 || dy <= 0) return Math.abs(x) <= hw && Math.abs(y) <= hh;
    return dx * dx + dy * dy <= radius * radius;
  };
}

/** Convex polygon inset by `r` then dilated by `r` — i.e. rounded corners. */
function insideRoundedPolygon(vertices: Array<[number, number]>, r: number): Inside {
  const planes = vertices.map((v, i) => {
    const w = vertices[(i + 1) % vertices.length];
    const ex = w[0] - v[0];
    const ey = w[1] - v[1];
    const len = Math.hypot(ex, ey) || 1;
    const nx = ey / len;
    const ny = -ex / len;
    return { nx, ny, d: nx * v[0] + ny * v[1] - r };
  });
  return (x, y) => {
    let worst = -Infinity;
    for (const p of planes) worst = Math.max(worst, p.nx * x + p.ny * y - p.d);
    return worst <= r;
  };
}

function insideDisks(disks: Array<[number, number, number]>): Inside {
  return (x, y) => disks.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
}

/**
 * The classic teardrop curve, point up: x = sin t * sin(t/2)^m, y = -cos t.
 *
 * One curve from tip to base, so the sides flow into the round body with no
 * seam. `m` sets the point: 1 is a plump drop with nearly straight flanks,
 * higher values pinch the tip and hollow the sides just below it.
 */
function insideTeardrop(m: number): Inside {
  return (x, y) => {
    if (y < -1 || y > 1) return false;
    const t = Math.acos(-y);
    return Math.abs(x) <= Math.sin(t) * Math.pow(Math.sin(t / 2), m);
  };
}

/** Regular polygon vertices, `rotate` in radians, optionally squashed. */
function polygon(sides: number, rotate = 0, squashY = 1): Array<[number, number]> {
  return Array.from({ length: sides }, (_, i) => {
    const a = rotate + (2 * Math.PI * i) / sides;
    return [Math.cos(a), Math.sin(a) * squashY] as [number, number];
  });
}

/**
 * Sample a closed ring by bisecting along `RING_POINTS` rays from the centre.
 * Every shape here is star-shaped about its centre, which is what makes radial
 * sampling exact rather than an approximation that could clip a concavity.
 */
function ringFor(inside: Inside, centreY = 0): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < RING_POINTS; i++) {
    const theta = (2 * Math.PI * i) / RING_POINTS;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    let lo = 0;
    let hi = 3;
    for (let step = 0; step < 40; step++) {
      const mid = (lo + hi) / 2;
      if (inside(cos * mid, centreY + sin * mid)) lo = mid;
      else hi = mid;
    }
    points.push([cos * lo, centreY + sin * lo]);
  }
  return points;
}

/**
 * Fit to the engine's box, keeping the aspect ratio and centring on both axes.
 *
 * Scaling by width alone was wrong: a shape taller than it is wide — the
 * teardrop, whose point reaches well above its disk — ran off the top and had
 * its apex clipped. Scaling by whichever half-extent is larger means a wide
 * shape still fills the width and a tall one still fits.
 */
function toEngineRing(points: Array<[number, number]>): Array<[number, number]> {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const scale = HEAD_C / (Math.max((maxX - minX) / 2, (maxY - minY) / 2) || 1);
  return points.map(([x, y]) => [
    round2(HEAD_C + (x - midX) * scale),
    round2(HEAD_C + (y - midY) * scale),
  ]);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface ShapeFace {
  x: number;
  y: number;
  sx: number;
  sy: number;
  eye: number;
}

interface ShapeSpec {
  inside: Inside;
  centreY?: number;
  face: ShapeFace;
  /** How far the body leans into a head-tilt pose; a pointed body leans less. */
  tiltScale: number;
}

/**
 * The twelve silhouettes.
 *
 * `face` places and scales the eyes inside the body. Values are chosen so the
 * eyes sit in the widest part of each silhouette: a tablet is barely half as
 * tall as it is wide, so its face has to shrink or the eyes clip the edge.
 */
const SHAPE_SPECS: Record<AoraShape, ShapeSpec> = {
  // Round and generous, a touch taller than a plain circle.
  blob: {
    inside: insideSuperellipse(1, 1.02, 2.08),
    face: { x: 0, y: 0, sx: 1, sy: 1, eye: 1 },
    tiltScale: 1,
  },
  // Organic, wider than tall, corners softer than a circle's.
  pebble: {
    inside: insideSuperellipse(1, 0.94, 2.35),
    face: { x: 0, y: 0, sx: 0.96, sy: 0.96, eye: 0.99 },
    tiltScale: 1,
  },
  // A square that has forgotten its corners.
  squircle: {
    inside: insideSuperellipse(1, 1, 4),
    face: { x: 0, y: 0, sx: 0.94, sy: 0.94, eye: 1.06 },
    tiltScale: 0.95,
  },
  // A wide stadium: fully round ends, flat top and bottom.
  tablet: {
    inside: insideRoundedRect(1, 0.62, 0.62),
    face: { x: 0, y: 0, sx: 0.62, sy: 0.62, eye: 1.05 },
    tiltScale: 0.8,
  },
  // Rounded triangle, point up, sitting on a broad base. The corner radius is
  // large: a hard-edged triangle reads as a warning sign, not a character.
  wedge: {
    inside: insideRoundedPolygon(polygon(3, -Math.PI / 2, 1.05), 0.34),
    centreY: 0.12,
    face: { x: 0, y: 30, sx: 0.6, sy: 0.6, eye: 0.8 },
    tiltScale: 0.3,
  },
  // Flat-top hexagon with generously rounded corners.
  hex: {
    inside: insideRoundedPolygon(polygon(6, 0, 0.98), 0.16),
    face: { x: 0, y: 0, sx: 0.82, sy: 0.82, eye: 0.96 },
    tiltScale: 0.9,
  },
  // Overlapping lobes. Star-shaped about the centre, so the sampler still
  // traces the outline exactly.
  cloud: {
    inside: insideDisks([
      [-0.58, 0.14, 0.42],
      [-0.2, -0.22, 0.55],
      [0.28, -0.14, 0.5],
      [0.62, 0.16, 0.38],
      [0, 0.24, 0.56],
    ]),
    centreY: 0.02,
    face: { x: 0, y: 6, sx: 0.78, sy: 0.78, eye: 0.95 },
    tiltScale: 0.95,
  },
  // A water drop. This used to be a cone pushed into the top of a disk: the
  // cone's straight sides met the circle at an angle and left a dent on each
  // shoulder. It is one smooth curve now, sampled from inside its belly, with
  // the face lowered into the widest part.
  teardrop: {
    inside: insideTeardrop(1.25),
    centreY: 0.34,
    face: { x: 0, y: 26, sx: 0.7, sy: 0.7, eye: 0.92 },
    tiltScale: 0.5,
  },

  // ---- OpenAgents extras, beyond the reference's eight ----

  // Rounded diamond, standing on a point. The face has to be small: a diamond
  // is narrow everywhere except its own waist, and a wider one clipped an eye.
  crystal: {
    inside: insideRoundedPolygon(polygon(4, -Math.PI / 2, 1.06), 0.3),
    face: { x: 0, y: 8, sx: 0.62, sy: 0.62, eye: 0.86 },
    tiltScale: 0.85,
  },
  // A tall stadium: the tablet stood on its end.
  capsule: {
    inside: insideRoundedRect(0.66, 1, 0.66),
    face: { x: 0, y: 0, sx: 0.62, sy: 0.8, eye: 0.95 },
    tiltScale: 0.75,
  },
  // Two lobes leaning together, like a bean. The middle disk is deliberately
  // generous: a thinner waist pinched the lower-left in far enough to push an
  // eye outside the body, which the eye-containment test catches.
  bean: {
    inside: insideDisks([
      [-0.34, -0.12, 0.64],
      [0.34, 0.12, 0.62],
      [0, 0, 0.6],
    ]),
    face: { x: 0, y: 0, sx: 0.78, sy: 0.78, eye: 0.95 },
    tiltScale: 0.95,
  },
  // A kite: high shoulders and a long taper below, so it reads as clearly
  // taller and more directional than the diamond.
  shard: {
    inside: insideRoundedPolygon(
      [
        [0, -1.05],
        [0.62, -0.42],
        [0, 1.05],
        [-0.62, -0.42],
      ],
      0.2
    ),
    centreY: -0.16,
    face: { x: 0, y: -14, sx: 0.5, sy: 0.5, eye: 0.78 },
    tiltScale: 0.6,
  },
};

/** Human labels for the picker, so the UI never prints a raw identifier. */
export const SHAPE_LABELS: Record<AoraShape, string> = {
  blob: 'Blob',
  pebble: 'Pebble',
  squircle: 'Squircle',
  tablet: 'Tablet',
  wedge: 'Wedge',
  hex: 'Hex',
  cloud: 'Cloud',
  teardrop: 'Teardrop',
  crystal: 'Crystal',
  capsule: 'Capsule',
  bean: 'Bean',
  shard: 'Shard',
};

/**
 * Browsing families, so the gallery can offer a few characters rather than a
 * wall of twelve. Purely a grouping for the picker; the engine knows nothing
 * about it.
 */
export const SHAPE_FAMILIES: Array<{
  id: string;
  name: string;
  description: string;
  shapes: AoraShape[];
}> = [
  {
    id: 'round',
    name: 'Rounds',
    description: 'Soft and approachable. Superellipses and stadiums.',
    shapes: ['blob', 'pebble', 'squircle', 'tablet', 'capsule'],
  },
  {
    id: 'angular',
    name: 'Angular',
    description: 'Faceted and decisive. Rounded polygons.',
    shapes: ['wedge', 'hex', 'crystal', 'shard'],
  },
  {
    id: 'organic',
    name: 'Organic',
    description: 'Irregular and lively. Unions of overlapping disks.',
    shapes: ['cloud', 'teardrop', 'bean'],
  },
];

export function familyOfShape(shape: AoraShape) {
  return SHAPE_FAMILIES.find((f) => f.shapes.includes(shape)) ?? SHAPE_FAMILIES[0];
}

/**
 * Write every silhouette into the engine's shape table.
 *
 * The table ships EMPTY — the upstream character geometry is not bundled — so
 * this is not an augmentation, it is the whole supply. It must therefore run
 * before any ball is created, which the side-effect import in ./index.ts and
 * the call below guarantee. Idempotent, so repeated imports are free.
 */
export function registerShapes(): void {
  const target = (EB_RINGS as any).SHAPES as Record<string, unknown>;
  for (const [id, spec] of Object.entries(SHAPE_SPECS)) {
    if (target[id]) continue;
    target[id] = {
      ring: toEngineRing(ringFor(spec.inside, spec.centreY ?? 0)),
      face: spec.face,
      tiltScale: spec.tiltScale,
    };
  }
}

registerShapes();

/** @deprecated Kept for one release; `registerShapes` is the name now. */
export const registerOpenAgentsShapes = registerShapes;
