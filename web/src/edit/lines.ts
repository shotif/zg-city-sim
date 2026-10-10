/**
 * New public transport lines (M9c): where their stops go on the roads (buses) or tram
 * tracks (trams), and the engine's records of a line (sim/src/edits.rs `kind::LINE`).
 *
 * A line keeps its stops by position, as edits keep roads, so that it finds its roads
 * again on a network built from newer OpenStreetMap data.
 */
import type { RoadNetwork } from '../world/roadNetwork';
import { RoadIndex, angleBetween, headingOf } from './roadIndex';

export type LineMode = 'bus' | 'tram';

/** A stop of a new line: where it is (scene x, z, m) and its name. */
export interface LineStop {
  x: number;
  z: number;
  name: string;
}

/** A stop goes on a road (track) within this far of it (m), running within this angle
 * (degrees) of the way the line goes there, else on the nearest. */
export const STOP_REACH = 40;
const STOP_ANGLE = 75;

/** Engine vehicle types (sim/src/vtype.rs). */
export const LINE_VTYPE: Record<LineMode, number> = { bus: 2, tram: 3 };

/** Record kinds (sim/src/edits.rs `kind`). */
const LINE = 8;
const LINE_HOURS = 9;
const LINE_STOP = 10;

/** An index of the roads buses may take, or the tram tracks, of a network. */
export function stopIndex(net: RoadNetwork, mode: LineMode): RoadIndex {
  return new RoadIndex(net, (e) => {
    if (net.isInternal(e)) return false;
    const lane = net.edgeLaneStart[e];
    for (let k = 0; k < net.edgeLaneCount[e]; k++) if (net.allows(lane + k, mode)) return true;
    return false;
  });
}

/** Where each of `stops` goes, in order: (edge, fraction along it) on a road of `index`
 * near it, running the way the line goes from the stop before to the one after; undefined
 * for a stop with no road near. */
export function placeStops(
  index: RoadIndex,
  stops: readonly LineStop[],
): ([number, number] | undefined)[] {
  return stops.map((s, i) => {
    const prev = stops[Math.max(0, i - 1)];
    const next = stops[Math.min(stops.length - 1, i + 1)];
    const near = index.near(s.x, s.z, STOP_REACH);
    const moves = next.x !== prev.x || next.z !== prev.z;
    const way = moves ? headingOf(next.x - prev.x, next.z - prev.z) : undefined;
    const pick =
      (way === undefined
        ? undefined
        : near.find((c) => angleBetween(c.heading, way) <= STOP_ANGLE)) ?? near[0];
    return pick ? [pick.edge, index.along(pick.edge, s.x, s.z)] : undefined;
  });
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function bits(value: number): number {
  f32[0] = value;
  return u32[0];
}

/** The engine's records of one way of a line: route `route`, its stops placed. */
export function lineWords(
  route: number,
  mode: LineMode,
  line: { headway: number; first: number; last: number },
  placed: readonly [number, number][],
): number[] {
  const out = [
    LINE,
    route,
    LINE_VTYPE[mode] | (placed.length << 8),
    bits(line.headway),
    LINE_HOURS,
    bits(line.first),
    bits(line.last),
    0,
  ];
  for (const [edge, frac] of placed) out.push(LINE_STOP, edge, 0, bits(frac));
  return out;
}

/** Trips a day one way of a line runs: one every `headway` s from `first` to `last`. */
export function tripsADay(line: { headway: number; first: number; last: number }): number {
  return line.last < line.first
    ? 0
    : Math.floor((line.last - line.first) / line.headway + 1e-6) + 1;
}

/** A tap within this far (m) of a stop of the line's mode puts the line's stop there. */
export const SNAP_STOP = 60;

/** The engine's question for a line's way (`TrafficEngine.planLine`): its vehicle type,
 * then each stop placed (edge, fraction as f32 bits). */
export function planWords(vtype: number, placed: readonly [number, number][]): Uint32Array {
  const out = [vtype];
  for (const [edge, frac] of placed) out.push(edge, bits(frac));
  return Uint32Array.from(out);
}

/** The engine's answer: the roads one way, how many stops it serves, how far (m) and how
 * long (s) it runs; null if it cannot run. */
export function readPlan(
  words: Uint32Array,
): { path: number[]; served: number; metres: number; seconds: number } | null {
  if (words.length < 3) return null;
  const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  const roads = words[0];
  const path = Array.from(words.subarray(1, 1 + roads));
  const served = words[1 + roads];
  const last = 1 + roads + 2 * served;
  return { path, served, metres: floats[last + 1], seconds: floats[last] };
}
