import { type Budget, euros } from '../grow/economy';
import { el } from './buildPanel';

/** Colours of the balance chart. */
const LINE = '#7cc7ff';
const ZERO = 'rgba(255, 255, 255, 0.35)';
const GRID_TEXT = 'rgba(255, 255, 255, 0.6)';

/**
 * The Budget panel (M5e): the City's balance, what comes in and goes out a year (a
 * simulated day), what was built, and the balance over time.
 */
export class BudgetPanel {
  private readonly panel: HTMLElement;
  private readonly balance: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly built: HTMLElement;
  private readonly chart: HTMLCanvasElement;
  private shown = false;

  constructor(parent: HTMLElement, onClose: () => void) {
    this.panel = el('aside', 'hud-panel budget-panel', parent);
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Budget');
    const header = el('div', 'news-header', this.panel);
    el('h2', 'build-title', header).textContent = 'Budget';
    const close = el('button', 'hud-button hud-icon', header);
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close (M)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', onClose);

    this.balance = el('p', 'budget-balance', this.panel);
    this.balance.setAttribute('aria-live', 'polite');
    el('h3', 'build-count', this.panel).textContent = 'A year (a simulated day)';
    this.rows = el('dl', 'budget-rows', this.panel);
    this.built = el('p', 'budget-note', this.panel);
    el('h3', 'build-count', this.panel).textContent = 'Balance over time';
    this.chart = el('canvas', 'budget-chart', this.panel);
    this.chart.setAttribute('role', 'img');
    this.chart.setAttribute('aria-label', 'The balance over the days simulated');
    el('p', 'budget-note', this.panel).textContent =
      "Income: the City of Zagreb's yearly investment in its streets (2025 budget), and " +
      'the income tax, communal fees and contributions of what grows on zoned land. Costs ' +
      'of roads, bridges, roundabouts and lights from Croatian projects, without land; ' +
      'taking an edit back refunds it. A simulated day counts as a year.';
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
  }

  /** Show the budget as it is now; `edits`: how many edits are in force. */
  show(budget: Budget, edits: number): void {
    this.balance.textContent = euros(budget.balance);
    this.balance.classList.toggle('budget-negative', budget.balance < 0);
    const y = budget.yearly;
    const net = y.base + y.tax + y.fee - y.upkeep - y.service;
    const items: [string, number][] = [
      ['Streets budget', y.base],
      ['Income tax', y.tax],
      ['Communal fees', y.fee],
      ['Upkeep of what was built', -y.upkeep],
      ...(y.service ? [['Public transport run more or less', -y.service] as [string, number]] : []),
      ['A year in all', net],
    ];
    this.rows.replaceChildren(
      ...items.flatMap(([label, v]) => {
        const dt = el('dt', '');
        dt.textContent = label;
        const dd = el('dd', v < 0 ? 'budget-out' : '');
        dd.textContent = euros(v);
        return [dt, dd];
      }),
    );
    this.built.textContent =
      `Built: ${euros(budget.spent)} on ${edits} edit${edits === 1 ? '' : 's'} in force.` +
      (budget.contributions > 0
        ? ` Communal contributions from buildings finished: ${euros(budget.contributions)}.`
        : '');
    if (this.shown) {
      const now = budget.current();
      this.drawChart(now ? [...budget.history, now] : budget.history);
    }
  }

  private drawChart(history: readonly [number, number][]): void {
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
    if (history.length < 2) return;
    const t0 = history[0][0];
    const t1 = Math.max(history[history.length - 1][0], t0 + 1e-6);
    let lo = Math.min(0, ...history.map((p) => p[1]));
    let hi = Math.max(...history.map((p) => p[1]));
    if (hi - lo < 1) [lo, hi] = [lo - 1, hi + 1];
    const pad = { left: 4, right: 4, top: 16, bottom: 16 };
    const x = (t: number) => pad.left + ((t - t0) / (t1 - t0)) * (w - pad.left - pad.right);
    const y = (v: number) => pad.top + (1 - (v - lo) / (hi - lo)) * (h - pad.top - pad.bottom);
    ctx.strokeStyle = ZERO;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y(0));
    ctx.lineTo(w - pad.right, y(0));
    ctx.stroke();
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    history.forEach(([t, v], k) => (k ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
    ctx.stroke();
    ctx.fillStyle = GRID_TEXT;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(euros(hi), pad.left, 1);
    ctx.textBaseline = 'bottom';
    const days = t1 - t0;
    const span =
      days >= 1
        ? `${days.toFixed(1)} days`
        : days >= 1 / 24
          ? `${Math.round(days * 24)} h`
          : `${Math.round(days * 1440)} min`;
    ctx.fillText(span, pad.left, h - 1);
  }
}
