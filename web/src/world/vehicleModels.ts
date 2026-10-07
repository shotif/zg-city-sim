/**
 * Vehicle models (M6c): low-poly shapes of the vehicles on Zagreb's streets, built from
 * boxes and side profiles extruded across the vehicle, so windscreens and bonnets slope.
 * Vehicle space: x to the right, y up, z forward, the origin at the middle of the
 * footprint on the road. Lengths follow the engine's (cars 4.5 m give or take half a
 * metre, lorries 10 m, buses 12 m, trams 32 m).
 *
 * Parts in `PAINT` take each vehicle's colour; the others keep their own. Lamps are
 * listed apart, so they can glow (headlamps at night, tail lamps braking, indicators).
 */
import * as THREE from 'three/webgpu';

/** Paint colour placeholder: parts in this colour take each vehicle's own paint. */
export const PAINT = 0xffffff;

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
  color: number;
}

/** A side profile (z, y points around a convex outline) extruded from x0 to x1. */
export interface Prism {
  profile: [number, number][];
  x: [number, number];
  color: number;
}

export type Part = Box | Prism;

export interface Model {
  name: string;
  parts: Part[];
  head: Part[];
  tail: Part[];
  /** Indicators, left and right. */
  left: Part[];
  right: Part[];
  /** Where the front is (m from the middle), and half the width (headlight beams). */
  front: number;
  halfWidth: number;
}

const GLASS = 0x2a3038;
const DARK = 0x1c1d1f;
const TYRE = 0x161616;
const GREY = 0x8a8d90;
const LIGHT_GREY = 0xd9dbdc;
const WHITE = 0xeeeeea;
const HEAD = 0xfff6d8;
const TAIL = 0xff2a1a;
const AMBER = 0xffa020;

const isBox = (p: Part): p is Box => 'min' in p;

// ---- geometry ----------------------------------------------------------------------------

/** Merge parts into one flat-shaded, vertex-coloured geometry. */
export function partsGeometry(parts: Part[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  const tri = (a: number[], b: number[], c: number[], n: number[]) => {
    // Wind the triangle so its front faces along n.
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const flip = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] < 0;
    for (const v of flip ? [a, c, b] : [a, b, c]) {
      positions.push(v[0], v[1], v[2]);
      normals.push(n[0], n[1], n[2]);
      colors.push(color.r, color.g, color.b);
    }
  };
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    tri(a, b, c, n);
    tri(a, c, d, n);
  };
  for (const part of parts) {
    color.setHex(part.color, THREE.SRGBColorSpace);
    if (isBox(part)) {
      const [x0, y0, z0] = part.min;
      const [x1, y1, z1] = part.max;
      quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
      quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
      quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]);
      quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
      quad([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [0, 0, 1]);
      quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]);
      continue;
    }
    const { profile, x } = part;
    const [x0, x1] = x;
    const cz = profile.reduce((s, p) => s + p[0], 0) / profile.length;
    const cy = profile.reduce((s, p) => s + p[1], 0) / profile.length;
    // The two sides, as fans.
    for (let k = 1; k + 1 < profile.length; k++) {
      const [a, b, c] = [profile[0], profile[k], profile[k + 1]];
      tri([x1, a[1], a[0]], [x1, b[1], b[0]], [x1, c[1], c[0]], [1, 0, 0]);
      tri([x0, a[1], a[0]], [x0, b[1], b[0]], [x0, c[1], c[0]], [-1, 0, 0]);
    }
    // Round the outline.
    for (let k = 0; k < profile.length; k++) {
      const [z0, y0] = profile[k];
      const [z1, y1] = profile[(k + 1) % profile.length];
      const len = Math.hypot(z1 - z0, y1 - y0);
      if (len === 0) continue;
      let ny = (z1 - z0) / len;
      let nz = -(y1 - y0) / len;
      if (ny * ((y0 + y1) / 2 - cy) + nz * ((z0 + z1) / 2 - cz) < 0) [ny, nz] = [-ny, -nz];
      quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1], [0, ny, nz]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

// ---- parts ------------------------------------------------------------------------------

/** A part mirrored to both sides (x and -x). */
const both = (b: Box): Box[] => [
  b,
  { ...b, min: [-b.max[0], b.min[1], b.min[2]], max: [-b.min[0], b.max[1], b.max[2]] },
];

/** Wheels at the given axles (z), half a track `x` out, `r` in radius. */
function wheels(axles: number[], x: number, r: number, width = 0.24): Box[] {
  return axles.flatMap((z) =>
    both({ min: [x - width, 0, z - r * 0.9], max: [x, 2 * r, z + r * 0.9], color: TYRE }),
  );
}

