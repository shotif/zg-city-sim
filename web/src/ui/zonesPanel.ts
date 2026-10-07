import { VALUE_STOPS } from '../grow/landValue';
import type { PlanClass } from '../grow/lots';
import type { ZoneDemand } from '../grow/zoneDemand';
import { type Brush, ZONES } from '../grow/zones';
import { button, el, fmt } from './buildPanel';

/** Brush sizes on offer (radius, m). */
export const BRUSH_SIZES = [
  { radius: 30, label: 'Small (30 m)' },
  { radius: 80, label: 'Medium (80 m)' },
  { radius: 200, label: 'Large (200 m)' },
];

export interface ZonesPanelCallbacks {
  /** Painting with this brush, or not painting (undefined). */
  onBrush(brush: Brush | undefined): void;
  onRadius(radius: number): void;
  /** Show or hide the City's planned land use. */
  onPlan(on: boolean): void;
  /** Colour lots by land value, or by zone. */
  onValue(on: boolean): void;
  onUndo(): void;
  onClear(): void;
  shareLink(): Promise<string>;
  onClose(): void;
}

/**
 * The Zones panel (M5a): choose a zone and a brush, paint lots on the map, see what is
 * zoned, show the City's plan, undo and share.
 */
export class ZonesPanel {
  private readonly panel: HTMLElement;
  private readonly brushes = new Map<Brush, HTMLButtonElement>();
  private readonly totals: HTMLElement;
  private readonly growth: HTMLElement;
  private readonly status: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly planToggle: HTMLInputElement;
  private readonly valueToggle: HTMLInputElement;
  private readonly valueNote: HTMLElement;
  private readonly demandBars = new Map<keyof ZoneDemand, HTMLElement>();
  private brushNow?: Brush;
  private radiusNow = BRUSH_SIZES[1].radius;
  private shown = false;

  constructor(
    parent: HTMLElement,
    planClasses: PlanClass[],
    private readonly callbacks: ZonesPanelCallbacks,
  ) {
    this.panel = el('aside', 'hud-panel zones-panel', parent);
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Zones');
    const header = el('div', 'news-header', this.panel);
    el('h2', 'build-title', header).textContent = 'Zones';
    const close = el('button', 'hud-button hud-icon', header);
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close (Z)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => callbacks.onClose());

    el('p', 'zones-hint', this.panel).textContent =
      'Choose a zone, then drag over the map to zone the lots along its streets. ' +
      'Esc stops painting, so the map can be moved again.';
    const grid = el('div', 'zone-grid', this.panel);
    const brushButton = (brush: Brush, label: string, color: string, title: string) => {
      const b = button(
        label,
        grid,
        () => this.choose(this.brushNow === brush ? undefined : brush),
        title,
      );
      b.classList.add('zone-button');
      b.setAttribute('aria-pressed', 'false');
      const swatch = document.createElement('i');
      swatch.className = 'zone-swatch';
      swatch.style.background = color;
      b.prepend(swatch);
      this.brushes.set(brush, b);
    };
    for (const z of ZONES) brushButton(z.id, z.label, z.color, z.title);
    brushButton(
      'plan',
      'As the City plans',
      'linear-gradient(135deg, #e8c45a 50%, #4a90d9 50%)',
      "Zone each lot as the City's plan has it",
    );
    brushButton('none', 'Remove zoning', 'transparent', 'Take the zone off lots');

    const row = el('div', 'build-row', this.panel);
    const label = el('label', 'build-label', row);
    label.append('Brush ');
    const size = el('select', 'build-select', label);
    size.setAttribute('aria-label', 'Brush size');
    for (const s of BRUSH_SIZES) {
      const o = el('option', '', size);
      o.value = String(s.radius);
      o.textContent = s.label;
    }
    size.value = String(this.radiusNow);
    size.addEventListener('change', () => {
      this.radiusNow = Number(size.value);
      callbacks.onRadius(this.radiusNow);
    });

    const planRow = el('label', 'build-check', this.panel);
    this.planToggle = el('input', '', planRow);
    this.planToggle.type = 'checkbox';
    planRow.append(" The City's planned land use");
    this.legend = el('div', 'hud-legend build-legend', this.panel);
    this.legend.hidden = true;
    for (const c of planClasses) {
      const item = el('span', '', this.legend);
      el('i', '', item).style.background = c.color;
      item.append(c.label);
    }
    this.planToggle.addEventListener('change', () => {
      this.legend.hidden = !this.planToggle.checked;
      callbacks.onPlan(this.planToggle.checked);
    });

    const valueRow = el('label', 'build-check', this.panel);
    this.valueToggle = el('input', '', valueRow);
    this.valueToggle.type = 'checkbox';
    valueRow.append(' Land value');
    const valueLegend = el('div', 'hud-legend build-legend zone-value-legend', this.panel);
    valueLegend.hidden = true;
    const ramp = el('i', 'zone-ramp', valueLegend);
    ramp.style.background = `linear-gradient(90deg, ${VALUE_STOPS.map((c) => c[1]).join(', ')})`;
    valueLegend.prepend('Low ');
    valueLegend.append(' high');
    this.valueNote = el('p', 'zones-value', this.panel);
    this.valueNote.hidden = true;
    this.valueToggle.addEventListener('change', () => {
      valueLegend.hidden = !this.valueToggle.checked;
      this.valueNote.hidden = !this.valueToggle.checked;
      callbacks.onValue(this.valueToggle.checked);
    });

