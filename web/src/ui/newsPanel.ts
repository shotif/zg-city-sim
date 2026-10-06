import type { NewsData, NewsHotspot, NewsReport, PlaceTraffic } from '../world/newsLayer';
import { TRAFFIC_BANDS } from '../world/trafficLayer';

/** Marker colours by the worst severity reported at a place (1-3). */
const SEVERITY_COLORS = ['#f2c12e', '#f07c22', '#d7263d'];
const TYPE_LABELS: Record<string, string> = {
  jam: 'jam',
  roadworks: 'roadworks',
  closure: 'closure',
  crash: 'crash',
  event: 'event',
  critical_point: 'bottleneck',
  other: 'other',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

/** "26 Sep 2022" for an ISO date; "Undated" without one. */
export function formatReportDate(date: string | undefined): string {
  if (!date) return 'Undated';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : date;
}

/** How the simulation sees a place right now, in words. */
export function describeTraffic(traffic: PlaceTraffic | undefined | null): string {
  if (traffic === null) return 'Simulation not running yet.';
  if (!traffic) return 'Simulation: no traffic here in the last minute.';
  const band = TRAFFIC_BANDS.find((b) => traffic.share >= b.min) ?? TRAFFIC_BANDS[3];
  return (
    `Simulation now: ${band.label.toLowerCase()}, ${Math.round(traffic.kmh)} km/h ` +
    `(${Math.round(traffic.share * 100)} % of the speed limit).`
  );
}

/** Only web links open from the panel. */
function safeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export interface NewsPanelCallbacks {
  /** A place was chosen (undefined: the panel closed). */
  onSelect(hotspot: NewsHotspot | undefined): void;
}

/**
 * News hotspots as map markers (one per place, showing how many reports it has) and a panel
 * with the reports of the chosen place and how the simulation sees it now.
 */
export class NewsPanel {
  private readonly markers: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly traffic: HTMLElement;
  private readonly list: HTMLElement;
  private selected?: NewsHotspot;
  private shown = false;

  constructor(
    parent: HTMLElement,
    readonly data: NewsData,
    private readonly callbacks: NewsPanelCallbacks,
  ) {
    this.markers = el('div', 'news-markers');
    parent.prepend(this.markers);
    this.markers.hidden = true;
    for (const hotspot of data.hotspots) {
      const button = el('button', 'news-marker', this.markers);
      button.type = 'button';
      const count = hotspot.reports.length;
      button.textContent = String(count);
      const label = `${hotspot.name}: ${count} news report${count === 1 ? '' : 's'}`;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', 'false');
      const severity = Math.max(1, ...hotspot.reports.map((r) => r.severity ?? 1));
      button.style.background = SEVERITY_COLORS[Math.min(3, severity) - 1];
      const size = 22 + Math.min(14, 2 * (count - 1));
      button.style.width = button.style.height = `${size}px`;
      button.addEventListener('click', () =>
        this.select(this.selected === hotspot ? undefined : hotspot),
      );
      this.buttons.set(hotspot.id, button);
    }

    this.panel = el('aside', 'hud-panel news-panel', parent);
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'News reports');
    const header = el('div', 'news-header', this.panel);
    this.title = el('h2', 'news-title', header);
    const close = el('button', 'hud-button hud-icon', header);
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.select(undefined));
    this.traffic = el('p', 'news-traffic', this.panel);
    this.list = el('ul', 'news-list', this.panel);
    const about = el('p', 'news-about', this.panel);
    about.textContent = data.about;

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.selected) this.select(undefined);
    });
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Show or hide the markers (hiding also closes the panel). */
  setVisible(shown: boolean): void {
    this.shown = shown;
    this.markers.hidden = !shown;
    if (!shown) this.select(undefined);
  }

  /** Move the markers to where their places are on screen (null: off screen). */
  place(project: (hotspot: NewsHotspot) => [number, number] | null): void {
    if (!this.shown) return;
    for (const hotspot of this.data.hotspots) {
      const button = this.buttons.get(hotspot.id)!;
      const at = project(hotspot);
      button.hidden = at === null;
      if (at) button.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, -50%)`;
    }
  }

  select(hotspot: NewsHotspot | undefined): void {
    if (this.selected) this.buttons.get(this.selected.id)?.setAttribute('aria-pressed', 'false');
    this.selected = hotspot;
    this.panel.hidden = !hotspot;
    if (hotspot) {
      this.buttons.get(hotspot.id)?.setAttribute('aria-pressed', 'true');
      this.title.textContent = hotspot.name;
      this.list.replaceChildren(...hotspot.reports.map((r) => this.reportItem(r)));
      this.panel.scrollTop = 0;
    }
    this.callbacks.onSelect(hotspot);
  }

  /** The simulation's view of the chosen place (null: no simulation). */
  setTraffic(traffic: PlaceTraffic | undefined | null): void {
    this.traffic.textContent = describeTraffic(traffic);
  }

  private reportItem(report: NewsReport): HTMLLIElement {
    const item = document.createElement('li');
    const meta = el('div', 'news-meta', item);
    const parts = [formatReportDate(report.date), report.outlet];
    if (report.timeOfDay) parts.push(report.timeOfDay);
    meta.textContent = parts.join(' · ');
    for (const tag of [
      report.type ? (TYPE_LABELS[report.type] ?? report.type) : undefined,
      report.recurring ? 'recurring' : undefined,
    ]) {
      if (!tag) continue;
      const span = el('span', 'news-tag', meta);
      span.textContent = tag;
    }
    const url = safeUrl(report.url);
    const headline = url ? el('a', 'news-headline', item) : el('span', 'news-headline', item);
    headline.textContent = report.headline;
    if (url && headline instanceof HTMLAnchorElement) {
      headline.href = url;
      headline.target = '_blank';
      headline.rel = 'noopener noreferrer';
    }
    const summary = el('p', 'news-summary', item);
    summary.textContent = report.summary;
    return item;
  }
}
