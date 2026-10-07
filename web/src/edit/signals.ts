/**
 * Junctions for the signal editor and the roundabout tool (M4e): the movements across a
 * junction, its traffic lights as they run, and the edits that set them.
 */
import type { SignalPrograms } from '../sim/wasm';
import type { RoadNetwork } from '../world/roadNetwork';
import type { JunctionPoint, Movement, SignalEdit, WayRef } from './builder';
import { DIRECTIONS, headingOf } from './roadIndex';

const NONE = 0xffffffff;
/** A road is named by a point this far (m) from the junction, so that it is found again
 * when a road drawn later cuts it further away. */
const REF_DISTANCE = 10;
/** Default length of a phase the editor adds (s). */
export const DEFAULT_PHASE = 20;

const COMPASS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
];
export const compass = (heading: number) => COMPASS[Math.round(heading / 45) % 8];

/** One movement across a junction: the links from one road onto another. */
export interface JunctionMovement {
  from: number;
  to: number;
  links: number[];
  /** SUMO link direction ('s', 'l', 'r', 't', 'L', 'R'). */
  dir: string;
  /** Trams or trains, not road traffic. */
  tracks: boolean;
  label: string;
  /** Where the roads are, for the edit. */
  ref: Movement;
}

export interface JunctionSignals {
  junction: JunctionPoint;
  /** The signal program, if it has traffic lights. */
  tls?: number;
  movements: JunctionMovement[];
  /** Green phases as the lights run now: their length and the movements they let go. */
  phases: { seconds: number; green: number[] }[];
}

/** A point on a road `REF_DISTANCE` m from its end at the junction (`atEnd`) or its start,
 * and its heading there. */
function wayRef(net: RoadNetwork, edge: number, atEnd: boolean): WayRef {
  const shape = net.laneShape;
  const { start, count } = net.lanePoints(net.edgeLaneStart[edge]);
  const pts: [number, number][] = [];
  for (let k = 0; k < count; k++) pts.push([shape[(start + k) * 3], shape[(start + k) * 3 + 1]]);
  if (atEnd) pts.reverse();
  let left = REF_DISTANCE;
  let ref = { x: pts[0][0], z: pts[0][1], heading: 0 };
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k];
    const [vx, vz] = [pts[k + 1][0] - ax, pts[k + 1][1] - az];
    const len = Math.hypot(vx, vz);
    if (left <= len || k + 2 === pts.length) {
      const t = len > 0 ? Math.min(1, left / len) : 0;
      // Heading of travel: against the walk when walking back from the end.
      const heading = atEnd ? headingOf(-vx, -vz) : headingOf(vx, vz);
      ref = { x: ax + vx * t, z: az + vz * t, heading };
      break;
    }
    left -= len;
  }
  const name = net.nameOf(edge);
  return {
    x: Math.round(ref.x * 10) / 10,
    z: Math.round(ref.z * 10) / 10,
    heading: Math.round(ref.heading),
    ...(name ? { name } : {}),
  };
}

