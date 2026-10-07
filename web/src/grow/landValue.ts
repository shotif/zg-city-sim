/**
 * Land value (M5d): how well placed each lot is, as an index where 100 is the best-placed
 * part of the map when first measured.
 *
 * - *Accessibility*: residents and jobs within reach by car on the travel times the
 *   simulation measures, each weighted by exp(-time / 6 min) up to 20 minutes (gravity
 *   accessibility, measured by the engine from one street in each square 1.5 km across and
 *   interpolated between them). Land value follows it to the power 0.75, so a place with a
 *   tenth of the centre's reach is worth about a sixth as much.
 * - *Green land* within 200 m (trees, grass, water) adds up to 10 %.
 * - *Traffic noise* takes 0.6 % per dB above 55 dB(A), at most 25 %: the level from the
 *   vehicles measured on the lot's street and on the nearest motorway, trunk or primary
 *   road within 250 m.
 *
 * The weights are estimates: hedonic studies of house prices put noise at about 0.5-1 % per
 * dB and a park nearby at a few per cent; the power on accessibility is chosen so building
 * land near the centre comes out several times dearer than on the City's edge, as asking
 * prices are.
 */
import { type Lots, NO_EDGE } from './lots';

/** Size (m) of the cells accessibility is measured for: 1,092 hold lots. */
export const ACCESS_CELL = 1500;
/** Homes and jobs `t` s away count exp(-t / REACH_DECAY), up to REACH_MAX s. */
export const REACH_DECAY = 360;
export const REACH_MAX = 1200;
const ACCESS_POWER = 0.75;
/** Value added by green land around, all of it green. */
const GREEN_BONUS = 0.1;
/** Traffic noise: value lost per dB(A) above QUIET, at most MAX_NOISE_LOSS. */
const QUIET = 55;
const NOISE_LOSS = 0.006;
const MAX_NOISE_LOSS = 0.25;
/** Distance (m) from a lot's street to its houses' windows. */
const STREET_DISTANCE = 12;
/** Share of a new measurement of accessibility in the value used, the rest from earlier
 * ones: land value follows the day's traffic slowly. */
const BLEND = 0.5;

/**
 * Traffic noise (dB(A), equivalent level over an hour) `distance` m from a road carrying
 * `perHour` vehicles: the UK's Calculation of Road Traffic Noise (L10 = 42.2 + 10 log q at
 * 10 m), less 3 dB from L10 to the equivalent level, falling 3 dB per doubling of distance.
 * An estimate: it leaves out speed, lorries and the road surface.
 */
export function noiseLevel(perHour: number, distance: number): number {
  return (
    39.2 + 10 * Math.log10(Math.max(perHour, 1)) - 10 * Math.log10(Math.max(distance, 10) / 10)
  );
}

/** Share of value traffic noise of `db` dB(A) takes. */
export function noiseLoss(db: number): number {
  return Math.min(MAX_NOISE_LOSS, Math.max(0, (db - QUIET) * NOISE_LOSS));
}

/** Colours of the land value map, from 0 to 100 and above. */
export const VALUE_STOPS: [number, string][] = [
  [0, '#3b2a6b'],
  [15, '#3f5fa8'],
  [35, '#2fa39a'],
  [60, '#9fd35a'],
  [100, '#fde74c'],
];

/** The land value map's colour of a value (r, g, b in 0-1; grey: not measured). */
export function valueColor(v: number): [number, number, number] {
  if (!Number.isFinite(v)) return [0.55, 0.55, 0.55];
  const hex = (c: string) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16) / 255);
  let k = 1;
  while (k < VALUE_STOPS.length - 1 && v > VALUE_STOPS[k][0]) k++;
  const [v0, c0] = VALUE_STOPS[k - 1];
  const [v1, c1] = VALUE_STOPS[k];
  const t = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
  const a = hex(c0);
  const b = hex(c1);
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as [number, number, number];
}

const cellKey = (i: number, j: number) => (i + 1000) * 4000 + (j + 1000);

/**
 * Accessibility per square 1.5 km across: the street each is measured from, and residents
 * and jobs within reach once measured.
 */
export class Accessibility {
  /** One street per cell with lots, as edges to measure from. */
  readonly sources: Uint32Array;
  /** Residents and jobs within reach (weighted) per source; NaN until measured. */
  readonly reach: Float32Array;
  private readonly cell = new Map<number, number>();
  measured = false;

