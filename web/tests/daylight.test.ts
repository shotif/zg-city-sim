import { describe, expect, it } from 'vitest';

import { ALWAYS_DAY, lighting, litShare } from '../src/world/daylight';
import { BuiltArea, lampPositions } from '../src/world/streetLights';
import { junction } from './fixtures';

describe('day and night', () => {
  it('lights the city by the sun, and keeps a little light at night', () => {
    const noon = lighting({ elevation: 40, azimuth: 180 });
    expect(noon.night).toBe(0);
    expect(noon.intensity).toBeCloseTo(ALWAYS_DAY.intensity);
    expect(noon.background).toBe(ALWAYS_DAY.background);
    // From the south at noon.
    expect(noon.direction[2]).toBeGreaterThan(0.5);
    const sunset = lighting({ elevation: 0.5, azimuth: 270 });
    expect(sunset.night).toBe(0);
    // Lamps come on as the sun goes down.
    const dusk = lighting({ elevation: -1, azimuth: 280 });
    expect(dusk.night).toBeGreaterThan(0);
    expect(dusk.night).toBeLessThan(0.2);
    // Orange in the sky, light from the west, low.
    expect((sunset.background >> 16) & 255).toBeGreaterThan(sunset.background & 255);
    expect(sunset.direction[0]).toBeLessThan(-0.9);
    const night = lighting({ elevation: -20, azimuth: 0 });
    expect(night.night).toBe(1);
    expect(night.ambient).toBeGreaterThan(0.3);
    expect(night.background).toBe(0x0b1424);
    // Moonlight from high in the south-west.
    expect(night.direction[1]).toBeGreaterThan(0.6);
  });

  it('lights most windows in the evening and few in the small hours', () => {
    expect(litShare(20 * 3600)).toBeCloseTo(0.6);
    expect(litShare(3 * 3600)).toBeCloseTo(0.1);
    expect(litShare(26 * 3600)).toBeCloseTo(litShare(2 * 3600));
    expect(litShare(23 * 3600)).toBeLessThan(litShare(21 * 3600));
  });

  it('puts street lamps along the right-hand side of streets among buildings', () => {
    const net = junction();
    // Ilica (lane centres at z 1.6), on past the junction, and Savska cesta north at x 101.6:
    // lamps 20 m and 60 m along each, 3.1 m right of the outer lane's centre.
    const all = lampPositions(net, 40);
    const points = Array.from({ length: all.length / 2 }, (_, k) => [
      Math.round(all[k * 2] * 10) / 10,
      Math.round(all[k * 2 + 1] * 10) / 10,
    ]);
    expect(points).toEqual([
      [25, 4.7],
      [65, 4.7],
      [125, 4.7],
      [165, 4.7],
      [104.7, -25],
      [104.7, -65],
    ]);
    // Only near buildings: one west of the junction lights Ilica's first stretch.
    const built = new BuiltArea(Float32Array.from([-50, 0]));
    expect(built.near(25, 4.7)).toBe(true);
    expect(built.near(125, 4.7)).toBe(false);
    expect(lampPositions(net, 40, (x, z) => built.near(x, z))).toHaveLength(4);
  });
});
