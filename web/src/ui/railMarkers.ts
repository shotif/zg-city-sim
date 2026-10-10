/**
 * HŽ's stations and the level crossings on the traffic map (M8e): a marker for each, a
 * crossing's coloured by its barriers, and a panel for the one tapped: a station's next
 * trains from the timetable, or a crossing's state and how long its barriers were down in
 * the last hour.
 */
import { formatClock } from './hud';

/** A train's call at a station: arrival and departure (s since midnight), the train's
 * number, where it comes from and where it goes ('' at its first and last station). */
export type Call = [number, number, string, string, string];

/** A station as the pipeline writes it (`transit/stations.json`). */
export interface Station {
  name: string;
  x: number;
  z: number;
  calls: Call[];
}

const DAY = 86_400;
const HOUR = 3_600;
/** Trains listed in a station's panel. */
const NEXT_TRAINS = 6;

/** When a train leaves the station, or gets there if it ends there (s since midnight). */
export function callTime(call: Call): number {
  return call[4] ? call[1] : call[0];
}

/** The next `n` calls at or after `time` (s, any day), soonest first, wrapping to the next
 * day's timetable after the last train. */
export function nextCalls(calls: Call[], time: number, n: number = NEXT_TRAINS): Call[] {
  const now = ((time % DAY) + DAY) % DAY;
  const wait = (c: Call) => (((callTime(c) - now) % DAY) + DAY) % DAY;
  return [...calls].sort((a, b) => wait(a) - wait(b)).slice(0, n);
}

/** "to Dugo Selo", "from Harmica, ends here" or "starts here, to Zabok". */
export function describeCall(call: Call): string {
  const [, , , from, to] = call;
  if (!to) return `from ${from}, ends here`;
  if (!from) return `starts here, to ${to}`;
  return `to ${to}`;
}

/**
 * Closures and seconds closed at each level crossing, sampled once a simulated minute, to
 * say how long its barriers were down in the last hour.
 */
export class CrossingHistory {
  /** Per junction: [time, closures, seconds closed] samples, oldest first. */
  private readonly samples = new Map<number, [number, number, number][]>();
  private last = -Infinity;

  /** Take a sample of `state` (wasm.ts `levelCrossings`) at `time`, at most once a minute.
   * Counts that go back (a new network, a new day) start the history again. */
  record(time: number, state: Float32Array): void {
    if (time < this.last) this.samples.clear();
    else if (time - this.last < 60) return;
    this.last = time;
    for (let c = 0; c + 3 < state.length; c += 4) {
      const j = state[c];
      let list = this.samples.get(j);
      const prev = list?.[list.length - 1];
      if (!list || (prev && (state[c + 2] < prev[1] || state[c + 3] < prev[2]))) {
        list = [];
        this.samples.set(j, list);
      }
      list.push([time, state[c + 2], state[c + 3]]);
      while (list.length > 2 && list[1][0] <= time - HOUR) list.shift();
    }
  }

  /** Closures and seconds closed at junction `j` from `since` (an hour ago, or the first
   * sample if later) to now (`closures`, `seconds`: the counts now). */
  lastHour(
    j: number,
    time: number,
    closures: number,
    seconds: number,
  ): { since: number; closures: number; seconds: number } {
    const list = this.samples.get(j);
    const from = list?.[0];
    if (!from) return { since: time, closures: 0, seconds: 0 };
    return {
      since: Math.max(from[0], time - HOUR),
      closures: Math.max(0, closures - from[1]),
      seconds: Math.max(0, seconds - from[2]),
    };
  }
}

const STATES = ['open', 'lights', 'down'] as const;
const STATE_TEXT = {
  open: 'Open',
  lights: 'Lights flashing: a train is coming',
  down: 'Barriers down',
};

type Selected = { kind: 'station'; station: Station } | { kind: 'crossing'; junction: number };

/** Markers for the stations and level crossings, and the panel for the one tapped. */
export class RailMarkers {
  private readonly layer: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly stationButtons: HTMLButtonElement[];
  private crossingButtons: HTMLButtonElement[] = [];
  /** Junction and position of each level crossing marker. */
  private crossings: { junction: number; x: number; z: number }[] = [];
  private state: Float32Array = new Float32Array(0);
  private readonly history = new CrossingHistory();
  private selected?: Selected;
  private shown = false;
  private time = 0;
  private lastText = '';

