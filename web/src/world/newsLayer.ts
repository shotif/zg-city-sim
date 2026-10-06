import * as THREE from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

import { DATA_URL } from '../manifest';
import type { HeightFn } from './roadGeometry';
import type { RoadNetwork } from './roadNetwork';

/** A news report about traffic at a place (pipeline/data/news.json). */
export interface NewsReport {
  date?: string;
  outlet: string;
  url: string;
  headline: string;
  summary: string;
  type?: string;
  severity?: number;
  timeOfDay?: string;
  recurring?: boolean;
  direction?: string;
  period?: { from?: string | null; to?: string | null };
}

/** A place the news reported traffic trouble at, with the edges that make it up. */
export interface NewsHotspot {
  id: string;
  name: string;
  x: number;
  z: number;
  edges: number[];
  /** Newest first. */
  reports: NewsReport[];
}

export interface NewsData {
  about: string;
  hotspots: NewsHotspot[];
}

export async function loadNews(indexPath: string): Promise<NewsData> {
  const response = await fetch(DATA_URL + indexPath);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as NewsData;
}

/** Traffic on a set of edges in the last simulated minute. */
export interface PlaceTraffic {
  /** Mean speed as a share of the speed limit (0-1), weighted by length. */
  share: number;
  /** Mean speed (km/h), weighted by length. */
  kmh: number;
}

/** Simulated traffic on `edges` from the engine's speed ratios (0-254 = 0-100 % of the
 * limit, 255 = no traffic); undefined if none of them had traffic. */
export function placeTraffic(
  net: RoadNetwork,
  edges: readonly number[],
  speeds: Uint8Array,
): PlaceTraffic | undefined {
  let weight = 0;
  let share = 0;
  let kmh = 0;
  for (const e of edges) {
    const ratio = speeds[e];
    if (ratio === undefined || ratio >= 255) continue;
    const lane = net.edgeLaneStart[e];
    const length = net.laneLength[lane];
    share += (ratio / 254) * length;
    kmh += (ratio / 254) * net.laneSpeed[lane] * 3.6 * length;
    weight += length;
  }
  return weight > 0 ? { share: share / weight, kmh: kmh / weight } : undefined;
}

/** Drawn above roads and the traffic map. */
const LIFT = 9;
const HIGHLIGHT = 0xff4fd8;

/**
 * News hotspots on the map: the selected place's roads drawn in a highlight colour. The
 * markers and the reports are HTML (ui/newsPanel.ts).
 */
export class NewsLayer {
  readonly object = new THREE.Group();
  private lines?: LineSegments2;
  selected?: NewsHotspot;

  constructor(
    private readonly net: RoadNetwork,
    private readonly height: HeightFn,
    readonly data: NewsData,
  ) {
    this.object.name = 'news hotspots';
  }

  /** Highlight a hotspot's roads (none: clear). */
  select(hotspot: NewsHotspot | undefined): void {
    this.selected = hotspot;
    if (this.lines) {
      this.object.remove(this.lines);
      this.lines.geometry.dispose();
      (this.lines.material as THREE.Material).dispose();
      this.lines = undefined;
    }
    if (!hotspot) return;
    const net = this.net;
    const positions: number[] = [];
    for (const e of hotspot.edges) {
      const lane = net.edgeLaneStart[e] + (net.edgeLaneCount[e] >> 1);
      const { start, count } = net.lanePoints(lane);
      for (let k = 0; k < count - 1; k++) {
        for (const p of [start + k, start + k + 1]) {
          const x = net.laneShape[p * 3];
          const z = net.laneShape[p * 3 + 1];
          positions.push(x, this.height(x, z) + net.laneShape[p * 3 + 2] + LIFT, z);
        }
      }
    }
    if (positions.length === 0) return;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(new Float32Array(positions));
    const material = new THREE.Line2NodeMaterial({
      color: HIGHLIGHT,
      linewidth: 6,
      worldUnits: false,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    this.lines = new LineSegments2(geometry, material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    this.object.add(this.lines);
  }

  /** Height of the ground at a hotspot's marker. */
  markerY(hotspot: NewsHotspot): number {
    return this.height(hotspot.x, hotspot.z) + LIFT;
  }
}
