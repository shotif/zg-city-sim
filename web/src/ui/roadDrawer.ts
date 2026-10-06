import { NEW_ROAD_TYPES, type NewRoadType, type Point, type RoadEdit } from '../edit/builder';
import { SPEED_LIMITS, button, el } from './buildPanel';

export interface RoadDrawerCallbacks {
  /** Drawing started or stopped: while drawing, clicks on the map add points. */
  onDrawing(on: boolean): void;
  /** The points so far, to draw the road as it is drawn. */
  onPoints(points: readonly Point[]): void;
  /** A finished road: added if it can be built, else the reason it cannot. */
  onRoad(road: RoadEdit): string | undefined;
}

/**
 * Drawing a road (M4d), in the Build panel: choose its type, lanes and limit, click where it
 * starts (on a road or at a junction), click along its way, and finish where it ends.
 */
export class RoadDrawer {
  readonly element: HTMLElement;
  private readonly drawButton: HTMLButtonElement;
  private readonly controls: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly status: HTMLElement;
  private readonly type: HTMLSelectElement;
  private readonly lanes: HTMLSelectElement;
  private readonly speed: HTMLSelectElement;
  private readonly oneway: HTMLInputElement;
  private readonly bridge: HTMLInputElement;
  private points: Point[] = [];
  private drawing = false;

  constructor(
    parent: HTMLElement,
    private readonly callbacks: RoadDrawerCallbacks,
  ) {
    this.element = el('section', 'build-draw', parent);
    const title = el('h3', 'build-count', this.element);
    title.textContent = 'New road';
    const options = el('div', 'build-row', this.element);
    const select = (label: string, values: [string, string][], parentEl = options) => {
      const wrap = el('label', 'build-label', parentEl);
      wrap.append(`${label} `);
      const s = el('select', 'build-select', wrap);
      for (const [value, text] of values) {
        const o = el('option', '', s);
        o.value = value;
        o.textContent = text;
      }
      return s;
    };
    this.type = select(
      'Type',
      (Object.keys(NEW_ROAD_TYPES) as NewRoadType[]).map((k) => [k, NEW_ROAD_TYPES[k].label]),
    );
    this.type.value = 'secondary';
    this.lanes = select('Lanes each way', [
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
    ]);
    this.speed = select(
      'Limit',
      SPEED_LIMITS.map((v) => [String(v), `${v} km/h`]),
    );
    this.speed.value = String(NEW_ROAD_TYPES.secondary.kmh);
    this.type.addEventListener('change', () => {
      this.speed.value = String(NEW_ROAD_TYPES[this.type.value as NewRoadType].kmh);
    });
    const checks = el('div', 'build-row', this.element);
    const check = (label: string) => {
      const wrap = el('label', 'build-check', checks);
      const input = el('input', '', wrap);
      input.type = 'checkbox';
      wrap.append(` ${label}`);
      return input;
    };
    this.oneway = check('One way');
    this.bridge = check('Bridge');
    const row = el('div', 'build-row', this.element);
    this.drawButton = button('Draw a road', row, () =>
      this.drawing ? this.cancel() : this.start(),
    );
    this.controls = el('div', 'build-row', this.element);
    this.controls.hidden = true;
    button('Finish road', this.controls, () => this.finish(), 'Enter');
    button('Remove last point', this.controls, () => this.undoPoint(), 'Backspace');
    this.hint = el('p', 'build-note', this.element);
    this.hint.textContent =
      'It joins other roads only where it starts and ends, on a road or at a junction; ' +
      'elsewhere it passes over or under them.';
    this.status = el('p', 'build-draw-status', this.element);
    this.status.setAttribute('role', 'status');

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

  start(): void {
    this.drawing = true;
    this.points = [];
    this.drawButton.textContent = 'Cancel';
    this.controls.hidden = false;
    this.status.textContent = 'Click on a road or junction where the road starts.';
    this.callbacks.onDrawing(true);
    this.callbacks.onPoints(this.points);
  }

  cancel(): void {
    this.drawing = false;
    this.points = [];
    this.drawButton.textContent = 'Draw a road';
    this.controls.hidden = true;
    this.status.textContent = '';
    this.callbacks.onDrawing(false);
    this.callbacks.onPoints([]);
  }

  /** A point clicked on the map (scene x, z). */
  addPoint(p: Point): void {
    if (!this.drawing) return;
    const last = this.points[this.points.length - 1];
    if (last && Math.hypot(last.x - p.x, last.z - p.z) < 5) return;
    this.points.push({ x: p.x, z: p.z });
    this.status.textContent =
      this.points.length === 1
        ? 'Click along its way, then on the road or junction where it ends, and Finish road.'
        : `${this.points.length} points: Finish road when its end is on a road or junction.`;
    this.callbacks.onPoints(this.points);
  }

  undoPoint(): void {
    this.points.pop();
    this.callbacks.onPoints(this.points);
  }

  finish(): void {
    if (this.points.length < 2) {
      this.status.textContent = 'Click at least where the road starts and where it ends.';
      return;
    }
    const type = this.type.value as NewRoadType;
    const road: RoadEdit = {
      kind: 'road',
      points: this.points,
      type,
      lanes: Number(this.lanes.value),
      oneway: this.oneway.checked,
      kmh: Number(this.speed.value),
      bridge: this.bridge.checked,
    };
    const problem = this.callbacks.onRoad(road);
    if (problem) {
      this.status.textContent = problem;
      return;
    }
    this.cancel();
    this.status.textContent = 'Road added: traffic starts using it within a minute.';
  }
}