/** Lamps: a pair at the front or back face `z` (facing out by `dir`), at height y0-y1,
 * from x0 to x1 out from the middle. */
function lamps(
  z: number,
  dir: 1 | -1,
  y: [number, number],
  x: [number, number],
  color: number,
): Box[] {
  const [za, zb] = dir > 0 ? [z - 0.02, z + 0.03] : [z - 0.03, z + 0.02];
  return both({ min: [x[0], y[0], za], max: [x[1], y[1], zb], color });
}

/** Indicators at the four corners of a vehicle, one side's pair. */
function indicators(side: 1 | -1, front: number, back: number, y: number, x: number): Box[] {
  const [xa, xb] = side > 0 ? [x - 0.14, x + 0.01] : [-x - 0.01, -x + 0.14];
  return [
    { min: [xa, y, front - 0.02], max: [xb, y + 0.08, front + 0.03], color: AMBER },
    { min: [xa, y, back - 0.03], max: [xb, y + 0.08, back + 0.02], color: AMBER },
  ];
}

/** A car of length `len` (m) from its body and glasshouse outlines. */
function car(
  name: string,
  len: number,
  body: [number, number][],
  glass: [number, number][],
  roof: [number, number][],
  options: { width?: number; wheel?: number; clearance?: number; lampY?: number } = {},
): Model {
  const w = options.width ?? 0.88;
  const r = options.wheel ?? 0.31;
  const half = len / 2;
  const axle = half - 0.85;
  const lampY = options.lampY ?? 0.62;
  return {
    name,
    parts: [
      { profile: body, x: [-w, w], color: PAINT },
      { profile: glass, x: [-(w - 0.07), w - 0.07], color: GLASS },
      { profile: roof, x: [-(w - 0.06), w - 0.06], color: PAINT },
      { min: [-w + 0.05, options.clearance ?? 0.14, -half + 0.15], max: [w - 0.05, 0.32, half - 0.15], color: DARK },
      ...wheels([axle, -axle], w + 0.02, r),
    ],
    head: lamps(half, 1, [lampY, lampY + 0.13], [w - 0.4, w - 0.1], HEAD),
    tail: lamps(-half, -1, [lampY + 0.05, lampY + 0.2], [w - 0.35, w - 0.08], TAIL),
    left: indicators(-1, half, -half, lampY - 0.1, w - 0.02),
    right: indicators(1, half, -half, lampY - 0.1, w - 0.02),
    front: half,
    halfWidth: w,
  };
} // prettier-ignore

/** Car shapes: Zagreb's streets are mostly hatchbacks and saloons, with estates, SUVs and
 * small vans (shares estimated). */
export const CARS: { model: Model; weight: number }[] = [
  {
    weight: 40,
    model: car(
      'hatchback',
      4.2,
      [[-2.1, 0.3], [2.1, 0.3], [2.13, 0.6], [1.95, 0.8], [0.85, 0.92], [-1.95, 0.95], [-2.12, 0.72]],
      [[-1.97, 0.95], [0.85, 0.92], [0.15, 1.38], [-1.6, 1.42]],
      [[-1.58, 1.42], [0.13, 1.38], [0.08, 1.44], [-1.55, 1.48]],
    ),
  },
  {
    weight: 25,
    model: car(
      'saloon',
      4.7,
      [[-2.35, 0.3], [2.35, 0.3], [2.38, 0.6], [2.15, 0.78], [1.0, 0.9], [-1.65, 0.93], [-2.3, 0.86], [-2.38, 0.62]],
      [[-1.65, 0.93], [1.0, 0.9], [0.25, 1.36], [-1.05, 1.39]],
      [[-1.03, 1.39], [0.23, 1.36], [0.18, 1.42], [-1.0, 1.45]],
    ),
  },
  {
    weight: 15,
    model: car(
      'estate',
      4.7,
      [[-2.35, 0.3], [2.35, 0.3], [2.38, 0.6], [2.15, 0.78], [1.0, 0.9], [-2.25, 0.95], [-2.38, 0.66]],
      [[-2.25, 0.95], [1.0, 0.9], [0.25, 1.38], [-2.15, 1.42]],
      [[-2.13, 1.42], [0.23, 1.38], [0.18, 1.44], [-2.1, 1.48]],
    ),
  },
  {
    weight: 15,
    model: car(
      'SUV',
      4.5,
      [[-2.25, 0.42], [2.25, 0.42], [2.28, 0.78], [2.05, 0.98], [0.95, 1.08], [-2.15, 1.12], [-2.28, 0.9]],
      [[-2.15, 1.12], [0.95, 1.08], [0.35, 1.58], [-1.95, 1.62]],
      [[-1.93, 1.62], [0.33, 1.58], [0.28, 1.66], [-1.9, 1.7]],
      { width: 0.92, wheel: 0.36, clearance: 0.22, lampY: 0.8 },
    ),
  },
  {
    weight: 5,
    model: car(
      'van',
      4.8,
      [[-2.4, 0.35], [2.4, 0.35], [2.43, 0.8], [2.2, 1.05], [-2.4, 1.1]],
      [[-2.38, 1.1], [2.2, 1.05], [1.45, 1.62], [-2.35, 1.66]],
      [[-2.38, 1.6], [1.5, 1.58], [1.4, 1.95], [-2.38, 1.98]],
      { width: 0.95, wheel: 0.33, lampY: 0.75 },
    ),
  },
]; // prettier-ignore

