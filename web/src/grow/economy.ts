/**
 * The City's money (M5e): what building costs, what comes in, and the balance over time.
 *
 * Money runs a year to the simulated day. Buildings rise in an hour or two of simulated
 * time and roads open as soon as they are drawn, so a day of the game stands for a year
 * of the City's budget: its yearly income and upkeep come in and go out over each
 * simulated day.
 *
 * Income, from the City of Zagreb's budget for 2025 and its decisions on communal fees:
 * - the City's yearly investment in its streets: €63.9 million (capital spending on
 *   *nerazvrstane ceste*, the streets it manages);
 * - income tax on what grows: €1,800 a resident a year (€1.377 billion of income tax over
 *   767,131 residents in the 2021 census; it all goes to the City);
 * - the communal fee (*komunalna naknada*): €1.39 a year per m² of usable floor (the
 *   City's point value since 2024), times the purpose coefficient (homes 1, shops 9,
 *   offices 10; industry 4, estimated: the City's coefficient for production premises was
 *   not found) and a zone coefficient by land value (1.00 down to 0.40, estimated);
 * - the communal contribution (*komunalni doprinos*), once, when a building is finished:
 *   €18.35, 18.00, 16.00, 12.00 or 2.00 per m³ of its volume in the City's zones I-V
 *   (2025), the zone taken from land value.
 *
 * The taxes and fees of what grows go to the player's roads in full: the schools, care
 * and transport its people would need are left out. Lots outside the City pay as if in it.
 *
 * Costs, from Croatian projects (euros without VAT; land is left out):
 * - roads: €1.1 million per lane-km (Branimirova's extension: €4.4 million for just over
 *   a kilometre of four lanes, with pavements, cycle paths and four junctions with
 *   lights); motorways €2.7 million (the A11 from Jakuševec to Velika Gorica: 780 million
 *   kuna for 9.5 km of four lanes);
 * - tram tracks along a new road (M9c): €4.2 million a km both ways (ZET's first phase of
 *   modernising its tram infrastructure: €34.46 million for 8.19 km of track and three
 *   substations; new track is taken to cost the same, an estimate), half one way;
 * - bridges: €5,600 per m² of deck (Jarunski most: €140 million estimated for 625 m by
 *   40 m), 3.5 m a lane and 4 m of pavements;
 * - roundabouts: €950,000 with one lane (Pavlovac in Rijeka, contracted in 2025), twice
 *   that with two (estimated);
 * - new traffic lights: €200,000 a junction (Zagreb's 2023 programme of works put
 *   €198,900 into new signals); new timings €5,000 (estimated);
 * - closures, lane changes, speed limits and turn bans: signs and markings, €1,000-5,000
 *   (estimated).
 *
 * Upkeep of what the player builds: €4,200 per lane-km a year (the City's 2024 programme put
 * €21.0 million into extraordinary maintenance of its streets: 4,986 lane-km on the
 * simulated network, service roads and motorways left out; regular upkeep is left out
 * too), 0.5 % a year of a bridge's cost and €3,000 a year for a set of lights (both
 * estimated).
 *
 * Public transport run more or less often (M9b) costs or saves what ZET spends per
 * vehicle-km: €7.00 a tram-km and €4.90 a bus-km. ZET's operating costs in 2024 were
 * €209.6 million (depreciation included) for 10.57 million tram-km and 27.72 million
 * bus-km; they are shared by the hours each ran (trams averaged 12.49 km/h, buses 17.96),
 * as drivers' pay is most of them (an estimate: ZET does not split its costs by mode). A
 * weekday's timetable is about 1/244 of a year's tram-km and 1/308 of its bus-km (ZET's
 * 2024 km over the weekday timetable's). A new line (M9c) costs the same per vehicle-km it
 * runs; building its stops is left out. Fares from riders gained or lost are left out.
 */
