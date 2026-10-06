import { describe, expect, it } from 'vitest';

import { type RoadEdit, buildNetwork, lanePieces } from '../src/edit/builder';
import { RoadIndex } from '../src/edit/roadIndex';
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

function rebuilt(net: RoadNetwork, roads: RoadEdit[]) {
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
