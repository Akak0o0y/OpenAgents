/**
 * Silhouette geometry.
 *
 * The rings are generated, so what needs testing is not their exact
 * coordinates but the properties the engine relies on: a closed 100-point ring
 * in its coordinate system, filling the width, distinct from every other shape.
 * A shape that silently collapses to a point would render as an invisible bot.
 */

import { describe, expect, it } from 'vitest';
import { EB_RINGS } from './rings.js';
import {
  ALL_SHAPES,
  BOT_SHAPES,
  EXTRA_SHAPES,
  SHAPE_FAMILIES,
  familyOfShape,
  isBotShape,
  registerShapes,
  resolveShape,
} from './shapes.js';

const SHAPES = (EB_RINGS as any).SHAPES as Record<string, { ring: number[][]; face: any; tiltScale: number }>;

describe('shape registration', () => {
  it('supplies every shape, because the engine table ships empty', () => {
    // The upstream character geometry is not bundled: this registration is the
    // whole supply, not an augmentation of it.
    for (const shape of ALL_SHAPES) {
      expect(SHAPES[shape], `${shape} is missing from the engine`).toBeTruthy();
    }
    expect(Object.keys(SHAPES).sort()).toEqual([...ALL_SHAPES].sort());
  });

  it('bundles no upstream character artwork', () => {
    // gem was the third Aora silhouette. Nothing may reintroduce it.
    expect(SHAPES.gem).toBeUndefined();
  });

  it('is idempotent', () => {
    const before = SHAPES.hex.ring;
    registerShapes();
    registerShapes();
    expect(SHAPES.hex.ring).toBe(before);
  });

  it('keeps the reference vocabulary and adds four of its own', () => {
    expect(BOT_SHAPES).toHaveLength(8);
    expect(EXTRA_SHAPES).toHaveLength(4);
    expect(ALL_SHAPES).toHaveLength(12);
    expect(isBotShape('crystal')).toBe(true);
    expect(isBotShape('nonsense')).toBe(false);
  });

  it('migrates a bot saved with the removed gem shape', () => {
    // Reverting it to the default would silently change an existing bot's face.
    expect(resolveShape('gem')).toBe('crystal');
    expect(resolveShape('hex')).toBe('hex');
    expect(resolveShape('nonsense')).toBeNull();
    expect(resolveShape(42)).toBeNull();
  });

  it('files every shape under exactly one browsing family', () => {
    const filed = SHAPE_FAMILIES.flatMap((f) => f.shapes);
    expect([...filed].sort()).toEqual([...ALL_SHAPES].sort());
    for (const shape of ALL_SHAPES) {
      expect(familyOfShape(shape).shapes, shape).toContain(shape);
    }
  });
});

