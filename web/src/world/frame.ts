import type { WorldManifest } from '../manifest';

export interface SceneBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Maps HTRS96/TM (EPSG:3765) metres to scene metres.
 * Scene axes: x = east, y = up, z = south (north is -z), origin at Trg bana Jelačića.
 */
export class WorldFrame {
  constructor(
    readonly originE: number,
    readonly originN: number,
    readonly extent: { minE: number; minN: number; maxE: number; maxN: number },
  ) {}

  static fromManifest(manifest: WorldManifest): WorldFrame {
    return new WorldFrame(manifest.origin.e, manifest.origin.n, manifest.extent);
  }

  toSceneX(e: number): number {
    return e - this.originE;
  }

  toSceneZ(n: number): number {
    return this.originN - n;
  }

  toEasting(x: number): number {
    return x + this.originE;
  }

  toNorthing(z: number): number {
    return this.originN - z;
  }

  /** The world extent in scene coordinates. */
  get bounds(): SceneBounds {
    return {
      minX: this.toSceneX(this.extent.minE),
      maxX: this.toSceneX(this.extent.maxE),
      minZ: this.toSceneZ(this.extent.maxN),
      maxZ: this.toSceneZ(this.extent.minN),
    };
  }
}
