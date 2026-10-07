import * as THREE from 'three/webgpu';

import { valueColor } from '../grow/landValue';
import type { Lots } from '../grow/lots';
import { ZONES } from '../grow/zones';
import type { HeightFn } from './roadGeometry';
import type { Extent, TerrainLayer } from './terrainLod';

/** Chunk size (m) lots are drawn in, and the farthest view (view height, m) they show at. */
const CHUNK = 500;
const MAX_VIEW = 12_000;
/** Height (m) of lots above the ground, and the gap (m) left between neighbouring lots. */
const LIFT = 0.6;
const INSET = 0.8;
/** Chunks rebuilt per frame at most. */
const BUDGET = 40;
/** Width (px) of the planned land use map. */
const PLAN_WIDTH = 2048;
const UNZONED = '#ffffff';

/**
 * Zoning on the map (M5a): zoned lots in their zone's colour, the other lots too while the
 * Zones tool is open, the City's planned land use under them, and the brush.
 */
export class ZoneLayer {
  readonly object = new THREE.Group();
  private readonly chunkLots = new Map<string, number[]>();
  private readonly chunkOf: string[];
  private readonly meshes = new Map<string, THREE.Group>();
  private readonly dirty = new Set<string>();
  private zones: Uint8Array;
  /** Building on each lot (-1: none): built lots are not filled unless all are shown. */
  private built?: Int32Array;
  private showAll = false;
  /** Land value per lot, when lots are coloured by it rather than by zone. */
  private values?: Float32Array;
  private readonly colors: THREE.Color[];
  private readonly material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  /** Lots not zoned: faint outlines. */
  private readonly outlineMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  /** The City's planned land use, drawn into the terrain once asked for. */
  private plan?: { map: THREE.Texture; extent: Extent };
  private planShown = false;
  private readonly brush: THREE.Mesh;
  /** Chunks around the view still to build after the last update. */
  private waiting = 0;

