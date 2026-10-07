/**
 * The terrain drawn in tiles that get coarser with distance (M6f), in place of one mesh of
 * every second height sample (1.9 million triangles in every view).
 *
 * Tiles form a quadtree: the root covers the whole heightfield with a grid of GRID by GRID
 * cells, each child a quarter of its parent with the same grid, down to tiles at the
 * finest stride, whose vertices and triangles are those of `Heightfield.meshSurface`, on
 * which roads and buildings are placed. Each frame the tree is walked from the root and a
 * tile is split while the most its surface can differ from the finest one, projected on
 * the screen, is more than TOLERANCE pixels.
 *
 * A coarser tile is lowered by as much as its surface rises above the finest one anywhere,
 * so it never covers roads, lots or buildings placed on the finest surface. Vertical
 * skirts along every tile's edges hide the gaps between tiles. The shading comes from a
 * texture of normals at every height sample, so it does not change with the tile's grid.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  mix,
  positionWorld,
  sqrt,
  texture,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';

import type { Heightfield } from './heightfield';

/** Cells across a tile, at every level. */
export const GRID = 64;
/** Largest height error allowed on the screen (CSS pixels). */
const TOLERANCE = 1.5;
/** Time per frame for preparing tiles (ms). */
const BUDGET_MS = 4;

export interface TerrainNode {
  /** 0 for the root. */
  level: number;
  /** Height samples per cell. */
  stride: number;
  /** First and last sample (column, row) the tile spans, inclusive. */
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  children: TerrainNode[];
  prepared: boolean;
  /** How far the tile is lowered so it never rises above the finest surface (m). */
  shift: number;
  /** The most the tile's surface lies below the finest one (m). */
  error: number;
  /** Bounds in scene coordinates, skirts included. */
  box: THREE.Box3;
  mesh?: THREE.Mesh;
}

/** A tile's vertex columns or rows: every `stride`-th sample from `first`, the last one
 * clamped to `last`. */
function lattice(first: number, last: number, stride: number): number[] {
  const out: number[] = [];
  for (let c = first; c < last; c += stride) out.push(c);
  out.push(last);
  return out;
}

/** The quadtree of tiles over a heightfield (no rendering, so it can be tested). */
export class TerrainTree {
  readonly root: TerrainNode;
  /** Last sample on the finest lattice, across and down. */
  readonly lastCol: number;
  readonly lastRow: number;
  /** How deep skirts hang (m): the root's error, which no tile exceeds, and a margin. */
  skirt = 0;
  /** Index of a full tile's triangles, shared by all of them. */
  private sharedIndex?: THREE.BufferAttribute;

  constructor(
    readonly hf: Heightfield,
    /** Height samples per cell of the finest tiles. */
    readonly finest: number,
    readonly grid = GRID,
  ) {
    this.lastCol = Math.floor((hf.cols - 1) / finest) * finest;
    this.lastRow = Math.floor((hf.rows - 1) / finest) * finest;
    let stride = finest;
    while (grid * stride < Math.max(this.lastCol, this.lastRow)) stride *= 2;
    this.root = this.node(0, stride, 0, 0);
    this.prepare(this.root);
    this.skirt = this.root.error + 5;
    this.root.box.min.y -= this.skirt;
  }

  private node(level: number, stride: number, c0: number, r0: number): TerrainNode {
    return {
      level,
      stride,
      c0,
      r0,
      c1: Math.min(c0 + this.grid * stride, this.lastCol),
      r1: Math.min(r0 + this.grid * stride, this.lastRow),
      children: [],
      prepared: false,
      shift: 0,
      error: 0,
      box: new THREE.Box3(),
    };
  }

  isLeaf(node: TerrainNode): boolean {
    return node.stride <= this.finest;
  }

  /** A node's children (made on first asking). */
  childrenOf(node: TerrainNode): TerrainNode[] {
    if (this.isLeaf(node) || node.children.length) return node.children;
    const stride = node.stride / 2;
    const span = this.grid * stride;
    for (const r0 of [node.r0, node.r0 + span]) {
      for (const c0 of [node.c0, node.c0 + span]) {
        if (c0 < node.c1 && r0 < node.r1) {
          node.children.push(this.node(node.level + 1, stride, c0, r0));
        }
      }
    }
    return node.children;
  }

