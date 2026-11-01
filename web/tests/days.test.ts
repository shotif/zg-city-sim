import { describe, expect, it } from 'vitest';

import { DAY, DayLog, type Totals, loadDays } from '../src/game/days';
import { change, dayTitle, describeDay } from '../src/ui/daysPanel';

function memory(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as Storage;
}

/** Totals after `t` seconds of a steady day: a trip of 20 min every 10 s. */
function totals(t: number): Totals {
  return {
    trips: t / 10,
    meanTripTime: 1200,
    vehicleHours: t / 36,
    delayHours: t / 360,
    vehicleKm: t,
  };
}

describe('the days played', () => {
  it('counts a day from midnight to midnight, the first from when the streets filled', () => {
    const storage = memory();
    const log = new DayLog(() => 4, storage);
    const extras = () => ({ balance: 1e6 });
    // Warming up: not counted.
    expect(log.tick(6 * 3600, totals(6 * 3600), false, extras)).toBeUndefined();
    expect(log.sofar()).toBeUndefined();
    expect(log.dayAt(6 * 3600)).toBe(4);
    // From 07:00, a minute at a time, to past midnight.
    let ended;
    for (let t = 7 * 3600; t <= DAY + 60 && !ended; t += 60) {
      ended = log.tick(t, totals(t), true, extras);
    }
    expect(ended).toMatchObject({ day: 4, from: 7 * 3600, balance: 1e6 });
    expect(ended!.trips).toBeCloseTo((DAY - 7 * 3600) / 10, -2);
    expect(ended!.tripMinutes).toBeCloseTo(20);
    expect(ended!.delayHours).toBeCloseTo((DAY - 7 * 3600) / 360, 0);
    expect(log.dayAt(DAY + 60)).toBe(5);
    // The next day is whole.
    for (let t = DAY + 120; t <= 2 * DAY + 60 && (ended?.day ?? 0) < 5; t += 60) {
      ended = log.tick(t, totals(t), true, extras) ?? ended;
    }
    expect(ended).toMatchObject({ day: 5, from: 0 });
    expect(ended!.delayHours).toBeCloseTo(DAY / 360, 0);
    // Kept with the city.
    expect(loadDays(storage).map((d) => d.day)).toEqual([4, 5]);
    expect(new DayLog(() => 6, storage).days).toHaveLength(2);
    // Day 5 is compared with the whole day before it: none, as day 4 started at 07:00.
    expect(log.before(5)).toBeUndefined();
    expect(log.before(6)?.day).toBe(5);
  });

  it('says what a day was in plain words', () => {
    const day = {
      day: 5,
      from: 0,
      trips: 412_000,
      tripMinutes: 21.4,
      vehicleHours: 150_000,
      delayHours: 30_000,
      vehicleKm: 9.8e6,
      ptTrips: 420_000,
      ptShare: 0.458,
      residents: 1200,
      jobs: 300,
      balance: 63.9e6,
    };
    const before = { ...day, day: 4, delayHours: 32_000 };
    expect(dayTitle(day)).toBe('Day 5');
    expect(dayTitle({ ...day, from: 7 * 3600 })).toBe('Day 5, from 07:00');
    expect(describeDay(day, before)).toEqual([
      '412,000 trips by road, 21.4 min on average.',
      '30,000 hours lost in traffic against the speed limits, 6 % less than on day 4; 9,800,000 km driven.',
      'Public transport: about 420,000 trips a weekday, 45.8 % of trips by car and public transport within the map (estimated).',
      'Grown on zoned land: 1,200 residents and 300 jobs.',
      'Balance at midnight: €63.9 million.',
    ]);
    expect(change(100, 100, 3)).toBe(', as on day 3');
    expect(change(100, undefined, undefined)).toBe('');
  });
});
