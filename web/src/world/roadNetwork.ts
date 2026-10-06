import { type PackedIndex, type TypedArray, loadPacked } from '../data/packed';
import { DATA_URL } from '../manifest';
import type { HeightFn } from './roadGeometry';

/** Index written next to the packed network arrays (pipeline/simnet.py). */
export interface RoadNetworkIndex extends PackedIndex {
  vclassBits: Record<string, number>;
  flags: {
    bridge: number;
    tunnel: number;
    hasOpposite: number;
    roundabout: number;
    internal: number;
  };
  types: string[];
  junctionTypes: string[];
  names: string[];
  tlsTypes: string[];
  linkDirs: string[];
  linkStates: string[];
  none: number;
}

export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'minor'
  | 'service'
  | 'tram'
  | 'rail';

/** Map a SUMO edge type such as "highway.primary_link" or "railway.tram" to a road class. */
export function classifyEdgeType(type: string): RoadClass {
  const parts = type.split('|');
  const highway = parts.find((p) => p.startsWith('highway.'))?.slice('highway.'.length);
  if (!highway) {
    if (parts.some((p) => p === 'railway.tram')) return 'tram';
    return 'rail';
  }
  const base = highway.replace(/_link$/, '');
  switch (base) {
    case 'motorway':
    case 'trunk':
    case 'primary':
    case 'secondary':
    case 'tertiary':
      return base;
    case 'service':
    case 'busway':
      return 'service';
    default:
      return 'minor';
  }
}

/**
 * Decode delta-encoded polylines into (x, z, elevation) triples in scene metres:
 * per polyline an int32 centimetre origin, int16 centimetre steps and int16 centimetre
 * elevations (pipeline/simnet.py encode_polylines).
 */
export function decodePolylines(
  origin: ArrayLike<number>,
  offsets: ArrayLike<number>,
  delta: ArrayLike<number>,
  elev: ArrayLike<number>,
): Float32Array {
  const out = new Float32Array(elev.length * 3);
  for (let i = 0; i < offsets.length - 1; i++) {
    let x = origin[i * 2];
    let z = origin[i * 2 + 1];
    for (let p = offsets[i]; p < offsets[i + 1]; p++) {
      x += delta[p * 2];
      z += delta[p * 2 + 1];
      out[p * 3] = x / 100;
      out[p * 3 + 1] = z / 100;
      out[p * 3 + 2] = elev[p] / 100;
    }
  }
  return out;
}

/**
 * The lane-level road network in scene coordinates: normal lanes, the internal lanes
 * that cross junctions, the links between them, right-of-way and traffic lights.
 * Shapes are (x, z, elevation offset) triples; the offset lifts bridges and ramps.
 */
export class RoadNetwork {
  readonly junctionPos: Float32Array;
  readonly junctionType: Uint8Array;
  readonly junctionShapeOffsets: Uint32Array;
  readonly junctionShape: Float32Array;
  readonly edgeFrom: Uint32Array;
  readonly edgeTo: Uint32Array;
  readonly edgeType: Uint16Array;
  readonly edgeFlags: Uint8Array;
  readonly edgeName: Uint32Array;
  readonly edgeLaneStart: Uint32Array;
  readonly edgeLaneCount: Uint8Array;
  readonly laneEdge: Uint32Array;
  readonly laneLength: Float32Array;
  readonly laneSpeed: Float32Array;
  readonly laneWidth: Float32Array;
  readonly laneAllow: Uint16Array;
  readonly laneShapeOffsets: Uint32Array;
  readonly laneShape: Float32Array;
  /** Road class per edge. */
  readonly edgeClass: RoadClass[];

