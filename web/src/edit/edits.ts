/**
 * The edit model: changes to the road network the player makes (M4a), kept as a list.
 *
 * Edits name roads by a point on them and their heading, not by edge id: CI rebuilds the
 * network from newer OpenStreetMap data on every deploy, and ids change with it. A saved or
 * shared list is matched to the network it is loaded on (`resolveEdits`). The list is kept
 * in local storage and shared as a link (compressed into the URL's fragment) or a file.
 */
import {
  NEW_ROAD_TYPES,
  type NetworkEdit,
  type RoadEdit,
  type RoundaboutEdit,
  type SignalEdit,
  type WayRef,
} from './builder';
import type { RoadIndex } from './roadIndex';

/** A road (one direction of travel): a point on it (scene x, z, m) and its heading there
 * (degrees, 0 = north, clockwise), with its name for display. */
export interface RoadRef {
  x: number;
  z: number;
  heading: number;
  name?: string;
}

/** A junction with traffic lights, by its position. */
export interface JunctionRef {
  x: number;
  z: number;
  name?: string;
}

/** Vehicle-class bits (pipeline/simnet.py VCLASS_BITS). */
export const VCLASS = {
  passenger: 1,
  bus: 2,
  tram: 4,
  truck: 8,
  rail: 16,
  taxi: 256,
  emergency: 512,
} as const;
/** Who may use a bus lane: buses, taxis and emergency vehicles, as on Zagreb's. */
export const BUS_LANE = VCLASS.bus | VCLASS.taxi | VCLASS.emergency;

export type Edit =
  /** Closed to cars and trucks (buses and trams keep their routes). */
  | { kind: 'close'; road: RoadRef }
  /** One lane (0 = rightmost) closed to cars and trucks. */
  | { kind: 'closeLane'; road: RoadRef; lane: number }
  /** Speed limit on every lane. */
  | { kind: 'speed'; road: RoadRef; kmh: number }
  /** A lane (0 = rightmost) for buses only. */
  | { kind: 'busLane'; road: RoadRef; lane: number }
  /** No turning from one road onto another. */
  | { kind: 'ban'; from: RoadRef; to: RoadRef }
  /** Green time of one phase of a junction's signal program. */
  | { kind: 'green'; junction: JunctionRef; phase: number; seconds: number }
  /** A new road, a junction made a roundabout, a junction's traffic lights as the player
   * sets them (edit/builder.ts): built into the network before the other edits apply. */
  | RoadEdit
  | RoundaboutEdit
  | SignalEdit;

/** Edits built into the network (`buildNetwork`), not applied by the engine. */
export function isNetworkEdit(edit: Edit): edit is NetworkEdit {
  return edit.kind === 'road' || edit.kind === 'roundabout' || edit.kind === 'signal';
}

/** Record kinds the engine reads (sim/src/edits.rs `kind`). */
const KIND = { close: 1, closeLane: 2, speed: 3, laneClasses: 4, ban: 5, green: 6 } as const;

