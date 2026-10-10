import { describe, expect, it } from 'vitest';

import { type Call, CrossingHistory, describeCall, nextCalls } from '../src/ui/railMarkers';

const calls: Call[] = [
  [21_600, 21_660, '8000', 'Dugo Selo', 'Harmica'],
  [25_200, 25_200, '8005', '', 'Dugo Selo'],
  [82_800, 82_800, '8099', 'Harmica', ''],
];

describe('nextCalls', () => {
  it('lists the trains still to come, soonest first', () => {
    expect(nextCalls(calls, 22_000, 2).map((c) => c[2])).toEqual(['8005', '8099']);
  });

  it('wraps round to the next day after the last train', () => {
    expect(nextCalls(calls, 85_000, 2).map((c) => c[2])).toEqual(['8000', '8005']);
    expect(nextCalls(calls, 86_400 + 22_000, 1).map((c) => c[2])).toEqual(['8005']);
  });

  it('takes a terminating train by its arrival', () => {
    const late: Call[] = [
      [30_000, 30_000, 'a', 'X', ''],
      [29_000, 31_000, 'b', 'X', 'Y'],
    ];
    expect(nextCalls(late, 29_500, 1)[0][2]).toBe('a');
  });
});

describe('describeCall', () => {
  it('says where a train goes, or that it starts or ends here', () => {
    expect(describeCall(calls[0])).toBe('to Harmica');
    expect(describeCall(calls[1])).toBe('starts here, to Dugo Selo');
    expect(describeCall(calls[2])).toBe('from Harmica, ends here');
  });
});

describe('CrossingHistory', () => {
  const state = (closures: number, seconds: number) =>
    Float32Array.of(42, 0, closures, seconds, 7, 0, 0, 0);

  it('counts closures and time closed over the last hour', () => {
    const h = new CrossingHistory();
    for (let m = 0; m <= 90; m++) h.record(m * 60, state(Math.floor(m / 10), m * 4));
    // At 90 min: 9 closures and 360 s so far; an hour ago (30 min), 3 and 120 s.
    expect(h.lastHour(42, 90 * 60, 9, 360)).toEqual({ since: 30 * 60, closures: 6, seconds: 240 });
    expect(h.lastHour(7, 90 * 60, 0, 0).closures).toBe(0);
  });

  it('says since when when it has less than an hour', () => {
    const h = new CrossingHistory();
    h.record(1_000, state(1, 40));
    expect(h.lastHour(42, 1_500, 2, 80)).toEqual({ since: 1_000, closures: 1, seconds: 40 });
  });

  it('starts again when the counts go back', () => {
    const h = new CrossingHistory();
    h.record(0, state(5, 200));
    h.record(60, state(0, 0));
    expect(h.lastHour(42, 120, 1, 30)).toEqual({ since: 60, closures: 1, seconds: 30 });
  });
});
