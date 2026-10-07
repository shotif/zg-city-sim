import * as THREE from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

import type { ViewMode } from '../camera/CameraRig';
import {
  type HeightFn,
  MeshBuilder,
  addDashes,
  addPolygon,
  addRibbon,
  groundPath,
  simplify,
} from './roadGeometry';
import type { RoadClass, RoadNetwork } from './roadNetwork';

const CHUNK = 1000; // metres per chunk side
const DETAIL_MAX_VIEW = 5_000; // detailed roads below this visible height
const OVERVIEW_MIN_VIEW = 2_500; // overview lines above this visible height
/** Overview lines are simplified within this (m): under a pixel from 2.5 km up. */
const OVERVIEW_TOLERANCE = 2;
/** Minor roads' overview lines in squares this wide (m), so those off the screen are culled. */
const OVERVIEW_TILE = 4000;
const MAX_CACHED_CHUNKS = 600;

const LANE_LIFT = 0.12;
const JUNCTION_LIFT = 0.1;
const MARK_LIFT = 0.02;
const RAIL_LIFT = 0.04;

const color = (hex: number) => new THREE.Color(hex);
const ASPHALT: Record<RoadClass, THREE.Color> = {
  motorway: color(0x37393c),
  trunk: color(0x37393c),
  primary: color(0x3d3f42),
  secondary: color(0x3f4144),
  tertiary: color(0x434548),
  minor: color(0x47494c),
  service: color(0x4d4f51),
  tram: color(0x56544f), // tram tracks are mostly embedded in paved streets
  rail: color(0x6a6357), // ballast
};
const JUNCTION_COLOR = color(0x3f4144);
const MARKING = color(0xe6e6e0);
const STEEL = color(0x9aa0a6);

const CENTRE_LINE_CLASSES = new Set<RoadClass>(['trunk', 'primary', 'secondary', 'tertiary']);
const EDGE_LINE_CLASSES = new Set<RoadClass>(['motorway', 'trunk', 'primary']);

/** Overview line styles, drawn as constant-pixel-width lines when zoomed out. */
const OVERVIEW: {
  classes: RoadClass[];
  color: number;
  width: number;
  maxView: number;
  /** In tiles (OVERVIEW_TILE), for classes only shown close in. */
  tiled?: boolean;
}[] = [
  { classes: ['minor'], color: 0xd9d6cf, width: 1, maxView: 9_000, tiled: true },
  { classes: ['tertiary'], color: 0xf1efe8, width: 1.4, maxView: 30_000 },
  { classes: ['rail'], color: 0x55585c, width: 1.5, maxView: Infinity },
  { classes: ['tram'], color: 0x2f6fd6, width: 1.8, maxView: Infinity },
  { classes: ['secondary'], color: 0xf6d860, width: 2, maxView: Infinity },
  { classes: ['primary'], color: 0xf3a64a, width: 2.6, maxView: Infinity },
  { classes: ['motorway', 'trunk'], color: 0xe8603c, width: 3.2, maxView: Infinity },
];

interface Chunk {
  group: THREE.Group;
  lastUsed: number;
}

export interface RoadView {
  mode: ViewMode;
  target: THREE.Vector3;
  viewHeight: number;
  /** Distance from the camera to the target (perspective) or 0 (orthographic). */
  distance: number;
  aspect: number;
}

/**
 * Draws the road network: detailed lanes, junctions, markings and rails built chunk by chunk
 * around the camera when zoomed in, and map-style lines for the whole city when zoomed out.
 */
export class RoadLayer {
  readonly object = new THREE.Group();
  private readonly detail = new THREE.Group();
  private readonly overview = new THREE.Group();
  private readonly overviewLayers: { lines: LineSegments2; maxView: number }[] = [];
  private readonly chunkLanes = new Map<string, number[]>();
  private readonly chunkJunctions = new Map<string, number[]>();
  private readonly chunks = new Map<string, Chunk>();
  private readonly surfaceMaterial: THREE.MeshStandardMaterial;
  private readonly markingMaterial: THREE.MeshStandardMaterial;
  private frame = 0;

  constructor(
    private readonly net: RoadNetwork,
    private readonly height: HeightFn,
  ) {
    this.object.name = 'roads';
    this.object.add(this.detail, this.overview);
    this.surfaceMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.markingMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.6,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.indexChunks();
    this.buildOverview();
  }

  private wet = 0;

  /** Wet roads (0 dry, 1 soaked: rain or snow): darker and glossier; whether it changed. */
  setWet(wet: number): boolean {
    if (Math.abs(wet - this.wet) < 0.01) return false;
    this.wet = wet;
    this.surfaceMaterial.color.setScalar(1 - 0.3 * wet);
    this.surfaceMaterial.roughness = 0.92 - 0.5 * wet;
    return true;
  }

  /** Hide the zoomed-out road lines (while the traffic map draws the roads instead). */
  overviewHidden = false;

