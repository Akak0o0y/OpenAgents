/**
 * Cortex constellation layout.
 *
 * The bot sits at the centre. The twelve layers wind outward from it in the
 * order the agent works - layer 1 closest, layer 12 furthest - so following the
 * spiral clockwise from the top reads the stack from cognition out to the
 * world. Tools hang off the layer they attach to, one step further out.
 *
 * World units: a WORLD x WORLD square centred on the bot; the component scales
 * it to the window. Nothing here decides what is LIT - that stays with
 * layerVisual() in the daemon source, where the hollow rule is tested.
 */

import { AGENT_LAYERS, type LayerId } from '@kernel/kernel/agent-layers.js';
import { mulberry32, type GalaxyNode } from '@kernel/cortex/galaxy.js';

export const WORLD = 1200;
export const HALF = WORLD / 2;
/** Radius of the glowing core the bot's face sits in. */
export const CORE_RADIUS = 78;

export interface Point {
  x: number;
  y: number;
}

const FIRST_RADIUS = 190;
const RADIUS_STEP = 20;
const START_ANGLE = -90;
const STEP_ANGLE = 360 / AGENT_LAYERS.length;
const TOOL_REACH = 122;
const TOOL_SPREAD = 16;

export function polar(radius: number, degrees: number): Point {
  const a = (degrees * Math.PI) / 180;
  return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
}

export function layerAngle(id: LayerId): number {
  return START_ANGLE + (id - 1) * STEP_ANGLE;
}

export function layerRadius(id: LayerId): number {
  return FIRST_RADIUS + (id - 1) * RADIUS_STEP;
}

export interface PlacedNode {
  node: GalaxyNode;
  point: Point;
  /** Direction from the centre, in degrees. Labels sit on the outer side. */
  angle: number;
  /** Where the node's link starts: its layer for a tool, the core for a layer. */
  anchor: Point;
}

/** Positions for every body, keeping the kernel's node list exactly as it is. */
export function placeNodes(nodes: readonly GalaxyNode[]): PlacedNode[] {
  const toolsByLayer = new Map<number, GalaxyNode[]>();
  for (const node of nodes) {
    if (node.kind !== 'tool') continue;
    const list = toolsByLayer.get(node.layerId) ?? [];
    list.push(node);
    toolsByLayer.set(node.layerId, list);
  }

  return nodes.map((node) => {
    const base = layerAngle(node.layerId);
    if (node.kind !== 'tool') {
      return { node, point: polar(layerRadius(node.layerId), base), angle: base, anchor: polar(CORE_RADIUS, base) };
    }
    const siblings = toolsByLayer.get(node.layerId) ?? [node];
    const index = siblings.indexOf(node);
    const angle = base + (index - (siblings.length - 1) / 2) * TOOL_SPREAD;
    // Many servers on one layer alternate between two reaches so they never touch.
    const reach = TOOL_REACH + (siblings.length > 3 ? (index % 2) * 58 : 0);
    return { node, point: polar(layerRadius(node.layerId) + reach, angle), angle, anchor: polar(layerRadius(node.layerId), base) };
  });
}

/**
 * A curved link between two points, bowed clockwise so every spoke leans the
 * same way - together they read as the arms of the old spiral.
 */
export function curvePath(from: Point, to: Point, bend = 0.16): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const cx = from.x + dx / 2 - (dy / length) * length * bend;
  const cy = from.y + dy / 2 + (dx / length) * length * bend;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

/** The spiral through every layer in order: a smooth Catmull-Rom curve. */
export function spiralPath(points: readonly Point[]): string {
  if (points.length < 2) return '';
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

export interface Star {
  x: number;
  y: number;
  r: number;
  opacity: number;
  /** Seconds. Negative so the twinkle is already mid-cycle on first paint. */
  delay: number;
  duration: number;
}

/**
 * The background sky. Deterministic per seed, like the old particle field, so
 * the View panel's seed and density controls keep meaning what they meant.
 */
export function starField(count: number, seed: number): Star[] {
  const rand = mulberry32(seed);
  const spread = WORLD * 1.7;
  return Array.from({ length: count }, () => ({
    x: (rand() - 0.5) * spread,
    y: (rand() - 0.5) * spread,
    r: 0.5 + rand() * rand() * 1.9,
    opacity: 0.18 + rand() * 0.55,
    delay: -rand() * 6,
    duration: 2.5 + rand() * 4.5,
  }));
}