/** Lorries, 10 m: a box van and a flatbed with its load. */
export const LORRIES: Model[] = [
  {
    name: 'box lorry',
    parts: [
      { min: [-1.2, 0.25, -4.9], max: [1.2, 0.9, 4.9], color: DARK },
      { profile: [[2.8, 0.9], [5.0, 0.9], [5.0, 1.85], [4.85, 2.75], [2.8, 2.8]], x: [-1.25, 1.25], color: PAINT },
      { profile: [[4.86, 1.9], [5.02, 1.9], [4.9, 2.6], [4.75, 2.6]], x: [-1.15, 1.15], color: GLASS },
      { min: [-1.27, 0.95, -5.0], max: [1.27, 3.6, 2.6], color: LIGHT_GREY },
      ...wheels([3.9, -2.4, -3.6], 1.2, 0.5, 0.3),
    ],
    head: lamps(5.0, 1, [0.95, 1.15], [0.75, 1.1], HEAD),
    tail: lamps(-5.0, -1, [0.6, 0.85], [0.85, 1.2], TAIL),
    left: indicators(-1, 5.0, -5.0, 0.8, 1.22),
    right: indicators(1, 5.0, -5.0, 0.8, 1.22),
    front: 5.0,
    halfWidth: 1.25,
  },
  {
    name: 'flatbed lorry',
    parts: [
      { min: [-1.2, 0.25, -4.9], max: [1.2, 1.1, 4.9], color: DARK },
      { profile: [[2.9, 1.1], [5.0, 1.1], [5.0, 1.95], [4.85, 2.8], [2.9, 2.85]], x: [-1.25, 1.25], color: PAINT },
      { profile: [[4.86, 2.0], [5.02, 2.0], [4.9, 2.65], [4.75, 2.65]], x: [-1.15, 1.15], color: GLASS },
      { min: [-1.25, 1.1, -5.0], max: [1.25, 1.35, 2.7], color: GREY },
      { min: [-1.0, 1.35, -4.4], max: [1.0, 2.3, -1.4], color: 0x9a7b4f },
      { min: [-1.0, 1.35, -1.1], max: [1.0, 2.0, 2.2], color: 0x6f7d86 },
      ...wheels([3.9, -2.4, -3.6], 1.2, 0.5, 0.3),
    ],
    head: lamps(5.0, 1, [1.15, 1.35], [0.75, 1.1], HEAD),
    tail: lamps(-5.0, -1, [0.75, 1.0], [0.85, 1.2], TAIL),
    left: indicators(-1, 5.0, -5.0, 0.95, 1.22),
    right: indicators(1, 5.0, -5.0, 0.95, 1.22),
    front: 5.0,
    halfWidth: 1.25,
  },
]; // prettier-ignore

/** ZET's 12 m low-floor bus: blue, a band of windows, a white roof with its equipment. */
export const BUS: Model = {
  name: 'ZET bus',
  parts: [
    { min: [-1.27, 0.3, -6.0], max: [1.27, 1.05, 6.0], color: PAINT },
    { min: [-1.25, 1.05, -5.9], max: [1.25, 2.55, 5.75], color: GLASS },
    { profile: [[5.75, 1.05], [6.02, 1.05], [5.95, 2.55], [5.75, 2.6]], x: [-1.24, 1.24], color: GLASS },
    { min: [-1.27, 2.55, -6.0], max: [1.27, 2.95, 5.95], color: PAINT },
    { min: [-1.1, 2.95, -5.6], max: [1.1, 3.25, -3.2], color: WHITE },
    { min: [-0.9, 2.95, 1.0], max: [0.9, 3.15, 3.2], color: WHITE },
    // Doors: darker panels on the right side.
    { min: [1.27, 0.35, 3.9], max: [1.29, 2.5, 5.1], color: DARK },
    { min: [1.27, 0.35, -0.6], max: [1.29, 2.5, 0.6], color: DARK },
    ...wheels([4.1, -2.4], 1.25, 0.48, 0.3),
  ],
  head: lamps(6.0, 1, [0.5, 0.72], [0.75, 1.15], HEAD),
  tail: lamps(-6.0, -1, [0.6, 0.95], [0.9, 1.2], TAIL),
  left: indicators(-1, 6.0, -6.0, 0.8, 1.25),
  right: indicators(1, 6.0, -6.0, 0.8, 1.25),
  front: 6.0,
  halfWidth: 1.27,
}; // prettier-ignore

