/**
 * ZET's and HŽ's lines as the timetable runs them (M9a): each line's stop patterns, trips by
 * hour and the next departures at a stop, from the transit arrays the simulation runs and
 * `transit/lines.json` (pipeline/transit.py). With frequency edits (M9b) the engine runs
 * fewer trips, or copies of them, and says which (`setService`).
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

/** `transit/lines.json`: stops as [name, x, z], the lines, and each trip's headsign and
 * length (m, whole: ZET's along its route's shape). */
export interface LinesFile {
  stops: [string, number, number][];
  lines: Line[];
  headsigns: string[];
  tripHeadsign: number[];
  tripMetres?: number[];
}

/** How often a line may run, as a share of its timetable (M9b; sim/src/transit.rs
 * `FREQUENCY_RANGE`). */
export const FREQUENCIES: readonly { factor: number; label: string }[] = [
  { factor: 0, label: 'Not running' },
  { factor: 0.5, label: 'Half as often' },
  { factor: 0.75, label: 'Three quarters as often' },
  { factor: 1, label: 'As timetabled' },
  { factor: 1.5, label: 'One and a half times as often' },
  { factor: 2, label: 'Twice as often' },
  { factor: 3, label: 'Three times as often' },
];
/** Modes whose frequency the player sets: ZET's (HŽ runs the trains). */
export const SET_FREQUENCY: ReadonlySet<Mode> = new Set(['tram', 'bus']);

export function frequencyLabel(factor: number): string {
  return FREQUENCIES.find((f) => f.factor === factor)?.label ?? `${factor} times as often`;
}

/** The transit arrays the app loads (pipeline/transit.py). */
export interface TimetableArrays {
  transitTripRoute: ArrayLike<number>;
  transitTripStops: ArrayLike<number>;
  transitStopTime: ArrayLike<number>;
  transitStopRef: ArrayLike<number>;
}

/** Public transport's riders a weekday as the engine estimates them (M9d): trips today and
 * with the edits in force, car trips moved off the roads, boardings by route. */
export interface Riders {
  ready: boolean;
  busy: boolean;
  today: number;
  now: number;
  moved: number;
  /** Car trips a weekday within the map today (at full demand, estimated). */
  carToday: number;
  boardingsToday: Float32Array;
  boardingsNow: Float32Array;
}

