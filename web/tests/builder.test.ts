import { describe, expect, it } from 'vitest';

import {
  type NetworkEdit,
  type RoadEdit,
  type RoundaboutEdit,
  buildNetwork,
  lanePieces,
} from '../src/edit/builder';
import { RoadIndex } from '../src/edit/roadIndex';
import { defaultPhases, junctionSignals, signalEdit } from '../src/edit/signals';
import { RoadNetwork } from '../src/world/roadNetwork';
import { NetMaker } from './fixtures';

const NONE = 0xffffffff;

/**
 * Ilica runs west-east through junction C (0, 0), one lane each way; Ulica runs west-east
 * 200 m south of it, from S1 to S2. `signals`: C has traffic lights (east-west green).
 */
function town(signals = false) {
  const m = new NetMaker();
  const w = m.junction(-200, 0);
  const c = m.junction(0, 0);
  const e = m.junction(200, 0);
  const s1 = m.junction(-150, 200);
  const s2 = m.junction(150, 200);
  const we = m.road(w, c, 1, 'Ilica');
  const ce = m.road(c, e, 1, 'Ilica');
  const ec = m.road(e, c, 1, 'Ilica');
  const cw = m.road(c, w, 1, 'Ilica');
  const s12 = m.road(s1, s2, 1, 'Ulica', 2);
  const s21 = m.road(s2, s1, 1, 'Ulica', 2);
  const east = m.connect(m.lane(we, 0), m.lane(ce, 0), c, 's');
  const west = m.connect(m.lane(ec, 0), m.lane(cw, 0), c, 's');
  if (signals)
    m.signals.push({
      links: [east, west],
      phases: [
        [30, 'GG'],
        [3, 'yy'],
      ],
    });
  const net = m.network();
  return { net, ids: { w, c, e, s1, s2, we, ce, ec, cw, s12, s21 } };
}

const ROAD: RoadEdit = {
  kind: 'road',
  points: [
    { x: 1, z: 3 },
    { x: 0, z: 100 },
    { x: 2, z: 197 },
  ],
  type: 'residential',
  lanes: 1,
  oneway: false,
  kmh: 30,
  bridge: false,
};

function rebuilt(net: RoadNetwork, roads: NetworkEdit[]) {
  const built = buildNetwork(net, roads, new RoadIndex(net));
  const next = new RoadNetwork({ ...net.index, types: built.types }, built.arrays, {
    lane: built.laneShape,
    junction: built.junctionShape,
  });
  return { built, next };
}

/** What the engine checks when it loads a network (sim/src/network.rs), and more. */
function expectConsistent(net: RoadNetwork) {
  const a = net.arrays as unknown as Record<string, Uint32Array>;
  const lanes = net.laneCount;
  expect(a.laneLinkOffsets.length).toBe(lanes + 1);
  expect(a.laneShapeOffsets.length).toBe(lanes + 1);
  expect(a.laneShapeOffsets[lanes] * 3).toBe(net.laneShape.length);
  for (const name of ['laneEdge', 'laneLength', 'laneSpeed', 'laneAllow', 'laneNext']) {
    expect(a[name].length, name).toBe(lanes);
  }
  for (let e = 0; e < net.edgeCount; e++) {
    for (let k = 0; k < net.edgeLaneCount[e]; k++) {
      expect(net.laneEdge[net.edgeLaneStart[e] + k]).toBe(e);
    }
  }
  const links = a.linkFrom.length;
  for (const name of ['linkTo', 'linkVia', 'linkJunction', 'linkRequest', 'linkDir', 'linkState']) {
    expect(a[name].length, name).toBe(links);
  }
  const seen = new Set<string>();
  for (let l = 0; l < links; l++) {
    const from = a.linkFrom[l];
    if (l > 0) expect(from).toBeGreaterThanOrEqual(a.linkFrom[l - 1]);
    expect(l).toBeGreaterThanOrEqual(a.laneLinkOffsets[from]);
    expect(l).toBeLessThan(a.laneLinkOffsets[from + 1]);
    const via = a.linkVia[l];
    expect(net.isInternal(net.laneEdge[via])).toBe(true);
    expect(a.laneNext[via]).toBe(a.linkTo[l]);
    const j = a.linkJunction[l];
    expect(a.linkRequest[l]).toBeLessThan(a.junctionLinkCount[j]);
    const key = `${j}:${a.linkRequest[l]}`;
    expect(seen.has(key), `request ${key} once`).toBe(false);
    seen.add(key);
    const words = Math.max(1, Math.ceil(a.junctionLinkCount[j] / 32));
    expect(a.junctionLogicOffset[j] + a.junctionLinkCount[j] * 2 * words).toBeLessThanOrEqual(
      a.logic.length,
    );
    const t = a.linkTls[l];
    if (t !== NONE) {
      for (let p = a.tlsPhaseOffsets[t]; p < a.tlsPhaseOffsets[t + 1]; p++) {
        const len = a.phaseStateOffsets[p + 1] - a.phaseStateOffsets[p];
        expect(a.linkTlsIndex[l]).toBeLessThan(len);
      }
    }
  }
}

