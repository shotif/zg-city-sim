/**
 * The junction builder (M4d): roads drawn in the app, built into the network the engine
 * runs, as netconvert would build them where that can be done simply.
 *
 * Every network is built from the one loaded, with all the roads drawn so far, so what was
 * loaded keeps its ids: new lanes, edges and junctions come after it. A road that starts or
 * ends on another road cuts it: the first part keeps the edge (its lanes shortened), the
 * rest becomes a new edge, and the links that left the old road's end now leave the new
 * one's. Links are re-sorted by the lane they leave, as the engine needs them.
 *
 * At each junction a new road meets, every way in links to every way out except back the
 * way it came: lane by lane straight on, right turns from the rightmost lane, left turns
 * from the leftmost. Each link crosses the junction on a lane of its own, a curve from the
 * end of one lane to the start of the other. Paths that cross or merge are foes. Who gives
 * way follows the roads' classes: the most important roads in have priority, between equals
 * traffic from the right goes first, and left turns give way to oncoming traffic. At
 * signals, links from an approach that is already there take the states of that
 * approach's nearest link, giving way where they cross a green, and a new approach gets a
 * green phase of its own at the end of the cycle.
 *
 * Each build also says where each of its lanes lies on the lanes it was made from
 * (`LaneOrigin`), so that the engine can move its vehicles from one build to the next
 * (`lanePieces`).
 */
import type { TypedArray } from '../data/packed';
import type { RoadNetwork } from '../world/roadNetwork';
import type { RoadIndex } from './roadIndex';

/** Roads the player can draw: OpenStreetMap class, default limit (km/h), label. */
export const NEW_ROAD_TYPES = {
  motorway: { type: 'highway.motorway', kmh: 100, label: 'Motorway' },
  primary: { type: 'highway.primary', kmh: 60, label: 'Main road' },
  secondary: { type: 'highway.secondary', kmh: 50, label: 'Secondary road' },
  tertiary: { type: 'highway.tertiary', kmh: 50, label: 'Local road' },
  residential: { type: 'highway.residential', kmh: 30, label: 'Residential street' },
} as const;
export type NewRoadType = keyof typeof NEW_ROAD_TYPES;

export interface Point {
  x: number;
  z: number;
}

/** A road drawn by the player, through `points` (scene x, z), its ends on roads or
 * junctions. It meets other roads only at its ends: elsewhere it passes over or under. */
export interface RoadEdit {
  kind: 'road';
  points: Point[];
  type: NewRoadType;
  /** Lanes each way. */
  lanes: number;
  /** One way, from the first point to the last. */
  oneway: boolean;
  kmh: number;
  /** A bridge: its deck runs straight between its ends instead of following the ground. */
  bridge: boolean;
}

/** A junction, by its position (scene x, z), with a name to show. */
export interface JunctionPoint {
  x: number;
  z: number;
  name?: string;
}

/** A road one way at a point on it (scene x, z) and its heading (degrees, 0 = north). */
export interface WayRef {
  x: number;
  z: number;
  heading: number;
  name?: string;
}

/** The junction made a roundabout (M4e): a ring of one-way roads, `lanes` wide, that
 * traffic entering gives way to. */
export interface RoundaboutEdit {
  kind: 'roundabout';
  junction: JunctionPoint;
  lanes: number;
}

/** A movement across a junction: from one road onto another. */
export interface Movement {
  from: WayRef;
  to: WayRef;
}

/** The junction's traffic lights as the player set them (M4e): its movements, and the
 * movements green in each phase (indices into `movements`) and the phase's length; a
 * yellow follows each phase for what turns red. Movements never green are closed. No
 * phases: no traffic lights. */
export interface SignalEdit {
  kind: 'signal';
  junction: JunctionPoint;
  movements: Movement[];
  phases: { seconds: number; green: number[] }[];
}

/** Edits the junction builder makes into the network. */
export type NetworkEdit = RoadEdit | RoundaboutEdit | SignalEdit;

/** Where a lane of a build lies on the lane it was made from: `key` names that lane (a
 * lane loaded, or a lane of a drawn road), `start` and `end` are metres along it. `gone`:
 * the lane is still there but nothing leads onto it (a junction made again). */
export interface LaneOrigin {
  key: string;
  start: number;
  end: number;
  gone?: boolean;
}

/** Where part of a lane of the previous build is in the next (sim/src/patch.rs). */
export interface LanePieceRec {
  old: number;
  from: number;
  lane: number;
  shift: number;
}

export interface BuiltNetwork {
  /** Arrays for the road network and the engine (shapes decoded, below). */
  arrays: Record<string, TypedArray>;
  laneShape: Float32Array;
  junctionShape: Float32Array;
  /** Origin of every lane that is not a whole lane as loaded. */
  origins: Map<number, LaneOrigin>;
  /** Edges of each edit (a road's both ways, a roundabout's ring), in the edits' order. */
  roads: number[][];
  /** Edits that could not be built, with why (index into the edits). */
  problems: { road: number; reason: string }[];
  /** Edge types (the loaded network's, and any a drawn road needed). */
  types: string[];
}

const NONE = 0xffffffff;
const LANE_WIDTH = 3.2;
/** A road end this close (m) to a junction joins it; this close to a road, it cuts it. */
export const SNAP_JUNCTION = 25;
export const SNAP_ROAD = 15;
/** Cars, buses, trucks, deliveries, taxis and emergency vehicles. */
const ROAD_ALLOW = 1 | 2 | 8 | 128 | 256 | 512;
const PASSENGER = 1;

type Shape = number[]; // x, z, elevation per point

const RANK: Record<string, number> = {
  motorway: 7,
  trunk: 6,
  primary: 5,
  secondary: 4,
  tertiary: 3,
  minor: 2,
  service: 1,
  tram: 8,
  rail: 8,
};

// ---- geometry ----------------------------------------------------------------------------

function pathLength(s: Shape): number {
  let total = 0;
  for (let i = 3; i < s.length; i += 3) total += Math.hypot(s[i] - s[i - 3], s[i + 1] - s[i - 2]);
  return total;
}

/** The part of a polyline from `a` to `b` metres along it. */
function cut(s: Shape, a: number, b: number): Shape {
  const out: Shape = [];
  let along = 0;
  const n = s.length / 3;
  const at = (i: number, t: number) => [
    s[i * 3] + (s[i * 3 + 3] - s[i * 3]) * t,
    s[i * 3 + 1] + (s[i * 3 + 4] - s[i * 3 + 1]) * t,
    s[i * 3 + 2] + (s[i * 3 + 5] - s[i * 3 + 2]) * t,
  ];
  for (let i = 0; i < n - 1; i++) {
    const len = Math.hypot(s[i * 3 + 3] - s[i * 3], s[i * 3 + 4] - s[i * 3 + 1]);
    const next = along + len;
    if (next >= a && along <= b && len > 0) {
      if (out.length === 0) out.push(...at(i, Math.max(0, (a - along) / len)));
      if (next <= b) out.push(s[i * 3 + 3], s[i * 3 + 4], s[i * 3 + 5]);
      else {
        out.push(...at(i, (b - along) / len));
        break;
      }
    }
    along = next;
  }
  if (out.length < 6) {
    const p = out.length ? out.slice(0, 3) : s.slice(0, 3);
    out.length = 0;
    out.push(...p, p[0] + 0.01, p[1], p[2]);
  }
  return out;
}

/** Distance along a polyline to the point nearest (x, z), and how far that point is. */
function project(s: Shape, x: number, z: number): { along: number; distance: number } {
  let best = { along: 0, distance: Infinity };
  let along = 0;
  for (let i = 0; i + 3 < s.length; i += 3) {
    const [ax, az, bx, bz] = [s[i], s[i + 1], s[i + 3], s[i + 4]];
    const len2 = (bx - ax) ** 2 + (bz - az) ** 2;
    const t =
      len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / len2)) : 0;
    const d = Math.hypot(ax + (bx - ax) * t - x, az + (bz - az) * t - z);
    if (d < best.distance) best = { along: along + Math.sqrt(len2) * t, distance: d };
    along += Math.sqrt(len2);
  }
  return best;
}

/** Unit direction of travel at a polyline's start or end. */
function direction(s: Shape, end: boolean): Point {
  const n = s.length / 3;
  const [i, j] = end ? [n - 2, n - 1] : [0, 1];
  const dx = s[j * 3] - s[i * 3];
  const dz = s[j * 3 + 1] - s[i * 3 + 1];
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

/** The polyline moved sideways by `offset` m to the right of travel (x east, z south). */
function offsetLine(points: Point[], offset: number): Point[] {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    // Right of travel: (-dz, dx).
    return { x: p.x - ((b.z - a.z) / len) * offset, z: p.z + ((b.x - a.x) / len) * offset };
  });
}

/** Turn from one direction of travel to another: 's', 'l', 'r' or 't' (back). */
function turn(a: Point, b: Point): 's' | 'l' | 'r' | 't' {
  const cross = a.x * b.z - a.z * b.x; // > 0: to the right (z points south)
  const angle = (Math.atan2(cross, a.x * b.x + a.z * b.z) * 180) / Math.PI;
  if (Math.abs(angle) < 35) return 's';
  if (Math.abs(angle) > 150) return 't';
  return angle > 0 ? 'r' : 'l';
}

function segmentsCross(a: Shape, b: Shape): boolean {
  for (let i = 0; i + 3 < a.length; i += 3) {
    for (let j = 0; j + 3 < b.length; j += 3) {
      const [px, pz, rx, rz] = [a[i], a[i + 1], a[i + 3] - a[i], a[i + 4] - a[i + 1]];
      const [qx, qz, sx, sz] = [b[j], b[j + 1], b[j + 3] - b[j], b[j + 4] - b[j + 1]];
      const den = rx * sz - rz * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((qx - px) * sz - (qz - pz) * sx) / den;
      const u = ((qx - px) * rz - (qz - pz) * rx) / den;
      if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) return true;
    }
  }
  return false;
}

function bezier(p0: Point, t0: Point, p3: Point, t1: Point): Shape {
  const k = Math.hypot(p3.x - p0.x, p3.z - p0.z) / 3;
  const p1 = { x: p0.x + t0.x * k, z: p0.z + t0.z * k };
  const p2 = { x: p3.x - t1.x * k, z: p3.z - t1.z * k };
  const out: Shape = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push(
      u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      u * u * u * p0.z + 3 * u * u * t * p1.z + 3 * u * t * t * p2.z + t * t * t * p3.z,
      0,
    );
  }
  return out;
}

