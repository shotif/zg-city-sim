/**
 * Today's services (M20a): primary schools, kindergartens, health care, fire and police
 * stations, from the City's open data and OpenStreetMap (pipeline/services.py). The Services panel sums them up by kind and lists them by
 * district; their markers show on the map while it is open.
 */
import { districtName } from '../game/career';
import { button, el } from './buildPanel';

export type ServiceKind = 'school' | 'kindergarten' | 'health' | 'fire' | 'police';

/** A service as the pipeline writes it (`services/services.json`). */
export interface Service {
  kind: ServiceKind;
  name: string;
  x: number;
  z: number;
  /** The street in front (today's network). */
  edge: number;
  /** Index into the City's districts; -1 outside the City. */
  district: number;
  /** Pupils, children or registered patients it takes (an estimate); 0 for fire and police. */
  places: number;
}

export interface ServicesData {
  kinds: ServiceKind[];
  districts: string[];
  services: Service[];
}

/** Each kind's name, what its places are, and its marker's letter. */
export const SERVICE_KINDS: Record<
  ServiceKind,
  { label: string; one: string; places?: string; letter: string }
> = {
  school: { label: 'Primary schools', one: 'Primary school', places: 'pupils', letter: 'Š' },
  kindergarten: { label: 'Kindergartens', one: 'Kindergarten', places: 'children', letter: 'V' },
  health: {
    label: 'GP practices and health centres',
    one: 'GP practice or health centre',
    places: 'patients registered',
    letter: 'Z',
  },
  fire: { label: 'Fire stations', one: 'Fire station', letter: 'F' },
  police: { label: 'Police stations', one: 'Police station', letter: 'P' },
};

const KINDS = Object.keys(SERVICE_KINDS) as ServiceKind[];
/** Services listed for a district at most. */
const LISTED = 60;

const n = (x: number) => Math.round(x).toLocaleString('en-GB');

export async function loadServices(url: string): Promise<ServicesData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as ServicesData;
}

/** Each kind's services and places in the City. */
export function serviceTotals(
  data: ServicesData,
): Record<ServiceKind, { count: number; places: number }> {
  const out = Object.fromEntries(KINDS.map((k) => [k, { count: 0, places: 0 }])) as Record<
    ServiceKind,
    { count: number; places: number }
  >;
  for (const s of data.services) {
    if (s.district < 0) continue;
    out[s.kind].count++;
    out[s.kind].places += s.places;
  }
  return out;
}

export interface ServicesPanelCallbacks {
  onClose(): void;
  /** Show a service: fly there. */
  onShow(s: Service): void;
  /** The markers changed: draw the view again. */
  invalidate(): void;
}

export class ServicesPanel {
  private readonly panel: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly list: HTMLElement;
  private readonly info: HTMLElement;
  private readonly district: HTMLSelectElement;
  private readonly markers: HTMLButtonElement[] = [];
  private readonly shownKinds = new Set<ServiceKind>(KINDS);
  private selected?: number;
  private shown = false;

