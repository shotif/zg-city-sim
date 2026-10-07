import { describe, expect, it } from 'vitest';

import {
  sunAt,
  sunDirection,
  sunTimes,
  zagrebMoment,
  zagrebOffset,
  zagrebToday,
} from '../src/world/sun';

const hm = (s: number | undefined) =>
  s === undefined
    ? ''
    : `${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;

describe('the sun over Zagreb', () => {
  it('keeps Central European time, and summer time from late March to late October', () => {
    expect(zagrebOffset(Date.UTC(2026, 0, 15))).toBe(1);
    expect(zagrebOffset(Date.UTC(2026, 6, 15))).toBe(2);
    // 2026: summer time from 29 March 01:00 UTC to 25 October 01:00 UTC.
    expect(zagrebOffset(Date.UTC(2026, 2, 29, 0, 59))).toBe(1);
    expect(zagrebOffset(Date.UTC(2026, 2, 29, 1, 0))).toBe(2);
    expect(zagrebOffset(Date.UTC(2026, 9, 25, 0, 59))).toBe(2);
    expect(zagrebOffset(Date.UTC(2026, 9, 25, 1, 0))).toBe(1);
    expect(zagrebMoment({ year: 2026, month: 7, day: 1 }, 12 * 3600)).toBe(
      Date.UTC(2026, 6, 1, 10),
    );
    expect(zagrebMoment({ year: 2026, month: 1, day: 1 }, 12 * 3600)).toBe(
      Date.UTC(2026, 0, 1, 11),
    );
    expect(zagrebToday(Date.UTC(2026, 9, 6, 22, 30))).toEqual({ year: 2026, month: 10, day: 7 });
  });

  it('stands as high at noon as Zagreb’s latitude allows', () => {
    // 90° - 45.81° ± 23.44° at the solstices.
    const top = (month: number, day: number) => {
      let best = -90;
      for (let s = 10 * 3600; s <= 15 * 3600; s += 60) {
        best = Math.max(best, sunAt({ year: 2026, month, day }, s).elevation);
      }
      return best;
    };
    expect(top(6, 21)).toBeCloseTo(67.6, 0);
    expect(top(12, 21)).toBeCloseTo(20.7, 0);
    // South at noon, east in the morning, west in the evening.
    expect(sunAt({ year: 2026, month: 6, day: 21 }, 13 * 3600).azimuth).toBeGreaterThan(170);
    expect(sunAt({ year: 2026, month: 6, day: 21 }, 13 * 3600).azimuth).toBeLessThan(195);
    // Due east at sunrise on the equinox.
    const equinox = { year: 2026, month: 3, day: 20 };
    expect(Math.abs(sunAt(equinox, sunTimes(equinox).rise!).azimuth - 90)).toBeLessThan(3);
  });

  it('rises and sets when the almanacs say', () => {
    // Zagreb, 2026 (local time; solarwatch.app): 21 June 05:06 and 20:48; 21 December
    // 07:34 and 16:14.
    const near = (s: number | undefined, h: number, m: number) =>
      expect(Math.abs(s! - (h * 3600 + m * 60))).toBeLessThan(150);
    const june = sunTimes({ year: 2026, month: 6, day: 21 });
    near(june.rise, 5, 6);
    near(june.set, 20, 48);
    const december = sunTimes({ year: 2026, month: 12, day: 21 });
    near(december.rise, 7, 34);
    near(december.set, 16, 14);
    expect(hm(june.rise)).toMatch(/^5:0\d$/);
  });

  it('gives the direction to the sun in scene axes', () => {
    const [x, y, z] = sunDirection({ elevation: 0, azimuth: 90 });
    expect([x, y, z].map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0, -0]);
    const south = sunDirection({ elevation: 30, azimuth: 180 });
    expect(south[2]).toBeCloseTo(Math.cos(Math.PI / 6));
    expect(south[1]).toBeCloseTo(0.5);
  });
});
