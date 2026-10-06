import * as THREE from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

import type { HeightFn } from './roadGeometry';
import type { RoadNetwork } from './roadNetwork';

/**
 * Live road closures from the City of Zagreb (data.zagreb.hr "prometnice", refreshed every
 * 3 minutes). The feed has no CORS headers, so a scheduled GitHub Action copies it to the
 * repository's `live-data` branch (.github/workflows/live-data.yml), served from
 * raw.githubusercontent.com.
 */
export const LIVE_CLOSURES_URL =
  import.meta.env.VITE_LIVE_CLOSURES_URL ??
  'https://raw.githubusercontent.com/shotif/zg-city-sim/live-data/closures.json';

/** One closure as the City publishes it (Waze CIFS-like). */
export interface Closure {
  type?: string;
  subtype?: string;
  street?: string;
  /** "lat lon lat lon …" */
  polyline?: string;
  direction?: string;
  /** Local wall-clock time, although written with a +00:00 offset. */
  expectedStartTime?: string;
  expectedEndTime?: string;
}

export interface ClosureFeed {
  source: string;
  /** When the copy was made (UTC, ISO). */
  fetched: string;
  closures: Closure[];
}

/** A closure placed on the network. */
export interface PlacedClosure {
  closure: Closure;
  edges: number[];
  /** Middle of the closure (scene x, z). */
  x: number;
  z: number;
}

export async function loadClosures(url = LIVE_CLOSURES_URL): Promise<ClosureFeed> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as ClosureFeed;
}

// HTRS96/TM (EPSG:3765): transverse Mercator on GRS80, central meridian 16.5°E,
// scale 0.9999, false easting 500 km (Snyder, Map Projections: A Working Manual, p. 61).
const A = 6_378_137;
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const EP2 = E2 / (1 - E2);
const K0 = 0.9999;
const LON0 = (16.5 * Math.PI) / 180;
const FALSE_EASTING = 500_000;

/** Easting and northing (EPSG:3765, m) of a WGS84/ETRS89 longitude and latitude. */
export function htrsTm(lon: number, lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const n = A / Math.sqrt(1 - E2 * sin * sin);
  const t = tan * tan;
  const c = EP2 * cos * cos;
  const a = ((lon * Math.PI) / 180 - LON0) * cos;
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  const m =
    A *
    ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi));
  const x =
    K0 *
    n *
    (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120);
  const y =
    K0 *
    (m +
      n *
        tan *
        ((a * a) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720));
  return [FALSE_EASTING + x, y];
}

/** "2026-10-06T22:00" for a feed timestamp (its clock value, ignoring the offset). */
function wallClock(stamp: string | undefined): string | undefined {
  return stamp && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stamp) ? stamp.slice(0, 16) : undefined;
}

/** The current wall-clock time in Zagreb, "YYYY-MM-DDTHH:MM". */
export function zagrebNow(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zagreb',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** Closures in force at `now` (a Zagreb wall-clock time as from `zagrebNow`). */
export function activeClosures(closures: readonly Closure[], now: string): Closure[] {
  return closures.filter((c) => {
    const start = wallClock(c.expectedStartTime);
    const end = wallClock(c.expectedEndTime);
    return (!start || start <= now) && (!end || now <= end);
  });
}

/** "6 Oct, 22:00" for a feed timestamp. */
export function formatUntil(stamp: string | undefined): string | undefined {
  const clock = wallClock(stamp);
  if (!clock) return undefined;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[Number(clock.slice(5, 7)) - 1] ?? clock.slice(5, 7);
  return `${Number(clock.slice(8, 10))} ${month}, ${clock.slice(11, 16)}`;
}

/** Points of a closure's polyline in scene coordinates. */
export function closurePoints(
  closure: Closure,
  origin: { e: number; n: number },
): [number, number][] {
  const values = (closure.polyline ?? '').trim().split(/\s+/).map(Number);
  const points: [number, number][] = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const [lat, lon] = [values[i], values[i + 1]];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const [e, n] = htrsTm(lon, lat);
    points.push([e - origin.e, origin.n - n]);
  }
  return points;
}

/** Distance from (x, z) to a polyline, and the polyline's unit direction there. */
function nearest(
  points: readonly [number, number][],
  x: number,
  z: number,
): { distance: number; dx: number; dz: number } {
  let best = { distance: Infinity, dx: 0, dz: 0 };
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const vx = bx - ax;
    const vz = bz - az;
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2)) : 0;
    const distance = Math.hypot(x - (ax + t * vx), z - (az + t * vz));
    if (distance < best.distance) {
      const len = Math.sqrt(len2) || 1;
      best = { distance, dx: vx / len, dz: vz / len };
    }
  }
  return best;
}

