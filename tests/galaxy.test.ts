/**
 * The hollow rule, restated for a particle field.
 *
 * In the 2D panel "dishonest" meant animating a layer with no data. In the
 * galaxy it means LIGHTING one: brightness, saturation and density are the
 * claim now. These tests drive the generator with the loudest possible activity
 * and assert the hollow bands do not respond to any of it.
 *
 * Pure maths - no WebGL, no browser, no Docker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_LAYERS } from '../src/kernel/agent-layers.js';
import { emptyActivity, type CortexActivity } from '../src/cortex/layer-view.js';
import {
  ALARM_COLOR,
  CORE_COLOR,
  GALAXY,
  HOLLOW_COLOR,
  RIM_COLOR,
  bandRadius,
  bandT,
  buildGalaxy,
  focusCamera,
  galaxyNodes,
  mulberry32,
  rampColor,
  rotationSpeed,
} from '../src/cortex/galaxy.js';

const HOLLOW_IDS = AGENT_LAYERS.filter((l) => l.status === 'hollow').map((l) => l.id);

/** The loudest state the panel can ever be in. */
const LOUD: CortexActivity = {
  activeLayer: 3, // a HOLLOW layer, deliberately
  eventCounts: { 1: 9, 2: 9, 3: 999, 4: 999, 5: 999, 9: 9, 11: 9, 12: 9 },
  alarm: true,
  latestEventId: 42,
};

/** Particle index range belonging to one layer, in emission order. */
function sliceFor(layerId: number): { start: number; end: number } {
  let start = 0;
  for (const layer of AGENT_LAYERS) {
    const count =
      layer.status === 'hollow'
        ? Math.round(GALAXY.particlesPerLayer * GALAXY.hollowParticleRatio)
        : GALAXY.particlesPerLayer;
    if (layer.id === layerId) return { start, end: start + count };
    start += count;
  }
  throw new Error(`no such layer ${layerId}`);
}

function colorsOf(field: { colors: Float32Array }, layerId: number): Float32Array {
  const { start, end } = sliceFor(layerId);
  return field.colors.slice(start * 3, end * 3);
}

describe('THE RULE, in a particle field: hollow bands never light up', () => {
  it('produces byte-identical hollow particles whether the run is idle or screaming', () => {
    // The strongest form of the assertion: not "dimmer", but UNCHANGED. Activity
    // is not merely weighted down for hollow layers, it is never consulted.
    const idle = buildGalaxy(emptyActivity(), { seed: 7 });
    const loud = buildGalaxy(LOUD, { seed: 7 });

    for (const id of HOLLOW_IDS) {
      assert.deepEqual(
        Array.from(colorsOf(loud, id)),
        Array.from(colorsOf(idle, id)),
        `layer ${id} is hollow; activity must not change a single particle`
      );
    }
  });

  it('NEGATIVE CONTROL: the same activity DOES change a live band', () => {
    // Without this, the test above would also pass if activity were ignored
    // everywhere - i.e. if the whole feature were broken.
    const idle = buildGalaxy(emptyActivity(), { seed: 7 });
    const loud = buildGalaxy(LOUD, { seed: 7 });
    assert.notDeepEqual(
      Array.from(colorsOf(loud, 1)),
      Array.from(colorsOf(idle, 1)),
      'a live layer with events must visibly differ'
    );
  });

  it('keeps hollow bands on the slate colour, outside the amber-violet ramp', () => {
    const field = buildGalaxy(LOUD, { seed: 3 });
    for (const id of HOLLOW_IDS) {
      const c = colorsOf(field, id);
      // Slate is the only colour where blue exceeds red. Every ramp colour, and
      // the alarm colour, are red-dominant.
      for (let i = 0; i < c.length; i += 3) {
        assert.ok(c[i + 2] > c[i], `hollow particle ${i / 3} of layer ${id} must not be warm`);
      }
    }
    assert.ok(HOLLOW_COLOR[2] > HOLLOW_COLOR[0]);
  });

  it('gives hollow bands visibly fewer particles, so absence reads as sparse', () => {
    const field = buildGalaxy(emptyActivity(), { seed: 1 });
    for (const id of HOLLOW_IDS) {
      assert.ok(
        field.countByLayer[id] < field.countByLayer[1] * 0.5,
        `layer ${id} must be sparse: ${field.countByLayer[id]} vs ${field.countByLayer[1]}`
      );
      assert.ok(field.countByLayer[id] > 0, 'but still present - absence must be visible, not invisible');
    }
  });

  it('never lets a hollow layer be the brightest thing on screen', () => {
    const field = buildGalaxy(LOUD, { seed: 11 });
    const peak = (id: number) => Math.max(...Array.from(colorsOf(field, id)));
    const hollowPeak = Math.max(...HOLLOW_IDS.map(peak));
    assert.ok(peak(1) > hollowPeak, 'a live band must outshine every hollow one');
  });
});