function convexHull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) {
      lower.pop();
    }
    lower.push(q);
  }
  const upper: Point[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) {
      upper.pop();
    }
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// ---- the draft network -------------------------------------------------------------------

interface Link {
  from: number;
  to: number;
  via: number;
  junction: number;
  request: number;
  dir: number;
  state: number;
  tls: number;
  tlsIndex: number;
}

interface Program {
  durations: number[];
  mins: number[];
  maxs: number[];
  states: string[];
}

/** The network as loaded, with what the roads drawn change and add. */
class Draft {
  readonly a: Record<string, TypedArray>;
  readonly baseLanes: number;
  readonly baseEdges: number;
  readonly baseJunctions: number;
  readonly baseLinks: number;
  // Lanes, edges and junctions added, and changes to those loaded.
  lanes: {
    edge: number;
    length: number;
    speed: number;
    width: number;
    allow: number;
    next: number;
    shape: Shape;
  }[] = [];
  laneShape = new Map<number, Shape>();
  laneLength = new Map<number, number>();
  laneNext = new Map<number, number>();
  edges: {
    from: number;
    to: number;
    type: number;
    flags: number;
    name: number;
    ref: number;
    laneStart: number;
    laneCount: number;
  }[] = [];
  edgeTo = new Map<number, number>();
  junctions: { x: number; z: number; type: number; shape: Point[] }[] = [];
  junctionShape = new Map<number, Point[]>();
  junctionType = new Map<number, number>();
  /** Links: those loaded (by id) as changed, and those added. */
  linkFrom = new Map<number, number>();
  linkState = new Map<number, number>();
  links: Link[] = [];
  /** Right of way, replaced for the junctions roads were added at: link ids by request, and
   * (response, foes) request sets per request. */
  logic = new Map<number, { links: number[]; response: Set<number>[]; foes: Set<number>[] }>();
  programs = new Map<number, Program>();
  /** Signal programs added, after those loaded, and those the player set. */
  newPrograms: Program[] = [];
  fixedPrograms = new Set<number>();
  linkTls = new Map<number, { tls: number; index: number }>();
  /** Links taken away (loaded or added), roads moved to start elsewhere, and road ranks set
   * (a roundabout's ring goes first). */
  removedLinks = new Set<number>();
  edgeFrom = new Map<number, number>();
  rankOverride = new Map<number, number>();
  /** Lanes not whole as loaded, and where they lie. */
  origins = new Map<number, LaneOrigin>();
  // Lookups over the network as loaded.
  private readonly inEdges: number[][];
  private readonly outEdges: number[][];
  private readonly junctionLinks = new Map<number, number[]>();
  private readonly internalType: number;

  constructor(
    readonly net: RoadNetwork,
    readonly types: string[],
  ) {
    this.a = net.arrays;
    this.baseLanes = net.laneCount;
    this.baseEdges = net.edgeCount;
    this.baseJunctions = net.junctionCount;
    this.baseLinks = (this.a.linkFrom as Uint32Array).length;
    this.inEdges = Array.from({ length: this.baseJunctions }, () => []);
    this.outEdges = Array.from({ length: this.baseJunctions }, () => []);
    for (let e = 0; e < this.baseEdges; e++) {
      if (net.isInternal(e)) continue;
      this.outEdges[net.edgeFrom[e]].push(e);
      this.inEdges[net.edgeTo[e]].push(e);
    }
    const linkJunction = this.a.linkJunction as Uint32Array;
    for (let l = 0; l < this.baseLinks; l++) {
      const j = linkJunction[l];
      if (j === NONE) continue;
      const list = this.junctionLinks.get(j);
      if (list) list.push(l);
      else this.junctionLinks.set(j, [l]);
    }
    this.internalType = Math.max(0, types.indexOf('internal'));
  }

  // -- reading lanes, edges, junctions and links, loaded or added

  get laneCount(): number {
    return this.baseLanes + this.lanes.length;
  }
  get edgeCount(): number {
    return this.baseEdges + this.edges.length;
  }
  get junctionCount(): number {
    return this.baseJunctions + this.junctions.length;
  }

  shapeOf(lane: number): Shape {
    if (lane >= this.baseLanes) return this.lanes[lane - this.baseLanes].shape;
    const own = this.laneShape.get(lane);
    if (own) return own;
    const { start, count } = this.net.lanePoints(lane);
    return Array.from(this.net.laneShape.subarray(start * 3, (start + count) * 3));
  }
  lengthOf(lane: number): number {
    if (lane >= this.baseLanes) return this.lanes[lane - this.baseLanes].length;
    return this.laneLength.get(lane) ?? this.net.laneLength[lane];
  }
  speedOf(lane: number): number {
    return lane >= this.baseLanes
      ? this.lanes[lane - this.baseLanes].speed
      : this.net.laneSpeed[lane];
  }
  allowOf(lane: number): number {
    return lane >= this.baseLanes
      ? this.lanes[lane - this.baseLanes].allow
      : this.net.laneAllow[lane];
  }
  edgeOfLane(lane: number): number {
    return lane >= this.baseLanes
      ? this.lanes[lane - this.baseLanes].edge
      : this.net.laneEdge[lane];
  }
  nextOf(lane: number): number {
    if (lane >= this.baseLanes) return this.lanes[lane - this.baseLanes].next;
    return this.laneNext.get(lane) ?? (this.a.laneNext as Uint32Array)[lane];
  }
  lanesOf(edge: number): number[] {
    const [start, count] =
      edge >= this.baseEdges
        ? [this.edges[edge - this.baseEdges].laneStart, this.edges[edge - this.baseEdges].laneCount]
        : [this.net.edgeLaneStart[edge], this.net.edgeLaneCount[edge]];
    return Array.from({ length: count }, (_, k) => start + k);
  }
  fromOf(edge: number): number {
    if (edge >= this.baseEdges) return this.edges[edge - this.baseEdges].from;
    return this.edgeFrom.get(edge) ?? this.net.edgeFrom[edge];
  }
  toOf(edge: number): number {
    if (edge >= this.baseEdges) return this.edges[edge - this.baseEdges].to;
    return this.edgeTo.get(edge) ?? this.net.edgeTo[edge];
  }
  typeOf(edge: number): number {
    return edge >= this.baseEdges
      ? this.edges[edge - this.baseEdges].type
      : this.net.edgeType[edge];
  }
  isInternal(edge: number): boolean {
    return edge >= this.baseEdges
      ? (this.edges[edge - this.baseEdges].flags & this.net.index.flags.internal) !== 0
      : this.net.isInternal(edge);
  }
  rankOf(edge: number): number {
    const own = this.rankOverride.get(edge);
    if (own !== undefined) return own;
    const type = this.types[this.typeOf(edge)] ?? '';
    const highway = type
      .split('|')[0]
      .replace('highway.', '')
      .replace(/_link$/, '');
    if (type.startsWith('railway')) return RANK.rail;
    if (highway in RANK) return RANK[highway];
    return highway === 'unclassified' || highway === 'residential' ? RANK.minor : RANK.service;
  }
  junctionPos(j: number): Point {
    if (j >= this.baseJunctions) return this.junctions[j - this.baseJunctions];
    return { x: this.net.junctionPos[j * 2], z: this.net.junctionPos[j * 2 + 1] };
  }
  /** Ways in to and out of a junction, for traffic (not junctions' own lanes). */
  incoming(j: number): number[] {
    const loaded = j < this.baseJunctions ? this.inEdges[j].filter((e) => this.toOf(e) === j) : [];
    const cut = [...this.edgeTo].filter(([, to]) => to === j).map(([e]) => e);
    const added = this.edges
      .map((_, k) => this.baseEdges + k)
      .filter((e) => !this.isInternal(e) && this.toOf(e) === j);
    return [...new Set([...loaded, ...cut, ...added])].filter((e) => this.carries(e));
  }
  outgoing(j: number): number[] {
    const loaded =
      j < this.baseJunctions ? this.outEdges[j].filter((e) => this.fromOf(e) === j) : [];
    const moved = [...this.edgeFrom].filter(([, from]) => from === j).map(([e]) => e);
    const added = this.edges
      .map((_, k) => this.baseEdges + k)
      .filter((e) => !this.isInternal(e) && this.fromOf(e) === j);
    return [...new Set([...loaded, ...moved, ...added])].filter((e) => this.carries(e));
  }
  carries(edge: number): boolean {
    return this.lanesOf(edge).some((l) => (this.allowOf(l) & PASSENGER) !== 0);
  }

  link(id: number): Link {
    if (id >= this.baseLinks) return this.links[id - this.baseLinks];
    const a = this.a;
    const tls = this.linkTls.get(id);
    return {
      from: this.linkFrom.get(id) ?? (a.linkFrom as Uint32Array)[id],
      to: (a.linkTo as Uint32Array)[id],
      via: (a.linkVia as Uint32Array)[id],
      junction: (a.linkJunction as Uint32Array)[id],
      request: (a.linkRequest as Uint16Array)[id],
      dir: (a.linkDir as Uint8Array)[id],
      state: this.linkState.get(id) ?? (a.linkState as Uint8Array)[id],
      tls: tls?.tls ?? (a.linkTls as Uint32Array)[id],
      tlsIndex: tls?.index ?? (a.linkTlsIndex as Uint16Array)[id],
    };
  }
  linksAt(j: number): number[] {
    const loaded = this.junctionLinks.get(j) ?? [];
    const added = this.links
      .map((l, k) => [l, this.baseLinks + k] as const)
      .filter(([l]) => l.junction === j)
      .map(([, id]) => id);
    return [...loaded, ...added].filter((l) => !this.removedLinks.has(l));
  }
  /** Every link signal program `t` controls (it can span a cluster of junctions). */
  linksOfProgram(t: number): number[] {
    const out: number[] = [];
    const linkTls = this.a.linkTls as Uint32Array;
    for (let l = 0; l < this.baseLinks; l++) {
      if (this.removedLinks.has(l)) continue;
      if ((this.linkTls.get(l)?.tls ?? linkTls[l]) === t) out.push(l);
    }
    this.links.forEach((link, k) => {
      if (link.tls === t && !this.removedLinks.has(this.baseLinks + k))
        out.push(this.baseLinks + k);
    });
    return out;
  }
  get programCount(): number {
    return (this.a.tlsPhaseOffsets as Uint32Array).length - 1 + this.newPrograms.length;
  }
  /** The path of a link across its junction: its internal lanes' shapes end to end. */
  pathOf(id: number): Shape {
    const out: Shape = [];
    let lane = this.link(id).via;
    for (let guard = 0; lane !== NONE && guard < 8; guard++) {
      const edge = this.edgeOfLane(lane);
      if (!this.isInternal(edge)) break;
      out.push(...this.shapeOf(lane));
      lane = this.nextOf(lane);
    }
    return out;
  }

