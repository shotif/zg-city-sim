import { describe, expect, it } from 'vitest';

import { WorldFrame } from '../src/world/frame';

describe('WorldFrame', () => {
  const frame = new WorldFrame(459_370, 5_074_940, {
    minE: 438_000,
    minN: 5_046_000,
    maxE: 486_000,
    maxN: 5_096_000,
  });

  it('puts east on +x and north on -z', () => {
    expect(frame.toSceneX(459_470)).toBe(100);
    expect(frame.toSceneZ(5_075_040)).toBe(-100);
  });

  it('round-trips projected coordinates', () => {
    expect(frame.toEasting(frame.toSceneX(470_123.5))).toBe(470_123.5);
    expect(frame.toNorthing(frame.toSceneZ(5_060_000.25))).toBe(5_060_000.25);
  });

  it('reports the world extent in scene coordinates', () => {
    expect(frame.bounds).toEqual({ minX: -21_370, maxX: 26_630, minZ: -21_060, maxZ: 28_940 });
  });
});
