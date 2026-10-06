import { type PackedIndex, loadPacked } from '../data/packed';
import { DATA_URL } from '../manifest';

/** Index written next to the packed road arrays (pipeline/network.py). */
export interface RoadNetworkIndex extends PackedIndex {
  pointStride: number;
  vclassBits: Record<string, number>;
  flags: { bridge: number; tunnel: number; hasOpposite: number; roundabout: number };
  types: string[];
  junctionTypes: string[];
  names: string[];
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
 * The lane-level road network in scene coordinates. Shapes are (x, z, elevation offset)
 * triples; the elevation offset lifts bridges and ramps above the terrain.
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
  readonly edgeSpeed: Float32Array;
  readonly edgeName: Uint32Array;
  readonly edgeLaneStart: Uint32Array;
  readonly edgeLaneCount: Uint8Array;
  readonly laneWidth: Float32Array;
  readonly laneAllow: Uint16Array;
  readonly laneShapeOffsets: Uint32Array;
  readonly laneShape: Float32Array;
  /** Road class per edge. */
  readonly edgeClass: RoadClass[];
  /** Edge index of every lane. */
  readonly laneEdge: Uint32Array;

  constructor(
    readonly index: RoadNetworkIndex,
    arrays: Record<string, ArrayLike<number>>,
  ) {
    this.junctionPos = arrays.junctionPos as Float32Array;
    this.junctionType = arrays.junctionType as Uint8Array;
    this.junctionShapeOffsets = arrays.junctionShapeOffsets as Uint32Array;
    this.junctionShape = arrays.junctionShape as Float32Array;
    this.edgeFrom = arrays.edgeFrom as Uint32Array;
    this.edgeTo = arrays.edgeTo as Uint32Array;
    this.edgeType = arrays.edgeType as Uint16Array;
    this.edgeFlags = arrays.edgeFlags as Uint8Array;
    this.edgeSpeed = arrays.edgeSpeed as Float32Array;
    this.edgeName = arrays.edgeName as Uint32Array;
    this.edgeLaneStart = arrays.edgeLaneStart as Uint32Array;
    this.edgeLaneCount = arrays.edgeLaneCount as Uint8Array;
    this.laneWidth = arrays.laneWidth as Float32Array;
    this.laneAllow = arrays.laneAllow as Uint16Array;
    this.laneShapeOffsets = arrays.laneShapeOffsets as Uint32Array;
    this.laneShape = arrays.laneShape as Float32Array;

    const typeClass = index.types.map(classifyEdgeType);
    this.edgeClass = Array.from(this.edgeType, (t) => typeClass[t]);
    this.laneEdge = new Uint32Array(this.laneWidth.length);
    for (let e = 0; e < this.edgeCount; e++) {
      const start = this.edgeLaneStart[e];
      this.laneEdge.fill(e, start, start + this.edgeLaneCount[e]);
    }
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

  allows(lane: number, vclass: string): boolean {
    return (this.laneAllow[lane] & (this.index.vclassBits[vclass] ?? 0)) !== 0;
  }

  /** Street name of an edge, if it has one. */
  nameOf(edge: number): string | undefined {
    const i = this.edgeName[edge];
    return i === 0xffffffff ? undefined : this.index.names[i];
  }

  /** Number of shape points of a lane; point k is at laneShape[(start + k) * 3]. */
  lanePoints(lane: number): { start: number; count: number } {
    const start = this.laneShapeOffsets[lane];
    return { start, count: this.laneShapeOffsets[lane + 1] - start };
  }

  junctionPoints(junction: number): { start: number; count: number } {
    const start = this.junctionShapeOffsets[junction];
    return { start, count: this.junctionShapeOffsets[junction + 1] - start };
  }
}

export async function loadRoadNetwork(indexFile: string): Promise<RoadNetwork> {
  const response = await fetch(DATA_URL + indexFile);
  if (!response.ok) throw new Error(`Could not load ${indexFile} (HTTP ${response.status})`);
  const index = (await response.json()) as RoadNetworkIndex;
  const folder = indexFile.slice(0, indexFile.lastIndexOf('/') + 1);
  const arrays = await loadPacked(DATA_URL + folder + index.file, index);
  return new RoadNetwork(index, arrays);
}
