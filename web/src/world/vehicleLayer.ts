import * as THREE from 'three/webgpu';

import { INFO, RENDER } from '../sim/wasm';
import { GLOW_ORDER, SOLID_ORDER, glowMaterial, nightUniform } from './nightLights';
import type { HeightFn } from './roadGeometry';
import { vehicleColor } from './vehicleGeometry';
import { MODELS, PAINT, modelOf, partsGeometry } from './vehicleModels';

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

/** Meshes of one vehicle model, all sharing one set of instance transforms: the painted
 * body (coloured per vehicle), the parts that keep their colour (glass, wheels, loads),
 * the lamps (glowing as each vehicle's state says) and the headlight beams. */
interface ModelMeshes {
  paint: THREE.InstancedMesh;
  fixed: THREE.InstancedMesh;
  head: THREE.InstancedMesh;
  tail: THREE.InstancedMesh;
  left: THREE.InstancedMesh;
  right: THREE.InstancedMesh;
  beam: THREE.InstancedMesh;
}

interface ModelGeometries {
  paint: THREE.BufferGeometry;
  fixed: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  left: THREE.BufferGeometry;
  right: THREE.BufferGeometry;
  beam: THREE.BufferGeometry;
}

/** Indicators blink this many times a second. */
const BLINK = 1.5;

const keyOf = (type: number, model: number) => type * 16 + model;

/**
 * Draws the simulation's vehicles as instanced low-poly models (M6c): a few car shapes,
 * lorries, ZET's buses and trams; lamps that glow at night, tail lamps bright when braking,
 * indicators blinking when turning or changing lanes.
 */
