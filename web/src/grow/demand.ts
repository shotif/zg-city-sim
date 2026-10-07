/**
 * Growth makes trips (M5c): the residents and jobs of buildings grown on zoned lots, added
 * to the city's on the streets their lots face, for the traffic engine.
 *
 * The engine's demand is per edge (pipeline/demand.py): `demandHome` is a weight of trips
 * from home, residents counted at the City's car trip rate (0.65 car trips a day each) and
 * those in the counties around at theirs (0.87), and `demandWork` is jobs. Car trips a day
 * follow the homes; jobs draw trips, also from beyond the map.
 */
import type { TypedArray } from '../data/packed';
import { type Growth, finished, occupants } from './growth';
import type { Lots } from './lots';

/** Car trips a day per resident of the City, and the counties' rate as a weight of it
 * (pipeline/demand.py CAR_TRIP_RATE). Lots outside the City have no plan. */
export const CAR_TRIPS_PER_RESIDENT = 0.6511;
export const COUNTY_WEIGHT = 0.8668 / 0.6511;

/** Homes (trip weight) and jobs per edge. */
export type EdgeDemand = Map<number, { home: number; work: number }>;

/** What the finished buildings add, per edge (`edgeOf`: the edge a lot's trips use, -1 for
 * none). */
export function addedDemand(
  lots: Lots,
  growth: Growth,
  now: number,
  edgeOf: (lot: number) => number = (i) => lots.edge[i],
): EdgeDemand {
  const out: EdgeDemand = new Map();
  for (const b of growth.buildings) {
    if (!b || !finished(b, now)) continue;
    const lot = b.lots[0];
    const edge = edgeOf(lot);
    if (edge < 0) continue;
    const o = occupants(b);
    const weight = lots.plan[lot] === lots.noPlan ? COUNTY_WEIGHT : 1;
    const entry = out.get(edge) ?? { home: 0, work: 0 };
    entry.home += o.residents * weight;
    entry.work += o.jobs;
    out.set(edge, entry);
  }
  return out;
}

export interface DemandArrays {
  arrays: { demandEdge: Uint32Array; demandHome: Float32Array; demandWork: Float32Array };
  /** Car trips a day the homes make (at demand scale 1). */
  dailyTrips: number;
}

/** The city's demand with `added` on top, and the car trips a day it makes. */
export function mergeDemand(
  base: Record<string, TypedArray>,
  baseDaily: number,
  added: EdgeDemand,
): DemandArrays {
  const edges = base.demandEdge as Uint32Array;
  const home = Float32Array.from(base.demandHome as Float32Array);
  const work = Float32Array.from(base.demandWork as Float32Array);
  const at = new Map<number, number>();
  edges.forEach((e, k) => at.set(e, k));
  const extraEdges: number[] = [];
  const extraHome: number[] = [];
  const extraWork: number[] = [];
  let homes = 0;
  for (const [edge, d] of added) {
    homes += d.home;
    const k = at.get(edge);
    if (k !== undefined) {
      home[k] += d.home;
      work[k] += d.work;
    } else {
      extraEdges.push(edge);
      extraHome.push(d.home);
      extraWork.push(d.work);
    }
  }
  const join = <T extends Uint32Array | Float32Array>(
    a: T,
    extra: number[],
    make: (n: number) => T,
  ) => {
    const out = make(a.length + extra.length);
    out.set(a);
    out.set(extra, a.length);
    return out;
  };
  return {
    arrays: {
      demandEdge: join(edges, extraEdges, (n) => new Uint32Array(n)),
      demandHome: join(home, extraHome, (n) => new Float32Array(n)),
      demandWork: join(work, extraWork, (n) => new Float32Array(n)),
    },
    dailyTrips: baseDaily + homes * CAR_TRIPS_PER_RESIDENT,
  };
}
