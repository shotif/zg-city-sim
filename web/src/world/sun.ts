/**
 * Where the sun is over Zagreb at a simulated time (M6a).
 *
 * The solar position follows the low-precision formulas of the US Naval Observatory and
 * the Astronomical Almanac (good to about 0.01° between 1950 and 2050). Simulated time is
 * Zagreb's wall-clock time, seconds since local midnight of the day the simulation shows;
 * the city keeps Central European Time, summer time from the last Sunday of March to the
 * last Sunday of October.
 */

/** Zagreb's centre (Ban Jelačić Square). */
export const ZAGREB = { lat: 45.8131, lon: 15.9772 };

const RAD = Math.PI / 180;

export interface SunPosition {
  /** Height above the horizon (degrees; negative below it). */
  elevation: number;
  /** Compass bearing (degrees, 0 = north, 90 = east). */
  azimuth: number;
}

/** The sun at a moment (`ms` since 1970 UTC), seen from `lat`, `lon` (degrees). */
export function sunPosition(ms: number, lat = ZAGREB.lat, lon = ZAGREB.lon): SunPosition {
  const n = ms / 86_400_000 + 2_440_587.5 - 2_451_545.0; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const hour = (gmst * 15 + lon) * RAD - ra;
  const phi = lat * RAD;
  const elevation = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hour),
  );
  const azimuth = Math.atan2(
    -Math.sin(hour),
    Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(hour),
  );
  return { elevation: elevation / RAD, azimuth: (((azimuth / RAD) % 360) + 360) % 360 };
}

/** Last Sunday of a month (0-11) of a year, as a UTC date at 01:00, when summer time starts
 * (March) or ends (October) across the EU. */
function lastSunday(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0, 1));
  return last.getTime() - last.getUTCDay() * 86_400_000;
}

/** Zagreb's offset from UTC (hours) at a moment: 2 in summer time, else 1. */
export function zagrebOffset(ms: number): number {
  const year = new Date(ms).getUTCFullYear();
  return ms >= lastSunday(year, 2) && ms < lastSunday(year, 9) ? 2 : 1;
}

/** A Zagreb calendar day (year, month 1-12, day). */
export interface Day {
  year: number;
  month: number;
  day: number;
}

/** Today in Zagreb. */
export function zagrebToday(now = Date.now()): Day {
  const local = new Date(now + zagrebOffset(now) * 3_600_000);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

/** The moment (ms since 1970 UTC) of Zagreb wall-clock time `seconds` after midnight on
 * `day` (past 86 400: the days after). */
export function zagrebMoment(day: Day, seconds: number): number {
  const naive = Date.UTC(day.year, day.month - 1, day.day) + seconds * 1000;
  // The offset of the moment itself: an hour off only within the hour the clocks change.
  return naive - zagrebOffset(naive - 3_600_000) * 3_600_000;
}

/** The sun over Zagreb at simulated time `seconds` on `day`. */
export function sunAt(day: Day, seconds: number): SunPosition {
  return sunPosition(zagrebMoment(day, seconds));
}

/** Direction to the sun in scene axes (x east, y up, z south), unit length. */
export function sunDirection(sun: SunPosition): [number, number, number] {
  const el = sun.elevation * RAD;
  const az = sun.azimuth * RAD;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/** Wall-clock seconds after midnight when the sun rises or sets on `day` (its upper edge
 * on the horizon, with refraction: -0.833°), found by bisection; undefined if it does not. */
export function sunTimes(day: Day): { rise?: number; set?: number } {
  const h = (s: number) => sunAt(day, s).elevation + 0.833;
  const find = (a: number, b: number) => {
    if (Math.sign(h(a)) === Math.sign(h(b))) return undefined;
    for (let k = 0; k < 40; k++) {
      const m = (a + b) / 2;
      if (Math.sign(h(m)) === Math.sign(h(a))) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };
  // Noon in Zagreb is near 11:56 in winter time, 12:56 in summer time.
  let noon = 12 * 3600;
  for (let s = 9 * 3600; s <= 15 * 3600; s += 300) {
    if (h(s) > h(noon)) noon = s;
  }
  return { rise: find(0, noon), set: find(noon, 86_400) };
}
