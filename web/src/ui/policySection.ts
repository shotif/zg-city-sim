import { type AreaEdit, CHARGE_RANGE, PARKING_RANGE } from '../edit/edits';
import {
  AREA_PRESETS,
  type AreaPoint,
  MAX_AREA_POINTS,
  areaOf,
  clock,
  hoursText,
} from '../edit/policies';
import { button, el } from './buildPanel';

/** Congestion charges on offer (€ a drive into the area). */
export const CHARGES = [1, 2, 3, 4, 5, 7.5, 10, 15, 20];
/** Parking surcharges on offer (€ an hour). */
export const PARKING_RATES = [0.5, 1, 1.5, 2, 3, 5];
/** Hours on offer (minutes after midnight). */
export const POLICY_HOURS: readonly { from: number; to: number }[] = [
  { from: 420, to: 1140 },
  { from: 420, to: 1260 },
  { from: 360, to: 1200 },
  { from: 420, to: 600 },
  { from: 900, to: 1140 },
  { from: 0, to: 1440 },
];

type Kind = AreaEdit['kind'];

const KINDS: Record<
  Kind,
  { label: string; amounts: number[]; amount: string; per: string; hours: number; note: string }
> = {
  charge: {
    label: 'Congestion charge',
    amounts: CHARGES.filter((c) => c >= CHARGE_RANGE[0] && c <= CHARGE_RANGE[1]),
    amount: '3',
    per: '',
    hours: 0,
    note:
      'Cars and lorries pay each time they drive into the area while it applies; buses, ' +
      'trams and bikes do not, and roads along its edge are free. Drivers count €1 as ' +
      'about 4 minutes, so through traffic goes round the area and some trips into it move ' +
      'to trams and buses.',
  },
  parking: {
    label: 'Parking surcharge',
    amounts: PARKING_RATES.filter((c) => c >= PARKING_RANGE[0] && c <= PARKING_RANGE[1]),
    amount: '1',
    per: ' an hour',
    hours: 1,
    note:
      'On top of today’s prices, for car trips that end in the area: commuters park for ' +
      'about 8 hours and half of them pay (the rest park at work), other trips about 1.5 ' +
      'hours, and residents park on permits (estimates). Through traffic does not pay, so ' +
      'only trips into the area move to trams and buses.',
  },
  lorryBan: {
    label: 'Lorry ban',
    amounts: [],
    amount: '',
    per: '',
    hours: 5,
    note:
      'Lorries may not cross the area’s edge, in or out, except to reach or leave places ' +
      'inside it: their routes count an hour for every road over the edge, so lorries ' +
      'passing through go round and deliveries still get in. Cars, buses and bikes are not ' +
      'affected. Zagreb already keeps lorries over 12 t out of its central zone; the ' +
      'simulation does not tell lorries apart by weight.',
  },
};

export interface PolicySectionCallbacks {
  /** Drawing an area started or stopped: while drawing, clicks on the map add points. */
  onDrawing(on: boolean): void;
  /** The area's points so far, to draw it as it is drawn. */
  onPoints(points: readonly AreaPoint[]): void;
  /** A policy to put in force (replacing one of the same kind on an area of the same name):
   * undefined if done, else why not. */
  onPolicy(policy: AreaEdit): string | undefined;
}

/** What has been paid in the simulation so far: euros, and by how many (drivers who paid a
 * charge; car trips that ended in a parking area). */
export interface Paid {
  euros: number;
  count: number;
  shown: boolean;
}

/**
 * Policies on an area (M18), in the Build panel: a congestion charge (M18a), a parking
 * surcharge (M18b) or a lorry ban (M18c). Choose the policy, its amount and hours, then an
 * area (Donji grad, or one drawn on the map). Policies in force are listed with the other
 * edits, and taken back there.
 */
export class PolicySection {
  readonly element: HTMLElement;
  private readonly kind: HTMLSelectElement;
  private readonly euros: HTMLSelectElement;
  private readonly hours: HTMLSelectElement;
  private readonly note: HTMLElement;
  private readonly drawButton: HTMLButtonElement;
  private readonly controls: HTMLElement;
  private readonly status: HTMLElement;
  private readonly paid: HTMLElement;
  private points: AreaPoint[] = [];
  private drawing = false;
  private drawn = 0;

