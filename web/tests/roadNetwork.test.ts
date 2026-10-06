import { describe, expect, it } from 'vitest';

import {
  type RoadNetworkIndex,
  RoadNetwork,
  classifyEdgeType,
  decodePolylines,
  laneShapeHeights,
} from '../src/world/roadNetwork';

describe('classifyEdgeType', () => {
  it('maps SUMO OSM types to road classes', () => {
    expect(classifyEdgeType('highway.motorway')).toBe('motorway');
    expect(classifyEdgeType('highway.primary_link')).toBe('primary');
    expect(classifyEdgeType('highway.residential')).toBe('minor');
    expect(classifyEdgeType('highway.living_street')).toBe('minor');
    expect(classifyEdgeType('highway.service|psv')).toBe('service');
    expect(classifyEdgeType('highway.service|railway.rail')).toBe('service');
    expect(classifyEdgeType('railway.tram')).toBe('tram');
    expect(classifyEdgeType('railway.rail')).toBe('rail');
  });
});

describe('decodePolylines', () => {
  it('accumulates centimetre steps and elevations', () => {
    const out = decodePolylines(
      new Int32Array([100, 200]),
      new Uint32Array([0, 2]),
      new Int16Array([0, 0, 150, -50]),
      new Int16Array([0, 600]),
    );
    expect(Array.from(out)).toEqual([1, 2, 0, 2.5, 1.5, 6]);
  });
});

describe('laneShapeHeights', () => {
  // Two one-lane edges: a 100 m bridge (flag 1) and a 100 m street, both with 2 m of
  // elevation offset at their far end.
  const index = {
    file: '',
    byteLength: 0,
    arrays: {},
    vclassBits: { passenger: 1 },
    flags: { bridge: 1, tunnel: 2, hasOpposite: 4, roundabout: 8, internal: 16 },
    types: ['highway.primary'],
    junctionTypes: [],
    names: [],
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
    edgeFrom: new Uint32Array(2),
    edgeTo: new Uint32Array(2),
    edgeType: new Uint16Array(2),
    edgeFlags: new Uint8Array([1, 0]),
    edgeName: new Uint32Array([0xffffffff, 0xffffffff]),
    edgeLaneStart: new Uint32Array([0, 1]),
    edgeLaneCount: new Uint8Array([1, 1]),
    laneEdge: new Uint32Array([0, 1]),
    laneLength: new Float32Array([100, 100]),
    laneSpeed: new Float32Array([13.9, 13.9]),
    laneWidth: new Float32Array([3.2, 3.2]),
    laneAllow: new Uint16Array([1, 1]),
    laneShapeOffsets: new Uint32Array([0, 3, 5]),
    laneShapeOrigin: new Int32Array([0, 0, 0, 1000]),
    laneShapeDelta: new Int16Array([0, 0, 5000, 0, 5000, 0, 0, 0, 10000, 0]),
    laneShapeElev: new Int16Array([0, 100, 200, 0, 200]),
  });
  // Ground rises 1 m per 10 m east.
  const heights = laneShapeHeights(net, (x) => x / 10);

  it('runs bridges straight between the ground at their ends, plus elevation', () => {
    expect(Array.from(heights.slice(0, 3))).toEqual([0, 6, 12]);
  });

  it('leaves the elevation offset for other lanes (the renderer adds the ground)', () => {
    expect(Array.from(heights.slice(3))).toEqual([0, 2]);
  });
});
