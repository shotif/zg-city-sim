import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import {
  MeshBuilder,
  addDashes,
  addPolygon,
  addRibbon,
  groundPath,
  pathDistances,
  simplify,
  slicePath,
} from '../src/world/roadGeometry';

const flat = () => 100;
const grey = new THREE.Color(0x808080);

function facesUp(b: MeshBuilder): boolean {
  const p = b.positions;
  for (let t = 0; t < b.indices.length; t += 3) {
    const [a, c, d] = [b.indices[t], b.indices[t + 1], b.indices[t + 2]];
    const abx = p[c * 3] - p[a * 3];
    const abz = p[c * 3 + 2] - p[a * 3 + 2];
    const acx = p[d * 3] - p[a * 3];
    const acz = p[d * 3 + 2] - p[a * 3 + 2];
    if (abz * acx - abx * acz < 0) return false;
  }
  return true;
}

describe('groundPath', () => {
  // A 100 m shape going east, elevation offset 0 -> 6 m.
  const shape = new Float32Array([0, 0, 0, 100, 0, 6]);

  it('densifies and puts points on the ground plus their elevation offset', () => {
    const path = groundPath(shape, 0, 2, flat, { maxStep: 25, lift: 0.1 });
    expect(path.length / 3).toBe(5);
    expect(path[1]).toBeCloseTo(100.1);
    expect(path[4 * 3 + 1]).toBeCloseTo(106.1);
    expect(path[2 * 3]).toBeCloseTo(50);
  });

  it('spans bridges straight between the ground at both ends', () => {
    const valley = (x: number) => (x > 10 && x < 90 ? 80 : 100);
    const deck = groundPath(new Float32Array([0, 0, 0, 100, 0, 0]), 0, 2, valley, {
      maxStep: 25,
      bridge: true,
    });
    for (let k = 0; k < deck.length / 3; k++) expect(deck[k * 3 + 1]).toBeCloseTo(100);
  });
});

describe('ribbons', () => {
  const path = new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 10]);

  it('builds an up-facing strip of the requested width', () => {
    const b = new MeshBuilder();
    addRibbon(b, path, 1.5, grey);
    expect(b.vertexCount).toBe(6);
    expect(b.indices.length).toBe(12);
    expect(facesUp(b)).toBe(true);
    // First pair: going east, left is north (-z), so the left vertex is at z = -1.5.
    expect(b.positions[2]).toBeCloseTo(-1.5);
    expect(b.positions[5]).toBeCloseTo(1.5);
  });

  it('offsets strips to the left of travel', () => {
    const b = new MeshBuilder();
    addRibbon(b, new Float32Array([0, 0, 0, 10, 0, 0]), 0.1, grey, 2);
    expect(b.positions[2]).toBeCloseTo(-2.1);
    expect(b.positions[5]).toBeCloseTo(-1.9);
  });

  it('measures and slices paths', () => {
    const d = pathDistances(path);
    expect(d[1]).toBe(10);
    expect(d[2]).toBeCloseTo(10 + Math.hypot(10, 10), 5);
    const part = slicePath(path, d, 5, 12);
    expect(Array.from(part.slice(0, 3))).toEqual([5, 0, 0]);
    expect(part[part.length - 3]).toBeCloseTo(10 + 2 / Math.SQRT2);
  });

  it('draws dashes at the requested period', () => {
    const b = new MeshBuilder();
    addDashes(b, new Float32Array([0, 0, 0, 90, 0, 0]), 0.06, grey, 0, 0, 3, 9);
    expect(b.indices.length / 6).toBe(10);
  });
});

describe('addPolygon', () => {
  it('triangulates a ring facing up and drops the closing point', () => {
    const b = new MeshBuilder();
    const ring = new Float32Array([0, 1, 0, 10, 1, 0, 10, 1, 10, 0, 1, 10, 0, 1, 0]);
    addPolygon(b, ring, grey);
    expect(b.vertexCount).toBe(4);
    expect(b.indices.length).toBe(6);
    expect(facesUp(b)).toBe(true);
  });
});

describe('simplify', () => {
  it('keeps the ends and the corners, drops points within the tolerance', () => {
    // A straight run with a wobble of 0.5 m, then a right-angle corner.
    const xz = [0, 0, 10, 0.5, 20, 0, 30, 0, 30, 10, 30, 20];
    expect(simplify(xz, 1)).toEqual([0, 3, 5]);
    expect(simplify(xz, 0.1)).toEqual([0, 1, 2, 3, 5]);
    expect(simplify([0, 0, 5, 5], 1)).toEqual([0, 1]);
  });
});
