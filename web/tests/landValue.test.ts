import { describe, expect, it } from 'vitest';

import { Growth, makeBuilding, occupants } from '../src/grow/growth';
import {
  ACCESS_CELL,
  Accessibility,
  LandValue,
  noiseLevel,
  noiseLoss,
} from '../src/grow/landValue';
import { Lots, NO_EDGE, type ZoningIndex } from '../src/grow/lots';
import {
  BASE_DEMAND,
  SHOP_JOBS_PER_RESIDENT,
  grownPeople,
  startRates,
  zoneDemand,
} from '../src/grow/zoneDemand';
import { ARCHETYPES } from '../src/grow/growth';
import { zoneCode } from '../src/grow/zones';

/** Lots at the given points, each on its own edge (its index), with a loud road (edge 99)
 * 20 m from the first. */
function lotsAt(points: [number, number][], green = 0): Lots {
  const n = points.length;
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
      lotX: Float32Array.from(points.map((p) => p[0])),
      lotZ: Float32Array.from(points.map((p) => p[1])),
      lotAngle: new Float32Array(n),
      lotFrontage: new Uint8Array(n).fill(20),
      lotDepth: new Uint8Array(n).fill(30),
      lotEdge: Uint32Array.from(points.map((_, k) => k)),
      lotPlan: new Uint8Array(n).fill(255),
      lotCover: new Uint8Array(n),
      lotContext: new Uint8Array(n),
      lotGreen: new Uint8Array(n).fill(green),
      lotLoudEdge: Uint32Array.from(points.map((_, k) => (k === 0 ? 99 : NO_EDGE))),
      lotLoudDistance: new Uint8Array(n).fill(20),
      planPolygonRings: Uint32Array.from([0]),
      planRingPoints: Uint32Array.from([0]),
      planPoints: new Float32Array(0),
      planClass: new Uint8Array(0),
    },
    index,
  );
}

describe('land value', () => {
  it('estimates traffic noise and what it takes off', () => {
    expect(noiseLevel(1000, 10)).toBeCloseTo(69.2);
    expect(noiseLevel(1000, 20)).toBeCloseTo(69.2 - 3.01, 1);
    expect(noiseLevel(10_000, 10) - noiseLevel(1000, 10)).toBeCloseTo(10);
    expect(noiseLoss(50)).toBe(0);
    expect(noiseLoss(65)).toBeCloseTo(0.06);
    expect(noiseLoss(120)).toBe(0.25);
  });

  it('measures accessibility from one street per cell, between cell centres', () => {
    const c = ACCESS_CELL;
    // Two lots in the first cell (the one nearer its centre gives the street), one in the
    // cell east of it.
    const lots = lotsAt([
      [0.1 * c, 0.1 * c],
      [0.45 * c, 0.5 * c],
      [1.5 * c, 0.5 * c],
    ]);
    const access = new Accessibility(lots);
    expect(Array.from(access.sources).sort()).toEqual([1, 2]);
    expect(Number.isNaN(access.at(0.5 * c, 0.5 * c))).toBe(true);
    const values = new Float32Array(4);
    access.sources.forEach((edge, k) => {
      values[2 * k] = edge === 1 ? 600 : 100; // residents
      values[2 * k + 1] = edge === 1 ? 400 : 100; // jobs
    });
    access.update(values);
    expect(access.at(0.5 * c, 0.5 * c)).toBeCloseTo(1000);
    expect(access.at(1.5 * c, 0.5 * c)).toBeCloseTo(200);
    expect(access.at(c, 0.5 * c)).toBeCloseTo(600);
    // Beyond the last centre, the nearest measured.
    expect(access.at(1.9 * c, 0.5 * c)).toBeCloseTo(200);
    // A new measurement counts half.
    access.update(values.map((v) => v * 3));
    expect(access.at(0.5 * c, 0.5 * c)).toBeCloseTo(2000);
  });

  it('values lots by reach, green land around and quiet', () => {
    const c = ACCESS_CELL;
    const points: [number, number][] = [
      [0.5 * c, 0.5 * c],
      [0.5 * c, 0.6 * c],
      [5.5 * c, 0.5 * c],
    ];
    const plain = new LandValue(lotsAt(points));
    const sources = plain.access.sources;
    const reach = new Float32Array(2 * sources.length);
    sources.forEach((edge, k) => {
      reach[2 * k] = edge === 2 ? 1000 : 10_000;
    });
    plain.setReach(reach);
    expect(plain.value[1]).toBeCloseTo(100);
    // A tenth of the reach: about a sixth of the value.
    expect(plain.value[2]).toBeCloseTo(100 * 0.1 ** 0.75);
    // Green all around adds a tenth.
    const green = new LandValue(lotsAt(points, 100));
    green.setReach(reach);
    expect(green.value[1]).toBeCloseTo(110);
    // 2,000 vehicles an hour on the loud road 20 m from lot 0: 69 dB, 8 % off.
    const counts = new Uint32Array(100);
    counts[99] = 4000;
    plain.setVolumes(counts, 2);
    expect(plain.noise[0]).toBeCloseTo(noiseLevel(2000, 20));
    expect(plain.value[0]).toBeCloseTo(100 * (1 - noiseLoss(noiseLevel(2000, 20))));
    expect(plain.value[1]).toBeCloseTo(100);
  });
});

describe('demand per zone', () => {
  it('starts from the base demand and follows what grows', () => {
    const jobsPerResident = 0.5;
    expect(zoneDemand({ residents: 0, shopJobs: 0, workJobs: 0 }, jobsPerResident)).toEqual(
      BASE_DEMAND,
    );
    // 2,000 new residents: homes less wanted, shops and workplaces more.
    const d = zoneDemand({ residents: 2000, shopJobs: 0, workJobs: 0 }, jobsPerResident);
    expect(d.homes).toBeCloseTo(BASE_DEMAND.homes - 0.5);
    expect(d.shops).toBeCloseTo(
      Math.min(1, BASE_DEMAND.shops + (2000 * SHOP_JOBS_PER_RESIDENT) / 400),
    );
    expect(d.work).toBeCloseTo(BASE_DEMAND.work + (2000 * 0.42) / 2000);
    // Jobs without homes for their workers: homes wanted.
    const jobs = zoneDemand({ residents: 0, shopJobs: 0, workJobs: 3000 }, jobsPerResident);
    expect(jobs.homes).toBe(1);
    expect(jobs.work).toBe(-1);
    // Rates: none at -1, twice the base at 1; mixed answers to homes and shops.
    const rates = startRates(jobs);
    expect(rates[zoneCode('offices')]).toBe(0);
    expect(rates[zoneCode('houses')]).toBe(2);
    expect(rates[zoneCode('mixed')]).toBeCloseTo(1 + (1 + jobs.shops) / 2);
  });

  it('counts the residents and jobs of finished buildings by kind', () => {
    const lots = lotsAt([
      [0, 0],
      [20, 0],
      [40, 0],
    ]);
    const growth = new Growth(lots);
    const id = (name: string) => ARCHETYPES.findIndex((a) => a.id === name);
    const corner = makeBuilding(lots, [0], id('corner block'), 1, 0);
    const office = makeBuilding(lots, [1], id('small office'), 2, 0);
    const late = makeBuilding(lots, [2], id('house'), 3, 3000);
    for (const b of [corner, office, late]) growth.add(b);
    const people = grownPeople(growth, 4000);
    expect(people.residents).toBeCloseTo(occupants(corner).residents);
    expect(people.shopJobs).toBeCloseTo(occupants(corner).jobs);
    expect(people.workJobs).toBeCloseTo(occupants(office).jobs);
  });
});
