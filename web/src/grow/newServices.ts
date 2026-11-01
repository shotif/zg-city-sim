/**
 * New services the player builds (M20c): what each kind takes, costs to build and to run a
 * year, and adds to the traffic. All estimates (docs/DATA_SOURCES.md, M20c):
 *
 * - A primary school for 600 pupils: €18 million, as the City's new schools (Horvati €14.9
 *   million, Lanište €16.9 million, Kušlana €19.7 million, Čulinec €26.4 million); €0.8
 *   million a year for upkeep, heating and materials (teachers are the state's).
 * - A kindergarten for 200 children: €8 million, as the City's new ones (Lučko €6.5
 *   million, Podbrežje €9 million for 200, Sesvetski Kraljevec about €10 million for 260);
 *   €1.4 million a year, as the City pays its kindergartens' staff.
 * - A health centre's site with six GP teams (10,200 patients): €6 million; €0.3 million a
 *   year (HZZO pays the teams).
 * - A fire station: €4 million (Croatian stations €1-3 million, a city's larger); €3 million
 *   a year for its crews.
 * - A police station: €4 million; nothing a year to the City, as the police are the
 *   state's.
 *
 * Staff are jobs on the street in front, and visitors (pupils driven, parents, patients)
 * count as further jobs: places that draw car trips.
 */
import type { Service, ServiceKind } from '../game/serviceKinds';
import type { EdgeDemand } from './demand';

export interface NewServiceKind {
  places: number;
  build: number;
  upkeep: number;
  /** Staff, as jobs. */
  staff: number;
  /** Visitors' car trips, as jobs that draw as many. */
  visits: number;
}

export const NEW_SERVICE: Record<ServiceKind, NewServiceKind> = {
  school: { places: 600, build: 18_000_000, upkeep: 800_000, staff: 60, visits: 60 },
  kindergarten: { places: 200, build: 8_000_000, upkeep: 1_400_000, staff: 40, visits: 80 },
  health: { places: 6 * 1700, build: 6_000_000, upkeep: 300_000, staff: 40, visits: 150 },
  fire: { places: 0, build: 4_000_000, upkeep: 3_000_000, staff: 60, visits: 0 },
  police: { places: 0, build: 4_000_000, upkeep: 0, staff: 80, visits: 0 },
};

/** A new service as an edit: its kind, name and place (scene x, z). */
export interface ServiceEdit {
  kind: 'service';
  service: ServiceKind;
  name: string;
  x: number;
  z: number;
}

/** The services built, as today's are listed (`edge`: the street in front, -1 if none). */
export function builtServices(
  edits: readonly { kind: string }[],
  edgeAt: (x: number, z: number) => number,
): Service[] {
  return edits
    .filter((e): e is ServiceEdit => e.kind === 'service')
    .map((e) => ({
      kind: e.service,
      name: e.name,
      x: e.x,
      z: e.z,
      edge: edgeAt(e.x, e.z),
      district: -1,
      places: NEW_SERVICE[e.service].places,
    }));
}

/** The jobs the services built add, per street. */
export function serviceDemand(services: readonly Service[]): EdgeDemand {
  const out: EdgeDemand = new Map();
  for (const s of services) {
    if (s.edge < 0) continue;
    const k = NEW_SERVICE[s.kind];
    const entry = out.get(s.edge) ?? { home: 0, work: 0 };
    entry.work += k.staff + k.visits;
    out.set(s.edge, entry);
  }
  return out;
}

/** Two sets of homes and jobs per street, added. */
export function addDemand(a: EdgeDemand | undefined, b: EdgeDemand | undefined): EdgeDemand {
  const out: EdgeDemand = new Map();
  for (const m of [a, b]) {
    for (const [edge, d] of m ?? []) {
      const entry = out.get(edge) ?? { home: 0, work: 0 };
      entry.home += d.home;
      entry.work += d.work;
      out.set(edge, entry);
    }
  }
  return out;
}

/** "New primary school 2": the next name for a new service of a kind. */
export function nextServiceName(
  kind: ServiceKind,
  label: string,
  edits: readonly { kind: string }[],
): string {
  const n = edits.filter((e) => e.kind === 'service' && (e as ServiceEdit).service === kind).length;
  return `New ${label.toLowerCase()} ${n + 1}`;
}