  // -- changing

  setState(id: number, state: string): void {
    const s = Math.max(0, this.net.index.linkStates.indexOf(state));
    if (id >= this.baseLinks) this.links[id - this.baseLinks].state = s;
    else this.linkState.set(id, s);
  }
  setTls(id: number, tls: number, index: number): void {
    if (id >= this.baseLinks)
      Object.assign(this.links[id - this.baseLinks], { tls, tlsIndex: index });
    else this.linkTls.set(id, { tls, index });
  }
  setEdgeTo(edge: number, j: number): void {
    if (edge >= this.baseEdges) this.edges[edge - this.baseEdges].to = j;
    else this.edgeTo.set(edge, j);
  }
  setEdgeFrom(edge: number, j: number): void {
    if (edge >= this.baseEdges) this.edges[edge - this.baseEdges].from = j;
    else this.edgeFrom.set(edge, j);
  }
  /** A lane's new shape and length (in its own measure), and where it now lies. */
  setLane(lane: number, shape: Shape, length: number, origin: LaneOrigin): void {
    if (lane >= this.baseLanes) Object.assign(this.lanes[lane - this.baseLanes], { shape, length });
    else {
      this.laneShape.set(lane, shape);
      this.laneLength.set(lane, length);
    }
    this.origins.set(lane, origin);
  }
  /** Take a link away; vehicles on the lanes across its junction leave. */
  removeLink(id: number): void {
    this.removedLinks.add(id);
    let lane = this.link(id).via;
    for (let guard = 0; lane !== NONE && guard < 8; guard++) {
      if (!this.isInternal(this.edgeOfLane(lane))) break;
      this.origins.set(lane, { ...this.originOf(lane), gone: true });
      lane = this.nextOf(lane);
    }
  }

  // -- adding

  addJunction(p: Point, type: number, shape: Point[]): number {
    this.junctions.push({ x: p.x, z: p.z, type, shape });
    return this.baseJunctions + this.junctions.length - 1;
  }

  addEdge(e: Omit<Draft['edges'][number], 'laneStart' | 'laneCount'>): number {
    this.edges.push({ ...e, laneStart: this.laneCount, laneCount: 0 });
    return this.baseEdges + this.edges.length - 1;
  }

  addLane(edge: number, shape: Shape, speed: number, allow: number, origin: LaneOrigin): number {
    const id = this.laneCount;
    this.lanes.push({
      edge,
      length: pathLength(shape),
      speed,
      width: LANE_WIDTH,
      allow,
      next: NONE,
      shape,
    });
    this.edges[edge - this.baseEdges].laneCount++;
    this.origins.set(id, origin);
    return id;
  }

  /** Where a lane lies on the lane it was made from (a whole lane as loaded if none). */
  originOf(lane: number): LaneOrigin {
    return this.origins.get(lane) ?? { key: `b${lane}`, start: 0, end: this.net.laneLength[lane] };
  }

  /** A link across junction `j` from the end of one lane to the start of another. */
  connect(from: number, to: number, j: number, dirChar: string, state: string): number {
    const fs = this.shapeOf(from);
    const ts = this.shapeOf(to);
    const p0 = { x: fs[fs.length - 3], z: fs[fs.length - 2] };
    const p3 = { x: ts[0], z: ts[1] };
    const shape =
      dirChar === 's' && Math.hypot(p3.x - p0.x, p3.z - p0.z) < 1
        ? [p0.x, p0.z, 0, p3.x + 0.01, p3.z, 0]
        : bezier(p0, direction(fs, true), p3, direction(ts, false));
    const speed = Math.min(
      this.speedOf(from),
      this.speedOf(to),
      dirChar === 's' ? Infinity : dirChar === 'r' ? 6.9 : 8.3,
    );
    const edge = this.addEdge({
      from: j,
      to: j,
      type: this.internalType,
      flags: this.net.index.flags.internal,
      name: NONE,
      ref: NONE,
    });
    const fromOrigin = this.originOf(from);
    const toOrigin = this.originOf(to);
    // Straight on along one lane cut in two: the junction's lane is that lane's middle.
    const origin =
      fromOrigin.key === toOrigin.key
        ? { key: fromOrigin.key, start: fromOrigin.end, end: toOrigin.start }
        : {
            key: `t${fromOrigin.key}@${fromOrigin.end.toFixed(1)}>${toOrigin.key}@${toOrigin.start.toFixed(1)}`,
            start: 0,
            end: pathLength(shape),
          };
    const via = this.addLane(edge, shape, speed, this.allowOf(from) & this.allowOf(to), origin);
    this.lanes[via - this.baseLanes].next = to;
    const dirs = this.net.index.linkDirs;
    const states = this.net.index.linkStates;
    this.links.push({
      from,
      to,
      via,
      junction: j,
      request: -1,
      dir: Math.max(0, dirs.indexOf(dirChar)),
      state: Math.max(0, states.indexOf(state)),
      tls: NONE,
      tlsIndex: 0xffff,
    });
    return this.baseLinks + this.links.length - 1;
  }

  /** Links that left `lane`'s end now leave `onto`'s. */
  moveLinks(lane: number, onto: number): void {
    const linkFrom = this.a.linkFrom as Uint32Array;
    const offsets = this.a.laneLinkOffsets as Uint32Array;
    if (lane < this.baseLanes) {
      for (let l = offsets[lane]; l < offsets[lane + 1]; l++) {
        if ((this.linkFrom.get(l) ?? linkFrom[l]) === lane) this.linkFrom.set(l, onto);
      }
    }
    for (const [l, from] of this.linkFrom) if (from === lane) this.linkFrom.set(l, onto);
    for (const link of this.links) if (link.from === lane) link.from = onto;
  }
}

// ---- building ----------------------------------------------------------------------------

type End = { kind: 'junction'; junction: number } | { kind: 'road'; edges: number[]; point: Point };

/** A road end this close (m) to the end of the road it is on joins that road's junction. */
const SNAP_END = 20;

/** Where a drawn road's end joins the network: the road clicked on (cut there, both ways,
 * or at its junction near its end), else a junction close by. */
function findEnd(d: Draft, index: RoadIndex | undefined, p: Point): End | undefined {
  // Roads loaded (from the road index) and drawn, main roads first where about as near.
  const candidates = new Set<number>();
  for (const c of index?.near(p.x, p.z, SNAP_ROAD) ?? []) candidates.add(c.edge);
  for (let e = d.baseEdges; e < d.edgeCount; e++) if (!d.isInternal(e)) candidates.add(e);
  let road: { edge: number; along: number; length: number; score: number } | undefined;
  for (const e of candidates) {
    if (d.isInternal(e) || !d.carries(e)) continue;
    const shape = d.shapeOf(d.lanesOf(e)[0]);
    const hit = project(shape, p.x, p.z);
    if (hit.distance > SNAP_ROAD) continue;
    const score = hit.distance - d.rankOf(e);
    if (!road || score < road.score) {
      road = { edge: e, along: hit.along, length: pathLength(shape), score };
    }
  }
  const usable = (j: number) => {
    const type = j < d.baseJunctions ? d.net.index.junctionTypes[d.net.junctionType[j]] : '';
    return type !== 'rail_crossing' && (d.incoming(j).length > 0 || d.outgoing(j).length > 0);
  };
  if (road) {
    const { edge, along, length } = road;
    if (along < SNAP_END && usable(d.fromOf(edge))) {
      return { kind: 'junction', junction: d.fromOf(edge) };
    }
    if (length - along < SNAP_END && usable(d.toOf(edge))) {
      return { kind: 'junction', junction: d.toOf(edge) };
    }
    if (along > 10 && along < length - 10) {
      return { kind: 'road', edges: [edge, ...otherWay(d, edge, p)], point: p };
    }
  }
  let best: End | undefined;
  let bestDistance = SNAP_JUNCTION;
  for (let j = 0; j < d.junctionCount; j++) {
    const q = d.junctionPos(j);
    const dist = Math.hypot(q.x - p.x, q.z - p.z);
    if (dist < bestDistance && usable(j)) {
      bestDistance = dist;
      best = { kind: 'junction', junction: j };
    }
  }
  return best;
}

/** The other direction of a road at `p`: the edge between the same junctions the other way,
 * else the nearest road running the other way within a carriageway's distance (a dual
 * carriageway). */
function otherWay(d: Draft, edge: number, p: Point): number[] {
  const from = d.fromOf(edge);
  const to = d.toOf(edge);
  for (const e of d.outgoing(to)) {
    if (d.toOf(e) !== from || e === edge) continue;
    if (project(d.shapeOf(d.lanesOf(e)[0]), p.x, p.z).distance < SNAP_ROAD + 8) return [e];
  }
  const shape = d.shapeOf(d.lanesOf(edge)[0]);
  const here = project(shape, p.x, p.z).along;
  const dir = directionAt(shape, here);
  let best: { edge: number; distance: number } | undefined;
  for (let j = 0; j < d.junctionCount; j++) {
    const q = d.junctionPos(j);
    if (Math.hypot(q.x - p.x, q.z - p.z) > 600) continue;
    for (const e of d.outgoing(j)) {
      if (e === edge) continue;
      const s = d.shapeOf(d.lanesOf(e)[0]);
      const hit = project(s, p.x, p.z);
      const length = pathLength(s);
      if (hit.distance > 35 || hit.along < 10 || hit.along > length - 10) continue;
      const other = directionAt(s, hit.along);
      if (other.x * dir.x + other.z * dir.z > -0.85) continue;
      if (!best || hit.distance < best.distance) best = { edge: e, distance: hit.distance };
    }
  }
  return best ? [best.edge] : [];
}

/** Unit direction of a polyline at `along` metres. */
function directionAt(s: Shape, along: number): Point {
  let acc = 0;
  for (let i = 0; i + 3 < s.length; i += 3) {
    const len = Math.hypot(s[i + 3] - s[i], s[i + 4] - s[i + 1]);
    if (acc + len >= along || i + 6 >= s.length) {
      return { x: (s[i + 3] - s[i]) / (len || 1), z: (s[i + 4] - s[i + 1]) / (len || 1) };
    }
    acc += len;
  }
  return { x: 1, z: 0 };
}

