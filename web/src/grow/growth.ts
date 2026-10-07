/**
 * Buildings that grow on zoned lots (M5b). Each simulated minute some of the zoned lots
 * still empty start building; after a while the building is finished. Neighbouring lots
 * of the same zone on the same side of a street join into plots for larger buildings.
 *
 * Building types follow what Zagreb builds in each zone, with sizes from the city's
 * buildings of that kind (ZG3D): family houses of two or three storeys under tiled roofs,
 * urban villas and blocks of four to six storeys, slabs and towers as in Novi Zagreb,
 * perimeter blocks with shops at street level, shops and retail boxes, office blocks,
 * workshops, halls and warehouses.
 *
 * Residents and jobs come from floor area: 30 m² of a home's floor per resident (Croatia's
 * 2021 census: about 32 m² of dwelling per person, rounded down for new flats), and per job
 * 20 m² in offices, 35 m² in shops and 80-120 m² in industry (typical employment densities
 * by building use; estimates). `NET_AREA` of the gross floor is usable, as in
 * pipeline/demand.py.
 */
import type { Lots } from './lots';
import { type SavedBuilding, type ZoneId, zoneCode } from './zones';

export interface Archetype {
  id: string;
  zone: ZoneId;
  /** Lots its plot takes, one after another along the street. */
  lots: number;
  storeys: [number, number];
  /** Height of a storey (m). */
  storey: number;
  /** Along the street, and back from it (m); width 0: the plot's frontage less a margin. */
  width: [number, number];
  depth: [number, number];
  /** From the lot's front edge to the building (m). */
  setback: [number, number];
  /** Pitched roof height above the eaves (m), 0 for a flat roof. */
  ridge: number;
  walls: number[];
  /** Colour of the ground floor where it differs (shops). */
  ground?: number;
  /** Floor area (m²) per job; homes: residents instead. */
  jobArea?: number;
  homes?: boolean;
  /** Simulated minutes to build. */
  build: number;
  /** How often it is chosen among its zone's types that fit. */
  weight: number;
}

const HOUSE_WALLS = [0xf1ead8, 0xe9dfc4, 0xf3e3b8, 0xe8d3b0, 0xdfe0d8, 0xeee8e0];
const FLAT_WALLS = [0xe6e0d4, 0xd9d4ca, 0xe8dcc6, 0xd5d9dc, 0xe3d2c0, 0xcfd3cf];
const TOWER_WALLS = [0xd6d6d2, 0xc8ccd0, 0xe2ddd2, 0xbcc4c9];
const SHOP_WALLS = [0xd5d3cd, 0xc9ccd0, 0xe4e1da, 0xb9c0c7];
const GLASS = [0x8fa6b8, 0x7f98a8, 0x9db0ba, 0x6f8796];
const HALL_WALLS = [0xc4c4bf, 0xd0cdc4, 0xb8c6d0, 0xd8d6cf];
const SHOPFRONT = 0x5a6670;

