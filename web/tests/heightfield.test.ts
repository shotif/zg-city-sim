import { describe, expect, it } from 'vitest';

import { Heightfield, decodeTerrainRgb } from '../src/world/heightfield';

describe('decodeTerrainRgb', () => {
  it('decodes Mapbox Terrain-RGB', () => {
    // 0 m = 100000 = (1, 134, 160); 1033.1 m = 110331 = (1, 174, 251)
    const rgba = [1, 134, 160, 255, 1, 174, 251, 255];
    const h = decodeTerrainRgb(rgba, 2);
    expect(h[0]).toBeCloseTo(0, 4);
    expect(h[1]).toBeCloseTo(1033.1, 3);
  });
});

describe('Heightfield', () => {
  // 3 x 2 grid, 10 m cells, western edge at x = 0, northern edge at z = 0.
  // Sample centres: x = 5, 15, 25; z = 5 (north row), 15 (south row).
  const hf = new Heightfield(new Float32Array([0, 10, 20, 100, 110, 120]), 3, 2, 10, 0, 0);

  it('returns sample values at cell centres', () => {
    expect(hf.sample(5, 5)).toBe(0);
    expect(hf.sample(25, 15)).toBe(120);
  });

  it('interpolates bilinearly between centres', () => {
    expect(hf.sample(10, 5)).toBeCloseTo(5);
    expect(hf.sample(5, 10)).toBeCloseTo(50);
    expect(hf.sample(10, 10)).toBeCloseTo(55);
  });

  it('clamps outside the grid', () => {
    expect(hf.sample(-100, -100)).toBe(0);
    expect(hf.sample(1000, 1000)).toBe(120);
    expect(hf.at(-1, 5)).toBe(100);
  });

  it('rejects mismatched sizes', () => {
    expect(() => new Heightfield(new Float32Array(5), 3, 2, 10, 0, 0)).toThrow();
  });
});

describe('Heightfield.meshSurface', () => {
  // 3 x 3 grid of 10 m cells, a single bump in the middle.
  const hf = new Heightfield(new Float32Array([0, 0, 0, 0, 9, 0, 0, 0, 0]), 3, 3, 10, 0, 0);
  const surface = hf.meshSurface(1);

  it('passes through the mesh vertices', () => {
    expect(surface(5, 5)).toBe(0);
    expect(surface(15, 15)).toBe(9);
  });

  it('interpolates within the triangles the mesh uses', () => {
    // Cell (0,0): corners NW 0, NE 0, SW 0, SE 9; split along SW-NE.
    expect(surface(7.5, 7.5)).toBeCloseTo(0); // u + v = 0.5: north-west triangle, all zeros
    expect(surface(12.5, 12.5)).toBeCloseTo(4.5); // u = v = 0.75: south-east triangle
  });
});
