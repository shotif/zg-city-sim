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
  readonly planClasses: PlanClass[];
  readonly noPlan: number;
  /** The plan's polygons: per polygon its first ring, per ring its first point, points x, z. */
  readonly planPolygonRings: Uint32Array;
  readonly planRingPoints: Uint32Array;
  readonly planPoints: Float32Array;
  readonly planClass: Uint8Array;
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
    this.planPolygonRings = arrays.planPolygonRings as Uint32Array;
    this.planRingPoints = arrays.planRingPoints as Uint32Array;
    this.planPoints = arrays.planPoints as Float32Array;
    this.planClass = arrays.planClass as Uint8Array;
    this.planClasses = index.planClasses;
    this.noPlan = index.noPlan;
    this.count = this.x.length;
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
