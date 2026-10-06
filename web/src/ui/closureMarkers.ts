import { type PlacedClosure, formatUntil } from '../world/closures';

const SUBTYPES: Record<string, string> = {
  ROAD_CLOSED_CONSTRUCTION: 'roadworks',
  ROAD_CLOSED_EVENT: 'event',
  ROAD_CLOSED_HAZARD: 'hazard',
};

/** "Grada Vukovara closed for roadworks, one direction, until 6 Oct, 22:00." */
export function describeClosure({ closure }: PlacedClosure): string {
  const why = closure.subtype ? SUBTYPES[closure.subtype] : undefined;
  const parts = [`${closure.street || 'Road'} closed${why ? ` for ${why}` : ''}`];
  if (closure.direction === 'ONE_DIRECTION') parts.push('one direction');
  const until = formatUntil(closure.expectedEndTime);
  if (until) parts.push(`until ${until}`);
  return `${parts.join(', ')}.`;
}

/** Markers on the map for live road closures, and a line describing the one tapped. */
export class ClosureMarkers {
  private readonly layer: HTMLElement;
  private readonly info: HTMLElement;
  private placed: PlacedClosure[] = [];
  private buttons: HTMLButtonElement[] = [];
  private shown = true;

  constructor(parent: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'news-markers';
    parent.prepend(this.layer);
    this.info = document.createElement('div');
    this.info.className = 'hud-panel closure-info';
    this.info.hidden = true;
    this.info.setAttribute('role', 'status');
    parent.append(this.info);
  }

  get visible(): boolean {
    return this.shown && this.placed.length > 0;
  }

  set(placed: PlacedClosure[]): void {
    this.placed = placed;
    this.layer.replaceChildren();
    this.buttons = placed.map((p) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'closure-marker';
      const text = describeClosure(p);
      button.title = text;
      button.setAttribute('aria-label', text);
      button.addEventListener('click', () => {
        this.info.textContent = text;
        this.info.hidden = false;
      });
      this.layer.append(button);
      return button;
    });
  }

  setVisible(shown: boolean): void {
    this.shown = shown;
    this.layer.hidden = !shown;
    if (!shown) this.info.hidden = true;
  }

  /** Move the markers to where their closures are on screen (null: off screen). */
  place(project: (x: number, z: number) => [number, number] | null): void {
    if (!this.visible) return;
    this.placed.forEach((p, i) => {
      const at = project(p.x, p.z);
      const button = this.buttons[i];
      button.hidden = at === null;
      if (at) button.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, -50%)`;
    });
  }
}
