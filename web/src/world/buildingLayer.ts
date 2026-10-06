import * as THREE from 'three/webgpu';

import { type PackedIndex, loadPacked } from '../data/packed';
import { DATA_URL } from '../manifest';
import type { HeightFn } from './roadGeometry';

export interface BuildingIndex extends PackedIndex {
  kinds: string[];
  roofShapes: string[];
}

/** Building footprints (scene x, z) with heights and roof shapes. */
export class Buildings {
  readonly points: Float32Array;
  readonly ringOffsets: Uint32Array;
  readonly buildingRings: Uint32Array;
  readonly height: Float32Array;
  readonly minHeight: Float32Array;
  readonly kind: Uint8Array;
  readonly roofShape: Uint8Array;

  constructor(
    readonly index: BuildingIndex,
    arrays: Record<string, ArrayLike<number>>,
  ) {
    this.points = arrays.points as Float32Array;
    this.ringOffsets = arrays.ringOffsets as Uint32Array;
    this.buildingRings = arrays.buildingRings as Uint32Array;
    this.height = arrays.height as Float32Array;
    this.minHeight = arrays.minHeight as Float32Array;
    this.kind = arrays.kind as Uint8Array;
    this.roofShape = arrays.roofShape as Uint8Array;
  }

  get count(): number {
    return this.height.length;
  }

  /** Rings of a building: the first is the outline, the rest are courtyards. */
  rings(building: number): { start: number; end: number }[] {
    const out = [];
    for (let r = this.buildingRings[building]; r < this.buildingRings[building + 1]; r++) {
      out.push({ start: this.ringOffsets[r], end: this.ringOffsets[r + 1] });
    }
    return out;
  }
}

export async function loadBuildings(indexFile: string): Promise<Buildings> {
  const response = await fetch(DATA_URL + indexFile);
  if (!response.ok) throw new Error(`Could not load ${indexFile} (HTTP ${response.status})`);
  const index = (await response.json()) as BuildingIndex;
  const folder = indexFile.slice(0, indexFile.lastIndexOf('/') + 1);
  return new Buildings(index, await loadPacked(DATA_URL + folder + index.file, index));
}

const CHUNK = 500;
const MAX_VIEW = 9_000; // buildings are drawn below this visible height
const MAX_CACHED_CHUNKS = 900;

/** Facade colours per kind (sRGB), varied per building. */
const WALLS: Record<string, number[]> = {
  house: [0xe9e2d0, 0xf1ead8, 0xe4d6b8, 0xefe6cf, 0xd9d2c3],
  residential: [0xdcd6cb, 0xe6e0d4, 0xcfc8bb, 0xe8dcc6, 0xc9c4bb],
  commercial: [0xb9c0c7, 0xc9ccd0, 0xa9b3bd, 0xd5d3cd],
  industrial: [0xc4c4bf, 0xb8bab8, 0xd0cdc4],
  civic: [0xe0d2b4, 0xd8c9a8, 0xe9dcc0],
  religious: [0xf0ece2, 0xe8e2d4],
  minor: [0xa8a49b, 0xbab3a6, 0x9c9a94],
  other: [0xe2dccf, 0xd9d3c6, 0xece5d6, 0xd0cabd],
};
const TILE_ROOFS = [0x8a4e3a, 0x925a44, 0x7d4a3b, 0x9a634b, 0x744c40, 0x86553f];
const FLAT_ROOFS = [0x7d7c78, 0x8a8985, 0x96958f, 0x73726e];
const PITCHED = new Set(['gabled', 'hipped', 'pyramidal', 'half-hipped', 'gambrel', 'mansard']);

const palette = (list: number[]) => list.map((hex) => new THREE.Color(hex));
const WALL_COLORS = Object.fromEntries(
  Object.entries(WALLS).map(([kind, list]) => [kind, palette(list)]),
);
const TILE_COLORS = palette(TILE_ROOFS);
const FLAT_COLORS = palette(FLAT_ROOFS);

