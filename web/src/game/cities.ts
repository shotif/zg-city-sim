/**
 * Cities kept in this browser (M19a): each a save slot with its mode, and its edits, zoning,
 * grown buildings and budget under keys of its own. The city kept before M19 keeps the old
 * keys, so nothing has to move; it becomes the first city, in Sandbox.
 *
 * The city played is chosen before the app starts (`useCity`), and the modules that save
 * a city's parts ask `cityKey` for their keys. Switching city reloads the page.
 */

export type GameMode = 'reality' | 'sandbox' | 'career';

export const GAME_MODES: Record<GameMode, { label: string; text: string }> = {
  reality: {
    label: 'Reality',
    text:
      "Today's Zagreb, for analysis: try edits and compare them with today's roads. Edits " +
      'cost nothing, and zoning and the budget are off.',
  },
  sandbox: {
    label: 'Sandbox',
    text:
      'Build, zone land and watch it grow. The budget is kept, but money never stops you ' +
      'building.',
  },
  career: {
    label: 'Career',
    text: "Build and grow within the City's budget, and meet goals stage by stage.",
  },
};

export interface City {
  id: string;
  name: string;
  mode: GameMode;
  /** When it was made and last played (ms since 1970). */
  created: number;
  played: number;
}

const PREFIX = 'zg-city-sim:';
const LIST_KEY = `${PREFIX}cities`;
const CURRENT_KEY = `${PREFIX}city`;
/** The city kept before M19, under the old keys. */
export const FIRST_CITY = 'zagreb';
/** The city a link with edits in it opens, in Reality, apart from the player's own. */
export const LINK_CITY = 'link';
/** What a city keeps, each part under a key of its own. */
export const CITY_PARTS = ['edits', 'zoning', 'growth', 'budget', 'days', 'career'] as const;
export type CityPart = (typeof CITY_PARTS)[number];
/** Longest name a city may have. */
export const MAX_NAME = 40;
const FILE_FORMAT = 'zg-city-sim city';

let active = FIRST_CITY;

/** The city whose parts are read and saved from now on. */
export function useCity(id: string): void {
  active = id;
}

/** The key part `part` of city `id` (the city played, by default) is kept under. */
export function cityKey(part: CityPart, id = active): string {
  return id === FIRST_CITY ? PREFIX + part : `${PREFIX}city:${id}:${part}`;
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Storage blocked.
    return undefined;
  }
}

function isMode(m: unknown): m is GameMode {
  return m === 'reality' || m === 'sandbox' || m === 'career';
}

function isCity(c: unknown): c is City {
  const x = c as City;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof x.id === 'string' &&
    /^[a-z0-9-]{1,40}$/.test(x.id) &&
    typeof x.name === 'string' &&
    isMode(x.mode) &&
    Number.isFinite(x.created) &&
    Number.isFinite(x.played)
  );
}

/** A name of at most `MAX_NAME` characters, with spaces tidied ("Zagreb" if none). */
export function cleanName(name: string): string {
  const tidy = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return tidy || 'Zagreb';
}

/** The cities kept in `storage` (none kept if it is unavailable). */
export class Cities {
  /** Cities made while storage is unavailable: they last the visit. */
  private readonly unsaved: City[] = [];

  constructor(private readonly storage: Storage | undefined = browserStorage()) {}

  /** The cities kept, in the order made. The city kept before M19 is listed first. */
  list(): City[] {
    let list: City[] = [];
    try {
      const v = JSON.parse(this.storage?.getItem(LIST_KEY) ?? '[]') as unknown;
      if (Array.isArray(v)) list = v.filter(isCity);
    } catch {
      // Not readable: start again.
    }
    if (!list.some((c) => c.id === FIRST_CITY) && this.hasParts(FIRST_CITY)) {
      const now = Date.now();
      list.unshift({ id: FIRST_CITY, name: 'Zagreb', mode: 'sandbox', created: now, played: now });
      this.write(list);
    }
    return [...list, ...this.unsaved];
  }

  get(id: string): City | undefined {
    return this.list().find((c) => c.id === id);
  }

  /** The city played last, if it is still kept. */
  current(): City | undefined {
    let id: string | null = null;
    try {
      id = this.storage?.getItem(CURRENT_KEY) ?? null;
    } catch {
      // As below.
    }
    const list = this.list();
    return list.find((c) => c.id === id) ?? (id === null ? list[0] : undefined);
  }

  /** Play city `id` from the next visit on. */
  setCurrent(id: string): void {
    try {
      this.storage?.setItem(CURRENT_KEY, id);
    } catch {
      // Storage blocked: the city is played this visit only.
    }
  }

