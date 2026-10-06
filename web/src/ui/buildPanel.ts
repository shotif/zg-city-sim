import { type Edit, type ResolvedEdit, describeEdit, withEdit, sameTarget } from '../edit/edits';
import type { RoadIndex } from '../edit/roadIndex';
import type { SignalPrograms } from '../sim/wasm';

/** Speed limits on offer (km/h). */
export const SPEED_LIMITS = [30, 40, 50, 60, 70, 80, 90, 100, 110, 130];
const NUMBER_RANGE = { min: 3, max: 180 };

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

function button(label: string, parent: HTMLElement, onClick: () => void, title?: string) {
  const b = el('button', 'hud-button hud-speed', parent);
  b.type = 'button';
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

const COMPASS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
];
function compass(heading: number): string {
  return COMPASS[Math.round(heading / 45) % 8];
}

/** Road class names for the panel, by the first part of the network's edge types. */
function roadKind(type: string): string {
  const highway = type.split('|')[0].replace('highway.', '').replace('_link', ' slip road');
  return highway.replace('_', ' ');
}

export interface BuildPanelCallbacks {
  /** The list of edits changed. */
  onEdits(edits: Edit[]): void;
  /** A road was chosen (undefined: none). */
  onSelect(edge: number | undefined): void;
  /** The panel was closed. */
  onClose(): void;
  /** A link to these edits, for sharing. */
  shareLink(edits: Edit[]): Promise<string>;
  /** Edits from a file the player chose. */
  importFile(file: File): Promise<Edit[]>;
  /** Save the edits as a file. */
  exportFile(edits: Edit[]): void;
}

/**
 * The Build panel (key B): pick a road on the map to close it or its lanes, change its
 * speed limit, make a lane a bus lane, ban turns at the junction it leads to and change the
 * green times there; list, undo and share the edits.
 */
export class BuildPanel {
  private readonly panel: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly road: HTMLElement;
  private readonly roadName: HTMLElement;
  private readonly roadInfo: HTMLElement;
  private readonly roadControls: HTMLElement;
  private readonly lanes: HTMLElement;
  private readonly turns: HTMLElement;
  private readonly signal: HTMLElement;
  private readonly count: HTMLElement;
  private readonly list: HTMLElement;
  private readonly missingNote: HTMLElement;
  private readonly inForce: HTMLElement;
  private readonly status: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private edits: Edit[] = [];
  private resolved: ResolvedEdit[] = [];
  private signals?: SignalPrograms;
  private selectedEdge?: number;
  private shown = false;

  constructor(
    parent: HTMLElement,
    private readonly index: RoadIndex,
    private readonly callbacks: BuildPanelCallbacks,
  ) {
    this.panel = el('aside', 'hud-panel build-panel', parent);
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Build');
    const header = el('div', 'news-header', this.panel);
    const title = el('h2', 'build-title', header);
    title.textContent = 'Build';
    const close = el('button', 'hud-button hud-icon', header);
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close (B)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => callbacks.onClose());

    this.hint = el('p', 'build-hint', this.panel);
    this.hint.textContent = 'Click a road on the map to change it.';

    this.road = el('section', 'build-road', this.panel);
    this.road.hidden = true;
    this.roadName = el('h3', 'build-road-name', this.road);
    this.roadInfo = el('p', 'build-road-info', this.road);
    this.roadControls = el('div', 'build-row', this.road);
    this.lanes = el('div', 'build-lanes', this.road);
    this.turns = el('div', 'build-turns', this.road);
    this.signal = el('div', 'build-signal', this.road);

