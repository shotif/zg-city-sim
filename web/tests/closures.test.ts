import { describe, expect, it } from 'vitest';

import { describeClosure } from '../src/ui/closureMarkers';
import {
  activeClosures,
  closurePoints,
  formatUntil,
  htrsTm,
  matchClosure,
  zagrebNow,
} from '../src/world/closures';
import { type RoadNetworkIndex, RoadNetwork } from '../src/world/roadNetwork';

describe('htrsTm', () => {
  it('matches PROJ for EPSG:3765 to the centimetre', () => {
    // Reference values from pyproj (EPSG:4326 -> EPSG:3765).
    const cases: [number, number, number, number][] = [
      [15.9772, 45.8131, 459370.128, 5074937.477],
      [15.6837, 45.648, 436373.346, 5056780.286],
      [16.383, 45.688, 490886.9, 5060908.183],
      [16.0, 46.05, 461307.139, 5101254.902],
    ];
    for (const [lon, lat, e, n] of cases) {
      const [x, y] = htrsTm(lon, lat);
      expect(x).toBeCloseTo(e, 1);
      expect(y).toBeCloseTo(n, 1);
    }
  });
});

describe('activeClosures', () => {
  const closures = [
    {
      street: 'a',
      expectedStartTime: '2026-10-01T07:00:00+00:00',
      expectedEndTime: '2026-10-06T22:00:00+00:00',
    },
    { street: 'b', expectedStartTime: '2026-10-07T07:00:00+00:00' },
    { street: 'c', expectedEndTime: '2026-10-06T08:00:00+00:00' },
  ];
  it('keeps closures in force, reading clock values as local time', () => {
    expect(activeClosures(closures, '2026-10-06T21:30').map((c) => c.street)).toEqual(['a']);
    expect(activeClosures(closures, '2026-10-06T07:30').map((c) => c.street)).toEqual(['a', 'c']);
  });

  it('formats the end and the current Zagreb time', () => {
    expect(formatUntil('2026-10-06T22:00:00+00:00')).toBe('6 Oct, 22:00');
    // 10:00 UTC is 12:00 in Zagreb in summer time.
    expect(zagrebNow(new Date('2026-07-01T10:00:00Z'))).toBe('2026-07-01T12:00');
    expect(
      describeClosure({
        closure: {
          street: 'Grada Vukovara',
          subtype: 'ROAD_CLOSED_CONSTRUCTION',
          direction: 'ONE_DIRECTION',
          expectedEndTime: '2026-10-06T22:00:00+00:00',
        },
        edges: [],
        x: 0,
        z: 0,
      }),
    ).toBe('Grada Vukovara closed for roadworks, one direction, until 6 Oct, 22:00.');
  });
});

describe('matchClosure', () => {
  // Two directions of "Ulica grada Vukovara" (edges 0: west to east, 1: east to west) and a
  // parallel "Savska cesta" (edge 2), each 200 m long.
  const index = {
    file: '',
    byteLength: 0,
    arrays: {},
    vclassBits: { passenger: 1 },
    flags: { bridge: 1, tunnel: 2, hasOpposite: 4, roundabout: 8, internal: 16 },
    types: ['highway.primary'],
    junctionTypes: [],
    names: ['Ulica grada Vukovara', 'Savska cesta'],
    tlsTypes: [],
    linkDirs: [],
    linkStates: [],
    none: 0xffffffff,
  } as RoadNetworkIndex;
  const net = new RoadNetwork(index, {
    junctionPos: new Float32Array(0),
    junctionType: new Uint8Array(0),
    junctionShapeOffsets: new Uint32Array([0]),
    junctionShapeOrigin: new Int32Array(0),
    junctionShapeDelta: new Int16Array(0),
    junctionShapeElev: new Int16Array(0),
    edgeFrom: new Uint32Array(3),
    edgeTo: new Uint32Array(3),
    edgeType: new Uint16Array(3),
    edgeFlags: new Uint8Array(3),
    edgeName: new Uint32Array([0, 0, 1]),
    edgeLaneStart: new Uint32Array([0, 1, 2]),
    edgeLaneCount: new Uint8Array([1, 1, 1]),
    laneEdge: new Uint32Array([0, 1, 2]),
    laneLength: new Float32Array([200, 200, 200]),
    laneSpeed: new Float32Array([13.9, 13.9, 13.9]),
    laneWidth: new Float32Array([3.2, 3.2, 3.2]),
    laneAllow: new Uint16Array([1, 1, 1]),
    laneShapeOffsets: new Uint32Array([0, 2, 4, 6]),
    // Edge 0 from (0, 2) to (200, 2); edge 1 from (200, -2) to (0, -2); edge 2 at z = 10.
    laneShapeOrigin: new Int32Array([0, 200, 20000, -200, 0, 1000]),
    laneShapeDelta: new Int16Array([0, 0, 20000, 0, 0, 0, -20000, 0, 0, 0, 20000, 0]),
    laneShapeElev: new Int16Array(6),
  });
  const line: [number, number][] = [
    [-10, 0],
    [210, 0],
  ];

  it('closes the named street along the line, in its direction', () => {
    const oneWay = { street: 'Grada Vukovara', direction: 'ONE_DIRECTION' };
    expect(matchClosure(net, line, oneWay)).toEqual([0]);
    expect(matchClosure(net, line, { ...oneWay, direction: 'BOTH_DIRECTIONS' })).toEqual([0, 1]);
  });

  it('reads the polyline as latitude-longitude pairs', () => {
    const origin = { e: 459370, n: 5074940 };
    const points = closurePoints({ polyline: '45.8131 15.9772 45.8141 15.9772' }, origin);
    expect(points).toHaveLength(2);
    expect(points[0][0]).toBeCloseTo(0.128, 1);
    expect(points[1][1]).toBeLessThan(points[0][1] - 100);
  });
});
