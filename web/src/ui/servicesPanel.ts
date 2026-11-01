/**
 * Today's services (M20a): primary schools, kindergartens, health care, fire and police
 * stations, from the City's open data and OpenStreetMap (pipeline/services.py). The Services panel sums them up by kind and lists them by
 * district; their markers show on the map while it is open.
 */
import { districtName } from '../game/career';
import { NEED_KINDS, type NeedKind, REACH } from '../grow/coverage';
import { euros } from '../grow/economy';
import { NEW_SERVICE } from '../grow/newServices';
import { button, el } from './buildPanel';

export {
  type Service,
  SERVICE_KINDS,
  type ServiceKind,
  type ServicesData,
} from '../game/serviceKinds';
import {
  type Service,
  SERVICE_KINDS,
  type ServiceKind,
  type ServicesData,
} from '../game/serviceKinds';

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
  /** Colour the zoned lots by coverage, or not (M20b). */
  onCoverageMap?(on: boolean): void;
  /** Place a new service of this kind with the next click on the map, or stop (M20c). */
  onPlace?(kind: ServiceKind | undefined): void;
}

/** Residents short of places within reach, and the places short, of each kind (the City's;
 * grow/coverage.ts `shortfall`). */
export type CoverageSummary = Record<NeedKind, { residents: number; short: number; total: number }>;

export class ServicesPanel {
  private readonly panel: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly list: HTMLElement;
  private readonly info: HTMLElement;
  private readonly district: HTMLSelectElement;
  private readonly coverageLines: HTMLElement;
  private readonly coverageMap: HTMLElement;
  private readonly newKind: HTMLSelectElement;
  private readonly placeButton: HTMLButtonElement;
  private readonly placeStatus: HTMLElement;
  private placing = false;
  private built: Service[] = [];
  private builtMarkers: HTMLButtonElement[] = [];
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
    el('h3', 'build-count', this.panel).textContent = 'Build one';
    const row = el('div', 'build-row', this.panel);
    const kindLabel = el('label', 'build-label', row);
    kindLabel.append('New ');
    this.newKind = el('select', 'build-select', kindLabel);
    this.newKind.setAttribute('aria-label', 'New service');
    for (const kind of KINDS) {
      const o = document.createElement('option');
      o.value = kind;
      o.textContent = SERVICE_KINDS[kind].one;
      this.newKind.append(o);
    }
    this.placeButton = button('Place on the map', row, () =>
      this.placing ? this.stopPlacing() : this.startPlacing(),
    );
    const about = el('p', 'build-note', this.panel);
    const describe = () => {
      const kind = this.newKind.value as ServiceKind;
      const k = NEW_SERVICE[kind];
      const places = SERVICE_KINDS[kind].places;
      about.textContent =
        (k.places && places ? `${n(k.places)} ${places}; ` : '') +
        `${euros(k.build)} to build, ${euros(k.upkeep)} a year to run; ` +
        `${n(k.staff)} staff (estimates).`;
    };
    this.newKind.addEventListener('change', () => {
      describe();
      if (this.placing) callbacks.onPlace?.(this.newKind.value as ServiceKind);
    });
    describe();
    this.placeStatus = el('p', 'build-draw-status', this.panel);
    this.placeStatus.setAttribute('role', 'status');
    el('h3', 'build-count', this.panel).textContent = 'Places within reach';
    this.coverageLines = el('div', 'services-coverage', this.panel);
    el('p', 'build-note', this.coverageLines).textContent = 'Measured once the traffic has loaded.';
    this.coverageMap = el('label', 'build-label services-kind', this.panel);
    this.coverageMap.hidden = true;
    const mapBox = el('input', '', this.coverageMap);
    mapBox.type = 'checkbox';
    mapBox.addEventListener('change', () => callbacks.onCoverageMap?.(mapBox.checked));
    this.coverageMap.append('Colour the lots by it (close in): green has places for all');
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
    if (!on && this.placing) this.stopPlacing();
    this.refresh();
  }

  private startPlacing(): void {
    this.placing = true;
    this.placeButton.textContent = 'Cancel';
    this.placeStatus.textContent = 'Click on the map where it should stand.';
    this.callbacks.onPlace?.(this.newKind.value as ServiceKind);
  }

  private stopPlacing(): void {
    this.placing = false;
    this.placeButton.textContent = 'Place on the map';
    this.placeStatus.textContent = '';
    this.callbacks.onPlace?.(undefined);
  }

  /** A service was placed (undefined) or could not be (why): stop placing. */
  placed(problem: string | undefined, name: string): void {
    this.stopPlacing();
    this.placeStatus.textContent = problem ?? `${name} built. Take it back from the Build edits.`;
  }

  /** The services built (M20c): their markers, among today's. */
  setBuilt(services: readonly Service[]): void {
    for (const b of this.builtMarkers) b.remove();
    this.built = [...services];
    this.builtMarkers = this.built.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'service-marker built';
      b.dataset.kind = s.kind;
      b.textContent = SERVICE_KINDS[s.kind].letter;
      const label = `${SERVICE_KINDS[s.kind].one}: ${s.name} (new)`;
      b.title = label;
      b.setAttribute('aria-label', label);
      this.layer.append(b);
      return b;
    });
    this.callbacks.invalidate();
  }

  /** The City's coverage as measured (M20b). */
  setCoverage(summary: CoverageSummary): void {
    this.coverageLines.replaceChildren(
      ...NEED_KINDS.map((kind) => {
        const c = summary[kind];
        const line = document.createElement('p');
        line.className = 'build-note';
        const pct = c.total > 0 ? Math.round((100 * c.residents) / c.total) : 0;
        const k = SERVICE_KINDS[kind];
        line.textContent =
          `${k.label}: ${pct} % of residents have fewer places than they need within ` +
          `${(REACH[kind] / 1000).toLocaleString('en-GB')} km, about ${n(c.short)} ` +
          `${k.places} short.`;
        return line;
      }),
    );
  }

  /** Offer to colour the lots by coverage (there are lots: Sandbox and Career). */
  enableCoverageMap(): void {
    this.coverageMap.hidden = false;
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
    this.built.forEach((s, i) => {
      const b = this.builtMarkers[i];
      const at = this.shownKinds.has(s.kind) ? project(s.x, s.z) : null;
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