import type { Point } from '../edit/builder';
import type { Edit } from '../edit/edits';
import type { Mode } from '../world/transitLines';
import { ARCHETYPES, type Grown, NET_AREA, heights, occupants } from './growth';

export const BASE_INCOME = 63_900_000;
export const INCOME_TAX = 1_800;
export const FEE_POINT = 1.39;
/** Communal fee purpose coefficients. */
export const PURPOSE = { homes: 1, shops: 9, offices: 10, industry: 4 } as const;
/** The City's zones, picked by land value: the fee's zone coefficient and the
 * contribution per m³. */
export const CITY_ZONES = [
  { from: 60, fee: 1.0, contribution: 18.35 },
  { from: 35, fee: 0.85, contribution: 18.0 },
  { from: 15, fee: 0.7, contribution: 16.0 },
  { from: 5, fee: 0.55, contribution: 12.0 },
  { from: -Infinity, fee: 0.4, contribution: 2.0 },
] as const;

export const LANE_KM = { motorway: 2_700_000, other: 1_100_000 } as const;
export const TRAM_TRACK_KM = 4_200_000;
export const BRIDGE_M2 = 5_600;
export const LANE_WIDTH = 3.5;
export const PAVEMENTS = 4;
export const ROUNDABOUT = [950_000, 1_900_000] as const;
export const NEW_LIGHTS = 200_000;
export const RETIMING = 5_000;
export const SIGNS = { close: 2_000, closeLane: 2_000, speed: 1_000, busLane: 5_000, ban: 1_000 };
export const UPKEEP_LANE_KM = 4_200;
export const BRIDGE_UPKEEP = 0.005;
export const LIGHTS_UPKEEP = 3_000;
/** ZET's cost per vehicle-km (€), and weekdays' service a year comes to. */
export const VEHICLE_KM: Record<Mode, number> = { tram: 7.0, bus: 4.9, train: 0 };
export const SERVICE_DAYS: Record<Mode, number> = { tram: 244, bus: 308, train: 0 };
/** Seconds of simulated time a budget year takes. */
export const YEAR = 86_400;

/** The City's zone for land worth `value` (not measured: zone III). */
export function cityZone(value: number | undefined): (typeof CITY_ZONES)[number] {
  const v = value !== undefined && Number.isFinite(value) ? value : 20;
  return CITY_ZONES.find((z) => v >= z.from) ?? CITY_ZONES[CITY_ZONES.length - 1];
}

/** What a finished building pays each year: income tax of its residents and the
 * communal fee on its floor. */
export function buildingIncome(b: Grown, value?: number): { tax: number; fee: number } {
  const a = ARCHETYPES[b.archetype];
  const floor = b.width * b.depth * NET_AREA;
  const homeFloors = a.homes ? (a.ground ? b.storeys - 1 : b.storeys) : 0;
  const business =
    a.zone === 'offices'
      ? PURPOSE.offices
      : a.zone === 'industry'
        ? PURPOSE.industry
        : PURPOSE.shops;
  const zone = cityZone(value);
  return {
    tax: occupants(b).residents * INCOME_TAX,
    fee:
      FEE_POINT *
      zone.fee *
      floor *
      (homeFloors * PURPOSE.homes + (b.storeys - homeFloors) * business),
  };
}

/** The communal contribution a building pays once finished: on its volume. */
export function contribution(b: Grown, value?: number): number {
  return b.width * b.depth * heights(b).eaves * cityZone(value).contribution;
}

const length = (points: Point[]) =>
  points.slice(1).reduce((s, p, k) => s + Math.hypot(p.x - points[k].x, p.z - points[k].z), 0);

/** Whether the junction near a point has traffic lights on the network loaded. */
export type HasLights = (x: number, z: number) => boolean;

/** A line's vehicle-km a weekday, as timetabled, or as a new line (`isNew`) runs
 * (undefined: not known). */
export type LineKm = (line: string, mode: Mode, isNew: boolean) => number | undefined;