/** Cut roads (a road both ways) where a new road joins them, at one new junction, `gap` m
 * across. */
function cutRoad(d: Draft, edges: number[], p: Point, gap: number): number {
  const priority = Math.max(0, d.net.index.junctionTypes.indexOf('priority'));
  // The junction is where the roads are cut: between the carriageways of a dual one.
  const hits = edges.map((e) => {
    const s = d.shapeOf(d.lanesOf(e)[0]);
    const along = project(s, p.x, p.z).along;
    const c = cut(s, along, along + 0.01);
    return { x: c[0], z: c[1] };
  });
  const centre = {
    x: hits.reduce((a, h) => a + h.x, 0) / hits.length,
    z: hits.reduce((a, h) => a + h.z, 0) / hits.length,
  };
  const j = d.addJunction(centre, priority, []);
  for (const e of edges) {
    const lanes = d.lanesOf(e);
    const edgeIndex = e >= d.baseEdges ? e - d.baseEdges : -1;
    const second = d.addEdge({
      from: j,
      to: d.toOf(e),
      type: d.typeOf(e),
      flags: edgeIndex >= 0 ? d.edges[edgeIndex].flags : d.net.edgeFlags[e],
      name: edgeIndex >= 0 ? d.edges[edgeIndex].name : d.net.edgeName[e],
      ref: edgeIndex >= 0 ? d.edges[edgeIndex].ref : (d.a.edgeRef as Uint32Array)[e],
    });
    if (e >= d.baseEdges) d.edges[edgeIndex].to = j;
    else d.edgeTo.set(e, j);
    const halves: [number, number][] = [];
    for (const lane of lanes) {
      const shape = d.shapeOf(lane);
      const here = project(shape, p.x, p.z).along;
      const length = pathLength(shape);
      const origin = d.originOf(lane);
      const scale = d.lengthOf(lane) / Math.max(length, 0.1);
      const firstEnd = Math.max(1, here - gap / 2);
      const secondStart = Math.min(length - 1, here + gap / 2);
      const first = cut(shape, 0, firstEnd);
      const rest = cut(shape, secondStart, length);
      const onto = d.addLane(second, rest, d.speedOf(lane), d.allowOf(lane), {
        key: origin.key,
        start: origin.start + secondStart * scale,
        end: origin.end,
      });
      // Lengths stay in the lane's own measure (netconvert's can differ from the shape's).
      d.lanes[onto - d.baseLanes].length = (length - secondStart) * scale;
      if (lane >= d.baseLanes) {
        const own = d.lanes[lane - d.baseLanes];
        own.shape = first;
        own.length = firstEnd * scale;
      } else {
        d.laneShape.set(lane, first);
        d.laneLength.set(lane, firstEnd * scale);
      }
      d.origins.set(lane, {
        key: origin.key,
        start: origin.start,
        end: origin.start + firstEnd * scale,
      });
      d.moveLinks(lane, onto);
      halves.push([lane, onto]);
    }
    for (const [lane, onto] of halves) d.connect(lane, onto, j, 's', 'M');
  }
  return j;
}

/** Lanes of a drawn road, `lanes` each way, between two points already trimmed. */
function addRoadEdges(
  d: Draft,
  road: RoadEdit,
  key: string,
  line: Point[],
  from: number,
  to: number,
  reverse: boolean,
): number {
  const typeName = NEW_ROAD_TYPES[road.type].type;
  let type = d.types.indexOf(typeName);
  if (type < 0) {
    d.types.push(typeName);
    type = d.types.length - 1;
  }
  const flags = road.bridge ? d.net.index.flags.bridge : 0;
  const edge = d.addEdge({ from, to, type, flags, name: NONE, ref: NONE });
  const path = reverse ? [...line].reverse() : line;
  const n = Math.max(1, Math.min(4, Math.round(road.lanes)));
  for (let k = 0; k < n; k++) {
    // Lane 0 is the rightmost; a two-way road's centre line is between its directions.
    const offset = road.oneway ? ((n - 1) / 2 - k) * LANE_WIDTH : (n - k - 0.5) * LANE_WIDTH;
    const pts = offsetLine(path, offset);
    const shape = pts.flatMap((p) => [p.x, p.z, 0]);
    d.addLane(edge, shape, road.kmh / 3.6, ROAD_ALLOW, {
      key: `${key}:${reverse ? 'b' : 'f'}${k}`,
      start: 0,
      end: pathLength(shape),
    });
  }
  return edge;
}

/** How far from a junction's centre roads joining it start (m). */
function junctionRadius(d: Draft, j: number, extra: number): number {
  let widest = extra;
  for (const e of [...d.incoming(j), ...d.outgoing(j)]) {
    widest = Math.max(widest, d.lanesOf(e).length * LANE_WIDTH * 2);
  }
  return Math.max(8, widest / 2 + 3);
}

/** Links between every way in and every way out at junction `j` that involve `added`. */
function connectJunction(d: Draft, j: number, added: Set<number>): number[] {
  const made: number[] = [];
  const ins = d.incoming(j);
  const outs = d.outgoing(j);
  for (const i of ins) {
    for (const o of outs) {
      if (!added.has(i) && !added.has(o)) continue;
      if (d.toOf(o) === d.fromOf(i)) continue; // back the way it came
      const inLanes = d.lanesOf(i).filter((l) => (d.allowOf(l) & PASSENGER) !== 0);
      const outLanes = d.lanesOf(o).filter((l) => (d.allowOf(l) & PASSENGER) !== 0);
      if (!inLanes.length || !outLanes.length) continue;
      const way = turn(
        direction(d.shapeOf(inLanes[0]), true),
        direction(d.shapeOf(outLanes[0]), false),
      );
      if (way === 't') continue;
      const pairs: [number, number][] =
        way === 's'
          ? inLanes.map((l, k) => [l, outLanes[Math.min(k, outLanes.length - 1)]])
          : way === 'r'
            ? [[inLanes[0], outLanes[0]]]
            : [[inLanes[inLanes.length - 1], outLanes[outLanes.length - 1]]];
      for (const [f, t] of pairs) made.push(d.connect(f, t, j, way, 'M'));
    }
  }
  return made;
}

interface RightOfWay {
  /** Link ids by request (-1: none). */
  links: number[];
  /** Per request, the requests it gives way to, and those it crosses or merges with. */
  response: Set<number>[];
  foes: Set<number>[];
}

/** Right of way at junction `j` as it stands (a copy), leaving out the links in `skip`. */
function rightOfWay(d: Draft, j: number, skip: readonly number[] = []): RightOfWay {
  const existing = d.logic.get(j);
  if (existing) {
    return {
      links: [...existing.links],
      response: existing.response.map((s) => new Set(s)),
      foes: existing.foes.map((s) => new Set(s)),
    };
  }
  const a = d.a;
  const count = j < d.baseJunctions ? (a.junctionLinkCount as Uint16Array)[j] : 0;
  const offset = j < d.baseJunctions ? (a.junctionLogicOffset as Uint32Array)[j] : 0;
  const words = Math.max(1, Math.ceil(count / 32));
  const logic = a.logic as Uint32Array;
  const links: number[] = new Array(count).fill(-1);
  const response = Array.from({ length: count }, () => new Set<number>());
  const foes = Array.from({ length: count }, () => new Set<number>());
  for (const l of d.linksAt(j)) {
    const r = d.link(l).request;
    if (r >= 0 && r < count && !skip.includes(l)) links[r] = l;
  }
  for (let r = 0; r < count; r++) {
    for (let w = 0; w < words; w++) {
      const resp = logic[offset + r * 2 * words + w];
      const foe = logic[offset + r * 2 * words + words + w];
      for (let b = 0; b < 32; b++) {
        if (resp & (1 << b)) response[r].add(w * 32 + b);
        if (foe & (1 << b)) foes[r].add(w * 32 + b);
      }
    }
  }
  return { links, response, foes };
}

/** Right of way and signal states at a junction where `added` links were made. */
function junctionLogic(d: Draft, j: number, added: number[]): void {
  const links = d.linksAt(j);
  const oldLinks = links.filter((l) => !added.includes(l));
  // Requests: those there keep their numbers, new links come after.
  const { links: byRequest, response, foes } = rightOfWay(d, j, added);
  for (const l of added) {
    const link = d.link(l);
    link.request = byRequest.length;
    byRequest.push(l);
    response.push(new Set());
    foes.push(new Set());
  }
  const requestOf = new Map(byRequest.map((l, r) => [l, r] as const));
  const ins = d.incoming(j);
  const top = Math.max(...ins.map((e) => d.rankOf(e)), 0);
  const inDir = (l: number) => direction(d.shapeOf(d.link(l).from), true);
  const fromEdge = (l: number) => d.edgeOfLane(d.link(l).from);
  const dirOf = (l: number) => d.net.index.linkDirs[d.link(l).dir] ?? 's';
  for (const l of added) {
    const r = requestOf.get(l)!;
    const path = d.pathOf(l);
    for (const m of byRequest) {
      if (m < 0 || m === l) continue;
      const q = requestOf.get(m)!;
      const [ll, lm] = [d.link(l), d.link(m)];
      if (ll.from === lm.from || fromEdge(l) === fromEdge(m)) continue;
      const merge = ll.to === lm.to;
      if (!merge && !segmentsCross(path, d.pathOf(m))) continue;
      foes[r].add(q);
      foes[q].add(r);
      // Who gives way.
      const [majorL, majorM] = [d.rankOf(fromEdge(l)) >= top, d.rankOf(fromEdge(m)) >= top];
      let lYields: boolean;
      if (majorL !== majorM) lYields = !majorL;
      else {
        const [da, db] = [inDir(l), inDir(m)];
        const opposite = da.x * db.x + da.z * db.z < -0.5;
        const [left, mLeft] = [dirOf(l) === 'l', dirOf(m) === 'l'];
        if (opposite && left !== mLeft) lYields = left;
        else if (merge && (dirOf(l) === 's') !== (dirOf(m) === 's')) lYields = dirOf(l) !== 's';
        // From the right goes first.
        else lYields = da.x * db.z - da.z * db.x < 0;
      }
      if (lYields) response[r].add(q);
      else response[q].add(r);
    }
  }
  d.logic.set(j, { links: byRequest, response, foes });

  // Priority junctions: links that give way to any foe are minor.
  const tlsLink = oldLinks.map((l) => d.link(l)).find((l) => l.tls !== NONE);
  const states = d.net.index.linkStates;
  if (!tlsLink) {
    for (const [r, l] of byRequest.entries()) {
      if (l < 0) continue;
      const link = d.link(l);
      const s = states[link.state];
      if (l >= d.baseLinks) {
        if (s === 'M' || s === 'm') link.state = states.indexOf(response[r].size ? 'm' : 'M');
      } else if (s === 'M' && response[r].size) {
        // A link loaded that now gives way to a new road.
        d.linkState.set(l, states.indexOf('m'));
      }
    }
    return;
  }
  signalStates(d, tlsLink.tls, j, added, byRequest, foes);
}

