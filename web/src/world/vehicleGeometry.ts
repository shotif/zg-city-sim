import * as THREE from 'three/webgpu';

/** An axis-aligned box in vehicle space (x right, y up, z forward) with a vertex colour. */
export interface Part {
  min: [number, number, number];
  max: [number, number, number];
  /** Multiplied by the instance colour; white parts take the vehicle's paint. */
  color: number;
}

const FACES: { normal: [number, number, number]; corners: [number, number, number][] }[] = [
  {
    normal: [1, 0, 0],
    corners: [
      [1, 0, 1],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
    ],
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    normal: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
  },
  {
    normal: [0, 0, -1],
    corners: [
      [1, 0, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
  },
];

/** Paint colour placeholder: parts in this colour take each vehicle's own paint. */
export const PAINT = 0xffffff;

/** Merge boxes into one flat-shaded, vertex-coloured geometry. */
export function boxesGeometry(parts: Part[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const color = new THREE.Color();
  for (const part of parts) {
    color.setHex(part.color, THREE.SRGBColorSpace);
    for (const face of FACES) {
      const base = positions.length / 3;
      for (const [cx, cy, cz] of face.corners) {
        positions.push(
          cx ? part.max[0] : part.min[0],
          cy ? part.max[1] : part.min[1],
          cz ? part.max[2] : part.min[2],
        );
        normals.push(...face.normal);
        colors.push(color.r, color.g, color.b);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const GLASS = 0x2a3038;
const DARK = 0x1c1d1f;
const LIGHT_GREY = 0xd9dbdc;

/** Low-poly vehicle shapes by engine vehicle type (car, truck, bus, tram), origin at the
 * centre of the footprint on the road, facing +z. */
export const VEHICLE_PARTS: Part[][] = [
  // Car, 4.5 m.
  [
    { min: [-0.85, 0.12, -2.1], max: [0.85, 0.3, 2.1], color: DARK },
    { min: [-0.9, 0.3, -2.25], max: [0.9, 0.82, 2.25], color: PAINT },
    { min: [-0.78, 0.82, -1.35], max: [0.78, 1.4, 0.85], color: GLASS },
    { min: [-0.74, 1.4, -1.25], max: [0.74, 1.46, 0.7], color: PAINT },
  ],
  // Truck, 10 m: cab in front, box behind.
  [
    { min: [-1.2, 0.2, -4.9], max: [1.2, 0.95, 4.9], color: DARK },
    { min: [-1.25, 0.95, 2.8], max: [1.25, 2.1, 5.0], color: PAINT },
    { min: [-1.2, 2.1, 3.0], max: [1.2, 2.75, 4.95], color: GLASS },
    { min: [-1.27, 0.95, -5.0], max: [1.27, 3.6, 2.6], color: LIGHT_GREY },
  ],
  // Bus, 12 m (ZET colours come from the instance colour).
  [
    { min: [-1.27, 0.3, -6.0], max: [1.27, 1.25, 6.0], color: PAINT },
    { min: [-1.25, 1.25, -5.9], max: [1.25, 2.55, 5.95], color: GLASS },
    { min: [-1.27, 2.55, -6.0], max: [1.27, 3.05, 6.0], color: PAINT },
  ],
  // Tram, 32 m in three sections.
  [
    { min: [-1.15, 0.35, -16.0], max: [1.15, 1.2, -5.6], color: PAINT },
    { min: [-1.15, 0.35, -5.2], max: [1.15, 1.2, 5.2], color: PAINT },
    { min: [-1.15, 0.35, 5.6], max: [1.15, 1.2, 16.0], color: PAINT },
    { min: [-1.13, 1.2, -15.9], max: [1.13, 2.6, 15.9], color: GLASS },
    { min: [-1.15, 2.6, -16.0], max: [1.15, 3.3, 16.0], color: LIGHT_GREY },
  ],
];

/** Lamps by vehicle type: headlamps at the front and tail lamps at the back (boxes in
 * vehicle space, standing 3 cm proud of the body), and the length of the vehicle's front
 * from its centre (where its headlight beam starts). */
export interface Lamps {
  head: Part[];
  tail: Part[];
  front: number;
  halfWidth: number;
}

const HEAD = 0xfff6d8;
const TAIL = 0xff2a1a;
const pair = (
  z0: number,
  z1: number,
  y0: number,
  y1: number,
  x0: number,
  x1: number,
  color: number,
): Part[] => [
  { min: [x0, y0, z0], max: [x1, y1, z1], color },
  { min: [-x1, y0, z0], max: [-x0, y1, z1], color },
];

export const VEHICLE_LAMPS: Lamps[] = [
  {
    head: pair(2.24, 2.28, 0.55, 0.7, 0.5, 0.82, HEAD),
    tail: pair(-2.28, -2.24, 0.6, 0.76, 0.52, 0.84, TAIL),
    front: 2.25,
    halfWidth: 0.9,
  },
  {
    head: pair(4.99, 5.03, 0.75, 0.95, 0.75, 1.1, HEAD),
    tail: pair(-5.03, -4.99, 0.6, 0.8, 0.85, 1.2, TAIL),
    front: 5.0,
    halfWidth: 1.25,
  },
  {
    head: pair(5.99, 6.03, 0.5, 0.75, 0.75, 1.15, HEAD),
    tail: pair(-6.03, -5.99, 0.6, 0.9, 0.85, 1.2, TAIL),
    front: 6.0,
    halfWidth: 1.27,
  },
  {
    head: pair(15.99, 16.03, 0.7, 0.9, 0.55, 0.95, HEAD),
    tail: pair(-16.03, -15.99, 0.7, 0.9, 0.55, 0.95, TAIL),
    front: 16.0,
    halfWidth: 1.15,
  },
];

/** Common car colours in Croatia, weighted (white, greys, black, silver, blues, reds…). */
const CAR_COLORS: [number, number][] = [
  [0xf2f2ef, 24],
  [0x8c9196, 12],
  [0x50555a, 8],
  [0x18191b, 16],
  [0xb9bdc1, 13],
  [0x1f3f73, 7],
  [0x5f87b3, 3],
  [0x9c1c1c, 7],
  [0x6b4a33, 3],
  [0x36553a, 2],
  [0xd9a521, 2],
  [0xc8481f, 1],
  [0xe4d9c0, 2],
];
const CAR_COLOR_TOTAL = CAR_COLORS.reduce((sum, [, w]) => sum + w, 0);

const TRUCK_CABS = [0xf2f2ef, 0xf2f2ef, 0x1f3f73, 0x9c1c1c, 0xd9a521, 0x2b2d30];
/** ZET blue. */
export const ZET_BLUE = 0x1d4fa0;

/** Paint colour for a vehicle of `type` from its 16-bit colour seed. */
export function vehicleColor(type: number, seed: number, out: THREE.Color): THREE.Color {
  if (type === 2 || type === 3) return out.setHex(ZET_BLUE, THREE.SRGBColorSpace);
  if (type === 1) return out.setHex(TRUCK_CABS[seed % TRUCK_CABS.length], THREE.SRGBColorSpace);
  let pick = (seed / 65536) * CAR_COLOR_TOTAL;
  for (const [hex, weight] of CAR_COLORS) {
    pick -= weight;
    if (pick < 0) return out.setHex(hex, THREE.SRGBColorSpace);
  }
  return out.setHex(CAR_COLORS[0][0], THREE.SRGBColorSpace);
}