/** What an edit costs (€): to build, its upkeep a year, and what it adds to public
 * transport's running costs a year (less where it runs less). */
export interface EditCost {
  build: number;
  upkeep: number;
  service: number;
}

/** What an edit costs to build (€), its upkeep a year and its service a year. */
export function editCost(edit: Edit, hasLights: HasLights = () => true, lineKm?: LineKm): EditCost {
  return { service: 0, ...buildAndUpkeep(edit, hasLights, lineKm) };
}

function buildAndUpkeep(
  edit: Edit,
  hasLights: HasLights,
  lineKm?: LineKm,
): { build: number; upkeep: number; service?: number } {
  switch (edit.kind) {
    case 'frequency': {
      const km = lineKm?.(edit.line, edit.mode, false) ?? 0;
      const service = (edit.factor - 1) * km * SERVICE_DAYS[edit.mode] * VEHICLE_KM[edit.mode];
      return { build: 0, upkeep: 0, service };
    }
    case 'line': {
      const km = lineKm?.(edit.name, edit.mode, true) ?? 0;
      return { build: 0, upkeep: 0, service: km * SERVICE_DAYS[edit.mode] * VEHICLE_KM[edit.mode] };
    }
    case 'road': {
      const km = length(edit.points) / 1000;
      const lanes = edit.lanes * (edit.oneway ? 1 : 2);
      const tracks = edit.tram ? km * TRAM_TRACK_KM * (edit.oneway ? 0.5 : 1) : 0;
      if (edit.bridge) {
        const deck = km * 1000 * (lanes * LANE_WIDTH + PAVEMENTS) * BRIDGE_M2;
        return { build: deck + tracks, upkeep: deck * BRIDGE_UPKEEP };
      }
      const rate = edit.type === 'motorway' ? LANE_KM.motorway : LANE_KM.other;
      return { build: km * lanes * rate + tracks, upkeep: km * lanes * UPKEEP_LANE_KM };
    }
    case 'roundabout':
      return { build: ROUNDABOUT[Math.min(edit.lanes, 2) - 1] ?? ROUNDABOUT[0], upkeep: 0 };
    case 'signal': {
      if (edit.phases.length === 0) return { build: SIGNS.close, upkeep: 0 };
      const fresh = !hasLights(edit.junction.x, edit.junction.z);
      return fresh ? { build: NEW_LIGHTS, upkeep: LIGHTS_UPKEEP } : { build: RETIMING, upkeep: 0 };
    }
    case 'green':
      return { build: RETIMING, upkeep: 0 };
    default:
      return { build: SIGNS[edit.kind], upkeep: 0 };
  }
}

/** What a list of edits cost to build, their upkeep and their service a year. */
export function editsCost(
  edits: readonly Edit[],
  hasLights?: HasLights,
  lineKm?: LineKm,
): EditCost {
  const sum: EditCost = { build: 0, upkeep: 0, service: 0 };
  for (const e of edits) {
    const c = editCost(e, hasLights, lineKm);
    sum.build += c.build;
    sum.upkeep += c.upkeep;
    sum.service += c.service;
  }
  return sum;
}

/** Money coming in and going out a year, by item. */
export interface Yearly {
  base: number;
  tax: number;
  fee: number;
  upkeep: number;
  /** Public transport run more (or less, negative) than timetabled. */
  service: number;
}

export interface SavedBudget {
  version: 1;
  balance: number;
  /** What the edits in force cost when last paid for. */
  spent: number;
  /** Balance over time: [days since the first (with the time of day as a fraction), €]. */
  history: [number, number][];
}

/** Samples of the balance kept. */
const HISTORY = 400;
/** Simulated seconds between samples. */
const SAMPLE = 600;

/**
 * The balance: yearly income and upkeep flow in over simulated time, building is paid
 * for when an edit comes into force (and refunded when taken back), communal
 * contributions when buildings are finished.
 */