    const edits = el('section', 'build-edits', this.panel);
    this.count = el('h3', 'build-count', edits);
    this.list = el('ul', 'build-list', edits);
    this.missingNote = el('p', 'build-missing', edits);
    this.missingNote.hidden = true;
    this.inForce = el('p', 'build-force', edits);
    const actions = el('div', 'build-row', edits);
    button(
      'Undo',
      actions,
      () => this.setEditsAndNotify(this.edits.slice(0, -1)),
      'Remove the last edit',
    );
    button('Clear', actions, () => this.setEditsAndNotify([]), 'Remove all edits');
    button('Share link', actions, () => void this.share(), 'Copy a link to these edits');
    button('Export', actions, () => callbacks.exportFile(this.edits), 'Save the edits as a file');
    button('Import', actions, () => this.fileInput.click(), 'Load edits from a file');
    this.fileInput = el('input', 'build-file', edits);
    this.fileInput.type = 'file';
    this.fileInput.accept = 'application/json,.json';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => void this.importChosen());
    this.status = el('p', 'build-status', edits);
    this.status.setAttribute('role', 'status');
    this.renderList();

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.shown && this.selectedEdge !== undefined) {
        this.select(undefined);
      }
    });
  }

  get visible(): boolean {
    return this.shown;
  }

  get selected(): number | undefined {
    return this.selectedEdge;
  }

  setVisible(shown: boolean): void {
    this.shown = shown;
    this.panel.hidden = !shown;
    if (!shown) this.select(undefined);
  }

  /** The edits in force, matched to the network, and those that do not fit it. */
  setEdits(edits: Edit[], resolved: ResolvedEdit[], missing: number): void {
    this.edits = edits;
    this.resolved = resolved;
    this.missingNote.hidden = missing === 0;
    this.missingNote.textContent = `${missing} edit${missing === 1 ? '' : 's'} could not be matched to today's road network and are not in force.`;
    this.renderList();
    this.renderRoad();
  }

  /** The signal programs the engine runs (they include green-time edits). */
  setSignals(signals: SignalPrograms): void {
    this.signals = signals;
    this.renderRoad();
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** How many edits the simulation has in force. */
  setInForce(applied: number): void {
    this.inForce.textContent =
      applied === 0
        ? ''
        : `${applied} edit${applied === 1 ? '' : 's'} in force: traffic re-plans its routes over the next minute.`;
  }

  select(edge: number | undefined): void {
    this.selectedEdge = edge;
    this.renderRoad();
    this.callbacks.onSelect(edge);
  }

  private setEditsAndNotify(edits: Edit[]): void {
    this.callbacks.onEdits(edits);
  }

  private add(edit: Edit): void {
    this.setEditsAndNotify(withEdit(this.edits, edit));
  }

  private remove(edit: Edit): void {
    this.setEditsAndNotify(this.edits.filter((e) => !sameTarget(e, edit)));
  }

  /** The edit in force of this kind on the selected road, if any. */
  private editOn<K extends Edit['kind']>(
    kind: K,
    test: (e: Extract<Edit, { kind: K }>) => boolean = () => true,
  ): Extract<Edit, { kind: K }> | undefined {
    const edge = this.selectedEdge;
    for (const r of this.resolved) {
      if (
        r.edit.kind === kind &&
        r.edges[0] === edge &&
        test(r.edit as Extract<Edit, { kind: K }>)
      ) {
        return r.edit as Extract<Edit, { kind: K }>;
      }
    }
    return undefined;
  }

  private renderList(): void {
    this.count.textContent =
      this.edits.length === 0 ? 'No edits yet' : `Edits (${this.edits.length})`;
    this.list.replaceChildren(
      ...this.edits.map((edit) => {
        const item = el('li', 'build-item');
        const text = el('span', '', item);
        text.textContent = describeEdit(edit);
        const remove = el('button', 'hud-button hud-icon', item);
        remove.type = 'button';
        remove.textContent = '✕';
        remove.title = 'Remove this edit';
        remove.setAttribute('aria-label', `Remove: ${describeEdit(edit)}`);
        remove.addEventListener('click', () => this.remove(edit));
        return item;
      }),
    );
  }

  private renderRoad(): void {
    const edge = this.selectedEdge;
    this.hint.hidden = edge !== undefined;
    this.road.hidden = edge === undefined;
    if (edge === undefined) return;
    const index = this.index;
    const net = index.net;
    const ref = index.ref(edge);
    const lanes = net.edgeLaneCount[edge];
    const builtKmh = Math.round((net.laneSpeed[net.edgeLaneStart[edge]] * 3.6) / 5) * 5;
    const speed = this.editOn('speed');
    const closed = this.editOn('close');
    this.roadName.textContent = ref.name ?? 'Unnamed road';
    this.roadInfo.textContent =
      `${roadKind(net.index.types[net.edgeType[edge]])} · ${lanes} lane${lanes === 1 ? '' : 's'} · ` +
      `${speed?.kmh ?? builtKmh} km/h · towards the ${compass(ref.heading)}`;

    // Close or reopen; speed limit.
    this.roadControls.replaceChildren();
    if (closed) button('Reopen road', this.roadControls, () => this.remove(closed));
    else {
      button(
        'Close road',
        this.roadControls,
        () => this.add({ kind: 'close', road: ref }),
        'Close to cars and trucks (buses and trams keep their routes)',
      );
    }
    const label = el('label', 'build-label', this.roadControls);
    label.textContent = 'Speed limit ';
    const select = el('select', 'build-select', label);
    select.setAttribute('aria-label', 'Speed limit');
    const asBuilt = el('option', '', select);
    asBuilt.value = '';
    asBuilt.textContent = `as built (${builtKmh} km/h)`;
    for (const kmh of SPEED_LIMITS) {
      const option = el('option', '', select);
      option.value = String(kmh);
      option.textContent = `${kmh} km/h`;
    }
    select.value = speed ? String(speed.kmh) : '';
    select.addEventListener('change', () => {
      if (select.value === '') {
        if (speed) this.remove(speed);
      } else this.add({ kind: 'speed', road: ref, kmh: Number(select.value) });
    });

    // Lanes, left to right as drivers see them (lane 0 is the rightmost).
    this.lanes.replaceChildren();
    const lanesTitle = el('div', 'build-subtitle', this.lanes);
    lanesTitle.textContent = 'Lanes, left to right';
    const laneRow = el('div', 'build-row', this.lanes);
    for (let k = lanes - 1; k >= 0; k--) {
      const lane = net.edgeLaneStart[edge] + k;
      const usable = net.allows(lane, 'passenger') || net.allows(lane, 'bus');
      const closedLane = this.editOn('closeLane', (e) => e.lane === k);
      const busLane = this.editOn('busLane', (e) => e.lane === k);
      const pick = el('select', 'build-select', laneRow);
      pick.setAttribute('aria-label', `Lane ${lanes - k} from the left`);
      for (const [value, text] of [
        ['open', usable ? 'open' : 'as built'],
        ['closed', 'closed'],
        ['bus', 'bus lane'],
      ]) {
        const option = el('option', '', pick);
        option.value = value;
        option.textContent = text;
      }
      pick.value = closedLane ? 'closed' : busLane ? 'bus' : 'open';
      pick.addEventListener('change', () => {
        if (pick.value === 'closed') this.add({ kind: 'closeLane', road: ref, lane: k });
        else if (pick.value === 'bus') this.add({ kind: 'busLane', road: ref, lane: k });
        else this.remove(closedLane ?? busLane!);
      });
    }

    // Turns at the junction ahead.
    this.turns.replaceChildren();
    const turns = index.turns(edge);
    if (turns.length > 0) {
      const turnsTitle = el('div', 'build-subtitle', this.turns);
      turnsTitle.textContent = 'Turns at the junction ahead';
      for (const turn of turns) {
        const to = index.ref(turn.to);
        const banned = this.resolved.find(
          (r) => r.edit.kind === 'ban' && r.edges[0] === edge && r.edges[1] === turn.to,
        );
        const row = el('label', 'build-check', this.turns);
        const box = el('input', '', row);
        box.type = 'checkbox';
        box.checked = !banned;
        row.append(` ${turn.direction} onto ${turn.name ?? 'an unnamed road'}`);
        box.addEventListener('change', () => {
          if (box.checked && banned) this.remove(banned.edit);
          else if (!box.checked) this.add({ kind: 'ban', from: ref, to });
        });
      }
    }

    // Green times of the signals there.
    this.signal.replaceChildren();
    const tls = index.signalAt(edge);
    const signals = this.signals;
    if (tls !== undefined && signals && tls + 1 < signals.phaseOffsets.length) {
      const junction = index.junctionRef(tls, ref.name ? `Signals at ${ref.name}` : undefined);
      const title = el('div', 'build-subtitle', this.signal);
      const a = signals.phaseOffsets[tls];
      const b = signals.phaseOffsets[tls + 1];
      let cycle = 0;
      for (let p = a; p < b; p++) cycle += signals.duration[p];
      title.textContent = `Signals ahead: ${b - a} phases, ${Math.round(cycle)} s cycle`;
      const row = el('div', 'build-row', this.signal);
      for (let p = a; p < b; p++) {
        const states = String.fromCharCode(
          ...signals.states.subarray(signals.stateOffsets[p], signals.stateOffsets[p + 1]),
        );
        if (/[yY]/.test(states) || !/[Gg]/.test(states)) continue;
        const phase = p - a;
        const field = el('label', 'build-label', row);
        field.textContent = `Phase ${phase + 1} green `;
        const input = el('input', 'build-number', field);
        input.type = 'number';
        input.min = String(NUMBER_RANGE.min);
        input.max = String(NUMBER_RANGE.max);
        input.step = '1';
        input.value = String(Math.round(signals.duration[p]));
        input.setAttribute('aria-label', `Phase ${phase + 1} green time (s)`);
        field.append(' s');
        input.addEventListener('change', () => {
          const seconds = Math.round(Number(input.value));
          if (!junction || !Number.isFinite(seconds)) return;
          const clamped = Math.min(NUMBER_RANGE.max, Math.max(NUMBER_RANGE.min, seconds));
          this.add({ kind: 'green', junction, phase, seconds: clamped });
        });
      }
    }
  }

  private async share(): Promise<void> {
    if (this.edits.length === 0) {
      this.setStatus('Nothing to share yet.');
      return;
    }
    try {
      const link = await this.callbacks.shareLink(this.edits);
      await navigator.clipboard?.writeText(link);
      this.setStatus('Link copied.');
    } catch {
      this.setStatus('Could not copy the link.');
    }
  }

  private async importChosen(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;
    try {
      const edits = await this.callbacks.importFile(file);
      this.setEditsAndNotify(edits);
      this.setStatus(`Loaded ${edits.length} edit${edits.length === 1 ? '' : 's'}.`);
    } catch {
      this.setStatus('That file is not a list of edits.');
    }
  }
}
