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

  it('runs the trips the engine runs: copies added, trips cancelled', () => {
    // A copy of the 07:00 to Sopot 35 min later; the 07:30 back cancelled.
    const words = new Uint32Array([4, 1, 4, 0, 0, 0, 0, 2, 3, 4]);
    new Float32Array(words.buffer)[5] = 2100;
    const t = new Timetable(routes, file, {
      transitTripRoute: [0, 0, 1, 0],
      transitTripStops: [0, 3, 6, 8, 11],
      transitStopTime: Array.from({ length: 11 }, (_, k) => timetable['a'].transitStopTime[k]),
      transitStopRef: [0, 1, 2, 2, 4, 0, NO_STOP, 3, 0, 1, 2],
    });
    t.setService(words);
    expect(t.tripsToday(0)).toBe(3);
    expect(t.routeOf(4)).toBe(0);
    expect(t.tripsByHour(0)[7]).toBe(2);
    expect(t.patternTrips(0, file.lines[0].patterns[0])).toEqual([0, 4, 3]);
    expect(t.tripStops(4)).toEqual([0, 1, 2]);
    const next = t.departures(t.platforms(1), h(7, 15), 3);
    expect(next.map((d) => [d.time, d.trip, d.headsign])).toEqual([
      [h(7, 45), 4, 'Sopot'],
      [h(8, 20), 3, 'Sopot'],
      [h(7, 10), 0, 'Sopot'],
    ]);
    // Words for another timetable, or none: as timetabled.
    t.setService(new Uint32Array([9, 0, 0, 0]));
    expect(t.tripsToday(0)).toBe(3);
    expect(t.departures(t.platforms(1), h(7, 15), 1)[0].time).toBe(h(7, 40));
  });

  it('runs new lines: their trips, stops and departures', () => {
    const t = new Timetable(routes, file, timetable['a']);
    const route = t.newRoute('400', 'bus');
    expect(route).toBe(2);
    expect(t.newRoute('400', 'bus')).toBe(2);
    expect(t.routeIndex('400', 'bus')).toBeUndefined();
    // Bus 400 from Črnomerec (a timetabled stop) to a stop of its own, at 07:00 and 07:30.
    const tag = 0x80000000;
    const words = new Uint32Array([
      4,
      2,
      6,
      1,
      tag,
      0,
      tag,
      0,
      0,
      1,
      2,
      3,
      4,
      5,
      0,
      0,
      2,
      0,
      0,
      1,
      0,
    ]);
    const floats = new Float32Array(words.buffer);
    floats[5] = h(7, 0);
    floats[7] = h(7, 30);
    floats[15] = 1500;
    floats[20] = 240;
    t.setService(words, [
      {
        route,
        name: '400',
        mode: 'bus',
        stops: [
          { name: 'Črnomerec', x: 10, z: 5 },
          { name: 'Gajnice', x: -900, z: -300 },
        ],
      },
    ]);
    expect(t.waysInForce).toBe(1);
    expect(t.newLineCount).toBe(1);
    expect(t.isNew(route)).toBe(true);
    expect(t.tripsToday(route)).toBe(2);
    expect(t.routeOf(5)).toBe(route);
    expect(t.km(route)).toBeCloseTo(3);
    const line = t.line(route)!;
    expect(line.patterns[0].stops).toEqual([0, 5]);
    expect(t.stop(5)).toEqual({ name: 'Gajnice', x: -900, z: -300 });
    expect(t.routes[route].longName).toBe('Črnomerec - Gajnice');
    expect(t.patternTrips(route, line.patterns[0])).toEqual([4, 5]);
    expect(t.tripStops(4)).toEqual([0, 5]);
    expect(t.tripsByHour(route)[7]).toBe(2);
    expect(t.search('400').lines.map((l) => l.route)).toEqual([route]);
    // Departures at Črnomerec, the bus's first stop (tram 6 leaves at 07:00 too); none at
    // its last.
    const next = t.departures([0], h(6, 50), 2, new Set([4, 5]));
    expect(next.map((d) => [d.time, d.route, d.headsign])).toEqual([
      [h(7, 0), route, 'Gajnice'],
      [h(7, 30), route, 'Gajnice'],
    ]);
    expect(t.departures([5], h(6, 50), 2)).toEqual([]);
    expect(t.nearestStop(-890, -300, 'bus', 60)).toBe(5);
    expect(t.nearestStop(-890, -300, 'tram', 60)).toBeUndefined();
  });

  it('adds up a line’s vehicle-km a weekday', () => {
    const t = new Timetable(
      routes,
      { ...file, tripMetres: [5000, 5200, 20000, 5000] },
      timetable['a'],
    );
    expect(t.km(0)).toBeCloseTo(15.2);
    expect(t.km(1)).toBe(20);
    expect(t.routeIndex('6', 'tram')).toBe(0);
    expect(t.routeIndex('6', 'bus')).toBeUndefined();
  });
});