export class VehicleLayer {
  readonly object = new THREE.Group();
  private readonly meshes = new Map<number, ModelMeshes>();
  private readonly geometries = new Map<number, ModelGeometries>();
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
    MODELS.forEach((models, type) =>
      models.forEach((model, k) => {
        this.geometries.set(keyOf(type, k), {
          paint: partsGeometry(model.parts.filter((part) => part.color === PAINT)),
          fixed: partsGeometry(model.parts.filter((part) => part.color !== PAINT)),
          head: partsGeometry(model.head),
          tail: partsGeometry(model.tail),
          left: partsGeometry(model.left),
          right: partsGeometry(model.right),
          // A beam on the road ahead: 18 m long, a little wider than the vehicle.
          beam: new THREE.PlaneGeometry(model.halfWidth * 3.2, 18)
            .rotateX(-Math.PI / 2)
            .translate(0, -ROAD_LIFT + 0.05, model.front + 8),
        });
        this.makeMeshes(keyOf(type, k), 64);
      }),
    );
  }

  private makeMeshes(key: number, capacity: number): void {
    const g = this.geometries.get(key)!;
    const make = (geometry: THREE.BufferGeometry, material: THREE.Material, colored: boolean) => {
      const m = new THREE.InstancedMesh(geometry, material, capacity);
      if (colored) {
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      return m;
    };
    const paint = make(g.paint, this.material, true);
    paint.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const set: ModelMeshes = {
      paint,
      fixed: make(g.fixed, this.material, false),
      head: make(g.head, this.lampMaterial, true),
      tail: make(g.tail, this.lampMaterial, true),
      left: make(g.left, this.lampMaterial, true),
      right: make(g.right, this.lampMaterial, true),
      beam: make(g.beam, this.beamMaterial, false),
    };
    for (const m of Object.values(set)) {
      if (m !== paint) m.instanceMatrix = paint.instanceMatrix;
      m.renderOrder = m === set.beam ? GLOW_ORDER : SOLID_ORDER;
      m.frustumCulled = false;
      m.count = 0;
      m.name = `vehicles ${key}`;
      this.object.add(m);
    }
    this.meshes.set(key, set);
  }

  private ensureCapacity(key: number, needed: number): ModelMeshes {
    const set = this.meshes.get(key)!;
    if (needed > set.paint.instanceMatrix.count) {
      for (const m of Object.values(set)) {
        this.object.remove(m);
        m.dispose();
      }
      this.makeMeshes(key, Math.ceil(needed * 1.5));
    }
    return this.meshes.get(key)!;
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
    const counts = new Map<number, number>();
    for (let slot = 0; slot < slots; slot++) {
      const o = slot * RENDER.stride;
      if (cur[o + RENDER.serial] === 0) continue;
      const info = cur[o + RENDER.info];
      const key = keyOf(info & 0xff, modelOf(info & 0xff, info >>> 16));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sets = new Map<number, ModelMeshes>();
    for (const key of this.meshes.keys())
      sets.set(key, this.ensureCapacity(key, counts.get(key) ?? 0));
    const used = new Map<number, number>();
    const r2 = view.radius * view.radius;
    const { x: tx, z: tz } = view.target;
    const pose = this.pose;
    // Lamps: headlamps pale by day and bright at night; tail lamps dim by day, brighter at
    // night, brightest when braking; indicators on and off.
    const night = nightUniform.value;
    const headLevel = 0.55 + 0.45 * night;
    const tailLevel = 0.3 + 0.35 * night;
    const blinkOn = Math.floor((performance.now() / 1000) * BLINK * 2) % 2 === 0;
    for (let slot = 0; slot < slots; slot++) {
      if (!interpolatePose(prev, cur, slot, alpha, pose)) continue;
      const dx = pose[0] - tx;
      const dz = pose[2] - tz;
      if (dx * dx + dz * dz > r2) continue;
      const info = cur[slot * RENDER.stride + RENDER.info];
      const type = info & 0xff;
      const key = keyOf(type, modelOf(type, info >>> 16));
      const set = sets.get(key);
      if (!set) continue;
      const k = used.get(key) ?? 0;
      used.set(key, k + 1);
      const y = info & INFO.absoluteY ? pose[1] : this.height(pose[0], pose[2]) + pose[1];
      const c = Math.cos(pose[3]);
      const sn = Math.sin(pose[3]);
      const m = set.paint.instanceMatrix.array as Float32Array;
      const i = k * 16;
      m[i] = c;
      m[i + 1] = 0;
      m[i + 2] = -sn;
      m[i + 3] = 0;
      m[i + 4] = 0;
      m[i + 5] = 1;
      m[i + 6] = 0;
      m[i + 7] = 0;
      m[i + 8] = sn;
      m[i + 9] = 0;
      m[i + 10] = c;
      m[i + 11] = 0;
      m[i + 12] = pose[0];
      m[i + 13] = y + ROAD_LIFT;
      m[i + 14] = pose[2];
      m[i + 15] = 1;
      vehicleColor(type, info >>> 16, this.color);
      const colors = set.paint.instanceColor!.array as Float32Array;
      colors[k * 3] = this.color.r;
      colors[k * 3 + 1] = this.color.g;
      colors[k * 3 + 2] = this.color.b;
      (set.head.instanceColor!.array as Float32Array).fill(headLevel, k * 3, k * 3 + 3);
      (set.tail.instanceColor!.array as Float32Array).fill(
        info & INFO.brake ? 1 : tailLevel,
        k * 3,
        k * 3 + 3,
      );
      const left = info & INFO.blinkLeft && blinkOn ? 1 : 0.3;
      const right = info & INFO.blinkRight && blinkOn ? 1 : 0.3;
      (set.left.instanceColor!.array as Float32Array).fill(left, k * 3, k * 3 + 3);
      (set.right.instanceColor!.array as Float32Array).fill(right, k * 3, k * 3 + 3);
    }
    this.drawn = 0;
    for (const [key, set] of sets) {
      const n = used.get(key) ?? 0;
      for (const mesh of Object.values(set)) mesh.count = n;
      set.beam.count = night > 0.02 ? n : 0;
      this.drawn += n;
      set.paint.instanceMatrix.needsUpdate = true;
      for (const mesh of [set.paint, set.head, set.tail, set.left, set.right]) {
        mesh.instanceColor!.needsUpdate = true;
      }
    }
  }
}
