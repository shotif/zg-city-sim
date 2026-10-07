import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';

import { Heightfield } from '../src/world/heightfield';
import { type TerrainNode, TerrainTree, decodeNormal, encodeNormal } from '../src/world/terrainLod';

// 101 by 90 samples 10 m apart: hills and a ridge, so coarse tiles differ from the finest.
const COLS = 101;
const ROWS = 90;
const heights = new Float32Array(COLS * ROWS);
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    heights[r * COLS + c] =
      100 + 30 * Math.sin(c / 7) * Math.cos(r / 9) + 12 * Math.abs(Math.sin((c + r) / 5));
  }
}
const hf = new Heightfield(heights, COLS, ROWS, 10, -500, -400);

/** Every tile of the tree, measured. */
function allNodes(tree: TerrainTree): TerrainNode[] {
  const out: TerrainNode[] = [];
  const visit = (node: TerrainNode) => {
    if (!node.prepared) tree.prepare(node);
    out.push(node);
    for (const child of tree.childrenOf(node)) visit(child);
  };
  visit(tree.root);
  return out;
}

/** The tile's top surface at (x, z), from its triangles; undefined outside it. */
function surfaceOf(geometry: THREE.BufferGeometry, x: number, z: number): number | undefined {
  const p = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    const [ax, az, bx, bz, cx, cz] = [
      p.getX(a),
      p.getZ(a),
      p.getX(b),
      p.getZ(b),
      p.getX(c),
      p.getZ(c),
    ];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue; // a skirt
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    return l1 * p.getY(a) + l2 * p.getY(b) + l3 * p.getY(c);
  }
  return undefined;
}

describe('terrain tiles', () => {
  const tree = new TerrainTree(hf, 2, 8);
  const nodes = allNodes(tree);
  const finest = hf.meshSurface(2);

  it('cover the grid with a root and quarters down to the finest stride', () => {
    expect(tree.root.stride).toBe(16);
    expect(tree.root.c1).toBe(100);
    expect(tree.root.r1).toBe(88);
    const leaves = nodes.filter((n) => tree.isLeaf(n));
    expect(leaves.every((n) => n.stride === 2 && n.error === 0 && n.shift === 0)).toBe(true);
    // Leaves tile the finest lattice: 50 by 44 cells.
    const cells = leaves.reduce((sum, n) => sum + ((n.c1 - n.c0) / 2) * ((n.r1 - n.r0) / 2), 0);
    expect(cells).toBe(50 * 44);
  });

  it('draw the finest tiles on the surface roads are placed on', () => {
    for (const node of nodes.filter((n) => tree.isLeaf(n)).slice(0, 6)) {
      const g = tree.geometry(node);
      for (const [x, z] of [
        [hf.west + (node.c0 + 1.3) * 10, hf.north + (node.r0 + 0.9) * 10],
        [hf.west + (node.c0 + 2.6) * 10, hf.north + (node.r0 + 3.1) * 10],
      ]) {
        const y = surfaceOf(g, x, z);
        if (y !== undefined) expect(y).toBeCloseTo(finest(x, z), 3);
      }
    }
  });

  it('lower coarser tiles under the finest surface, by no more than their error', () => {
    let checked = 0;
    for (const node of nodes.filter((n) => !tree.isLeaf(n))) {
      expect(node.error).toBeGreaterThanOrEqual(node.shift);
      const g = tree.geometry(node);
      for (let k = 0; k < 40; k++) {
        const col = node.c0 + (((k * 37) % 97) / 97) * (node.c1 - node.c0);
        const row = node.r0 + (((k * 53) % 89) / 89) * (node.r1 - node.r0);
        const x = hf.west + (col + 0.5) * 10;
        const z = hf.north + (row + 0.5) * 10;
        const y = surfaceOf(g, x, z);
        if (y === undefined) continue;
        checked++;
        expect(y).toBeLessThanOrEqual(finest(x, z) + 1e-3);
        expect(y).toBeGreaterThanOrEqual(finest(x, z) - node.error - 1e-3);
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(tree.root.error).toBeGreaterThan(1);
  });

  it('face their tops up and their skirts out', () => {
    const node = nodes[1];
    const g = tree.geometry(node);
    const p = g.getAttribute('position');
    const index = g.getIndex()!;
    const centre = node.box.getCenter(new THREE.Vector3());
    const [a, b, c, n] = [0, 1, 2, 3].map(() => new THREE.Vector3());
    let walls = 0;
    for (let t = 0; t < index.count; t += 3) {
      a.fromBufferAttribute(p, index.getX(t));
      b.fromBufferAttribute(p, index.getX(t + 1));
      c.fromBufferAttribute(p, index.getX(t + 2));
      n.subVectors(b, a).cross(c.clone().sub(a));
      if (Math.abs(n.y) > 1e-6) {
        expect(n.y).toBeGreaterThan(0);
      } else {
        walls++;
        const mid = a.clone().add(b).add(c).divideScalar(3).sub(centre);
        expect(n.x * mid.x + n.z * mid.z).toBeGreaterThan(0);
      }
    }
    expect(walls).toBeGreaterThan(0);
  });

  it('choose finer tiles where the error on the screen is larger', () => {
    const fresh = new TerrainTree(hf, 2, 8);
    const all = () => true;
    expect(
      fresh.select(
        all,
        () => 0,
        () => 0,
      ).nodes,
    ).toEqual([fresh.root]);
    // Asked for every detail: tiles are measured a batch at a time until only leaves are left.
    let picked = fresh.select(
      all,
      () => 100,
      () => 0,
      Infinity,
    );
    for (let i = 0; i < 10 && picked.pending; i++) {
      picked = fresh.select(
        all,
        () => 100,
        () => 0,
        Infinity,
      );
    }
    expect(picked.pending).toBe(false);
    expect(picked.nodes.every((n) => fresh.isLeaf(n))).toBe(true);
    // Only tiles on the screen.
    const west = fresh.select(
      (n) => n.c0 < 40,
      () => 100,
      () => 0,
      Infinity,
    );
    expect(west.nodes.every((n) => n.c0 < 40)).toBe(true);
  });
});

describe('normals in a byte', () => {
  it('keep slopes near level ground finely', () => {
    for (const n of [-1, -0.5, -0.1, -0.02, 0, 0.005, 0.03, 0.2, 0.7, 1]) {
      const back = decodeNormal(encodeNormal(n));
      expect(Math.abs(back - n)).toBeLessThan(Math.abs(n) < 0.05 ? 0.004 : 0.012);
    }
  });
});
