import type { ViewMode } from '../camera/CameraRig';
import { formatDistance, niceScaleLength } from '../camera/viewMath';
import type { Attribution } from '../manifest';

export interface HudCallbacks {
  onMode(mode: ViewMode): void;
  onRotateIso(direction: 1 | -1): void;
  onFaceNorth(): void;
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

  constructor(container: HTMLElement, callbacks: HudCallbacks) {
    this.root = el('div', 'hud', container);

    const title = el('div', 'hud-panel hud-title', this.root);
    title.innerHTML = '<strong>ZG City Sim</strong><span>Zagreb · prototype</span>';

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
      if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) return;
      const mode = MODES.find((m) => m.key === event.key)?.mode;
      if (mode) callbacks.onMode(mode);
      else if (event.key === 'q' || event.key === 'Q') callbacks.onRotateIso(-1);
      else if (event.key === 'e' || event.key === 'E') callbacks.onRotateIso(1);
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
