import { describe, expect, it } from 'vitest';

import {
  type CareerState,
  STAGES,
  goalText,
  judge,
  newCareer,
  progress,
  progressText,
} from '../src/game/career';
import type { DayRecord } from '../src/game/days';

/** A whole day's record with the numbers given. */
function day(n: number, more: Partial<DayRecord> = {}): DayRecord {
  return {
    day: n,
    from: 0,
    trips: 400_000,
    tripMinutes: 20,
    vehicleHours: 150_000,
    delayHours: 30_000,
    vehicleKm: 1e7,
    balance: 1e6,
    ptShare: 0.4,
    residents: 0,
    jobs: 0,
    ...more,
  };
}

describe('a career', () => {
  it('runs through its stages as their goals are met, and pays their grants', () => {
    expect(STAGES.map((s) => s.id)).toEqual([
      'first-steps',
      'savska',
      'transit',
      'novi-zagreb',
      'slavonska',
    ]);
    const state = newCareer();
    // The first day, from 07:00, does not count as whole.
    const days: DayRecord[] = [day(1, { from: 7 * 3600, residents: 500 })];
    expect(judge(state, days)).toEqual([]);
    expect(state.reference).toBeUndefined();
    // Day 2: 2,500 residents, but the balance is above zero for one day running only.
    days.push(day(2, { residents: 2500, balance: 1e6 }));
    days[0].balance = -1;
    expect(judge(state, days)).toEqual([]);
    expect(state.met).toEqual({ 0: 2 });
    // Day 3: the second whole day sets the reference; the stage is done.
    days.push(day(3, { residents: 2600, delayHours: 32_000, ptShare: 0.42 }));
    const done = judge(state, days);
    expect(done.map((s) => s.id)).toEqual(['first-steps']);
    expect(state).toMatchObject({ stage: 1, met: {}, done: [{ id: 'first-steps', day: 3 }] });
    expect(state.reference?.delayHours).toBe(31_000);
    expect(state.reference?.ptShare).toBeCloseTo(0.41);

    // Savska cesta: the afternoon share over the last two whole days.
    const peaks = (pm: number | null) => ({
      'savska-tratinska': [0.1, pm] as [number, number | null],
    });
    days.push(day(4, { peaks: peaks(0.3) }));
    expect(judge(state, days)).toEqual([]);
    const jam = STAGES[1].goals[0];
    expect(progress(jam, days, state)).toEqual({ value: 0.3, met: false });
    days.push(day(5, { peaks: peaks(0.25) }));
    expect(judge(state, days).map((s) => s.id)).toEqual(['savska']);

    // Public transport: 2 points above the first days' 41 %, over two whole days.
    days.push(day(6, { ptShare: 0.43 }), day(7, { ptShare: 0.43 }));
    expect(judge(state, days)).toEqual([]);
    days.push(day(8, { ptShare: 0.44 }));
    expect(judge(state, days).map((s) => s.id)).toEqual(['transit']);
  });

  it('lets a district grow only while traffic holds', () => {
    const state: CareerState = {
      ...newCareer(),
      stage: 3,
      reference: { delayHours: 30_000, ptShare: 0.4 },
    };
    const grown = { 'Novi Zagreb - zapad': [6000, 100] as [number, number] };
    const days = [
      day(10, { districts: grown, delayHours: 33_000 }),
      day(11, { districts: grown, delayHours: 33_000 }),
    ];
    expect(judge(state, days)).toEqual([]);
    // Growth stays met; traffic is 10 % up, above the 5 % allowed.
    expect(state.met).toEqual({ 0: 11 });
    const [growth, traffic] = STAGES[3].goals;
    expect(progressText(traffic, progress(traffic, days, state), state)).toBe(
      '33,000 hours a day now, against 30,000 at first',
    );
    days.push(day(12, { delayHours: 31_000 }), day(13, { delayHours: 31_000 }));
    expect(judge(state, days).map((s) => s.id)).toEqual(['novi-zagreb']);
    expect(goalText(growth)).toBe(
      '5,000 residents in buildings grown on zoned land in Novi Zagreb – zapad',
    );
  });

  it('says what each goal asks in plain words', () => {
    const place = (id: string) =>
      id === 'savska-tratinska' ? 'Savska cesta × Tratinska ulica' : id;
    expect(STAGES.flatMap((s) => s.goals.map((g) => goalText(g, place)))).toEqual([
      '2,000 residents in buildings grown on zoned land',
      'The balance above zero at midnight, 2 days running',
      'Traffic at Savska cesta × Tratinska ulica at 20 % of the speed limit or more from 15:00 to 18:00, over two whole days (today about 7 %)',
      "Public transport's share of trips 2 points above the career's first two whole days, over two whole days",
      '5,000 residents in buildings grown on zoned land in Novi Zagreb – zapad',
      "Hours lost in traffic no more than 5 % above the career's first two whole days, over two whole days",
      'Traffic at slavonska-savska at 60 % of the speed limit or more from 07:00 to 09:00, over two whole days (today about 47 %)',
    ]);
  });
});
