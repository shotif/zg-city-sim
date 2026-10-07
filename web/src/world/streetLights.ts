/**
 * Street lamps at night (M6a): a pool of light on the road every 40 m along each side of
 * the streets among buildings (a building within about 100 m), drawn in chunks around the
 * view like the roads. Motorways, service roads, tram tracks, railways and roads through
 * open country have none. Where lamps really stand is not in the data; the spacing is
 * typical of Zagreb's streets (the City runs about 126,000 lamps).
 */
import * as THREE from 'three/webgpu';

import { uniform } from 'three/tsl';

import { GLOW_ORDER, glowMaterial, nightUniform } from './nightLights';
import type { RoadClass, RoadNetwork } from './roadNetwork';
import type { HeightFn } from './roadGeometry';

/** Metres between lamps along a side of a street. */
export const LAMP_SPACING = 40;
/** From a street's outer lane edge to the lamp's pool centre (m). */
const SIDE = 1.5;
/** Pool of light on the ground (m across), and how far it grows as the view goes out. */
const POOL = 36;
const MAX_GROW = 3;
const CHUNK = 2000;
/** Lamps are drawn below this view height (m). */
const MAX_VIEW = 15_000;
/** Chunks built per frame at most. */
const BUDGET = 6;
const LIT: ReadonlySet<RoadClass> = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'minor']);

/** Where there are buildings: 100 m squares with a building's centre in them. */
export class BuiltArea {
  private readonly cells = new Set<number>();
  constructor(
    centres: Float32Array,
    private readonly cell = 100,
  ) {
    for (let k = 0; k < centres.length; k += 2) {
      this.cells.add(this.key(Math.floor(centres[k] / cell), Math.floor(centres[k + 1] / cell)));
    }
  }

  private key(i: number, j: number): number {
    return (i + 5000) * 10_000 + (j + 5000);
  }

  /** Whether a building stands in the square at (x, z) or one next to it. */
  near(x: number, z: number): boolean {
    const i = Math.floor(x / this.cell);
    const j = Math.floor(z / this.cell);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) if (this.cells.has(this.key(i + di, j + dj))) return true;
    }
    return false;
  }
}

/** Lamp positions (x, z pairs): along each direction's right-hand side, every `spacing` m
 * from half a spacing in; only where `lit` says (streets among buildings). */
export function lampPositions(
  net: RoadNetwork,
  spacing = LAMP_SPACING,
  lit: (x: number, z: number) => boolean = () => true,
): Float32Array {
  const out: number[] = [];
  const shape = net.laneShape;
  for (let e = 0; e < net.edgeCount; e++) {
    if (net.isInternal(e) || !LIT.has(net.edgeClass[e]) || net.edgeLaneCount[e] === 0) continue;
    const lane = net.edgeLaneStart[e];
    const { start, count } = net.lanePoints(lane);
    const side = net.laneWidth[lane] / 2 + SIDE;
    let next = spacing / 2;
    let walked = 0;
    for (let k = 0; k + 1 < count; k++) {
      const ax = shape[(start + k) * 3];
      const az = shape[(start + k) * 3 + 1];
      const bx = shape[(start + k + 1) * 3];
      const bz = shape[(start + k + 1) * 3 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len <= 0) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      while (next <= walked + len) {
        const t = next - walked;
        // To the right of the direction of travel (x east, z south): (-uz, ux).
        const x = ax + ux * t - uz * side;
        const z = az + uz * t + ux * side;
        if (lit(x, z)) out.push(x, z);
        next += spacing;
      }
      walked += len;
    }
  }
  return Float32Array.from(out);
}

export class StreetLightLayer {
  readonly object = new THREE.Group();
  private readonly chunks = new Map<string, number[]>();
  private readonly meshes = new Map<string, THREE.InstancedMesh>();
  private readonly geometry = new THREE.PlaneGeometry(POOL, POOL).rotateX(-Math.PI / 2);
  private readonly size = uniform(1);
  private readonly material = glowMaterial(0xffd9a0, 0.15, this.size);
  private readonly lamps: Float32Array;

  constructor(
    net: RoadNetwork,
    private readonly height: HeightFn,
    built?: BuiltArea,
  ) {
    this.object.name = 'street lights';
    this.lamps = lampPositions(net, LAMP_SPACING, built && ((x, z) => built.near(x, z)));
    for (let k = 0; k < this.lamps.length / 2; k++) {
      const key = `${Math.floor(this.lamps[k * 2] / CHUNK)},${Math.floor(this.lamps[k * 2 + 1] / CHUNK)}`;
      const list = this.chunks.get(key);
      if (list) list.push(k);
      else this.chunks.set(key, [k]);
    }
  }

  get count(): number {
    return this.lamps.length / 2;
  }

  /** Show the lamps around the view while it is dark; whether anything changed. */
  update(target: THREE.Vector3, viewHeight: number): boolean {
    const visible = nightUniform.value > 0.02 && viewHeight < MAX_VIEW;
    let changed = this.object.visible !== visible;
    this.object.visible = visible;
    if (!visible) return changed;
    const grow = Math.min(MAX_GROW, Math.max(1, viewHeight / 2000));
    if (Math.abs(this.size.value - grow) > 0.01) {
      this.size.value = grow;
      // Far out the pools are larger and fewer (each chunk's lamps are in random order),
      // so the glow covers as much for a fraction of the drawing.
      this.share = 1 / (grow * grow);
      for (const mesh of this.meshes.values()) mesh.count = this.drawn(mesh);
      changed = true;
    }
    const radius = Math.max(2000, viewHeight * 1.2);
    const [c0, c1] = [
      Math.floor((target.x - radius) / CHUNK),
      Math.floor((target.x + radius) / CHUNK),
    ];
    const [r0, r1] = [
      Math.floor((target.z - radius) / CHUNK),
      Math.floor((target.z + radius) / CHUNK),
    ];
    // Nearest first, so what is in view lights up first.
    const missing: [number, string][] = [];
    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const key = `${cx},${cz}`;
        if (this.meshes.has(key) || !this.chunks.has(key)) continue;
        const d = Math.hypot((cx + 0.5) * CHUNK - target.x, (cz + 0.5) * CHUNK - target.z);
        missing.push([d, key]);
      }
    }
    missing.sort((a, b) => a[0] - b[0]);
    for (const [, key] of missing.slice(0, BUDGET)) {
      this.build(key);
      changed = true;
    }
    return changed;
  }

  /** Share of each chunk's lamps drawn. */
  private share = 1;

  private drawn(mesh: THREE.InstancedMesh): number {
    return Math.max(1, Math.round(mesh.instanceMatrix.count * this.share));
  }

  private build(key: string): void {
    const ids = [...(this.chunks.get(key) ?? [])];
    // Random order (seeded by the chunk), so drawing the first few spreads them out.
    let seed = key.length * 7919 + ids.length;
    for (let i = ids.length - 1; i > 0; i--) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const j = seed % (i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, ids.length);
    const m = new THREE.Matrix4();
    ids.forEach((k, i) => {
      const x = this.lamps[k * 2];
      const z = this.lamps[k * 2 + 1];
      m.makeTranslation(x, this.height(x, z) + 0.35, z);
      mesh.setMatrixAt(i, m);
    });
    mesh.computeBoundingSphere();
    mesh.count = this.drawn(mesh);
    mesh.renderOrder = GLOW_ORDER;
    mesh.name = `lamps ${key}`;
    this.object.add(mesh);
    this.meshes.set(key, mesh);
  }
}