export const ARCHETYPES: Archetype[] = [
  { id: 'house', zone: 'houses', lots: 1, storeys: [2, 3], storey: 2.9, width: [9, 12],
    depth: [9, 11], setback: [4, 6], ridge: 3, walls: HOUSE_WALLS, homes: true, build: 30,
    weight: 1 },
  { id: 'villa', zone: 'lowrise', lots: 1, storeys: [3, 4], storey: 3, width: [13, 15],
    depth: [12, 15], setback: [4, 6], ridge: 2.5, walls: FLAT_WALLS, homes: true, build: 50,
    weight: 1 },
  { id: 'block', zone: 'lowrise', lots: 2, storeys: [4, 6], storey: 3, width: [28, 34],
    depth: [12, 14], setback: [4, 7], ridge: 0, walls: FLAT_WALLS, homes: true, build: 60,
    weight: 2 },
  { id: 'point tower', zone: 'highrise', lots: 1, storeys: [8, 11], storey: 3, width: [14, 16],
    depth: [14, 16], setback: [6, 8], ridge: 0, walls: TOWER_WALLS, homes: true, build: 100,
    weight: 1 },
  { id: 'tower', zone: 'highrise', lots: 2, storeys: [12, 19], storey: 3, width: [18, 22],
    depth: [18, 22], setback: [6, 8], ridge: 0, walls: TOWER_WALLS, homes: true, build: 150,
    weight: 1 },
  { id: 'slab', zone: 'highrise', lots: 3, storeys: [9, 13], storey: 3, width: [44, 54],
    depth: [12, 14], setback: [6, 10], ridge: 0, walls: TOWER_WALLS, homes: true, build: 120,
    weight: 2 },
  { id: 'corner block', zone: 'mixed', lots: 1, storeys: [4, 5], storey: 3.1, width: [0, 0],
    depth: [12, 14], setback: [0, 1], ridge: 0, walls: FLAT_WALLS, ground: SHOPFRONT,
    homes: true, jobArea: 35, build: 60, weight: 1 },
  { id: 'perimeter block', zone: 'mixed', lots: 2, storeys: [5, 6], storey: 3.1, width: [0, 0],
    depth: [13, 15], setback: [0, 1], ridge: 0, walls: FLAT_WALLS, ground: SHOPFRONT,
    homes: true, jobArea: 35, build: 75, weight: 2 },
  { id: 'shop', zone: 'shops', lots: 1, storeys: [1, 1], storey: 4.5, width: [12, 16],
    depth: [10, 14], setback: [7, 9], ridge: 0, walls: SHOP_WALLS, jobArea: 35, build: 20,
    weight: 2 },
  { id: 'retail box', zone: 'shops', lots: 3, storeys: [1, 1], storey: 7.5, width: [44, 54],
    depth: [20, 24], setback: [3, 5], ridge: 0, walls: SHOP_WALLS, jobArea: 35, build: 45,
    weight: 1 },
  { id: 'small office', zone: 'offices', lots: 1, storeys: [3, 5], storey: 3.6, width: [14, 16],
    depth: [14, 18], setback: [4, 6], ridge: 0, walls: GLASS, jobArea: 20, build: 60,
    weight: 1 },
  { id: 'office block', zone: 'offices', lots: 2, storeys: [5, 12], storey: 3.6, width: [28, 34],
    depth: [14, 17], setback: [4, 6], ridge: 0, walls: GLASS, jobArea: 20, build: 90,
    weight: 2 },
  { id: 'workshop', zone: 'industry', lots: 1, storeys: [1, 1], storey: 6, width: [14, 18],
    depth: [14, 20], setback: [4, 6], ridge: 1.2, walls: HALL_WALLS, jobArea: 80, build: 30,
    weight: 1 },
  { id: 'hall', zone: 'industry', lots: 2, storeys: [1, 1], storey: 9, width: [0, 0],
    depth: [20, 25], setback: [3, 5], ridge: 1.5, walls: HALL_WALLS, jobArea: 80, build: 45,
    weight: 2 },
  { id: 'warehouse', zone: 'industry', lots: 4, storeys: [1, 1], storey: 11, width: [0, 0],
    depth: [22, 26], setback: [3, 4], ridge: 2, walls: HALL_WALLS, jobArea: 120, build: 60,
    weight: 1 },
]; // prettier-ignore

/** Share of a building's gross floor that is usable (pipeline/demand.py NET_AREA). */
export const NET_AREA = 0.8;
/** Usable floor of a home per resident (m²). */
export const HOME_AREA = 30;
/** Height of a shop's ground floor (m). */
const GROUND_FLOOR = 4.5;
/** Margin (m) a building keeps from the sides of its plot, and from its back. */
const MARGIN = 1;
/** Share of the empty zoned lots that start building each simulated minute. */
export const START_RATE = 0.02;

/** A building grown on lots: its type, size and where it stands on its plot. */
export interface Grown {
  /** Its lots, first to last along the street. */
  lots: number[];
  archetype: number;
  seed: number;
  storeys: number;
  width: number;
  depth: number;
  setback: number;
  /** From the plot's start along the street to the building (m). */
  offset: number;
  /** Simulated time (s) building started and is finished. */
  started: number;
  done: number;
}

/** Deterministic random numbers in [0, 1) from a seed (mulberry32). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: () => number, [a, b]: [number, number]) => a + (b - a) * r();

/** A building of type `archetype` on plot `lots`, sized from `seed`. Where land value is
 * known (`value`, grow/landValue.ts) it is taller the dearer the land: storeys follow land
 * value for 60 % and chance for 40 %. `storeys`: as many as that (a building saved). */
export function makeBuilding(
  lots: Lots,
  plot: number[],
  archetype: number,
  seed: number,
  started: number,
  value?: number,
  storeys?: number,
): Grown {
  const a = ARCHETYPES[archetype];
  const r = random(seed);
  const frontage = plot.reduce((n, i) => n + lots.frontage[i], 0);
  const lotDepth = lots.depth[plot[0]];
  const width = Math.min(
    a.width[1] === 0 ? frontage - 2 * MARGIN : between(r, a.width),
    frontage - 2 * MARGIN,
  );
  const setback = between(r, a.setback);
  const depth = Math.min(between(r, a.depth), lotDepth - setback - MARGIN);
  const chance = r();
  const share =
    value !== undefined && Number.isFinite(value)
      ? 0.4 * chance + 0.6 * Math.min(1, Math.max(0, value / 100))
      : chance;
  const span = a.storeys[1] - a.storeys[0] + 1;
  const grown = storeys ?? a.storeys[0] + Math.min(span - 1, Math.floor(share * span));
  const room = frontage - 2 * MARGIN - width;
  return {
    lots: plot,
    archetype,
    seed,
    storeys: Math.max(a.storeys[0], Math.min(a.storeys[1], Math.round(grown))),
    width,
    depth,
    setback,
    offset: MARGIN + room * r(),
    started,
    done: started + a.build * 60,
  };
}

