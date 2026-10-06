/** Types and loader for `data/manifest.json`, written by the data pipeline (pipeline/manifest.py). */

export interface Attribution {
  name: string;
  text: string;
  url: string;
}

export interface TerrainLayer {
  file: string;
  width: number;
  height: number;
  /** Metres between height samples. */
  resolution: number;
  encoding: 'terrain-rgb';
  minHeight: number;
  maxHeight: number;
  attribution: Attribution;
}

export interface GroundLayer {
  file: string;
  width: number;
  height: number;
  resolution: number;
  classShare?: Record<string, number>;
  attribution: Attribution;
}

export interface WorldManifest {
  version: number;
  generated: string;
  /** Projected CRS of all world coordinates (EPSG:3765, HTRS96/TM). */
  crs: string;
  /** Scene origin, Trg bana Jelačića. */
  origin: { e: number; n: number; lon: number; lat: number };
  extent: { minE: number; minN: number; maxE: number; maxN: number };
  layers: {
    terrain?: TerrainLayer;
    ground?: GroundLayer;
  };
}

export const DATA_URL = `${import.meta.env.BASE_URL}data/`;

export async function loadManifest(): Promise<WorldManifest> {
  const response = await fetch(`${DATA_URL}manifest.json`);
  if (!response.ok) {
    throw new Error(
      `Could not load the city data (manifest.json: HTTP ${response.status}). ` +
        'Run `python -m pipeline all` to build it.',
    );
  }
  const manifest = (await response.json()) as WorldManifest;
  if (manifest.version !== 1) {
    throw new Error(`Unsupported data version ${manifest.version}`);
  }
  return manifest;
}

export function attributions(manifest: WorldManifest): Attribution[] {
  return Object.values(manifest.layers)
    .map((layer) => layer?.attribution)
    .filter((a): a is Attribution => a !== undefined);
}
