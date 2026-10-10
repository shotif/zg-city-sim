/**
 * ZET's and HŽ's lines as the timetable runs them (M9a): each line's stop patterns, trips by
 * hour and the next departures at a stop, from the transit arrays the simulation runs and
 * `transit/lines.json` (pipeline/transit.py).
 */

export type Mode = 'tram' | 'bus' | 'train';

/** A line as the transit index lists it (`routes`). */
export interface Route {
  name: string;
  longName: string;
  mode: Mode;
}

/** One way a line runs: where its signs say it goes, the stops it calls at and how many
 * trips a day run so. */
export interface Pattern {
  headsign: string;
  stops: number[];
  trips: number;
}

export interface Line {
  route: number;
  trips: number;
  patterns: Pattern[];
}

/** `transit/lines.json`: stops as [name, x, z], the lines, and each trip's headsign. */
export interface LinesFile {
  stops: [string, number, number][];
  lines: Line[];
  headsigns: string[];
  tripHeadsign: number[];
}

/** The transit arrays the app loads (pipeline/transit.py). */
export interface TimetableArrays {
  transitTripRoute: ArrayLike<number>;
  transitTripStops: ArrayLike<number>;
  transitStopTime: ArrayLike<number>;
  transitStopRef: ArrayLike<number>;
}

/** A stop visit that names no stop (a train crossing the map's edge). */
export const NO_STOP = 0xffffffff;
/** Colours of the lines by mode. */
export const MODE_COLOR: Record<Mode, number> = {
  tram: 0x2f80ed,
  bus: 0xe8892b,
  train: 0x8a6fe0,
};
export const MODE_NAME: Record<Mode, string> = { tram: 'Tram', bus: 'Bus', train: 'Train' };

const DAY = 86_400;
/** Platforms of one stop: stops of the same name within this far (m). */
const SAME_STOP = 300;

export interface Departure {
  /** Scheduled departure (s since the service day's midnight). */
  time: number;
  trip: number;
  route: number;
  headsign: string;
}

export class Timetable {
  /** Stop visits by stop: `visits[visitStart[s]..visitStart[s + 1]]`. */
  private readonly visitStart: Uint32Array;
  private readonly visits: Uint32Array;
  /** The trip of each stop visit. */
  private readonly tripOf: Uint32Array;
  private readonly byRoute = new Map<number, Line>();

  constructor(
    readonly routes: Route[],
    readonly file: LinesFile,
    private readonly a: TimetableArrays,
  ) {
    const n = file.stops.length;
    const refs = a.transitStopRef;
    const visitCount = refs.length;
    this.tripOf = new Uint32Array(visitCount);
    const trips = a.transitTripStops.length - 1;
    for (let t = 0; t < trips; t++) {
      this.tripOf.fill(t, a.transitTripStops[t], a.transitTripStops[t + 1]);
    }
    const counts = new Uint32Array(n + 1);
    for (let v = 0; v < visitCount; v++) {
      if (refs[v] < n) counts[refs[v] + 1]++;
    }
    for (let s = 0; s < n; s++) counts[s + 1] += counts[s];
    this.visitStart = counts;
    this.visits = new Uint32Array(counts[n]);
    const fill = counts.slice(0, n);
    for (let v = 0; v < visitCount; v++) {
      if (refs[v] < n) this.visits[fill[refs[v]]++] = v;
    }
    for (const line of file.lines) this.byRoute.set(line.route, line);
  }

  get lines(): Line[] {
    return this.file.lines;
  }

  line(route: number): Line | undefined {
    return this.byRoute.get(route);
  }

  stop(s: number): { name: string; x: number; z: number } {
    const [name, x, z] = this.file.stops[s];
    return { name, x, z };
  }

  /** Trips of `route` starting in each hour of the day (by their first departure). */
  tripsByHour(route: number): number[] {
    const hours = new Array<number>(24).fill(0);
    const a = this.a;
    for (let t = 0; t < a.transitTripRoute.length; t++) {
      if (a.transitTripRoute[t] !== route) continue;
      const first = a.transitStopTime[a.transitTripStops[t]];
      hours[Math.floor(first / 3600) % 24]++;
    }
    return hours;
  }

  /** The stops trip `t` calls at, in order (crossings of the map's edge left out). */
  tripStops(t: number): number[] {
    const a = this.a;
    const out: number[] = [];
    for (let v = a.transitTripStops[t]; v < a.transitTripStops[t + 1]; v++) {
      if (a.transitStopRef[v] !== NO_STOP) out.push(a.transitStopRef[v]);
    }
    return out;
  }

  /** The trips of `route` that run as `pattern` does. */
  patternTrips(route: number, pattern: Pattern): number[] {
    const a = this.a;
    const out: number[] = [];
    for (let t = 0; t < a.transitTripRoute.length; t++) {
      if (a.transitTripRoute[t] !== route) continue;
      if (this.file.headsigns[this.file.tripHeadsign[t]] !== pattern.headsign) continue;
      const stops = this.tripStops(t);
      if (stops.length === pattern.stops.length && stops.every((s, i) => s === pattern.stops[i]))
        out.push(t);
    }
    return out;
  }

  /** Stop `s` and the other platforms of the same stop (same name, within 300 m). */
  platforms(s: number): number[] {
    const { name, x, z } = this.stop(s);
    const out: number[] = [];
    this.file.stops.forEach(([n, sx, sz], k) => {
      if (n === name && Math.hypot(sx - x, sz - z) < SAME_STOP) out.push(k);
    });
    return out;
  }

  /** The next `n` departures at any of `stops` at or after `time` (s, any day), soonest
   * first, wrapping to the next day's timetable; only `trips` if given. A trip's last stop
   * is not a departure. */
  departures(stops: number[], time: number, n: number, trips?: Set<number>): Departure[] {
    const a = this.a;
    const now = ((time % DAY) + DAY) % DAY;
    const found: (Departure & { wait: number })[] = [];
    for (const s of stops) {
      for (let k = this.visitStart[s]; k < this.visitStart[s + 1]; k++) {
        const v = this.visits[k];
        const t = this.tripOf[v];
        if (v === a.transitTripStops[t + 1] - 1) continue;
        if (trips && !trips.has(t)) continue;
        const dep = a.transitStopTime[v];
        found.push({
          time: dep,
          trip: t,
          route: a.transitTripRoute[t],
          headsign: this.file.headsigns[this.file.tripHeadsign[t]],
          wait: (((dep - now) % DAY) + DAY) % DAY,
        });
      }
    }
    found.sort((p, q) => p.wait - q.wait);
    return found.slice(0, n).map(({ wait: _, ...d }) => d);
  }

  /** Lines whose number or name, or stops whose name, contain `query` (case and accents
   * ignored): lines first. */
  search(query: string): { lines: Line[]; stops: number[] } {
    const q = fold(query.trim());
    if (!q) return { lines: this.lines, stops: [] };
    const exact = (l: Line) => fold(this.routes[l.route].name) === q;
    const lines = this.lines
      .filter((l) => {
        const r = this.routes[l.route];
        return exact(l) || fold(`${r.name} ${r.longName}`).includes(q);
      })
      .sort((p, r) => Number(exact(r)) - Number(exact(p)));
    const seen = new Set<string>();
    const stops: number[] = [];
    this.file.stops.forEach(([name], s) => {
      if (stops.length < 8 && fold(name).includes(q) && !seen.has(name)) {
        seen.add(name);
        stops.push(s);
      }
    });
    return { lines, stops };
  }
}

/** Lower case without diacritics, for search. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}
