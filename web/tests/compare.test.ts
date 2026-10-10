import { describe, expect, it } from 'vitest';

import {
  DIFF_MIN_VEHICLES,
  PLACES,
  change,
  commonMinute,
  compareStats,
  diffBands,
  pairTimes,
  ridersRows,
  summariseTravelTimes,
} from '../src/edit/compare';
import { STAT } from '../src/sim/wasm';

describe('compareStats', () => {
  it('reads both simulations alike', () => {
    const today = new Float64Array(23);
    const edited = new Float64Array(23);
    today[STAT.delayHours] = 1200;
    edited[STAT.delayHours] = 900;
    today[STAT.meanSpeed] = 10;
    edited[STAT.meanSpeed] = 12;
    today[STAT.meanTripTime] = 1200;
    edited[STAT.meanTripTime] = 1080;
    const rows = compareStats(today, edited);
    const delay = rows.find((r) => r.label === 'Delay so far')!;
    expect([delay.today, delay.edited, delay.moreIsBetter]).toEqual([1200, 900, false]);
    const speed = rows.find((r) => r.label === 'Mean speed')!;
    expect([speed.today, speed.edited]).toEqual([36, 43.2]);
    expect(rows.find((r) => r.label === 'Mean trip')!.edited).toBe(18);
    today[STAT.transitLate] = 300;
    edited[STAT.transitLate] = 90;
    const late = compareStats(today, edited).find((r) => r.label.startsWith('Trams and buses'))!;
    expect([late.today, late.edited, late.unit]).toEqual([5, 1.5, 'min']);
    expect(change(1200, 900)).toBe(-0.25);
    expect(change(0, 0)).toBe(0);
  });
});

describe('summariseTravelTimes', () => {
  it('averages the change over pairs with routes and lists the biggest', () => {
    const pairs: [number, number][] = [
      [0, 1],
      [1, 0],
      [0, 2],
      [2, 0],
    ];
    const names = ['A', 'B', 'C'];
    // A->B 10 % slower, B->A 30 % faster, A->C no route with the edits, C->A unchanged.
    const summary = summariseTravelTimes(pairs, [600, 600, 900, 300], [660, 420, -1, 300], names);
    expect(summary.pairs).toBe(3);
    expect(summary.mean).toBeCloseTo((0.1 - 0.3 + 0) / 3, 6);
    expect(summary.slower).toEqual([{ from: 'A', to: 'B', today: 600, edited: 660 }]);
    expect(summary.faster).toEqual([{ from: 'B', to: 'A', today: 600, edited: 420 }]);
    expect(PLACES).toHaveLength(21);
  });
});

describe('diffBands', () => {
  it('sorts busy roads by how much their traffic changed', () => {
    const n = DIFF_MIN_VEHICLES;
    const today = [100, 100, 100, 100, 100, n - 1, 100];
    const edited = [50, 80, 105, 125, 200, n - 1, 300];
    const bands = diffBands(today, edited, (e) => e !== 6);
    expect(bands).toEqual([[0], [1], [], [3], [4]]);
  });
});

describe('commonMinute', () => {
  it('finds the latest minute both simulations have measures for', () => {
    const stats = new Float64Array(1);
    const a = new Map([400, 401, 402].map((m) => [m, stats]));
    const b = new Map([399, 400, 401].map((m) => [m, stats]));
    expect(commonMinute(a, b)).toBe(401);
    expect(commonMinute(a, new Map())).toBeUndefined();
  });
});

describe('public transport in the comparison', () => {
  it('compares riders and car trips, and picks pairs out of a matrix', () => {
    const rows = ridersRows({
      ready: true,
      busy: false,
      today: 400_000,
      now: 420_000,
      moved: 15_000,
      carToday: 700_000,
      boardingsToday: new Float32Array(0),
      boardingsNow: new Float32Array(0),
    });
    expect(rows.map((r) => [r.today, r.edited, r.moreIsBetter])).toEqual([
      [400_000, 420_000, true],
      [700_000, 685_000, false],
    ]);
    // Three places: 0 → 2 and 2 → 1.
    expect(
      pairTimes(
        [
          [0, 2],
          [2, 1],
        ],
        3,
        [0, 1, 2, 3, 4, 5, 6, 7, 8],
      ),
    ).toEqual([2, 7]);
  });
});
