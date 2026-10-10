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
import { junction } from './fixtures';

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
    // Built into the network, not matched here.
    { kind: 'roundabout', junction: { x: 100.04, z: 0, name: 'Ilica / Savska cesta' }, lanes: 2 },
    {
      kind: 'signal',
      junction: { x: 100, z: 0, name: 'Ilica / Savska cesta' },
      movements: [{ from: ilica, to: savska }],
      phases: [
        { seconds: 30, green: [0] },
        { seconds: 20, green: [] },
      ],
    },
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
    expect(describeEdit(edits[6])).toBe('Roundabout at Ilica / Savska cesta, 2 lanes');
    expect(describeEdit(edits[7])).toBe(
      'Traffic lights at Ilica / Savska cesta: 2 phases, about 56 s cycle',
    );
    // A junction is a roundabout or has lights set, not both: the later edit stays.
    expect(withEdit([edits[6]], edits[7])).toEqual([edits[7]]);
    expect(describeEdit({ ...(edits[7] as Extract<Edit, { kind: 'signal' }>), phases: [] })).toBe(
      'No traffic lights at Ilica / Savska cesta',
    );
  });

  const transit = (route: (line: string, mode: string) => number | undefined) => ({
    route,
    newRoute: () => 200,
    stopRoads: () => index,
  });

  it('run public transport lines more or less often', () => {
    const tram6: Edit = { kind: 'frequency', line: '6', mode: 'tram', factor: 2 };
    const lines = transit((line, mode) => (line === '6' && mode === 'tram' ? 11 : undefined));
    const { resolved, missing } = resolveEdits(index, [tram6, { ...tram6, line: '99' }], lines);
    expect(missing).toHaveLength(1);
    expect(resolved[0].edges).toEqual([]);
    const words = editWords(resolved);
    expect(Array.from(words.slice(0, 3))).toEqual([7, 11, 0]);
    expect(new Float32Array(words.buffer)[3]).toBe(2);
    // Without the timetable loaded, none match.
    expect(resolveEdits(index, [tram6]).missing).toEqual([tram6]);
    expect(describeEdit(tram6)).toBe('Tram 6: twice as often');
    expect(describeEdit({ ...tram6, mode: 'bus', line: '109', factor: 0 })).toBe(
      'Bus 109: not running',
    );
    // One edit a line: the later replaces the earlier.
    expect(withEdit([tram6], { ...tram6, factor: 0.5 })).toEqual([{ ...tram6, factor: 0.5 }]);
    expect(withEdit([tram6], { ...tram6, mode: 'bus' })).toHaveLength(2);
    // Saved and read back; trains and factors the panel does not offer are not read.
    expect(parseEdits(serializeEdits([tram6]))).toEqual([tram6]);
    expect(
      parseEdits(
        serializeEdits([
          { ...tram6, mode: 'train' },
          { ...tram6, factor: 7 },
        ]),
      ),
    ).toEqual([]);
  });

  it('add new lines, their stops on the roads they run along', () => {
    const line: Edit = {
      kind: 'line',
      name: '400',
      mode: 'bus',
      stops: [
        { x: 30, z: 0.4, name: 'Ilica' },
        { x: 150, z: 0, name: 'Ilica' },
        { x: 900, z: 900, name: 'Nowhere' },
      ],
      both: false,
      headway: 600,
      first: 5 * 3600,
      last: 23 * 3600,
    };
    const { resolved } = resolveEdits(
      index,
      [line],
      transit(() => undefined),
    );
    const words = editWords(resolved);
    const floats = new Float32Array(words.buffer);
    // A line record, its hours, then the two stops on a road (the third has none near).
    expect(Array.from(words.slice(0, 3))).toEqual([8, 200, 2 | (2 << 8)]);
    expect(floats[3]).toBe(600);
    expect([words[4], floats[5], floats[6]]).toEqual([9, 5 * 3600, 23 * 3600]);
    expect(Array.from(words.slice(8, 11))).toEqual([10, 0, 0]);
    expect(floats[11]).toBeCloseTo(25 / 90, 2);
    expect(Array.from(words.slice(12, 15))).toEqual([10, 1, 0]);
    expect(floats[15]).toBeCloseTo(45 / 90, 2);
    expect(words.length).toBe(16);
    expect(resolved[0].ways).toEqual([line.stops.slice(0, 2)]);
    // Both ways: the stops again in reverse.
    const both = resolveEdits(
      index,
      [{ ...line, both: true }],
      transit(() => undefined),
    );
    expect(both.resolved[0].ways?.[1].map((s) => s.x)).toEqual([150, 30]);
    expect(describeEdit({ ...line, both: true })).toBe(
      'New bus line 400, Ilica - Nowhere and back, every 10 min',
    );
    // One line by name and mode; kept and read back.
    expect(withEdit([line], { ...line, headway: 300 })).toHaveLength(1);
    expect(parseEdits(serializeEdits([line]))).toEqual([line]);
    expect(parseEdits(serializeEdits([{ ...line, headway: 30 }]))).toEqual([]);
    expect(parseEdits(serializeEdits([{ ...line, stops: line.stops.slice(0, 1) }]))).toEqual([]);
  });

  it('save, load and share', async () => {
    // Saved lists keep positions to 0.1 m and headings to a degree.
    const text = serializeEdits(edits);
    const loaded = parseEdits(text);
    expect(loaded).toHaveLength(edits.length);
    expect(loaded[1]).toEqual({ kind: 'speed', road: { ...ilica, z: 1.6 }, kmh: 30 });
    expect(serializeEdits(loaded)).toBe(text);
    expect(loaded[6]).toEqual({
      ...edits[6],
      junction: { ...(edits[6] as { junction: object }).junction, x: 100 },
    });
    expect(loaded[7]).toEqual({
      ...edits[7],
      movements: [{ from: { ...ilica, z: 1.6 }, to: { ...savska, x: 101.6 } }],
    });
    expect(() => parseEdits('{"edits": 3}')).toThrow();
    // Lights naming a movement they do not list are not read.
    const bad = { ...edits[7], phases: [{ seconds: 30, green: [3] }] };
    expect(parseEdits(JSON.stringify({ version: 1, edits: [bad] }))).toEqual([]);
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