describe('amber core to violet rim', () => {
  it('ramps monotonically: red falls and blue rises all the way out', () => {
    let previousRed = Infinity;
    let previousBlue = -Infinity;
    for (let i = 0; i <= 10; i++) {
      const [r, , b] = rampColor(i / 10);
      assert.ok(r <= previousRed + 1e-9, `red must not rise at t=${i / 10}`);
      assert.ok(b >= previousBlue - 1e-9, `blue must not fall at t=${i / 10}`);
      previousRed = r;
      previousBlue = b;
    }
  });

  it('anchors the ends on the stated palette', () => {
    assert.deepEqual(rampColor(0), CORE_COLOR);
    assert.deepEqual(rampColor(1), RIM_COLOR);
    assert.deepEqual(rampColor(-5), CORE_COLOR, 'clamps rather than extrapolating');
    assert.deepEqual(rampColor(5), RIM_COLOR);
  });

  it('places layer 1 at the warm end and layer 12 at the violet end', () => {
    assert.equal(bandT(1), 0);
    assert.equal(bandT(12), 1);
    const core = rampColor(bandT(1));
    const rim = rampColor(bandT(12));
    assert.ok(core[0] > core[2], 'core is warm');
    assert.ok(rim[2] > rim[0], 'rim is violet');
  });

  it('orders the bands outward with no overlap', () => {
    for (let id = 2; id <= 12; id++) {
      assert.ok(bandRadius(id as any) > bandRadius((id - 1) as any));
    }
  });
});

describe('layer 11 alarm', () => {
  it('turns the repair band red only when a repair loop actually ran', () => {
    const calm = buildGalaxy({ ...emptyActivity(), eventCounts: { 11: 2 } }, { seed: 5 });
    const alarmed = buildGalaxy({ ...emptyActivity(), eventCounts: { 11: 2 }, alarm: true }, { seed: 5 });
    assert.notDeepEqual(Array.from(colorsOf(alarmed, 11)), Array.from(colorsOf(calm, 11)));
    assert.ok(ALARM_COLOR[0] > ALARM_COLOR[2], 'the alarm colour is red-dominant');
  });

  it('the alarm never leaks onto a neighbouring band', () => {
    const calm = buildGalaxy(emptyActivity(), { seed: 5 });
    const alarmed = buildGalaxy({ ...emptyActivity(), alarm: true }, { seed: 5 });
    for (const id of [10, 12]) {
      assert.deepEqual(
        Array.from(colorsOf(alarmed, id)),
        Array.from(colorsOf(calm, id)),
        `layer ${id} is not the repair layer and must be untouched`
      );
    }
  });
});

describe('determinism', () => {
  it('the same seed produces the same sky, particle for particle', () => {
    const a = buildGalaxy(LOUD, { seed: 1234 });
    const b = buildGalaxy(LOUD, { seed: 1234 });
    assert.deepEqual(Array.from(a.positions), Array.from(b.positions));
    assert.deepEqual(Array.from(a.sizes), Array.from(b.sizes));
  });

  it('a different seed produces a different sky', () => {
    const a = buildGalaxy(LOUD, { seed: 1 });
    const b = buildGalaxy(LOUD, { seed: 2 });
    assert.notDeepEqual(Array.from(a.positions), Array.from(b.positions));
  });

  it('mulberry32 stays in [0,1) and does not immediately repeat', () => {
    const rand = mulberry32(99);
    const draws = Array.from({ length: 500 }, () => rand());
    assert.ok(draws.every((v) => v >= 0 && v < 1));
    assert.ok(new Set(draws).size > 400, 'a PRNG that repeats would band the galaxy');
  });

  it('emits exactly as many particles as it reports', () => {
    const f = buildGalaxy(emptyActivity(), { seed: 2, particlesPerLayer: 50 });
    assert.equal(f.positions.length, f.total * 3);
    assert.equal(f.colors.length, f.total * 3);
    assert.equal(f.sizes.length, f.total);
    assert.equal(
      Object.values(f.countByLayer).reduce((n, c) => n + c, 0),
      f.total
    );
  });

  it('produces no NaN, which would silently blank the whole field', () => {
    const f = buildGalaxy(LOUD, { seed: 8, particlesPerLayer: 200 });
    assert.ok(f.positions.every(Number.isFinite), 'positions');
    assert.ok(f.colors.every(Number.isFinite), 'colors');
    assert.ok(f.sizes.every((s) => Number.isFinite(s) && s > 0), 'sizes');
  });
});

