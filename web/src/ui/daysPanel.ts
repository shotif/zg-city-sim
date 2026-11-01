import type { DayRecord } from '../game/days';
import { euros } from '../grow/economy';
import { el } from './buildPanel';
import { formatClock } from './hud';

const BAR = '#7cc7ff';
const BAR_PART = 'rgba(124, 199, 255, 0.35)';
const GRID_TEXT = 'rgba(255, 255, 255, 0.6)';
/** Days listed, newest first. */
const LISTED = 10;

const n = (x: number) => Math.round(x).toLocaleString('en-GB');

/** "1 hour lost" or "12,400 hours lost". */
export function hoursLost(h: number): string {
  return `${n(h)} ${Math.round(h) === 1 ? 'hour' : 'hours'} lost`;
}

/** "4 % less than day 2", for a change from `before` to `now` (none if there is nothing to
 * compare with). */
export function change(now: number, before: number | undefined, day: number | undefined): string {
  if (before === undefined || day === undefined || before <= 0) return '';
  const pct = Math.round((100 * (now - before)) / before);
  if (pct === 0) return `, as on day ${day}`;
  return `, ${Math.abs(pct)} % ${pct < 0 ? 'less' : 'more'} than on day ${day}`;
}

/** A day's numbers in a few lines of plain words; `before`: the whole day before. */
export function describeDay(d: DayRecord, before?: DayRecord): string[] {
  const lines = [
    `${n(d.trips)} trips by road, ${d.tripMinutes.toFixed(1)} min on average.`,
    `${hoursLost(d.delayHours)} in traffic against the speed limits` +
      `${d.from === 0 ? change(d.delayHours, before?.delayHours, before?.day) : ''}; ` +
      `${n(d.vehicleKm)} km driven.`,
  ];
  if (d.ptTrips !== undefined && d.ptShare !== undefined) {
    lines.push(
      `Public transport: about ${n(d.ptTrips)} trips a weekday, ` +
        `${(100 * d.ptShare).toFixed(1)} % of trips by car and public transport within the ` +
        'map (estimated).',
    );
  }
  if (d.residents !== undefined && d.jobs !== undefined && d.residents + d.jobs > 0) {
    lines.push(`Grown on zoned land: ${n(d.residents)} residents and ${n(d.jobs)} jobs.`);
  }
  if (d.balance !== undefined) lines.push(`Balance at midnight: ${euros(d.balance)}.`);
  return lines;
}

/** "Day 3" or "Day 3, from 07:00". */
export function dayTitle(d: DayRecord): string {
  return d.from === 0 ? `Day ${d.day}` : `Day ${d.day}, from ${formatClock(d.from)}`;
}

/**
 * The Days panel (M19b): the day going on so far, the days played with this city, and the
 * hours lost in traffic day by day.
 */
export class DaysPanel {
  private readonly panel: HTMLElement;
  private readonly today: HTMLElement;
  private readonly list: HTMLElement;
  private readonly chart: HTMLCanvasElement;
  private shown = false;

  constructor(parent: HTMLElement, onClose: () => void) {
    this.panel = el('aside', 'hud-panel cities-panel days-panel', parent);
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Days');
    const header = el('div', 'news-header', this.panel);
    el('h2', 'build-title', header).textContent = 'Days';
    const close = el('button', 'hud-button hud-icon', header);
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close (D)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', onClose);
    this.today = el('div', 'days-today', this.panel);
    el('h3', 'build-count', this.panel).textContent = 'Hours lost in traffic, day by day';
    this.chart = el('canvas', 'budget-chart', this.panel);
    this.chart.setAttribute('role', 'img');
    this.chart.setAttribute('aria-label', 'Hours lost in traffic on each day played');
    this.list = el('ul', 'cities-list', this.panel);
    el('p', 'budget-note', this.panel).textContent =
      'Each day runs from midnight to midnight; a visit starts its first day when the streets ' +
      'have filled, so that day is counted from then and not compared. Two runs of the same ' +
      'day differ by about a sixth in the hours lost, so compare days over several.';
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(on: boolean): void {
    this.shown = on;
    this.panel.hidden = !on;
  }

  /** Show the day so far and the days kept. */
  show(
    sofar: DayRecord | undefined,
    days: readonly DayRecord[],
    before: (day: number) => DayRecord | undefined,
  ): void {
    if (!this.shown) return;
    this.today.replaceChildren();
    if (sofar) {
      el('h3', 'build-count', this.today).textContent = `${dayTitle(sofar)}, so far`;
      for (const line of describeDay(sofar)) el('p', 'build-note', this.today).textContent = line;
    } else {
      el('p', 'build-note', this.today).textContent =
        'The day is counted once the streets have filled.';
    }
    this.list.replaceChildren(
      ...[...days]
        .reverse()
        .slice(0, LISTED)
        .map((d) => {
          const item = document.createElement('li');
          el('strong', '', item).textContent = dayTitle(d);
          for (const line of describeDay(d, before(d.day))) {
            el('span', 'cities-meta', item).textContent = line;
          }
          return item;
        }),
    );
    this.drawChart(days);
  }

  private drawChart(days: readonly DayRecord[]): void {
    const canvas = this.chart;
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 360;
    const h = canvas.clientHeight || 120;
    if (canvas.width !== Math.round(w * ratio)) canvas.width = Math.round(w * ratio);
    if (canvas.height !== Math.round(h * ratio)) canvas.height = Math.round(h * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const shown = days.slice(-30);
    if (shown.length === 0) return;
    const hi = Math.max(...shown.map((d) => d.delayHours), 1);
    const pad = { top: 16, bottom: 16 };
    const step = w / Math.max(shown.length, 7);
    shown.forEach((d, i) => {
      const bar = ((h - pad.top - pad.bottom) * d.delayHours) / hi;
      // Days counted from later than midnight are paler: they are not whole.
      ctx.fillStyle = d.from === 0 ? BAR : BAR_PART;
      ctx.fillRect(i * step + 2, h - pad.bottom - bar, Math.max(1, step - 4), bar);
    });
    ctx.fillStyle = GRID_TEXT;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(`${n(hi)} h`, 2, 1);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`day ${shown[0].day}`, 2, h - 1);
    const last = `day ${shown.at(-1)!.day}`;
    ctx.fillText(
      last,
      Math.min(w - ctx.measureText(last).width - 2, (shown.length - 1) * step + 2),
      h - 1,
    );
  }
}