describe('generated rings', () => {
  // Every shape is generated now, so every shape is checked.
  const generated = ALL_SHAPES;

  for (const shape of generated) {
    describe(shape, () => {
      const entry = SHAPES[shape];

      it('has a 100-point ring of finite coordinates', () => {
        expect(entry.ring).toHaveLength(100);
        for (const [x, y] of entry.ring) {
          expect(Number.isFinite(x)).toBe(true);
          expect(Number.isFinite(y)).toBe(true);
        }
      });

      it('fits inside the engine box on both axes', () => {
        // The box is 0..228.541 around a centre of 114.2705. A shape that
        // overflowed it would have the overflowing part clipped at render time
        // - which is exactly how the teardrop's point was lost before the
        // normalisation was changed to fit height as well as width.
        const xs = entry.ring.map((p) => p[0]);
        const ys = entry.ring.map((p) => p[1]);
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1);
        expect(Math.max(...xs)).toBeLessThanOrEqual(230);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1);
        expect(Math.max(...ys)).toBeLessThanOrEqual(230);
      });

      it('touches at least one edge, so it is not rendered undersized', () => {
        const xs = entry.ring.map((p) => p[0]);
        const ys = entry.ring.map((p) => p[1]);
        const spanX = Math.max(...xs) - Math.min(...xs);
        const spanY = Math.max(...ys) - Math.min(...ys);
        expect(Math.max(spanX, spanY)).toBeGreaterThan(226);
      });

      it('is centred in the box on both axes', () => {
        const xs = entry.ring.map((p) => p[0]);
        const ys = entry.ring.map((p) => p[1]);
        expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 114.2705)).toBeLessThan(1);
        expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - 114.2705)).toBeLessThan(1);
      });

      it('encloses real area rather than collapsing', () => {
        // Shoelace formula. A degenerate ring would come out near zero.
        let area = 0;
        for (let i = 0; i < entry.ring.length; i++) {
          const [x1, y1] = entry.ring[i];
          const [x2, y2] = entry.ring[(i + 1) % entry.ring.length];
          area += x1 * y2 - x2 * y1;
        }
        expect(Math.abs(area) / 2).toBeGreaterThan(10000);
      });

      it('has a face fit the engine can use', () => {
        expect(entry.face.sx).toBeGreaterThan(0);
        expect(entry.face.sy).toBeGreaterThan(0);
        expect(entry.tiltScale).toBeGreaterThan(0);
      });
    });
  }

  it('produces a visibly different silhouette for each shape', () => {
    const signatures = new Set(generated.map((s) => JSON.stringify(SHAPES[s].ring)));
    expect(signatures.size).toBe(generated.length);
  });

  it('gives each shape the proportions its name implies', () => {
    const extent = (shape: string) => {
      const ys = SHAPES[shape].ring.map((p) => p[1]);
      const xs = SHAPES[shape].ring.map((p) => p[0]);
      return (Math.max(...ys) - Math.min(...ys)) / (Math.max(...xs) - Math.min(...xs));
    };
    expect(extent('tablet'), 'tablet is a wide slab').toBeLessThan(0.75);
    expect(extent('capsule'), 'capsule stands upright').toBeGreaterThan(1.3);
    expect(extent('squircle'), 'squircle is roughly square').toBeGreaterThan(0.9);
    expect(extent('squircle')).toBeLessThan(1.1);
    expect(extent('blob'), 'blob is roughly round').toBeGreaterThan(0.9);
    expect(extent('blob')).toBeLessThan(1.15);
  });

  /**
   * The face must fit inside the body.
   *
   * This is the invariant hand-tuning kept getting wrong: on the diamond an eye
   * was drawn outside the silhouette and simply clipped. Rather than checking
   * by eye, take the engine's actual eye-ring points for every expression,
   * apply each shape's face transform, and assert they land inside the body.
   *
   * Real points, not their bounding box: the corners of the union box are
   * positions no eye ever occupies, and testing those rejects even the plain
   * circle the upstream eyes were authored for.
   */
  it('keeps the eyes inside the silhouette on every shape', () => {
    const HEAD_C = 114.2705;
    const expressions = (EB_RINGS as any).EXPRESSIONS as number[][][][];

    const inside = (ring: number[][], px: number, py: number) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };

    for (const shape of ALL_SHAPES) {
      const { ring, face } = SHAPES[shape];
      const scale = face.sx * face.eye;
      const scaleY = face.sy * face.eye;
      let worst: { x: number; y: number } | null = null;

      for (const expression of expressions) {
        for (const eye of expression) {
          for (const [x, y] of eye) {
            const cx = HEAD_C + (x - HEAD_C) * scale + face.x;
            const cy = HEAD_C + (y - HEAD_C) * scaleY + face.y;
            if (!inside(ring, cx, cy)) worst = { x: cx, y: cy };
          }
        }
      }

      expect(
        worst,
        worst
          ? `${shape}: an eye point lands at (${worst.x.toFixed(1)}, ${worst.y.toFixed(1)}), outside the body`
          : ''
      ).toBeNull();
    }
  });

  it('narrows a wedge towards its apex, which is what makes it a wedge', () => {
    // Width near the top must be well under width near the bottom.
    const ring = SHAPES.wedge.ring;
    const ys = ring.map((p) => p[1]);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const widthAt = (y: number, band: number) => {
      const xs = ring.filter((p) => Math.abs(p[1] - y) < band).map((p) => p[0]);
      return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
    };
    const band = (bottom - top) * 0.12;
    expect(widthAt(top + band, band)).toBeLessThan(widthAt(bottom - band, band) * 0.6);
  });

  it('draws the teardrop as one smooth outline whose only corner is its tip', () => {
    // The teardrop used to be a cone pushed into a disk. Where the cone's
    // straight sides met the circle the outline turned sharply inward - a dent
    // on each shoulder, measured at 27.6 degrees. The smooth curve that
    // replaced it turns at most about 5 degrees anywhere but the tip.
    const ring = SHAPES.teardrop.ring;
    const n = ring.length;
    const tip = ring.reduce((best, p, i) => (p[1] < ring[best][1] ? i : best), 0);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      if (Math.min(Math.abs(i - tip), n - Math.abs(i - tip)) <= 2) continue;
      const [ax, ay] = ring[(i - 1 + n) % n];
      const [bx, by] = ring[i];
      const [cx, cy] = ring[(i + 1) % n];
      let turn = Math.abs(Math.atan2(cy - by, cx - bx) - Math.atan2(by - ay, bx - ax));
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      worst = Math.max(worst, turn);
    }
    expect((worst * 180) / Math.PI).toBeLessThan(12);
  });
});