  constructor(
    private readonly lots: Lots,
    private readonly height: HeightFn,
    private readonly terrain: Pick<TerrainLayer, 'setOverlay'>,
  ) {
    this.object.name = 'zoning';
    this.zones = new Uint8Array(lots.count);
    this.colors = [new THREE.Color(UNZONED), ...ZONES.map((z) => new THREE.Color(z.color))];
    this.chunkOf = new Array<string>(lots.count);
    for (let i = 0; i < lots.count; i++) {
      const key = `${Math.floor(lots.x[i] / CHUNK)},${Math.floor(lots.z[i] / CHUNK)}`;
      this.chunkOf[i] = key;
      const list = this.chunkLots.get(key);
      if (list) list.push(i);
      else this.chunkLots.set(key, [i]);
    }
    const ring = new THREE.RingGeometry(0.94, 1, 48);
    ring.rotateX(-Math.PI / 2);
    this.brush = new THREE.Mesh(
      ring,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      }),
    );
    this.brush.visible = false;
    this.brush.renderOrder = 10;
    this.brush.frustumCulled = false;
    this.object.add(this.brush);
  }

  /** Zone codes of every lot; `changed`: only these lots changed. */
  setZones(zones: Uint8Array, changed?: readonly number[]): void {
    this.zones = zones;
    if (!changed) for (const key of this.meshes.keys()) this.dirty.add(key);
    else for (const i of changed) this.dirty.add(this.chunkOf[i]);
  }

  /** Which lots have buildings (grow/growth.ts `lotBuilding`). */
  setBuilt(built: Int32Array): void {
    this.built = built;
  }

  /** Show the lots not zoned too (while the Zones tool is open). */
  setShowAll(on: boolean): void {
    if (on === this.showAll) return;
    this.showAll = on;
    for (const key of this.meshes.keys()) this.dirty.add(key);
  }

  /** Colour every lot by land value (`values` per lot), or by zone again (undefined). Call
   * again when the values change. */
  setValues(values: Float32Array | undefined): void {
    if (!values && !this.values) return;
    this.values = values;
    for (const key of this.meshes.keys()) this.dirty.add(key);
  }

  /** The brush at (x, z), `radius` m (undefined: hidden). */
  setBrush(at: { x: number; z: number } | undefined, radius: number): void {
    this.brush.visible = at !== undefined;
    if (!at) return;
    this.brush.position.set(at.x, this.height(at.x, at.z) + 2, at.z);
    this.brush.scale.setScalar(radius);
  }

  /** Draw the City's planned land use under the lots. */
  setPlanVisible(on: boolean): void {
    if (on && !this.plan) this.plan = this.buildPlan();
    this.planShown = on;
    if (this.plan) this.terrain.setOverlay(on ? this.plan.map : undefined, this.plan.extent, 0.5);
  }

  get planVisible(): boolean {
    return this.planShown;
  }

  /** Build the chunks around the view; whether anything changed. */
  update(target: THREE.Vector3, viewHeight: number): boolean {
    const visible = viewHeight < MAX_VIEW;
    let changed = false;
    for (const mesh of this.meshes.values()) {
      if (mesh.visible !== visible) {
        mesh.visible = visible;
        changed = true;
      }
    }
    this.waiting = 0;
    if (!visible) return changed;
    const radius = Math.max(1500, viewHeight * 1.5);
    const near: string[] = [];
    const [c0, c1] = [
      Math.floor((target.x - radius) / CHUNK),
      Math.floor((target.x + radius) / CHUNK),
    ];
    const [r0, r1] = [
      Math.floor((target.z - radius) / CHUNK),
      Math.floor((target.z + radius) / CHUNK),
    ];
    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const key = `${cx},${cz}`;
        if (this.chunkLots.has(key) && (!this.meshes.has(key) || this.dirty.has(key)))
          near.push(key);
      }
    }
    // Nearest first, so what is in view fills in first.
    const away = (key: string) => {
      const [cx, cz] = key.split(',').map(Number);
      return Math.hypot((cx + 0.5) * CHUNK - target.x, (cz + 0.5) * CHUNK - target.z);
    };
    if (near.length > BUDGET) near.sort((a, b) => away(a) - away(b));
    for (const key of near.slice(0, BUDGET)) {
      this.buildChunk(key);
      changed = true;
    }
    this.waiting = Math.max(0, near.length - BUDGET);
    return changed;
  }

  /** Whether lots around the view are still being drawn. */
  get filling(): boolean {
    return this.waiting > 0;
  }

  private buildChunk(key: string): void {
    this.dirty.delete(key);
    const old = this.meshes.get(key);
    if (old) {
      this.object.remove(old);
      old.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
      });
    }
    const ids = this.chunkLots.get(key) ?? [];
    const group = new THREE.Group();
    group.name = `lots ${key}`;
    this.object.add(group);
    this.meshes.set(key, group);
    const values = this.values;
    if (values) {
      // Every lot, by land value.
      if (ids.length) group.add(this.fill(ids, (i) => valueColor(values[i])));
      return;
    }
    const zoned = ids.filter(
      (i) => this.zones[i] > 0 && (this.showAll || !this.built || this.built[i] < 0),
    );
    const open = this.showAll ? ids.filter((i) => this.zones[i] === 0) : [];
    if (zoned.length) {
      group.add(
        this.fill(zoned, (i) => {
          const c = this.colors[this.zones[i]];
          return [c.r, c.g, c.b];
        }),
      );
    }
    if (open.length) group.add(this.outline(open));
  }

  /** Corners of lot `i` on the ground, a little inside its edges. */
  private cornersOf(i: number): [number, number, number][] {
    const lots = this.lots;
    const ux = Math.cos(lots.angle[i]);
    const uz = Math.sin(lots.angle[i]);
    const f = lots.frontage[i] / 2 - INSET;
    const d = lots.depth[i] / 2 - INSET;
    return [
      [-f, -d],
      [f, -d],
      [f, d],
      [-f, d],
    ].map(([a, b]) => {
      // Along the street by a, to its right (x east, z south) by b.
      const x = lots.x[i] + ux * a - uz * b;
      const z = lots.z[i] + uz * a + ux * b;
      return [x, this.height(x, z) + LIFT, z];
    });
  }

  /** Lots filled, each in its colour (r, g, b in 0-1). */
  private fill(ids: number[], colorOf: (i: number) => [number, number, number]): THREE.Mesh {
    const positions = new Float32Array(ids.length * 12);
    const colors = new Float32Array(ids.length * 12);
    const index = new Uint32Array(ids.length * 6);
    ids.forEach((i, k) => {
      const color = colorOf(i);
      this.cornersOf(i).forEach((p, c) => {
        positions.set(p, (k * 4 + c) * 3);
        colors.set(color, (k * 4 + c) * 3);
      });
      const v = k * 4;
      index.set([v, v + 2, v + 1, v, v + 3, v + 2], k * 6);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.renderOrder = 2;
    return mesh;
  }

  /** Lots not zoned, as outlines. */
  private outline(ids: number[]): THREE.LineSegments {
    const positions = new Float32Array(ids.length * 24);
    ids.forEach((i, k) => {
      const c = this.cornersOf(i);
      for (let e = 0; e < 4; e++) {
        positions.set(c[e], (k * 8 + e * 2) * 3);
        positions.set(c[(e + 1) % 4], (k * 8 + e * 2 + 1) * 3);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    const lines = new THREE.LineSegments(geometry, this.outlineMaterial);
    lines.renderOrder = 2;
    return lines;
  }

  /** The planned land use as a map to drape over the terrain. */
  private buildPlan(): { map: THREE.Texture; extent: Extent } {
    const lots = this.lots;
    const pts = lots.planPoints;
    let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let p = 0; p < pts.length; p += 2) {
      minX = Math.min(minX, pts[p]);
      maxX = Math.max(maxX, pts[p]);
      minZ = Math.min(minZ, pts[p + 1]);
      maxZ = Math.max(maxZ, pts[p + 1]);
    }
    // A margin, so the map's clamped edge is clear.
    const pad = 200;
    [minX, minZ, maxX, maxZ] = [minX - pad, minZ - pad, maxX + pad, maxZ + pad];
    const width = PLAN_WIDTH;
    const height = Math.round((width * (maxZ - minZ)) / (maxX - minX));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const sx = width / (maxX - minX);
    const sz = height / (maxZ - minZ);
    const rings = lots.planPolygonRings;
    const ringPoints = lots.planRingPoints;
    for (let poly = 0; poly + 1 < rings.length; poly++) {
      ctx.beginPath();
      for (let r = rings[poly]; r < rings[poly + 1]; r++) {
        for (let p = ringPoints[r]; p < ringPoints[r + 1]; p++) {
          const x = (pts[p * 2] - minX) * sx;
          const y = (pts[p * 2 + 1] - minZ) * sz;
          if (p === ringPoints[r]) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = lots.planClasses[lots.planClass[poly]]?.color ?? '#888888';
      ctx.fill('evenodd');
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    return {
      map: texture,
      extent: { west: minX, north: minZ, width: maxX - minX, height: maxZ - minZ },
    };
  }
}
