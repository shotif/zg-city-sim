import { describe, expect, it } from 'vitest';

import {
  MIN_START,
  NEED,
  coverage,
  coverageColor,
  shortfall,
  startFactor,
  withGrown,
} from '../src/grow/coverage';
import type { Service } from '../src/ui/servicesPanel';

const school = (x: number, places: number): Service => ({
  kind: 'school',
  name: '',
  x,
  z: 0,
  edge: 0,
  district: 0,
  places,
});

describe('services within reach', () => {
  it("shares each school's places among the homes within reach, and sums them for each home", () => {
    // 1,000 residents at x = 0 and at x = 5 km; one school next to each, one with half the
    // places they need.
    const homes = {
      x: Float32Array.of(0, 5000),
      z: Float32Array.of(0, 0),
      residents: Float32Array.of(1000, 1000),
    };
    const need = 1000 * NEED.school;
    const c = coverage([school(100, need), school(5100, need / 2)], homes, homes);
    expect(c.school[0]).toBeCloseTo(1, 5);
    expect(c.school[1]).toBeCloseTo(0.5, 5);
    // No kindergartens or GPs: none covered.
    expect(c.kindergarten[0]).toBe(0);
    // A place beyond any school's reach, 2.5 km from both.
    expect(coverage([school(100, need)], homes, { x: [2500], z: [0] }).school[0]).toBe(0);
    // Both homes within reach of one school: its places are shared between them.
    const close = {
      x: Float32Array.of(0, 500),
      z: Float32Array.of(0, 0),
      residents: homes.residents,
    };
    expect(coverage([school(250, need)], close, close).school[1]).toBeCloseTo(0.5, 5);

    const short = shortfall(c, homes.residents);
    expect(short.school.residents).toBe(1000);
    expect(short.school.short).toBeCloseTo(need / 2, 3);
    expect(short.school.total).toBe(2000);
  });

  it('slows homes where places run short, and joins grown homes to today', () => {
    expect(startFactor(1.2)).toBe(1);
    expect(startFactor(1)).toBe(1);
    expect(startFactor(0)).toBe(MIN_START);
    expect(startFactor(0.5)).toBeCloseTo((1 + MIN_START) / 2, 5);
    expect(startFactor(NaN)).toBe(1);
    const base = {
      x: Float32Array.of(1),
      z: Float32Array.of(2),
      residents: Float32Array.of(3),
      inCity: Uint8Array.of(0),
    };
    const all = withGrown(base, [{ x: 4, z: 5, residents: 6 }]);
    expect([...all.x, ...all.residents, ...all.inCity]).toEqual([1, 4, 3, 6, 0, 1]);
    expect(coverageColor(2)).toEqual(coverageColor(1));
    expect(coverageColor(0)[0]).toBeGreaterThan(coverageColor(1)[0]);
  });
});
