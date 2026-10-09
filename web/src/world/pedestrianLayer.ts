/**
 * Pedestrians at crossings (M8c): those waiting at the kerb and those crossing, drawn as
 * simple figures at the crossings near the view. The engine has them as numbers per crossing
 * (sim/src/pedestrians.rs: how many wait, how far across the last group is); where each
 * figure stands is made up here, at the kerbs and along the crossing.
 */
import * as THREE from 'three/webgpu';

import type { HeightFn } from './roadGeometry';
import type { RoadNetwork } from './roadNetwork';

/** Figures drawn at most, and per crossing waiting or walking. */
const MAX_FIGURES = 800;
const MAX_WAITING = 6;
/** Crossings within this far (m) of the view's target are drawn, below `MAX_VIEW` m. */
const RANGE = 350;
const MAX_VIEW = 1200;
/** Clothes, drab to bright. */
const COLOURS = [0x2f3640, 0x4b6584, 0x8c2f39, 0xd1a054, 0x3c6e47, 0x6c5b7b, 0xbfbfbf, 0x1e3799];

/** The crossing arrays the app loads (pipeline/pedestrians.py). */
export interface CrossingArrays {
  crossingLaneOffsets: Uint32Array;
  crossingLanes: Uint32Array;
  crossingLength: Float32Array;
  crossingXY: Float32Array;
}

export class PedestrianLayer {
  readonly object: THREE.InstancedMesh;
  /** Per crossing: its kerbs (x, y, z of one end, then of the other). */
  private readonly ends: Float32Array;
  private readonly count: number;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly scale = new THREE.Vector3(1, 1, 1);

  constructor(net: RoadNetwork, height: HeightFn, arrays: CrossingArrays) {
    this.count = arrays.crossingLength.length;
    this.ends = new Float32Array(this.count * 6);
    for (let c = 0; c < this.count; c++) {
      const x = arrays.crossingXY[2 * c];
      const z = arrays.crossingXY[2 * c + 1];
      // Across the first lane it crosses, at its nearest point.
      const lane = arrays.crossingLanes[arrays.crossingLaneOffsets[c]];
      const [dx, dz] = laneDirection(net, lane, x, z);
      const half = arrays.crossingLength[c] / 2;
      const y = height(x, z) + 0.05;
      this.ends.set([x - dz * half, y, z + dx * half, x + dz * half, y, z - dx * half], 6 * c);
    }
    // A figure about 1.7 m tall: body and head in one capsule.
    const geometry = new THREE.CapsuleGeometry(0.24, 1.2, 2, 6);
    geometry.translate(0, 0.84, 0);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
    this.object = new THREE.InstancedMesh(geometry, material, MAX_FIGURES);
    this.object.name = 'pedestrians';
    this.object.frustumCulled = false;
    this.object.count = 0;
    const colour = new THREE.Color();
    for (let i = 0; i < MAX_FIGURES; i++) {
      this.object.setColorAt(i, colour.setHex(COLOURS[(i * 7 + (i >> 3)) % COLOURS.length]));
    }
  }

  /** Place the figures for crossings' `state` (two bytes each, wasm.ts `crossings`). */
  update(state: Uint8Array | undefined, target: THREE.Vector3, viewHeight: number): void {
    let n = 0;
    if (state && state.length >= 2 * this.count && viewHeight < MAX_VIEW) {
      const r2 = RANGE * RANGE;
      for (let c = 0; c < this.count && n < MAX_FIGURES; c++) {
        const e = this.ends;
        const mx = (e[6 * c] + e[6 * c + 3]) / 2 - target.x;
        const mz = (e[6 * c + 2] + e[6 * c + 5]) / 2 - target.z;
        if (mx * mx + mz * mz > r2) continue;
        const waiting = Math.min(state[2 * c], MAX_WAITING);
        const progress = state[2 * c + 1];
        // Odd crossings wait and start from their other kerb.
        const [from, to] = c & 1 ? [3, 0] : [0, 3];
        const ax = e[6 * c + from];
        const az = e[6 * c + from + 2];
        const bx = e[6 * c + to];
        const bz = e[6 * c + to + 2];
        const y = e[6 * c + 1];
        const ux = (bx - ax) / Math.max(Math.hypot(bx - ax, bz - az), 0.1);
        const uz = (bz - az) / Math.max(Math.hypot(bx - ax, bz - az), 0.1);
        for (let k = 0; k < waiting && n < MAX_FIGURES; k++) {
          // In a row along the kerb, half a metre back from it.
          const side = (k - (waiting - 1) / 2) * 0.7;
          this.place(n++, ax - ux * 0.5 - uz * side, y, az - uz * 0.5 + ux * side, ux, uz);
        }
        if (progress !== 255) {
          const t = progress / 254;
          const group = 1 + (c % 3);
          for (let k = 0; k < group && n < MAX_FIGURES; k++) {
            const side = (k - (group - 1) / 2) * 0.8;
            const back = (k & 1) * 0.6;
            const x = ax + (bx - ax) * t - ux * back - uz * side;
            const z = az + (bz - az) * t - uz * back + ux * side;
            this.place(n++, x, y, z, ux, uz);
          }
        }
      }
    }
    this.object.count = n;
    this.object.instanceMatrix.needsUpdate = true;
  }

  private place(i: number, x: number, y: number, z: number, ux: number, uz: number): void {
    this.turn.setFromAxisAngle(this.up, Math.atan2(ux, uz));
    this.position.set(x, y, z);
    this.matrix.compose(this.position, this.turn, this.scale);
    this.object.setMatrixAt(i, this.matrix);
  }
}

/** Unit direction (x, z) of `lane` at the point of its shape nearest (x, z). */
function laneDirection(net: RoadNetwork, lane: number, x: number, z: number): [number, number] {
  const { start, count } = net.lanePoints(lane);
  let best = Infinity;
  let dir: [number, number] = [1, 0];
  for (let k = 0; k < count - 1; k++) {
    const p = (start + k) * 3;
    const q = (start + k + 1) * 3;
    const ax = net.laneShape[p];
    const az = net.laneShape[p + 1];
    const sx = net.laneShape[q] - ax;
    const sz = net.laneShape[q + 1] - az;
    const len2 = sx * sx + sz * sz;
    if (len2 < 1e-6) continue;
    const t = Math.min(1, Math.max(0, ((x - ax) * sx + (z - az) * sz) / len2));
    const d = Math.hypot(ax + sx * t - x, az + sz * t - z);
    if (d < best) {
      best = d;
      const len = Math.sqrt(len2);
      dir = [sx / len, sz / len];
    }
  }
  return dir;
}