describe('selectable bodies and focus', () => {
  it('offers one body per layer plus every declared tool', () => {
    const nodes = galaxyNodes();
    assert.equal(nodes.filter((n) => n.kind === 'layer').length, 12);
    assert.ok(nodes.some((n) => n.id === 'tool-mcp'));
    assert.ok(nodes.some((n) => n.id === 'tool-obsidian'));
    assert.equal(new Set(nodes.map((n) => n.id)).size, nodes.length, 'ids must be unique');
  });

  it('marks unconnected tools as planned and says so in the integration text', () => {
    const nodes = galaxyNodes();
    const mcp = nodes.find((n) => n.id === 'tool-mcp')!;
    assert.equal(mcp.status, 'planned');
    assert.equal(mcp.eventTypes.length, 0, 'a planned tool must claim no evidence');
    assert.match(mcp.integration, /Phase D/);
    assert.match(
      mcp.integration,
      /never in the executor container/,
      'the trust boundary is the point of the MCP node'
    );
  });

  it('pins Obsidian to memory without claiming a live vault connection', () => {
    const obsidian = galaxyNodes().find((n) => n.id === 'tool-obsidian')!;
    assert.equal(obsidian.layerId, 3);
    assert.equal(AGENT_LAYERS.find((l) => l.id === 3)!.status, 'live');
    assert.equal(obsidian.status, 'planned');
  });

  it('every layer body carries the taxonomy status it was built from', () => {
    for (const node of galaxyNodes().filter((n) => n.kind === 'layer')) {
      const layer = AGENT_LAYERS.find((l) => l.id === node.layerId)!;
      assert.equal(node.status, layer.status);
      assert.equal(node.integration, layer.evidence);
    }
  });

  it('shows a "none configured" placeholder when no MCP server exists', () => {
    const mcp = galaxyNodes().find((n) => n.id === 'tool-mcp')!;
    assert.equal(mcp.status, 'planned');
    assert.match(mcp.description, /No MCP server is configured/);
  });

  it('draws a real MCP server LIVE only when it actually connected', () => {
    const nodes = galaxyNodes([
      { name: 'echo', connected: true, tools: ['reverse'], callsUsed: 2, quota: 50 },
      { name: 'dead', connected: false, tools: [], callsUsed: 0, quota: 50, error: 'spawn ENOENT' },
    ]);

    const echo = nodes.find((n) => n.id === 'mcp-echo')!;
    assert.equal(echo.status, 'live', 'a connected server is a live body');
    assert.deepEqual(echo.eventTypes, ['TOOL_CALL']);
    assert.match(echo.integration, /never in the executor container/);
    assert.match(echo.integration, /2\/50/, 'quota usage is operator-visible');

    const dead = nodes.find((n) => n.id === 'mcp-dead')!;
    assert.equal(dead.status, 'planned', 'configured is NOT connected');
    assert.deepEqual(dead.eventTypes, [], 'an unconnected server claims no evidence');
    assert.match(dead.description, /spawn ENOENT/, 'it must say why');

    // The placeholder is gone once real servers exist.
    assert.equal(nodes.find((n) => n.id === 'tool-mcp'), undefined);
  });

  it('NEGATIVE CONTROL: merely being configured never makes a server live', () => {
    const nodes = galaxyNodes([
      { name: 'a', connected: false, tools: ['x'], callsUsed: 0, quota: 50 },
      { name: 'b', connected: false, tools: [], callsUsed: 0, quota: 50 },
    ]);
    assert.equal(nodes.filter((n) => n.id.startsWith('mcp-') && n.status === 'live').length, 0);
  });

  it('places the camera outside the body it is looking at', () => {
    const all = [
      ...galaxyNodes(),
      ...galaxyNodes([{ name: 'echo', connected: true, tools: ['reverse'], callsUsed: 0, quota: 50 }]),
    ];
    for (const node of all) {
      const { target, position } = focusCamera(node);
      const distance = Math.hypot(
        position[0] - target[0],
        position[1] - target[1],
        position[2] - target[2]
      );
      assert.ok(distance > 2, `${node.id}: camera must not sit inside the body (got ${distance})`);
      assert.ok(position.every(Number.isFinite));
      // Further from the origin than its subject, so outer bands do not occlude it.
      assert.ok(Math.hypot(position[0], position[2]) >= Math.hypot(target[0], target[2]) - 1e-6);
    }
  });
});

describe('rotation', () => {
  it('stops completely under reduced motion', () => {
    assert.equal(rotationSpeed({ reducedMotion: true }), 0);
    assert.equal(rotationSpeed({ reducedMotion: true, hasActivity: true }), 0);
  });

  it('turns slowly when idle and faster when the agent is working', () => {
    const idle = rotationSpeed({ hasActivity: false });
    const busy = rotationSpeed({ hasActivity: true });
    assert.ok(idle > 0 && busy > idle, 'motion should mean something, not just exist');
  });
});
