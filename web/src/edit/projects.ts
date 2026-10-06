/**
 * Planned road projects (M4c): each a road network of its own, built by the data pipeline
 * (pipeline/projects.py) from OpenStreetMap with the project's roads open, with demand and
 * the timetable placed on it. The app runs a project's network in place of today's.
 */
import type { DemandLayer, NetworkLayer, NewsLayerInfo, TransitLayer } from '../manifest';
import type { CompareRow } from './compare';
import type { RoadIndex } from './roadIndex';

/** A pair of places and the travel time by car between them (s). */
export interface ProjectTravelPair {
  from: string;
  to: string;
  today: number;
  project: number;
}

export interface ProjectTotals {
  delayHours: number;
  vehicleKm: number;
  arrived: number;
  tripMinutes: number;
}

/** Before and after numbers, from native runs of both networks through the morning peak
 * (sim/examples/compare.rs). */
export interface ProjectComparison {
  /** Date the runs were made. */
  computed: string;
  fromHour: number;
  hours: number;
  demandScale: number;
  totals: { today: ProjectTotals; project: ProjectTotals };
  travel: {
    /** Mean relative change of the travel times between the places at each hour's end. */
    perHour: { hour: number; mean: number }[];
    /** The same over the hours' mean times, and the pairs that changed most on them. */
    mean: number;
    faster: ProjectTravelPair[];
    slower: ProjectTravelPair[];
  };
  /** Named main roads whose traffic changes most (vehicle-km over the hours). */
  roads: { name: string; today: number; project: number }[];
  /** How much two runs of today's roads with other random trips differ: relative delay,
   * and mean relative difference of the travel times. Changes smaller are noise. */
  noise: { delay: number; travel: number } | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  status: string;
  summary: string;
  sources: { title: string; url: string }[];
  layers: {
    network: NetworkLayer;
    demand?: DemandLayer;
    transit?: TransitLayer;
    news?: NewsLayerInfo;
  };
  /** Edges of the project's network that today's network does not have, and their middle
   * (scene x, z). */
  newEdges: number[];
  centre: [number, number];
  comparison: ProjectComparison | null;
}

/** The projects the data was built with. */
export async function loadProjects(url: string): Promise<ProjectInfo[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ((await response.json()) as { projects: ProjectInfo[] }).projects;
}

/** The page's address showing a project (undefined: today's roads), keeping the rest. */
export function projectUrl(href: string, id: string | undefined): string {
  const url = new URL(href);
  if (id) url.searchParams.set('project', id);
  else url.searchParams.delete('project');
  return url.href;
}

/** The numbers of a project's comparison, as rows of the before and after table. */
export function comparisonRows(c: ProjectComparison): CompareRow[] {
  const { today, project } = c.totals;
  return [
    {
      label: 'Delay',
      today: today.delayHours,
      edited: project.delayHours,
      unit: 'vehicle-hours',
      moreIsBetter: false,
      digits: 0,
    },
    {
      label: 'Mean trip',
      today: today.tripMinutes,
      edited: project.tripMinutes,
      unit: 'min',
      moreIsBetter: false,
      digits: 1,
    },
    {
      label: 'Driven',
      today: today.vehicleKm,
      edited: project.vehicleKm,
      unit: 'km',
      moreIsBetter: false,
      digits: 0,
    },
    {
      label: 'Trips finished',
      today: today.arrived,
      edited: project.arrived,
      unit: '',
      moreIsBetter: true,
      digits: 0,
    },
  ];
}

/** For each edge of one build of the network, the same road on another (-1: none), by
 * its middle and heading. */
export function edgeMap(from: RoadIndex, to: RoadIndex): Int32Array {
  const out = new Int32Array(from.net.edgeCount).fill(-1);
  for (let e = 0; e < out.length; e++) {
    if (!from.editable(e)) continue;
    out[e] = to.find(from.ref(e)) ?? -1;
  }
  return out;
}

/** Counts per edge of another network read onto this one's edges through `map` (an edge of
 * this network to the same road on the other, as from `edgeMap`); 0 where there is none. */
export function pullCounts(counts: ArrayLike<number>, map: Int32Array): Float64Array {
  const out = new Float64Array(map.length);
  for (let e = 0; e < map.length; e++) {
    if (map[e] >= 0) out[e] = counts[map[e]];
  }
  return out;
}
