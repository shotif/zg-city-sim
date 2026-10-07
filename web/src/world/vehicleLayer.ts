import * as THREE from 'three/webgpu';

import { INFO, RENDER } from '../sim/wasm';
import { GLOW_ORDER, SOLID_ORDER, glowMaterial, nightUniform } from './nightLights';
import type { HeightFn } from './roadGeometry';
import {
  PAINT,
  VEHICLE_LAMPS,
  VEHICLE_PARTS,
  boxesGeometry,
  vehicleColor,
} from './vehicleGeometry';

/** Vehicles sit on the road surface, which is drawn this far above the ground. */
const ROAD_LIFT = 0.12;
/** Vehicles are drawn when the view shows less than this many metres. */
export const VEHICLE_MAX_VIEW = 6_000;

export interface VehicleView {
  target: THREE.Vector3;
  viewHeight: number;
  /** Draw vehicles within this distance (m) of the view centre. */
  radius: number;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const asFloat = (bits: number) => {
  u32[0] = bits;
  return f32[0];
};

/** Interpolate angles the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/**
 * Pose of slot `slot` between two render frames: [x, y, z, heading], or null if the slot is
 * empty in `cur`. A vehicle that is new in `cur` (different serial) is not interpolated.
 */
export function interpolatePose(
  prev: Uint32Array | undefined,
  cur: Uint32Array,
  slot: number,
  alpha: number,
  out: Float64Array,
): boolean {
  const o = slot * RENDER.stride;
  const serial = cur[o + RENDER.serial];
  if (serial === 0) return false;
  const x = asFloat(cur[o + RENDER.x]);
  const y = asFloat(cur[o + RENDER.y]);
  const z = asFloat(cur[o + RENDER.z]);
  const h = asFloat(cur[o + RENDER.heading]);
  if (prev && o + RENDER.stride <= prev.length && prev[o + RENDER.serial] === serial && alpha < 1) {
    const t = alpha;
    out[0] = asFloat(prev[o + RENDER.x]) + (x - asFloat(prev[o + RENDER.x])) * t;
    out[1] = asFloat(prev[o + RENDER.y]) + (y - asFloat(prev[o + RENDER.y])) * t;
    out[2] = asFloat(prev[o + RENDER.z]) + (z - asFloat(prev[o + RENDER.z])) * t;
    out[3] = lerpAngle(asFloat(prev[o + RENDER.heading]), h, t);
  } else {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = h;
  }
  return true;
}

/**
 * Draws the simulation's vehicles as instanced low-poly models. Each vehicle type has two
 * meshes sharing one set of instance transforms: the painted body, coloured per vehicle,
 * and the parts that keep their own colour (glass, cargo boxes, roofs).
 */
export class VehicleLayer {
  readonly object = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly fixedMeshes: THREE.InstancedMesh[] = [];
  /** Headlamps, tail lamps and headlight beams (M6a), sharing the vehicles' transforms. */
  private readonly headMeshes: THREE.InstancedMesh[] = [];
  private readonly tailMeshes: THREE.InstancedMesh[] = [];
  private readonly beamMeshes: THREE.InstancedMesh[] = [];
  private readonly paintGeometries: THREE.BufferGeometry[];
  private readonly fixedGeometries: THREE.BufferGeometry[];
  private readonly headGeometries: THREE.BufferGeometry[];
  private readonly tailGeometries: THREE.BufferGeometry[];
  private readonly beamGeometries: THREE.BufferGeometry[];
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  /** Lamps glow: unlit, their colour times the instance's brightness. */
  private readonly lampMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly beamMaterial = glowMaterial(0xfff2cc, 0.25);
  private readonly pose = new Float64Array(4);
  private readonly color = new THREE.Color();
  /** Vehicles drawn in the last update. */
  drawn = 0;

  constructor(private readonly height: HeightFn) {
    this.object.name = 'vehicles';
    this.paintGeometries = VEHICLE_PARTS.map((parts) =>
      boxesGeometry(parts.filter((part) => part.color === PAINT)),
    );
    this.fixedGeometries = VEHICLE_PARTS.map((parts) =>
      boxesGeometry(parts.filter((part) => part.color !== PAINT)),
    );
    this.headGeometries = VEHICLE_LAMPS.map((l) => boxesGeometry(l.head));
    this.tailGeometries = VEHICLE_LAMPS.map((l) => boxesGeometry(l.tail));
    // A beam on the road ahead: 18 m long, a little wider than the vehicle.
    this.beamGeometries = VEHICLE_LAMPS.map((l) =>
      new THREE.PlaneGeometry(l.halfWidth * 3.2, 18)
        .rotateX(-Math.PI / 2)
        .translate(0, -ROAD_LIFT + 0.05, l.front + 8),
    );
    for (let type = 0; type < VEHICLE_PARTS.length; type++) this.makeMeshes(type, 256);
  }