/** Links of a network at a junction as (from edge, to edge, direction, state). */
function linksAt(net: RoadNetwork, j: number) {
  const a = net.arrays as unknown as Record<string, Uint32Array>;
  const out: [number, number, string, string][] = [];
  for (let l = 0; l < a.linkFrom.length; l++) {
    if (a.linkJunction[l] !== j) continue;
    out.push([
      net.laneEdge[a.linkFrom[l]],
      net.laneEdge[a.linkTo[l]],
      net.index.linkDirs[a.linkDir[l]],
      net.index.linkStates[a.linkState[l]],
    ]);
  }
  return out;
}

describe('the junction builder', () => {
  it('joins a drawn road to a junction and cuts the road it ends on', () => {
    const { net, ids } = town();
    const { built, next } = rebuilt(net, [ROAD]);
    expect(built.problems).toEqual([]);
    expect(built.roads[0]).toHaveLength(2);
    expectConsistent(next);
    // Everything loaded keeps its id.
    expect(next.edgeFrom.subarray(0, net.edgeCount)).toEqual(net.edgeFrom);
    expect(next.junctionCount).toBe(net.junctionCount + 1);
    // Ulica is cut at a new junction J: its first parts end there, its second parts are new.
    const j = net.junctionCount;
    expect(next.edgeTo[ids.s12]).toBe(j);
    expect(next.edgeTo[ids.s21]).toBe(j);
    const [south, north] = built.roads[0];
    expect(next.edgeTo[south]).toBe(j);
    expect(next.edgeFrom[north]).toBe(j);
    // At C: Ilica's ways in turn into the new road (the right turn crosses nothing, the left
    // gives way to oncoming traffic), the new road gives way turning onto Ilica.
    const atC = linksAt(next, ids.c);
    expect(atC).toContainEqual([ids.we, south, 'r', 'M']);
    expect(atC).toContainEqual([ids.ec, south, 'l', 'm']);
    expect(atC).toContainEqual([north, ids.ce, 'r', 'm']);
    expect(atC).toContainEqual([north, ids.cw, 'l', 'm']);
    // Straight on along Ilica keeps priority.
    expect(atC).toContainEqual([ids.we, ids.ce, 's', 'M']);
    // At J, Ulica goes straight on into its second parts and turns onto the new road.
    const atJ = linksAt(next, j);
    const ulicaOn = atJ.filter(([f, t]) => f === ids.s12 && next.edgeFrom[t] === j && t !== north);
    expect(ulicaOn).toHaveLength(1);
    expect(atJ.some(([f, t]) => f === ids.s12 && t === north)).toBe(true);
    expect(atJ.some(([f, , , s]) => f === south && s === 'm')).toBe(true);
    // The lanes of Ulica's first part lie on the lane as loaded, the rest beyond the cut.
    const lane = net.edgeLaneStart[ids.s12];
    const first = built.origins.get(lane)!;
    expect(first).toMatchObject({ key: `b${lane}`, start: 0 });
    expect(first.end).toBeCloseTo(next.laneLength[lane], 3);
    const second = next.edgeLaneStart[ulicaOn[0][1]];
    expect(built.origins.get(second)!.key).toBe(`b${lane}`);
    expect(built.origins.get(second)!.start).toBeGreaterThan(first.end);
  });

  it('says where every lane went, from build to build, both ways', () => {
    const { net, ids } = town();
    const { built } = rebuilt(net, [ROAD]);
    const length = (l: number) => net.laneLength[l];
    const lane = net.edgeLaneStart[ids.s12];
    // Adding the road: Ulica's lane goes on as its second part past the cut.
    const added = lanePieces(new Map(), built.origins, length);
    const pieces = added.filter((p) => p.old === lane).sort((x, y) => x.from - y.from);
    expect(pieces[0]).toMatchObject({ from: 0, lane, shift: 0 });
    const last = pieces[pieces.length - 1];
    expect(last.lane).toBeGreaterThanOrEqual(net.laneCount);
    expect(last.from + last.shift).toBeCloseTo(0, 3);
    // Taking it away again: the new road's lanes go nowhere, the second part goes back.
    const removed = lanePieces(built.origins, new Map(), length);
    for (const e of built.roads[0]) {
      const l = built.arrays.edgeLaneStart[e];
      expect(removed).toContainEqual({ old: l, from: 0, lane: NONE, shift: 0 });
    }
    const back = removed.find((p) => p.old === last.lane)!;
    expect(back.lane).toBe(lane);
    expect(back.shift).toBeCloseTo(-last.shift, 3);
    // The same roads again: every lane stays where it is.
    const same = lanePieces(built.origins, built.origins, length);
    expect(same.every((p) => p.old === p.lane && p.shift === 0 && p.from === 0)).toBe(true);
  });

  it('gives a new approach to traffic lights a green phase of its own', () => {
    const { net, ids } = town(true);
    const { next } = rebuilt(net, [ROAD]);
    expectConsistent(next);
    const a = next.arrays as unknown as Record<string, Uint32Array>;
    const phases = Array.from({ length: a.tlsPhaseOffsets[1] }, (_, p) =>
      String.fromCharCode(
        ...a.phaseStates.subarray(a.phaseStateOffsets[p], a.phaseStateOffsets[p + 1]),
      ),
    );
    // Two links loaded, four added; the program gains a green and a yellow for the new road.
    expect(phases).toHaveLength(4);
    expect(phases.every((s) => s.length === 6)).toBe(true);
    const tlsIndex = (from: number, to: number) => {
      for (let l = 0; l < a.linkFrom.length; l++) {
        if (next.laneEdge[a.linkFrom[l]] === from && next.laneEdge[a.linkTo[l]] === to) {
          return a.linkTlsIndex[l];
        }
      }
      return -1;
    };
    const { built } = rebuilt(net, [ROAD]);
    const [south, north] = built.roads[0];
    // Turning from Ilica into the new road goes with Ilica's green, giving way when it
    // crosses the other way's straight on; the new road has its own green.
    expect(phases[0][tlsIndex(ids.we, south)]).toBe('G');
    expect(phases[0][tlsIndex(ids.ec, south)]).toBe('g');
    expect(phases[0][tlsIndex(north, ids.ce)]).toBe('r');
    expect(phases[2][tlsIndex(north, ids.ce)]).toBe('G');
    expect(phases[2][tlsIndex(ids.we, ids.ce)]).toBe('r');
    expect(phases[3][tlsIndex(north, ids.cw)]).toBe('y');
  });

  it('builds nothing for a road that ends nowhere, and says why', () => {
    const { net } = town();
    const nowhere = { ...ROAD, points: [ROAD.points[0], { x: 0, z: -400 }] };
    const { built, next } = rebuilt(net, [nowhere]);
    expect(built.problems).toEqual([
      { road: 0, reason: 'Start and end the road on a road or at a junction.' },
    ]);
    expect(next.edgeCount).toBe(net.edgeCount);
  });
});

