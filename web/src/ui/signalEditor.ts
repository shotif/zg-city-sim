import { PHASE_SECONDS, type SignalEdit } from '../edit/builder';
import { DEFAULT_PHASE, type JunctionSignals, defaultPhases } from '../edit/signals';
import { button, el } from './buildPanel';

/** Most phases a program can have in the editor. */
const MAX_PHASES = 8;
/** Yellow after each phase (s), as the builder adds it. */
const YELLOW = 3;

export interface SignalEditorCallbacks {
  /** Set the lights to these phases (none: no lights); else the reason it cannot be. */
  onApply(phases: SignalEdit['phases']): string | undefined;
  onClose(): void;
}

/**
 * The signal editor (M4e): a junction's movements down the side, its phases across, a
 * tick where a phase lets a movement go, and each phase's length.
 */
export class SignalEditor {
  readonly element: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly cycle: HTMLElement;
  private readonly status: HTMLElement;
  private phases: SignalEdit['phases'];

  constructor(
    parent: HTMLElement,
    private readonly signals: JunctionSignals,
    private readonly callbacks: SignalEditorCallbacks,
  ) {
    this.phases = signals.phases.length
      ? signals.phases.map((p) => ({ ...p, green: [...p.green] }))
      : defaultPhases(signals.movements);
    this.element = el('section', 'build-signals', parent);
    this.element.setAttribute('aria-label', 'Signal editor');
    const title = el('div', 'build-subtitle', this.element);
    title.textContent = `Traffic lights at ${signals.junction.name ?? 'the junction'}`;
    const note = el('p', 'build-note', this.element);
    note.textContent =
      `Tick the movements each phase lets go; a ${YELLOW} s yellow follows each phase. ` +
      'Turns crossing traffic with priority give way. Movements never green are closed.';
    const wrap = el('div', 'build-phases-wrap', this.element);
    this.table = el('table', 'build-table build-phases', wrap);
    this.cycle = el('p', 'build-note', this.element);
    const row = el('div', 'build-row', this.element);
    button('Add phase', row, () => this.addPhase());
    button('Remove last phase', row, () => this.removePhase());
    const actions = el('div', 'build-row', this.element);
    button('Apply lights', actions, () => this.apply(this.phases));
    if (signals.tls !== undefined) {
      button('Remove traffic lights', actions, () => this.apply([]));
    }
    button('Cancel', actions, () => callbacks.onClose());
    this.status = el('p', 'build-draw-status', this.element);
    this.status.setAttribute('role', 'status');
    this.render();
  }

  private addPhase(): void {
    if (this.phases.length >= MAX_PHASES) return;
    this.phases.push({ seconds: DEFAULT_PHASE, green: [] });
    this.render();
  }

  private removePhase(): void {
    if (this.phases.length <= 1) return;
    this.phases.pop();
    this.render();
  }

  private apply(phases: SignalEdit['phases']): void {
    const problem = this.callbacks.onApply(phases);
    if (problem) this.status.textContent = problem;
  }

  private render(): void {
    const movements = this.signals.movements;
    this.table.replaceChildren();
    const head = el('tr', '', el('thead', '', this.table));
    el('th', '', head).textContent = 'Movement';
    this.phases.forEach((_, p) => {
      const th = el('th', '', head);
      th.textContent = `Phase ${p + 1}`;
    });
    const body = el('tbody', '', this.table);
    const times = el('tr', '', body);
    el('th', '', times).textContent = 'Seconds';
    this.phases.forEach((phase, p) => {
      const input = el('input', 'build-number', el('td', '', times));
      input.type = 'number';
      input.min = String(PHASE_SECONDS.min);
      input.max = String(PHASE_SECONDS.max);
      input.step = '1';
      input.value = String(phase.seconds);
      input.setAttribute('aria-label', `Phase ${p + 1} length (s)`);
      input.addEventListener('change', () => {
        const v = Math.round(Number(input.value));
        phase.seconds = Number.isFinite(v)
          ? Math.min(PHASE_SECONDS.max, Math.max(PHASE_SECONDS.min, v))
          : DEFAULT_PHASE;
        input.value = String(phase.seconds);
        this.showCycle();
      });
    });
    movements.forEach((m, k) => {
      const tr = el('tr', '', body);
      el('th', '', tr).textContent = m.label;
      this.phases.forEach((phase, p) => {
        const box = el('input', '', el('td', '', tr));
        box.type = 'checkbox';
        box.checked = phase.green.includes(k);
        box.setAttribute('aria-label', `Phase ${p + 1}: ${m.label}`);
        box.addEventListener('change', () => {
          phase.green = box.checked ? [...phase.green, k] : phase.green.filter((g) => g !== k);
          this.showCycle();
        });
      });
    });
    this.showCycle();
  }

  private showCycle(): void {
    const cycle = this.phases.reduce((acc, p) => acc + p.seconds + YELLOW, 0);
    const never = this.signals.movements.filter(
      (_, k) => !this.phases.some((p) => p.green.includes(k)),
    );
    const roads = never.filter((m) => !m.tracks).length;
    const trams = never.length - roads;
    const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    this.cycle.textContent =
      `Cycle about ${cycle} s.` +
      (roads ? ` Never green, so closed: ${plural(roads, 'movement')}.` : '') +
      (trams ? ` Never green, so held at red: ${plural(trams, 'tram movement')}.` : '');
  }
}
