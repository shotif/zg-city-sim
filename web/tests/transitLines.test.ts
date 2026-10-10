import { describe, expect, it } from 'vitest';

import { type LinesFile, NO_STOP, type Route, Timetable, fold } from '../src/world/transitLines';

// Two lines: tram 6 (stops 0, 1, 2 one way at 07:00 and 08:10, back 2, 1, 0 at 07:30) and
// a train calling at stop 3 from beyond the map.
const routes: Route[] = [
  { name: '6', longName: 'Črnomerec - Sopot', mode: 'tram' },
  { name: '', longName: 'Zagreb Glavni kolodvor - Dugo Selo', mode: 'train' },
];
const file: LinesFile = {
  stops: [
    ['Črnomerec', 0, 0],
    ['Trg bana Jelačića', 1000, 0],
    ['Sopot', 2000, 1000],
    ['Maksimir', 3000, 0],
    ['Trg bana Jelačića', 1010, 20],
  ],
  lines: [
    {
      route: 0,
      trips: 3,
      patterns: [
        { headsign: 'Sopot', stops: [0, 1, 2], trips: 2 },
        { headsign: 'Črnomerec', stops: [2, 4, 0], trips: 1 },
      ],
    },
    { route: 1, trips: 1, patterns: [{ headsign: 'Dugo Selo', stops: [3], trips: 1 }] },
  ],
  headsigns: ['Dugo Selo', 'Sopot', 'Črnomerec'],
  tripHeadsign: [1, 2, 0, 1],
};
const h = (hh: number, mm: number) => hh * 3600 + mm * 60;
const timetable = new Timetable(routes, file, {
  transitTripRoute: [0, 0, 1, 0],
  transitTripStops: [0, 3, 6, 8, 11],
  transitStopTime: [
    h(7, 0),
    h(7, 10),
    h(7, 20),
    h(7, 30),
    h(7, 40),
    h(7, 50),
    h(7, 55),
    h(8, 5),
    h(8, 10),
    h(8, 20),
    h(8, 30),
  ],
  transitStopRef: [0, 1, 2, 2, 4, 0, NO_STOP, 3, 0, 1, 2],
});

describe('Timetable', () => {
  it('counts a line’s trips by the hour they start', () => {
    const hours = timetable.tripsByHour(0);
    expect(hours[7]).toBe(2);
    expect(hours[8]).toBe(1);
    expect(hours.reduce((a, b) => a + b)).toBe(3);
  });

  it('finds the trips that run as a pattern does', () => {
    expect(timetable.patternTrips(0, file.lines[0].patterns[0])).toEqual([0, 3]);
    expect(timetable.patternTrips(0, file.lines[0].patterns[1])).toEqual([1]);
    expect(timetable.tripStops(2)).toEqual([3]);
  });

  it('lists the next departures at a stop and its other platforms', () => {
    const platforms = timetable.platforms(1);
    expect(platforms).toEqual([1, 4]);
    const next = timetable.departures(platforms, h(7, 15), 3);
    expect(next.map((d) => [d.time, d.headsign])).toEqual([
      [h(7, 40), 'Črnomerec'],
      [h(8, 20), 'Sopot'],
      [h(7, 10), 'Sopot'],
    ]);
    // A trip's last stop is no departure; only the trips asked for.
    expect(timetable.departures([2], h(7, 0), 5).map((d) => d.trip)).toEqual([1]);
    expect(timetable.departures([1], h(7, 0), 5, new Set([3])).map((d) => d.trip)).toEqual([3]);
  });

  it('searches lines by number and name, and stops by name, ignoring accents', () => {
    expect(timetable.search('6').lines.map((l) => l.route)).toEqual([0]);
    expect(timetable.search('crnomerec').lines.map((l) => l.route)).toEqual([0]);
    expect(timetable.search('jelacic').stops).toEqual([1]);
    expect(fold('Đurđevac')).toBe('durdevac');
  });
});
