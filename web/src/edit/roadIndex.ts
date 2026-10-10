import type { JunctionRef, RoadRef } from './edits';
import type { RoadNetwork } from '../world/roadNetwork';

/** Grid cell size (m). */
const CELL = 100;
/** A saved road matches an edge passing this close (m) to its point... */
const FIND_DISTANCE = 12;
/** ...heading within this many degrees of it. */
const FIND_HEADING = 35;
/** A saved junction matches signals this close (m). */
const FIND_SIGNAL = 25;
const NONE = 0xffffffff;

/** Turn directions by SUMO's link direction codes (the network index's `linkDirs`). */
export const DIRECTIONS: Record<string, string> = {
  s: 'straight on',
  l: 'left',
  r: 'right',
  t: 'U-turn',
  L: 'half left',
  R: 'half right',
};

/** One way on from a road at the junction it leads to. */
export interface Turn {
  to: number;
  /** "straight on", "left", "right", "U-turn", "half left" or "half right". */
  direction: string;
  name?: string;
  /** Signal program controlling the turn, if any. */
  tls?: number;
}

/** Heading (degrees clockwise from north) of a step (dx, dz) in scene coordinates. */
export function headingOf(dx: number, dz: number): number {
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
}

export function angleBetween(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Roads the player can edit (edges that cars or buses use, not junction-internal lanes),
 * indexed by where their rightmost lane runs, plus the turns and signals between them.
 */
export class RoadIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly cols: number;
  private readonly minX: number;
  private readonly minZ: number;
  /** Signal program of each junction (NONE if it has none). */
  private readonly junctionTls: Uint32Array;
  /** Edges each signal program controls turns from. */
  private readonly tlsEdges = new Map<number, number[]>();

  /** `include`: the edges to index (default: those the player can edit). */
  constructor(
    readonly net: RoadNetwork,
    include?: (edge: number) => boolean,
  ) {
    const keep = include ?? ((e: number) => this.editable(e));
    const shape = net.laneShape;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    for (let p = 0; p < shape.length; p += 3) {
      minX = Math.min(minX, shape[p]);
      maxX = Math.max(maxX, shape[p]);
      minZ = Math.min(minZ, shape[p + 1]);
    }
    this.minX = minX;
    this.minZ = minZ;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
    for (let e = 0; e < net.edgeCount; e++) {
      if (!keep(e)) continue;
      const { start, count } = net.lanePoints(net.edgeLaneStart[e]);
      const seen = new Set<number>();
      for (let k = 0; k + 1 < count; k++) {
        const [ax, az] = [shape[(start + k) * 3], shape[(start + k) * 3 + 1]];
        const [bx, bz] = [shape[(start + k + 1) * 3], shape[(start + k + 1) * 3 + 1]];
        for (const key of this.cellsAlong(ax, az, bx, bz)) {
          if (seen.has(key)) continue;
          seen.add(key);
          const list = this.cells.get(key);
          if (list) list.push(e);
          else this.cells.set(key, [e]);
        }
      }
    }

    const a = net.arrays;
    const linkJunction = a.linkJunction as Uint32Array;
    const linkTls = a.linkTls as Uint32Array;
    const linkFrom = a.linkFrom as Uint32Array;
    this.junctionTls = new Uint32Array(net.junctionCount).fill(NONE);
    for (let l = 0; l < linkTls.length; l++) {
      const t = linkTls[l];
      if (t === NONE) continue;
      const j = linkJunction[l];
      if (j !== NONE && this.junctionTls[j] === NONE) this.junctionTls[j] = t;
      const from = net.laneEdge[linkFrom[l]];
      const list = this.tlsEdges.get(t);
      if (!list) this.tlsEdges.set(t, [from]);
      else if (!list.includes(from)) list.push(from);
    }
  }

  /** Whether the player can edit an edge: a road (not inside a junction) for cars or buses. */
  editable(edge: number): boolean {
    const net = this.net;
    if (edge < 0 || edge >= net.edgeCount || net.isInternal(edge)) return false;
    const lane = net.edgeLaneStart[edge];
    for (let k = 0; k < net.edgeLaneCount[edge]; k++) {
      if (net.allows(lane + k, 'passenger') || net.allows(lane + k, 'bus')) return true;
    }
    return false;
  }

  private cellKey(cx: number, cz: number): number {
    return cz * this.cols + cx;
  }

  private *cellsAlong(ax: number, az: number, bx: number, bz: number): Generator<number> {
    const x0 = Math.floor((Math.min(ax, bx) - this.minX) / CELL);
    const x1 = Math.floor((Math.max(ax, bx) - this.minX) / CELL);
    const z0 = Math.floor((Math.min(az, bz) - this.minZ) / CELL);
    const z1 = Math.floor((Math.max(az, bz) - this.minZ) / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) yield this.cellKey(cx, cz);
    }
  }

  /** Distance from (x, z) to an edge's rightmost lane, and the lane's heading there. */
  distance(edge: number, x: number, z: number): { distance: number; heading: number } {
    const net = this.net;
    const shape = net.laneShape;
    const { start, count } = net.lanePoints(net.edgeLaneStart[edge]);
    let best = { distance: Infinity, heading: 0 };
    for (let k = 0; k + 1 < count; k++) {
      const [ax, az] = [shape[(start + k) * 3], shape[(start + k) * 3 + 1]];
      const [bx, bz] = [shape[(start + k + 1) * 3], shape[(start + k + 1) * 3 + 1]];
      const vx = bx - ax;
      const vz = bz - az;
      const len2 = vx * vx + vz * vz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2)) : 0;
      const d = Math.hypot(x - (ax + t * vx), z - (az + t * vz));
      if (d < best.distance) best = { distance: d, heading: headingOf(vx, vz) };
    }
    return best;
  }

  /** How far along an edge's rightmost lane (as a fraction of it) the point nearest
   * (x, z) is. */
  along(edge: number, x: number, z: number): number {
    const net = this.net;
    const shape = net.laneShape;
    const { start, count } = net.lanePoints(net.edgeLaneStart[edge]);
    let total = 0;
    let best = { distance: Infinity, at: 0 };
    for (let k = 0; k + 1 < count; k++) {
      const [ax, az] = [shape[(start + k) * 3], shape[(start + k) * 3 + 1]];
      const vx = shape[(start + k + 1) * 3] - ax;
      const vz = shape[(start + k + 1) * 3 + 1] - az;
      const len = Math.hypot(vx, vz);
      const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len ** 2)) : 0;
      const d = Math.hypot(x - (ax + t * vx), z - (az + t * vz));
      if (d < best.distance) best = { distance: d, at: total + t * len };
      total += len;
    }
    return total > 0 ? best.at / total : 0;
  }

  /** Indexed edges with a lane within `radius` of (x, z), nearest first. */
  near(
    x: number,
    z: number,
    radius: number,
  ): { edge: number; distance: number; heading: number }[] {
    const found = new Map<number, { edge: number; distance: number; heading: number }>();
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor((x - this.minX) / CELL);
    const cz = Math.floor((z - this.minZ) / CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        for (const e of this.cells.get(this.cellKey(cx + dx, cz + dz)) ?? []) {
          if (found.has(e)) continue;
          const d = this.distance(e, x, z);
          if (d.distance <= radius) found.set(e, { edge: e, ...d });
        }
      }
    }
    return [...found.values()].sort((a, b) => a.distance - b.distance);
  }

  /** The editable edge nearest to (x, z) within `radius` m. */
  pick(x: number, z: number, radius = 25): number | undefined {
    return this.near(x, z, radius)[0]?.edge;
  }

  /** How to find an edge again on another build of the network: its middle and heading. */
  ref(edge: number): RoadRef {
    const net = this.net;
    const shape = net.laneShape;
    const { start, count } = net.lanePoints(net.edgeLaneStart[edge]);
    let total = 0;
    for (let k = 0; k + 1 < count; k++) {
      total += Math.hypot(
        shape[(start + k + 1) * 3] - shape[(start + k) * 3],
        shape[(start + k + 1) * 3 + 1] - shape[(start + k) * 3 + 1],
      );
    }
    let left = total / 2;
    let point = { x: shape[start * 3], z: shape[start * 3 + 1], heading: 0 };
    for (let k = 0; k + 1 < count; k++) {
      const [ax, az] = [shape[(start + k) * 3], shape[(start + k) * 3 + 1]];
      const vx = shape[(start + k + 1) * 3] - ax;
      const vz = shape[(start + k + 1) * 3 + 1] - az;
      const len = Math.hypot(vx, vz);
      if (left <= len || k + 2 === count) {
        const t = len > 0 ? Math.min(1, left / len) : 0;
        point = { x: ax + vx * t, z: az + vz * t, heading: headingOf(vx, vz) };
        break;
      }
      left -= len;
    }
    const name = net.nameOf(edge);
    return { ...point, ...(name ? { name } : {}) };
  }

  /** The edge a saved road refers to on this network, if it has one there. */
  find(ref: RoadRef): number | undefined {
    return this.near(ref.x, ref.z, FIND_DISTANCE).find(
      (c) => angleBetween(c.heading, ref.heading) <= FIND_HEADING,
    )?.edge;
  }

  /** Signal program of the junction a road leads to, if it has signals. */
  signalAt(edge: number): number | undefined {
    const t = this.junctionTls[this.net.edgeTo[edge]];
    return t === NONE ? undefined : t;
  }

  /** How to find a signal program's junction again. */
  junctionRef(tls: number, name?: string): JunctionRef | undefined {
    const j = this.junctionTls.indexOf(tls);
    if (j < 0) return undefined;
    const pos = this.net.junctionPos;
    return { x: pos[j * 2], z: pos[j * 2 + 1], ...(name ? { name } : {}) };
  }

  /** The signal program at a saved junction, if this network has one there. */
  findSignal(ref: JunctionRef): number | undefined {
    const pos = this.net.junctionPos;
    let best: { tls: number; d: number } | undefined;
    for (let j = 0; j < this.junctionTls.length; j++) {
      const t = this.junctionTls[j];
      if (t === NONE) continue;
      const d = Math.hypot(pos[j * 2] - ref.x, pos[j * 2 + 1] - ref.z);
      if (d <= FIND_SIGNAL && (!best || d < best.d)) best = { tls: t, d };
    }
    return best?.tls;
  }

  /** Roads whose turns a signal program controls. */
  signalEdges(tls: number): number[] {
    return this.tlsEdges.get(tls) ?? [];
  }

  /** The ways on from a road at the junction it leads to. */
  turns(edge: number): Turn[] {
    const net = this.net;
    const a = net.arrays;
    const linkFrom = a.linkFrom as Uint32Array;
    const linkTo = a.linkTo as Uint32Array;
    const linkDir = a.linkDir as Uint8Array;
    const linkTls = a.linkTls as Uint32Array;
    const offsets = a.laneLinkOffsets as Uint32Array;
    const dirs = net.index.linkDirs;
    const out = new Map<number, Turn>();
    const lane0 = net.edgeLaneStart[edge];
    for (let lane = lane0; lane < lane0 + net.edgeLaneCount[edge]; lane++) {
      for (let l = offsets[lane]; l < offsets[lane + 1]; l++) {
        if (linkFrom[l] !== lane) continue;
        const to = net.laneEdge[linkTo[l]];
        if (out.has(to) || !this.editable(to)) continue;
        const name = net.nameOf(to);
        out.set(to, {
          to,
          direction: DIRECTIONS[dirs[linkDir[l]]] ?? 'straight on',
          ...(name ? { name } : {}),
          ...(linkTls[l] !== NONE ? { tls: linkTls[l] } : {}),
        });
      }
    }
    return [...out.values()];
  }
}
