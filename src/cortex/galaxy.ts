/**
 * Cortex galaxy geometry.
 *
 * The 12 ECC layers become a spiral galaxy: layer 1 at the warm amber core,
 * layer 12 at the violet rim, tools orbiting the bands they attach to.
 *
 * Moving to 3D does not relax the rule the 2D panel was built around:
 *
 *   A LAYER NEVER RENDERS AS ALIVE FROM DATA IT DOES NOT HAVE.
 *
 * In a particle field "alive" means lit, saturated and dense, so hollow layers
 * get a sparse grey ghost arm that ACTIVITY CANNOT CHANGE. That is enforced
 * here, in pure functions the Node test suite runs - not in a shader nobody can
 * assert against.
 *
 * Everything is deterministic given a seed, so a test can compare two galaxies
 * particle-for-particle and a re-render never reshuffles the sky.
 */

import { AGENT_LAYERS, type AgentLayer, type LayerId } from '../kernel/agent-layers.js';
import type { CortexActivity } from './layer-view.js';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

/** Warm amber at the core. */
export const CORE_COLOR: Rgb = [1.0, 0.7, 0.28];
/** Violet at the outer rim. */
export const RIM_COLOR: Rgb = [0.55, 0.36, 0.96];
/** Hollow layers: slate, deliberately outside the amber-violet ramp entirely. */
export const HOLLOW_COLOR: Rgb = [0.29, 0.32, 0.39];
/** Layer 11 when a repair loop fired. */
export const ALARM_COLOR: Rgb = [0.97, 0.32, 0.29];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * The core-to-rim ramp. `t` is 0 at the galactic centre and 1 at the rim.
 * Monotonic by construction: red falls, blue rises, all the way out.
 */
