import * as THREE from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

import type { HeightFn } from './roadGeometry';
import type { RoadClass, RoadNetwork } from './roadNetwork';

/** Traffic map bands: measured mean speed as a share of the speed limit. */
export const TRAFFIC_BANDS = [
  { min: 0.7, color: 0x2fb14b, label: 'Flowing' },
  { min: 0.45, color: 0xf2c12e, label: 'Slow' },
  { min: 0.2, color: 0xf07c22, label: 'Congested' },
  { min: 0, color: 0xd7263d, label: 'Jammed' },
] as const;
/** Roads with no vehicles in the last minute. */
const NO_TRAFFIC = 0x9aa1a8;

/** Colour of a road from the engine's speed ratio (0-254 = 0-100 % of the limit, 255 = no
 * traffic). */
export function trafficColor(ratio: number): number {
  if (ratio >= 255) return NO_TRAFFIC;
  const share = ratio / 254;
  for (const band of TRAFFIC_BANDS) if (share >= band.min) return band.color;
  return TRAFFIC_BANDS[TRAFFIC_BANDS.length - 1].color;
}

/** Shown when the view covers at least this many metres (closer, you see the vehicles). */
const MIN_VIEW = 1_200;
/** Drawn above the road overview lines. */
const LIFT = 6;
const NONE = 0xffffffff;
const LAYERS: { classes: RoadClass[]; width: number; maxView: number }[] = [
  { classes: ['minor'], width: 1.4, maxView: 9_000 },
  {
    classes: ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'],
    width: 3,
    maxView: Infinity,
  },
];

interface Layer {
  lines: LineSegments2;
  geometry: LineSegmentsGeometry;
  /** Edge of each line segment, and the opposite direction's edge (or NONE). */
  segmentEdge: Uint32Array;
  segmentOpposite: Uint32Array;
  maxView: number;
}

/**
 * The traffic map: every road coloured by how fast traffic moved on it in the last
 * simulated minute. Two-way roads are drawn once, in the colour of the slower direction
 * (at city scale the two would overlap anyway). While it shows, it replaces the road
 * overview lines, so the frame costs about the same.
 */
export class TrafficLayer {
  readonly object = new THREE.Group();
  private readonly layers: Layer[] = [];
  private readonly color = new THREE.Color();
  enabled = false;

  constructor(net: RoadNetwork, height: HeightFn) {
    this.object.name = 'traffic map';
    // The opposite direction of a two-way road: the edge between the same junctions, reversed.
    const byEnds = new Map<string, number>();
    for (let e = 0; e < net.edgeCount; e++) {
      if (!net.isInternal(e)) byEnds.set(`${net.edgeFrom[e]},${net.edgeTo[e]}`, e);
    }
    for (const style of LAYERS) {
      const classes = new Set(style.classes);
      const positions: number[] = [];
      const segmentEdge: number[] = [];
      const segmentOpposite: number[] = [];
      for (let e = 0; e < net.edgeCount; e++) {
        if (net.isInternal(e) || !classes.has(net.edgeClass[e])) continue;
        let opposite = NONE;
        if (net.hasFlag(e, 'hasOpposite')) {
          if (net.edgeFrom[e] > net.edgeTo[e]) continue; // drawn with its other direction
          opposite = byEnds.get(`${net.edgeTo[e]},${net.edgeFrom[e]}`) ?? NONE;
        }
        const lane = net.edgeLaneStart[e] + (net.edgeLaneCount[e] >> 1);
        const { start, count } = net.lanePoints(lane);
        for (let k = 0; k < count - 1; k++) {
          for (const p of [start + k, start + k + 1]) {
            const x = net.laneShape[p * 3];
            const z = net.laneShape[p * 3 + 1];
            positions.push(x, height(x, z) + net.laneShape[p * 3 + 2] + LIFT, z);
          }
          segmentEdge.push(e);
          segmentOpposite.push(opposite);
        }
      }
      if (segmentEdge.length === 0) continue;
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(new Float32Array(positions));
      const material = new THREE.Line2NodeMaterial({
        vertexColors: true,
        linewidth: style.width,
        worldUnits: false,
      });
      const lines = new LineSegments2(geometry, material);
      lines.frustumCulled = false;
      lines.renderOrder = 2;
      lines.name = `traffic ${style.classes.join('+')}`;
      this.object.add(lines);
      this.layers.push({
        lines,
        geometry,
        segmentEdge: new Uint32Array(segmentEdge),
        segmentOpposite: new Uint32Array(segmentOpposite),
        maxView: style.maxView,
      });
    }
    this.setSpeeds(undefined);
    this.object.visible = false;
  }

  /** Recolour roads from the engine's per-edge speed ratios (none: all without traffic). */
  setSpeeds(speeds: Uint8Array | undefined): void {
    for (const layer of this.layers) {
      const colors = new Float32Array(layer.segmentEdge.length * 6);
      for (let i = 0; i < layer.segmentEdge.length; i++) {
        const opposite = layer.segmentOpposite[i];
        // 255 (no traffic) is above every measured ratio, so the slower measured one wins.
        const ratio = speeds
          ? Math.min(speeds[layer.segmentEdge[i]], opposite === NONE ? 255 : speeds[opposite])
          : 255;
        this.color.setHex(trafficColor(ratio));
        const { r, g, b } = this.color;
        colors.set([r, g, b, r, g, b], i * 6);
      }
      layer.geometry.setColors(colors);
    }
  }

  /** Whether the map is on screen at this view height. */
  shows(viewHeight: number): boolean {
    return this.enabled && viewHeight >= MIN_VIEW;
  }

  /** Show the layers that suit the view. Returns true if anything changed. */
  update(viewHeight: number): boolean {
    let changed = false;
    const show = this.shows(viewHeight);
    if (this.object.visible !== show) {
      this.object.visible = show;
      changed = true;
    }
    for (const layer of this.layers) {
      const visible = viewHeight <= layer.maxView;
      if (layer.lines.visible !== visible) {
        layer.lines.visible = visible;
        changed = true;
      }
    }
    return changed;
  }
}
