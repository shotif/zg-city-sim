/**
 * The Public transport panel (M9a): ZET's tram and bus lines and HŽ's trains, each with its
 * stops, trips by hour and the next departures, the vehicles running now and how late they
 * run in the simulation; the line picked is drawn on the map, its stops marked. ZET's lines
 * can be run more or less often (M9b).
 */
import {
  type Departure,
  FREQUENCIES,
  type Line,
  MODE_COLOR,
  MODE_NAME,
  type Mode,
  type Pattern,
  SET_FREQUENCY,
  type Timetable,
} from '../world/transitLines';
import { el } from './buildPanel';
import { formatClock } from './hud';

/** Departures listed at a stop, and lines listed at once. */
const STOP_DEPARTURES = 10;
const LIST_LIMIT = 80;

/** What the app does for the panel. */
export interface TransitPanelHost {
  onClose(): void;
  /** Draw trip `trip`'s route in `color` and mark `stops` (none: clear the map). */
  onShow(shown: { trip: number; color: number; stops: number[] } | undefined): void;
  /** Look at a stop. */
  onStop(x: number, z: number): void;
  /** Run line `route` `factor` times as often as timetabled (1: as timetabled). */
  onFrequency?(route: number, factor: number): void;
  /** What running line `route` `factor` times as often comes to, in a sentence. */
  frequencyNote?(route: number, factor: number): string;
}

type View =
  | { kind: 'list' }
  | { kind: 'line'; line: Line; pattern: number }
  | { kind: 'stop'; stop: number; from?: { line: Line; pattern: number } };

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

export class TransitPanel {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private view: View = { kind: 'list' };
  private query = '';
  private modes = new Set<Mode>(['tram', 'bus', 'train']);
  private shown = false;
  private time = 0;
  /** Two numbers per vehicle running: its trip and how late it is (s). */
  private running: Float32Array = new Float32Array(0);
  /** Trips of the pattern shown, for its departures and vehicles. */
  private trips = new Set<number>();
  /** How often lines run, by route, where edits change it. */
  private frequencies = new Map<number, number>();
  /** What the line or stop view shows: its controls, and what changes as time goes on. */
  private lastHead = '';
  private lastLive = '';