/** States for new links of signal program `t`: as the nearest link from the same approach,
 * and a phase of their own for new approaches. */
function signalStates(
  d: Draft,
  t: number,
  j: number,
  added: number[],
  byRequest: number[],
  foes: Set<number>[],
): void {
  const a = d.a;
  const program =
    d.programs.get(t) ??
    (() => {
      const offsets = a.tlsPhaseOffsets as Uint32Array;
      const stateOffsets = a.phaseStateOffsets as Uint32Array;
      const chars = a.phaseStates as Uint8Array;
      const p: Program = { durations: [], mins: [], maxs: [], states: [] };
      for (let k = offsets[t]; k < offsets[t + 1]; k++) {
        p.durations.push((a.phaseDuration as Float32Array)[k]);
        p.mins.push((a.phaseMinDur as Float32Array)[k]);
        p.maxs.push((a.phaseMaxDur as Float32Array)[k]);
        p.states.push(String.fromCharCode(...chars.subarray(stateOffsets[k], stateOffsets[k + 1])));
      }
      return p;
    })();
  d.programs.set(t, program);
  const requestOf = new Map(byRequest.map((l, r) => [l, r] as const));
  const old = d.linksAt(j).filter((l) => !added.includes(l) && d.link(l).tls === t);
  const approaches = new Set(old.map((l) => d.edgeOfLane(d.link(l).from)));
  const fresh: number[] = [];
  for (const l of added) {
    const link = d.link(l);
    link.tls = t;
    link.tlsIndex = program.states[0]?.length ?? 0;
    for (let k = 0; k < program.states.length; k++) program.states[k] += 'r';
    const from = d.edgeOfLane(link.from);
    if (!approaches.has(from)) {
      fresh.push(l);
      continue;
    }
    // The approach's link nearest in direction, from the same lane if it has one.
    const out = direction(d.shapeOf(link.to), false);
    const candidates = old.filter((m) => d.link(m).from === link.from);
    const pool = candidates.length
      ? candidates
      : old.filter((m) => d.edgeOfLane(d.link(m).from) === from);
    let ref = pool[0];
    let best = -Infinity;
    for (const m of pool) {
      const o = direction(d.shapeOf(d.link(m).to), false);
      const dot = o.x * out.x + o.z * out.z;
      if (dot > best) [best, ref] = [dot, m];
    }
    for (let k = 0; k < program.states.length; k++) {
      let c = program.states[k][d.link(ref).tlsIndex] ?? 'r';
      if (c === 'G') {
        const r = requestOf.get(l)!;
        const crossesGreen = [...foes[r]].some((q) => {
          const m = byRequest[q];
          return m >= 0 && program.states[k][d.link(m).tlsIndex] === 'G';
        });
        if (crossesGreen) c = 'g';
      }
      program.states[k] = setChar(program.states[k], link.tlsIndex, c);
    }
  }
  if (fresh.length) {
    const green = program.states[0].replace(/./g, 'r');
    let g = green;
    let y = green;
    for (const l of fresh) {
      g = setChar(g, d.link(l).tlsIndex, 'G');
      y = setChar(y, d.link(l).tlsIndex, 'y');
    }
    program.states.push(g, y);
    program.durations.push(15, 3);
    program.mins.push(6, 3);
    program.maxs.push(30, 3);
  }
}

function setChar(s: string, i: number, c: string): string {
  return s.slice(0, i) + c + s.slice(i + 1);
}

/** The corners of the lane ends at junction `j`, for its surface. */
function laneEnds(d: Draft, j: number): Point[] {
  const points: Point[] = [];
  for (const e of [...d.incoming(j), ...d.outgoing(j)]) {
    for (const lane of d.lanesOf(e)) {
      const s = d.shapeOf(lane);
      const end = d.toOf(e) === j;
      const k = end ? s.length - 3 : 0;
      const dir = direction(s, end);
      const w = LANE_WIDTH / 2;
      points.push(
        { x: s[k] - dir.z * w, z: s[k + 1] + dir.x * w },
        { x: s[k] + dir.z * w, z: s[k + 1] - dir.x * w },
      );
    }
  }
  return points;
}

function setJunction(d: Draft, j: number, type: string, shape?: Point[]): void {
  const t = Math.max(0, d.net.index.junctionTypes.indexOf(type));
  if (j >= d.baseJunctions) {
    const own = d.junctions[j - d.baseJunctions];
    own.type = t;
    if (shape) own.shape = shape;
  } else {
    d.junctionType.set(j, t);
    if (shape) d.junctionShape.set(j, shape);
  }
}

// ---- roundabouts -------------------------------------------------------------------------

/** Tram and rail tracks: a junction they cross is not made a roundabout. */
const TRACKS = 4 | 16;
/** Roads whose ends at a junction are this close in bearing (radians) are one leg. */
const LEG_ANGLE = (25 * Math.PI) / 180;
/** Roundabout ring radius (m, to the middle of the ring) by lanes, and the largest. */
const RING_RADIUS = [14, 18];
const MAX_RING_RADIUS = 40;
/** Speed on the ring (m/s): 25 km/h with one lane, 30 with two. */
const RING_SPEED = [6.9, 8.3];
/** Rank of a ring's roads: traffic on it goes before traffic entering. */
const RING_RANK = 9;

function edgeFlagsOf(d: Draft, e: number): number {
  return e >= d.baseEdges ? d.edges[e - d.baseEdges].flags : d.net.edgeFlags[e];
}

/** Turn of `b` from `a`, in radians, between -π and π. */
function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Parameter along segment a→b where its distance from `c` crosses `r`: the first crossing,
 * or the last (`last`). */
function crossing(a: Point, b: Point, c: Point, r: number, last: boolean): number {
  const [dx, dz] = [b.x - a.x, b.z - a.z];
  const [fx, fz] = [a.x - c.x, a.z - c.z];
  const qa = dx * dx + dz * dz;
  const qb = 2 * (fx * dx + fz * dz);
  const qc = fx * fx + fz * fz - r * r;
  const disc = Math.max(0, qb * qb - 4 * qa * qc);
  if (qa === 0) return 0;
  const t = (-qb + (last ? 1 : -1) * Math.sqrt(disc)) / (2 * qa);
  return Math.min(1, Math.max(0, t));
}

/** Shorten a lane to end (a way in) or start (a way out) `r` m from `c` (or, without
 * `apply`, only check that it can be). False if too little of it would be left. */
function trimLane(
  d: Draft,
  lane: number,
  c: Point,
  r: number,
  wayIn: boolean,
  apply: boolean,
): boolean {
  const s = d.shapeOf(lane);
  const n = s.length / 3;
  const dist = (i: number) => Math.hypot(s[i * 3] - c.x, s[i * 3 + 1] - c.z);
  const pt = (i: number) => ({ x: s[i * 3], z: s[i * 3 + 1] });
  const len = pathLength(s);
  const alongAt: number[] = [0];
  for (let i = 1; i < n; i++)
    alongAt.push(alongAt[i - 1] + Math.hypot(s[i * 3] - s[i * 3 - 3], s[i * 3 + 1] - s[i * 3 - 2]));
  let along: number | undefined;
  if (wayIn) {
    if (dist(n - 1) >= r) return true;
    for (let i = n - 2; i >= 0; i--) {
      if (dist(i) >= r) {
        along =
          alongAt[i] + crossing(pt(i), pt(i + 1), c, r, false) * (alongAt[i + 1] - alongAt[i]);
        break;
      }
    }
  } else {
    if (dist(0) >= r) return true;
    for (let i = 1; i < n; i++) {
      if (dist(i) >= r) {
        along =
          alongAt[i - 1] + crossing(pt(i - 1), pt(i), c, r, true) * (alongAt[i] - alongAt[i - 1]);
        break;
      }
    }
  }
  if (along === undefined) return false;
  const left = wayIn ? along : len - along;
  if (left < 3) return false;
  if (!apply) return true;
  const scale = d.lengthOf(lane) / Math.max(len, 0.1);
  const o = d.originOf(lane);
  if (wayIn) {
    d.setLane(lane, cut(s, 0, along), along * scale, {
      key: o.key,
      start: o.start,
      end: o.start + along * scale,
    });
  } else {
    d.setLane(lane, cut(s, along, len), (len - along) * scale, {
      key: o.key,
      start: o.start + along * scale,
      end: o.end,
    });
  }
  return true;
}

/**
 * Make junction `j` a roundabout: the roads meeting there (legs, by bearing) end at a ring
 * of one-way roads, anticlockwise, `lanes` wide. Traffic entering gives way to traffic on
 * the ring. Returns the ring's edges, or why it cannot be built.
 */
