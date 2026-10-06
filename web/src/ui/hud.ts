import type { ViewMode } from '../camera/CameraRig';
import { formatDistance, niceScaleLength } from '../camera/viewMath';
import type { Attribution } from '../manifest';

export interface HudCallbacks {
  onMode(mode: ViewMode): void;
  onRotateIso(direction: 1 | -1): void;
  onFaceNorth(): void;
  onPause?(paused: boolean): void;
  onSpeed?(speed: number): void;
  onTrafficMap?(enabled: boolean): void;
  onNews?(enabled: boolean): void;
  onClosures?(enabled: boolean): void;
  onBuild?(enabled: boolean): void;
}

/** A colour and its meaning, for the traffic map legend. */
export interface LegendEntry {
  color: number;
  label: string;
}

/** What the simulation panel shows. */
export interface HudSim {
  /** Simulated time, s since midnight. */
  time: number;
  paused: boolean;
  speed: number;
  /** Simulated seconds per real second actually achieved. */
  rate: number;
  warming: boolean;
  vehicles: number;
  /** Vehicles coming from or going to places beyond the map. */
  outside: number;
  trams: number;
  buses: number;
  /** Mean speed of all traffic, km/h. */
  meanSpeed: number;
}

export const SIM_SPEEDS = [1, 4, 16, 64];

/** "07:05" for a time in seconds since midnight. */
export function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface HudView {
  mode: ViewMode;
  azimuth: number;
  /** Metres of ground per CSS pixel at the screen centre. */
  metersPerPixel: number;
}

const MODES: { mode: ViewMode; label: string; key: string }[] = [
  { mode: 'map', label: 'Map', key: '1' },
  { mode: 'iso', label: 'Isometric', key: '2' },
  { mode: 'free', label: '3D', key: '3' },
];

const SCALE_BAR_MAX_PX = 120;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

/** The overlay UI: view switcher, compass, scale bar, credits, loading and error screens. */
export class Hud {
  private readonly root: HTMLElement;
  private readonly modeButtons = new Map<ViewMode, HTMLButtonElement>();
  private readonly isoRotate: HTMLElement;
  private readonly compass: HTMLButtonElement;
  private readonly compassNeedle: HTMLElement;
  private readonly scale: HTMLElement;
  private readonly scaleBar: HTMLElement;
  private readonly scaleLabel: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly creditsList: HTMLElement;
  private readonly credits: HTMLDialogElement;
  private readonly status: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly sim: HTMLElement;
  private readonly simClock: HTMLElement;
  private readonly simInfo: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly speedButtons = new Map<number, HTMLButtonElement>();
  private readonly trafficButton: HTMLButtonElement;
  private readonly legend: HTMLElement;
  private readonly layers: HTMLElement;
  private readonly newsButton: HTMLButtonElement;
  private readonly closuresButton: HTMLButtonElement;
  private readonly buildButton: HTMLButtonElement;
  private simState?: HudSim;
  private trafficMap = false;
  private news = false;
  private closures = true;
  private build = false;