/** One module of a tram, from z0 to z1, its body blue and its roof white. */
function tramModule(z0: number, z1: number): Part[] {
  return [
    { min: [-1.15, 0.35, z0], max: [1.15, 1.15, z1], color: PAINT },
    { min: [-1.13, 1.15, z0 + 0.15], max: [1.13, 2.65, z1 - 0.15], color: GLASS },
    { min: [-1.15, 2.65, z0], max: [1.15, 3.3, z1], color: WHITE },
  ];
}

/** ZET's 32 m low-floor tram (TMK 2200): five modules, a sloped nose, a pantograph. */
export const TRAM: Model = {
  name: 'ZET tram',
  parts: [
    ...tramModule(-16.0, -10.4),
    ...tramModule(-10.1, -4.0),
    ...tramModule(-3.7, 3.7),
    ...tramModule(4.0, 10.1),
    ...tramModule(10.4, 14.8),
    // The cab: a sloping glass front.
    { profile: [[14.8, 0.35], [16.0, 0.35], [16.05, 1.15], [15.6, 2.7], [14.8, 3.3]], x: [-1.15, 1.15], color: PAINT },
    { profile: [[15.0, 1.15], [16.07, 1.15], [15.63, 2.68], [15.0, 2.68]], x: [-1.1, 1.1], color: GLASS },
    // Articulation joints, roof equipment and the pantograph.
    { min: [-1.0, 0.4, -10.4], max: [1.0, 3.1, -10.1], color: DARK },
    { min: [-1.0, 0.4, -4.0], max: [1.0, 3.1, -3.7], color: DARK },
    { min: [-1.0, 0.4, 3.7], max: [1.0, 3.1, 4.0], color: DARK },
    { min: [-1.0, 0.4, 10.1], max: [1.0, 3.1, 10.4], color: DARK },
    { min: [-0.8, 3.3, -2.5], max: [0.8, 3.6, 2.5], color: GREY },
    { min: [-0.7, 3.6, -0.1], max: [0.7, 3.65, 0.1], color: DARK },
    { min: [-0.05, 3.6, -0.6], max: [0.05, 4.3, 0.6], color: DARK },
    { min: [-0.75, 4.3, -0.1], max: [0.75, 4.35, 0.1], color: DARK },
    ...[-13.2, -7.0, 7.0, 12.6].flatMap((z) => both({ min: [0.6, 0.05, z - 1.0], max: [1.05, 0.4, z + 1.0], color: TYRE })),
  ],
  head: lamps(16.0, 1, [0.7, 0.9], [0.55, 0.95], HEAD),
  tail: lamps(-16.0, -1, [0.75, 0.95], [0.55, 0.95], TAIL),
  left: indicators(-1, 16.0, -16.0, 1.0, 1.15),
  right: indicators(1, 16.0, -16.0, 1.0, 1.15),
  front: 16.0,
  halfWidth: 1.15,
}; // prettier-ignore

/** The models for each engine vehicle type (car, lorry, bus, tram). */
export const MODELS: Model[][] = [CARS.map((c) => c.model), LORRIES, [BUS], [TRAM]];

const CAR_TOTAL = CARS.reduce((n, c) => n + c.weight, 0);

/** Which of its type's models a vehicle is, from its 16-bit colour seed. */
export function modelOf(type: number, seed: number): number {
  if (type === 0) {
    // The seed's low byte (the colour uses the whole seed, so shape and colour vary apart).
    let pick = (((seed * 2654435761) >>> 24) / 256) * CAR_TOTAL;
    for (let k = 0; k < CARS.length; k++) {
      pick -= CARS[k].weight;
      if (pick < 0) return k;
    }
    return 0;
  }
  if (type === 1) return seed % LORRIES.length;
  return 0;
}