export function rampColor(t: number): Rgb {
  const clamped = Math.min(1, Math.max(0, t));
  return mixRgb(CORE_COLOR, RIM_COLOR, clamped);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export const GALAXY = {
  /** Radius of layer 1's band. */
  innerRadius: 3.4,
  /** Distance between successive layer bands. */
  bandGap: 2.05,
  /** Radial spread of particles within one band. */
  bandSpread: 0.78,
  /** How tightly the arms wind. Higher = more curl. */
  spiralTightness: 0.42,
  /** Arms in the spiral. Layers are distributed across them. */
  arms: 3,
  /** Disc half-thickness at the core; the disc thins toward the rim. */
  coreThickness: 0.72,
  particlesPerLayer: 1400,
  /** Hollow layers get a fraction of the particles: present, but plainly sparse. */
  hollowParticleRatio: 0.22,
} as const;

/** Mean radius of a layer's band. */
export function bandRadius(layerId: LayerId): number {
  return GALAXY.innerRadius + (layerId - 1) * GALAXY.bandGap;
}

/** 0 at the core band, 1 at the rim band. Drives the colour ramp. */
export function bandT(layerId: LayerId): number {
  return (layerId - 1) / (AGENT_LAYERS.length - 1);
}

/** Deterministic PRNG. A fixed seed must always produce the same sky. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so the disc thins naturally instead of ending in a hard edge. */
function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export interface GalaxyField {
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  /** Particle count actually emitted per layer. */
  countByLayer: Record<number, number>;
  total: number;
}

/**
 * Build the particle field.
 *
 * The single most important line in this file is the `hollow` branch: it is
 * evaluated BEFORE activity is consulted and returns a fixed grey, so no amount
 * of events can light up a layer this runtime does not have.
 */
export function buildGalaxy(
  activity: CortexActivity,
  options: { seed?: number; particlesPerLayer?: number } = {}
): GalaxyField {
  const rand = mulberry32(options.seed ?? 0x5eed);
  const perLayer = options.particlesPerLayer ?? GALAXY.particlesPerLayer;

  const counts: number[] = AGENT_LAYERS.map((l) =>
    l.status === 'hollow' ? Math.round(perLayer * GALAXY.hollowParticleRatio) : perLayer
  );
  const total = counts.reduce((n, c) => n + c, 0);

  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const sizes = new Float32Array(total);
  const countByLayer: Record<number, number> = {};

  let i = 0;
  AGENT_LAYERS.forEach((layer, layerIndex) => {
    const count = counts[layerIndex];
    countByLayer[layer.id] = count;

    const radius = bandRadius(layer.id);
    const t = bandT(layer.id);
    const hollow = layer.status === 'hollow';

    // Activity is read ONCE, here, and is never consulted for a hollow layer.
    const isActive = !hollow && activity.activeLayer === layer.id;
    const isAlarming = !hollow && activity.alarm && layer.id === 11;
    const hasEvents = !hollow && (activity.eventCounts[layer.id] ?? 0) > 0;

    const baseColor: Rgb = hollow ? HOLLOW_COLOR : isAlarming ? ALARM_COLOR : rampColor(t);

    // Unlit layers sit dark; lit ones brighten. Hollow is pinned low and cannot
    // be raised, which is the whole point.
    // 0.5 left the violet rim too dark to read as violet at all, which lost the
    // core-to-rim gradient the whole layout is built on. Raised to 0.66 - still
    // clearly below `hasEvents`, and still far above hollow.
    const luminance = hollow ? 0.34 : isActive ? 1.0 : hasEvents ? 0.85 : 0.66;
    const baseSize = hollow ? 0.055 : isActive ? 0.13 : hasEvents ? 0.105 : 0.085;

    for (let n = 0; n < count; n++) {
      const arm = n % GALAXY.arms;
      const armAngle = (arm / GALAXY.arms) * Math.PI * 2;

      // Radial jitter, densest at the band centre.
      const r = radius + gaussian(rand) * GALAXY.bandSpread;
      const spiral = r * GALAXY.spiralTightness;
      const scatter = (rand() - 0.5) * 0.55;
      const angle = armAngle + spiral + scatter;

      // The disc is fat at the core and thin at the rim, like a real one.
      const thickness = GALAXY.coreThickness * (1 - t * 0.72);
      const y = gaussian(rand) * thickness * (hollow ? 0.5 : 1);

      positions[i * 3] = Math.cos(angle) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(angle) * r;

      // Per-particle brightness wobble so the field has depth rather than
      // reading as twelve flat bands of solid colour.
      const flicker = 0.82 + rand() * 0.36;
      colors[i * 3] = baseColor[0] * luminance * flicker;
      colors[i * 3 + 1] = baseColor[1] * luminance * flicker;
      colors[i * 3 + 2] = baseColor[2] * luminance * flicker;

      sizes[i] = baseSize * (0.7 + rand() * 0.7);
      i++;
    }
  });

  return { positions, colors, sizes, countByLayer, total };
}

// ---------------------------------------------------------------------------
// Selectable bodies
// ---------------------------------------------------------------------------

export type NodeKind = 'layer' | 'tool' | 'agent';
export type NodeStatus = 'live' | 'partial' | 'hollow' | 'planned';

export interface GalaxyNode {
  kind: NodeKind;
  /** Stable id: `layer-7`, `tool-mcp`. */
  id: string;
  label: string;
  /** Which band this body sits on. Tools inherit the layer they attach to. */
  layerId: LayerId;
  status: NodeStatus;
  position: [number, number, number];
  /** One-line description shown on focus. */
  description: string;
  /** How this is (or is not) wired into the runtime. */
  integration: string;
  /** Event types that prove this body is doing something. */
  eventTypes: readonly string[];
}

/** Tools and external systems, and the truth about whether they are attached. */
interface ToolSpec {
  id: string;
  label: string;
  layerId: LayerId;
  status: 'live' | 'planned';
  description: string;
  integration: string;
  eventTypes: readonly string[];
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    id: 'tool-test-container',
    label: 'Test Container',
    layerId: 7,
    status: 'live',
    description: 'The hardened container whose exit code IS the verdict.',
    integration:
      'DockerSandbox.executeTask(): --network none, --cap-drop ALL, --read-only, no secrets. ' +
      'It is the only thing allowed to decide pass or fail, precisely because it can reach nothing.',
    eventTypes: ['TURN_COMPLETED'],
  },
  {
    id: 'tool-opencode',
    label: 'OpenCode Session',
    layerId: 6,
    status: 'live',
    description: 'The agent container running the opencode CLI.',
    integration:
      'runAgentContainer(): networked and given exactly one provider credential - the only ' +
      'container that ever receives a secret. Session-level events are parsed; individual tool ' +
      'calls are NOT, because that envelope has not been confirmed against a live session.',
    eventTypes: ['OPENCODE_SESSION'],
  },
  {
    id: 'tool-cost-ledger',
    label: 'Cost Ledger',
    layerId: 12,
    status: 'live',
    description: 'Pre-dispatch reservation, reconciliation, and crash accounting.',
    integration:
      'Every provider call reserves budget BEFORE dispatch and reconciles after. A session that ' +
      'cannot be observed is recorded as UNRECONCILED_ASSUMED_SPENT, never as $0.',
    eventTypes: ['TASK_COMPLETED', 'TASK_FAILED'],
  },
  {
    id: 'tool-mcp',
    label: 'MCP Servers',
    layerId: 7,
    status: 'planned',
    description: 'No MCP server is configured on this daemon.',
    integration:
      'The client is built and tested (Phase D), but MCP_SERVERS is empty, so nothing is ' +
      'connected. Servers run in the DAEMON, never in the executor container: they hold real ' +
      'host access, so letting sandboxed agent code reach one would defeat the sandbox. Access ' +
      'is allowlisted per agent and defaults to DENY.',
    eventTypes: [],
  },
  {
    id: 'tool-obsidian',
    label: 'Obsidian Vault',
    layerId: 3,
    status: 'planned',
    description: 'Explicit vault snapshots can feed bot-scoped long-term memory.',
    integration:
      'Configure obsidianVault for a bot and use its Memory and Obsidian controls to import or export notes. ' +
      'This graph has no live vault connection status, so this satellite does not claim an active connection. ' +
      'Memory writes and recall are independently recorded on layers 3 and 5.',
    eventTypes: [],
  },
];