/** Street name for comparing: lower case, without "ulica" and the like. */
function streetKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ulica|cesta|avenija|trg)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Edges this close (m) to a closure's line, all along their length, are closed. */
const MATCH_DISTANCE = 20;

/** The network edges a closure covers: along its line, in its direction (unless both
 * directions are closed), on the street it names. */
export function matchClosure(
  net: RoadNetwork,
  points: readonly [number, number][],
  closure: Closure,
): number[] {
  if (points.length < 2) return [];
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const street = closure.street ? streetKey(closure.street) : '';
  const bothWays = closure.direction !== 'ONE_DIRECTION';
  const edges: number[] = [];
  for (let e = 0; e < net.edgeCount; e++) {
    if (net.isInternal(e)) continue;
    const lane = net.edgeLaneStart[e];
    if (!net.allows(lane, 'passenger')) continue;
    const { start, count } = net.lanePoints(lane);
    if (count < 2) continue;
    const sx = net.laneShape[start * 3];
    const sz = net.laneShape[start * 3 + 1];
    if (sx < minX - 50 || sx > maxX + 50 || sz < minZ - 50 || sz > maxZ + 50) {
      continue;
    }
    if (street) {
      const name = net.nameOf(e);
      if (!name || !streetKey(name).includes(street)) continue;
    }
    let along = true;
    for (const k of [0, count >> 1, count - 1]) {
      const p = start + k;
      const x = net.laneShape[p * 3];
      const z = net.laneShape[p * 3 + 1];
      if (nearest(points, x, z).distance > MATCH_DISTANCE) {
        along = false;
        break;
      }
    }
    if (!along) continue;
    if (!bothWays) {
      const ex = net.laneShape[(start + count - 1) * 3] - sx;
      const ez = net.laneShape[(start + count - 1) * 3 + 1] - sz;
      const mid = nearest(points, sx + ex / 2, sz + ez / 2);
      const len = Math.hypot(ex, ez) || 1;
      if ((ex * mid.dx + ez * mid.dz) / len < 0.5) continue;
    }
    edges.push(e);
  }
  return edges;
}

/** Place the closures in force on the network. */
export function placeClosures(
  net: RoadNetwork,
  closures: readonly Closure[],
  origin: { e: number; n: number },
): PlacedClosure[] {
  const placed: PlacedClosure[] = [];
  for (const closure of closures) {
    const points = closurePoints(closure, origin);
    const edges = matchClosure(net, points, closure);
    if (edges.length === 0) continue;
    const [x, z] = points[points.length >> 1];
    placed.push({ closure, edges, x, z });
  }
  return placed;
}

const LIFT = 8;
const CLOSED_COLOR = 0xe0102f;

/** Closed roads drawn in red over the map. */
export class ClosureLayer {
  readonly object = new THREE.Group();

  constructor(
    private readonly net: RoadNetwork,
    private readonly height: HeightFn,
  ) {
    this.object.name = 'road closures';
  }

  show(closures: readonly PlacedClosure[]): void {
    for (const child of [...this.object.children]) {
      this.object.remove(child);
      if (child instanceof LineSegments2) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    const net = this.net;
    const positions: number[] = [];
    for (const { edges } of closures) {
      for (const e of edges) {
        const lane = net.edgeLaneStart[e];
        const { start, count } = net.lanePoints(lane);
        for (let k = 0; k < count - 1; k++) {
          for (const p of [start + k, start + k + 1]) {
            const x = net.laneShape[p * 3];
            const z = net.laneShape[p * 3 + 1];
            positions.push(x, this.height(x, z) + net.laneShape[p * 3 + 2] + LIFT, z);
          }
        }
      }
    }
    if (positions.length === 0) return;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(new Float32Array(positions));
    const lines = new LineSegments2(
      geometry,
      new THREE.Line2NodeMaterial({ color: CLOSED_COLOR, linewidth: 5, worldUnits: false }),
    );
    lines.frustumCulled = false;
    lines.renderOrder = 3;
    this.object.add(lines);
  }

  markerY(x: number, z: number): number {
    return this.height(x, z) + LIFT;
  }
}
