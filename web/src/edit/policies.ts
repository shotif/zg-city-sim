/**
 * Policies on areas (M18): the areas on offer, and the roads into an area, where a
 * congestion charge's cameras stand. The engine works the same out for itself
 * (sim/src/policy.rs).
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

/** Area of a polygon (m²). */
export function areaOf(area: readonly AreaPoint[]): number {
  let twice = 0;
  for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
    twice += area[j].x * area[i].z - area[i].x * area[j].z;
  }
  return Math.abs(twice) / 2;
}

/** Roads cars may drive into the area by: edges from a junction outside it to one inside. */
export function roadsInto(net: RoadNetwork, area: readonly AreaPoint[]): number[] {
  const n = net.junctionPos.length / 2;
  const isIn = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    isIn[j] = inside(area, { x: net.junctionPos[2 * j], z: net.junctionPos[2 * j + 1] }) ? 1 : 0;
  }
  const roads: number[] = [];
  for (let e = 0; e < net.edgeFrom.length; e++) {
    if (net.isInternal(e) || isIn[net.edgeFrom[e]] || !isIn[net.edgeTo[e]]) continue;
    const lane = net.edgeLaneStart[e];
    let cars = false;
    for (let l = lane; l < lane + net.edgeLaneCount[e]; l++) cars ||= (net.laneAllow[l] & 1) !== 0;
    if (cars) roads.push(e);
  }
  return roads;
}

/** "07:00" for minutes after midnight. */
export function clock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