/** Where a tool sits: on its layer's band, fanned out so satellites never stack. */
export function toolPosition(index: number, total: number, layerId: LayerId): [number, number, number] {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 + 0.7;
  const r = bandRadius(layerId) + 1.15;
  return [Math.cos(angle) * r, 1.5 + (index % 2) * 0.9, Math.sin(angle) * r];
}

/** A representative point on a layer's band, used as its clickable body. */
export function layerPosition(layerId: LayerId): [number, number, number] {
  const r = bandRadius(layerId);
  const angle = r * GALAXY.spiralTightness + Math.PI * 0.5;
  return [Math.cos(angle) * r, 0, Math.sin(angle) * r];
}

/** Live MCP status, as served by GET /api/mcp. */
export interface McpNodeInfo {
  name: string;
  connected: boolean;
  tools: string[];
  callsUsed: number;
  quota: number;
  error?: string;
}

/**
 * Turn real MCP status into galaxy bodies.
 *
 * A server is drawn LIVE only when the daemon reports it actually connected.
 * Being listed in config is not enough - that is the difference between "I
 * intend to have this tool" and "this tool answered".
 */
function mcpNodes(servers: readonly McpNodeInfo[], startIndex: number, total: number): GalaxyNode[] {
  return servers.map((server, i) => ({
    kind: 'tool' as const,
    id: `mcp-${server.name}`,
    label: `MCP: ${server.name}`,
    layerId: 7 as LayerId,
    status: server.connected ? ('live' as const) : ('planned' as const),
    position: toolPosition(startIndex + i, total, 7),
    description: server.connected
      ? `Connected. ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'} exposed.`
      : `Configured but NOT connected. ${server.error ?? 'No reason reported.'}`,
    integration: server.connected
      ? `Runs in the daemon, never in the executor container. Tools: ${server.tools.join(', ') || 'none exposed'}. ` +
        `Calls this run: ${server.callsUsed}/${server.quota}. Access is allowlisted per agent and defaults to DENY.`
      : `This server is in MCP_SERVERS but did not connect, so no agent can call it. ${server.error ?? ''}`,
    eventTypes: server.connected ? ['TOOL_CALL'] : [],
  }));
}