  constructor(
    parent: HTMLElement,
    private readonly data: ServicesData,
    private readonly callbacks: ServicesPanelCallbacks,
  ) {
    // Under the HUD's panels.
    this.layer = el('div', 'service-markers');
    parent.prepend(this.layer);
    this.layer.hidden = true;
    data.services.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'service-marker';
      b.dataset.kind = s.kind;
      b.textContent = SERVICE_KINDS[s.kind].letter;
      const label = `${SERVICE_KINDS[s.kind].one}: ${s.name || 'unnamed'}`;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', () => this.select(i));
      this.layer.append(b);
      this.markers.push(b);
    });

    this.panel = el('aside', 'hud-panel cities-panel services-panel', parent);
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Services');
    const header = el('div', 'news-header', this.panel);
    el('h2', 'build-title', header).textContent = 'Services';
    const close = el('button', 'hud-button hud-icon', header);
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close (V)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => callbacks.onClose());
    el('p', 'build-note', this.panel).textContent = 'In the City today:';
    const totals = serviceTotals(data);
    const kinds = el('div', 'services-kinds', this.panel);
    for (const kind of KINDS) {
      const k = SERVICE_KINDS[kind];
      const row = el('label', 'build-label services-kind', kinds);
      const box = el('input', '', row);
      box.type = 'checkbox';
      box.checked = true;
      box.addEventListener('change', () => {
        if (box.checked) this.shownKinds.add(kind);
        else this.shownKinds.delete(kind);
        this.refresh();
      });
      el('span', `service-swatch`, row).dataset.kind = kind;
      const t = totals[kind];
      row.append(
        `${k.label}: ${n(t.count)}` + (k.places ? `, about ${n(t.places)} ${k.places}` : ''),
      );
    }
    const pick = el('label', 'build-label', this.panel);
    pick.append('District ');
    this.district = el('select', 'build-select', pick);
    this.district.setAttribute('aria-label', 'District');
    const all = document.createElement('option');
    all.value = '-1';
    all.textContent = 'Choose one';
    this.district.append(all);
    data.districts.forEach((name, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = districtName(name);
      this.district.append(o);
    });
    this.district.addEventListener('change', () => this.refresh());
    this.info = el('p', 'build-draw-status', this.panel);
    this.info.setAttribute('role', 'status');
    this.list = el('ul', 'cities-list', this.panel);
    el('p', 'budget-note', this.panel).textContent =
      "From the City's open data: schools with their pupils, kindergartens, health " +
      "centres' sites and police stations; fire stations, and everything beyond the City, " +
      "from OpenStreetMap. Kindergartens share the 32,390 children in the City's own (a " +
      "private one about 60), and health centres' sites the GP teams its residents need " +
      '(one for each 1,563, of 1,700 patients): estimates.';
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(on: boolean): void {
    this.shown = on;
    this.panel.hidden = !on;
    this.layer.hidden = !on;
    this.refresh();
  }

  /** Move the markers to where they are on screen (null: off screen). */
  place(project: (x: number, z: number) => [number, number] | null): void {
    if (!this.shown) return;
    this.data.services.forEach((s, i) => {
      const b = this.markers[i];
      if (!this.shownKinds.has(s.kind)) {
        b.hidden = true;
        return;
      }
      const at = project(s.x, s.z);
      b.hidden = at === null;
      if (at) b.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, -50%)`;
    });
  }

  private select(i: number | undefined): void {
    if (this.selected !== undefined) this.markers[this.selected].classList.remove('selected');
    this.selected = i;
    if (i === undefined) {
      this.info.textContent = '';
      return;
    }
    this.markers[i].classList.add('selected');
    const s = this.data.services[i];
    const k = SERVICE_KINDS[s.kind];
    const where =
      s.district >= 0 ? `in ${districtName(this.data.districts[s.district])}` : 'outside the City';
    this.info.textContent =
      `${k.one}: ${s.name || 'unnamed'}, ${where}` +
      (k.places ? `; about ${n(s.places)} ${k.places} (estimated).` : '.');
    this.callbacks.onShow(s);
  }

  private refresh(): void {
    const d = Number(this.district.value);
    const items = this.data.services
      .map((s, i) => [s, i] as const)
      .filter(([s]) => d >= 0 && s.district === d && this.shownKinds.has(s.kind))
      .slice(0, LISTED);
    this.list.replaceChildren(
      ...items.map(([s, i]) => {
        const item = document.createElement('li');
        const k = SERVICE_KINDS[s.kind];
        button(`${k.letter} ${s.name || k.one}`, item, () => this.select(i), k.one);
        if (k.places) {
          el('span', 'cities-meta', item).textContent = `about ${n(s.places)} ${k.places}`;
        }
        return item;
      }),
    );
    this.callbacks.invalidate();
  }
}
