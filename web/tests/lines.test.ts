import { describe, expect, it } from 'vitest';

import { placeStops, planWords, readPlan, tripsADay } from '../src/edit/lines';
import { RoadIndex } from '../src/edit/roadIndex';
import { junction } from './fixtures';

describe('new lines', () => {
  const index = new RoadIndex(junction());

  it('put stops on the road running the way the line goes', () => {
    // Along Ilica, then up Savska cesta; a stop with no road near is left out.
    const placed = placeStops(index, [
      { x: 50, z: 0, name: 'Ilica' },
      { x: 101, z: -40, name: 'Savska' },
      { x: 2000, z: 2000, name: 'Nowhere' },
    ]);
    expect(placed[0]?.[0]).toBe(0);
    expect(placed[0]?.[1]).toBeCloseTo(45 / 90, 2);
    expect(placed[1]?.[0]).toBe(2);
    expect(placed[2]).toBeUndefined();
  });

  it('ask the engine for a way and read its answer', () => {
    const words = planWords(2, [
      [0, 0.5],
      [2, 0.25],
    ]);
    expect(words[0]).toBe(2);
    expect(new Float32Array(words.buffer)[2]).toBe(0.5);
    // Roads 0, 1, 2; two stops served, the second 95 s after the first; 1,180 m.
    const answer = new Uint32Array([3, 0, 1, 2, 2, 0, 0, 1, 0, 0]);
    const floats = new Float32Array(answer.buffer);
    floats[8] = 95;
    floats[9] = 1180;
    expect(readPlan(answer)).toEqual({ path: [0, 1, 2], served: 2, metres: 1180, seconds: 95 });
    expect(readPlan(new Uint32Array(0))).toBeNull();
    expect(tripsADay({ headway: 600, first: 5 * 3600, last: 23 * 3600 })).toBe(109);
  });
});