function makeRoundabout(d: Draft, j: number, lanes: number, key: string): number[] | string {
  lanes = Math.max(1, Math.min(2, Math.round(lanes)));
  const c = d.junctionPos(j);
  const links = d.linksAt(j);
  if (links.some((l) => ((d.allowOf(d.link(l).from) | d.allowOf(d.link(l).to)) & TRACKS) !== 0)) {
    return 'Tram or rail tracks cross this junction, so it cannot be a roundabout.';
  }
  const roundabout = d.net.index.flags.roundabout;
  if ([...d.incoming(j), ...d.outgoing(j)].some((e) => (edgeFlagsOf(d, e) & roundabout) !== 0)) {
    return 'This junction is on a roundabout already.';
  }
  // Legs: the roads meeting, by the bearing (anticlockwise from east) of a point 20 m along
  // each from the junction.
  const bearingOf = (e: number, wayIn: boolean) => {
    const sh = d.shapeOf(d.lanesOf(e)[0]);
    const len = pathLength(sh);
    const at = wayIn ? Math.max(0, len - 20) : Math.min(len, 20);
    const p = cut(sh, at, at + 0.01);
    return Math.atan2(-(p[1] - c.z), p[0] - c.x);
  };
  const ends = [
    ...d.incoming(j).map((e) => ({ e, wayIn: true, bearing: bearingOf(e, true) })),
    ...d.outgoing(j).map((e) => ({ e, wayIn: false, bearing: bearingOf(e, false) })),
  ].sort((x, y) => x.bearing - y.bearing);
  const groups: (typeof ends)[] = [];
  for (const end of ends) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(angleDiff(last[last.length - 1].bearing, end.bearing)) < LEG_ANGLE) {
      last.push(end);
    } else groups.push([end]);
  }
  if (groups.length > 1) {
    const [first, last] = [groups[0], groups[groups.length - 1]];
    if (Math.abs(angleDiff(last[last.length - 1].bearing, first[0].bearing)) < LEG_ANGLE) {
      first.unshift(...groups.pop()!);
    }
  }
  if (groups.length < 3) return 'A roundabout needs at least three roads meeting.';
  const legs = groups
    .map((g) => {
      const bearing = Math.atan2(
        g.reduce((acc, x) => acc + Math.sin(x.bearing), 0),
        g.reduce((acc, x) => acc + Math.cos(x.bearing), 0),
      );
      const ins = g.filter((x) => x.wayIn).map((x) => x.e);
      const outs = g.filter((x) => !x.wayIn).map((x) => x.e);
      const width = Math.max(...g.map((x) => d.lanesOf(x.e).length)) * LANE_WIDTH;
      // Along the ring either side of the leg, clear of where its lanes join.
      const gap = width + 3;
      return { bearing, ins, outs, gap };
    })
    .sort((x, y) => x.bearing - y.bearing);
  const n = legs.length;
  let radius = RING_RADIUS[lanes - 1];
  for (let i = 0; i < n; i++) {
    const [a, b] = [legs[i], legs[(i + 1) % n]];
    let span = b.bearing - a.bearing;
    if (span <= 0) span += 2 * Math.PI;
    radius = Math.max(radius, (a.gap + b.gap + 6) / span);
  }
  if (radius > MAX_RING_RADIUS) {
    return 'The roads meet at too sharp an angle for a roundabout here.';
  }
  const ringWidth = lanes * LANE_WIDTH;
  const reach = radius + ringWidth / 2 + 4;
  for (const apply of [false, true]) {
    for (const leg of legs) {
      for (const e of [...leg.ins, ...leg.outs]) {
        for (const lane of d.lanesOf(e)) {
          if (!trimLane(d, lane, c, reach, leg.ins.includes(e), apply)) {
            return 'A road into the junction is too short for a roundabout here.';
          }
        }
      }
    }
  }

  // The junction goes; a junction on the ring for each leg takes its roads.
  for (const l of links) d.removeLink(l);
  d.logic.set(j, { links: [], response: [], foes: [] });
  setJunction(d, j, 'priority', []);
  const nodes = legs.map((leg) =>
    d.addJunction(
      { x: c.x + radius * Math.cos(leg.bearing), z: c.z - radius * Math.sin(leg.bearing) },
      Math.max(0, d.net.index.junctionTypes.indexOf('priority')),
      [],
    ),
  );
  legs.forEach((leg, i) => {
    for (const e of leg.ins) d.setEdgeTo(e, nodes[i]);
    for (const e of leg.outs) d.setEdgeFrom(e, nodes[i]);
  });

  // The ring: an arc from each leg to the next, anticlockwise, lane 0 outermost.
  const top = [...legs.flatMap((l) => [...l.ins, ...l.outs])].sort(
    (x, y) => d.rankOf(y) - d.rankOf(x),
  )[0];
  const ring = legs.map((leg, i) => {
    const next = legs[(i + 1) % n];
    const a0 = leg.bearing + leg.gap / radius;
    let a1 = next.bearing - next.gap / radius;
    while (a1 <= a0) a1 += 2 * Math.PI;
    const edge = d.addEdge({
      from: nodes[i],
      to: nodes[(i + 1) % n],
      type: d.typeOf(top),
      flags: d.net.index.flags.roundabout,
      name: NONE,
      ref: NONE,
    });
    d.rankOverride.set(edge, RING_RANK);
    const steps = Math.max(2, Math.ceil((a1 - a0) / ((10 * Math.PI) / 180)));
    for (let k = 0; k < lanes; k++) {
      const r = radius + ((lanes - 1) / 2 - k) * LANE_WIDTH;
      const shape: Shape = [];
      for (let q = 0; q <= steps; q++) {
        const a = a0 + ((a1 - a0) * q) / steps;
        shape.push(c.x + r * Math.cos(a), c.z - r * Math.sin(a), 0);
      }
      d.addLane(edge, shape, RING_SPEED[lanes - 1], ROAD_ALLOW, {
        key: `${key}:${i}:${k}`,
        start: 0,
        end: pathLength(shape),
      });
    }
    return edge;
  });

  // At each leg: round the ring, onto it (giving way) and off it.
  const roadLanes = (e: number) =>
    d.lanesOf(e).filter((l) => (d.allowOf(l) & (PASSENGER | 2)) !== 0);
  legs.forEach((leg, i) => {
    const node = nodes[i];
    const into = ring[(i + n - 1) % n];
    const onto = ring[i];
    const made: number[] = [];
    const ringIn = d.lanesOf(into);
    const ringOut = d.lanesOf(onto);
    ringIn.forEach((l, k) => made.push(d.connect(l, ringOut[k], node, 's', 'M')));
    for (const e of leg.ins) {
      roadLanes(e).forEach((l, k) =>
        made.push(d.connect(l, ringOut[Math.min(k, lanes - 1)], node, 'r', 'm')),
      );
    }
    for (const e of leg.outs) {
      const out = roadLanes(e);
      if (!out.length) continue;
      ringIn.forEach((l, k) =>
        made.push(d.connect(l, out[Math.min(k, out.length - 1)], node, 'r', 'M')),
      );
    }
    junctionLogic(d, node, made);
    setJunction(d, node, 'priority', convexHull(laneEnds(d, node)));
  });
  return ring;
}

// ---- signals -----------------------------------------------------------------------------

/** Yellow after each phase (s), and the shortest and longest phase the player can set. */
const YELLOW = 3;
export const PHASE_SECONDS = { min: 5, max: 180 };

/** Heading (degrees, 0 = north, clockwise) of a direction of travel (x east, z south). */
function headingOf(dir: Point): number {
  return ((Math.atan2(dir.x, -dir.z) * 180) / Math.PI + 360) % 360;
}

/** How far a road reference is from edge `e` (m), Infinity if not on it or the other way. */
function wayDistance(d: Draft, e: number, ref: WayRef): number {
  const shape = d.shapeOf(d.lanesOf(e)[0]);
  const hit = project(shape, ref.x, ref.z);
  if (hit.distance > SNAP_JUNCTION) return Infinity;
  const turnBy = Math.abs(
    ((headingOf(directionAt(shape, hit.along)) - ref.heading + 540) % 360) - 180,
  );
  return turnBy > 40 ? Infinity : hit.distance;
}

/** The junction at `p` with traffic through it, if any (within 6 m). */
function junctionAt(d: Draft, p: JunctionPoint): number | undefined {
  let best: number | undefined;
  let bestDistance = 6;
  for (let j = 0; j < d.junctionCount; j++) {
    const q = d.junctionPos(j);
    const dist = Math.hypot(q.x - p.x, q.z - p.z);
    if (dist < bestDistance && d.linksAt(j).length > 0) [best, bestDistance] = [j, dist];
  }
  return best;
}

/** Whether link `l` gives way to `m` where nothing says which goes first: turns left give
 * way, then traffic from the right goes first. */
function givesWay(d: Draft, l: number, m: number): boolean {
  const dirs = d.net.index.linkDirs;
  const left = (x: number) => ['l', 'L', 't'].includes(dirs[d.link(x).dir] ?? 's');
  if (left(l) !== left(m)) return left(l);
  const [da, db] = [
    direction(d.shapeOf(d.link(l).from), true),
    direction(d.shapeOf(d.link(m).from), true),
  ];
  return da.x * db.z - da.z * db.x < 0;
}

/**
 * The player's traffic lights at a junction (and the junctions its program controls with
 * it): each phase lets the movements chosen go, those crossing a movement with priority on
 * a permissive green (`g`), and a yellow follows for what turns red. Road movements never
 * green are closed; movements the edit does not know (a road drawn since) go with their
 * approach, or get a phase of their own. The engine runs the program as given
 * (`tlsFixed`). No phases: the lights go, and right of way rules.
 */