  /** Measure how far the tile is from the finest surface, and its bounds. */
  prepare(node: TerrainNode): void {
    const hf = this.hf;
    const h = hf.heights;
    const cols = lattice(node.c0, node.c1, node.stride);
    const rows = lattice(node.r0, node.r1, node.stride);
    const fine = this.finest;
    let above = 0;
    let below = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    const leaf = this.isLeaf(node);
    // Each coarse cell against the finest samples in it (those on its edges twice).
    for (let j = 0; j + 1 < rows.length; j++) {
      const [ra, rb] = [rows[j], rows[j + 1]];
      for (let i = 0; i + 1 < cols.length; i++) {
        const [ca, cb] = [cols[i], cols[i + 1]];
        const ha = h[ra * hf.cols + ca]; // north-west
        const he = h[ra * hf.cols + cb]; // north-east
        const hb = h[rb * hf.cols + ca]; // south-west
        const hd = h[rb * hf.cols + cb]; // south-east
        for (let row = ra; row <= rb; row += fine) {
          const v = (row - ra) / (rb - ra);
          for (let col = ca; col <= cb; col += fine) {
            const y = h[row * hf.cols + col];
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (leaf) continue;
            const u = (col - ca) / (cb - ca);
            // The triangles split from south-west to north-east, as the mesh's.
            const coarse =
              u + v <= 1
                ? ha + (he - ha) * u + (hb - ha) * v
                : hd + (hb - hd) * (1 - u) + (he - hd) * (1 - v);
            const diff = coarse - y;
            if (diff > above) above = diff;
            if (diff < below) below = diff;
          }
        }
      }
    }
    node.shift = above;
    node.error = above - below;
    const x = (c: number) => hf.west + (c + 0.5) * hf.resolution;
    const z = (r: number) => hf.north + (r + 0.5) * hf.resolution;
    node.box.min.set(x(node.c0), minY - node.shift - this.skirt, z(node.r0));
    node.box.max.set(x(node.c1), maxY, z(node.r1));
    node.prepared = true;
  }

  /** The tile's vertices (with skirts) and triangles. */
  geometry(node: TerrainNode): THREE.BufferGeometry {
    const hf = this.hf;
    const cols = lattice(node.c0, node.c1, node.stride);
    const rows = lattice(node.r0, node.r1, node.stride);
    const nc = cols.length;
    const nr = rows.length;
    const top = nc * nr;
    // Skirt vertices: under the north, south, west and east edges.
    const count = top + 2 * nc + 2 * nr;
    const positions = new Float32Array(count * 3);
    const put = (v: number, col: number, row: number, drop: number) => {
      positions[v * 3] = hf.west + (col + 0.5) * hf.resolution;
      positions[v * 3 + 1] = hf.at(col, row) - node.shift - drop;
      positions[v * 3 + 2] = hf.north + (row + 0.5) * hf.resolution;
    };
    for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) put(j * nc + i, cols[i], rows[j], 0);
    const north = top;
    const south = north + nc;
    const west = south + nc;
    const east = west + nr;
    for (let i = 0; i < nc; i++) {
      put(north + i, cols[i], rows[0], this.skirt);
      put(south + i, cols[i], rows[nr - 1], this.skirt);
    }
    for (let j = 0; j < nr; j++) {
      put(west + j, cols[0], rows[j], this.skirt);
      put(east + j, cols[nc - 1], rows[j], this.skirt);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const full = nc === this.grid + 1 && nr === this.grid + 1;
    geometry.setIndex(full ? (this.sharedIndex ??= this.index(nc, nr)) : this.index(nc, nr));
    geometry.boundingBox = node.box.clone();
    geometry.boundingSphere = node.box.getBoundingSphere(new THREE.Sphere());
    return geometry;
  }

  /** Triangles of a tile of nc by nr vertices, then its skirts, all facing out. */
  private index(nc: number, nr: number): THREE.BufferAttribute {
    const cells = (nc - 1) * (nr - 1) * 6;
    const skirts = (2 * (nc - 1) + 2 * (nr - 1)) * 6;
    const total = nc * nr + 2 * nc + 2 * nr;
    const index = total > 65535 ? new Uint32Array(cells + skirts) : new Uint16Array(cells + skirts);
    let k = 0;
    for (let j = 0; j < nr - 1; j++) {
      for (let i = 0; i < nc - 1; i++) {
        const a = j * nc + i; // north-west
        const b = a + nc; // south-west
        const d = b + 1; // south-east
        const e = a + 1; // north-east
        index.set([a, b, e, b, d, e], k);
        k += 6;
      }
    }
    const top = nc * nr;
    const north = top;
    const south = north + nc;
    const west = south + nc;
    const east = west + nr;
    // A wall from top vertex t0 to t1 with s0, s1 under them, wound to face the side
    // `outward` says: the north and east walls face out when walked one way, the south and
    // west ones the other.
    const wall = (t0: number, t1: number, s0: number, s1: number, flip: boolean) => {
      if (flip) index.set([t0, s1, s0, t0, t1, s1], k);
      else index.set([t0, s0, s1, t0, s1, t1], k);
      k += 6;
    };
    for (let i = 0; i < nc - 1; i++) {
      wall(i, i + 1, north + i, north + i + 1, true);
      wall((nr - 1) * nc + i, (nr - 1) * nc + i + 1, south + i, south + i + 1, false);
    }
    for (let j = 0; j < nr - 1; j++) {
      wall(j * nc, (j + 1) * nc, west + j, west + j + 1, false);
      wall(j * nc + nc - 1, (j + 1) * nc + nc - 1, east + j, east + j + 1, true);
    }
    return new THREE.BufferAttribute(index, 1);
  }