  /** `edgeOf`: the street a lot's trips use (-1: none). */
  constructor(lots: Lots, edgeOf: (lot: number) => number = (i) => lots.edge[i]) {
    // The lot nearest each cell's centre gives its street.
    const best = new Map<number, { d: number; edge: number }>();
    for (let k = 0; k < lots.count; k++) {
      const edge = edgeOf(k);
      if (edge < 0) continue;
      const i = Math.floor(lots.x[k] / ACCESS_CELL);
      const j = Math.floor(lots.z[k] / ACCESS_CELL);
      const d = Math.hypot(
        lots.x[k] - (i + 0.5) * ACCESS_CELL,
        lots.z[k] - (j + 0.5) * ACCESS_CELL,
      );
      const key = cellKey(i, j);
      const b = best.get(key);
      if (!b || d < b.d) best.set(key, { d, edge });
    }
    const sources: number[] = [];
    for (const [key, { edge }] of best) {
      this.cell.set(key, sources.length);
      sources.push(edge);
    }
    this.sources = Uint32Array.from(sources);
    this.reach = new Float32Array(sources.length).fill(NaN);
  }

  /** A measurement (two numbers per source: residents and jobs), blended into earlier ones. */
  update(values: Float32Array): void {
    for (let k = 0; k < this.sources.length; k++) {
      const v = values[2 * k] + values[2 * k + 1];
      if (!Number.isFinite(v)) continue;
      const old = this.reach[k];
      this.reach[k] = Number.isFinite(old) ? BLEND * v + (1 - BLEND) * old : v;
    }
    this.measured = true;
  }

  /** The highest reach measured. */
  max(): number {
    let m = 0;
    for (const v of this.reach) if (v > m) m = v;
    return m;
  }

  /** Reach at (x, z), between the centres of the cells around it that were measured. */
  at(x: number, z: number): number {
    const fx = x / ACCESS_CELL - 0.5;
    const fz = z / ACCESS_CELL - 0.5;
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fz);
    const tx = fx - i0;
    const tz = fz - j0;
    let sum = 0;
    let weight = 0;
    for (const [di, dj, w] of [
      [0, 0, (1 - tx) * (1 - tz)],
      [1, 0, tx * (1 - tz)],
      [0, 1, (1 - tx) * tz],
      [1, 1, tx * tz],
    ]) {
      const k = this.cell.get(cellKey(i0 + di, j0 + dj));
      if (k === undefined || w <= 0) continue;
      const v = this.reach[k];
      if (!Number.isFinite(v)) continue;
      sum += w * v;
      weight += w;
    }
    return weight > 0 ? sum / weight : NaN;
  }
}

/** Land value of every lot, from accessibility, green land around and traffic noise. */
export class LandValue {
  readonly access: Accessibility;
  /** Per lot: the index (NaN until accessibility is measured). */
  readonly value: Float32Array;
  /** Per lot: traffic noise (dB(A)) at its street, 0 until traffic is measured. */
  readonly noise: Float32Array;
  /** Reach that scores 100: the highest at the first measurement. */
  reference = 0;
  /** Goes up with every change, so the map knows to redraw. */
  version = 0;

  constructor(
    private readonly lots: Lots,
    private readonly edgeOf: (lot: number) => number = (i) => lots.edge[i],
    /** The loud road near a lot on the network running (-1: none). */
    private readonly loudOf: (lot: number) => number = (i) =>
      lots.loudEdge[i] === NO_EDGE ? -1 : lots.loudEdge[i],
  ) {
    this.access = new Accessibility(lots, edgeOf);
    this.value = new Float32Array(lots.count).fill(NaN);
    this.noise = new Float32Array(lots.count);
  }

  /** Accessibility measured (two numbers per `access.sources`). */
  setReach(values: Float32Array): void {
    this.access.update(values);
    if (this.reference <= 0) this.reference = this.access.max();
    this.compute();
  }

  /** Vehicles that drove onto each edge over `hours` simulated hours. */
  setVolumes(counts: Uint32Array, hours: number): void {
    if (hours <= 0) return;
    const lots = this.lots;
    for (let i = 0; i < lots.count; i++) {
      const edge = this.edgeOf(i);
      let db = 0;
      if (edge >= 0 && edge < counts.length) {
        db = noiseLevel(counts[edge] / hours, STREET_DISTANCE);
      }
      const loud = this.loudOf(i);
      if (loud >= 0 && loud < counts.length) {
        db = Math.max(db, noiseLevel(counts[loud] / hours, lots.loudDistance[i]));
      }
      this.noise[i] = db;
    }
    this.compute();
  }

  private compute(): void {
    if (!this.access.measured || this.reference <= 0) return;
    const lots = this.lots;
    for (let i = 0; i < lots.count; i++) {
      const reach = this.access.at(lots.x[i], lots.z[i]);
      this.value[i] = !(reach >= 0)
        ? NaN
        : 100 *
          (reach / this.reference) ** ACCESS_POWER *
          (1 + (GREEN_BONUS * lots.green[i]) / 100) *
          (1 - noiseLoss(this.noise[i]));
    }
    this.version++;
  }

  /** Mean value of `lots` (NaN: none measured). */
  mean(ids: Iterable<number>): number {
    let [sum, n] = [0, 0];
    for (const i of ids) {
      const v = this.value[i];
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    return n ? sum / n : NaN;
  }
}
