/**
 * Rain and snow falling around the view (M6b): drops scattered in a box over the point
 * the camera looks at, moved by the GPU (each drop's place and phase come from a hash of
 * its index), so it costs nothing per frame on the CPU. Drawn in the 3D and isometric
 * views close to the ground; the map view shows the weather by its light only.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  hash,
  instanceIndex,
  mod,
  positionLocal,
  sin,
  time,
  uniform,
  vec3,
} from 'three/tsl';

/** Drops at most. */
const DROPS = 12_000;
/** Shown below this view height (m). */
const MAX_VIEW = 2500;

export class Precipitation {
  readonly object: THREE.InstancedMesh;
  /** Box the drops fall in (m): width and height. */
  private readonly width = uniform(160);
  private readonly height = uniform(90);
  /** Falling speed (m/s) and sideways drift (m). */
  private readonly speed = uniform(9);
  private readonly drift = uniform(0);
  /** A drop's size (m): across and up. */
  private readonly across = uniform(0.02);
  private readonly up = uniform(0.9);
  private readonly material: THREE.MeshBasicNodeMaterial;
  private kind?: 'rain' | 'snow';
  /** Falling speed (m/s) seen close up. */
  private fall = 9;
  private amount = 0;

  constructor() {
    // Two crossed quads per drop, so it shows from any side: a streak 0.9 m long.
    const a = new THREE.PlaneGeometry(1, 1);
    const b = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI / 2);
    const geometry = new THREE.BufferGeometry();
    const merged = [a, b].map((g) => g.toNonIndexed());
    const pos = new Float32Array(
      merged.reduce((n, g) => n + g.attributes.position.array.length, 0),
    );
    let k = 0;
    for (const g of merged) {
      pos.set(g.attributes.position.array as Float32Array, k);
      k += g.attributes.position.array.length;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    this.material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const i = instanceIndex.toFloat();
    const x = hash(i).sub(0.5).mul(this.width);
    const z = hash(i.add(7.31)).sub(0.5).mul(this.width);
    const phase = hash(i.add(3.17)).mul(this.height);
    const y = mod(phase.sub(time.mul(this.speed)), this.height);
    const sway = sin(time.mul(0.8).add(phase)).mul(this.drift);
    const drop = positionLocal.mul(vec3(this.across, this.up, this.across));
    this.material.positionNode = drop.add(vec3(x.add(sway), y, z));
    this.material.opacityNode = float(1);
    this.object = new THREE.InstancedMesh(geometry, this.material, DROPS);
    this.object.name = 'precipitation';
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
    this.object.renderOrder = 4;
  }

  /** What falls and how much (0-1); nothing: undefined. */
  set(kind: 'rain' | 'snow' | undefined, amount: number): void {
    if (kind !== this.kind) {
      this.kind = kind;
      if (kind === 'rain') {
        this.fall = 9;
        this.drift.value = 0;
        this.material.color.set(0xb8c4d0);
        this.material.opacity = 0.55;
      } else if (kind === 'snow') {
        this.fall = 1.2;
        this.drift.value = 0.8;
        this.material.color.set(0xffffff);
        this.material.opacity = 0.9;
      }
      this.material.opacityNode = float(this.material.opacity);
      this.material.needsUpdate = true;
    }
    this.amount = kind ? amount : 0;
  }

  /** Over the point looked at, in the 3D and isometric views close in; whether anything
   * changed. */
  update(target: THREE.Vector3, ground: number, viewHeight: number, map: boolean): boolean {
    const visible = this.amount > 0 && !map && viewHeight < MAX_VIEW;
    const changed = visible !== this.object.visible;
    this.object.visible = visible;
    if (!visible) return changed;
    // The box: wider the further out the view, around the target, from the ground up;
    // drops larger too, so they still show from above.
    const width = Math.min(1500, Math.max(120, viewHeight * 1.2));
    this.width.value = width;
    this.height.value = width * 0.5;
    const scale = Math.max(1, viewHeight / 150);
    this.speed.value = this.fall * Math.sqrt(scale);
    if (this.kind === 'rain') {
      this.across.value = 0.02 * scale;
      this.up.value = 0.9 * scale;
    } else {
      this.across.value = 0.09 * scale;
      this.up.value = 0.09 * scale;
    }
    this.object.position.set(target.x, ground, target.z);
    this.object.count = Math.round(DROPS * this.amount);
    // Moving drops: draw every frame.
    return true;
  }
}
