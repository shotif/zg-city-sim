/**
 * Services' coverage (M20b): whether the places at primary schools, kindergartens and GP
 * practices within reach of a home are enough for the residents within reach of them, by
 * the two-step floating catchment method. Each service's places are shared among the
 * residents within its reach (times the share of them who need one); a home's coverage is
 * the sum of those shares from the services within its reach. One means places for all.
 *
 * Reach is a straight line: 1 km to a kindergarten, 1.5 km to a primary school, 3 km to
 * health care (estimates of how far families go). Need per resident is the City's: its
 * 64,860 pupils and about 34,100 children in or waiting for a kindergarten (enrolled, and
 * left without a place in 2023) among its 767,131 residents; everyone needs a GP.
 */
import type { Service, ServiceKind } from '../game/serviceKinds';
import type { RoadNetwork } from '../world/roadNetwork';

export type NeedKind = Extract<ServiceKind, 'school' | 'kindergarten' | 'health'>;
export const NEED_KINDS: readonly NeedKind[] = ['school', 'kindergarten', 'health'];

/** How far residents go to each (m, straight line; estimates). */
export const REACH: Record<NeedKind, number> = {
  school: 1500,
  kindergarten: 1000,
  health: 3000,
};

/** Places each resident needs: the City's pupils, children in or waiting for a
 * kindergarten, and GP patients, per resident (2021 census: 767,131). */
export const NEED: Record<NeedKind, number> = {
  school: 64_860 / 767_131,
  kindergarten: (32_390 + 1_700) / 767_131,
  health: 1,
};

/** Residents at a point. */
export interface Homes {
  x: Float32Array;
  z: Float32Array;
  residents: Float32Array;
}

/** Cells of the raster coverage is measured on (m): a home or lot takes its cell's, so
 * reach is counted between cell centres (within about 180 m). */
export const CELL = 250;

/** A raster over the points given, CELL across. */
class Raster {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;

  constructor(xs: ArrayLike<number>[], zs: ArrayLike<number>[], margin: number) {
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const x of xs)
      for (let i = 0; i < x.length; i++) [x0, x1] = [Math.min(x0, x[i]), Math.max(x1, x[i])];
    for (const z of zs)
      for (let i = 0; i < z.length; i++) [z0, z1] = [Math.min(z0, z[i]), Math.max(z1, z[i])];
    if (!Number.isFinite(x0)) [x0, z0, x1, z1] = [0, 0, 0, 0];
    this.x0 = x0 - margin;
    this.z0 = z0 - margin;
    this.nx = Math.ceil((x1 - x0 + 2 * margin) / CELL) + 1;
    this.nz = Math.ceil((z1 - z0 + 2 * margin) / CELL) + 1;
  }

  cell(x: number, z: number): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / CELL)));
    const j = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / CELL)));
    return j * this.nx + i;
  }

  /** Each cell whose centre is within `r` of (x, z). */
  disc(x: number, z: number, r: number, visit: (c: number) => void): void {
    const [i0, i1] = [Math.floor((x - r - this.x0) / CELL), Math.floor((x + r - this.x0) / CELL)];
    const [j0, j1] = [Math.floor((z - r - this.z0) / CELL), Math.floor((z + r - this.z0) / CELL)];
    const r2 = r * r;
    for (let j = Math.max(0, j0); j <= Math.min(this.nz - 1, j1); j++) {
      const dz = this.z0 + (j + 0.5) * CELL - z;
      for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) {
        const dx = this.x0 + (i + 0.5) * CELL - x;
        if (dx * dx + dz * dz <= r2) visit(j * this.nx + i);
      }
    }
  }
}

/** Coverage at points (x, z) of each kind, from `services` and the residents in `homes`. */
export function coverage(
  services: readonly Service[],
  homes: Homes,
  at: { x: ArrayLike<number>; z: ArrayLike<number> },
): Record<NeedKind, Float32Array> {
  const margin = Math.max(...Object.values(REACH));
  const grid = new Raster(
    [homes.x, at.x, services.map((s) => s.x)],
    [homes.z, at.z, services.map((s) => s.z)],
    margin,
  );
  const residents = new Float64Array(grid.nx * grid.nz);
  for (let k = 0; k < homes.x.length; k++)
    residents[grid.cell(homes.x[k], homes.z[k])] += homes.residents[k];
  const cellOf = new Int32Array(at.x.length);
  for (let i = 0; i < at.x.length; i++) cellOf[i] = grid.cell(at.x[i], at.z[i]);
  const out = {} as Record<NeedKind, Float32Array>;
  const sums = new Float64Array(grid.nx * grid.nz);
  for (const kind of NEED_KINDS) {
    const r = REACH[kind];
    sums.fill(0);
    for (const s of services) {
      if (s.kind !== kind || !(s.places > 0)) continue;
      // Step one: the service's places per resident in need within its reach.
      let need = 0;
      grid.disc(s.x, s.z, r, (c) => {
        need += residents[c];
      });
      need *= NEED[kind];
      if (need <= 0) continue;
      const ratio = s.places / need;
      // Step two: its share counts for every home within its reach.
      grid.disc(s.x, s.z, r, (c) => {
        sums[c] += ratio;
      });
    }
    const values = new Float32Array(at.x.length);
    for (let i = 0; i < at.x.length; i++) values[i] = sums[cellOf[i]];
    out[kind] = values;
  }
  return out;
}