/** Corners (scene x, z) of a building's footprint, around it. */
export function footprint(lots: Lots, b: Grown): [number, number][] {
  const i = b.lots[0];
  const ux = Math.cos(lots.angle[i]);
  const uz = Math.sin(lots.angle[i]);
  // The plot's start: the first lot's front corner where the street enters it.
  const sx = lots.x[i] - (ux * lots.frontage[i]) / 2 + (uz * lots.depth[i]) / 2;
  const sz = lots.z[i] - (uz * lots.frontage[i]) / 2 - (ux * lots.depth[i]) / 2;
  const at = (a: number, d: number): [number, number] => [
    sx + ux * a - uz * d,
    sz + uz * a + ux * d,
  ];
  const [a0, a1] = [b.offset, b.offset + b.width];
  const [d0, d1] = [b.setback, b.setback + b.depth];
  return [at(a0, d0), at(a1, d0), at(a1, d1), at(a0, d1)];
}

/** Height (m) of a building's walls, and of its roof's ridge. */
export function heights(b: Grown): { eaves: number; ridge: number } {
  const a = ARCHETYPES[b.archetype];
  const eaves = a.ground ? GROUND_FLOOR + (b.storeys - 1) * a.storey : b.storeys * a.storey;
  return { eaves, ridge: eaves + a.ridge };
}

/** Whether a building is finished at simulated time `now` (s): its time has come, or the
 * clock is behind its start (a new day, or a visit started again). */
export function finished(b: Grown, now: number): boolean {
  return now >= b.done || now < b.started;
}

/** Residents and jobs a finished building holds. */
export function occupants(b: Grown): { residents: number; jobs: number } {
  const a = ARCHETYPES[b.archetype];
  const floor = b.width * b.depth * NET_AREA;
  if (a.homes && a.ground) {
    return {
      residents: (floor * (b.storeys - 1)) / HOME_AREA,
      jobs: floor / (a.jobArea ?? 35),
    };
  }
  if (a.homes) return { residents: (floor * b.storeys) / HOME_AREA, jobs: 0 };
  return { residents: 0, jobs: (floor * b.storeys) / (a.jobArea ?? 50) };
}

/** Building types of a zone that fit a run of `free` lots. */
function fitting(zone: number, free: number): number[] {
  return ARCHETYPES.flatMap((a, k) => (zoneCode(a.zone) === zone && a.lots <= free ? [k] : []));
}

/**
 * Growth on the zoned lots: the buildings there and which lot each stands on.
 */
export class Growth {
  readonly buildings: (Grown | undefined)[] = [];
  /** Building on each lot (-1: none). */
  readonly lotBuilding: Int32Array;
  private lastMinute = -1;
  /** How fast each zone's lots start building, as a factor of `START_RATE` (per zone
   * code; grow/zoneDemand.ts). None: the base rate. */
  rates?: readonly number[];
  /** Land value per lot (grow/landValue.ts): dearer lots build first and taller. */
  value?: Float32Array;

  constructor(
    private readonly lots: Lots,
    private seed = 1,
  ) {
    this.lotBuilding = new Int32Array(lots.count).fill(-1);
  }

  /** No buildings. */
  clear(): void {
    this.buildings.length = 0;
    this.lotBuilding.fill(-1);
  }

  add(b: Grown): number {
    const id = this.buildings.length;
    this.buildings.push(b);
    for (const i of b.lots) this.lotBuilding[i] = id;
    return id;
  }

  remove(id: number): void {
    const b = this.buildings[id];
    if (!b) return;
    for (const i of b.lots) if (this.lotBuilding[i] === id) this.lotBuilding[i] = -1;
    this.buildings[id] = undefined;
  }

  /** Buildings standing on lots whose zone no longer suits them come down; their ids. */
  sync(zones: Uint8Array): number[] {
    const gone: number[] = [];
    this.buildings.forEach((b, id) => {
      if (!b) return;
      const zone = zoneCode(ARCHETYPES[b.archetype].zone);
      if (b.lots.some((i) => zones[i] !== zone)) {
        this.remove(id);
        gone.push(id);
      }
    });
    return gone;
  }

  /** The free lots of `zone` from lot `i` along the street (up to `max`). */
  run(zones: Uint8Array, i: number, max: number): number[] {
    const out: number[] = [];
    for (let k = i; k >= 0 && out.length < max; k = this.lots.next[k]) {
      if (zones[k] !== zones[i] || this.lotBuilding[k] >= 0) break;
      out.push(k);
    }
    return out;
  }

