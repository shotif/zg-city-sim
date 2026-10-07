import * as THREE from 'three/webgpu';

/** Height of the ground at scene (x, z). */
export type HeightFn = (x: number, z: number) => number;

/** Collects an indexed, vertex-coloured triangle mesh. */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(x: number, y: number, z: number, color: THREE.Color): number {
    this.positions.push(x, y, z);
    this.colors.push(color.r, color.g, color.b);
    return this.vertexCount - 1;
  }

  /** Add a triangle, flipping it if needed so it faces up. */
  triUp(a: number, b: number, c: number): void {
    const p = this.positions;
    const abx = p[b * 3] - p[a * 3];
    const abz = p[b * 3 + 2] - p[a * 3 + 2];
    const acx = p[c * 3] - p[a * 3];
    const acz = p[c * 3 + 2] - p[a * 3 + 2];
    if (abz * acx - abx * acz >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const count = this.vertexCount;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    const normals = new Float32Array(count * 3);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/**
 * Densify a shape of (x, z, elevation offset) triples to at most `maxStep` metres between
 * points and lift it onto the ground. Bridges span straight between the ground at their ends.
 * Returns (x, y, z) triples.
 */
export function groundPath(
  shape: ArrayLike<number>,
  start: number,
  count: number,
  height: HeightFn,
  options: { maxStep?: number; bridge?: boolean; lift?: number } = {},
): Float32Array {
  const maxStep = options.maxStep ?? 25;
  const lift = options.lift ?? 0;
  const pts: number[] = []; // x, z, dz
  for (let k = 0; k < count; k++) {
    const i = (start + k) * 3;
    const x = shape[i];
    const z = shape[i + 1];
    const dz = shape[i + 2];
    if (k > 0) {
      const px = pts[pts.length - 3];
      const pz = pts[pts.length - 2];
      const pdz = pts[pts.length - 1];
      const length = Math.hypot(x - px, z - pz);
      if (length < 1e-3) continue;
      const steps = Math.ceil(length / maxStep);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        pts.push(px + (x - px) * t, pz + (z - pz) * t, pdz + (dz - pdz) * t);
      }
    }
    pts.push(x, z, dz);
  }

  const n = pts.length / 3;
  const out = new Float32Array(n * 3);
  let h0 = 0;
  let h1 = 0;
  let total = 0;
  if (options.bridge && n > 1) {
    h0 = height(pts[0], pts[1]);
    h1 = height(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1]);
    for (let k = 1; k < n; k++) {
      total += Math.hypot(pts[k * 3] - pts[k * 3 - 3], pts[k * 3 + 1] - pts[k * 3 - 2]);
    }
  }
  let travelled = 0;
  for (let k = 0; k < n; k++) {
    const x = pts[k * 3];
    const z = pts[k * 3 + 1];
    if (k > 0) travelled += Math.hypot(x - pts[k * 3 - 3], z - pts[k * 3 - 2]);
    const ground =
      options.bridge && total > 0 ? h0 + (h1 - h0) * (travelled / total) : height(x, z);
    out[k * 3] = x;
    out[k * 3 + 1] = ground + pts[k * 3 + 2] + lift;
    out[k * 3 + 2] = z;
  }
  return out;
}

/** Cumulative distance along an (x, y, z) path, measured in the horizontal plane. */
export function pathDistances(path: Float32Array): Float32Array {
  const n = path.length / 3;
  const d = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    d[k] = d[k - 1] + Math.hypot(path[k * 3] - path[k * 3 - 3], path[k * 3 + 2] - path[k * 3 - 1]);
  }
  return d;
}

/** The part of a path between distances d0 and d1. */
export function slicePath(
  path: Float32Array,
  dist: Float32Array,
  d0: number,
  d1: number,
): Float32Array {
  const n = dist.length;
  const out: number[] = [];
  const at = (d: number) => {
    let k = 1;
    while (k < n - 1 && dist[k] < d) k++;
    const span = dist[k] - dist[k - 1];
    const t = span > 0 ? Math.min(1, Math.max(0, (d - dist[k - 1]) / span)) : 0;
    for (let c = 0; c < 3; c++)
      out.push(path[(k - 1) * 3 + c] + (path[k * 3 + c] - path[(k - 1) * 3 + c]) * t);
  };
  at(d0);
  for (let k = 0; k < n; k++) {
    if (dist[k] > d0 && dist[k] < d1) out.push(path[k * 3], path[k * 3 + 1], path[k * 3 + 2]);
  }
  at(d1);
  return new Float32Array(out);
}