  /** Chunks built so far (for diagnostics). */
  get builtChunks(): number {
    return this.chunks.size;
  }

  /**
   * Show the right representation for the view and build missing chunks within a time
   * budget. Returns true if anything changed and the frame should be redrawn.
   */
  update(view: RoadView, budgetMs = 8): boolean {
    this.frame++;
    let changed = false;

    for (const layer of this.overviewLayers) {
      const visible =
        !this.overviewHidden &&
        view.viewHeight >= OVERVIEW_MIN_VIEW &&
        view.viewHeight <= layer.maxView;
      if (layer.lines.visible !== visible) {
        layer.lines.visible = visible;
        changed = true;
      }
    }

    const showDetail = view.viewHeight < DETAIL_MAX_VIEW;
    if (this.detail.visible !== showDetail) {
      this.detail.visible = showDetail;
      changed = true;
    }
    if (!showDetail) return changed;

    const radius =
      view.mode === 'free'
        ? THREE.MathUtils.clamp(view.distance * 2.5, 1_500, 8_000)
        : (view.viewHeight * Math.max(1, view.aspect)) / 2 + CHUNK;
    const wanted = this.chunksAround(view.target.x, view.target.z, radius);
    const start = performance.now();
    for (const key of wanted) {
      const existing = this.chunks.get(key);
      if (existing) {
        existing.lastUsed = this.frame;
        if (!existing.group.visible) {
          existing.group.visible = true;
          changed = true;
        }
        continue;
      }
      if (performance.now() - start > budgetMs) continue;
      const group = this.buildChunk(key);
      this.detail.add(group);
      this.chunks.set(key, { group, lastUsed: this.frame });
      changed = true;
    }

    const wantedSet = new Set(wanted);
    for (const [key, chunk] of this.chunks) {
      if (!wantedSet.has(key) && chunk.group.visible) {
        chunk.group.visible = false;
        changed = true;
      }
    }
    this.evict();
    return changed;
  }

  private indexChunks() {
    const { net } = this;
    const key = (x: number, z: number) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    const add = (map: Map<string, number[]>, k: string, v: number) => {
      const list = map.get(k);
      if (list) list.push(v);
      else map.set(k, [v]);
    };
    for (let lane = 0; lane < net.laneCount; lane++) {
      if (net.isInternal(net.laneEdge[lane])) continue; // junction surfaces cover these
      const { start, count } = net.lanePoints(lane);
      const mid = (start + (count >> 1)) * 3;
      add(this.chunkLanes, key(net.laneShape[mid], net.laneShape[mid + 1]), lane);
    }
    for (let j = 0; j < net.junctionCount; j++) {
      add(this.chunkJunctions, key(net.junctionPos[j * 2], net.junctionPos[j * 2 + 1]), j);
    }
  }