  constructor(
    readonly index: RoadNetworkIndex,
    /** All packed arrays, as loaded (the traffic engine takes them as they are). */
    readonly arrays: Record<string, TypedArray>,
  ) {
    this.junctionPos = arrays.junctionPos as Float32Array;
    this.junctionType = arrays.junctionType as Uint8Array;
    this.junctionShapeOffsets = arrays.junctionShapeOffsets as Uint32Array;
    this.junctionShape = decodePolylines(
      arrays.junctionShapeOrigin,
      arrays.junctionShapeOffsets,
      arrays.junctionShapeDelta,
      arrays.junctionShapeElev,
    );
    this.edgeFrom = arrays.edgeFrom as Uint32Array;
    this.edgeTo = arrays.edgeTo as Uint32Array;
    this.edgeType = arrays.edgeType as Uint16Array;
    this.edgeFlags = arrays.edgeFlags as Uint8Array;
    this.edgeName = arrays.edgeName as Uint32Array;
    this.edgeLaneStart = arrays.edgeLaneStart as Uint32Array;
    this.edgeLaneCount = arrays.edgeLaneCount as Uint8Array;
    this.laneEdge = arrays.laneEdge as Uint32Array;
    this.laneLength = arrays.laneLength as Float32Array;
    this.laneSpeed = arrays.laneSpeed as Float32Array;
    this.laneWidth = arrays.laneWidth as Float32Array;
    this.laneAllow = arrays.laneAllow as Uint16Array;
    this.laneShapeOffsets = arrays.laneShapeOffsets as Uint32Array;
    this.laneShape = decodePolylines(
      arrays.laneShapeOrigin,
      arrays.laneShapeOffsets,
      arrays.laneShapeDelta,
      arrays.laneShapeElev,
    );

    const typeClass = index.types.map(classifyEdgeType);
    this.edgeClass = Array.from(this.edgeType, (t) => typeClass[t]);
  }

  get edgeCount(): number {
    return this.edgeType.length;
  }

  get laneCount(): number {
    return this.laneWidth.length;
  }

  get junctionCount(): number {
    return this.junctionType.length;
  }

  hasFlag(edge: number, flag: keyof RoadNetworkIndex['flags']): boolean {
    return (this.edgeFlags[edge] & this.index.flags[flag]) !== 0;
  }

  /** Lanes inside junctions are drawn by the junction surface, not as roads. */
  isInternal(edge: number): boolean {
    return this.hasFlag(edge, 'internal');
  }

  allows(lane: number, vclass: string): boolean {
    return (this.laneAllow[lane] & (this.index.vclassBits[vclass] ?? 0)) !== 0;
  }

  /** Street name of an edge, if it has one. */
  nameOf(edge: number): string | undefined {
    const i = this.edgeName[edge];
    return i === this.index.none ? undefined : this.index.names[i];
  }

  /** Shape points of a lane; point k is at laneShape[(start + k) * 3]. */
  lanePoints(lane: number): { start: number; count: number } {
    const start = this.laneShapeOffsets[lane];
    return { start, count: this.laneShapeOffsets[lane + 1] - start };
  }

  junctionPoints(junction: number): { start: number; count: number } {
    const start = this.junctionShapeOffsets[junction];
    return { start, count: this.junctionShapeOffsets[junction + 1] - start };
  }
}

/**
 * Heights the traffic engine draws vehicles at, per lane shape point: absolute on bridges
 * (straight between the ground at the bridge ends, as the road renderer draws them) and
 * the elevation offset above the ground elsewhere (the renderer adds the ground).
 */
export function laneShapeHeights(net: RoadNetwork, height: HeightFn): Float32Array {
  const shape = net.laneShape;
  const out = new Float32Array(shape.length / 3);
  for (let p = 0; p < out.length; p++) out[p] = shape[p * 3 + 2];
  for (let lane = 0; lane < net.laneCount; lane++) {
    if (!net.hasFlag(net.laneEdge[lane], 'bridge')) continue;
    const { start, count } = net.lanePoints(lane);
    if (count < 2) continue;
    const end = start + count - 1;
    const h0 = height(shape[start * 3], shape[start * 3 + 1]);
    const h1 = height(shape[end * 3], shape[end * 3 + 1]);
    let total = 0;
    for (let p = start + 1; p <= end; p++) {
      total += Math.hypot(shape[p * 3] - shape[p * 3 - 3], shape[p * 3 + 1] - shape[p * 3 - 2]);
    }
    let travelled = 0;
    for (let p = start; p <= end; p++) {
      if (p > start) {
        travelled += Math.hypot(
          shape[p * 3] - shape[p * 3 - 3],
          shape[p * 3 + 1] - shape[p * 3 - 2],
        );
      }
      const ground = total > 0 ? h0 + (h1 - h0) * (travelled / total) : h0;
      out[p] = ground + shape[p * 3 + 2];
    }
  }
  return out;
}

export async function loadRoadNetwork(indexFile: string): Promise<RoadNetwork> {
  const response = await fetch(DATA_URL + indexFile);
  if (!response.ok) throw new Error(`Could not load ${indexFile} (HTTP ${response.status})`);
  const index = (await response.json()) as RoadNetworkIndex;
  const folder = indexFile.slice(0, indexFile.lastIndexOf('/') + 1);
  const arrays = await loadPacked(DATA_URL + folder + index.file, index);
  return new RoadNetwork(index, arrays);
}