/** An edit matched to the network it is loaded on. */
export interface ResolvedEdit {
  edit: Edit;
  /** Edges it changes (for drawing): the road, or both roads of a turn. */
  edges: number[];
  /** Signal program, for green-time edits. */
  tls?: number;
  /** The engine's four-word record. */
  record: [number, number, number, number];
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function floatBits(value: number): number {
  f32[0] = value;
  return u32[0];
}

/** Match edits to the network: those whose roads or junction it has, and the rest. New
 * roads and junctions are left out: they are built into the network (`buildNetwork`). */
export function resolveEdits(
  index: RoadIndex,
  edits: readonly Edit[],
): { resolved: ResolvedEdit[]; missing: Edit[] } {
  const resolved: ResolvedEdit[] = [];
  const missing: Edit[] = [];
  for (const edit of edits) {
    if (isNetworkEdit(edit)) continue;
    const r = resolveEdit(index, edit);
    if (r) resolved.push(r);
    else missing.push(edit);
  }
  return { resolved, missing };
}

function resolveEdit(index: RoadIndex, edit: Exclude<Edit, NetworkEdit>): ResolvedEdit | undefined {
  switch (edit.kind) {
    case 'close':
    case 'closeLane':
    case 'speed':
    case 'busLane': {
      const edge = index.find(edit.road);
      if (edge === undefined) return undefined;
      const record: ResolvedEdit['record'] =
        edit.kind === 'close'
          ? [KIND.close, edge, 0, 0]
          : edit.kind === 'closeLane'
            ? [KIND.closeLane, edge, edit.lane, 0]
            : edit.kind === 'speed'
              ? [KIND.speed, edge, 0, floatBits(edit.kmh / 3.6)]
              : [KIND.laneClasses, edge, edit.lane, floatBits(BUS_LANE)];
      return { edit, edges: [edge], record };
    }
    case 'ban': {
      const from = index.find(edit.from);
      const to = index.find(edit.to);
      if (from === undefined || to === undefined) return undefined;
      return { edit, edges: [from, to], record: [KIND.ban, from, to, 0] };
    }
    case 'green': {
      const tls = index.findSignal(edit.junction);
      if (tls === undefined) return undefined;
      return {
        edit,
        edges: index.signalEdges(tls),
        tls,
        record: [KIND.green, tls, edit.phase, floatBits(edit.seconds)],
      };
    }
  }
}

/** The engine's records of resolved edits, four words each. */
export function editWords(resolved: readonly ResolvedEdit[]): Uint32Array {
  return Uint32Array.from(resolved.flatMap((r) => r.record));
}

/** Whether two edits change the same thing (a later one replaces an earlier one). */
export function sameTarget(a: Edit, b: Edit): boolean {
  const near = (p: { x: number; z: number }, q: { x: number; z: number }) =>
    Math.hypot(p.x - q.x, p.z - q.z) < 1;
  const sameRoad = (p: RoadRef, q: RoadRef) =>
    near(p, q) && Math.abs(((p.heading - q.heading + 540) % 360) - 180) < 5;
  if (a.kind !== b.kind) {
    // A junction is a roundabout or has the lights set, not both.
    const junctions = ['roundabout', 'signal'];
    if (junctions.includes(a.kind) && junctions.includes(b.kind)) {
      const [p, q] = [a, b] as (RoundaboutEdit | SignalEdit)[];
      return near(p.junction, q.junction);
    }
    // A lane can be closed or a bus lane, not both.
    const lanes = ['closeLane', 'busLane'];
    if (lanes.includes(a.kind) && lanes.includes(b.kind)) {
      const [p, q] = [a, b] as Extract<Edit, { kind: 'closeLane' | 'busLane' }>[];
      return sameRoad(p.road, q.road) && p.lane === q.lane;
    }
    return false;
  }
  switch (a.kind) {
    case 'close':
    case 'speed':
      return sameRoad(a.road, (b as typeof a).road);
    case 'closeLane':
    case 'busLane':
      return sameRoad(a.road, (b as typeof a).road) && a.lane === (b as typeof a).lane;
    case 'ban':
      return sameRoad(a.from, (b as typeof a).from) && sameRoad(a.to, (b as typeof a).to);
    case 'green':
      return near(a.junction, (b as typeof a).junction) && a.phase === (b as typeof a).phase;
    case 'road': {
      const q = (b as typeof a).points;
      return a.points.length === q.length && a.points.every((p, i) => near(p, q[i]));
    }
    case 'roundabout':
    case 'signal':
      return near(a.junction, (b as typeof a).junction);
  }
}

/** The list with `edit` added, replacing an earlier edit of the same thing. */
export function withEdit(edits: readonly Edit[], edit: Edit): Edit[] {
  return [...edits.filter((e) => !sameTarget(e, edit)), edit];
}

const roadName = (r: RoadRef) => r.name ?? 'an unnamed road';
const laneName = (lane: number) => (lane === 0 ? 'right lane' : `lane ${lane + 1} from the right`);

/** One line describing an edit, for the list of edits. */
export function describeEdit(edit: Edit): string {
  switch (edit.kind) {
    case 'close':
      return `${roadName(edit.road)} closed`;
    case 'closeLane':
      return `${roadName(edit.road)}: ${laneName(edit.lane)} closed`;
    case 'speed':
      return `${roadName(edit.road)}: ${edit.kmh} km/h`;
    case 'busLane':
      return `${roadName(edit.road)}: ${laneName(edit.lane)} for buses`;
    case 'ban':
      return `No turn from ${roadName(edit.from)} onto ${roadName(edit.to)}`;
    case 'green':
      return `${edit.junction.name ?? 'Signals'}: phase ${edit.phase + 1} green ${edit.seconds} s`;
    case 'road': {
      let metres = 0;
      for (let i = 1; i < edit.points.length; i++) {
        const [p, q] = [edit.points[i - 1], edit.points[i]];
        metres += Math.hypot(q.x - p.x, q.z - p.z);
      }
      const lanes = `${edit.lanes} lane${edit.lanes === 1 ? '' : 's'}${edit.oneway ? ' one way' : ' each way'}`;
      const what = edit.bridge
        ? 'New bridge'
        : `New ${NEW_ROAD_TYPES[edit.type].label.toLowerCase()}`;
      return `${what}, ${(metres / 1000).toFixed(1)} km, ${lanes}, ${edit.kmh} km/h`;
    }
    case 'roundabout':
      return `Roundabout at ${edit.junction.name ?? 'a junction'}, ${edit.lanes} lane${edit.lanes === 1 ? '' : 's'}`;
    case 'signal': {
      const at = edit.junction.name ?? 'a junction';
      if (edit.phases.length === 0) return `No traffic lights at ${at}`;
      const cycle = edit.phases.reduce((acc, p) => acc + p.seconds + 3, 0);
      return `Traffic lights at ${at}: ${edit.phases.length} phase${edit.phases.length === 1 ? '' : 's'}, about ${cycle} s cycle`;
    }
  }
}

// ---- saving and sharing ------------------------------------------------------------------

export const EDITS_VERSION = 1;

interface SavedEdits {
  version: number;
  edits: Edit[];
}

const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;

function compact(edit: Edit): Edit {
  const road = (r: RoadRef): RoadRef => ({
    x: round(r.x),
    z: round(r.z),
    heading: Math.round(r.heading),
    ...(r.name ? { name: r.name } : {}),
  });
  const junction = <T extends { x: number; z: number }>(j: T): T => ({
    ...j,
    x: round(j.x),
    z: round(j.z),
  });
  switch (edit.kind) {
    case 'ban':
      return { ...edit, from: road(edit.from), to: road(edit.to) };
    case 'roundabout':
      return { ...edit, junction: junction(edit.junction) };
    case 'signal':
      return {
        ...edit,
        junction: junction(edit.junction),
        movements: edit.movements.map((m) => ({ from: road(m.from), to: road(m.to) })),
      };
    case 'green':
      return {
        ...edit,
        junction: { ...edit.junction, x: round(edit.junction.x), z: round(edit.junction.z) },
      };
    case 'road':
      return { ...edit, points: edit.points.map((p) => ({ x: round(p.x), z: round(p.z) })) };
    default:
      return { ...edit, road: road(edit.road) };
  }
}

export function serializeEdits(edits: readonly Edit[]): string {
  const saved: SavedEdits = { version: EDITS_VERSION, edits: edits.map(compact) };
  return JSON.stringify(saved);
}

const KINDS = new Set([
  'close',
  'closeLane',
  'speed',
  'busLane',
  'ban',
  'green',
  'road',
  'roundabout',
  'signal',
]);

/** Edits from a saved list; throws if it is not one. Unknown kinds are dropped. */
export function parseEdits(text: string): Edit[] {
  const saved = JSON.parse(text) as Partial<SavedEdits>;
  if (typeof saved !== 'object' || saved === null || !Array.isArray(saved.edits)) {
    throw new Error('Not a list of edits');
  }
  const isRoad = (r: unknown): r is RoadRef | WayRef =>
    typeof r === 'object' &&
    r !== null &&
    Number.isFinite((r as RoadRef).x) &&
    Number.isFinite((r as RoadRef).z) &&
    Number.isFinite((r as RoadRef).heading);
  const isJunction = (j: unknown) =>
    typeof j === 'object' &&
    j !== null &&
    Number.isFinite((j as RoadRef).x) &&
    Number.isFinite((j as RoadRef).z);
  return saved.edits.filter((e): e is Edit => {
    if (typeof e !== 'object' || e === null || !KINDS.has(e.kind)) return false;
    switch (e.kind) {
      case 'ban':
        return isRoad(e.from) && isRoad(e.to);
      case 'green':
        return (
          Number.isFinite(e.junction?.x) &&
          Number.isFinite(e.junction?.z) &&
          Number.isInteger(e.phase) &&
          Number.isFinite(e.seconds)
        );
      case 'speed':
        return isRoad(e.road) && Number.isFinite(e.kmh);
      case 'closeLane':
      case 'busLane':
        return isRoad(e.road) && Number.isInteger(e.lane);
      case 'road':
        return (
          Array.isArray(e.points) &&
          e.points.length >= 2 &&
          e.points.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.z)) &&
          e.type in NEW_ROAD_TYPES &&
          Number.isInteger(e.lanes) &&
          e.lanes >= 1 &&
          e.lanes <= 4 &&
          typeof e.oneway === 'boolean' &&
          Number.isFinite(e.kmh) &&
          typeof e.bridge === 'boolean'
        );
      case 'roundabout':
        return isJunction(e.junction) && (e.lanes === 1 || e.lanes === 2);
      case 'signal':
        return (
          isJunction(e.junction) &&
          Array.isArray(e.movements) &&
          e.movements.every((m) => isRoad(m?.from) && isRoad(m?.to)) &&
          Array.isArray(e.phases) &&
          e.phases.every(
            (p) =>
              Number.isFinite(p?.seconds) &&
              Array.isArray(p.green) &&
              p.green.every((k) => Number.isInteger(k) && k >= 0 && k < e.movements.length),
          )
        );
      default:
        return isRoad(e.road);
    }
  });
}

const STORAGE_KEY = 'zg-city-sim:edits';

/** Edits saved in this browser (none if storage is unavailable). */
export function loadSavedEdits(storage: Storage | undefined = globalThis.localStorage): Edit[] {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    return text ? parseEdits(text) : [];
  } catch {
    return [];
  }
}

export function saveEdits(
  edits: readonly Edit[],
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    if (edits.length === 0) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, serializeEdits(edits));
  } catch {
    // Private windows and full storage: edits live for this visit only.
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Edits as a URL fragment parameter value: deflated JSON in base64url. */
export async function encodeEditsForUrl(edits: readonly Edit[]): Promise<string> {
  const json = new TextEncoder().encode(serializeEdits(edits));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeEditsFromUrl(value: string): Promise<Edit[]> {
  const json = await pipe(fromBase64Url(value), new DecompressionStream('deflate-raw'));
  return parseEdits(new TextDecoder().decode(json));
}
