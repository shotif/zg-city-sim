import * as THREE from 'three/webgpu';

import { ARCHETYPES, type Grown, finished, footprint, heights, random } from '../grow/growth';
import type { Lots } from '../grow/lots';
import { BuildingMaterials, BuildingMeshBuilder, signedArea } from './buildingLayer';
import { SOLID_ORDER } from './nightLights';
import type { HeightFn } from './roadGeometry';

const CHUNK = 500;
/** Grown buildings are drawn below this visible height (m), as the city's are. */
const MAX_VIEW = 9_000;
/** Chunks rebuilt per frame at most. */
const BUDGET = 8;
/** A building site: concrete walls a third of the way up. */
const SITE = new THREE.Color(0xb3ada2);
const SITE_SHARE = 0.35;
const TILES = [0x8a4e3a, 0x925a44, 0x7d4a3b, 0x9a634b, 0x86553f].map((c) => new THREE.Color(c));
const FLAT = [0x7d7c78, 0x8a8985, 0x96958f].map((c) => new THREE.Color(c));

/**
 * Buildings grown on zoned lots (M5b): finished ones in their type's colours, those being
 * built as concrete shells, drawn in chunks like the city's buildings.
 */
export class GrowthLayer {
  readonly object = new THREE.Group();
  private readonly chunkOf = new Map<number, string>();
  private readonly chunkBuildings = new Map<string, Set<number>>();
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly dirty = new Set<string>();
  /** Buildings under way, to redraw when finished. */
  private readonly underway = new Set<number>();
  private now = 0;
  private readonly materials = new BuildingMaterials();

  constructor(
    private readonly lots: Lots,
    private readonly height: HeightFn,
    private readonly buildings: readonly (Grown | undefined)[],
  ) {
    this.object.name = 'grown buildings';
  }

  /** Lit windows while it is dark; whether anything changed. */
  setNight(night: boolean): boolean {
    return this.materials.set(night, this.object);
  }

  /** A building added (or changed). */
  add(id: number): void {
    const b = this.buildings[id];
    if (!b) return;
    const i = b.lots[0];
    const key = `${Math.floor(this.lots.x[i] / CHUNK)},${Math.floor(this.lots.z[i] / CHUNK)}`;
    this.chunkOf.set(id, key);
    const set = this.chunkBuildings.get(key) ?? new Set<number>();
    set.add(id);
    this.chunkBuildings.set(key, set);
    if (!finished(b, this.now)) this.underway.add(id);
    this.dirty.add(key);
  }

  remove(id: number): void {
    const key = this.chunkOf.get(id);
    if (key === undefined) return;
    this.chunkBuildings.get(key)?.delete(id);
    this.chunkOf.delete(id);
    this.underway.delete(id);
    this.dirty.add(key);
  }

  /** Every building again (after a reload or a cleared zoning). */
  reset(): void {
    for (const key of this.chunkBuildings.keys()) this.dirty.add(key);
    this.chunkBuildings.clear();
    this.chunkOf.clear();
    this.underway.clear();
    this.buildings.forEach((b, id) => {
      if (b) this.add(id);
    });
  }

  /** Simulated time now (s): buildings finished by then are drawn finished. */
  setTime(now: number): void {
    this.now = now;
    for (const id of this.underway) {
      const b = this.buildings[id];
      if (!b || finished(b, now)) {
        this.underway.delete(id);
        const key = this.chunkOf.get(id);
        if (key) this.dirty.add(key);
      }
    }
  }

  /** Rebuild changed chunks; whether anything changed. */
  update(viewHeight: number): boolean {
    const visible = viewHeight < MAX_VIEW;
    let changed = this.object.visible !== visible;
    this.object.visible = visible;
    let budget = BUDGET;
    for (const key of [...this.dirty]) {
      if (budget-- <= 0) break;
      this.dirty.delete(key);
      this.buildChunk(key);
      changed = true;
    }
    return changed;
  }

  private buildChunk(key: string): void {
    const old = this.meshes.get(key);
    if (old) {
      this.object.remove(old);
      old.geometry.dispose();
      this.meshes.delete(key);
    }
    const builder = new BuildingMeshBuilder();
    for (const id of this.chunkBuildings.get(key) ?? []) {
      const b = this.buildings[id];
      if (b) this.addBuilding(builder, b);
    }
    const geometry = builder.toGeometry();
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, this.materials.current);
    mesh.renderOrder = SOLID_ORDER;
    mesh.name = `grown ${key}`;
    this.object.add(mesh);
    this.meshes.set(key, mesh);
  }

  private addBuilding(builder: BuildingMeshBuilder, b: Grown): void {
    const a = ARCHETYPES[b.archetype];
    const outline = footprint(this.lots, b).map(([x, z]) => new THREE.Vector2(x, z));
    if (signedArea(outline) < 0) outline.reverse();
    let ground = Infinity;
    for (const p of outline) ground = Math.min(ground, this.height(p.x, p.y));
    const base = ground - 0.5;
    const { eaves, ridge } = heights(b);
    const ring = (y0: number, y1: number, color: THREE.Color) => {
      for (let k = 0; k < outline.length; k++) {
        const p = outline[k];
        const q = outline[(k + 1) % outline.length];
        builder.wall(p.x, p.y, q.x, q.y, y0, y1, color);
      }
    };
    if (!finished(b, this.now)) {
      const top = ground + eaves * SITE_SHARE;
      ring(base, top, SITE);
      builder.flatRoof(outline, [], top, SITE);
      return;
    }
    const r = random(b.seed + 11);
    const wall = new THREE.Color(a.walls[Math.floor(r() * a.walls.length)]);
    let from = base;
    if (a.ground) {
      ring(base, ground + 4.5, new THREE.Color(a.ground));
      from = ground + 4.5;
    }
    ring(from, ground + eaves, wall);
    if (ridge > eaves) {
      const tiles = TILES[Math.floor(r() * TILES.length)];
      builder.gabledRoof(outline, ground + eaves, ground + ridge, tiles, wall);
    } else {
      builder.flatRoof(outline, [], ground + eaves, FLAT[Math.floor(r() * FLAT.length)]);
    }
  }
}
