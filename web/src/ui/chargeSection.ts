import { CHARGE_RANGE, type ChargeEdit } from '../edit/edits';
import { AREA_PRESETS, type AreaPoint, MAX_AREA_POINTS, areaOf, clock } from '../edit/policies';
import { button, el } from './buildPanel';

/** Charges on offer (€). */
export const CHARGES = [1, 2, 3, 4, 5, 7.5, 10, 15, 20];
/** Charging hours on offer (minutes after midnight). */
export const CHARGE_HOURS: readonly { from: number; to: number }[] = [
  { from: 420, to: 1140 },
  { from: 360, to: 1200 },
  { from: 420, to: 600 },
  { from: 900, to: 1140 },
  { from: 0, to: 1440 },
];

export interface ChargeSectionCallbacks {
  /** Drawing an area started or stopped: while drawing, clicks on the map add points. */
  onDrawing(on: boolean): void;
  /** The area's points so far, to draw it as it is drawn. */
  onPoints(points: readonly AreaPoint[]): void;
  /** A charge to put in force (replacing one on an area of the same name): undefined if
   * done, else why not. */
  onCharge(charge: ChargeEdit): string | undefined;
}

/**
 * The congestion charge (M18a), in the Build panel's Policies: choose the charge and its
 * hours, then an area (Donji grad, or one drawn on the map). Charges in force are listed
 * with the other edits, and taken back there.
 */
export class ChargeSection {
  readonly element: HTMLElement;
  private readonly euros: HTMLSelectElement;
  private readonly hours: HTMLSelectElement;
  private readonly drawButton: HTMLButtonElement;
  private readonly controls: HTMLElement;
  private readonly status: HTMLElement;
  private readonly paid: HTMLElement;
  private points: AreaPoint[] = [];
  private drawing = false;
  private drawn = 0;

  constructor(
    parent: HTMLElement,
    private readonly callbacks: ChargeSectionCallbacks,
  ) {
    this.element = el('section', 'build-draw', parent);
    el('h3', 'build-count', this.element).textContent = 'Congestion charge';
    el('p', 'build-note', this.element).textContent =
      'Cars and lorries pay each time they drive into the area while it applies; buses, ' +
      'trams and bikes do not. Drivers count €1 as about 4 minutes, so some go round the ' +
      'area and some trips into it move to trams and buses.';
    const options = el('div', 'build-row', this.element);
    const select = (label: string, values: [string, string][]) => {
      const wrap = el('label', 'build-label', options);
      wrap.append(`${label} `);
      const s = el('select', 'build-select', wrap);
      for (const [value, text] of values) {
        const o = el('option', '', s);
        o.value = value;
        o.textContent = text;
      }
      return s;
    };
    this.euros = select(
      'Charge',
      CHARGES.filter((c) => c >= CHARGE_RANGE[0] && c <= CHARGE_RANGE[1]).map((c) => [
        String(c),
        `€${c}`,
      ]),
    );
    this.euros.value = '3';
    this.hours = select(
      'Hours',
      CHARGE_HOURS.map((h, i) => [
        String(i),
        h.from === 0 && h.to === 1440 ? 'All day' : `${clock(h.from)}-${clock(h.to)}`,
      ]),
    );
    const row = el('div', 'build-row', this.element);
    for (const preset of AREA_PRESETS) {
      button(
        preset.name,
        row,
        () => this.charge(preset.name, [...preset.area]),
        `Charge for driving into ${preset.name}`,
      );
    }
    this.drawButton = button('Draw an area', row, () =>
      this.drawing ? this.cancel() : this.start(),
    );
    this.controls = el('div', 'build-row', this.element);
    this.controls.hidden = true;
    button('Finish area', this.controls, () => this.finish(), 'Enter');
    button('Remove last point', this.controls, () => this.undoPoint(), 'Backspace');
    this.status = el('p', 'build-draw-status', this.element);
    this.status.setAttribute('role', 'status');
    this.paid = el('p', 'build-note', this.element);
    this.paid.hidden = true;

    window.addEventListener('keydown', (event) => {
      if (!this.drawing || event.target instanceof HTMLInputElement) return;
      if (event.key === 'Enter') this.finish();
      else if (event.key === 'Escape') this.cancel();
      else if (event.key === 'Backspace') this.undoPoint();
      else return;
      event.preventDefault();
    });
  }

  get active(): boolean {
    return this.drawing;
  }

  /** Charges paid in the simulation so far (€), and by how many cars and lorries. */
  setPaid(euros: number, payers: number, shown: boolean): void {
    this.paid.hidden = !shown;
    if (shown) {
      this.paid.textContent =
        `Paid so far today: €${Math.round(euros).toLocaleString('en-GB')} by ` +
        `${payers.toLocaleString('en-GB')} cars and lorries.`;
    }
  }

  start(): void {
    this.drawing = true;
    this.points = [];
    this.drawButton.textContent = 'Cancel';
    this.controls.hidden = false;
    this.status.textContent = 'Click round the area on the map, then Finish area.';
    this.callbacks.onDrawing(true);
    this.callbacks.onPoints(this.points);
  }

  cancel(): void {
    this.drawing = false;
    this.points = [];
    this.drawButton.textContent = 'Draw an area';
    this.controls.hidden = true;
    this.callbacks.onDrawing(false);
    this.callbacks.onPoints([]);
  }

  /** A point clicked on the map (scene x, z). */
  addPoint(p: AreaPoint): void {
    if (!this.drawing || this.points.length >= MAX_AREA_POINTS) return;
    const last = this.points.at(-1);
    if (last && Math.hypot(last.x - p.x, last.z - p.z) < 5) return;
    this.points.push({ x: p.x, z: p.z });
    this.status.textContent =
      this.points.length < 3
        ? `${this.points.length} point${this.points.length === 1 ? '' : 's'}: click on round the area.`
        : `${this.points.length} points, ${(areaOf(this.points) / 1e6).toFixed(1)} km²: Finish area when it is closed off.`;
    this.callbacks.onPoints(this.closed());
  }

  undoPoint(): void {
    if (!this.drawing) return;
    this.points.pop();
    this.callbacks.onPoints(this.closed());
  }

  finish(): void {
    if (!this.drawing) return;
    if (this.points.length < 3) {
      this.status.textContent = 'An area needs three points or more.';
      return;
    }
    const area = this.points;
    this.drawn += 1;
    if (this.charge(`area ${this.drawn}`, area)) {
      this.drawing = false;
      this.points = [];
      this.drawButton.textContent = 'Draw an area';
      this.controls.hidden = true;
      this.callbacks.onDrawing(false);
      this.callbacks.onPoints([]);
    }
  }

  /** The points drawn, back to the first once there are three. */
  private closed(): AreaPoint[] {
    return this.points.length >= 3 ? [...this.points, this.points[0]] : [...this.points];
  }

  private charge(name: string, area: AreaPoint[]): boolean {
    const hours = CHARGE_HOURS[Number(this.hours.value)] ?? CHARGE_HOURS[0];
    const euros = Number(this.euros.value);
    const problem = this.callbacks.onCharge({
      kind: 'charge',
      name,
      area,
      euros,
      from: hours.from,
      to: hours.to,
    });
    this.status.textContent =
      problem ??
      `€${euros} for driving into ${name} from ${clock(hours.from)} to ${clock(hours.to)}.`;
    return problem === undefined;
  }
}