  constructor(
    parent: HTMLElement,
    private readonly timetable: Timetable,
    private readonly host: TransitPanelHost,
  ) {
    this.panel = el('aside', 'hud-panel transit-panel', parent);
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Public transport');
    const header = el('div', 'news-header', this.panel);
    el('h2', 'build-title', header).textContent = 'Public transport';
    const close = el('button', 'hud-button hud-icon', header);
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close (P)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => host.onClose());
    this.body = el('div', 'transit-body', this.panel);
    this.body.addEventListener('click', (event) => this.onClick(event));
    this.body.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      if (target.name === 'transit-search') {
        this.query = target.value;
        this.render(true);
      }
    });
    this.body.addEventListener('change', (event) => {
      const target = event.target as HTMLSelectElement;
      if (target.name === 'transit-pattern' && this.view.kind === 'line') {
        this.openLine(this.view.line, Number(target.value));
      } else if (target.name === 'transit-frequency' && this.view.kind === 'line') {
        host.onFrequency?.(this.view.line.route, Number(target.value));
      }
    });
  }

  get visible(): boolean {
    return this.shown;
  }

  get element(): HTMLElement {
    return this.panel;
  }

  setVisible(shown: boolean): void {
    this.shown = shown;
    this.panel.hidden = !shown;
    if (shown) this.render(true);
    else this.host.onShow(undefined);
  }

  /** The simulated time and the vehicles running (wasm.ts `transitState`). */
  update(time: number, running?: Float32Array): void {
    this.time = time;
    if (running) this.running = running;
    if (this.shown) this.render(false);
  }

  /** How often lines run where edits change it (route to factor). */
  setFrequencies(frequencies: Map<number, number>): void {
    this.frequencies = frequencies;
    if (this.shown) this.render(true);
  }

  /** The trips that run changed (`Timetable.setService`): count and list them again. */
  refresh(): void {
    if (this.view.kind === 'line') {
      const p = this.view.line.patterns[this.view.pattern];
      this.trips = new Set(p ? this.timetable.patternTrips(this.view.line.route, p) : []);
    }
    if (this.shown) this.render(true);
  }

  /** Open a stop's departures (a stop marker tapped). */
  openStop(stop: number): void {
    const from = this.view.kind === 'line' ? this.view : undefined;
    this.view = {
      kind: 'stop',
      stop,
      from: from && { line: from.line, pattern: from.pattern },
    };
    const { x, z } = this.timetable.stop(stop);
    this.host.onStop(x, z);
    this.render(true);
  }

  private openLine(line: Line, pattern: number): void {
    this.view = { kind: 'line', line, pattern };
    const p = line.patterns[pattern];
    const trips = p ? this.timetable.patternTrips(line.route, p) : [];
    this.trips = new Set(trips);
    const mode = this.timetable.routes[line.route].mode;
    this.host.onShow(
      p && trips.length ? { trip: trips[0], color: MODE_COLOR[mode], stops: p.stops } : undefined,
    );
    this.render(true);
  }

  private onClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const { action, value } = target.dataset;
    const n = Number(value);
    if (action === 'line') {
      const line = this.timetable.line(n);
      if (line) this.openLine(line, 0);
    } else if (action === 'stop') {
      this.openStop(n);
    } else if (action === 'mode') {
      const mode = value as Mode;
      if (this.modes.has(mode)) this.modes.delete(mode);
      else this.modes.add(mode);
      this.render(true);
    } else if (action === 'back') {
      if (this.view.kind === 'stop' && this.view.from) {
        this.openLine(this.view.from.line, this.view.from.pattern);
      } else {
        this.view = { kind: 'list' };
        this.host.onShow(undefined);
        this.render(true);
      }
    }
  }

  /** Write the panel for the view; `force` also rebuilds what keeps focus (the search, the
   * line's selects). */
  private render(force: boolean): void {
    if (this.view.kind === 'list') {
      if (force) this.renderList();
      return;
    }
    const { head, live } =
      this.view.kind === 'line' ? this.lineHtml(this.view) : this.stopHtml(this.view);
    let headEl = this.body.querySelector<HTMLElement>(':scope > .transit-head');
    let liveEl = this.body.querySelector<HTMLElement>(':scope > .transit-live');
    if (!headEl || !liveEl) {
      this.body.innerHTML = '<div class="transit-head"></div><div class="transit-live"></div>';
      headEl = this.body.querySelector<HTMLElement>('.transit-head')!;
      liveEl = this.body.querySelector<HTMLElement>('.transit-live')!;
      force = true;
    }
    if (force || head !== this.lastHead) headEl.innerHTML = head;
    if (force || live !== this.lastLive) liveEl.innerHTML = live;
    this.lastHead = head;
    this.lastLive = live;
  }

  private badge(route: number): string {
    const r = this.timetable.routes[route];
    const label = r.name || MODE_NAME[r.mode];
    return `<span class="transit-badge" style="background:${hex(MODE_COLOR[r.mode])}">${escape(label)}</span>`;
  }

  private renderList(): void {
    const { lines, stops } = this.timetable.search(this.query);
    const shown = lines.filter((l) => this.modes.has(this.timetable.routes[l.route].mode));
    const chips = (['tram', 'bus', 'train'] as Mode[])
      .map(
        (m) =>
          `<button type="button" class="hud-button hud-speed" data-action="mode" data-value="${m}" aria-pressed="${this.modes.has(m)}">${MODE_NAME[m]}s</button>`,
      )
      .join('');
    const stopItems = stops
      .map(
        (s) =>
          `<li><button type="button" class="transit-item" data-action="stop" data-value="${s}"><span class="transit-stop-dot"></span>${escape(this.timetable.stop(s).name)}</button></li>`,
      )
      .join('');
    const lineItems = shown
      .slice(0, LIST_LIMIT)
      .map((l) => {
        const r = this.timetable.routes[l.route];
        return `<li><button type="button" class="transit-item" data-action="line" data-value="${l.route}">${this.badge(l.route)}<span>${escape(r.longName)}</span><small>${this.timetable.tripsToday(l.route)} trips</small></button></li>`;
      })
      .join('');
    const more =
      shown.length > LIST_LIMIT
        ? `<p class="budget-note">${shown.length - LIST_LIMIT} more: search to narrow.</p>`
        : '';
    // Keep the search box (and its focus) when only the list changes.
    let search = this.body.querySelector<HTMLInputElement>('input[name="transit-search"]');
    if (!search) {
      this.body.innerHTML =
        '<input class="build-select transit-search" name="transit-search" type="search" ' +
        'placeholder="Line or stop" aria-label="Find a line or stop" autocomplete="off">' +
        '<div class="transit-modes"></div><ul class="transit-list"></ul>';
      search = this.body.querySelector<HTMLInputElement>('input[name="transit-search"]')!;
      search.value = this.query;
    }
    this.body.querySelector('.transit-modes')!.innerHTML = chips;
    this.body.querySelector('.transit-list')!.innerHTML =
      stopItems + lineItems + (stopItems || lineItems ? '' : '<li>Nothing found.</li>');
    this.body.querySelectorAll('.transit-more').forEach((m) => m.remove());
    if (more) this.body.insertAdjacentHTML('beforeend', `<div class="transit-more">${more}</div>`);
    this.lastHead = '';
    this.lastLive = '';
  }

  private lineHtml(view: { line: Line; pattern: number }): { head: string; live: string } {
    const { line } = view;
    const r = this.timetable.routes[line.route];
    const p: Pattern | undefined = line.patterns[view.pattern];
    const options = line.patterns
      .map(
        (q, i) =>
          `<option value="${i}"${i === view.pattern ? ' selected' : ''}>to ${escape(q.headsign)} (${q.trips} trips)</option>`,
      )
      .join('');
    // Vehicles of this line running now, and how late.
    let running = 0;
    let late = 0;
    for (let k = 0; k + 1 < this.running.length; k += 2) {
      const t = this.running[k];
      if (this.trips.has(t)) {
        running++;
        late += this.running[k + 1];
      }
    }
    const lateText = running > 0 ? `, ${Math.round(late / running / 60)} min late on average` : '';
    const hours = this.timetable.tripsByHour(line.route);
    const top = Math.max(1, ...hours);
    const bars = hours
      .map(
        (n, h) =>
          `<rect x="${h * 10 + 1}" y="${40 - (n / top) * 38}" width="8" height="${(n / top) * 38}" rx="1"><title>${String(h).padStart(2, '0')}:00, ${n} trips</title></rect>`,
      )
      .join('');
    const stops = (p?.stops ?? [])
      .map((s) => {
        const next = this.timetable.departures([s], this.time, 1, this.trips)[0];
        return `<li><button type="button" class="transit-item" data-action="stop" data-value="${s}"><span class="transit-stop-dot" style="border-color:${hex(MODE_COLOR[r.mode])}"></span><span>${escape(this.timetable.stop(s).name)}</span><small>${next ? formatClock(next.time) : ''}</small></button></li>`;
      })
      .join('');
    const factor = this.frequencies.get(line.route) ?? 1;
    const frequencies = FREQUENCIES.map(
      (f) =>
        `<option value="${f.factor}"${f.factor === factor ? ' selected' : ''}>${f.label}</option>`,
    ).join('');
    const service =
      SET_FREQUENCY.has(r.mode) && this.host.onFrequency
        ? `<label class="transit-service">Service <select class="build-select" name="transit-frequency">${frequencies}</select></label>` +
          `<p class="budget-note">${escape(this.host.frequencyNote?.(line.route, factor) ?? '')}</p>`
        : r.mode === 'train'
          ? '<p class="budget-note">HŽ runs its trains to its own timetable.</p>'
          : '';
    const today = this.timetable.tripsToday(line.route);
    const timetabled = today === line.trips ? '' : ` (${line.trips} timetabled)`;
    return {
      head:
        `<button type="button" class="hud-button hud-speed transit-back" data-action="back">‹ All lines</button>` +
        `<h3 class="transit-title">${this.badge(line.route)} ${escape(r.longName)}</h3>` +
        (line.patterns.length > 1
          ? `<select class="build-select" name="transit-pattern" aria-label="Direction">${options}</select>`
          : p
            ? `<p class="budget-note">To ${escape(p.headsign)}</p>`
            : '') +
        service,
      live:
        `<p class="transit-stats">${today} trips today${timetabled}; ${running} running now${lateText}.</p>` +
        `<svg class="transit-hours" viewBox="0 0 240 52" role="img" aria-label="Trips by hour">${bars}` +
        `<text x="0" y="51">00</text><text x="114" y="51">12</text><text x="226" y="51">23</text></svg>` +
        `<h4 class="build-count">Stops, and the next departure from each</h4>` +
        `<ol class="transit-list transit-stops">${stops}</ol>`,
    };
  }

  private stopHtml(view: { stop: number; from?: { line: Line; pattern: number } }): {
    head: string;
    live: string;
  } {
    const platforms = this.timetable.platforms(view.stop);
    const next: Departure[] = this.timetable.departures(platforms, this.time, STOP_DEPARTURES);
    const rows = next
      .map(
        (d) =>
          `<tr><td>${formatClock(d.time)}</td><td>${this.badge(d.route)}</td><td>${escape(d.headsign)}</td></tr>`,
      )
      .join('');
    const back = view.from ? '‹ Back to the line' : '‹ All lines';
    return {
      head:
        `<button type="button" class="hud-button hud-speed transit-back" data-action="back">${back}</button>` +
        `<h3 class="transit-title">${escape(this.timetable.stop(view.stop).name)}</h3>`,
      live: rows
        ? `<p class="budget-note">The next departures, as timetabled:</p><table class="rail-table">${rows}</table>`
        : '<p class="budget-note">No departures from here.</p>',
    };
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Markers for the stops of the line shown; tapping one opens its departures. */
export class StopMarkers {
  private readonly layer: HTMLElement;
  private buttons: { stop: number; x: number; z: number; button: HTMLButtonElement }[] = [];

  constructor(
    parent: HTMLElement,
    private readonly timetable: Timetable,
    private readonly onStop: (stop: number) => void,
  ) {
    this.layer = el('div', 'news-markers transit-markers', parent);
    parent.prepend(this.layer);
  }

  get visible(): boolean {
    return this.buttons.length > 0;
  }

  /** Mark `stops` in `color` (none: clear). */
  set(stops: number[], color: number): void {
    this.layer.replaceChildren();
    this.buttons = stops.map((stop) => {
      const { name, x, z } = this.timetable.stop(stop);
      const button = el('button', 'transit-marker', this.layer);
      button.type = 'button';
      button.title = name;
      button.setAttribute('aria-label', `${name} stop`);
      button.style.borderColor = hex(color);
      button.addEventListener('click', () => this.onStop(stop));
      return { stop, x, z, button };
    });
  }

  /** Move the markers to where their stops are on screen (null: off screen). */
  place(project: (x: number, z: number) => [number, number] | null): void {
    for (const { x, z, button } of this.buttons) {
      const at = project(x, z);
      button.hidden = at === null;
      if (at) button.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, -50%)`;
    }
  }
}