  private makeMeshes(type: number, capacity: number): void {
    const mesh = new THREE.InstancedMesh(this.paintGeometries[type], this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const fixed = new THREE.InstancedMesh(this.fixedGeometries[type], this.material, capacity);
    fixed.instanceMatrix = mesh.instanceMatrix;
    const lamps = (geometry: THREE.BufferGeometry, material: THREE.Material, colored: boolean) => {
      const m = new THREE.InstancedMesh(geometry, material, capacity);
      m.instanceMatrix = mesh.instanceMatrix;
      if (colored) {
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      return m;
    };
    const head = lamps(this.headGeometries[type], this.lampMaterial, true);
    const tail = lamps(this.tailGeometries[type], this.lampMaterial, true);
    const beam = lamps(this.beamGeometries[type], this.beamMaterial, false);
    for (const m of [mesh, fixed, head, tail, beam]) {
      m.renderOrder = m === beam ? GLOW_ORDER : SOLID_ORDER;
      m.frustumCulled = false;
      m.count = 0;
      m.name = `vehicles ${type}`;
      this.object.add(m);
    }
    this.meshes[type] = mesh;
    this.fixedMeshes[type] = fixed;
    this.headMeshes[type] = head;
    this.tailMeshes[type] = tail;
    this.beamMeshes[type] = beam;
  }

  private ensureCapacity(type: number, needed: number): THREE.InstancedMesh {
    const mesh = this.meshes[type];
    if (needed > mesh.instanceMatrix.count) {
      for (const m of [
        mesh,
        this.fixedMeshes[type],
        this.headMeshes[type],
        this.tailMeshes[type],
        this.beamMeshes[type],
      ]) {
        this.object.remove(m);
        m.dispose();
      }
      this.makeMeshes(type, Math.ceil(needed * 1.5));
    }
    return this.meshes[type];
  }

  /** Place every vehicle near the view between the previous and current frame. */
  update(prev: Uint32Array | undefined, cur: Uint32Array, alpha: number, view: VehicleView): void {
    const visible = view.viewHeight < VEHICLE_MAX_VIEW;
    this.object.visible = visible;
    if (!visible) {
      this.drawn = 0;
      return;
    }
    const slots = cur.length / RENDER.stride;
    const counts = [0, 0, 0, 0];
    for (let slot = 0; slot < slots; slot++) {
      const serial = cur[slot * RENDER.stride + RENDER.serial];
      if (serial !== 0) counts[cur[slot * RENDER.stride + RENDER.info] & 0xff]++;
    }
    const meshes = counts.map((n, type) => this.ensureCapacity(type, n));
    const used = [0, 0, 0, 0];
    // Lamps: headlamps pale by day and bright at night; tail lamps dim by day, brighter at
    // night, brightest when braking.
    const night = nightUniform.value;
    const headLevel = 0.55 + 0.45 * night;
    const tailLevel = 0.3 + 0.35 * night;
    const r2 = view.radius * view.radius;
    const { x: tx, z: tz } = view.target;
    const pose = this.pose;
    for (let slot = 0; slot < slots; slot++) {
      if (!interpolatePose(prev, cur, slot, alpha, pose)) continue;
      const dx = pose[0] - tx;
      const dz = pose[2] - tz;
      if (dx * dx + dz * dz > r2) continue;
      const info = cur[slot * RENDER.stride + RENDER.info];
      const type = info & 0xff;
      const mesh = meshes[type];
      if (!mesh) continue;
      const k = used[type]++;
      const y = info & INFO.absoluteY ? pose[1] : this.height(pose[0], pose[2]) + pose[1];
      const c = Math.cos(pose[3]);
      const s = Math.sin(pose[3]);
      const m = mesh.instanceMatrix.array as Float32Array;
      const i = k * 16;
      m[i] = c;
      m[i + 1] = 0;
      m[i + 2] = -s;
      m[i + 3] = 0;
      m[i + 4] = 0;
      m[i + 5] = 1;
      m[i + 6] = 0;
      m[i + 7] = 0;
      m[i + 8] = s;
      m[i + 9] = 0;
      m[i + 10] = c;
      m[i + 11] = 0;
      m[i + 12] = pose[0];
      m[i + 13] = y + ROAD_LIFT;
      m[i + 14] = pose[2];
      m[i + 15] = 1;
      vehicleColor(type, info >>> 16, this.color);
      const colors = mesh.instanceColor!.array as Float32Array;
      colors[k * 3] = this.color.r;
      colors[k * 3 + 1] = this.color.g;
      colors[k * 3 + 2] = this.color.b;
      const head = this.headMeshes[type].instanceColor!.array as Float32Array;
      head.fill(headLevel, k * 3, k * 3 + 3);
      const tail = this.tailMeshes[type].instanceColor!.array as Float32Array;
      tail.fill(info & INFO.brake ? 1 : tailLevel, k * 3, k * 3 + 3);
    }
    this.drawn = 0;
    meshes.forEach((mesh, type) => {
      mesh.count = used[type];
      this.fixedMeshes[type].count = used[type];
      this.headMeshes[type].count = used[type];
      this.tailMeshes[type].count = used[type];
      this.beamMeshes[type].count = night > 0.02 ? used[type] : 0;
      this.drawn += used[type];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      this.headMeshes[type].instanceColor!.needsUpdate = true;
      this.tailMeshes[type].instanceColor!.needsUpdate = true;
    });
  }
}