/** Small deterministic hash for per-building variation. */
const hash = (n: number) => {
  let x = n * 2654435761;
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
};

class BuildingMeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  private vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: THREE.Color,
  ) {
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.colors.push(c.r, c.g, c.b);
    return this.positions.length / 3 - 1;
  }

  /** One wall quad from (x0, z0) to (x1, z1), facing outwards for counter-clockwise rings. */
  wall(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, c: THREE.Color) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    // Outward normal of an edge of a counter-clockwise ring (seen from above, y up).
    const nx = -dz / len;
    const nz = dx / len;
    const a = this.vertex(x0, y0, z0, nx, 0, nz, c);
    const b = this.vertex(x1, y0, z1, nx, 0, nz, c);
    const d = this.vertex(x1, y1, z1, nx, 0, nz, c);
    const e = this.vertex(x0, y1, z0, nx, 0, nz, c);
    this.indices.push(a, b, d, a, d, e);
  }

  /** Flat roof over the outline (with courtyard holes). */
  flatRoof(outline: THREE.Vector2[], holes: THREE.Vector2[][], y: number, c: THREE.Color) {
    const base = this.positions.length / 3;
    for (const p of [outline, ...holes].flat()) this.vertex(p.x, y, p.y, 0, 1, 0, c);
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(outline, holes)) {
      this.upTriangle(base + i, base + j, base + k);
    }
  }

  /**
   * Gabled roof over a four-cornered outline: the ridge runs along the longer sides.
   * Returns false if the outline doesn't have four corners.
   */
  gabledRoof(
    outline: THREE.Vector2[],
    eaves: number,
    ridge: number,
    roof: THREE.Color,
    wall: THREE.Color,
  ) {
    if (outline.length !== 4) return false;
    const [p0, p1, p2, p3] = outline;
    const long01 = p0.distanceToSquared(p1) + p2.distanceToSquared(p3);
    const long12 = p1.distanceToSquared(p2) + p3.distanceToSquared(p0);
    // Corners a, b, c, d with a-b and c-d the long eaves sides.
    const [a, b, c, d] = long01 >= long12 ? [p0, p1, p2, p3] : [p1, p2, p3, p0];
    const m1 = new THREE.Vector2().addVectors(b, c).multiplyScalar(0.5); // gable end b-c
    const m2 = new THREE.Vector2().addVectors(d, a).multiplyScalar(0.5); // gable end d-a
    this.slope(a, b, m1, m2, eaves, ridge, roof);
    this.slope(c, d, m2, m1, eaves, ridge, roof);
    this.gable(b, c, m1, eaves, ridge, wall);
    this.gable(d, a, m2, eaves, ridge, wall);
    return true;
  }

  private slope(
    e0: THREE.Vector2,
    e1: THREE.Vector2,
    r1: THREE.Vector2,
    r0: THREE.Vector2,
    eaves: number,
    ridge: number,
    c: THREE.Color,
  ) {
    const v = [
      new THREE.Vector3(e0.x, eaves, e0.y),
      new THREE.Vector3(e1.x, eaves, e1.y),
      new THREE.Vector3(r1.x, ridge, r1.y),
      new THREE.Vector3(r0.x, ridge, r0.y),
    ];
    const n = new THREE.Vector3()
      .subVectors(v[1], v[0])
      .cross(new THREE.Vector3().subVectors(v[3], v[0]))
      .normalize();
    if (n.y < 0) n.negate();
    const ids = v.map((p) => this.vertex(p.x, p.y, p.z, n.x, n.y, n.z, c));
    this.upTriangle(ids[0], ids[1], ids[2]);
    this.upTriangle(ids[0], ids[2], ids[3]);
  }

  private gable(
    e0: THREE.Vector2,
    e1: THREE.Vector2,
    top: THREE.Vector2,
    eaves: number,
    ridge: number,
    c: THREE.Color,
  ) {
    const dx = e1.x - e0.x;
    const dz = e1.y - e0.y;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const a = this.vertex(e0.x, eaves, e0.y, nx, 0, nz, c);
    const b = this.vertex(e1.x, eaves, e1.y, nx, 0, nz, c);
    const t = this.vertex(top.x, ridge, top.y, nx, 0, nz, c);
    this.indices.push(a, b, t);
  }

  /** Add a triangle wound so it faces along its vertex normal (up for roofs). */
  private upTriangle(a: number, b: number, c: number) {
    const p = this.positions;
    const ab = new THREE.Vector3(
      p[b * 3] - p[a * 3],
      p[b * 3 + 1] - p[a * 3 + 1],
      p[b * 3 + 2] - p[a * 3 + 2],
    );
    const ac = new THREE.Vector3(
      p[c * 3] - p[a * 3],
      p[c * 3 + 1] - p[a * 3 + 1],
      p[c * 3 + 2] - p[a * 3 + 2],
    );
    const n = ab.cross(ac);
    const vn = new THREE.Vector3(
      this.normals[a * 3],
      this.normals[a * 3 + 1],
      this.normals[a * 3 + 2],
    );
    if (n.dot(vn) >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.setIndex(this.indices);
    g.computeBoundingSphere();
    return g;
  }
}

