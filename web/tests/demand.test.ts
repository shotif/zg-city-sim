import { describe, expect, it } from 'vitest';

import {
  CAR_TRIPS_PER_RESIDENT,
  COUNTY_WEIGHT,
  addedDemand,
  mergeDemand,
} from '../src/grow/demand';
import { ARCHETYPES, Growth, makeBuilding, occupants } from '../src/grow/growth';
import { Lots, type ZoningIndex } from '../src/grow/lots';

/** Four lots in a row: the first two in the City on edge 3, the others outside it on 5. */
function street(): Lots {
  const n = 4;
  const index: ZoningIndex = {
    file: '',
    byteLength: 0,
    arrays: {},
    lot: { frontage: 20, depth: 30 },
    planClasses: [{ id: 'residential', label: '', color: '', lots: true }],
    noPlan: 255,
    stats: {},
  };
  return new Lots(
    {
      lotX: Float32Array.from({ length: n }, (_, k) => 10 + 20 * k),
      lotZ: new Float32Array(n).fill(19.6),
      lotAngle: new Float32Array(n),
      lotFrontage: new Uint8Array(n).fill(20),
      lotDepth: new Uint8Array(n).fill(30),
      lotEdge: Uint32Array.from([3, 3, 5, 5]),
      lotPlan: Uint8Array.from([0, 0, 255, 255]),
      lotCover: new Uint8Array(n),
      lotContext: new Uint8Array(n),
      planPolygonRings: Uint32Array.from([0]),
      planRingPoints: Uint32Array.from([0]),
      planPoints: new Float32Array(0),
      planClass: new Uint8Array(0),
    },
    index,
  );
}

describe('growth makes trips', () => {
  it("adds finished buildings' residents and jobs on their streets", () => {
    const lots = street();
    const growth = new Growth(lots);
    const house = makeBuilding(lots, [0], 0, 1, 0);
    const office = makeBuilding(
      lots,
      [2, 3],
      ARCHETYPES.findIndex((a) => a.id === 'office block'),
      2,
      0,
    );
    const outside = makeBuilding(lots, [1], 0, 3, 5000);
    for (const b of [house, office, outside]) growth.add(b);
    // At 6000 s: the house (30 min) and the office (90 min) are finished, the house
    // started at 5000 s is not.
    const added = addedDemand(lots, growth, 6000);
    expect([...added.keys()].sort()).toEqual([3, 5]);
    expect(added.get(3)!.home).toBeCloseTo(occupants(house).residents);
    expect(added.get(5)).toEqual({ home: 0, work: occupants(office).jobs });
    // Homes outside the City count at the counties' higher car trip rate.
    const county = makeBuilding(lots, [3], 0, 4, 0);
    const g2 = new Growth(lots);
    g2.add(county);
    expect(addedDemand(lots, g2, 2000).get(5)!.home).toBeCloseTo(
      occupants(county).residents * COUNTY_WEIGHT,
    );
    // A lot whose street is not known adds nothing.
    expect(addedDemand(lots, growth, 6000, () => -1).size).toBe(0);
  });

  it("merges them with the city's, with the car trips the homes make", () => {
    const base = {
      demandEdge: Uint32Array.from([3, 7]),
      demandHome: Float32Array.from([10, 0]),
      demandWork: Float32Array.from([0, 5]),
    };
    const added = new Map([
      [3, { home: 2, work: 1 }],
      [9, { home: 0, work: 4 }],
    ]);
    const merged = mergeDemand(base, 1000, added);
    expect(Array.from(merged.arrays.demandEdge)).toEqual([3, 7, 9]);
    expect(Array.from(merged.arrays.demandHome)).toEqual([12, 0, 0]);
    expect(Array.from(merged.arrays.demandWork)).toEqual([1, 5, 4]);
    expect(merged.dailyTrips).toBeCloseTo(1000 + 2 * CAR_TRIPS_PER_RESIDENT);
    // The city's arrays are left as they were.
    expect(Array.from(base.demandHome)).toEqual([10, 0]);
  });
});
