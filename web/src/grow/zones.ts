/**
 * Zoning (M5a): which lots buildings of which kind may grow on, painted by the player with a
 * brush. The zoning is kept as the brush strokes, by position, not as lot ids: lots are made
 * again whenever CI rebuilds the data, and strokes painted again land on the same land.
 */
import { decodeTextFromUrl, encodeTextForUrl } from '../edit/edits';
import type { Lots } from './lots';

/** Zones, in the order of their codes (1 up; 0 is no zone). */
export const ZONES = [
  { id: 'houses', label: 'Houses', color: '#a7d86e', title: 'Family houses, two or three storeys' },
  {
    id: 'lowrise',
    label: 'Low-rise flats',
    color: '#52b04f',
    title: 'Villas and blocks, 4-6 storeys',
  },
  {
    id: 'highrise',
    label: 'High-rise flats',
    color: '#2b7a31',
    title: 'Slabs and towers, 7-19 storeys',
  },
  {
    id: 'mixed',
    label: 'Flats over shops',
    color: '#3ba99b',
    title: 'Housing with shops at street level',
  },
  { id: 'shops', label: 'Shops', color: '#4a90d9', title: 'Shops, services and retail parks' },
  { id: 'offices', label: 'Offices', color: '#8a6fd8', title: 'Office blocks' },
  { id: 'industry', label: 'Industry', color: '#e0b23a', title: 'Workshops, halls and warehouses' },
] as const;

export type ZoneId = (typeof ZONES)[number]['id'];
/** What a brush paints: a zone, the zone the City's plan gives each lot, or no zone. */
export type Brush = ZoneId | 'plan' | 'none';

/** A brush stroke: what it painted, its radius (m) and the points it passed (scene x, z). */
export interface Stroke {
  brush: Brush;
  radius: number;
  points: [number, number][];
}

/** Code of a zone (1 up), 0 for none. */
export function zoneCode(id: ZoneId): number {
  return ZONES.findIndex((z) => z.id === id) + 1;
}

/** The zone the City's plan gives lot `i` (0: none). Housing land takes the density of the
 * buildings around it: houses among houses, flats among flats, and low-rise flats where
 * there is nothing yet. */
export function plannedZone(lots: Lots, i: number): number {
  const plan = lots.planOf(i)?.id;
  switch (plan) {
    case 'residential': {
      const storeys = lots.context[i];
      if (storeys === 0) return zoneCode('lowrise');
      if (storeys <= 2) return zoneCode('houses');
      return zoneCode(storeys <= 6 ? 'lowrise' : 'highrise');
    }
    case 'mixed':
      return zoneCode('mixed');
    case 'commercial':
      return zoneCode('shops');
    case 'office':
      return zoneCode('offices');
    case 'industrial':
      return zoneCode('industry');
    default:
      return 0;
  }
}

/** Points along a stroke this far apart (a share of its radius) are painted. */
const STEP = 0.4;

/** Paint a stroke onto `zones` (one code per lot); the lots it changed. The plan's brush
 * zones only the lots the plan zones, and leaves the others (farmland, no plan) as they
 * are. */
export function applyStroke(lots: Lots, zones: Uint8Array, stroke: Stroke): number[] {
  const changed = new Set<number>();
  const paint = (x: number, z: number) => {
    for (const i of lots.within(x, z, stroke.radius)) {
      const code =
        stroke.brush === 'none'
          ? 0
          : stroke.brush === 'plan'
            ? plannedZone(lots, i)
            : zoneCode(stroke.brush);
      if (stroke.brush === 'plan' && code === 0) continue;
      if (zones[i] !== code) {
        zones[i] = code;
        changed.add(i);
      }
    }
  };
  const pts = stroke.points;
  pts.forEach(([x, z], k) => {
    if (k > 0) {
      // Between points, so a quick drag leaves no gaps.
      const [px, pz] = pts[k - 1];
      const steps = Math.floor(Math.hypot(x - px, z - pz) / (stroke.radius * STEP));
      for (let s = 1; s < steps; s++)
        paint(px + ((x - px) * s) / steps, pz + ((z - pz) * s) / steps);
    }
    paint(x, z);
  });
  return [...changed];
}

/** Zones of every lot after `strokes`. */
export function zonesFrom(lots: Lots, strokes: readonly Stroke[]): Uint8Array {
  const zones = new Uint8Array(lots.count);
  for (const stroke of strokes) applyStroke(lots, zones, stroke);
  return zones;
}

/** Lots and land (m²) per zone code. */
export function zoneTotals(lots: Lots, zones: Uint8Array): { lots: number; area: number }[] {
  const out = Array.from({ length: ZONES.length + 1 }, () => ({ lots: 0, area: 0 }));
  for (let i = 0; i < zones.length; i++) {
    out[zones[i]].lots++;
    out[zones[i]].area += lots.area(i);
  }
  return out;
}

// ---- saving and sharing ----------------------------------------------------------------

export const ZONING_VERSION = 1;
const BRUSHES = new Set<string>([...ZONES.map((z) => z.id), 'plan', 'none']);

export function serializeZoning(strokes: readonly Stroke[]): string {
  return JSON.stringify({
    version: ZONING_VERSION,
    strokes: strokes.map((s) => ({
      brush: s.brush,
      radius: Math.round(s.radius),
      points: s.points.map(([x, z]) => [Math.round(x), Math.round(z)]),
    })),
  });
}

/** Strokes from a saved zoning; throws if it is not one. Strokes that cannot be read are
 * dropped. */
export function parseZoning(text: string): Stroke[] {
  const saved = JSON.parse(text) as { strokes?: unknown };
  if (typeof saved !== 'object' || saved === null || !Array.isArray(saved.strokes)) {
    throw new Error('Not a zoning');
  }
  return saved.strokes.filter((s): s is Stroke => {
    const t = s as Partial<Stroke>;
    return (
      typeof t === 'object' &&
      t !== null &&
      BRUSHES.has(t.brush as string) &&
      Number.isFinite(t.radius) &&
      (t.radius as number) > 0 &&
      Array.isArray(t.points) &&
      t.points.length > 0 &&
      t.points.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    );
  });
}

const STORAGE_KEY = 'zg-city-sim:zoning';

export function loadSavedZoning(storage: Storage | undefined = globalThis.localStorage): Stroke[] {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    return text ? parseZoning(text) : [];
  } catch {
    return [];
  }
}

export function saveZoning(
  strokes: readonly Stroke[],
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    if (strokes.length === 0) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, serializeZoning(strokes));
  } catch {
    // Private windows and full storage: the zoning lives for this visit only.
  }
}

export const encodeZoningForUrl = (strokes: readonly Stroke[]) =>
  encodeTextForUrl(serializeZoning(strokes));

export const decodeZoningFromUrl = async (value: string) =>
  parseZoning(await decodeTextFromUrl(value));