/** The engine's riders (sim `zg_riders`); undefined without. */
export function readRiders(words: Float32Array): Riders | undefined {
  if (words.length < 7) return undefined;
  const routes = words[6];
  return {
    ready: words[0] === 1,
    busy: words[1] === 1,
    today: words[2],
    now: words[3],
    moved: words[4],
    carToday: words[5],
    boardingsToday: words.subarray(7, 7 + routes),
    boardingsNow: words.subarray(7 + routes, 7 + 2 * routes),
  };
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

/** One way of a new line (M9c) as the app sends it to the engine: its route, name and mode,
 * and its stops in order (both ways: two of them, sharing a route). */
export interface NewWay {
  route: number;
  name: string;
  mode: Mode;
  stops: { name: string; x: number; z: number }[];
}

/** A trip after the timetable's: a copy of one (M9b), or a new line's (M9c). */
type Added = { trip: number; shift: number } | { way: number; start: number };

/** One way of a new line as the engine runs it. */
interface Way {
  route: number;
  /** Stops served, and when each is left after the first (s). */
  stops: number[];
  offsets: number[];
  metres: number;
  trips: number[];
}

/** Marks a new line's trips in the engine's service (sim/src/transit.rs `LINE_TAG`). */
const LINE_TAG = 0x80000000;
/** A new line's stop is a timetabled stop of the same name within this far (m). */
const SAME_PLACE = 50;

export class Timetable {
  /** Stop visits by stop: `visits[visitStart[s]..visitStart[s + 1]]`. */
  private readonly visitStart: Uint32Array;
  private readonly visits: Uint32Array;
  /** The trip of each stop visit. */
  private readonly tripOf: Uint32Array;
  /** Trips in the timetable; those after are copies frequency edits add, and new lines'. */
  readonly timetabled: number;
  /** The timetable's routes, then new lines'. */
  routes: Route[];
  private readonly baseRoutes: number;
  /** Stops of new lines that are not timetabled stops: [name, x, z]. */
  private extraStops: [string, number, number][] = [];
  private added: Added[] = [];
  private copiesOf = new Map<number, number[]>();
  /** New lines' ways in force, by the engine's line, and their stop visits by stop. */
  private ways = new Map<number, Way>();
  private wayVisits = new Map<number, { way: Way; i: number }[]>();
  private newLines: Line[] = [];
  private byRoute = new Map<number, Line>();
  /** Whether each trip runs, and trips a day by route. */
  private runs: Uint8Array;
  private running: Uint32Array;
  /** Vehicle-km a weekday by route, as timetabled. */
  private readonly kmByRoute: Float64Array;

  constructor(
    routes: Route[],
    readonly file: LinesFile,
    private readonly a: TimetableArrays,
  ) {
    this.routes = [...routes];
    this.baseRoutes = routes.length;
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
    this.timetabled = trips;
    this.runs = new Uint8Array(trips).fill(1);
    this.running = this.countRunning();
    this.kmByRoute = new Float64Array(routes.length);
    const metres = file.tripMetres;
    if (metres?.length === trips) {
      for (let t = 0; t < trips; t++) this.kmByRoute[a.transitTripRoute[t]] += metres[t] / 1000;
    }
  }

  /** A new line's route: the same for the same name and mode, after the timetable's. */
  newRoute(name: string, mode: Mode): number {
    const r = this.routes.findIndex(
      (q, i) => i >= this.baseRoutes && q.name === name && q.mode === mode,
    );
    if (r >= 0) return r;
    this.routes.push({ name, longName: '', mode });
    return this.routes.length - 1;
  }

  /** New lines' ways the engine runs, and the new lines they make up. */
  get waysInForce(): number {
    return this.ways.size;
  }

  get newLineCount(): number {
    return this.newLines.length;
  }

  /** Whether `route` is a new line's. */
  isNew(route: number): boolean {
    return route >= this.baseRoutes;
  }

  /** The trips the engine runs (sim `Transit::write_service`), with `ways`, the new lines'
   * ways in the order their records were sent; no words: as timetabled. */
  setService(words?: Uint32Array, ways: readonly NewWay[] = []): void {
    this.added = [];
    this.copiesOf = new Map();
    this.ways = new Map();
    this.wayVisits = new Map();
    this.extraStops = [];
    const n = this.timetabled;
    if (!words || words.length < 4 || words[0] !== n) {
      this.runs = new Uint8Array(n).fill(1);
    } else {
      const [, added, running, lines] = words;
      const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
      let k = 4;
      for (let i = 0; i < added; i++, k += 2) {
        const tag = words[k];
        if (tag >= LINE_TAG) {
          this.added.push({ way: tag - LINE_TAG, start: floats[k + 1] });
        } else {
          this.added.push({ trip: tag, shift: floats[k + 1] });
          const list = this.copiesOf.get(tag) ?? [];
          list.push(n + i);
          this.copiesOf.set(tag, list);
        }
      }
      this.runs = new Uint8Array(n + added);
      for (let i = 0; i < running; i++) this.runs[words[k + i]] = 1;
      k += running;
      for (let w = 0; w < lines && k + 3 <= words.length; w++) {
        const [id, , served] = [words[k], words[k + 1], words[k + 2]];
        const metres = floats[k + 1];
        k += 3;
        const def = ways[w];
        const way: Way = { route: def?.route ?? 0, stops: [], offsets: [], metres, trips: [] };
        for (let i = 0; i < served; i++, k += 2) {
          const stop = def?.stops[words[k]];
          if (!stop) continue;
          way.stops.push(this.placeStop(stop));
          way.offsets.push(floats[k + 1]);
        }
        if (id !== 0xffffffff && def) this.ways.set(id, way);
      }
      this.added.forEach((a, i) => {
        if ('way' in a) this.ways.get(a.way)?.trips.push(n + i);
      });
    }
    for (const way of this.ways.values()) {
      way.stops.forEach((s, i) => {
        const list = this.wayVisits.get(s) ?? [];
        list.push({ way, i });
        this.wayVisits.set(s, list);
      });
    }
    this.running = this.countRunning();
    this.newLines = [];
    const byRoute = new Map<number, Line>();
    for (const way of this.ways.values()) {
      let line = byRoute.get(way.route);
      if (!line) {
        line = { route: way.route, trips: 0, patterns: [] };
        byRoute.set(way.route, line);
        this.newLines.push(line);
      }
      const trips = way.trips.filter((t) => this.runs[t]).length;
      line.trips += trips;
      line.patterns.push({
        headsign: this.stop(way.stops[way.stops.length - 1]).name,
        stops: way.stops,
        trips,
      });
    }
    for (const line of this.newLines) {
      const r = this.routes[line.route];
      const p = line.patterns[0];
      if (r && p) r.longName = `${this.stop(p.stops[0]).name} - ${p.headsign}`;
    }
    this.byRoute = new Map([...this.file.lines, ...this.newLines].map((l) => [l.route, l]));
  }

  /** A new line's stop: a timetabled stop of the same name nearby, else a stop of its own. */
  private placeStop(stop: { name: string; x: number; z: number }): number {
    const near = (x: number, z: number) => Math.hypot(x - stop.x, z - stop.z) < SAME_PLACE;
    const found = this.file.stops.findIndex(([name, x, z]) => name === stop.name && near(x, z));
    if (found >= 0) return found;
    const extra = this.extraStops.findIndex(([name, x, z]) => name === stop.name && near(x, z));
    if (extra >= 0) return this.file.stops.length + extra;
    this.extraStops.push([stop.name, stop.x, stop.z]);
    return this.file.stops.length + this.extraStops.length - 1;
  }

  private countRunning(): Uint32Array {
    const out = new Uint32Array(this.routes.length);
    for (let t = 0; t < this.runs.length; t++) if (this.runs[t]) out[this.routeOf(t)]++;
    return out;
  }

  /** The new line's way of trip `t`, if it is one of theirs. */
  private wayOf(t: number): Way | undefined {
    const a = t >= this.timetabled ? this.added[t - this.timetabled] : undefined;
    return a && 'way' in a ? this.ways.get(a.way) : undefined;
  }

  /** The timetabled trip `t` runs as (itself, or the one a copy copies) and how much later;
   * undefined for a new line's. */
  private source(t: number): { trip: number; shift: number } | undefined {
    if (t < this.timetabled) return { trip: t, shift: 0 };
    const a = this.added[t - this.timetabled];
    return a && 'trip' in a ? a : undefined;
  }

  routeOf(t: number): number {
    const src = this.source(t);
    if (src) return this.a.transitTripRoute[src.trip];
    return this.wayOf(t)?.route ?? 0;
  }

  /** When trip `t` leaves its first stop (s after midnight). */
  private firstTime(t: number): number {
    const src = this.source(t);
    if (src) return this.a.transitStopTime[this.a.transitTripStops[src.trip]] + src.shift;
    const a = this.added[t - this.timetabled];
    return a && 'start' in a ? a.start : 0;
  }

  /** Trips of `route` that run today. */
  tripsToday(route: number): number {
    return this.running[route] ?? 0;
  }

  /** Vehicle-km of `route` a weekday: as timetabled, or as a new line runs. */
  km(route: number): number {
    if (route < this.baseRoutes) return this.kmByRoute[route] ?? 0;
    let km = 0;
    for (const way of this.ways.values()) {
      if (way.route === route)
        km += (way.metres / 1000) * way.trips.filter((t) => this.runs[t]).length;
    }
    return km;
  }

  /** The timetable's route of the line named `name` run by `mode`. */
  routeIndex(name: string, mode: Mode): number | undefined {
    const r = this.routes.findIndex(
      (q, i) => i < this.baseRoutes && q.name === name && q.mode === mode,
    );
    return r < 0 ? undefined : r;
  }

  get lines(): Line[] {
    return this.newLines.length ? [...this.file.lines, ...this.newLines] : this.file.lines;
  }

  line(route: number): Line | undefined {
    return this.byRoute.get(route);
  }

  stop(s: number): { name: string; x: number; z: number } {
    const [name, x, z] = this.file.stops[s] ?? this.extraStops[s - this.file.stops.length];
    return { name, x, z };
  }

  private get stopCount(): number {
    return this.file.stops.length + this.extraStops.length;
  }

  /** Trips of `route` that run, starting in each hour of the day (by first departure). */
  tripsByHour(route: number): number[] {
    const hours = new Array<number>(24).fill(0);
    for (let t = 0; t < this.runs.length; t++) {
      if (!this.runs[t] || this.routeOf(t) !== route) continue;
      hours[Math.floor(this.firstTime(t) / 3600) % 24]++;
    }
    return hours;
  }

  /** The stops trip `t` calls at, in order (crossings of the map's edge left out). */
  tripStops(t: number): number[] {
    const src = this.source(t);
    if (!src) return [...(this.wayOf(t)?.stops ?? [])];
    const a = this.a;
    const out: number[] = [];
    for (let v = a.transitTripStops[src.trip]; v < a.transitTripStops[src.trip + 1]; v++) {
      if (a.transitStopRef[v] !== NO_STOP) out.push(a.transitStopRef[v]);
    }
    return out;
  }

  /** The trips of `route` timetabled to run as `pattern` does, and their copies (whether
   * they run or not); a new line's way's trips. */
  patternTrips(route: number, pattern: Pattern): number[] {
    if (route >= this.baseRoutes) {
      const way = [...this.ways.values()].find(
        (w) => w.route === route && w.stops.join() === pattern.stops.join(),
      );
      return way ? [...way.trips] : [];
    }
    const a = this.a;
    const out: number[] = [];
    for (let t = 0; t < this.timetabled; t++) {
      if (a.transitTripRoute[t] !== route) continue;
      if (this.file.headsigns[this.file.tripHeadsign[t]] !== pattern.headsign) continue;
      const stops = this.tripStops(t);
      if (stops.length === pattern.stops.length && stops.every((s, i) => s === pattern.stops[i]))
        out.push(t, ...(this.copiesOf.get(t) ?? []));
    }
    return out;
  }

  /** Stop `s` and the other platforms of the same stop (same name, within 300 m). */
  platforms(s: number): number[] {
    const { name, x, z } = this.stop(s);
    const out: number[] = [];
    for (let k = 0; k < this.stopCount; k++) {
      const q = this.stop(k);
      if (q.name === name && Math.hypot(q.x - x, q.z - z) < SAME_STOP) out.push(k);
    }
    return out;
  }

  /** The next `n` departures at any of `stops` at or after `time` (s, any day), soonest
   * first, wrapping to the next day's timetable; trips that run, only `trips` if given. A
   * trip's last stop is not a departure. */
  departures(stops: number[], time: number, n: number, trips?: Set<number>): Departure[] {
    const a = this.a;
    const now = ((time % DAY) + DAY) % DAY;
    const found: (Departure & { wait: number })[] = [];
    const add = (t: number, dep: number, route: number, headsign: string) => {
      if (!this.runs[t] || (trips && !trips.has(t))) return;
      found.push({
        time: dep,
        trip: t,
        route,
        headsign,
        wait: (((dep - now) % DAY) + DAY) % DAY,
      });
    };
    for (const s of stops) {
      for (let k = this.visitStart[s] ?? 0; k < (this.visitStart[s + 1] ?? 0); k++) {
        const v = this.visits[k];
        const t = this.tripOf[v];
        if (v === a.transitTripStops[t + 1] - 1) continue;
        const route = a.transitTripRoute[t];
        const headsign = this.file.headsigns[this.file.tripHeadsign[t]];
        add(t, a.transitStopTime[v], route, headsign);
        for (const c of this.copiesOf.get(t) ?? []) {
          const copy = this.added[c - this.timetabled] as { shift: number };
          add(c, a.transitStopTime[v] + copy.shift, route, headsign);
        }
      }
      for (const { way, i } of this.wayVisits.get(s) ?? []) {
        if (i === way.stops.length - 1) continue;
        const headsign = this.stop(way.stops[way.stops.length - 1]).name;
        for (const t of way.trips) add(t, this.firstTime(t) + way.offsets[i], way.route, headsign);
      }
    }
    found.sort((p, q) => p.wait - q.wait);
    return found.slice(0, n).map(({ wait: _, ...d }) => d);
  }

  /** The stop nearest (x, z) within `radius` m that `mode`'s lines call at. */
  nearestStop(x: number, z: number, mode: Mode, radius: number): number | undefined {
    let best: { s: number; d: number } | undefined;
    for (const line of this.lines) {
      if (this.routes[line.route]?.mode !== mode) continue;
      for (const p of line.patterns) {
        for (const s of p.stops) {
          const q = this.stop(s);
          const d = Math.hypot(q.x - x, q.z - z);
          if (d <= radius && (!best || d < best.d)) best = { s, d };
        }
      }
    }
    return best?.s;
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
    for (let s = 0; s < this.stopCount && stops.length < 8; s++) {
      const { name } = this.stop(s);
      if (fold(name).includes(q) && !seen.has(name)) {
        seen.add(name);
        stops.push(s);
      }
    }
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