function applySignal(d: Draft, edit: SignalEdit): string | undefined {
  const j = junctionAt(d, edit.junction);
  if (j === undefined) return 'There is no junction with traffic there.';
  const atJ = d.linksAt(j);
  const t0 = atJ.map((l) => d.link(l).tls).find((t) => t !== NONE);
  let links = t0 === undefined ? atJ : d.linksOfProgram(t0);
  const junctions = [...new Set(links.map((l) => d.link(l).junction))];
  const ways = new Map(junctions.map((jj) => [jj, rightOfWay(d, jj)] as const));
  const request = (l: number) => d.link(l).request;

  if (edit.phases.length === 0) {
    if (t0 === undefined) return undefined;
    for (const l of links) {
      d.setTls(l, NONE, 0xffff);
      const way = ways.get(d.link(l).junction)!;
      d.setState(l, way.response[request(l)]?.size ? 'm' : 'M');
    }
    for (const jj of junctions) setJunction(d, jj, 'priority');
    return undefined;
  }

  // Movements: the links from one road onto another.
  const groups = new Map<string, number[]>();
  for (const l of links) {
    const k = `${d.edgeOfLane(d.link(l).from)}>${d.edgeOfLane(d.link(l).to)}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const resolve = (m: Movement): number[] => {
    let best: number[] = [];
    let bestScore = Infinity;
    for (const [k, list] of groups) {
      const [f, t] = k.split('>').map(Number);
      const score = wayDistance(d, f, m.from) + wayDistance(d, t, m.to);
      if (score < bestScore) [best, bestScore] = [list, score];
    }
    return best;
  };
  const matched = edit.movements.map(resolve);
  const known = new Set(matched.flat());
  if (edit.movements.length > 0 && known.size === 0) {
    return "The signals' roads are not at this junction.";
  }
  const green = edit.phases.map((p) => new Set(p.green.flatMap((i) => matched[i] ?? [])));
  const seconds = edit.phases.map((p) =>
    Math.min(PHASE_SECONDS.max, Math.max(PHASE_SECONDS.min, p.seconds)),
  );
  const fromEdge = (l: number) => d.edgeOfLane(d.link(l).from);
  for (const list of groups.values()) {
    if (list.some((l) => known.has(l))) continue;
    const from = fromEdge(list[0]);
    let placed = false;
    for (const set of green) {
      if ([...set].some((l) => fromEdge(l) === from)) {
        for (const l of list) set.add(l);
        placed = true;
      }
    }
    if (!placed) {
      green.push(new Set(list));
      seconds.push(15);
    }
  }
  for (const l of links) {
    const road = ((d.allowOf(d.link(l).from) | d.allowOf(d.link(l).to)) & TRACKS) === 0;
    if (road && !green.some((set) => set.has(l))) d.removeLink(l);
  }
  links = links.filter((l) => !d.removedLinks.has(l));

  // Who gives way among movements green together.
  const yieldsIn = green.map(() => new Set<number>());
  green.forEach((set, p) => {
    const list = [...set];
    for (const l of list) {
      for (const m of list) {
        if (l >= m || d.link(l).junction !== d.link(m).junction) continue;
        const way = ways.get(d.link(l).junction)!;
        const [r, q] = [request(l), request(m)];
        if (!way.foes[r]?.has(q)) continue;
        if (way.response[r]?.has(q)) yieldsIn[p].add(l);
        else if (way.response[q]?.has(r)) yieldsIn[p].add(m);
        else if (givesWay(d, l, m)) {
          way.response[r].add(q);
          yieldsIn[p].add(l);
        } else {
          way.response[q].add(r);
          yieldsIn[p].add(m);
        }
      }
    }
  });
  for (const [jj, way] of ways) d.logic.set(jj, way);

  const program: Program = { durations: [], mins: [], maxs: [], states: [] };
  const push = (states: string, seconds: number) => {
    program.states.push(states);
    program.durations.push(seconds);
    program.mins.push(seconds);
    program.maxs.push(seconds);
  };
  green.forEach((set, p) => {
    const states = links.map((l) => (set.has(l) ? (yieldsIn[p].has(l) ? 'g' : 'G') : 'r')).join('');
    push(states, seconds[p]);
    const next = green[(p + 1) % green.length];
    const yellow = links.map((l, k) => (set.has(l) && !next.has(l) ? 'y' : states[k])).join('');
    if (yellow !== states) push(yellow, YELLOW);
  });
  const t = t0 ?? d.programCount;
  if (t0 === undefined) d.newPrograms.push(program);
  else d.programs.set(t0, program);
  d.fixedPrograms.add(t);
  links.forEach((l, k) => d.setTls(l, t, k));
  for (const jj of junctions) setJunction(d, jj, 'traffic_light');
  return undefined;
}

/** Build the network loaded with `edits` made: the roads drawn, in order, then the
 * junctions changed, in order. `index` finds roads to join. */
export function buildNetwork(
  net: RoadNetwork,
  edits: readonly NetworkEdit[],
  index?: RoadIndex,
): BuiltNetwork {
  const types = [...net.index.types];
  const d = new Draft(net, types);
  const built: number[][] = edits.map(() => []);
  const problems: BuiltNetwork['problems'] = [];
  const touched = new Map<number, Set<number>>();
  edits.forEach((road, r) => {
    if (road.kind !== 'road') return;
    const key = `r:${roadKey(road)}`;
    if (road.points.length < 2) {
      problems.push({ road: r, reason: 'A road needs a start and an end.' });
      return;
    }
    const first = road.points[0];
    const last = road.points[road.points.length - 1];
    const ends = [findEnd(d, index, first), findEnd(d, index, last)];
    if (!ends[0] || !ends[1]) {
      problems.push({ road: r, reason: 'Start and end the road on a road or at a junction.' });
      return;
    }
    const width = road.lanes * LANE_WIDTH * (road.oneway ? 1 : 2);
    const junctions = ends.map((end) =>
      end!.kind === 'junction' ? end!.junction : cutRoad(d, end!.edges, end!.point, width + 6),
    );
    if (junctions[0] === junctions[1]) {
      problems.push({ road: r, reason: 'The road starts and ends at the same junction.' });
      return;
    }
    // The line between the junctions, trimmed clear of them.
    const line = [
      d.junctionPos(junctions[0]),
      ...road.points.slice(1, -1),
      d.junctionPos(junctions[1]),
    ];
    const shape = line.flatMap((p) => [p.x, p.z, 0]);
    const total = pathLength(shape);
    const r0 = junctionRadius(d, junctions[0], width);
    const r1 = junctionRadius(d, junctions[1], width);
    if (total < r0 + r1 + 10) {
      problems.push({ road: r, reason: 'The road is too short.' });
      return;
    }
    const trimmed = cut(shape, r0, total - r1);
    const pts: Point[] = [];
    for (let i = 0; i < trimmed.length; i += 3) pts.push({ x: trimmed[i], z: trimmed[i + 1] });
    const edges = [addRoadEdges(d, road, key, pts, junctions[0], junctions[1], false)];
    if (!road.oneway) edges.push(addRoadEdges(d, road, key, pts, junctions[1], junctions[0], true));
    built[r] = edges;
    for (const j of junctions) {
      const set = touched.get(j) ?? new Set<number>();
      for (const e of edges) set.add(e);
      touched.set(j, set);
    }
  });
  // Junctions: links for the new roads, right of way, signals and a surface to draw.
  const splitJunctions = new Set<number>();
  for (let j = d.baseJunctions; j < d.junctionCount; j++) splitJunctions.add(j);
  for (const [j, added] of touched) {
    // Links of the cut roads at their new junctions count as added too.
    const made = connectJunction(d, j, added);
    const all = splitJunctions.has(j) ? [...d.linksAt(j)] : made;
    junctionLogic(d, j, all);
    const points = laneEnds(d, j);
    if (j >= d.baseJunctions) d.junctions[j - d.baseJunctions].shape = convexHull(points);
    else {
      const { start, count } = net.junctionPoints(j);
      for (let p = start; p < start + count; p++) {
        points.push({ x: net.junctionShape[p * 3], z: net.junctionShape[p * 3 + 1] });
      }
      d.junctionShape.set(j, convexHull(points));
      const type = net.index.junctionTypes[net.junctionType[j]];
      if (type === 'dead_end') d.junctionType.set(j, net.index.junctionTypes.indexOf('priority'));
    }
  }
  // Junctions made roundabouts and signals set, in order.
  edits.forEach((edit, r) => {
    let problem: string | undefined;
    if (edit.kind === 'roundabout') {
      const j = junctionAt(d, edit.junction);
      const ring =
        j === undefined
          ? 'There is no junction with traffic there.'
          : makeRoundabout(d, j, edit.lanes, roundaboutKey(edit));
      if (typeof ring === 'string') problem = ring;
      else built[r] = ring;
    } else if (edit.kind === 'signal') problem = applySignal(d, edit);
    if (problem) problems.push({ road: r, reason: problem });
  });
  return { ...finish(d, net), origins: d.origins, roads: built, problems, types };
}

function roundaboutKey(edit: RoundaboutEdit): string {
  return `o:${edit.junction.x.toFixed(1)},${edit.junction.z.toFixed(1)}:${edit.lanes}`;
}

/** A key for a drawn road that stays the same from build to build. */
function roadKey(road: RoadEdit): string {
  const p = road.points;
  return `${road.type}${road.lanes}${road.oneway ? 'o' : ''}:${p[0].x.toFixed(1)},${p[0].z.toFixed(1)}>${p[p.length - 1].x.toFixed(1)},${p[p.length - 1].z.toFixed(1)}`;
}

/** The draft as arrays: what was loaded, changed and added, links sorted by lane. */
function finish(
  d: Draft,
  net: RoadNetwork,
): Pick<BuiltNetwork, 'arrays' | 'laneShape' | 'junctionShape'> {
  const a = d.a;
  const out: Record<string, TypedArray> = {};
  const grow = <T extends TypedArray>(
    base: ArrayLike<number>,
    ctor: { new (n: number): T },
    extra: ArrayLike<number>,
  ): T => {
    const arr = new ctor(base.length + extra.length);
    arr.set(base);
    arr.set(extra, base.length);
    return arr;
  };
  const nl = d.lanes;
  const ne = d.edges;
  const nj = d.junctions;

  // Junctions.
  out.junctionPos = grow(
    a.junctionPos as Float32Array,
    Float32Array,
    nj.flatMap((j) => [j.x, j.z]),
  );
  out.junctionType = grow(
    a.junctionType as Uint8Array,
    Uint8Array,
    nj.map((j) => j.type),
  );
  for (const [j, t] of d.junctionType) (out.junctionType as Uint8Array)[j] = t;
  const jShapes: number[][] = [];
  for (let j = 0; j < d.junctionCount; j++) {
    const own = j >= d.baseJunctions ? nj[j - d.baseJunctions].shape : d.junctionShape.get(j);
    if (own) jShapes.push(own.flatMap((p) => [p.x, p.z, 0]));
    else {
      const { start, count } = net.junctionPoints(j);
      jShapes.push(Array.from(net.junctionShape.subarray(start * 3, (start + count) * 3)));
    }
  }
  const jOffsets = new Uint32Array(d.junctionCount + 1);
  let total = 0;
  jShapes.forEach((s, j) => {
    total += s.length / 3;
    jOffsets[j + 1] = total;
  });
  const junctionShape = new Float32Array(total * 3);
  jShapes.forEach((s, j) => junctionShape.set(s, jOffsets[j] * 3));
  out.junctionShapeOffsets = jOffsets;

  // Edges.
  out.edgeFrom = grow(
    a.edgeFrom as Uint32Array,
    Uint32Array,
    ne.map((e) => e.from),
  );
  out.edgeTo = grow(
    a.edgeTo as Uint32Array,
    Uint32Array,
    ne.map((e) => e.to),
  );
  for (const [e, to] of d.edgeTo) (out.edgeTo as Uint32Array)[e] = to;
  for (const [e, from] of d.edgeFrom) (out.edgeFrom as Uint32Array)[e] = from;
  out.edgeType = grow(
    a.edgeType as Uint16Array,
    Uint16Array,
    ne.map((e) => e.type),
  );
  out.edgeFlags = grow(
    a.edgeFlags as Uint8Array,
    Uint8Array,
    ne.map((e) => e.flags),
  );
  out.edgeName = grow(
    a.edgeName as Uint32Array,
    Uint32Array,
    ne.map((e) => e.name),
  );
  out.edgeRef = grow(
    a.edgeRef as Uint32Array,
    Uint32Array,
    ne.map((e) => e.ref),
  );
  out.edgeLaneStart = grow(
    a.edgeLaneStart as Uint32Array,
    Uint32Array,
    ne.map((e) => e.laneStart),
  );
  out.edgeLaneCount = grow(
    a.edgeLaneCount as Uint8Array,
    Uint8Array,
    ne.map((e) => e.laneCount),
  );

  // Lanes and their shapes.
  out.laneEdge = grow(
    a.laneEdge as Uint32Array,
    Uint32Array,
    nl.map((l) => l.edge),
  );
  out.laneLength = grow(
    a.laneLength as Float32Array,
    Float32Array,
    nl.map((l) => l.length),
  );
  for (const [l, len] of d.laneLength) (out.laneLength as Float32Array)[l] = len;
  out.laneSpeed = grow(
    a.laneSpeed as Float32Array,
    Float32Array,
    nl.map((l) => l.speed),
  );
  out.laneWidth = grow(
    a.laneWidth as Float32Array,
    Float32Array,
    nl.map((l) => l.width),
  );
  out.laneAllow = grow(
    a.laneAllow as Uint16Array,
    Uint16Array,
    nl.map((l) => l.allow),
  );
  out.laneNext = grow(
    a.laneNext as Uint32Array,
    Uint32Array,
    nl.map((l) => l.next),
  );
  for (const [l, next] of d.laneNext) (out.laneNext as Uint32Array)[l] = next;
  const lOffsets = new Uint32Array(d.laneCount + 1);
  const baseOffsets = net.laneShapeOffsets;
  let points = 0;
  for (let l = 0; l < d.laneCount; l++) {
    const own = l >= d.baseLanes ? nl[l - d.baseLanes].shape : d.laneShape.get(l);
    points += own ? own.length / 3 : baseOffsets[l + 1] - baseOffsets[l];
    lOffsets[l + 1] = points;
  }
  const laneShape = new Float32Array(points * 3);
  if (d.laneShape.size === 0)
    laneShape.set(net.laneShape.subarray(0, baseOffsets[d.baseLanes] * 3));
  for (let l = 0; l < d.laneCount; l++) {
    const own = l >= d.baseLanes ? nl[l - d.baseLanes].shape : d.laneShape.get(l);
    if (own) laneShape.set(own, lOffsets[l] * 3);
    else if (d.laneShape.size) {
      laneShape.set(
        net.laneShape.subarray(baseOffsets[l] * 3, baseOffsets[l + 1] * 3),
        lOffsets[l] * 3,
      );
    }
  }
  out.laneShapeOffsets = lOffsets;

  // Links: those loaded and added and not taken away, sorted by the lane they leave.
  const allLinks = d.baseLinks + d.links.length;
  const fromOf = (l: number) =>
    l >= d.baseLinks
      ? d.links[l - d.baseLinks].from
      : (d.linkFrom.get(l) ?? (a.linkFrom as Uint32Array)[l]);
  const froms = Uint32Array.from({ length: allLinks }, (_, l) => fromOf(l));
  const order = Array.from({ length: allLinks }, (_, l) => l).filter((l) => !d.removedLinks.has(l));
  order.sort((x, y) => froms[x] - froms[y] || x - y);
  const nLinks = order.length;
  const pick = <T extends TypedArray>(
    ctor: { new (n: number): T },
    get: (l: Link) => number,
  ): T => {
    const arr = new ctor(nLinks);
    order.forEach((l, k) => (arr[k] = get(d.link(l))));
    return arr;
  };
  out.linkFrom = pick(Uint32Array, (l) => l.from);
  out.linkTo = pick(Uint32Array, (l) => l.to);
  out.linkVia = pick(Uint32Array, (l) => l.via);
  out.linkJunction = pick(Uint32Array, (l) => l.junction);
  out.linkRequest = pick(Uint16Array, (l) => l.request);
  out.linkDir = pick(Uint8Array, (l) => l.dir);
  out.linkState = pick(Uint8Array, (l) => l.state);
  out.linkTls = pick(Uint32Array, (l) => l.tls);
  out.linkTlsIndex = pick(Uint16Array, (l) => l.tlsIndex);
  const linkOffsets = new Uint32Array(d.laneCount + 1);
  for (const f of out.linkFrom as Uint32Array) linkOffsets[f + 1]++;
  for (let l = 0; l < d.laneCount; l++) linkOffsets[l + 1] += linkOffsets[l];
  out.laneLinkOffsets = linkOffsets;

  // Right of way: junctions with roads added get a new block at the end.
  const logic: number[] = [];
  const linkCount = grow(
    a.junctionLinkCount as Uint16Array,
    Uint16Array,
    nj.map(() => 0),
  );
  const logicOffset = grow(
    a.junctionLogicOffset as Uint32Array,
    Uint32Array,
    nj.map(() => 0),
  );
  const baseLogic = a.logic as Uint32Array;
  for (const [j, block] of d.logic) {
    const n = block.links.length;
    const words = Math.max(1, Math.ceil(n / 32));
    linkCount[j] = n;
    logicOffset[j] = baseLogic.length + logic.length;
    for (let r = 0; r < n; r++) {
      for (const set of [block.response[r], block.foes[r]]) {
        const row = new Array(words).fill(0);
        for (const q of set) row[q >> 5] |= 1 << (q & 31);
        logic.push(...row.map((w) => w >>> 0));
      }
    }
  }
  out.junctionLinkCount = linkCount;
  out.junctionLogicOffset = logicOffset;
  out.logic = grow(baseLogic, Uint32Array, logic);

  // Signal programs, those changed in place.
  const tlsOffsets = a.tlsPhaseOffsets as Uint32Array;
  const nTls = tlsOffsets.length - 1;
  const durations: number[] = [];
  const mins: number[] = [];
  const maxs: number[] = [];
  const states: number[] = [];
  const phaseOffsets: number[] = [0];
  const programOffsets: number[] = [0];
  const stateOffsets = a.phaseStateOffsets as Uint32Array;
  const chars = a.phaseStates as Uint8Array;
  for (let t = 0; t < nTls + d.newPrograms.length; t++) {
    const own = t < nTls ? d.programs.get(t) : d.newPrograms[t - nTls];
    if (own) {
      own.states.forEach((s, k) => {
        durations.push(own.durations[k]);
        mins.push(own.mins[k]);
        maxs.push(own.maxs[k]);
        for (let i = 0; i < s.length; i++) states.push(s.charCodeAt(i));
        phaseOffsets.push(states.length);
      });
    } else {
      for (let k = tlsOffsets[t]; k < tlsOffsets[t + 1]; k++) {
        durations.push((a.phaseDuration as Float32Array)[k]);
        mins.push((a.phaseMinDur as Float32Array)[k]);
        maxs.push((a.phaseMaxDur as Float32Array)[k]);
        for (let i = stateOffsets[k]; i < stateOffsets[k + 1]; i++) states.push(chars[i]);
        phaseOffsets.push(states.length);
      }
    }
    programOffsets.push(durations.length);
  }
  out.tlsPhaseOffsets = Uint32Array.from(programOffsets);
  const added = d.newPrograms.map(() => 0);
  out.tlsOffset = grow(a.tlsOffset as Float32Array, Float32Array, added);
  out.tlsType = grow(a.tlsType as Uint8Array, Uint8Array, added);
  const fixed = new Uint8Array(nTls + d.newPrograms.length);
  const fixedType = Math.max(0, d.net.index.tlsTypes.indexOf('static'));
  for (const t of d.fixedPrograms) {
    fixed[t] = 1;
    (out.tlsType as Uint8Array)[t] = fixedType;
  }
  out.tlsFixed = fixed;
  out.phaseDuration = Float32Array.from(durations);
  out.phaseMinDur = Float32Array.from(mins);
  out.phaseMaxDur = Float32Array.from(maxs);
  out.phaseStateOffsets = Uint32Array.from(phaseOffsets);
  out.phaseStates = Uint8Array.from(states);
  return { arrays: out, laneShape, junctionShape };
}

/**
 * Where the lanes of one build went in the next, for the engine to move its vehicles
 * (sim/src/patch.rs `LanePiece`): lanes are matched by what they were made from, and a lane
 * goes on as whichever lanes of the next build cover its stretch. Lanes whole as loaded in
 * both builds are left out.
 */
export function lanePieces(
  previous: ReadonlyMap<number, LaneOrigin>,
  next: ReadonlyMap<number, LaneOrigin>,
  baseLength: (lane: number) => number,
): LanePieceRec[] {
  const segments = new Map<string, { lane: number; start: number; end: number }[]>();
  // Lanes nothing leads onto any more (a junction made again): what is on them leaves.
  const gone = new Set<string>();
  for (const [lane, o] of next) {
    if (o.gone) {
      gone.add(o.key);
      continue;
    }
    const list = segments.get(o.key) ?? [];
    list.push({ lane, start: o.start, end: o.end });
    segments.set(o.key, list);
  }
  for (const list of segments.values()) list.sort((x, y) => x.start - y.start);
  const covering = (key: string) => {
    const own = segments.get(key);
    if (own) return own;
    if (gone.has(key)) return [];
    // A lane as loaded that the next build leaves whole.
    const m = /^b(\d+)$/.exec(key);
    return m ? [{ lane: Number(m[1]), start: 0, end: baseLength(Number(m[1])) }] : [];
  };
  const out: LanePieceRec[] = [];
  const add = (old: number, o: LaneOrigin) => {
    const list = o.gone ? [] : covering(o.key).filter((s) => s.end > o.start && s.start < o.end);
    if (!list.length) {
      out.push({ old, from: 0, lane: NONE, shift: 0 });
      return;
    }
    for (const s of list) {
      out.push({
        old,
        from: Math.max(0, s.start - o.start),
        lane: s.lane,
        shift: o.start - s.start,
      });
    }
  };
  for (const [old, o] of previous) add(old, o);
  // Lanes whole as loaded before and cut now.
  for (const [lane, o] of next) {
    const m = /^b(\d+)$/.exec(o.key);
    if (!m) continue;
    const base = Number(m[1]);
    if (lane === base && !previous.has(base)) {
      add(base, { key: o.key, start: 0, end: baseLength(base) });
    }
  }
  return out;
}