/** The names of the roads meeting at junction `j`, for display. */
export function junctionName(net: RoadNetwork, j: number): string {
  const names: string[] = [];
  for (let e = 0; e < net.edgeCount; e++) {
    if (net.isInternal(e) || (net.edgeTo[e] !== j && net.edgeFrom[e] !== j)) continue;
    const name = net.nameOf(e);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names.slice(0, 3).join(' / ') : 'an unnamed junction';
}

/** The junction's movements and its lights as they run (`programs`: the engine's, which
 * may differ from the network's after re-timing; the network's if not given). A junction
 * whose program also controls others (a cluster) is edited with them. */
export function junctionSignals(
  net: RoadNetwork,
  j: number,
  programs?: SignalPrograms,
): JunctionSignals {
  const a = net.arrays;
  const linkJunction = a.linkJunction as Uint32Array;
  const linkTls = a.linkTls as Uint32Array;
  const linkFrom = a.linkFrom as Uint32Array;
  const linkTo = a.linkTo as Uint32Array;
  const linkDir = a.linkDir as Uint8Array;
  const linkTlsIndex = a.linkTlsIndex as Uint16Array;
  const at: number[] = [];
  for (let l = 0; l < linkJunction.length; l++) if (linkJunction[l] === j) at.push(l);
  const tls = at.map((l) => linkTls[l]).find((t) => t !== NONE);
  const links =
    tls === undefined ? at : Array.from(linkTls.keys()).filter((l) => linkTls[l] === tls);

  const groups = new Map<string, JunctionMovement>();
  const tracks = (lane: number) => !net.allows(lane, 'passenger') && !net.allows(lane, 'bus');
  for (const l of links) {
    const [from, to] = [net.laneEdge[linkFrom[l]], net.laneEdge[linkTo[l]]];
    const key = `${from}>${to}`;
    const group = groups.get(key);
    if (group) {
      group.links.push(l);
      continue;
    }
    const dir = net.index.linkDirs[linkDir[l]] ?? 's';
    const fromRef = wayRef(net, from, true);
    const toRef = wayRef(net, to, false);
    const onTracks = tracks(linkFrom[l]);
    // Tram tracks are mostly unnamed: they are called what they are.
    const what = (ref: WayRef, unnamed: string) =>
      onTracks ? `tram tracks${ref.name ? ` on ${ref.name}` : ''}` : (ref.name ?? unnamed);
    const source = what(fromRef, 'Unnamed road');
    const turn = DIRECTIONS[dir] ?? 'straight on';
    const label =
      `${source[0].toUpperCase()}${source.slice(1)} from the ${compass((fromRef.heading + 180) % 360)}: ` +
      `${turn}${dir === 's' ? '' : ` onto ${what(toRef, 'an unnamed road')}`}`;
    groups.set(key, {
      from,
      to,
      links: [l],
      dir,
      tracks: onTracks,
      label,
      ref: { from: fromRef, to: toRef },
    });
  }
  // By approach, clockwise from the north, then right, straight on, left.
  const order = ['r', 'R', 's', 'L', 'l', 't'];
  const movements = [...groups.values()].sort(
    (x, y) =>
      ((x.ref.from.heading + 180) % 360) - ((y.ref.from.heading + 180) % 360) ||
      x.from - y.from ||
      order.indexOf(x.dir) - order.indexOf(y.dir),
  );

  const phases: JunctionSignals['phases'] = [];
  if (tls !== undefined) {
    const offsets = programs?.phaseOffsets ?? (a.tlsPhaseOffsets as Uint32Array);
    const duration = programs?.duration ?? (a.phaseDuration as Float32Array);
    const stateOffsets = programs?.stateOffsets ?? (a.phaseStateOffsets as Uint32Array);
    const states = programs?.states ?? (a.phaseStates as Uint8Array);
    if (tls + 1 < offsets.length) {
      for (let p = offsets[tls]; p < offsets[tls + 1]; p++) {
        const s = String.fromCharCode(...states.subarray(stateOffsets[p], stateOffsets[p + 1]));
        if (/[yY]/.test(s)) continue;
        const green = movements
          .map((m, k) => (m.links.some((l) => /[Gg]/.test(s[linkTlsIndex[l]] ?? '')) ? k : -1))
          .filter((k) => k >= 0);
        if (green.length) phases.push({ seconds: Math.round(duration[p]), green });
      }
    }
  }
  const pos = net.junctionPos;
  return {
    junction: { x: pos[j * 2], z: pos[j * 2 + 1], name: junctionName(net, j) },
    ...(tls !== undefined ? { tls } : {}),
    movements,
    phases,
  };
}

/** Phases for a junction getting traffic lights: approaches from opposite directions go
 * together (turning left on a permissive green), the others one after another. */
export function defaultPhases(movements: readonly JunctionMovement[]): SignalEdit['phases'] {
  const approaches = new Map<number, { heading: number; moves: number[] }>();
  movements.forEach((m, k) => {
    const a = approaches.get(m.from) ?? { heading: m.ref.from.heading, moves: [] };
    a.moves.push(k);
    approaches.set(m.from, a);
  });
  const list = [...approaches.values()];
  const used = new Set<number>();
  const phases: SignalEdit['phases'] = [];
  list.forEach((a, i) => {
    if (used.has(i)) return;
    used.add(i);
    const green = [...a.moves];
    const opposite = list.findIndex(
      (b, k) => !used.has(k) && Math.abs(((a.heading - b.heading + 540) % 360) - 180) > 135,
    );
    if (opposite >= 0) {
      used.add(opposite);
      green.push(...list[opposite].moves);
    }
    phases.push({ seconds: DEFAULT_PHASE, green });
  });
  return phases;
}

/** The edit setting a junction's lights to `phases` (none: no lights). */
export function signalEdit(signals: JunctionSignals, phases: SignalEdit['phases']): SignalEdit {
  return {
    kind: 'signal',
    junction: signals.junction,
    movements: signals.movements.map((m) => m.ref),
    phases: phases.map((p) => ({ seconds: p.seconds, green: [...p.green].sort((x, y) => x - y) })),
  };
}
