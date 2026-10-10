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

export interface NetworkLayer {
  /** Path of the road network index (JSON) relative to the data folder. */
  index: string;
  counts: {
    junctions: number;
    edges: number;
    lanes: number;
    trafficLights: number;
    roadKm: number;
  };
  attribution: Attribution;
}

export interface BuildingsLayer {
  index: string;
  counts: { buildings: number; zg3d: number; measuredHeights: number };
  attribution: Attribution[];
}

/** Where people live and work, per street edge (pipeline/demand.py). */
export interface DemandLayer {
  index: string;
  residents: number;
  residentsInCity: number;
  jobs: number;
  edges: number;
  /** Car trips per weekday the residents make. */
  dailyCarTrips: number;
  /** Places where roads leave the map, and vehicles crossing there per day. */
  gateways?: number;
  gatewayDaily?: number;
  /** Share of this demand the simulation runs (calibration, docs/VALIDATION.md). */
  demandScale?: number;
  attribution?: Attribution | Attribution[];
}

/** ZET trams and buses and HŽ trains, a weekday's timetable placed on the network
 * (pipeline/transit.py). */
export interface TransitLayer {
  index: string;
  serviceDate: string;
  trips: number;
  tramTrips: number;
  busTrips: number;
  trainTrips?: number;
  attribution?: Attribution | Attribution[];
}

/** Pedestrian crossings on the drivable roads, with pedestrians a day (pipeline/pedestrians.py). */
export interface PedestriansLayer {
  index: string;
  crossings: number;
  pedestriansDaily: number;
  attribution?: Attribution | Attribution[];
}

/** Roads with a cycle track or lane, and bike trips (pipeline/cycling.py). */
export interface CyclingLayer {
  index: string;
  bikeTripsDaily: number;
  attribution?: Attribution | Attribution[];
}

/** Places the news reported traffic trouble at (pipeline/news.py). */
export interface NewsLayerInfo {
  index: string;
  hotspots: number;
  reports: number;
  attribution?: Attribution;
}

/** Planned road projects, each with a road network of its own (pipeline/projects.py). */
export interface ProjectsLayerInfo {
  /** Path of the projects index (JSON) relative to the data folder. */
  index: string;
  projects: { id: string; name: string }[];
  attribution?: Attribution;
}

/** Lots for zoning and the City's planned land use (pipeline/zoning.py). */
export interface ZoningLayerInfo {
  index: string;
  lots: number;
  attribution?: Attribution;
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
    network?: NetworkLayer;
    buildings?: BuildingsLayer;
    demand?: DemandLayer;
    transit?: TransitLayer;
    pedestrians?: PedestriansLayer;
    cycling?: CyclingLayer;
    news?: NewsLayerInfo;
    projects?: ProjectsLayerInfo;
    zoning?: ZoningLayerInfo;
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

/** Every source credited by the loaded layers, each once. */
export function attributions(manifest: WorldManifest): Attribution[] {
  const all = Object.values(manifest.layers).flatMap((layer) =>
    layer?.attribution ? ([] as Attribution[]).concat(layer.attribution) : [],
  );
  return all.filter((a, i) => all.findIndex((b) => b.name === a.name) === i);
}