  /** Start buildings on empty zoned lots for each simulated minute up to `now` (s); the
   * buildings started. */
  tick(zones: Uint8Array, now: number): number[] {
    const minute = Math.floor(now / 60);
    if (this.lastMinute < 0 || minute < this.lastMinute) this.lastMinute = minute;
    const started: number[] = [];
    // At most an hour of growth at once (a jump in time, or a long pause).
    const steps = Math.min(60, minute - this.lastMinute);
    for (let s = 1; s <= steps; s++) {
      started.push(...this.startSome(zones, (this.lastMinute + s) * 60));
    }
    this.lastMinute = minute;
    return started;
  }

  private startSome(zones: Uint8Array, now: number): number[] {
    const lots = this.lots;
    const r = random(this.seed * 7919 + Math.floor(now / 60));
    // Empty zoned lots, those amid other buildings and on dearer land first.
    const empty: { i: number; key: number }[] = [];
    const perZone: number[] = [];
    for (let i = 0; i < lots.count; i++) {
      if (zones[i] && this.lotBuilding[i] < 0) {
        const v = this.value?.[i];
        const dear = v !== undefined && Number.isFinite(v) ? 0.5 + v / 100 : 1;
        empty.push({ i, key: r() * (1 + lots.context[i] / 3) * dear });
        perZone[zones[i]] = (perZone[zones[i]] ?? 0) + 1;
      }
    }
    if (!empty.length) return [];
    // Buildings to start in each zone: at least one while its demand is not negative,
    // fewer than one (by chance) when it is.
    const want = perZone.map((n, zone) => {
      const rate = this.rates?.[zone] ?? 1;
      const expected = (n ?? 0) * START_RATE * rate;
      const whole = Math.floor(expected) + (r() < expected % 1 ? 1 : 0);
      return rate >= 1 ? Math.max(1, whole) : whole;
    });
    empty.sort((a, b) => b.key - a.key);
    const started: number[] = [];
    for (const { i } of empty) {
      if (!(want[zones[i]] > 0)) continue;
      if (this.lotBuilding[i] >= 0) continue;
      const free = this.run(zones, i, 4);
      const options = fitting(zones[i], free.length);
      if (!options.length) continue;
      const total = options.reduce((n, k) => n + ARCHETYPES[k].weight, 0);
      let pick = r() * total;
      let archetype = options[0];
      for (const k of options) {
        pick -= ARCHETYPES[k].weight;
        if (pick < 0) {
          archetype = k;
          break;
        }
      }
      const seed = Math.floor(r() * 2 ** 31);
      const plot = free.slice(0, ARCHETYPES[archetype].lots);
      started.push(this.add(makeBuilding(lots, plot, archetype, seed, now, this.value?.[i])));
      want[zones[i]]--;
    }
    return started;
  }

  /** Buildings finished and under way, and the residents and jobs of those finished. */
  totals(now: number): { built: number; building: number; residents: number; jobs: number } {
    let [built, building, residents, jobs] = [0, 0, 0, 0];
    for (const b of this.buildings) {
      if (!b) continue;
      if (!finished(b, now)) {
        building++;
        continue;
      }
      built++;
      const o = occupants(b);
      residents += o.residents;
      jobs += o.jobs;
    }
    return { built, building, residents, jobs };
  }
}

// ---- saving --------------------------------------------------------------------------

export function saveBuildings(lots: Lots, growth: Growth): SavedBuilding[] {
  return growth.buildings.flatMap((b) => {
    if (!b) return [];
    const i = b.lots[0];
    const r = (v: number) => Math.round(v * 10) / 10;
    return [
      [
        r(lots.x[i]),
        r(lots.z[i]),
        ARCHETYPES[b.archetype].id,
        b.seed,
        b.started,
        b.done,
        b.storeys,
      ],
    ];
  });
}

/** Put saved buildings back on the lots they stood on (those whose lots are still free
 * and zoned for them). The simulated day starts again on every visit, so they come back
 * finished: building went on meanwhile. */
export function restoreBuildings(
  lots: Lots,
  growth: Growth,
  zones: Uint8Array,
  saved: readonly SavedBuilding[],
): number {
  let restored = 0;
  for (const [x, z, id, seed, , , storeys] of saved) {
    const archetype = ARCHETYPES.findIndex((a) => a.id === id);
    if (archetype < 0) continue;
    const first = lots.within(x, z, 2)[0];
    if (first === undefined) continue;
    const a = ARCHETYPES[archetype];
    if (zones[first] !== zoneCode(a.zone)) continue;
    const plot = growth.run(zones, first, a.lots);
    if (plot.length < a.lots) continue;
    const b = makeBuilding(lots, plot, archetype, seed, 0, undefined, storeys);
    b.done = 0;
    growth.add(b);
    restored++;
  }
  return restored;
}
