import { describe, expect, it } from 'vitest';

import {
  BUS_LANE,
  type Edit,
  decodeEditsFromUrl,
  describeEdit,
  editWords,
  encodeEditsForUrl,
  loadSavedEdits,
  parseEdits,
  resolveEdits,
  saveEdits,
  serializeEdits,
  withEdit,
} from '../src/edit/edits';
import { RoadIndex, headingOf } from '../src/edit/roadIndex';
import { type RoadNetworkIndex, RoadNetwork } from '../src/world/roadNetwork';

const NONE = 0xffffffff;

/**
 * Ilica runs east (two lanes) into a signalled junction at x = 100 and on east (one
 * lane); Savska cesta leaves it north. The right lane goes straight on, the left lane
 * turns left.
 */
function junction(): RoadNetwork {
  const index = {
    file: '',
    byteLength: 0,
    arrays: {},
    vclassBits: { passenger: 1, bus: 2 },
    flags: { bridge: 1, tunnel: 2, hasOpposite: 4, roundabout: 8, internal: 16 },
    types: ['highway.primary'],
    junctionTypes: [],
    names: ['Ilica', 'Savska cesta'],
    tlsTypes: [],
    linkDirs: ['s', 'l', 'r', 't', 'L', 'R', 'invalid'],
    linkStates: [],
    none: NONE,
  } as RoadNetworkIndex;
  // Lane shapes in centimetres: origin per lane, then steps from it.
  const lanes: [number, number, number, number][] = [
    [500, 160, 9000, 0], // Ilica in, right lane
    [500, -160, 9000, 0], // Ilica in, left lane
    [10500, 160, 9000, 0], // Ilica on
    [10160, -500, 0, -9000], // Savska cesta north
  ];
  return new RoadNetwork(index, {
    junctionPos: new Float32Array([0, 0, 100, 0, 200, 0, 100, -100]),
    junctionType: new Uint8Array(4),
    junctionShapeOffsets: new Uint32Array([0, 0, 0, 0, 0]),
    junctionShapeOrigin: new Int32Array(0),
    junctionShapeDelta: new Int16Array(0),
    junctionShapeElev: new Int16Array(0),
    edgeFrom: new Uint32Array([0, 1, 1]),
    edgeTo: new Uint32Array([1, 2, 3]),
    edgeType: new Uint16Array(3),
    edgeFlags: new Uint8Array(3),
    edgeName: new Uint32Array([0, 0, 1]),
    edgeLaneStart: new Uint32Array([0, 2, 3]),
    edgeLaneCount: new Uint8Array([2, 1, 1]),
    laneEdge: new Uint32Array([0, 0, 1, 2]),
    laneLength: new Float32Array([90, 90, 90, 90]),
    laneSpeed: new Float32Array([13.9, 13.9, 13.9, 13.9]),
    laneWidth: new Float32Array([3.2, 3.2, 3.2, 3.2]),
    laneAllow: new Uint16Array([1, 1, 1, 1]),
    laneLinkOffsets: new Uint32Array([0, 1, 2, 2, 2]),
    laneShapeOffsets: new Uint32Array([0, 2, 4, 6, 8]),
    laneShapeOrigin: new Int32Array(lanes.flatMap(([x, z]) => [x, z])),
    laneShapeDelta: new Int16Array(lanes.flatMap(([, , dx, dz]) => [0, 0, dx, dz])),
    laneShapeElev: new Int16Array(8),
    linkFrom: new Uint32Array([0, 1]),
    linkTo: new Uint32Array([2, 3]),
    linkDir: new Uint8Array([0, 1]),
    linkJunction: new Uint32Array([1, 1]),
    linkTls: new Uint32Array([0, 0]),
  });
}