  /** Keys of chunks with content within `radius` of (x, z), nearest first. */
  private chunksAround(x: number, z: number, radius: number): string[] {
    const out: { key: string; d: number }[] = [];
    const c0 = Math.floor((x - radius) / CHUNK);
    const c1 = Math.floor((x + radius) / CHUNK);
    const r0 = Math.floor((z - radius) / CHUNK);
    const r1 = Math.floor((z + radius) / CHUNK);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = r0; cz <= r1; cz++) {
        const key = `${cx},${cz}`;
        if (!this.chunkLanes.has(key) && !this.chunkJunctions.has(key)) continue;
        const d = Math.hypot((cx + 0.5) * CHUNK - x, (cz + 0.5) * CHUNK - z);
        if (d <= radius + CHUNK * 0.71) out.push({ key, d });
      }
    }
    return out.sort((a, b) => a.d - b.d).map((c) => c.key);
  }

  private buildChunk(key: string): THREE.Group {
    const { net, height } = this;
    const surface = new MeshBuilder();
    const marks = new MeshBuilder();

    for (const lane of this.chunkLanes.get(key) ?? []) {
      const edge = net.laneEdge[lane];
      const cls = net.edgeClass[edge];
      const { start, count } = net.lanePoints(lane);
      const path = groundPath(net.laneShape, start, count, height, {
        bridge: net.hasFlag(edge, 'bridge'),
        lift: LANE_LIFT,
      });
      const half = net.laneWidth[lane] / 2;
      const road = cls !== 'tram' && cls !== 'rail';
      const tram = net.allows(lane, 'tram');
      const rail = net.allows(lane, 'rail');
      addRibbon(surface, path, half, ASPHALT[cls]);

      if (road) {
        const i = lane - net.edgeLaneStart[edge];
        const n = net.edgeLaneCount[edge];
        if (i < n - 1) addDashes(marks, path, 0.06, MARKING, half, MARK_LIFT, 3, 9);
        if (i === n - 1 && net.hasFlag(edge, 'hasOpposite') && CENTRE_LINE_CLASSES.has(cls)) {
          addRibbon(marks, path, 0.05, MARKING, half - 0.05, MARK_LIFT);
        }
        if (i === 0 && EDGE_LINE_CLASSES.has(cls)) {
          addRibbon(marks, path, 0.07, MARKING, -half + 0.2, MARK_LIFT);
        }
      }
      if (tram || rail) {
        const gauge = rail && !tram ? 1.435 : 1.0; // ZET trams run on metre gauge
        addRibbon(marks, path, 0.04, STEEL, gauge / 2, RAIL_LIFT);
        addRibbon(marks, path, 0.04, STEEL, -gauge / 2, RAIL_LIFT);
      }
    }

    for (const j of this.chunkJunctions.get(key) ?? []) {
      const { start, count } = net.junctionPoints(j);
      const ring = new Float32Array(count * 3);
      for (let k = 0; k < count; k++) {
        const i = (start + k) * 3;
        const x = net.junctionShape[i];
        const z = net.junctionShape[i + 1];
        ring[k * 3] = x;
        ring[k * 3 + 1] = height(x, z) + net.junctionShape[i + 2] + JUNCTION_LIFT;
        ring[k * 3 + 2] = z;
      }
      addPolygon(surface, ring, JUNCTION_COLOR);
    }

    const group = new THREE.Group();
    group.name = `roads ${key}`;
    const surfaceGeometry = surface.toGeometry();
    if (surfaceGeometry) group.add(new THREE.Mesh(surfaceGeometry, this.surfaceMaterial));
    const markGeometry = marks.toGeometry();
    if (markGeometry) group.add(new THREE.Mesh(markGeometry, this.markingMaterial));
    return group;
  }

  /** Free the least recently used hidden chunks beyond the cache size. */
  private evict() {
    if (this.chunks.size <= MAX_CACHED_CHUNKS) return;
    const hidden = [...this.chunks.entries()]
      .filter(([, c]) => !c.group.visible)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, chunk] of hidden.slice(0, this.chunks.size - MAX_CACHED_CHUNKS)) {
      this.detail.remove(chunk.group);
      chunk.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      this.chunks.delete(key);
    }
  }

  private buildOverview() {
    const { net, height } = this;
    const tiled = new Set(OVERVIEW.filter((s) => s.tiled).flatMap((s) => s.classes));
    // Segments by class, and by tile for tiled classes ('' otherwise).
    const byClass = new Map<RoadClass, Map<string, number[]>>();
    const xz: number[] = [];
    for (let e = 0; e < net.edgeCount; e++) {
      const cls = net.edgeClass[e];
      if (cls === 'service' || net.isInternal(e)) continue;
      // Draw each two-way road once.
      if (net.hasFlag(e, 'hasOpposite') && net.edgeFrom[e] > net.edgeTo[e]) continue;
      const lane = net.edgeLaneStart[e] + (net.edgeLaneCount[e] >> 1);
      const { start, count } = net.lanePoints(lane);
      xz.length = 0;
      for (let k = 0; k < count; k++) {
        xz.push(net.laneShape[(start + k) * 3], net.laneShape[(start + k) * 3 + 1]);
      }
      const tile = tiled.has(cls)
        ? `${Math.floor(xz[0] / OVERVIEW_TILE)},${Math.floor(xz[1] / OVERVIEW_TILE)}`
        : '';
      let tiles = byClass.get(cls);
      if (!tiles) byClass.set(cls, (tiles = new Map()));
      let list = tiles.get(tile);
      if (!list) tiles.set(tile, (list = []));
      const kept = simplify(xz, OVERVIEW_TOLERANCE);
      for (let k = 0; k + 1 < kept.length; k++) {
        for (const i of [kept[k], kept[k + 1]]) {
          const [x, z] = [xz[i * 2], xz[i * 2 + 1]];
          list.push(x, height(x, z) + net.laneShape[(start + i) * 3 + 2] + 3, z);
        }
      }
    }
    for (const style of OVERVIEW) {
      const tiles = new Map<string, number[]>();
      for (const cls of style.classes) {
        for (const [tile, list] of byClass.get(cls) ?? []) {
          const all = tiles.get(tile);
          if (all) all.push(...list);
          else tiles.set(tile, list);
        }
      }
      const material = new THREE.Line2NodeMaterial({
        color: style.color,
        linewidth: style.width,
        worldUnits: false,
      });
      for (const [tile, positions] of tiles) {
        if (positions.length === 0) continue;
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(new Float32Array(positions));
        const lines = new LineSegments2(geometry, material);
        lines.name = `overview ${style.classes.join('+')}${tile ? ` ${tile}` : ''}`;
        // Tiles are culled by their bounds; whole-map lines are always in view.
        lines.frustumCulled = tile !== '';
        this.overview.add(lines);
        this.overviewLayers.push({ lines, maxView: style.maxView });
      }
    }
  }
}
