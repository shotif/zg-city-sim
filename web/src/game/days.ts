/**
 * Progress over simulated days (M19b): each day's traffic, public transport, growth and
 * balance, kept with the city. A day's numbers are the change in the engine's running
 * totals between one midnight and the next; the first day of a visit starts when the
 * streets have filled, so it is counted from then (`from`).
 */
import { cityKey } from './cities';

/** Seconds in a simulated day. */
export const DAY = 86_400;
/** Days kept with a city. */
export const MAX_DAYS = 365;
/** A day counted from this many seconds after midnight or earlier counts as whole. */
const WHOLE = 600;

/** The engine's running totals since it started (`STAT` slots). */
export interface Totals {
  /** Road trips completed. */
  trips: number;
  /** Mean time of the trips completed (s). */
  meanTripTime: number;
  vehicleHours: number;
  delayHours: number;
  vehicleKm: number;
}

/** What else a day's record holds, as it stands at the day's end. */
export interface DayExtras {
  /** Public transport's trips a weekday and their share of motorised trips within the
   * map, as estimated (M9d). */
  ptTrips?: number;
  ptShare?: number;
  /** Residents and jobs in buildings grown on zoned land. */
  residents?: number;
  jobs?: number;
  balance?: number;
}

export interface DayRecord extends DayExtras {
  /** The city's day number (1 on its first). */
  day: number;
  /** Seconds after midnight the numbers start (0: the whole day). */
  from: number;
  trips: number;
  /** Mean time of the day's trips (min). */
  tripMinutes: number;
  vehicleHours: number;
  /** Hours lost against driving at the speed limit. */
  delayHours: number;
  vehicleKm: number;
}

function isRecord(r: unknown): r is DayRecord {
  const x = r as DayRecord;
  return (
    typeof r === 'object' &&
    r !== null &&
    Number.isInteger(x.day) &&
    [x.from, x.trips, x.tripMinutes, x.vehicleHours, x.delayHours, x.vehicleKm].every(
      Number.isFinite,
    )
  );
}

export function loadDays(storage: Storage | undefined = globalThis.localStorage): DayRecord[] {
  try {
    const v = JSON.parse(storage?.getItem(cityKey('days')) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export function saveDays(
  days: readonly DayRecord[],
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(cityKey('days'), JSON.stringify(days.slice(-MAX_DAYS)));
  } catch {
    // Storage full or blocked: the days last the visit.
  }
}

/** The change from `a` to `b` as a day's numbers. */
function between(a: Totals, b: Totals): Omit<DayRecord, 'day' | 'from'> {
  const trips = b.trips - a.trips;
  const time = b.meanTripTime * b.trips - a.meanTripTime * a.trips;
  return {
    trips,
    tripMinutes: trips > 0 ? time / trips / 60 : 0,
    vehicleHours: b.vehicleHours - a.vehicleHours,
    delayHours: b.delayHours - a.delayHours,
    vehicleKm: b.vehicleKm - a.vehicleKm,
  };
}

/** The days kept with the city played, and the day going on now. */
export class DayLog {
  readonly days: DayRecord[];
  /** Where the day going on now started: engine day, time and totals. */
  private start?: { k: number; time: number; totals: Totals };
  private last?: Totals;

  /**
   * `firstDay`: the city's day number of the engine's first day (its day 0) this visit.
   */
  constructor(
    private readonly firstDay: () => number,
    private readonly storage: Storage | undefined = globalThis.localStorage,
  ) {
    this.days = loadDays(storage);
  }

  /** The city's day number at engine time `now`. */
  dayAt(now: number): number {
    return this.firstDay() + Math.floor(now / DAY);
  }

  /** The numbers of the day going on, so far (none before counting starts). */
  sofar(): DayRecord | undefined {
    if (!this.start || !this.last) return undefined;
    return {
      day: this.dayAt(this.start.time),
      from: this.start.time - this.start.k * DAY,
      ...between(this.start.totals, this.last),
    };
  }

  /**
   * Engine time `now` and its totals (`counting`: the streets have filled, so the day's
   * numbers count). Returns the record of a day that has just ended, kept with the city.
   */
  tick(
    now: number,
    totals: Totals,
    counting: boolean,
    extras: () => DayExtras,
  ): DayRecord | undefined {
    if (!counting) return undefined;
    const k = Math.floor(now / DAY);
    if (!this.start || now < this.start.time) {
      // Counting starts, or a new engine began from an earlier time.
      this.start = { k, time: now, totals };
      this.last = totals;
      return undefined;
    }
    let ended: DayRecord | undefined;
    if (k > this.start.k && this.last) {
      const from = this.start.time - this.start.k * DAY;
      ended = {
        day: this.dayAt(this.start.time),
        from: from <= WHOLE ? 0 : Math.round(from),
        ...between(this.start.totals, this.last),
        ...extras(),
      };
      const i = this.days.findIndex((d) => d.day === ended!.day);
      if (i >= 0) this.days.splice(i, 1);
      this.days.push(ended);
      this.days.sort((a, b) => a.day - b.day);
      saveDays(this.days, this.storage);
      this.start = { k, time: k * DAY, totals: this.last };
    }
    this.last = totals;
    return ended;
  }

  /** The whole day before `day`, if kept: to compare `day` with. */
  before(day: number): DayRecord | undefined {
    return [...this.days].reverse().find((d) => d.day < day && d.from === 0);
  }
}
