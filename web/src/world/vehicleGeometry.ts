import * as THREE from 'three/webgpu';

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
/** The blue band on HŽ's trains. */
export const HZ_BLUE = 0x1b3c8c;

/** Paint colour for a vehicle of `type` from its 16-bit colour seed. */
export function vehicleColor(type: number, seed: number, out: THREE.Color): THREE.Color {
  if (type === 2 || type === 3) return out.setHex(ZET_BLUE, THREE.SRGBColorSpace);
  if (type === 4) return out.setHex(HZ_BLUE, THREE.SRGBColorSpace);
  if (type === 1) return out.setHex(TRUCK_CABS[seed % TRUCK_CABS.length], THREE.SRGBColorSpace);
  let pick = (seed / 65536) * CAR_COLOR_TOTAL;
  for (const [hex, weight] of CAR_COLORS) {
    pick -= weight;
    if (pick < 0) return out.setHex(hex, THREE.SRGBColorSpace);
  }
  return out.setHex(CAR_COLORS[0][0], THREE.SRGBColorSpace);
}
