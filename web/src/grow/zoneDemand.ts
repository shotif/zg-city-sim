/**
 * Demand per zone (M5d): whether the city wants more homes, shops or workplaces, from -1
 * (none) to 1 (strongly), and how fast zoned lots of each kind start building.
 *
 * Today's map holds about 0.5 jobs per resident (pipeline/demand.py: 509,950 jobs and
 * 1,018,646 residents). What grows is compared with that:
 * - homes are wanted where jobs grew more than the residents to fill them;
 * - shops where residents grew beyond the shops serving them (about 0.08 shop jobs per
 *   resident: retail is about a sixth of Croatia's employment);
 * - offices and industry where residents grew beyond the other jobs.
 *
 * Each starts from a base demand set by hand for Zagreb today: flats are scarce and dear,
 * so homes are wanted most. Where it builds first follows land value, which follows the
 * travel times the simulation measures (grow/landValue.ts).
 */
import { ARCHETYPES, type Growth, finished, occupants } from './growth';
import { ZONES, type ZoneId } from './zones';

export interface ZoneDemand {
  homes: number;
  shops: number;
  work: number;
}

export const BASE_DEMAND: ZoneDemand = { homes: 0.4, shops: 0.2, work: 0.3 };
export const SHOP_JOBS_PER_RESIDENT = 0.08;
/** People (residents or jobs) out of balance that move demand by 1. */
const SWING = 2000;
const SHOP_SWING = 400;

/** Residents, shop jobs and other jobs in the finished buildings grown. */
export function grownPeople(
  growth: Growth,
  now: number,
): { residents: number; shopJobs: number; workJobs: number } {
  let [residents, shopJobs, workJobs] = [0, 0, 0];
  for (const b of growth.buildings) {
    if (!b || !finished(b, now)) continue;
    const o = occupants(b);
    residents += o.residents;
    const zone = ARCHETYPES[b.archetype].zone;
    if (zone === 'shops' || zone === 'mixed') shopJobs += o.jobs;
    else workJobs += o.jobs;
  }
  return { residents, shopJobs, workJobs };
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** Demand for each kind of zone, given what has grown and today's jobs per resident. */
export function zoneDemand(
  grown: { residents: number; shopJobs: number; workJobs: number },
  jobsPerResident: number,
): ZoneDemand {
  const { residents, shopJobs, workJobs } = grown;
  const jobs = shopJobs + workJobs;
  const otherPerResident = Math.max(0, jobsPerResident - SHOP_JOBS_PER_RESIDENT);
  return {
    homes: clamp(BASE_DEMAND.homes + (jobs - residents * jobsPerResident) / SWING),
    shops: clamp(BASE_DEMAND.shops + (residents * SHOP_JOBS_PER_RESIDENT - shopJobs) / SHOP_SWING),
    work: clamp(BASE_DEMAND.work + (residents * otherPerResident - workJobs) / SWING),
  };
}

/** The demand a zone's lots answer to (mixed: homes and shops alike). */
export function demandFor(zone: ZoneId, d: ZoneDemand): number {
  switch (zone) {
    case 'houses':
    case 'lowrise':
    case 'highrise':
      return d.homes;
    case 'mixed':
      return (d.homes + d.shops) / 2;
    case 'shops':
      return d.shops;
    case 'offices':
    case 'industry':
      return d.work;
  }
}

/** How much faster than the base rate a zone's lots start building: none at demand -1,
 * the base rate at 0, twice it at 1. Per zone code (index 0: no zone). */
export function startRates(d: ZoneDemand): number[] {
  return [0, ...ZONES.map((z) => Math.max(0, 1 + demandFor(z.id, d)))];
}