  /**
   * The tiles to draw: split from the root while a tile's error on the screen (`error`,
   * pixels) is over the tolerance, leaving out tiles `visible` says are off the screen.
   * Children not yet measured are measured nearest first within the time budget; until
   * then their parent is drawn. `pending`: some are still waiting.
   */
  select(
    visible: (node: TerrainNode) => boolean,
    error: (node: TerrainNode) => number,
    distance: (node: TerrainNode) => number,
    budgetMs = BUDGET_MS,
    now: () => number = () => performance.now(),
  ): { nodes: TerrainNode[]; pending: boolean } {
    const nodes: TerrainNode[] = [];
    const waiting: TerrainNode[] = [];
    const visit = (node: TerrainNode) => {
      if (!visible(node)) return;
      if (this.isLeaf(node) || error(node) <= TOLERANCE) {
        nodes.push(node);
        return;
      }
      const children = this.childrenOf(node);
      const unready = children.filter((c) => !c.prepared);
      if (unready.length) {
        waiting.push(...unready);
        nodes.push(node);
        return;
      }
      for (const child of children) visit(child);
    };
    visit(this.root);
    if (waiting.length) {
      waiting.sort((a, b) => distance(a) - distance(b));
      const start = now();
      for (const node of waiting) {
        this.prepare(node);
        if (now() - start > budgetMs) break;
      }
    }
    return { nodes, pending: waiting.length > 0 };
  }
}

/** A slope component (-1 to 1) in a byte, finer near level ground: sign(n) √|n|. */
export function encodeNormal(n: number): number {
  const e = Math.sign(n) * Math.sqrt(Math.min(1, Math.abs(n)));
  return Math.round((e * 0.5 + 0.5) * 255);
}

export function decodeNormal(byte: number): number {
  const e = (byte / 255) * 2 - 1;
  return Math.sign(e) * e * e;
}