/**
 * A flat strip along an (x, y, z) path: `offset` shifts it sideways (positive = left of the
 * direction of travel), `lift` raises it.
 */
export function addRibbon(
  b: MeshBuilder,
  path: Float32Array,
  halfWidth: number,
  color: THREE.Color,
  offset = 0,
  lift = 0,
): void {
  const n = path.length / 3;
  if (n < 2) return;
  let prevLeft = -1;
  let prevRight = -1;
  for (let i = 0; i < n; i++) {
    const x = path[i * 3];
    const y = path[i * 3 + 1] + lift;
    const z = path[i * 3 + 2];
    let inX = 0;
    let inZ = 0;
    let outX = 0;
    let outZ = 0;
    if (i > 0) {
      const dx = x - path[i * 3 - 3];
      const dz = z - path[i * 3 - 1];
      const len = Math.hypot(dx, dz) || 1;
      inX = dx / len;
      inZ = dz / len;
    }
    if (i < n - 1) {
      const dx = path[i * 3 + 3] - x;
      const dz = path[i * 3 + 5] - z;
      const len = Math.hypot(dx, dz) || 1;
      outX = dx / len;
      outZ = dz / len;
    }
    if (i === 0) {
      inX = outX;
      inZ = outZ;
    }
    if (i === n - 1) {
      outX = inX;
      outZ = inZ;
    }
    let mx = inX + outX;
    let mz = inZ + outZ;
    const mlen = Math.hypot(mx, mz);
    if (mlen < 1e-6) {
      mx = inX;
      mz = inZ;
    } else {
      mx /= mlen;
      mz /= mlen;
    }
    // Miter: keep the strip's width constant through bends (capped at sharp corners).
    const miter = 1 / Math.max(0.35, mx * inX + mz * inZ);
    const leftX = mz; // left of travel is (dz, -dx)
    const leftZ = -mx;
    const l = (offset + halfWidth) * miter;
    const r = (offset - halfWidth) * miter;
    const vl = b.vertex(x + leftX * l, y, z + leftZ * l, color);
    const vr = b.vertex(x + leftX * r, y, z + leftZ * r, color);
    if (i > 0) {
      b.triUp(prevLeft, prevRight, vl);
      b.triUp(prevRight, vr, vl);
    }
    prevLeft = vl;
    prevRight = vr;
  }
}

/** Dashes of `dash` metres every `period` metres along a path. */
export function addDashes(
  b: MeshBuilder,
  path: Float32Array,
  halfWidth: number,
  color: THREE.Color,
  offset: number,
  lift: number,
  dash: number,
  period: number,
): void {
  const dist = pathDistances(path);
  const total = dist[dist.length - 1];
  for (let d = (total % period) / 2; d + dash <= total; d += period) {
    addRibbon(b, slicePath(path, dist, d, d + dash), halfWidth, color, offset, lift);
  }
}

/** Fill a closed ring of (x, y, z) points. */
export function addPolygon(b: MeshBuilder, ring: Float32Array, color: THREE.Color): void {
  let n = ring.length / 3;
  if (
    n > 3 &&
    ring[0] === ring[(n - 1) * 3] &&
    ring[1] === ring[(n - 1) * 3 + 1] &&
    ring[2] === ring[(n - 1) * 3 + 2]
  ) {
    n -= 1; // drop the closing duplicate
  }
  if (n < 3) return;
  const contour: THREE.Vector2[] = [];
  const base = b.vertexCount;
  for (let i = 0; i < n; i++) {
    contour.push(new THREE.Vector2(ring[i * 3], ring[i * 3 + 2]));
    b.vertex(ring[i * 3], ring[i * 3 + 1], ring[i * 3 + 2], color);
  }
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    b.triUp(base + i, base + j, base + k);
  }
}

/**
 * Douglas-Peucker: the indices of the points of a polyline (x, z pairs) to keep so that
 * none left out is further than `tolerance` (m) from the line kept; the ends always stay.
 */
export function simplify(xz: ArrayLike<number>, tolerance: number): number[] {
  const n = xz.length / 2;
  if (n <= 2) return n === 2 ? [0, 1] : n === 1 ? [0] : [];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, az, bx, bz] = [xz[a * 2], xz[a * 2 + 1], xz[b * 2], xz[b * 2 + 1]];
    const len = Math.hypot(bx - ax, bz - az);
    let far = tolerance;
    let best = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = [xz[i * 2], xz[i * 2 + 1]];
      const d =
        len > 1e-9
          ? Math.abs((bx - ax) * (az - pz) - (ax - px) * (bz - az)) / len
          : Math.hypot(px - ax, pz - az);
      if (d > far) {
        far = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}