  constructor(container: HTMLElement, callbacks: HudCallbacks) {
    this.root = el('div', 'hud', container);

    const left = el('div', 'hud-left', this.root);
    const title = el('div', 'hud-panel hud-title', left);
    title.innerHTML = '<strong>ZG City Sim</strong><span>Zagreb · prototype</span>';

    this.sim = el('div', 'hud-panel hud-sim', left);
    this.sim.hidden = true;
    const clockRow = el('div', 'hud-sim-row', this.sim);
    this.simClock = el('span', 'hud-sim-clock', clockRow);
    this.pauseButton = el('button', 'hud-button hud-icon', clockRow);
    this.pauseButton.type = 'button';
    this.pauseButton.addEventListener('click', () => {
      if (this.simState) callbacks.onPause?.(!this.simState.paused);
    });
    const speeds = el('div', 'hud-sim-speeds', clockRow);
    speeds.setAttribute('role', 'group');
    speeds.setAttribute('aria-label', 'Simulation speed');
    for (const speed of SIM_SPEEDS) {
      const button = el('button', 'hud-button hud-speed', speeds);
      button.type = 'button';
      button.textContent = `${speed}×`;
      button.title = speed === 1 ? 'Real time' : `${speed} times real time`;
      button.addEventListener('click', () => callbacks.onSpeed?.(speed));
      this.speedButtons.set(speed, button);
    }
    this.simInfo = el('div', 'hud-sim-info', this.sim);
    const mapRow = el('div', 'hud-sim-row', this.sim);
    this.trafficButton = el('button', 'hud-button hud-speed', mapRow);
    this.trafficButton.type = 'button';
    this.trafficButton.textContent = 'Traffic map';
    this.trafficButton.title = 'Colour roads by how fast traffic moves (T)';
    this.trafficButton.setAttribute('aria-pressed', 'false');
    this.trafficButton.addEventListener('click', () => this.toggleTrafficMap(callbacks));
    this.legend = el('div', 'hud-legend', mapRow);
    this.legend.hidden = true;

    this.layers = el('div', 'hud-panel hud-layers', left);
    this.layers.hidden = true;
    this.newsButton = el('button', 'hud-button hud-speed', this.layers);
    this.newsButton.type = 'button';
    this.newsButton.textContent = 'News reports';
    this.newsButton.setAttribute('aria-pressed', 'false');
    this.newsButton.hidden = true;
    this.newsButton.addEventListener('click', () => this.toggleNews(callbacks));
    this.closuresButton = el('button', 'hud-button hud-speed', this.layers);
    this.closuresButton.type = 'button';
    this.closuresButton.textContent = 'Closures';
    this.closuresButton.hidden = true;
    this.closuresButton.setAttribute('aria-pressed', 'true');
    this.closuresButton.addEventListener('click', () => this.toggleClosures(callbacks));
    this.buildButton = el('button', 'hud-button hud-speed', this.layers);
    this.buildButton.type = 'button';
    this.buildButton.textContent = 'Build';
    this.buildButton.title = 'Change roads, lanes, turns and signals (B)';
    this.buildButton.hidden = true;
    this.buildButton.setAttribute('aria-pressed', 'false');
    this.buildButton.addEventListener('click', () => this.setBuild(!this.build, callbacks));

    const toolbar = el('div', 'hud-panel hud-toolbar', this.root);
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'View');
    for (const { mode, label, key } of MODES) {
      const button = el('button', 'hud-button', toolbar);
      button.type = 'button';
      button.textContent = label;
      button.title = `${label} view (${key})`;
      button.addEventListener('click', () => callbacks.onMode(mode));
      this.modeButtons.set(mode, button);
    }
    this.isoRotate = el('div', 'hud-iso-rotate', toolbar);
    for (const [direction, symbol, label] of [
      [-1, '⟲', 'Rotate left (Q)'],
      [1, '⟳', 'Rotate right (E)'],
    ] as const) {
      const button = el('button', 'hud-button hud-icon', this.isoRotate);
      button.type = 'button';
      button.textContent = symbol;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', () => callbacks.onRotateIso(direction));
    }

    this.compass = el('button', 'hud-panel hud-compass', this.root);
    this.compass.type = 'button';
    this.compass.title = 'Face north';
    this.compass.setAttribute('aria-label', 'Face north');
    this.compassNeedle = el('span', 'hud-compass-needle', this.compass);
    this.compassNeedle.textContent = 'N';
    this.compass.addEventListener('click', () => callbacks.onFaceNorth());

    const footer = el('div', 'hud-footer', this.root);
    this.scale = el('div', 'hud-panel hud-scale', footer);
    this.scaleBar = el('div', 'hud-scale-bar', this.scale);
    this.scaleLabel = el('span', 'hud-scale-label', this.scale);
    this.hint = el('div', 'hud-panel hud-hint', footer);
    const creditsButton = el('button', 'hud-panel hud-button hud-credits-button', footer);
    creditsButton.type = 'button';
    creditsButton.textContent = 'Data & credits';