  constructor(
    parent: HTMLElement,
    private readonly stations: Station[],
    /** Position (x, z) of junction `j`, and the names of the roads meeting there. */
    private readonly junction: (j: number) => { x: number; z: number; name: string },
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'news-markers rail-markers';
    this.layer.hidden = true;
    parent.prepend(this.layer);
    this.stationButtons = stations.map((station) => {
      const button = this.button('rail-station', `${station.name} station`);
      button.addEventListener('click', () => this.select({ kind: 'station', station }));
      return button;
    });
    this.panel = document.createElement('div');
    this.panel.className = 'hud-panel rail-info';
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'status');
    const head = document.createElement('div');
    head.className = 'rail-info-head';
    this.title = document.createElement('strong');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'hud-button hud-icon';
    close.textContent = '×';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.select(undefined));
    head.append(this.title, close);
    this.body = document.createElement('div');
    this.panel.append(head, this.body);
    parent.append(this.panel);
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(shown: boolean): void {
    this.shown = shown;
    this.layer.hidden = !shown;
    if (!shown) this.select(undefined);
  }

  /** The simulated time and the level crossings' state (wasm.ts `levelCrossings`). */
  update(time: number, state: Float32Array | undefined): void {
    this.time = time;
    if (state) {
      this.state = state;
      this.history.record(time, state);
      this.syncCrossings();
    }
    this.crossings.forEach((_, i) => {
      const s = STATES[this.state[4 * i + 1]] ?? 'open';
      const button = this.crossingButtons[i];
      if (button.dataset.state !== s) button.dataset.state = s;
    });
    this.render();
  }

  /** Move the markers to where they are on screen (null: off screen). */
  place(project: (x: number, z: number) => [number, number] | null): void {
    if (!this.shown) return;
    const put = (button: HTMLButtonElement, x: number, z: number) => {
      const at = project(x, z);
      button.hidden = at === null;
      if (at) button.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, -50%)`;
    };
    this.stations.forEach((s, i) => put(this.stationButtons[i], s.x, s.z));
    this.crossings.forEach((c, i) => put(this.crossingButtons[i], c.x, c.z));
  }

  private button(className: string, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = label;
    button.setAttribute('aria-label', label);
    this.layer.append(button);
    return button;
  }

  /** Markers for the crossings the engine has now (they change when roads are drawn). */
  private syncCrossings(): void {
    const n = Math.floor(this.state.length / 4);
    const same =
      n === this.crossings.length &&
      this.crossings.every((c, i) => c.junction === this.state[4 * i]);
    if (same) return;
    for (const b of this.crossingButtons) b.remove();
    this.crossings = [];
    this.crossingButtons = [];
    for (let i = 0; i < n; i++) {
      const j = this.state[4 * i];
      const { x, z, name } = this.junction(j);
      this.crossings.push({ junction: j, x, z });
      const button = this.button('rail-crossing', `Level crossing: ${name}`);
      button.addEventListener('click', () => this.select({ kind: 'crossing', junction: j }));
      this.crossingButtons.push(button);
    }
    if (this.selected?.kind === 'crossing') {
      const j = this.selected.junction;
      if (!this.crossings.some((c) => c.junction === j)) this.select(undefined);
    }
  }

  private select(selected: Selected | undefined): void {
    this.selected = selected;
    this.panel.hidden = !selected;
    this.lastText = '';
    this.render();
  }

  /** The panel's text for what is selected, written when it changes. */
  private render(): void {
    const sel = this.selected;
    if (!sel || this.panel.hidden) return;
    let title: string;
    let html: string;
    if (sel.kind === 'station') {
      title = sel.station.name;
      const next = nextCalls(sel.station.calls, this.time);
      const rows = next
        .map(
          (c) =>
            `<tr><td>${formatClock(callTime(c))}</td><td>${escape(c[2])}</td>` +
            `<td>${escape(describeCall(c))}</td></tr>`,
        )
        .join('');
      html = next.length
        ? `<p>The next trains, as timetabled:</p><table class="rail-table">${rows}</table>`
        : '<p>No trains call here.</p>';
    } else {
      const i = this.crossings.findIndex((c) => c.junction === sel.junction);
      const name = this.junction(sel.junction).name;
      title = `Level crossing, ${name}`;
      const s = STATES[this.state[4 * i + 1]] ?? 'open';
      const hour = this.history.lastHour(
        sel.junction,
        this.time,
        this.state[4 * i + 2],
        this.state[4 * i + 3],
      );
      const span =
        this.time - hour.since >= HOUR - 60
          ? 'In the last hour'
          : `Since ${formatClock(hour.since)}`;
      const minutes = Math.round(hour.seconds / 60);
      const closed =
        hour.closures > 0
          ? `${span}, the barriers came down ${hour.closures} ${hour.closures === 1 ? 'time' : 'times'}, ` +
            `for ${minutes < 1 ? 'under a minute' : `${minutes} min`} in all.`
          : `${span}, no train has passed.`;
      html = `<p class="rail-state" data-state="${s}">${STATE_TEXT[s]}</p><p>${closed}</p>`;
    }
    const text = title + html;
    if (text === this.lastText) return;
    this.lastText = text;
    this.title.textContent = title;
    this.body.innerHTML = html;
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