/**
 * Ilica (east-west) crosses Savska cesta (north-south) at C (0, 0): two-way roads 200 m
 * long, one lane each way; straight on both ways, and left from Ilica. Savska cesta gives
 * way to Ilica, left turns to oncoming traffic. `signals`: lights, Ilica then Savska cesta.
 */
function crossroads(signals = false) {
  const m = new NetMaker();
  const c = m.junction(0, 0);
  const [w, e, n, s] = [
    m.junction(-200, 0),
    m.junction(200, 0),
    m.junction(0, -200),
    m.junction(0, 200),
  ];
  const ids = {
    c,
    we: m.road(w, c, 1, 'Ilica'),
    ce: m.road(c, e, 1, 'Ilica'),
    ec: m.road(e, c, 1, 'Ilica'),
    cw: m.road(c, w, 1, 'Ilica'),
    sn: m.road(s, c, 1, 'Savska cesta', 2),
    cn: m.road(c, n, 1, 'Savska cesta', 2),
    ns: m.road(n, c, 1, 'Savska cesta', 2),
    cs: m.road(c, s, 1, 'Savska cesta', 2),
  };
  const lane = (x: number) => m.lane(x, 0);
  const links = [
    m.connect(lane(ids.we), lane(ids.ce), c, 's'),
    m.connect(lane(ids.ec), lane(ids.cw), c, 's'),
    m.connect(lane(ids.sn), lane(ids.cn), c, 's', 'm'),
    m.connect(lane(ids.ns), lane(ids.cs), c, 's', 'm'),
    m.connect(lane(ids.we), lane(ids.cn), c, 'l', 'm'),
    m.connect(lane(ids.ec), lane(ids.cs), c, 'l', 'm'),
  ];
  // (response, foes) as links were made, in requests (by the lane they leave): Ilica
  // west 0 and its left 1, Ilica east 2 and its left 3, Savska cesta north 4, south 5.
  m.logic.set(c, [
    [0, 0b111000],
    [0, 0b110010],
    [0b001111, 0b001111],
    [0b001111, 0b001111],
    [0b000100, 0b110100],
    [0b000001, 0b110001],
  ]);
  if (signals) {
    m.signals.push({
      links,
      phases: [
        [25, 'GGrrgg'],
        [3, 'yyrryy'],
        [20, 'rrGGrr'],
        [3, 'rryyrr'],
      ],
    });
  }
  return { net: m.network(), ids };
}

