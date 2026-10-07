/**
 * Lots for zoning (M5a): free land along streets that buildings can grow on, made by the
 * pipeline (pipeline/zoning.py), and the City's planned land use.
 */
import { type PackedIndex, type TypedArray, loadPacked } from '../data/packed';
import { DATA_URL } from '../manifest';

export interface PlanClass {
  id: string;
  label: string;
  color: string;
  /** Whether the plan lets lots be laid on it. */
  lots: boolean;
}

export interface ZoningIndex extends PackedIndex {
  lot: { frontage: number; depth: number };
  planClasses: PlanClass[];
  noPlan: number;
  stats: Record<string, unknown>;
}

/** No edge (`loudEdge`). */
export const NO_EDGE = 0xffffffff;

/** Size (m) of the grid cells lots are found by. */
const CELL = 100;

export class Lots {
  readonly count: number;
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** Direction along the street (radians, atan2(dz, dx)); the lot lies to its right. */
  readonly angle: Float32Array;
  readonly frontage: Uint8Array;
  readonly depth: Uint8Array;
  /** The street (edge of today's network) each lot faces. */
  readonly edge: Uint32Array;
  /** Planned use (index into `planClasses`), `noPlan` outside the City. */
  readonly plan: Uint8Array;
  /** ESA WorldCover class under the lot. */
  readonly cover: Uint8Array;
  /** Median storeys of the buildings within 150 m (0: none). */
  readonly context: Uint8Array;
  /** Green land cover within 200 m (percent). */
  readonly green: Uint8Array;
  /** The nearest motorway, trunk or primary road within 250 m (`NO_EDGE`: none), and how
   * far it is (m). */
  readonly loudEdge: Uint32Array;
  readonly loudDistance: Uint8Array;
  readonly planClasses: PlanClass[];
  readonly noPlan: number;
  /** The plan's polygons: per polygon its first ring, per ring its first point, points x, z. */
  readonly planPolygonRings: Uint32Array;
  readonly planRingPoints: Uint32Array;
  readonly planPoints: Float32Array;
  readonly planClass: Uint8Array;
  /** The next lot along the street on the same side (-1: none), so neighbouring lots can
   * join into larger plots. */
  readonly next: Int32Array;
  private readonly cells = new Map<number, number[]>();

  constructor(arrays: Record<string, TypedArray>, index: ZoningIndex) {
    this.x = arrays.lotX as Float32Array;
    this.z = arrays.lotZ as Float32Array;
    this.angle = arrays.lotAngle as Float32Array;
    this.frontage = arrays.lotFrontage as Uint8Array;
    this.depth = arrays.lotDepth as Uint8Array;
    this.edge = arrays.lotEdge as Uint32Array;
    this.plan = arrays.lotPlan as Uint8Array;
    this.cover = arrays.lotCover as Uint8Array;
    this.context = arrays.lotContext as Uint8Array;
    const n = this.x.length;
    this.green = (arrays.lotGreen as Uint8Array | undefined) ?? new Uint8Array(n);
    this.loudEdge =
      (arrays.lotLoudEdge as Uint32Array | undefined) ?? new Uint32Array(n).fill(NO_EDGE);
    this.loudDistance =
      (arrays.lotLoudDistance as Uint8Array | undefined) ?? new Uint8Array(n).fill(255);
    this.planPolygonRings = arrays.planPolygonRings as Uint32Array;
    this.planRingPoints = arrays.planRingPoints as Uint32Array;
    this.planPoints = arrays.planPoints as Float32Array;
    this.planClass = arrays.planClass as Uint8Array;
    this.planClasses = index.planClasses;
    this.noPlan = index.noPlan;
    this.count = this.x.length;
    this.next = new Int32Array(this.count).fill(-1);
    // Lots of a street side were laid one after another: a neighbour is a lot before or
    // after it in the list, on the same street, facing the same way, one frontage along.
    for (let i = 0; i < this.count; i++) {
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= this.count || this.edge[j] !== this.edge[i]) continue;
        const ux = Math.cos(this.angle[i]);
        const uz = Math.sin(this.angle[i]);
        const dx = this.x[j] - this.x[i];
        const dz = this.z[j] - this.z[i];
        const along = dx * ux + dz * uz;
        const across = Math.abs(dx * uz - dz * ux);
        const gap = (this.frontage[i] + this.frontage[j]) / 2;
        if (Math.abs(along - gap) < 1.5 && across < 1.5) this.next[i] = j;
      }
    }
    for (let i = 0; i < this.count; i++) {
      const key = cellKey(Math.floor(this.x[i] / CELL), Math.floor(this.z[i] / CELL));
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    }
  }

  /** Corners of lot `i` (scene x, z): the front along the street, then the back. */
  corners(i: number): [number, number][] {
    const ux = Math.cos(this.angle[i]);
    const uz = Math.sin(this.angle[i]);
    // Right of the street's direction (x east, z south).
    const [rx, rz] = [-uz, ux];
    const f = this.frontage[i] / 2;
    const d = this.depth[i] / 2;
    const [cx, cz] = [this.x[i], this.z[i]];
    return [
      [cx - ux * f - rx * d, cz - uz * f - rz * d],
      [cx + ux * f - rx * d, cz + uz * f - rz * d],
      [cx + ux * f + rx * d, cz + uz * f + rz * d],
      [cx - ux * f + rx * d, cz - uz * f + rz * d],
    ];
  }

  /** Area of lot `i` (m²). */
  area(i: number): number {
    return this.frontage[i] * this.depth[i];
  }

  /** Lots whose centre is within `radius` m of (x, z). */
  within(x: number, z: number, radius: number): number[] {
    const out: number[] = [];
    const r2 = radius * radius;
    for (let cz = Math.floor((z - radius) / CELL); cz <= Math.floor((z + radius) / CELL); cz++) {
      for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++) {
        for (const i of this.cells.get(cellKey(cx, cz)) ?? []) {
          if ((this.x[i] - x) ** 2 + (this.z[i] - z) ** 2 <= r2) out.push(i);
        }
      }
    }
    return out;
  }

  /** The planned use of lot `i` (undefined outside the City). */
  planOf(i: number): PlanClass | undefined {
    return this.plan[i] === this.noPlan ? undefined : this.planClasses[this.plan[i]];
  }
}

function cellKey(cx: number, cz: number): number {
  // Cells within ±50 km of the origin: unique keys in a safe integer.
  return (cz + 1000) * 2000 + (cx + 1000);
}

export async function loadLots(indexPath: string): Promise<Lots> {
  const response = await fetch(DATA_URL + indexPath);
  if (!response.ok) throw new Error(`Could not load ${indexPath} (HTTP ${response.status})`);
  const index = (await response.json()) as ZoningIndex;
  const dir = indexPath.slice(0, indexPath.lastIndexOf('/') + 1);
  const arrays = await loadPacked(DATA_URL + dir + index.file, index);
  return new Lots(arrays, index);
}
