import { describe, expect, it } from 'vitest';

import { soundLevels } from '../src/ui/sound';

const street = { vehicles: 64, speed: 10, trams: 2, rain: 0, snow: 0, viewHeight: 150 };

describe('the sound of the city', () => {
  it('hums with the traffic near the view, brighter when it moves', () => {
    const busy = soundLevels(street);
    expect(busy.hum).toBeCloseTo(8 / 12);
    expect(soundLevels({ ...street, vehicles: 4 }).hum).toBeLessThan(busy.hum / 3);
    expect(soundLevels({ ...street, speed: 1 }).cutoff).toBeLessThan(busy.cutoff);
    expect(busy.rumble).toBeGreaterThan(0);
    expect(busy.bell).toBeGreaterThan(0);
    expect(soundLevels({ ...street, trams: 0 }).bell).toBe(0);
  });

  it('fades as the view goes out, and snow muffles it', () => {
    expect(soundLevels({ ...street, viewHeight: 3000 }).hum).toBe(0);
    expect(soundLevels({ ...street, viewHeight: 1600 }).hum).toBeCloseTo(
      soundLevels(street).hum / 2,
    );
    expect(soundLevels({ ...street, snow: 1 }).hum).toBeCloseTo(soundLevels(street).hum * 0.6);
    expect(soundLevels({ ...street, rain: 1 }).rain).toBe(1);
    expect(soundLevels({ ...street, rain: 1, viewHeight: 5000 }).rain).toBeCloseTo(0.3);
  });
});