    this.credits = el('dialog', 'hud-credits', this.root);
    this.credits.innerHTML =
      '<h2>Data & credits</h2><p>ZG City Sim is built from open data.</p><ul></ul>' +
      '<p class="hud-status"></p><form method="dialog"><button class="hud-button">Close</button></form>';
    this.creditsList = this.credits.querySelector('ul')!;
    this.status = this.credits.querySelector('.hud-status')!;
    creditsButton.addEventListener('click', () => this.credits.showModal());

    this.notice = el('div', 'hud-panel hud-notice', this.root);
    this.notice.hidden = true;
    this.notice.setAttribute('role', 'status');

    this.overlay = el('div', 'hud-overlay', container);
    this.setLoading('Loading Zagreb…');

    window.addEventListener('keydown', (event) => {
      const typing =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
      if (typing || event.metaKey || event.ctrlKey) return;
      const mode = MODES.find((m) => m.key === event.key)?.mode;
      if (mode) callbacks.onMode(mode);
      else if (event.key === 'q' || event.key === 'Q') callbacks.onRotateIso(-1);
      else if (event.key === 'e' || event.key === 'E') callbacks.onRotateIso(1);
      else if (event.key === ' ' && this.simState) {
        event.preventDefault();
        callbacks.onPause?.(!this.simState.paused);
      } else if ((event.key === 't' || event.key === 'T') && this.simState) {
        this.toggleTrafficMap(callbacks);
      } else if ((event.key === 'n' || event.key === 'N') && !this.newsButton.hidden) {
        this.toggleNews(callbacks);
      } else if ((event.key === 'c' || event.key === 'C') && !this.closuresButton.hidden) {
        this.toggleClosures(callbacks);
      } else if ((event.key === 'b' || event.key === 'B') && !this.buildButton.hidden) {
        this.setBuild(!this.build, callbacks);
      } else if ((event.key === '+' || event.key === '-') && this.simState) {
        const i = SIM_SPEEDS.indexOf(this.simState.speed) + (event.key === '+' ? 1 : -1);
        const speed = SIM_SPEEDS[Math.min(SIM_SPEEDS.length - 1, Math.max(0, i))];
        callbacks.onSpeed?.(speed);
      }
    });
  }

  setLoading(message: string): void {
    this.overlay.className = 'hud-overlay';
    this.overlay.innerHTML = '<div class="hud-spinner"></div><p></p>';
    this.overlay.querySelector('p')!.textContent = message;
  }

  setError(message: string): void {
    this.overlay.className = 'hud-overlay hud-overlay-error';
    this.overlay.innerHTML = '<h2>Something went wrong</h2><p></p>';
    this.overlay.querySelector('p')!.textContent = message;
  }

  /** A small status message above the footer; null hides it. */
  setNotice(message: string | null): void {
    this.notice.hidden = message === null;
    this.notice.textContent = message ?? '';
  }

  ready(): void {
    this.overlay.classList.add('hud-overlay-hidden');
  }

  setCredits(attributions: Attribution[], status: string): void {
    this.creditsList.replaceChildren(
      ...attributions.map((a) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = a.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = a.name;
        item.append(link, document.createTextNode(`: ${a.text}`));
        return item;
      }),
    );
    this.status.textContent = status;
  }

  /** The element overlays such as map markers go in. */
  get element(): HTMLElement {
    return this.root;
  }

  /** Offer the news layer: `places` places with `reports` reports. */
  enableNews(places: number, reports: number): void {
    this.layers.hidden = false;
    this.newsButton.hidden = false;
    this.newsButton.title = `Traffic news: ${reports} reports at ${places} places (N)`;
  }

  /** Offer the live closures layer (on by default). */
  enableClosures(count: number, fetched: string): void {
    this.layers.hidden = false;
    this.closuresButton.hidden = false;
    this.closuresButton.textContent = `Closures (${count})`;
    const when = new Date(fetched);
    const age = Number.isNaN(when.getTime())
      ? ''
      : `, as of ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    this.closuresButton.title = `Road closures from the City of Zagreb${age} (C)`;
  }

  /** Offer the Build tools. */
  enableBuild(): void {
    this.layers.hidden = false;
    this.buildButton.hidden = false;
  }

  /** Turn the Build tools on or off (`callbacks` given: tell the app). */
  setBuild(enabled: boolean, callbacks?: HudCallbacks): void {
    this.build = enabled;
    this.buildButton.setAttribute('aria-pressed', String(enabled));
    callbacks?.onBuild?.(enabled);
  }

  private toggleClosures(callbacks: HudCallbacks): void {
    this.closures = !this.closures;
    this.closuresButton.setAttribute('aria-pressed', String(this.closures));
    callbacks.onClosures?.(this.closures);
  }

  private toggleNews(callbacks: HudCallbacks): void {
    this.news = !this.news;
    this.newsButton.setAttribute('aria-pressed', String(this.news));
    callbacks.onNews?.(this.news);
  }

  private toggleTrafficMap(callbacks: HudCallbacks): void {
    this.trafficMap = !this.trafficMap;
    this.trafficButton.setAttribute('aria-pressed', String(this.trafficMap));
    this.legend.hidden = !this.trafficMap;
    callbacks.onTrafficMap?.(this.trafficMap);
  }

  /** Colours of the traffic map, shown next to its button while it is on. */
  setTrafficLegend(entries: LegendEntry[]): void {
    this.legend.replaceChildren(
      ...entries.map(({ color, label }) => {
        const item = document.createElement('span');
        const swatch = document.createElement('i');
        swatch.style.background = `#${color.toString(16).padStart(6, '0')}`;
        item.append(swatch, document.createTextNode(label));
        return item;
      }),
    );
  }

  /** Show the simulation panel with the current time, speed and traffic. */
  updateSim(sim: HudSim): void {
    const changed =
      !this.simState ||
      this.simState.paused !== sim.paused ||
      this.simState.speed !== sim.speed ||
      this.simState.warming !== sim.warming;
    this.simState = sim;
    this.sim.hidden = false;
    this.simClock.textContent = formatClock(sim.time);
    if (changed) {
      this.pauseButton.textContent = sim.paused ? '▶' : '⏸';
      const label = sim.paused ? 'Resume (space)' : 'Pause (space)';
      this.pauseButton.title = label;
      this.pauseButton.setAttribute('aria-label', label);
      for (const [speed, button] of this.speedButtons) {
        button.setAttribute('aria-pressed', String(speed === sim.speed));
      }
    }
    const lagging = !sim.paused && !sim.warming && sim.rate < sim.speed * 0.8;
    this.simInfo.textContent = sim.warming
      ? 'Filling the streets with traffic…'
      : `${sim.vehicles.toLocaleString('en')} vehicles ` +
        `(${sim.outside.toLocaleString('en')} crossing the map's edge) · ` +
        `${sim.trams} trams · ${sim.buses} buses · ` +
        `${Math.round(sim.meanSpeed)} km/h` +
        (lagging ? ` · running at ${sim.rate.toFixed(sim.rate < 10 ? 1 : 0)}×` : '');
  }

  update(view: HudView): void {
    for (const [mode, button] of this.modeButtons) {
      button.setAttribute('aria-pressed', String(mode === view.mode));
    }
    this.isoRotate.hidden = view.mode !== 'iso';
    this.compass.disabled = view.mode !== 'free';
    this.compassNeedle.style.transform = `rotate(${(view.azimuth * 180) / Math.PI}deg)`;

    const length = niceScaleLength(view.metersPerPixel * SCALE_BAR_MAX_PX);
    this.scale.hidden = view.mode !== 'map' || length === 0;
    this.scaleBar.style.width = `${length / view.metersPerPixel}px`;
    this.scaleLabel.textContent = formatDistance(length);

    const touch = matchMedia('(pointer: coarse)').matches;
    this.hint.textContent =
      view.mode === 'free'
        ? touch
          ? 'Drag to move · pinch to zoom · two fingers to rotate and tilt'
          : 'Drag to move · scroll to zoom · right-drag to rotate and tilt'
        : touch
          ? 'Drag to move · pinch to zoom'
          : 'Drag to move · scroll to zoom · arrow keys pan';
  }
}
