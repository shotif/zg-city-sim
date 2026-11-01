import { type Cities, type City, GAME_MODES, type GameMode, MAX_NAME } from '../game/cities';
import { button, el } from './buildPanel';

const MODES = Object.keys(GAME_MODES) as GameMode[];

/** "Career, day 3" for a city. */
export function cityLabel(city: City, day: number): string {
  return `${GAME_MODES[city.mode].label}, day ${day}`;
}

/**
 * The first visit's question (M19a): how to play, and the city's name. Resolves with the
 * city made, which is played from then on.
 */
export function chooseCity(parent: HTMLElement, cities: Cities): Promise<City> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'hud-credits city-chooser', parent);
    dialog.setAttribute('aria-labelledby', 'city-chooser-title');
    const title = el('h2', '', dialog);
    title.id = 'city-chooser-title';
    title.textContent = 'How do you want to play?';
    el('p', '', dialog).textContent =
      "ZG City Sim runs a weekday of Zagreb's traffic, calibrated to traffic counts. Choose " +
      'how to play this city; you can make more, in any mode, from the City panel.';
    const label = el('label', 'build-label city-name', dialog);
    label.append('City name ');
    const name = el('input', 'build-select', label);
    name.value = 'Zagreb';
    name.maxLength = MAX_NAME;
    const choices = el('div', 'city-modes', dialog);
    for (const mode of MODES) {
      const choice = el('button', 'hud-button city-mode', choices);
      choice.type = 'button';
      el('strong', '', choice).textContent = GAME_MODES[mode].label;
      el('span', '', choice).textContent = GAME_MODES[mode].text;
      choice.addEventListener('click', () => {
        const city = cities.create(name.value, mode);
        cities.setCurrent(city.id);
        dialog.close();
        dialog.remove();
        resolve(city);
      });
    }
    // A choice is needed: Escape does not close it.
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    dialog.showModal();
  });
}

export interface CitiesPanelCallbacks {
  onClose(): void;
  /** Play city `id`: keep the city played as it is, then switch (the page reloads). */
  onPlay(id: string): void;
  /** Keep the city played as it is now (before its file is saved). */
  onSave(): void;
}

/**
 * The City panel (M19a): the cities kept in this browser, each with its mode and the
 * simulated days played; play another, rename, delete or save one to a file, make a new
 * one or load one from a file.
 */
export class CitiesPanel {
  private readonly panel: HTMLElement;
  private readonly playing: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly name: HTMLInputElement;
  private readonly mode: HTMLSelectElement;
  private shown = false;
  /** The city asked to be deleted, waiting for the second click. */
  private deleting?: string;
  private renaming?: string;

  constructor(
    parent: HTMLElement,
    private readonly cities: Cities,
    private readonly city: City,
    private readonly callbacks: CitiesPanelCallbacks,
  ) {
    this.panel = el('aside', 'hud-panel cities-panel', parent);
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Cities');
    const header = el('div', 'news-header', this.panel);
    el('h2', 'build-title', header).textContent = 'Cities';
    const close = el('button', 'hud-button hud-icon', header);
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => callbacks.onClose());
    this.playing = el('p', 'build-note', this.panel);
    this.list = el('ul', 'cities-list', this.panel);

    el('h3', 'build-count', this.panel).textContent = 'A new city';
    const row = el('div', 'build-row', this.panel);
    const nameLabel = el('label', 'build-label', row);
    nameLabel.append('Name ');
    this.name = el('input', 'build-select', nameLabel);
    this.name.value = 'Zagreb';
    this.name.maxLength = MAX_NAME;
    this.name.setAttribute('aria-label', 'New city name');
    const modeLabel = el('label', 'build-label', row);
    modeLabel.append('Mode ');
    this.mode = el('select', 'build-select', modeLabel);
    this.mode.setAttribute('aria-label', 'New city mode');
    for (const m of MODES) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = GAME_MODES[m].label;
      this.mode.append(o);
    }
    this.mode.value = 'career';
    const note = el('p', 'build-note', this.panel);
    const describe = () => {
      note.textContent = GAME_MODES[this.mode.value as GameMode].text;
    };
    this.mode.addEventListener('change', describe);
    describe();
    const actions = el('div', 'build-row', this.panel);
    button('Make and play', actions, () => {
      const made = this.cities.create(this.name.value, this.mode.value as GameMode);
      this.callbacks.onPlay(made.id);
    });
    const file = el('input', '', actions);
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    button('Load from a file', actions, () => file.click(), 'A city saved from this game');
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      chosen
        .text()
        .then((text) => {
          const city = this.cities.importCity(text);
          this.status.textContent = `Loaded ${city.name}: play it from the list.`;
          this.show();
        })
        .catch((error: unknown) => {
          this.status.textContent = `That file could not be loaded: ${
            error instanceof Error ? error.message : 'not a city'
          }.`;
        });
    });
    this.status = el('p', 'build-draw-status', this.panel);
    this.status.setAttribute('role', 'status');
    el('p', 'budget-note', this.panel).textContent =
      'Cities are kept in this browser only: save one to a file to keep it safe or move it ' +
      'to another browser.';
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(on: boolean): void {
    this.shown = on;
    this.panel.hidden = !on;
    this.deleting = undefined;
    this.renaming = undefined;
    if (on) this.show();
  }

  /** List the cities as they are kept now. */
  show(): void {
    const here = this.cities.get(this.city.id) ?? this.city;
    this.playing.textContent = `Playing ${here.name}: ${cityLabel(here, this.cities.day(here.id))}.`;
    this.list.replaceChildren(...this.cities.list().map((c) => this.row(c)));
  }

  private row(city: City): HTMLElement {
    const item = document.createElement('li');
    const current = city.id === this.city.id;
    const head = el('div', 'cities-row', item);
    if (this.renaming === city.id) {
      const input = el('input', 'build-select', head);
      input.value = city.name;
      input.maxLength = MAX_NAME;
      input.setAttribute('aria-label', 'City name');
      const save = () => {
        this.cities.rename(city.id, input.value);
        this.renaming = undefined;
        this.show();
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') save();
      });
      button('Save', head, save);
      queueMicrotask(() => input.focus());
    } else {
      el('strong', '', head).textContent = city.name;
    }
    const when = new Date(city.played).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
    });
    el('span', 'cities-meta', item).textContent =
      `${cityLabel(city, this.cities.day(city.id))} · ${current ? 'playing now' : `played ${when}`}`;
    const actions = el('div', 'build-row', item);
    if (!current)
      button('Play', actions, () => this.callbacks.onPlay(city.id), `Play ${city.name}`);
    button('Rename', actions, () => {
      this.renaming = city.id;
      this.show();
    });
    button(
      'Save to a file',
      actions,
      () => {
        if (current) this.callbacks.onSave();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(
          new Blob([this.cities.exportCity(city.id)], { type: 'application/json' }),
        );
        link.download = `${city.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      },
      `Save ${city.name} to a file`,
    );
    if (!current) {
      const asked = this.deleting === city.id;
      button(asked ? 'Delete for good' : 'Delete', actions, () => {
        if (!asked) {
          this.deleting = city.id;
        } else {
          this.cities.remove(city.id);
          this.deleting = undefined;
          this.status.textContent = `Deleted ${city.name}.`;
        }
        this.show();
      });
    }
    return item;
  }
}
