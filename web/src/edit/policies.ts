/**
 * Policies on areas (M18): the areas on offer, the roads into an area, where a congestion
 * charge's cameras stand, and the roads over its edge, where a lorry ban's signs stand. The
 * engine works the same out for itself (sim/src/policy.rs).
 */
import type { RoadNetwork } from '../world/roadNetwork';

export interface AreaPoint {
  x: number;
  z: number;
}

/** Areas on offer for a policy (scene x, z). Donji grad is the City's district (its
 * register of districts, simplified to 25 m): about 3 km² between Ilica and Vlaška ulica to
 * the north and the railway to the south, from Ulica Republike Austrije in the west to
 * beyond Avenija Marina Držića in the east. */
export const AREA_PRESETS: readonly { name: string; area: readonly AreaPoint[] }[] = [
  {
    name: 'Donji grad',
    area: [
      [72, 1009],
      [-319, 1007],
      [-998, 1187],
      [-869, 924],
      [-1254, 557],
      [-1424, 470],
      [-1579, 445],
      [-1516, -21],
      [-1068, 80],
      [-809, -2],
      [-571, -16],
      [-93, 18],
      [127, 88],
      [481, 116],
      [461, -100],
      [569, -70],
      [1242, -95],
      [1477, -180],
      [1494, -110],
      [1559, -116],
      [2035, 497],
      [1372, 753],
      [1263, 834],
      [495, 989],
      [664, 992],
      [413, 1010],
      [539, 1055],
      [279, 1069],
    ].map(([x, z]) => ({ x, z })),
  },
];

/** Most points an area may have (sim/src/policy.rs `MAX_POINTS`). */
export const MAX_AREA_POINTS = 256;
/** Junctions within this distance of an area's edge (m) count as outside it, so the roads
 * along the edge are free (sim/src/policy.rs `EDGE_FREE`). */
export const EDGE_FREE = 40;

/** Whether `p` is inside the polygon `area` (even-odd rule, as the engine decides it). */
export function inside(area: readonly AreaPoint[], p: AreaPoint): boolean {
  let isIn = false;
  for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
    const a = area[i];
    const b = area[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) {
      isIn = !isIn;
    }
  }
  return area.length >= 3 && isIn;
}

/** Distance from `p` to the nearest side of the polygon `area` (m). */
export function distanceToEdge(area: readonly AreaPoint[], p: AreaPoint): number {
  let best = Infinity;
  for (let i = 0; i < area.length; i++) {
    const a = area[i];
    const b = area[(i + 1) % area.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz));
  }
  return best;
}

/** Whether a junction at `p` is in the area: inside it and more than `EDGE_FREE` from its
 * edge, as the engine decides it. */
export function within(area: readonly AreaPoint[], p: AreaPoint): boolean {
  return inside(area, p) && distanceToEdge(area, p) > EDGE_FREE;
}

/** Area of a polygon (m²). */
export function areaOf(area: readonly AreaPoint[]): number {
  let twice = 0;
  for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
    twice += area[j].x * area[i].z - area[i].x * area[j].z;
  }
  return Math.abs(twice) / 2;
}

/** For each junction, whether it is in the area (`within`). */
function junctionsWithin(net: RoadNetwork, area: readonly AreaPoint[]): Uint8Array {
  const n = net.junctionPos.length / 2;
  const isIn = new Uint8Array(n);
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of area) {
    [x0, z0, x1, z1] = [Math.min(x0, p.x), Math.min(z0, p.z), Math.max(x1, p.x), Math.max(z1, p.z)];
  }
  for (let j = 0; j < n; j++) {
    const p = { x: net.junctionPos[2 * j], z: net.junctionPos[2 * j + 1] };
    isIn[j] = p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1 && within(area, p) ? 1 : 0;
  }
  return isIn;
}

/** Whether vehicles of class bits `vclass` (1 cars, 8 lorries: `VCLASS` in edits.ts) may
 * drive a lane of edge `e`. */
function allows(net: RoadNetwork, e: number, vclass: number): boolean {
  const lane = net.edgeLaneStart[e];
  for (let l = lane; l < lane + net.edgeLaneCount[e]; l++) {
    if ((net.laneAllow[l] & vclass) !== 0) return true;
  }
  return false;
}

/** Roads cars may drive into the area by: edges from a junction outside it (or along its
 * edge) to one inside. */
export function roadsInto(net: RoadNetwork, area: readonly AreaPoint[]): number[] {
  const isIn = junctionsWithin(net, area);
  const roads: number[] = [];
  for (let e = 0; e < net.edgeFrom.length; e++) {
    if (net.isInternal(e) || isIn[net.edgeFrom[e]] || !isIn[net.edgeTo[e]]) continue;
    if (allows(net, e, 1)) roads.push(e);
  }
  return roads;
}

/** Roads lorries may drive over the area's edge by, in or out (a lorry ban's, M18c). */
export function roadsAcross(net: RoadNetwork, area: readonly AreaPoint[]): number[] {
  const isIn = junctionsWithin(net, area);
  const roads: number[] = [];
  for (let e = 0; e < net.edgeFrom.length; e++) {
    if (net.isInternal(e) || (isIn[net.edgeFrom[e]] ?? 0) === (isIn[net.edgeTo[e]] ?? 0)) continue;
    if (allows(net, e, 8)) roads.push(e);
  }
  return roads;
}

/** "from 07:00 to 19:00", or "all day", for a policy's hours (minutes after midnight). */
export function hoursText(from: number, to: number): string {
  return to - from >= 1440 ? 'all day' : `from ${clock(from)} to ${clock(to)}`;
}

/** "07:00" for minutes after midnight. */
export function clock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