/** Residents' coverage summed up: residents whose coverage of each kind is below one, and
 * the places short for them. */
export function shortfall(
  c: Record<NeedKind, Float32Array>,
  residents: ArrayLike<number>,
  include: (i: number) => boolean = () => true,
): Record<NeedKind, { residents: number; short: number; total: number }> {
  const out = {} as Record<NeedKind, { residents: number; short: number; total: number }>;
  for (const kind of NEED_KINDS) {
    let [under, short, total] = [0, 0, 0];
    for (let i = 0; i < residents.length; i++) {
      if (!include(i)) continue;
      const n = residents[i];
      total += n;
      const v = c[kind][i];
      if (v < 1) {
        under += n;
        short += n * NEED[kind] * (1 - v);
      }
    }
    out[kind] = { residents: under, short, total };
  }
  return out;
}

/** A coverage's colour on the map: red where places are far short, amber where somewhat,
 * green where there are enough. */
export function coverageColor(v: number): [number, number, number] {
  if (!Number.isFinite(v)) return [0.55, 0.55, 0.55];
  const stops: [number, [number, number, number]][] = [
    [0, [0.8, 0.15, 0.12]],
    [0.6, [0.93, 0.6, 0.15]],
    [1, [0.25, 0.68, 0.36]],
  ];
  if (v >= 1) return stops[2][1];
  let k = 1;
  while (k < stops.length - 1 && v > stops[k][0]) k++;
  const [v0, c0] = stops[k - 1];
  const [v1, c1] = stops[k];
  const t = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
  return [0, 1, 2].map((i) => c0[i] + (c1[i] - c0[i]) * t) as [number, number, number];
}

/** Today's homes as points (each street's residents at its middle) from the demand
 * (pipeline/demand.py): residents count as they are in the City, and beyond it by their
 * trip weight over the counties' (`countyWeight`, grow/demand.ts). `inCity` marks the
 * City's streets (`demandDistrict` below `districts`). */
export function homesFromDemand(
  net: RoadNetwork,
  arrays: {
    demandEdge: ArrayLike<number>;
    demandHome: ArrayLike<number>;
    demandDistrict?: ArrayLike<number>;
  },
  districts: number,
  countyWeight: number,
): Homes & { inCity: Uint8Array } {
  const n = arrays.demandEdge.length;
  const out = {
    x: new Float32Array(n),
    z: new Float32Array(n),
    residents: new Float32Array(n),
    inCity: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const e = arrays.demandEdge[i];
    if (e >= net.edgeLaneStart.length) continue;
    const { start, count } = net.lanePoints(net.edgeLaneStart[e]);
    if (count === 0) continue;
    const p = start + Math.floor(count / 2);
    out.x[i] = net.laneShape[p * 3];
    out.z[i] = net.laneShape[p * 3 + 1];
    const city = arrays.demandDistrict ? arrays.demandDistrict[i] < districts : true;
    out.inCity[i] = city ? 1 : 0;
    out.residents[i] = city ? arrays.demandHome[i] : arrays.demandHome[i] / countyWeight;
  }
  return out;
}

/** Homes grown on zoned lots, joined to `base` (their residents at their first lot). */
export function withGrown(
  base: Homes & { inCity: Uint8Array },
  grown: readonly { x: number; z: number; residents: number }[],
): Homes & { inCity: Uint8Array } {
  const n = base.x.length + grown.length;
  const out = {
    x: new Float32Array(n),
    z: new Float32Array(n),
    residents: new Float32Array(n),
    inCity: new Uint8Array(n),
  };
  out.x.set(base.x);
  out.z.set(base.z);
  out.residents.set(base.residents);
  out.inCity.set(base.inCity);
  grown.forEach((g, k) => {
    const i = base.x.length + k;
    out.x[i] = g.x;
    out.z[i] = g.z;
    out.residents[i] = g.residents;
    out.inCity[i] = 1;
  });
  return out;
}

/** How fast homes start on a lot whose services score `v` (0-1, the mean of its
 * coverages, each up to one): as usual at one, half as fast with none within reach
 * (`MIN_START`; an estimate: homes are built on the City's edges today with few services
 * near, but more slowly). */
export const MIN_START = 0.5;
export function startFactor(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return MIN_START + (1 - MIN_START) * Math.min(1, Math.max(0, v));
}

/** A point's services score: the mean of its coverages, each up to one. */
export function serviceScore(c: Record<NeedKind, Float32Array>, i: number): number {
  return NEED_KINDS.reduce((a, k) => a + Math.min(1, c[k][i]), 0) / NEED_KINDS.length;
}
