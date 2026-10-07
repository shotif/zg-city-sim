import { describe, expect, it } from 'vitest';

import {
  ARCHETYPES,
  Growth,
  finished,
  footprint,
  heights,
  makeBuilding,
  occupants,
  restoreBuildings,
  saveBuildings,
} from '../src/grow/growth';
import { Lots, type ZoningIndex } from '../src/grow/lots';
import { zoneCode } from '../src/grow/zones';

/** Twenty lots in a row along a street running east from (0, 0), on its south side. */
function street(n = 20): Lots {
  const index: ZoningIndex = {
    file: '',
    byteLength: 0,
    arrays: {},
    lot: { frontage: 20, depth: 30 },
    planClasses: [],
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
      lotEdge: new Uint32Array(n).fill(3),
      lotPlan: new Uint8Array(n).fill(255),
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

const zoned = (lots: Lots, zone: Parameters<typeof zoneCode>[0]) =>
  new Uint8Array(lots.count).fill(zoneCode(zone));

describe('growth', () => {
  it('joins neighbouring lots into plots', () => {
    const lots = street(5);
    expect(Array.from(lots.next)).toEqual([1, 2, 3, 4, -1]);
    const growth = new Growth(lots);
    const zones = zoned(lots, 'industry');
    zones[3] = zoneCode('shops');
    expect(growth.run(zones, 0, 4)).toEqual([0, 1, 2]);
    expect(growth.run(zones, 3, 4)).toEqual([3]);
  });

  it('grows buildings that fit their plots, the same from the same seed', () => {
    const lots = street();
    const zones = zoned(lots, 'lowrise');
    zones.fill(zoneCode('highrise'), 10);
    const grow = () => {
      const g = new Growth(lots, 5);
      g.tick(zones, 0);
      g.tick(zones, 60 * 60);
      return g;
    };
    const growth = grow();
    const built = growth.buildings.filter((b) => b !== undefined);
    expect(built.length).toBeGreaterThan(3);
    expect(JSON.stringify(grow().buildings)).toBe(JSON.stringify(growth.buildings));
    const used = new Set<number>();
    for (const b of built) {
      const a = ARCHETYPES[b.archetype];
      // Its lots: one after another, zoned for it, its own.
      expect(b.lots).toHaveLength(a.lots);
      b.lots.forEach((i, k) => {
        expect(zones[i]).toBe(zoneCode(a.zone));
        if (k) expect(lots.next[b.lots[k - 1]]).toBe(i);
        expect(used.has(i)).toBe(false);
        used.add(i);
      });
      // Inside its plot: the lots' frontage along the street, 30 m deep from 4.6 m.
      const x0 = lots.x[b.lots[0]] - 10;
      const x1 = x0 + 20 * b.lots.length;
      for (const [x, z] of footprint(lots, b)) {
        expect(x).toBeGreaterThanOrEqual(x0 + 0.99);
        expect(x).toBeLessThanOrEqual(x1 - 0.99);
        expect(z).toBeGreaterThanOrEqual(4.6);
        expect(z).toBeLessThanOrEqual(4.6 + 30 - 0.99);
      }
      expect(b.storeys).toBeGreaterThanOrEqual(a.storeys[0]);
      expect(b.storeys).toBeLessThanOrEqual(a.storeys[1]);
      expect(b.done - b.started).toBe(a.build * 60);
    }
  });

  it('counts a building finished once its time has come, or on a new day', () => {
    const lots = street(2);
    const b = makeBuilding(lots, [0], 0, 1, 1000);
    expect(b.done).toBe(1000 + 30 * 60);
    expect(finished(b, 1500)).toBe(false);
    expect(finished(b, b.done)).toBe(true);
    // The clock went back (a new visit starts at 06:50 again).
    expect(finished(b, 500)).toBe(true);
  });

  it('counts residents and jobs from floor area', () => {
    const lots = street(4);
    const house = makeBuilding(lots, [0], 0, 1, 0);
    const { eaves, ridge } = heights(house);
    expect(ridge - eaves).toBe(3);
    const floor = house.width * house.depth * 0.8 * house.storeys;
    expect(occupants(house)).toEqual({ residents: floor / 30, jobs: 0 });
    const office = ARCHETYPES.findIndex((a) => a.id === 'office block');
    const block = makeBuilding(lots, [0, 1], office, 2, 0);
    expect(occupants(block).residents).toBe(0);
    expect(occupants(block).jobs).toBeCloseTo(
      (block.width * block.depth * 0.8 * block.storeys) / 20,
    );
    const mixed = ARCHETYPES.findIndex((a) => a.id === 'perimeter block');
    const perimeter = makeBuilding(lots, [0, 1], mixed, 3, 0);
    // Shops at street level, flats above, along the whole plot.
    expect(perimeter.width).toBe(38);
    expect(occupants(perimeter).jobs).toBeCloseTo((perimeter.width * perimeter.depth * 0.8) / 35);
  });

  it('builds taller where land is dearer, and keeps the storeys it built', () => {
    const lots = street(4);
    const tower = ARCHETYPES.findIndex((a) => a.id === 'tower');
    const at = (value: number) =>
      Array.from({ length: 50 }, (_, seed) => makeBuilding(lots, [0, 1], tower, seed, 0, value));
    // Towers have 12-19 storeys: land value sets 60 % of where in that range.
    expect(Math.max(...at(0).map((b) => b.storeys))).toBeLessThanOrEqual(15);
    expect(Math.min(...at(100).map((b) => b.storeys))).toBeGreaterThanOrEqual(16);
    expect(makeBuilding(lots, [0, 1], tower, 3, 0, 0, 18).storeys).toBe(18);
  });

  it('starts building as fast as demand asks, on dearer land first', () => {
    const lots = street(200);
    const zones = zoned(lots, 'houses');
    const built = (rate: number, value?: Float32Array) => {
      const g = new Growth(lots, 4);
      g.rates = [0, rate, 1, 1, 1, 1, 1, 1];
      g.value = value;
      g.tick(zones, 0);
      g.tick(zones, 10 * 60);
      return g.buildings.filter((b) => b !== undefined);
    };
    expect(built(0)).toHaveLength(0);
    expect(built(2).length).toBeGreaterThan(built(1).length * 1.5);
    // Half the lots are worth 100, the others 5: the dear ones go first.
    const value = Float32Array.from({ length: 200 }, (_, i) => (i % 2 ? 100 : 5));
    const dear = built(1, value).filter((b) => b.lots[0] % 2 === 1).length;
    expect(dear).toBeGreaterThan(built(1, value).length * 0.6);
  });

  it('takes buildings down when their lots are zoned for something else, and keeps them', () => {
    const lots = street();
    const zones = zoned(lots, 'industry');
    const growth = new Growth(lots, 9);
    growth.tick(zones, 0);
    growth.tick(zones, 60 * 30);
    const saved = saveBuildings(lots, growth);
    expect(saved.length).toBeGreaterThan(0);

    // The same buildings again from what was saved.
    const again = new Growth(lots);
    expect(restoreBuildings(lots, again, zones, saved)).toBe(saved.length);
    // Back finished: the simulated day starts again on every visit.
    const finished = saved.map((b) => [b[0], b[1], b[2], b[3], 0, 0, b[6]]);
    expect(saveBuildings(lots, again)).toEqual(finished);

    const first = growth.buildings.find((b) => b !== undefined)!;
    zones[first.lots[0]] = zoneCode('houses');
    const gone = growth.sync(zones);
    expect(gone).toHaveLength(1);
    expect(growth.lotBuilding[first.lots[0]]).toBe(-1);
    // Saved buildings whose lots changed zone are not put back.
    const third = new Growth(lots);
    expect(restoreBuildings(lots, third, zones, saved)).toBe(saved.length - 1);
  });
});