export class Budget {
  balance: number;
  /** Cost of the edits in force, as paid. */
  spent: number;
  readonly history: [number, number][];
  yearly: Yearly = { base: BASE_INCOME, tax: 0, fee: 0, upkeep: 0, service: 0 };
  /** Communal contributions paid since the page was opened. */
  contributions = 0;
  private last?: number;
  /** Days run (the simulated clock starts again each visit and passes midnight). */
  private days = 0;

  constructor(saved?: SavedBudget) {
    this.balance = saved?.balance ?? BASE_INCOME;
    this.spent = saved?.spent ?? 0;
    this.history = saved?.history?.slice(-HISTORY) ?? [];
  }

  /** Whether `cost` more can be paid for now; else why not. */
  afford(cost: number): string | undefined {
    if (cost <= 0 || cost <= this.balance) return undefined;
    return (
      `Not enough money: this costs ${euros(cost)} and the City has ${euros(Math.max(0, this.balance))}. ` +
      'Income comes in as the simulated day goes on.'
    );
  }

  /** The edits in force now cost `total` to build: pay the difference (or get it back). */
  setSpent(total: number): void {
    this.balance -= total - this.spent;
    this.spent = total;
  }

  /** A building finished: its communal contribution. */
  contribute(amount: number): void {
    this.balance += amount;
    this.contributions += amount;
  }

  /** Simulated time now (s since midnight on the first day): the year's flows for the
   * time passed. */
  tick(now: number): void {
    if (this.last === undefined || now < this.last) {
      // A new visit, or the clock went back: no time has passed, and the history goes on
      // from the next day.
      const lastDay = this.history.at(-1)?.[0];
      this.days = lastDay === undefined ? 0 : Math.floor(lastDay) + 1;
      this.last = now;
      this.sample(now);
      return;
    }
    const dt = Math.min(now - this.last, YEAR);
    this.last = now;
    const y = this.yearly;
    this.balance += ((y.base + y.tax + y.fee - y.upkeep - y.service) * dt) / YEAR;
    this.sample(now);
  }

  private sample(now: number): void {
    const t = this.days + now / YEAR;
    const prev = this.history.at(-1);
    if (prev && t >= prev[0] && (t - prev[0]) * YEAR < SAMPLE - 1) return;
    this.history.push([t, Math.round(this.balance)]);
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
  }

  /** The balance now, as a point of the history (none before the first tick). */
  current(): [number, number] | undefined {
    return this.last === undefined
      ? undefined
      : [this.days + this.last / YEAR, Math.round(this.balance)];
  }

  save(): SavedBudget {
    return { version: 1, balance: this.balance, spent: this.spent, history: this.history };
  }
}

/** A sum of money as the panel shows it: "€63.9 million", "€250,000", "-€1.2 million". */
export function euros(v: number): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}€${(a / 1e9).toFixed(2)} billion`;
  if (a >= 1e6) return `${sign}€${(a / 1e6).toFixed(1)} million`;
  return `${sign}€${Math.round(a).toLocaleString('en-GB')}`;
}

const BUDGET_KEY = 'zg-city-sim:budget';

export function loadBudget(
  storage: Storage | undefined = globalThis.localStorage,
): SavedBudget | undefined {
  try {
    const v = JSON.parse(storage?.getItem(BUDGET_KEY) ?? 'null') as SavedBudget | null;
    if (
      v?.version === 1 &&
      Number.isFinite(v.balance) &&
      Number.isFinite(v.spent) &&
      Array.isArray(v.history)
    ) {
      return {
        ...v,
        history: v.history.filter(
          (h): h is [number, number] =>
            Array.isArray(h) && Number.isFinite(h[0]) && Number.isFinite(h[1]),
        ),
      };
    }
  } catch {
    // Nothing saved, or not readable.
  }
  return undefined;
}

export function saveBudget(
  budget: Budget,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(BUDGET_KEY, JSON.stringify(budget.save()));
  } catch {
    // Storage full or blocked: the balance lasts the visit.
  }
}