/** Normals at every height sample: x and z in two bytes (`encodeNormal`); y follows. */
export function normalTexture(hf: Heightfield): THREE.DataTexture {
  const data = new Uint8Array(hf.cols * hf.rows * 2);
  const step = 2 * hf.resolution;
  for (let r = 0; r < hf.rows; r++) {
    for (let c = 0; c < hf.cols; c++) {
      const dhdx = (hf.at(c + 1, r) - hf.at(c - 1, r)) / step;
      const dhdz = (hf.at(c, r + 1) - hf.at(c, r - 1)) / step;
      const len = Math.hypot(dhdx, 1, dhdz);
      const i = (r * hf.cols + c) * 2;
      data[i] = encodeNormal(-dhdx / len);
      data[i + 1] = encodeNormal(-dhdz / len);
    }
  }
  const tex = new THREE.DataTexture(data, hf.cols, hf.rows, THREE.RGFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Ground beyond the terrain, out to `reach` m: a square with the terrain's rectangle cut
 * out, so it never shows through tiles lowered below it.
 */
export function outsideGeometry(tree: TerrainTree, reach: number): THREE.BufferGeometry {
  const { hf } = tree;
  const [x0, z0] = [hf.west + 0.5 * hf.resolution, hf.north + 0.5 * hf.resolution];
  const [x1, z1] = [x0 + tree.lastCol * hf.resolution, z0 + tree.lastRow * hf.resolution];
  // Outer corners, then inner ones, each north-west, north-east, south-east, south-west.
  const corners = [
    [x0 - reach, z0 - reach],
    [x1 + reach, z0 - reach],
    [x1 + reach, z1 + reach],
    [x0 - reach, z1 + reach],
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(corners.flatMap(([x, z]) => [x, 0, z])), 3),
  );
  geometry.setAttribute(
    'normal',
    new THREE.BufferAttribute(new Float32Array(corners.flatMap(() => [0, 1, 0])), 3),
  );
  // A band on each side, outer edge to inner edge, facing up.
  const index: number[] = [];
  for (let k = 0; k < 4; k++) {
    const [o0, o1, i0, i1] = [k, (k + 1) % 4, 4 + k, 4 + ((k + 1) % 4)];
    index.push(o0, i0, o1, o1, i0, i1);
  }
  geometry.setIndex(index);
  return geometry;
}

/** Rectangle a texture covers, in scene coordinates. */
export interface Extent {
  west: number;
  north: number;
  width: number;
  height: number;
}

/** The terrain as drawn: tiles chosen for the camera every frame it moves. */
export class TerrainLayer {
  readonly object = new THREE.Group();
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly tree: TerrainTree;
  /** Tiles drawn, and triangles in them (for tests and ?perf). */
  drawn = 0;
  triangles = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private key = '';
  private shown = new Set<TerrainNode>();
  private readonly planMap: THREE.TextureNode<'vec4'>;
  private readonly planOpacity = uniform(0);
  private readonly planMin = uniform(new THREE.Vector2());
  private readonly planSize = uniform(new THREE.Vector2(1, 1));

  constructor(hf: Heightfield, stride: number, ground: THREE.Texture, groundExtent: Extent) {
    this.object.name = 'terrain';
    this.tree = new TerrainTree(hf, stride);
    const normals = normalTexture(hf);
    const xz = positionWorld.xz;
    const uvOf = (west: number, north: number, width: number, height: number) =>
      xz.sub(vec2(west, north)).div(vec2(width, height));
    const g = groundExtent;
    const groundColor = texture(ground, uvOf(g.west, g.north, g.width, g.height));
    const n = texture(
      normals,
      uvOf(hf.west, hf.north, hf.cols * hf.resolution, hf.rows * hf.resolution),
    );
    const e = n.rg.mul(2).sub(1);
    const nx = e.x.mul(e.x.abs());
    const nz = e.y.mul(e.y.abs());
    const ny = sqrt(float(1).sub(nx.mul(nx)).sub(nz.mul(nz)).max(0));
    const placeholder = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    placeholder.needsUpdate = true;
    this.planMap = texture(placeholder, xz.sub(this.planMin).div(this.planSize));
    this.material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    this.material.colorNode = mix(
      groundColor.rgb,
      this.planMap.rgb,
      this.planMap.a.mul(this.planOpacity),
    );
    this.material.normalNode = transformNormalToView(vec3(nx, ny, nz).normalize());
  }

  /** Lay a map over the terrain (the City's planned land use), or take it away. */
  setOverlay(map: THREE.Texture | undefined, extent: Extent, opacity: number): void {
    if (map) this.planMap.value = map;
    this.planMin.value.set(extent.west, extent.north);
    this.planSize.value.set(extent.width, extent.height);
    this.planOpacity.value = map ? opacity : 0;
  }

  /** Choose the tiles for the camera; whether anything changed. */
  update(camera: THREE.Camera, viewportHeight: number): boolean {
    camera.updateMatrixWorld();
    const key = `${camera.matrixWorld.elements.join()}|${camera.projectionMatrix.elements.join()}|${viewportHeight}`;
    if (key === this.key) return false;
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(
      this.matrix,
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    camera.getWorldPosition(this.position);
    camera.getWorldDirection(this.direction);
    const pos = this.position;
    const height = Math.max(1, viewportHeight);
    let error: (node: TerrainNode) => number;
    if (camera instanceof THREE.PerspectiveCamera) {
      const k = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      error = (node) => (node.error * k) / Math.max(1, node.box.distanceToPoint(pos));
    } else {
      const ortho = camera as THREE.OrthographicCamera;
      const metresPerPixel = (ortho.top - ortho.bottom) / ortho.zoom / height;
      // A height error shows on the screen as much as the view is tilted from straight down.
      const tilt = Math.sqrt(Math.max(0, 1 - this.direction.y * this.direction.y));
      error = (node) => (node.error * tilt) / metresPerPixel;
    }
    const { nodes, pending } = this.tree.select(
      (node) => this.frustum.intersectsBox(node.box),
      error,
      (node) => node.box.distanceToPoint(pos),
    );
    // Measured children need choosing again next frame.
    this.key = pending ? '' : key;
    const wanted = new Set(nodes);
    let changed = false;
    for (const node of this.shown) {
      if (!wanted.has(node) && node.mesh) {
        node.mesh.visible = false;
        changed = true;
      }
    }
    let triangles = 0;
    for (const node of nodes) {
      if (!node.mesh) {
        node.mesh = new THREE.Mesh(this.tree.geometry(node), this.material);
        node.mesh.name = `terrain ${node.level}`;
        node.mesh.matrixAutoUpdate = false;
        this.object.add(node.mesh);
      }
      if (!node.mesh.visible || !this.shown.has(node)) changed = true;
      node.mesh.visible = true;
      triangles += node.mesh.geometry.index!.count / 3;
    }
    this.shown = wanted;
    this.drawn = nodes.length;
    this.triangles = triangles;
    return changed;
  }
}