describe('RoadIndex', () => {
  const index = new RoadIndex(junction());

  it('picks the road nearest a point, and gives its middle and heading', () => {
    expect(index.pick(50, 3)).toBe(0);
    expect(index.pick(150, 0)).toBe(1);
    expect(index.pick(500, 500)).toBeUndefined();
    const ref = index.ref(0);
    expect(ref).toMatchObject({ x: 50, heading: 90, name: 'Ilica' });
    expect(ref.z).toBeCloseTo(1.6, 5);
    expect(index.ref(2).heading).toBe(0);
    expect(headingOf(0, 1)).toBe(180);
  });

  it('finds a saved road again near its point, in its direction', () => {
    expect(index.find({ x: 47, z: 5, heading: 95 })).toBe(0);
    // The other way along the same road, or too far away: not found.
    expect(index.find({ x: 50, z: 1.6, heading: 270 })).toBeUndefined();
    expect(index.find({ x: 50, z: 40, heading: 90 })).toBeUndefined();
  });

  it('lists the turns at the junction ahead and its signals', () => {
    expect(index.turns(0)).toEqual([
      { to: 1, direction: 'straight on', name: 'Ilica', tls: 0 },
      { to: 2, direction: 'left', name: 'Savska cesta', tls: 0 },
    ]);
    expect(index.signalAt(0)).toBe(0);
    expect(index.signalAt(1)).toBeUndefined();
    expect(index.junctionRef(0)).toEqual({ x: 100, z: 0 });
    expect(index.findSignal({ x: 110, z: 5 })).toBe(0);
    expect(index.signalEdges(0)).toEqual([0]);
  });
});

describe('edits', () => {
  const index = new RoadIndex(junction());
  const ilica = index.ref(0);
  const savska = index.ref(2);
  const edits: Edit[] = [
    { kind: 'close', road: index.ref(1) },
    { kind: 'speed', road: ilica, kmh: 30 },
    { kind: 'busLane', road: ilica, lane: 0 },
    { kind: 'ban', from: ilica, to: savska },
    { kind: 'green', junction: { x: 100, z: 0 }, phase: 2, seconds: 40 },
    // A road this network does not have.
    { kind: 'closeLane', road: { x: 900, z: 900, heading: 0 }, lane: 0 },
  ];

  it('match the network and become the engine records', () => {
    const { resolved, missing } = resolveEdits(index, edits);
    expect(missing).toEqual([edits[5]]);
    expect(resolved.map((r) => r.edges)).toEqual([[1], [0], [0], [0, 2], [0]]);
    const words = editWords(resolved);
    const floats = new Float32Array(words.buffer);
    expect(Array.from(words.slice(0, 4))).toEqual([1, 1, 0, 0]);
    expect(Array.from(words.slice(4, 7))).toEqual([3, 0, 0]);
    expect(floats[7]).toBeCloseTo(30 / 3.6, 5);
    expect(Array.from(words.slice(8, 11))).toEqual([4, 0, 0]);
    expect(floats[11]).toBe(BUS_LANE);
    expect(Array.from(words.slice(12, 16))).toEqual([5, 0, 2, 0]);
    expect(Array.from(words.slice(16, 19))).toEqual([6, 0, 2]);
    expect(floats[19]).toBe(40);
  });

  it('replace earlier edits of the same thing', () => {
    let list = withEdit([], { kind: 'speed', road: ilica, kmh: 30 });
    list = withEdit(list, { kind: 'speed', road: ilica, kmh: 70 });
    list = withEdit(list, { kind: 'closeLane', road: ilica, lane: 1 });
    // A closed lane becoming a bus lane.
    list = withEdit(list, { kind: 'busLane', road: ilica, lane: 1 });
    list = withEdit(list, { kind: 'busLane', road: ilica, lane: 0 });
    expect(list.map(describeEdit)).toEqual([
      'Ilica: 70 km/h',
      'Ilica: lane 2 from the right for buses',
      'Ilica: right lane for buses',
    ]);
    expect(describeEdit(edits[3])).toBe('No turn from Ilica onto Savska cesta');
    expect(describeEdit(edits[4])).toBe('Signals: phase 3 green 40 s');
  });

  it('save, load and share', async () => {
    // Saved lists keep positions to 0.1 m and headings to a degree.
    const text = serializeEdits(edits);
    const loaded = parseEdits(text);
    expect(loaded).toHaveLength(edits.length);
    expect(loaded[1]).toEqual({ kind: 'speed', road: { ...ilica, z: 1.6 }, kmh: 30 });
    expect(serializeEdits(loaded)).toBe(text);
    expect(() => parseEdits('{"edits": 3}')).toThrow();
    expect(parseEdits('{"version":1,"edits":[{"kind":"nonsense"},{"kind":"close"}]}')).toEqual([]);

    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
    saveEdits(edits, storage);
    expect(loadSavedEdits(storage)).toHaveLength(edits.length);
    saveEdits([], storage);
    expect(loadSavedEdits(storage)).toEqual([]);

    const encoded = await encodeEditsForUrl(edits);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeEditsFromUrl(encoded)).toEqual(loaded);
  });
});
