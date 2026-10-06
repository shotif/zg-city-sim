/** Decode Mapbox Terrain-RGB pixels (RGBA, 4 bytes each) into heights in metres. */
export function decodeTerrainRgb(rgba: ArrayLike<number>, pixelCount: number): Float32Array {
  const heights = new Float32Array(pixelCount);
  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    heights[i] = -10000 + (rgba[p] * 65536 + rgba[p + 1] * 256 + rgba[p + 2]) * 0.1;
  }
  return heights;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Heights on a regular grid in scene space. Row 0 is the northern edge and rows run south
 * (+z); samples sit at cell centres.
 */
export class Heightfield {
  constructor(
    readonly heights: Float32Array,
    readonly cols: number,
    readonly rows: number,
    /** Metres between samples. */
    readonly resolution: number,
    /** Scene x of the grid's western edge. */
    readonly west: number,
    /** Scene z of the grid's northern edge. */
    readonly north: number,
  ) {
    if (heights.length !== cols * rows) {
      throw new Error(`heightfield has ${heights.length} samples, expected ${cols}x${rows}`);
    }
  }

  /** Height of a grid sample; indices outside the grid are clamped to the edge. */
  at(col: number, row: number): number {
    const c = clamp(col, 0, this.cols - 1);
    const r = clamp(row, 0, this.rows - 1);
    return this.heights[r * this.cols + c];
  }

  /** Bilinearly interpolated height at scene (x, z), clamped to the grid. */
  sample(x: number, z: number): number {
    const fc = clamp((x - this.west) / this.resolution - 0.5, 0, this.cols - 1);
    const fr = clamp((z - this.north) / this.resolution - 0.5, 0, this.rows - 1);
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const tx = fc - c0;
    const tz = fr - r0;
    const h00 = this.at(c0, r0);
    const h10 = this.at(c0 + 1, r0);
    const h01 = this.at(c0, r0 + 1);
    const h11 = this.at(c0 + 1, r0 + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
}