    const demand = el('section', 'zone-demand', this.panel);
    el('h3', 'build-count', demand).textContent = 'Demand';
    for (const [key, label] of [
      ['homes', 'Homes'],
      ['shops', 'Shops'],
      ['work', 'Offices and industry'],
    ] as const) {
      const row = el('div', 'zone-demand-row', demand);
      el('span', 'zone-demand-label', row).textContent = label;
      const bar = el('span', 'zone-demand-bar', row);
      bar.setAttribute('role', 'meter');
      bar.setAttribute('aria-label', `Demand for ${label.toLowerCase()}`);
      bar.setAttribute('aria-valuemin', '-100');
      bar.setAttribute('aria-valuemax', '100');
      el('i', '', bar);
      this.demandBars.set(key, bar);
    }

    const zoned = el('section', 'build-edits', this.panel);
    el('h3', 'build-count', zoned).textContent = 'Zoned';
    this.totals = el('ul', 'zone-totals', zoned);
    this.growth = el('p', 'zones-growth', zoned);
    this.growth.setAttribute('aria-live', 'polite');
    const actions = el('div', 'build-row', zoned);
    button('Undo stroke', actions, () => callbacks.onUndo(), 'Take back the last stroke');
    button('Clear zoning', actions, () => callbacks.onClear(), 'Remove all zoning');
    button('Share zoning', actions, () => void this.share(), 'Copy a link to this zoning');
    this.status = el('p', 'zones-status', zoned);
    this.status.setAttribute('role', 'status');

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.shown && this.brushNow) this.choose(undefined);
    });
  }

  get element(): HTMLElement {
    return this.panel;
  }

  get visible(): boolean {
    return this.shown;
  }

  get brush(): Brush | undefined {
    return this.brushNow;
  }

  get radius(): number {
    return this.radiusNow;
  }

  setVisible(shown: boolean): void {
    this.shown = shown;
    this.panel.hidden = !shown;
    if (!shown) this.choose(undefined);
  }

  /** Zoned lots and land per zone code (0: none), and how many strokes. */
  setTotals(totals: { lots: number; area: number }[], strokes: number): void {
    const rows = ZONES.map((z, k) => ({ z, t: totals[k + 1] })).filter(({ t }) => t.lots > 0);
    this.totals.replaceChildren(
      ...rows.map(({ z, t }) => {
        const item = el('li', 'zone-item');
        const swatch = el('i', 'zone-swatch', item);
        swatch.style.background = z.color;
        item.append(`${z.label}: ${fmt(t.lots, 0)} lots, ${fmt(t.area / 10_000, 1)} ha`);
        return item;
      }),
    );
    if (!rows.length) {
      const item = el('li', 'zone-item', this.totals);
      item.textContent = strokes ? 'No lots zoned.' : 'Nothing zoned yet.';
    }
  }

  /** Buildings grown so far, and their residents and jobs (estimated from floor area). */
  setGrowth(t: { built: number; building: number; residents: number; jobs: number }): void {
    if (t.built + t.building === 0) {
      this.growth.textContent = this.totals.childElementCount
        ? 'Buildings grow on zoned lots as the simulated day goes on.'
        : '';
      return;
    }
    this.growth.textContent =
      `Grown: ${fmt(t.built, 0)} building${t.built === 1 ? '' : 's'}` +
      (t.building ? `, ${fmt(t.building, 0)} being built` : '') +
      `; about ${fmt(Math.round(t.residents / 10) * 10, 0)} residents and ` +
      `${fmt(Math.round(t.jobs / 10) * 10, 0)} jobs (estimated from floor area).`;
  }

  /** Demand per kind of zone (-1 to 1). */
  setDemand(d: ZoneDemand): void {
    for (const [key, bar] of this.demandBars) {
      const v = Math.round(d[key] * 100);
      bar.setAttribute('aria-valuenow', String(v));
      bar.title = v > 25 ? 'Wanted' : v > -25 ? 'Some' : 'Not wanted';
      bar.setAttribute('aria-valuetext', bar.title);
      const fill = bar.firstElementChild as HTMLElement;
      fill.style.left = `${50 + Math.min(0, v) / 2}%`;
      fill.style.width = `${Math.abs(v) / 2}%`;
      fill.className = v >= 0 ? 'up' : 'down';
    }
  }

  /** Land value: not measured yet, or the mean of the zoned lots (NaN: none zoned). */
  setLandValue(measured: boolean, meanZoned: number): void {
    this.valueNote.textContent = !measured
      ? 'Measuring how far homes and jobs are by car on the traffic simulated…'
      : 'From homes and jobs within reach by car, green land around and traffic noise; ' +
        '100 is the best-placed land when first measured.' +
        (Number.isFinite(meanZoned) ? ` Zoned lots: ${fmt(meanZoned, 0)} on average.` : '');
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  private choose(brush: Brush | undefined): void {
    this.brushNow = brush;
    for (const [b, el] of this.brushes) el.setAttribute('aria-pressed', String(b === brush));
    this.callbacks.onBrush(brush);
  }

  private async share(): Promise<void> {
    try {
      const link = await this.callbacks.shareLink();
      await navigator.clipboard?.writeText(link);
      this.setStatus('Link copied.');
    } catch {
      this.setStatus('Could not copy the link.');
    }
  }
}
