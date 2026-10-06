import { describe, expect, it } from 'vitest';

import { Heightfield } from '../src/world/heightfield';
import { buildTerrainGeometry } from '../src/world/terrain';

describe('buildTerrainGeometry', () => {
  // 3 x 3 grid of 10 m cells; height rises 1 m per 10 m going east.
  const hf = new Heightfield(new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]), 3, 3, 10, 0, 0);
  const geometry = buildTerrainGeometry(hf, 1, { west: 0, north: 0, width: 30, height: 30 });

  it('places vertices at sample centres with their heights', () => {
    const p = geometry.getAttribute('position');
    expect(p.count).toBe(9);
    expect([p.getX(0), p.getY(0), p.getZ(0)]).toEqual([5, 0, 5]);
    expect([p.getX(8), p.getY(8), p.getZ(8)]).toEqual([25, 2, 25]);
  });

  it('tilts normals away from the slope', () => {
    const n = geometry.getAttribute('normal');
    // slope dh/dx = 0.1 -> normal (-0.1, 1, 0) normalised
    expect(n.getX(4)).toBeCloseTo(-0.1 / Math.hypot(0.1, 1), 6);
    expect(n.getY(4)).toBeCloseTo(1 / Math.hypot(0.1, 1), 6);
    expect(n.getZ(4)).toBeCloseTo(0, 6);
  });

  it('maps the north-west texture corner to uv (0, 0)', () => {
    const uv = geometry.getAttribute('uv');
    expect(uv.getX(0)).toBeCloseTo(5 / 30);
    expect(uv.getY(0)).toBeCloseTo(5 / 30);
  });

  it('winds triangles counter-clockwise seen from above', () => {
    const p = geometry.getAttribute('position');
    const index = geometry.getIndex()!;
    for (let t = 0; t < index.count; t += 3) {
      const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      const abx = p.getX(b) - p.getX(a);
      const abz = p.getZ(b) - p.getZ(a);
      const acx = p.getX(c) - p.getX(a);
      const acz = p.getZ(c) - p.getZ(a);
      // y component of AB x AC must point up
      expect(abz * acx - abx * acz).toBeGreaterThan(0);
    }
  });
});