  /** A new city called `name` in `mode`. */
  create(name: string, mode: GameMode): City {
    const now = Date.now();
    const taken = new Set(this.list().map((c) => c.id));
    let id: string;
    do {
      id = `c${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    } while (taken.has(id));
    const city: City = { id, name: cleanName(name), mode, created: now, played: now };
    if (!this.add(city)) this.unsaved.push(city);
    return city;
  }

  rename(id: string, name: string): void {
    this.update(id, (c) => ({ ...c, name: cleanName(name) }));
  }

  /** City `id` was played just now. */
  touch(id: string): void {
    this.update(id, (c) => ({ ...c, played: Date.now() }));
  }

  /** Forget city `id` and everything it kept. */
  remove(id: string): void {
    for (const part of CITY_PARTS) this.setPart(id, part, null);
    this.write(this.list().filter((c) => c.id !== id));
  }

  /** The city a link with edits opens: in Reality, kept apart from the player's cities,
   * and started afresh by each link. */
  linkCity(): City {
    for (const part of CITY_PARTS) this.setPart(LINK_CITY, part, null);
    const now = Date.now();
    const city: City = {
      id: LINK_CITY,
      name: 'From a link',
      mode: 'reality',
      created: now,
      played: now,
    };
    const list = this.list().filter((c) => c.id !== LINK_CITY);
    if (!this.write([...list, city])) this.unsaved.push(city);
    return city;
  }

  /** The simulated day city `id` has reached (1 on its first), from its budget's history. */
  day(id: string): number {
    try {
      const v = JSON.parse(this.part(id, 'budget') ?? 'null') as { history?: unknown } | null;
      const last = Array.isArray(v?.history) ? (v.history.at(-1) as unknown) : undefined;
      const t = Array.isArray(last) ? Number(last[0]) : NaN;
      return Number.isFinite(t) ? Math.floor(t) + 1 : 1;
    } catch {
      return 1;
    }
  }

  /** City `id` as a file's text, everything it keeps with it. */
  exportCity(id: string): string {
    const city = this.get(id);
    if (!city) throw new Error('No such city');
    const parts: Partial<Record<CityPart, string | null>> = {};
    for (const part of CITY_PARTS) parts[part] = this.part(id, part);
    return JSON.stringify({
      format: FILE_FORMAT,
      version: 1,
      name: city.name,
      mode: city.mode,
      created: city.created,
      parts,
    });
  }

  /** A new city from a file's text (`exportCity`); throws if it is not one, or if the
   * browser has no room for it. */
  importCity(text: string): City {
    const v = JSON.parse(text) as {
      format?: unknown;
      version?: unknown;
      name?: unknown;
      mode?: unknown;
      created?: unknown;
      parts?: Record<string, unknown>;
    };
    if (
      v?.format !== FILE_FORMAT ||
      v.version !== 1 ||
      typeof v.name !== 'string' ||
      !isMode(v.mode) ||
      typeof v.parts !== 'object' ||
      v.parts === null
    ) {
      throw new Error('Not a city saved from ZG City Sim');
    }
    const parts = v.parts;
    if (
      CITY_PARTS.some(
        (p) => parts[p] !== undefined && parts[p] !== null && typeof parts[p] !== 'string',
      )
    ) {
      throw new Error('Not a city saved from ZG City Sim');
    }
    const names = new Set(this.list().map((c) => c.name));
    let name = cleanName(v.name);
    for (let k = 2; names.has(name); k++) name = `${cleanName(v.name)} (${k})`;
    const city = this.create(name, v.mode);
    if (Number.isFinite(v.created))
      this.update(city.id, (c) => ({ ...c, created: Number(v.created) }));
    try {
      for (const part of CITY_PARTS) {
        const value = parts[part];
        if (typeof value === 'string') this.storage?.setItem(cityKey(part, city.id), value);
      }
    } catch {
      this.remove(city.id);
      throw new Error("There is no room for it in this browser's storage");
    }
    return this.get(city.id) ?? city;
  }

  private hasParts(id: string): boolean {
    return CITY_PARTS.some((part) => this.part(id, part) !== null);
  }

  private part(id: string, part: CityPart): string | null {
    try {
      return this.storage?.getItem(cityKey(part, id)) ?? null;
    } catch {
      return null;
    }
  }

  private setPart(id: string, part: CityPart, value: string | null): void {
    try {
      if (value === null) this.storage?.removeItem(cityKey(part, id));
      else this.storage?.setItem(cityKey(part, id), value);
    } catch {
      // Storage blocked.
    }
  }

  private add(city: City): boolean {
    return this.write([...this.list().filter((c) => c.id !== city.id), city]);
  }

  private update(id: string, change: (c: City) => City): void {
    const i = this.unsaved.findIndex((c) => c.id === id);
    if (i >= 0) this.unsaved[i] = change(this.unsaved[i]);
    else this.write(this.list().map((c) => (c.id === id ? change(c) : c)));
  }

  /** Keep the list (the cities made this visit only are left out); false if it could not
   * be kept. */
  private write(list: City[]): boolean {
    const kept = list.filter((c) => !this.unsaved.includes(c));
    try {
      if (!this.storage) return false;
      this.storage.setItem(LIST_KEY, JSON.stringify(kept));
      return true;
    } catch {
      return false;
    }
  }
}
