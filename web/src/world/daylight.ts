/**
 * Light by the time of day (M6a): the sun's light and the sky's colour from the sun's
 * height, from midday through golden hour, sunset and twilight to night, when a faint
 * moonlight keeps the relief readable. The colours are chosen by eye, not measured.
 */
import { type SunPosition, sunDirection } from './sun';

export interface Lighting {
  /** Direction to the light that casts (scene axes). */
  direction: [number, number, number];
  color: number;
  intensity: number;
  /** Hemisphere light: sky and ground colours, intensity. */
  sky: number;
  ground: number;
  ambient: number;
  /** The sky behind everything, and the fog. */
  background: number;
  /** How dark it is: 0 by day, 1 from 6° below the horizon (lamps on, windows lit). */
  night: number;
}

/** The map's light as before M6a: from the north-west, so relief reads well. */
export const ALWAYS_DAY: Lighting = {
  direction: normalise([-1, 1.4, -0.9]),
  color: 0xfff3e0,
  intensity: 2.6,
  sky: 0xdde8f5,
  ground: 0x3b3a30,
  ambient: 1.1,
  background: 0xb9cfe0,
  night: 0,
};

/** Stops by the sun's height (degrees). */
const STOPS: {
  at: number;
  color: number;
  intensity: number;
  sky: number;
  ground: number;
  ambient: number;
  background: number;
}[] = [
  { at: -12, color: 0x9fb0d0, intensity: 0.5, sky: 0x7a8fc0, ground: 0x24262e, ambient: 0.5, background: 0x0b1424 },
  { at: -6, color: 0x9fb0d0, intensity: 0.5, sky: 0x7a8fc0, ground: 0x26282f, ambient: 0.55, background: 0x1a2747 },
  { at: -2, color: 0xff9a5a, intensity: 0, sky: 0x8a90b8, ground: 0x2a2626, ambient: 0.55, background: 0x5a5f8a },
  { at: 1, color: 0xff9a5a, intensity: 0.9, sky: 0xc8b0b0, ground: 0x3a3028, ambient: 0.7, background: 0xd99a72 },
  { at: 6, color: 0xffcf9a, intensity: 1.9, sky: 0xd8dceb, ground: 0x3b3830, ambient: 0.95, background: 0xc8c6c9 },
  { at: 20, color: 0xfff3e0, intensity: 2.6, sky: 0xdde8f5, ground: 0x3b3a30, ambient: 1.1, background: 0xb9cfe0 },
]; // prettier-ignore

/** Moonlight's direction at night: high in the south-west. */
const MOON = sunDirection({ elevation: 45, azimuth: 220 });

function normalise(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function mixColor(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  let out = 0;
  for (const s of [16, 8, 0]) out |= Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t) << s;
  return out;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The light with the sun where it is. */
export function lighting(sun: SunPosition): Lighting {
  const e = sun.elevation;
  let k = 1;
  while (k < STOPS.length - 1 && e > STOPS[k].at) k++;
  const a = STOPS[k - 1];
  const b = STOPS[k];
  const t = Math.min(1, Math.max(0, (e - a.at) / (b.at - a.at)));
  const lerp = (x: number, y: number) => x + (y - x) * t;
  // The sun lights while it is up; the moon's light takes over below -2°.
  const direction = e > -2 ? sunDirection({ ...sun, elevation: Math.max(e, 2) }) : MOON;
  return {
    direction,
    color: mixColor(a.color, b.color, t),
    intensity: lerp(a.intensity, b.intensity),
    sky: mixColor(a.sky, b.sky, t),
    ground: mixColor(a.ground, b.ground, t),
    ambient: lerp(a.ambient, b.ambient),
    background: mixColor(a.background, b.background, t),
    night: smooth(0, -6, e),
  };
}

/** Share of windows lit at night by the hour (Zagreb wall-clock time, s): most in the
 * evening, few in the small hours; an estimate. */
export function litShare(seconds: number): number {
  const h = (((seconds / 3600) % 24) + 24) % 24;
  const stops: [number, number][] = [
    [0, 0.25],
    [2, 0.1],
    [5, 0.1],
    [6.5, 0.35],
    [9, 0.2],
    [17, 0.45],
    [20, 0.6],
    [22.5, 0.45],
    [24, 0.25],
  ];
  let k = 1;
  while (k < stops.length - 1 && h > stops[k][0]) k++;
  const [h0, v0] = stops[k - 1];
  const [h1, v1] = stops[k];
  return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
}
