import { describe, expect, it } from 'vitest';

import { Lots, type ZoningIndex } from '../src/grow/lots';
import {
  type Stroke,
  applyStroke,
  decodeZoningFromUrl,
  encodeZoningForUrl,
  loadSavedZoning,
  parseZoning,
  plannedZone,
  saveZoning,
  serializeZoning,
  zoneCode,
  zoneTotals,
  zonesFrom,
} from '../src/grow/zones';

const PLAN_CLASSES = ['residential', 'mixed', 'commercial', 'office', 'industrial', 'civic'].map(
  (id) => ({ id, label: id, color: '#888888', lots: id !== 'civic' }),
);

/**
 * Ten lots along a street running east from (0, 0), on its south side: centres at x = 10,
 * 30, ... 190 and z = 19.6 (a pavement and half a lot back). The first six are planned:
 * housing among no buildings, one-storey, two-storey, four-storey and eight-storey ones,
 * then offices; the rest have no plan.
 */
function street(): Lots {
  const n = 10;
  const index: ZoningIndex = {
    file: '',
    byteLength: 0,
    arrays: {},
    lot: { frontage: 20, depth: 30 },
    planClasses: PLAN_CLASSES,
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
      lotEdge: new Uint32Array(n).fill(7),
      lotPlan: Uint8Array.from([0, 0, 0, 0, 0, 3, 255, 255, 255, 255]),
      lotCover: new Uint8Array(n).fill(40),
      lotContext: Uint8Array.from([0, 1, 2, 4, 8, 0, 0, 0, 0, 0]),
      planPolygonRings: Uint32Array.from([0]),
      planRingPoints: Uint32Array.from([0]),
      planPoints: new Float32Array(0),
      planClass: new Uint8Array(0),
    },
    index,
  );
}

describe('lots', () => {
  it('lie to the right of their street, found by position', () => {
    const lots = street();
    expect(lots.count).toBe(10);
    // The first: 20 m of frontage from x 0 to 20, from 4.6 m to 34.6 m south of the street.
    const c = lots.corners(0).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
    expect(c).toEqual([
      [0, 4.6],
      [20, 4.6],
      [20, 34.6],
      [0, 34.6],
    ]);
    expect(lots.area(0)).toBe(600);
    expect(lots.within(50, 20, 25).sort()).toEqual([1, 2, 3]);
    expect(lots.within(500, 500, 100)).toEqual([]);
    expect(lots.planOf(0)?.id).toBe('residential');
    expect(lots.planOf(9)).toBeUndefined();
  });
});

describe('zoning', () => {
  it('paints the lots under a brush, along the whole stroke', () => {
    const lots = street();
    const zones = new Uint8Array(lots.count);
    const changed = applyStroke(lots, zones, { brush: 'shops', radius: 25, points: [[50, 20]] });
    expect(changed.sort()).toEqual([1, 2, 3]);
    expect(Array.from(zones)).toEqual([0, 5, 5, 5, 0, 0, 0, 0, 0, 0]);
    // A quick drag from one end to the other leaves no gaps.
    applyStroke(lots, zones, {
      brush: 'industry',
      radius: 12,
      points: [
        [10, 20],
        [190, 20],
      ],
    });
    expect(zones.every((z) => z === zoneCode('industry'))).toBe(true);
    // Removing zoning, and painting again only what changes.
    expect(applyStroke(lots, zones, { brush: 'none', radius: 12, points: [[10, 20]] })).toEqual([
      0,
    ]);
    expect(applyStroke(lots, zones, { brush: 'none', radius: 12, points: [[10, 20]] })).toEqual([]);
  });

  it("follows the City's plan: housing by the buildings around", () => {
    const lots = street();
    const plan = Array.from({ length: lots.count }, (_, i) => plannedZone(lots, i));
    expect(plan).toEqual([
      zoneCode('lowrise'),
      zoneCode('houses'),
      zoneCode('houses'),
      zoneCode('lowrise'),
      zoneCode('highrise'),
      zoneCode('offices'),
      0,
      0,
      0,
      0,
    ]);
    const strokes: Stroke[] = [
      { brush: 'plan', radius: 300, points: [[100, 20]] },
      { brush: 'houses', radius: 15, points: [[190, 20]] },
    ];
    const zones = zonesFrom(lots, strokes);
    expect(Array.from(zones)).toEqual([...plan.slice(0, 9), zoneCode('houses')]);
    const totals = zoneTotals(lots, zones);
    expect(totals[0]).toEqual({ lots: 3, area: 1800 });
    expect(totals[zoneCode('houses')]).toEqual({ lots: 3, area: 1800 });
  });

  it('is kept and shared as strokes', async () => {
    const strokes: Stroke[] = [
      { brush: 'highrise', radius: 80.4, points: [[12.6, -3.2]] },
      {
        brush: 'plan',
        radius: 200,
        points: [
          [0, 0],
          [100, 50],
        ],
      },
    ];
    const text = serializeZoning(strokes);
    expect(parseZoning(text)).toEqual([
      { brush: 'highrise', radius: 80, points: [[13, -3]] },
      strokes[1],
    ]);
    expect(() => parseZoning('{"strokes": 3}')).toThrow();
    expect(
      parseZoning('{"strokes":[{"brush":"castle","radius":5,"points":[[0,0]]},{"brush":"shops"}]}'),
    ).toEqual([]);

    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
    saveZoning(strokes, storage);
    expect(loadSavedZoning(storage)).toHaveLength(2);
    saveZoning([], storage);
    expect(loadSavedZoning(storage)).toEqual([]);

    const encoded = await encodeZoningForUrl(strokes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeZoningFromUrl(encoded)).toEqual(parseZoning(text));
  });
});
