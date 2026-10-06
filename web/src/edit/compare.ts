/**
 * Before and after (M4b): today's roads and the edited ones, simulated side by side from
 * the same start with the same trips, compared as they run.
 */
import { STAT } from '../sim/wasm';

/** Places travel times are compared between (scene x, z): the City's districts at the
 * mean position of their residents (census 2021, as the simulation places them), and the
 * four largest towns around the City at their centres. */
export const PLACES: readonly { name: string; x: number; z: number }[] = [
  { name: 'Brezovica', x: -6770, z: 12690 },
  { name: 'Črnomerec', x: -3041, z: -1127 },
  { name: 'Donja Dubrava', x: 6395, z: -805 },
  { name: 'Donji grad', x: 291, z: 380 },
  { name: 'Gornja Dubrava', x: 6075, z: -3729 },
  { name: 'Gornji grad – Medveščak', x: -113, z: -1104 },
  { name: 'Maksimir', x: 2295, z: -1777 },
  { name: 'Novi Zagreb – istok', x: 1526, z: 4983 },
  { name: 'Novi Zagreb – zapad', x: -2650, z: 5604 },
  { name: 'Peščenica – Žitnjak', x: 4362, z: 1651 },
  { name: 'Podsljeme', x: 722, z: -5725 },
  { name: 'Podsused – Vrapče', x: -7560, z: -967 },
  { name: 'Sesvete', x: 11910, z: -4088 },
  { name: 'Stenjevec', x: -6004, z: 850 },
  { name: 'Trešnjevka – jug', x: -3967, z: 2532 },
  { name: 'Trešnjevka – sjever', x: -2749, z: 1331 },
  { name: 'Trnje', x: 530, z: 1853 },
  { name: 'Velika Gorica', x: 7286, z: 10882 },
  { name: 'Samobor', x: -20701, z: 1177 },
  { name: 'Zaprešić', x: -13185, z: -4977 },
  { name: 'Dugo Selo', x: 20343, z: 1003 },
];

/** One line of the comparison: a measure today and with the edits. */
export interface CompareRow {
  label: string;
  today: number;
  edited: number;
  unit: string;
  /** Whether more is better (for colouring the change). */
  moreIsBetter: boolean;
  digits: number;
}

/** The measures both simulations report, from their statistics arrays. */
export function compareStats(today: Float64Array, edited: Float64Array): CompareRow[] {
  const tripMinutes = (s: Float64Array) => s[STAT.meanTripTime] / 60;
  return [
    {
      label: 'Delay so far',
      today: today[STAT.delayHours],
      edited: edited[STAT.delayHours],
      unit: 'vehicle-hours',
      moreIsBetter: false,
      digits: 0,
    },
    {
      label: 'Vehicles on the road',
      today: today[STAT.running],
      edited: edited[STAT.running],
      unit: '',
      moreIsBetter: false,
      digits: 0,
    },
    {
      label: 'Mean speed',
      today: today[STAT.meanSpeed] * 3.6,
      edited: edited[STAT.meanSpeed] * 3.6,
      unit: 'km/h',
      moreIsBetter: true,
      digits: 1,
    },
    {
      label: 'Driven so far',
      today: today[STAT.vehicleKm],
      edited: edited[STAT.vehicleKm],
      unit: 'km',
      moreIsBetter: false,
      digits: 0,
    },
    {
      label: 'Trips finished',
      today: today[STAT.arrived],
      edited: edited[STAT.arrived],
      unit: '',
      moreIsBetter: true,
      digits: 0,
    },
    {
      label: 'Mean trip',
      today: tripMinutes(today),
      edited: tripMinutes(edited),
      unit: 'min',
      moreIsBetter: false,
      digits: 1,
    },
  ];
}

/** The latest simulated minute both simulations have statistics for. */
export function commonMinute(
  a: ReadonlyMap<number, Float64Array>,
  b: ReadonlyMap<number, Float64Array>,
): number | undefined {
  let best: number | undefined;
  for (const minute of a.keys()) {
    if (b.has(minute) && (best === undefined || minute > best)) best = minute;
  }
  return best;
}

/** Relative change from `a` to `b` (0 when both are 0). */
export function change(a: number, b: number): number {
  return a === 0 ? (b === 0 ? 0 : Infinity) : (b - a) / a;
}

export interface TravelTimeChange {
  from: string;
  to: string;
  today: number;
  edited: number;
}

export interface TravelTimeSummary {
  /** Pairs with a route both ways compared. */
  pairs: number;
  /** Mean relative change over the pairs. */
  mean: number;
  /** The pairs that changed most, slower first, then faster. */
  slower: TravelTimeChange[];
  faster: TravelTimeChange[];
}

/** Travel times between place pairs today and with the edits (s; negative: no route). */
export function summariseTravelTimes(
  pairs: readonly [number, number][],
  today: ArrayLike<number>,
  edited: ArrayLike<number>,
  names: readonly string[] = PLACES.map((p) => p.name),
  top = 3,
): TravelTimeSummary {
  const changes: (TravelTimeChange & { rel: number })[] = [];
  for (let k = 0; k < pairs.length; k++) {
    const [a, b] = [today[k], edited[k]];
    if (!(a > 0) || !(b > 0)) continue;
    const [i, j] = pairs[k];
    changes.push({ from: names[i], to: names[j], today: a, edited: b, rel: (b - a) / a });
  }
  const mean = changes.length ? changes.reduce((s, c) => s + c.rel, 0) / changes.length : 0;
  const strip = ({ from, to, today: t, edited: e }: TravelTimeChange) => ({
    from,
    to,
    today: t,
    edited: e,
  });
  const sorted = [...changes].sort((p, q) => q.rel - p.rel);
  return {
    pairs: changes.length,
    mean,
    slower: sorted
      .filter((c) => c.rel > 0.005)
      .slice(0, top)
      .map(strip),
    faster: sorted
      .filter((c) => c.rel < -0.005)
      .reverse()
      .slice(0, top)
      .map(strip),
  };
}

/** Bands of the difference map: relative change of the traffic on a road (orange more,
 * purple less: apart from the blue of tram tracks and the yellow of main roads). */
export const DIFF_BANDS = [
  { max: -0.3, color: 0x5e3c99, label: 'over 30 % less' },
  { max: -0.1, color: 0xb2abd2, label: '10-30 % less' },
  { max: 0.1, color: 0, label: 'about the same' },
  { max: 0.3, color: 0xfdb863, label: '10-30 % more' },
  { max: Infinity, color: 0xe66101, label: 'over 30 % more' },
] as const;

/** Roads with at least this many vehicles, today or with the edits, are coloured. */
export const DIFF_MIN_VEHICLES = 60;
/** The difference map starts when the streets have filled (s since midnight). */
export const DIFF_FROM = 7 * 3600;

/** Edges of each band of the difference map from the vehicles that drove onto each edge
 * today and with the edits (the middle band, about the same, is left out). */
export function diffBands(
  today: ArrayLike<number>,
  edited: ArrayLike<number>,
  include: (edge: number) => boolean = () => true,
): number[][] {
  const bands: number[][] = DIFF_BANDS.map(() => []);
  for (let e = 0; e < today.length; e++) {
    const [a, b] = [today[e], edited[e]];
    if (Math.max(a, b) < DIFF_MIN_VEHICLES || !include(e)) continue;
    const rel = (b - a) / Math.max(a, 1);
    const band = DIFF_BANDS.findIndex((d) => rel < d.max);
    if (band !== 2) bands[band].push(e);
  }
  return bands;
}
