import * as THREE from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

import type { Edit } from '../edit/edits';
import type { HeightFn } from './roadGeometry';
import type { RoadNetwork } from './roadNetwork';

const LIFT = 9;

/** Colours of edited roads by kind of edit (public transport edits change no road), and
 * of the road being edited. */
export const EDIT_COLORS: Record<Exclude<Edit['kind'], 'frequency' | 'line'> | 'selected', number> =
  {
    selected: 0x4da3ff,
    close: 0xe0102f,
    closeLane: 0xf07c22,
    speed: 0xa070ff,
    busLane: 0xd6336c,
    ban: 0xf2c12e,
    green: 0x2fbf71,
    priority: 0x2fbf71,
    road: 0x12a4a0,
    roundabout: 0x12a4a0,
    signal: 0x2fbf71,
    charge: 0x9b59d0,
    parking: 0x3b7dd8,
    lorryBan: 0xc8702a,
    service: 0x2f9e6e,
  };

/** Roads changed by edits, and the road being edited, drawn over the map. */
export class EditLayer {
  readonly object = new THREE.Group();

  constructor(
    private readonly net: RoadNetwork,
    private readonly height: HeightFn,
  ) {
    this.object.name = 'edits';
  }

  /** Draw each group of edges in its colour. */
  show(groups: readonly { edges: readonly number[]; color: number; width?: number }[]): void {
    for (const child of [...this.object.children]) {
      this.object.remove(child);
      if (child instanceof LineSegments2) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    const net = this.net;
    for (const { edges, color, width } of groups) {
      const positions: number[] = [];
      for (const e of edges) {
        const lane0 = net.edgeLaneStart[e];
        // Along the middle of the road's lanes.
        const lanes = net.edgeLaneCount[e];
        const lane = lane0 + Math.floor(lanes / 2);
        const { start, count } = net.lanePoints(lane);
        for (let k = 0; k < count - 1; k++) {
          for (const p of [start + k, start + k + 1]) {
            const x = net.laneShape[p * 3];
            const z = net.laneShape[p * 3 + 1];
            positions.push(x, this.height(x, z) + net.laneShape[p * 3 + 2] + LIFT, z);
          }
        }
      }
      if (positions.length === 0) continue;
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(new Float32Array(positions));
      const lines = new LineSegments2(
        geometry,
        new THREE.Line2NodeMaterial({ color, linewidth: width ?? 5, worldUnits: false }),
      );
      lines.frustumCulled = false;
      lines.renderOrder = 4;
      this.object.add(lines);
    }
  }
}

/** The road being drawn (Build panel, New road): its points joined over the ground. */
export class DrawLayer {
  readonly object = new THREE.Group();

  constructor(private readonly height: HeightFn) {
    this.object.name = 'drawing';
  }

  show(points: readonly { x: number; z: number }[]): void {
    for (const child of [...this.object.children]) {
      this.object.remove(child);
      if (child instanceof LineSegments2) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    if (points.length === 0) return;
    const y = (p: { x: number; z: number }) => this.height(p.x, p.z) + LIFT + 1;
    const positions: number[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const [a, b] = [points[i], points[i + 1]];
      positions.push(a.x, y(a), a.z, b.x, y(b), b.z);
    }
    // A cross at each point clicked.
    for (const p of points) {
      positions.push(p.x - 6, y(p), p.z - 6, p.x + 6, y(p), p.z + 6);
      positions.push(p.x - 6, y(p), p.z + 6, p.x + 6, y(p), p.z - 6);
    }
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(new Float32Array(positions));
    const lines = new LineSegments2(
      geometry,
      new THREE.Line2NodeMaterial({ color: 0xffffff, linewidth: 4, worldUnits: false }),
    );
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    this.object.add(lines);
  }
}

/** Areas of policies in force (M18): their outlines over the ground. */
export class AreaLayer {
  readonly object = new THREE.Group();

  constructor(private readonly height: HeightFn) {
    this.object.name = 'areas';
  }

  show(areas: readonly { points: readonly { x: number; z: number }[]; color: number }[]): void {
    for (const child of [...this.object.children]) {
      this.object.remove(child);
      if (child instanceof LineSegments2) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    for (const { points, color } of areas) {
      const positions: number[] = [];
      // Each side in steps of 40 m at most, so the outline follows the ground.
      for (let i = 0; i < points.length; i++) {
        const [a, b] = [points[i], points[(i + 1) % points.length]];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 40));
        for (let k = 0; k < steps; k++) {
          for (const f of [k / steps, (k + 1) / steps]) {
            const x = a.x + (b.x - a.x) * f;
            const z = a.z + (b.z - a.z) * f;
            positions.push(x, this.height(x, z) + LIFT + 1, z);
          }
        }
      }
      if (positions.length === 0) continue;
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(new Float32Array(positions));
      const lines = new LineSegments2(
        geometry,
        new THREE.Line2NodeMaterial({ color, linewidth: 4, worldUnits: false }),
      );
      lines.frustumCulled = false;
      lines.renderOrder = 4;
      this.object.add(lines);
    }
  }
}