  constructor(
    parent: HTMLElement,
    private readonly callbacks: PolicySectionCallbacks,
  ) {
    this.element = el('section', 'build-draw', parent);
    el('h3', 'build-count', this.element).textContent = 'Policies on an area';
    const options = el('div', 'build-row', this.element);
    const select = (label: string) => {
      const wrap = el('label', 'build-label', options);
      wrap.append(`${label} `);
      const s = el('select', 'build-select', wrap);
      s.setAttribute('aria-label', label);
      return s;
    };
    const fill = (s: HTMLSelectElement, values: [string, string][]) => {
      s.replaceChildren(
        ...values.map(([value, text]) => {
          const o = document.createElement('option');
          o.value = value;
          o.textContent = text;
          return o;
        }),
      );
    };
    this.kind = select('Policy');
    fill(
      this.kind,
      (Object.keys(KINDS) as Kind[]).map((k) => [k, KINDS[k].label]),
    );
    this.euros = select('Charge');
    this.hours = select('Hours');
    fill(
      this.hours,
      POLICY_HOURS.map((h, i) => [
        String(i),
        h.from === 0 && h.to === 1440 ? 'All day' : `${clock(h.from)}-${clock(h.to)}`,
      ]),
    );
    this.note = el('p', 'build-note', this.element);
    const choose = () => {
      const k = KINDS[this.kind.value as Kind];
      fill(
        this.euros,
        k.amounts.map((c) => [String(c), `€${c}${k.per}`]),
      );
      this.euros.value = k.amount;
      // A lorry ban has no amount.
      if (this.euros.parentElement) this.euros.parentElement.hidden = k.amounts.length === 0;
      this.hours.value = String(k.hours);
      this.note.textContent = k.note;
    };
    this.kind.addEventListener('change', choose);
    choose();
    const row = el('div', 'build-row', this.element);
    for (const preset of AREA_PRESETS) {
      button(
        preset.name,
        row,
        () => this.put(preset.name, [...preset.area]),
        `Put the policy on ${preset.name}`,
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

  /** What has been paid in the simulation so far for charges and for parking, and the
   * lorries let into banned areas (`count`). */
  setPaid(charges: Paid, parking: Paid, lorries: Paid): void {
    const lines: string[] = [];
    const n = (x: number) => Math.round(x).toLocaleString('en-GB');
    if (charges.shown) {
      lines.push(
        `Charges paid so far today: €${n(charges.euros)} by ${n(charges.count)} cars and lorries.`,
      );
    }
    if (parking.shown) {
      lines.push(
        `Parking surcharges paid so far today: €${n(parking.euros)}, by ${n(parking.count)} ` +
          'car trips that ended in the area.',
      );
    }
    if (lorries.shown) {
      lines.push(
        `Lorries let into banned areas so far today, to reach places there: ${n(lorries.count)}.`,
      );
    }
    this.paid.hidden = lines.length === 0;
    this.paid.textContent = lines.join(' ');
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
    if (this.put(`area ${this.drawn}`, area)) {
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

  private put(name: string, area: AreaPoint[]): boolean {
    const kind = this.kind.value as Kind;
    const hours = POLICY_HOURS[Number(this.hours.value)] ?? POLICY_HOURS[0];
    const euros = Number(this.euros.value);
    const base = { name, area, from: hours.from, to: hours.to };
    const problem = this.callbacks.onPolicy(
      kind === 'lorryBan' ? { kind, ...base } : { kind, euros, ...base },
    );
    const what =
      kind === 'charge'
        ? `€${euros} for driving into ${name}`
        : kind === 'parking'
          ? `€${euros} an hour on parking in ${name}`
          : `Lorries kept from crossing the edge of ${name}`;
    this.status.textContent = problem ?? `${what} ${hoursText(hours.from, hours.to)}.`;
    return problem === undefined;
  }
}