/** Signed area of a ring in the x/z plane; positive means counter-clockwise seen from above. */
function signedArea(points: THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.y * q.x - p.x * q.y;
  }
  return a / 2;
}

export interface BuildingView {
  target: THREE.Vector3;
  viewHeight: number;
  distance: number;
  aspect: number;
  perspective: boolean;
}

/** Extruded buildings, built in chunks around the camera like the roads. */
export class BuildingLayer {
  readonly object = new THREE.Group();
  private readonly chunkBuildings = new Map<string, number[]>();
  private readonly chunks = new Map<string, { mesh: THREE.Mesh | null; lastUsed: number }>();
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
  });
  private frame = 0;

  constructor(
    private readonly data: Buildings,
    private readonly height: HeightFn,
  ) {
    this.object.name = 'buildings';
    const { points } = data;
    for (let b = 0; b < data.count; b++) {
      const { start, end } = data.rings(b)[0];
      let x = 0;
      let z = 0;
      for (let p = start; p < end; p++) {
        x += points[p * 2];
        z += points[p * 2 + 1];
      }
      const n = end - start;
      const key = `${Math.floor(x / n / CHUNK)},${Math.floor(z / n / CHUNK)}`;
      const list = this.chunkBuildings.get(key);
      if (list) list.push(b);
      else this.chunkBuildings.set(key, [b]);
    }
  }

  get builtChunks(): number {
    return this.chunks.size;
  }

  update(view: BuildingView, budgetMs = 8): boolean {
    this.frame++;
    let changed = false;
    const show = view.viewHeight < MAX_VIEW;
    if (this.object.visible !== show) {
      this.object.visible = show;
      changed = true;
    }
    if (!show) return changed;

    const radius = view.perspective
      ? THREE.MathUtils.clamp(view.distance * 2.5, 1_200, 7_000)
      : (view.viewHeight * Math.max(1, view.aspect)) / 2 + CHUNK;
    const wanted = this.chunksAround(view.target.x, view.target.z, radius);
    const wantedSet = new Set(wanted);
    const start = performance.now();
    for (const key of wanted) {
      const chunk = this.chunks.get(key);
      if (chunk) {
        chunk.lastUsed = this.frame;
        if (chunk.mesh && !chunk.mesh.visible) {
          chunk.mesh.visible = true;
          changed = true;
        }
        continue;
      }
      if (performance.now() - start > budgetMs) continue;
      const mesh = this.buildChunk(key);
      if (mesh) this.object.add(mesh);
      this.chunks.set(key, { mesh, lastUsed: this.frame });
      changed = true;
    }
    for (const [key, chunk] of this.chunks) {
      if (!wantedSet.has(key) && chunk.mesh?.visible) {
        chunk.mesh.visible = false;
        changed = true;
      }
    }
    if (this.chunks.size > MAX_CACHED_CHUNKS) {
      const stale = [...this.chunks.entries()]
        .filter(([key]) => !wantedSet.has(key))
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
        .slice(0, this.chunks.size - MAX_CACHED_CHUNKS);
      for (const [key, chunk] of stale) {
        if (chunk.mesh) {
          this.object.remove(chunk.mesh);
          chunk.mesh.geometry.dispose();
        }
        this.chunks.delete(key);
      }
    }
    return changed;
  }

  private chunksAround(x: number, z: number, radius: number): string[] {
    const out: { key: string; d: number }[] = [];
    for (let cx = Math.floor((x - radius) / CHUNK); cx <= Math.floor((x + radius) / CHUNK); cx++) {
      for (
        let cz = Math.floor((z - radius) / CHUNK);
        cz <= Math.floor((z + radius) / CHUNK);
        cz++
      ) {
        const key = `${cx},${cz}`;
        if (!this.chunkBuildings.has(key)) continue;
        const d = Math.hypot((cx + 0.5) * CHUNK - x, (cz + 0.5) * CHUNK - z);
        if (d <= radius + CHUNK * 0.71) out.push({ key, d });
      }
    }
    return out.sort((a, b) => a.d - b.d).map((c) => c.key);
  }

  private buildChunk(key: string): THREE.Mesh | null {
    const { data, height } = this;
    const builder = new BuildingMeshBuilder();
    for (const b of this.chunkBuildings.get(key) ?? []) {
      const rings = data.rings(b).map(({ start, end }) => {
        const ring: THREE.Vector2[] = [];
        for (let p = start; p < end; p++) {
          ring.push(new THREE.Vector2(data.points[p * 2], data.points[p * 2 + 1]));
        }
        return ring;
      });
      const [outline, ...holes] = rings;
      if (outline.length < 3) continue;
      // Outline counter-clockwise (seen from above), holes clockwise, so walls face out.
      if (signedArea(outline) < 0) outline.reverse();
      for (const hole of holes) if (signedArea(hole) > 0) hole.reverse();

      let ground = Infinity;
      for (const p of outline) ground = Math.min(ground, height(p.x, p.y));
      const base = ground + data.minHeight[b] - (data.minHeight[b] > 0 ? 0 : 0.5);
      const top = ground + data.height[b];
      const kind = data.index.kinds[data.kind[b]];
      const shape = data.index.roofShapes[data.roofShape[b]];
      const variation = hash(b);
      const walls = WALL_COLORS[kind] ?? WALL_COLORS.other;
      const wall = walls[Math.floor(variation * walls.length)];

      const pitched = PITCHED.has(shape) && outline.length === 4 && holes.length === 0;
      const roofHeight = pitched ? Math.min(4, Math.max(2, data.height[b] * 0.3)) : 0;
      const eaves = top - roofHeight;
      for (const ring of [outline, ...holes]) {
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i];
          const q = ring[(i + 1) % ring.length];
          builder.wall(p.x, p.y, q.x, q.y, base, eaves, wall);
        }
      }
      if (pitched) {
        const roof = TILE_COLORS[Math.floor(hash(b + 7) * TILE_COLORS.length)];
        builder.gabledRoof(outline, eaves, top, roof, wall);
      } else {
        const roof =
          PITCHED.has(shape) && kind !== 'industrial'
            ? TILE_COLORS[Math.floor(hash(b + 7) * TILE_COLORS.length)]
            : FLAT_COLORS[Math.floor(hash(b + 3) * FLAT_COLORS.length)];
        builder.flatRoof(outline, holes, top, roof);
      }
    }
    const geometry = builder.toGeometry();
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = `buildings ${key}`;
    return mesh;
  }
}
