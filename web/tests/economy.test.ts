import { describe, expect, it } from 'vitest';

import type { RoadEdit } from '../src/edit/builder';
import {
  BASE_INCOME,
  BRIDGE_M2,
  Budget,
  FEE_POINT,
  INCOME_TAX,
  LANE_KM,
  NEW_LIGHTS,
  RETIMING,
  ROUNDABOUT,
  UPKEEP_LANE_KM,
  buildingIncome,
  cityZone,
  contribution,
  editCost,
  editsCost,
  euros,
  loadBudget,
  saveBudget,
} from '../src/grow/economy';
import { ARCHETYPES, NET_AREA, heights, makeBuilding, occupants } from '../src/grow/growth';
import { Lots, type ZoningIndex } from '../src/grow/lots';

function street(n = 4): Lots {
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

const road = (over: Partial<RoadEdit> = {}): RoadEdit => ({
  kind: 'road',
  points: [
    { x: 0, z: 0 },
    { x: 600, z: 0 },
    { x: 600, z: 400 },
  ],
  type: 'secondary',
  lanes: 1,
  oneway: false,
  kmh: 50,
  bridge: false,
  ...over,
});

describe('what building costs', () => {
  it('prices roads by lane-km, bridges by deck and motorways dearer', () => {
    // 1 km, a lane each way.
    expect(editCost(road())).toEqual({ build: 2 * LANE_KM.other, upkeep: 2 * UPKEEP_LANE_KM });
    expect(editCost(road({ oneway: true, lanes: 2 })).build).toBeCloseTo(2 * LANE_KM.other);
    expect(editCost(road({ type: 'motorway', lanes: 2 })).build).toBeCloseTo(4 * LANE_KM.motorway);
    // A bridge: 1 km of deck 3.5 m a lane and 4 m of pavements, 0.5 % a year to keep.
    const bridge = editCost(road({ bridge: true }));
    expect(bridge.build).toBeCloseTo(1000 * 11 * BRIDGE_M2);
    expect(bridge.upkeep).toBeCloseTo(bridge.build * 0.005);
  });

  it('prices junctions: roundabouts, new lights and new timings', () => {
    const junction = { x: 10, z: 20 };
    expect(editCost({ kind: 'roundabout', junction, lanes: 1 }).build).toBe(ROUNDABOUT[0]);
    expect(editCost({ kind: 'roundabout', junction, lanes: 2 }).build).toBe(ROUNDABOUT[1]);
    const lights = {
      kind: 'signal' as const,
      junction,
      movements: [],
      phases: [{ seconds: 30, green: [] }],
    };
    expect(editCost(lights, () => false).build).toBe(NEW_LIGHTS);
    expect(editCost(lights, () => true).build).toBe(RETIMING);
    const total = editsCost([road(), { kind: 'roundabout', junction, lanes: 1 }], () => true);
    expect(total.build).toBeCloseTo(2 * LANE_KM.other + ROUNDABOUT[0]);
  });
});

describe('what comes in', () => {
  it('taxes residents and charges communal fees by purpose and zone', () => {
    const lots = street();
    const house = makeBuilding(lots, [0], 0, 1, 0);
    const floor = house.width * house.depth * NET_AREA;
    const h = buildingIncome(house, 70);
    expect(h.tax).toBeCloseTo(occupants(house).residents * INCOME_TAX);
    expect(h.fee).toBeCloseTo(FEE_POINT * floor * house.storeys);
    // Offices pay ten times a home's fee, in a cheaper zone less.
    const office = makeBuilding(
      lots,
      [0, 1],
      ARCHETYPES.findIndex((a) => a.id === 'office block'),
      2,
      0,
    );
    const o = buildingIncome(office, 20);
    expect(o.tax).toBe(0);
    expect(o.fee).toBeCloseTo(
      FEE_POINT * cityZone(20).fee * office.width * office.depth * NET_AREA * office.storeys * 10,
    );
    // Flats over shops: the shop floor at the shops' rate.
    const block = makeBuilding(
      lots,
      [0, 1],
      ARCHETYPES.findIndex((a) => a.id === 'perimeter block'),
      3,
      0,
    );
    const per = block.width * block.depth * NET_AREA;
    expect(buildingIncome(block, 70).fee).toBeCloseTo(FEE_POINT * per * (9 + block.storeys - 1));
  });

  it('takes the communal contribution on volume, by zone', () => {
    const lots = street();
    const house = makeBuilding(lots, [0], 0, 1, 0);
    const volume = house.width * house.depth * heights(house).eaves;
    expect(contribution(house, 70)).toBeCloseTo(volume * 18.35);
    expect(contribution(house, 40)).toBeCloseTo(volume * 18.0);
    expect(contribution(house, 1)).toBeCloseTo(volume * 2.0);
    // Not measured yet: zone III.
    expect(contribution(house, NaN)).toBeCloseTo(volume * 16.0);
  });
});

describe('the balance', () => {
  it('flows a year a simulated day, pays for building and refuses what it cannot', () => {
    const budget = new Budget();
    expect(budget.balance).toBe(BASE_INCOME);
    budget.yearly = { base: BASE_INCOME, tax: 1e6, fee: 2e5, upkeep: 2e5 };
    budget.tick(6 * 3600);
    budget.tick(18 * 3600);
    // Half a day: half a year's income less upkeep.
    expect(budget.balance).toBeCloseTo(BASE_INCOME * 1.5 + 0.5e6);
    budget.setSpent(10e6);
    expect(budget.balance).toBeCloseTo(BASE_INCOME * 1.5 + 0.5e6 - 10e6);
    // Taking an edit back refunds it.
    budget.setSpent(4e6);
    expect(budget.balance).toBeCloseTo(BASE_INCOME * 1.5 + 0.5e6 - 4e6);
    expect(budget.afford(1e6)).toBeUndefined();
    expect(budget.afford(1e9)).toMatch(/Not enough money: this costs €1.00 billion/);
    budget.contribute(250_000);
    expect(budget.contributions).toBe(250_000);
    // The balance over time: a sample every 10 simulated minutes at most.
    expect(budget.history).toHaveLength(2);
    for (let t = 18 * 3600 + 60; t <= 19 * 3600; t += 60) budget.tick(t);
    expect(budget.history).toHaveLength(8);
    expect(budget.current()).toEqual([19 / 24, Math.round(budget.balance)]);
  });

  it('is kept, and its history goes on from the next day on a new visit', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
    const budget = new Budget();
    budget.tick(7 * 3600);
    budget.tick(9 * 3600);
    budget.setSpent(1e6);
    saveBudget(budget, storage);
    const again = new Budget(loadBudget(storage));
    expect(again.balance).toBeCloseTo(budget.balance);
    expect(again.spent).toBe(1e6);
    again.tick(7 * 3600);
    const [day, balance] = again.history.at(-1)!;
    expect(Math.floor(day)).toBe(1);
    expect(balance).toBe(Math.round(budget.balance));
    expect(loadBudget({ getItem: () => '{"version":1}' } as unknown as Storage)).toBeUndefined();
  });

  it('writes sums of money plainly', () => {
    expect(euros(63_900_000)).toBe('€63.9 million');
    expect(euros(198_900)).toBe('€198,900');
    expect(euros(-1_250_000)).toBe('-€1.3 million');
    expect(euros(2.75e9)).toBe('€2.75 billion');
  });
});