/** A signal program's phases as (state of each movement by from and to edge, seconds). */
function program(net: RoadNetwork, t: number) {
  const a = net.arrays as unknown as Record<string, Uint32Array>;
  const durations = net.arrays.phaseDuration as Float32Array;
  return Array.from({ length: a.tlsPhaseOffsets[t + 1] - a.tlsPhaseOffsets[t] }, (_, k) => {
    const p = a.tlsPhaseOffsets[t] + k;
    const states = String.fromCharCode(
      ...a.phaseStates.subarray(a.phaseStateOffsets[p], a.phaseStateOffsets[p + 1]),
    );
    const of = (from: number, to: number) => {
      for (let l = 0; l < a.linkFrom.length; l++) {
        if (a.linkTls[l] !== t) continue;
        if (net.laneEdge[a.linkFrom[l]] === from && net.laneEdge[a.linkTo[l]] === to) {
          return states[a.linkTlsIndex[l]];
        }
      }
      return undefined;
    };
    return { of, seconds: durations[p] };
  });
}

describe('junctions changed', () => {
  const C = { x: 0, z: 0, name: 'Ilica / Savska cesta' };

  it('makes a crossroads a roundabout', () => {
    const { net, ids } = crossroads();
    const edit: RoundaboutEdit = { kind: 'roundabout', junction: C, lanes: 1 };
    const { built, next } = rebuilt(net, [edit]);
    expect(built.problems).toEqual([]);
    expectConsistent(next);
    const ring = built.roads[0];
    expect(ring).toHaveLength(4);
    for (const e of ring) expect(next.edgeFlags[e] & net.index.flags.roundabout).not.toBe(0);
    // Nothing crosses C any more: each road ends or starts at a junction on the ring.
    expect(linksAt(next, ids.c)).toEqual([]);
    const nodes = new Set(ring.map((e) => next.edgeFrom[e]));
    expect(nodes.size).toBe(4);
    for (const e of [ids.we, ids.ec, ids.sn, ids.ns]) expect(nodes.has(next.edgeTo[e])).toBe(true);
    for (const e of [ids.ce, ids.cw, ids.cn, ids.cs]) {
      expect(nodes.has(next.edgeFrom[e])).toBe(true);
    }
    // Anticlockwise: from the east to the north.
    const pos = (j: number) => [next.junctionPos[j * 2], next.junctionPos[j * 2 + 1]];
    const east = [...nodes].find((j) => pos(j)[0] > 5)!;
    const fromEast = ring.find((e) => next.edgeFrom[e] === east)!;
    expect(pos(next.edgeTo[fromEast])[1]).toBeLessThan(-5);
    // At the east: Ilica westbound comes on giving way; round, and off onto Ilica eastbound.
    const intoEast = ring.find((e) => next.edgeTo[e] === east)!;
    const at = linksAt(next, east);
    expect(at).toContainEqual([ids.ec, fromEast, 'r', 'm']);
    expect(at).toContainEqual([intoEast, fromEast, 's', 'M']);
    expect(at).toContainEqual([intoEast, ids.ce, 'r', 'M']);
    expect(at).toHaveLength(3);
    // The roads end and start clear of the ring, and the engine is told where they went.
    const into = next.edgeLaneStart[ids.we];
    const out = next.edgeLaneStart[ids.ce];
    expect(next.laneLength[into]).toBeLessThan(net.laneLength[into] - 5);
    expect(built.origins.get(into)).toMatchObject({ key: `b${into}`, start: 0 });
    const pieces = lanePieces(new Map(), built.origins, (l) => net.laneLength[l]);
    expect(pieces).toContainEqual({ old: into, from: 0, lane: into, shift: 0 });
    const outPiece = pieces.find((p) => p.old === out)!;
    expect(outPiece.lane).toBe(out);
    expect(outPiece.shift).toBeLessThan(-5);
    // The lanes across C go, with whatever is on them.
    for (let l = 0; l < net.laneCount; l++) {
      if (net.isInternal(net.laneEdge[l])) {
        expect(pieces).toContainEqual({ old: l, from: 0, lane: NONE, shift: 0 });
      }
    }
    // Undone: back to the lanes as loaded.
    const back = lanePieces(built.origins, new Map(), (l) => net.laneLength[l]);
    expect(back.find((p) => p.old === out)).toMatchObject({ lane: out, from: 0 });
    const ringLane = built.arrays.edgeLaneStart[ring[0]];
    expect(back).toContainEqual({ old: ringLane, from: 0, lane: NONE, shift: 0 });
  });

  it('keeps turns waiting inside junctions it leaves alone, not inside those it changes', () => {
    const { net, ids } = crossroads();
    const arrays = net.arrays as unknown as Record<string, Uint32Array>;
    // A turn waiting inside C, and one inside the junction east of it.
    const inside = (j: number) => {
      for (let l = 0; l < net.laneCount; l++) {
        const e = net.laneEdge[l];
        if (net.isInternal(e) && net.edgeFrom[e] === j) return l;
      }
      return -1;
    };
    const atC = inside(ids.c);
    const east = net.edgeTo[ids.ce];
    const atEast = inside(east);
    expect(atC).toBeGreaterThanOrEqual(0);
    arrays.waitLane = Uint32Array.of(atC, ...(atEast >= 0 ? [atEast] : []));
    arrays.waitFoeOffsets = Uint32Array.of(0, 1, ...(atEast >= 0 ? [2] : []));
    arrays.waitFoes = Uint32Array.of(atC, ...(atEast >= 0 ? [atEast] : []));
    const { built } = rebuilt(net, [{ kind: 'roundabout', junction: C, lanes: 1 }]);
    const kept = Array.from(built.arrays.waitLane as Uint32Array);
    expect(kept).not.toContain(atC);
    if (atEast >= 0) expect(kept).toEqual([atEast]);
    expect((built.arrays.waitFoeOffsets as Uint32Array).length).toBe(kept.length + 1);
  });

  it('needs three roads for a roundabout', () => {
    const { net } = town();
    const { built, next } = rebuilt(net, [{ kind: 'roundabout', junction: C, lanes: 2 }]);
    expect(built.problems).toEqual([
      { road: 0, reason: 'A roundabout needs at least three roads meeting.' },
    ]);
    expect(next.edgeCount).toBe(net.edgeCount);
  });

  it('puts traffic lights on a junction, opposite approaches together', () => {
    const { net, ids } = crossroads();
    const signals = junctionSignals(net, ids.c);
    expect(signals.tls).toBeUndefined();
    expect(signals.movements.map((m) => m.label)).toContain(
      'Ilica from the west: left onto Savska cesta',
    );
    const phases = defaultPhases(signals.movements);
    expect(phases).toHaveLength(2);
    const { built, next } = rebuilt(net, [signalEdit(signals, phases)]);
    expect(built.problems).toEqual([]);
    expectConsistent(next);
    expect(next.arrays.tlsFixed).toEqual(Uint8Array.from([1]));
    expect(next.index.junctionTypes[next.junctionType[ids.c]]).toBe('traffic_light');
    const p = program(next, 0);
    expect(p.map((x) => x.seconds)).toEqual([20, 3, 20, 3]);
    const ilicaFirst = p[0].of(ids.we, ids.ce) === 'G';
    const [ilica, savska] = ilicaFirst ? [p[0], p[2]] : [p[2], p[0]];
    // Turning left on a permissive green, giving way to oncoming traffic.
    expect([ilica.of(ids.we, ids.ce), ilica.of(ids.we, ids.cn), ilica.of(ids.sn, ids.cn)]).toEqual([
      'G',
      'g',
      'r',
    ]);
    expect([
      savska.of(ids.sn, ids.cn),
      savska.of(ids.ns, ids.cs),
      savska.of(ids.ec, ids.cw),
    ]).toEqual(['G', 'G', 'r']);
    expect(p[1].of(ids.we, ids.cn)).toBe(ilicaFirst ? 'y' : 'r');
  });

  it('closes movements never green, and changes lights already there', () => {
    const { net, ids } = crossroads(true);
    const signals = junctionSignals(net, ids.c);
    expect(signals.tls).toBe(0);
    expect(signals.phases.map((x) => x.seconds)).toEqual([25, 20]);
    // Ilica's green longer, and no left turns.
    const lefts = signals.movements.flatMap((m, k) => (m.dir === 'l' ? [k] : []));
    const phases = signals.phases.map((x, k) => ({
      seconds: k === 0 ? 40 : x.seconds,
      green: x.green.filter((g) => !lefts.includes(g)),
    }));
    const { built, next } = rebuilt(net, [signalEdit(signals, phases)]);
    expect(built.problems).toEqual([]);
    expectConsistent(next);
    expect(next.arrays.tlsFixed).toEqual(Uint8Array.from([1]));
    const p = program(next, 0);
    expect(p.map((x) => x.seconds)).toEqual([40, 3, 20, 3]);
    expect(p[0].of(ids.we, ids.ce)).toBe('G');
    expect(linksAt(next, ids.c).some(([f, t]) => f === ids.we && t === ids.cn)).toBe(false);
    expect(linksAt(next, ids.c)).toHaveLength(4);
  });

  it('takes traffic lights away: right of way rules', () => {
    const { net, ids } = crossroads(true);
    const signals = junctionSignals(net, ids.c);
    const { built, next } = rebuilt(net, [signalEdit(signals, [])]);
    expect(built.problems).toEqual([]);
    expectConsistent(next);
    const a = next.arrays as unknown as Record<string, Uint32Array>;
    expect(Array.from(a.linkTls).every((t) => t === NONE)).toBe(true);
    const at = linksAt(next, ids.c);
    expect(at).toContainEqual([ids.we, ids.ce, 's', 'M']);
    expect(at).toContainEqual([ids.sn, ids.cn, 's', 'm']);
    expect(at).toContainEqual([ids.ec, ids.cs, 'l', 'm']);
  });
});
