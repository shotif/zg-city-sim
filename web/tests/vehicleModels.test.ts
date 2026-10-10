import { describe, expect, it } from 'vitest';

import { CARS, MODELS, PAINT, farModel, modelOf, partsGeometry } from '../src/world/vehicleModels';

/** Every triangle's normal points away from the part's centre, and is wound to face it. */
function outward(geometry: ReturnType<typeof partsGeometry>, centre: [number, number, number]) {
  const p = geometry.getAttribute('position');
  const n = geometry.getAttribute('normal');
  for (let t = 0; t < p.count; t += 3) {
    const v = [0, 1, 2].map((k) => [p.getX(t + k), p.getY(t + k), p.getZ(t + k)]);
    const mid = [0, 1, 2].map((a) => (v[0][a] + v[1][a] + v[2][a]) / 3);
    const normal = [n.getX(t), n.getY(t), n.getZ(t)];
    const away = mid.map((m, a) => m - centre[a]);
    expect(normal.reduce((s, x, a) => s + x * away[a], 0)).toBeGreaterThanOrEqual(-1e-6);
    const ab = [0, 1, 2].map((a) => v[1][a] - v[0][a]);
    const ac = [0, 1, 2].map((a) => v[2][a] - v[0][a]);
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    expect(cross.reduce((s, x, a) => s + x * normal[a], 0)).toBeGreaterThan(0);
  }
}

describe('vehicle models', () => {
  it('builds boxes and extruded profiles facing outwards', () => {
    const box = partsGeometry([{ min: [-1, 0, -2], max: [1, 1, 2], color: PAINT }]);
    expect(box.getAttribute('position').count).toBe(36);
    outward(box, [0, 0.5, 0]);
    // A car's body: a convex side profile extruded across.
    const body = CARS[0].model.parts[0];
    const prism = partsGeometry([body]);
    const profile = 'profile' in body ? body.profile : [];
    const cz = profile.reduce((s, q) => s + q[0], 0) / profile.length;
    const cy = profile.reduce((s, q) => s + q[1], 0) / profile.length;
    outward(prism, [0, cy, cz]);
  });

  it('gives every type its models, with lamps at the ends', () => {
    expect(MODELS.map((m) => m.length)).toEqual([5, 2, 1, 1, 1, 1]);
    for (const models of MODELS) {
      for (const model of models) {
        expect(model.head.length).toBe(2);
        expect(model.tail.length).toBe(2);
        expect(model.left.length + model.right.length).toBe(4);
        // Headlamps at the front face, tail lamps at the back.
        for (const lamp of model.head)
          expect('max' in lamp && lamp.max[2]).toBeGreaterThan(model.front - 0.1);
        for (const lamp of model.tail)
          expect('min' in lamp && lamp.min[2]).toBeLessThan(-model.front + 0.1);
      }
    }
  });

  it('mixes car shapes by their shares, and keeps a vehicle the same shape', () => {
    const counts = new Array(CARS.length).fill(0);
    for (let seed = 0; seed < 65_536; seed += 7) counts[modelOf(0, seed)]++;
    const total = counts.reduce((a, b) => a + b, 0);
    const weights = CARS.map((c) => c.weight);
    const sum = weights.reduce((a, b) => a + b, 0);
    counts.forEach((n, k) => expect(n / total).toBeCloseTo(weights[k] / sum, 1));
    expect(modelOf(0, 12_345)).toBe(modelOf(0, 12_345));
    expect(modelOf(2, 99)).toBe(0);
    expect([modelOf(1, 4), modelOf(1, 5)].sort()).toEqual([0, 1]);
  });
});

describe('far models', () => {
  const triangles = (parts: Parameters<typeof partsGeometry>[0]) =>
    partsGeometry(parts).getAttribute('position').count / 3;

  it('draw each type as a box with a roof and two lamps, a fraction of the triangles', () => {
    for (const models of MODELS) {
      const near = models[0];
      const far = farModel(near);
      const all = (m: typeof near) =>
        triangles(m.parts) + triangles(m.head) + triangles(m.tail) + triangles(m.left);
      expect(all(far)).toBeLessThanOrEqual(48);
      expect(all(far)).toBeLessThan(all(near) / 3);
      expect(far.parts).toHaveLength(2);
      expect(far.front).toBe(near.front);
    }
  });

  it('keep the roof colour seen from above: painted on cars, white on trams', () => {
    expect(farModel(MODELS[0][0]).parts[1].color).toBe(PAINT);
    expect(farModel(MODELS[3][0]).parts[1].color).not.toBe(PAINT);
  });
});
