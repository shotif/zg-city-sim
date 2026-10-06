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