/**
 * Every selectable body in the galaxy, layers first, then tools.
 *
 * Pass live MCP status to replace the "none configured" placeholder with one
 * body per real server.
 */
export function galaxyNodes(mcp: readonly McpNodeInfo[] = []): GalaxyNode[] {
  const layers: GalaxyNode[] = AGENT_LAYERS.map((layer: AgentLayer) => ({
    kind: 'layer' as const,
    id: `layer-${layer.id}`,
    label: `${layer.id}. ${layer.name}`,
    layerId: layer.id,
    status: layer.status,
    position: layerPosition(layer.id),
    description: layer.description,
    integration: layer.evidence,
    eventTypes: layer.eventTypes,
  }));

  // The MCP placeholder only exists to explain an empty config. Once real
  // servers are configured they replace it entirely.
  const specs = mcp.length > 0 ? TOOL_SPECS.filter((t) => t.id !== 'tool-mcp') : TOOL_SPECS;
  const total = specs.length + mcp.length;

  const tools: GalaxyNode[] = specs.map((spec, i) => ({
    kind: 'tool' as const,
    id: spec.id,
    label: spec.label,
    layerId: spec.layerId,
    status: spec.status,
    position: toolPosition(i, total, spec.layerId),
    description: spec.description,
    integration: spec.integration,
    eventTypes: spec.eventTypes,
  }));

  return [...layers, ...tools, ...mcpNodes(mcp, specs.length, total)];
}

/**
 * Where the camera should sit to look at a body.
 *
 * Pulled back along the body's own outward direction and lifted, so the focused
 * object is never occluded by the bands outside it.
 *
 * Two numbers here were set by looking at the result, not by taste:
 *  - `pull` was 5.2 and put the camera so close the subject filled the frame.
 *  - `lateral` slides the camera sideways so the subject renders LEFT of centre,
 *    clear of the detail card that opens top-right. Without it the panel covered
 *    the very body it was describing.
 */
export function focusCamera(node: GalaxyNode): {
  target: [number, number, number];
  position: [number, number, number];
} {
  const [x, y, z] = node.position;
  const len = Math.hypot(x, z);
  const pull = node.kind === 'tool' ? 9.0 : node.kind === 'agent' ? 8.0 : 10.5;
  const lateral = pull * 0.42;

  if (len < 0.001) {
    return {
      target: [x, y, z],
      position: [lateral, y + pull * 0.55, pull],
    };
  }

  // Unit vector outward, and its perpendicular in the XZ plane.
  const ox = x / len;
  const oz = z / len;
  const px = -oz;
  const pz = ox;

  return {
    target: [x, y, z],
    position: [x + ox * pull + px * lateral, y + pull * 0.55, z + oz * pull + pz * lateral],
  };
}

/** The resting camera, framing the whole disc. */
export const HOME_CAMERA = {
  target: [0, 0, 0] as [number, number, number],
  // Two numbers set by looking at the render, not by taste:
  //  - distance ~51: the rim band sits at radius ~26, and at distance 32 the
  //    disc was cropped by the top and bottom of the frame.
  //  - elevation ~42 degrees: at 26 degrees the disc collapsed to a thin band
  //    and stopped reading as a disc at all.
  position: [0, 34, 38] as [number, number, number],
};

/**
 * Radians per second of galactic rotation.
 *
 * Zero under reduced motion. Slower when nothing has happened - a galaxy that
 * spins hard on an idle daemon is decoration, and stillness is information here.
 */
export function rotationSpeed(options: { reducedMotion?: boolean; hasActivity?: boolean } = {}): number {
  if (options.reducedMotion) return 0;
  return options.hasActivity ? 0.045 : 0.012;
}
