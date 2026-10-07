import type { NetworkEdit } from '../edit/builder';
import { type Edit, type ResolvedEdit, describeEdit, withEdit, sameTarget } from '../edit/edits';
import { junctionSignals, signalEdit } from '../edit/signals';
import { type CompareRow, DIFF_BANDS, type TravelTimeSummary, change } from '../edit/compare';
import type { RoadIndex } from '../edit/roadIndex';
import type { SignalPrograms } from '../sim/wasm';
import { formatClock } from './hud';
import { SignalEditor } from './signalEditor';

/** Speed limits on offer (km/h). */
export const SPEED_LIMITS = [30, 40, 50, 60, 70, 80, 90, 100, 110, 130];
const NUMBER_RANGE = { min: 3, max: 180 };

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

export function button(label: string, parent: HTMLElement, onClick: () => void, title?: string) {
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
  /** A junction made a roundabout or its lights set, replacing the edits `replaces` picks:
   * built into the network if it can be, else the reason it cannot. */
  onNetworkEdit(edit: NetworkEdit, replaces?: (e: Edit) => boolean): string | undefined;
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
  /** Start or stop comparing with today's roads. */
  onCompare(on: boolean): void;
  /** Show or hide the difference map. */
  onDiffMap(on: boolean): void;
}

export const fmt = (n: number, digits: number) =>
  n.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function percent(rel: number): string {
  if (!Number.isFinite(rel)) return '';
  const p = Math.round(rel * 1000) / 10;
  return `${p > 0 ? '+' : ''}${p.toLocaleString('en-GB')} %`;
}

export const minutes = (s: number) => fmt(s / 60, 1);

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
  private readonly junction: HTMLElement;
  private readonly editorSlot: HTMLElement;
  private editor?: { junction: number; view: SignalEditor };
  private readonly count: HTMLElement;
  private readonly list: HTMLElement;
  private readonly missingNote: HTMLElement;
  private readonly inForce: HTMLElement;
  private readonly status: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly compareButton: HTMLButtonElement;
  private readonly compareNote: HTMLElement;
  private readonly compareTable: HTMLTableElement;
  private readonly travel: HTMLElement;
  private readonly diffToggle: HTMLInputElement;
  private readonly diffLegend: HTMLElement;
  private comparing = false;
  private edits: Edit[] = [];
  private resolved: ResolvedEdit[] = [];
  private signals?: SignalPrograms;
  private selectedEdge?: number;
  private shown = false;
  /** The planned project whose network is running, if any. */
  private scenario?: string;

  /** Where the tool for drawing roads goes (ui/roadDrawer.ts). */
  readonly drawSlot: HTMLElement;

  constructor(
    parent: HTMLElement,
    private index: RoadIndex,
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
    this.drawSlot = el('div', 'build-draw-slot', this.panel);

    this.road = el('section', 'build-road', this.panel);
    this.road.hidden = true;
    this.roadName = el('h3', 'build-road-name', this.road);
    this.roadInfo = el('p', 'build-road-info', this.road);
    this.roadControls = el('div', 'build-row', this.road);
    this.lanes = el('div', 'build-lanes', this.road);
    this.turns = el('div', 'build-turns', this.road);
    this.signal = el('div', 'build-signal', this.road);
    this.junction = el('div', 'build-junction', this.road);
    this.editorSlot = el('div', 'build-editor-slot', this.road);

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

    const compare = el('section', 'build-compare', this.panel);
    const compareTitle = el('h3', 'build-count', compare);
    compareTitle.textContent = 'Before and after';
    this.compareNote = el('p', 'build-note', compare);
    this.compareNote.textContent =
      "Run the day again from 06:50 with your edits, next to today's roads with the same trips.";
    const compareRow = el('div', 'build-row', compare);
    this.compareButton = button(
      "Compare with today's roads",
      compareRow,
      () => callbacks.onCompare(!this.comparing),
      'Simulate the edited and the unedited network side by side',
    );
    const diff = el('label', 'build-check', compareRow);
    this.diffToggle = el('input', '', diff);
    this.diffToggle.type = 'checkbox';
    this.diffToggle.disabled = true;
    diff.append(' Difference map');
    this.diffToggle.addEventListener('change', () => {
      this.diffLegend.hidden = !this.diffToggle.checked;
      callbacks.onDiffMap(this.diffToggle.checked);
    });
    this.diffLegend = el('div', 'hud-legend build-legend', compare);
    this.diffLegend.hidden = true;
    for (const band of DIFF_BANDS) {
      if (band.color === 0) continue;
      const item = el('span', '', this.diffLegend);
      const swatch = el('i', '', item);
      swatch.style.background = `#${band.color.toString(16).padStart(6, '0')}`;
      item.append(`traffic ${band.label}`);
    }
    this.compareTable = el('table', 'build-table', compare);
    this.compareTable.hidden = true;
    this.travel = el('div', 'build-travel', compare);

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.shown && this.selectedEdge !== undefined) {
        this.select(undefined);
      }
    });
  }

  get visible(): boolean {
    return this.shown;
  }

  /** The panel, for sections added to it (planned projects). */
  get element(): HTMLElement {
    return this.panel;
  }

  /** The network changed (roads drawn): roads are picked and described on this index. */
  setIndex(index: RoadIndex): void {
    this.index = index;
    this.closeEditor();
    // Roads loaded keep their ids from build to build: keep the one chosen.
    const edge = this.selectedEdge;
    this.select(edge !== undefined && index.editable(edge) ? edge : undefined);
  }

  /** The map runs a planned project's network: compare it (and the edits) with today's. */
  setScenario(name: string | undefined): void {
    this.scenario = name;
    this.compareNote.textContent = name
      ? `Run the day again from 06:50 with ${name} and your edits, next to today's roads with the same trips.`
      : "Run the day again from 06:50 with your edits, next to today's roads with the same trips.";
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
    const network = this.scenario ? 'this' : "today's";
    this.missingNote.textContent = `${missing} edit${missing === 1 ? '' : 's'} could not be matched to ${network} road network and are not in force.`;
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

  /** Whether the edited and today's networks are being compared. */
  setComparing(on: boolean): void {
    this.comparing = on;
    this.compareButton.textContent = on ? 'Stop comparing' : "Compare with today's roads";
    this.compareButton.setAttribute('aria-pressed', String(on));
    this.diffToggle.disabled = !on;
    if (!on) {
      this.diffToggle.checked = false;
      this.diffLegend.hidden = true;
      this.compareTable.hidden = true;
      this.travel.replaceChildren();
    }
  }

  /** Measures of both simulations at simulated time `time`. */
  setComparison(time: number, rows: readonly CompareRow[]): void {
    this.compareTable.hidden = false;
    const edited = this.scenario ? 'With project' : 'With edits';
    const head = `<thead><tr><th>At ${formatClock(time)}</th><th>Today</th><th>${edited}</th><th>Change</th></tr></thead>`;
    this.compareTable.innerHTML = head;
    const body = el('tbody', '', this.compareTable);
    for (const row of rows) {
      const tr = el('tr', '', body);
      const label = el('th', '', tr);
      label.textContent = row.unit ? `${row.label} (${row.unit})` : row.label;
      el('td', '', tr).textContent = fmt(row.today, row.digits);
      el('td', '', tr).textContent = fmt(row.edited, row.digits);
      const rel = change(row.today, row.edited);
      const cell = el('td', '', tr);
      cell.textContent = percent(rel);
      if (Math.abs(rel) >= 0.005 && Number.isFinite(rel)) {
        cell.className = rel > 0 === row.moreIsBetter ? 'build-better' : 'build-worse';
      }
    }
  }

  /** Travel times between places, today and with the edits. */
  setTravelTimes(time: number, summary: TravelTimeSummary): void {
    const lines: string[] = [
      `Travel times by car between the City's districts and four nearby towns, at ${formatClock(time)}: ` +
        `${percent(summary.mean) || 'no change'} on average over ${summary.pairs} trips.`,
    ];
    for (const [title, list] of [
      ['Slower', summary.slower],
      ['Faster', summary.faster],
    ] as const) {
      for (const c of list) {
        lines.push(
          `${title}: ${c.from} → ${c.to}, ${minutes(c.today)} → ${minutes(c.edited)} min ` +
            `(${percent(change(c.today, c.edited))})`,
        );
      }
    }
    this.travel.replaceChildren(
      ...lines.map((text, i) => {
        const p = el('p', i === 0 ? 'build-travel-summary' : 'build-travel-pair');
        p.textContent = text;
        return p;
      }),
    );
  }

  /** How many edits the simulation has in force. */
  setInForce(applied: number): void {
    this.inForce.textContent =
      applied === 0
        ? ''
        : `${applied} edit${applied === 1 ? '' : 's'} in force: traffic re-plans its routes over the next minute.`;
  }

  select(edge: number | undefined): void {
    if (edge !== this.selectedEdge) this.closeEditor();
    this.selectedEdge = edge;
    this.renderRoad();
    this.callbacks.onSelect(edge);
  }

  private closeEditor(): void {
    this.editor = undefined;
    this.editorSlot.replaceChildren();
  }

  /** The signal editor for junction `j`. */
  private openEditor(j: number): void {
    this.closeEditor();
    const signals = junctionSignals(this.index.net, j, this.signals);
    const tls = signals.tls;
    const view = new SignalEditor(this.editorSlot, signals, {
      onApply: (phases) => {
        // Green times set before on these lights go: the editor sets them all.
        const replaces = (e: Edit) =>
          e.kind === 'green' && this.resolved.some((r) => r.edit === e && r.tls === tls);
        const problem = this.callbacks.onNetworkEdit(signalEdit(signals, phases), replaces);
        if (!problem) {
          this.closeEditor();
          this.setStatus(
            phases.length
              ? `Traffic lights set at ${signals.junction.name}.`
              : `Traffic lights taken away at ${signals.junction.name}.`,
          );
        }
        return problem;
      },
      onClose: () => this.closeEditor(),
    });
    this.editor = { junction: j, view };
    view.element.scrollIntoView?.({ block: 'nearest' });
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
    const playerSet = tls !== undefined && (net.arrays.tlsFixed as Uint8Array | undefined)?.[tls];
    if (tls !== undefined && signals && tls + 1 < signals.phaseOffsets.length) {
      const junction = index.junctionRef(tls, ref.name ? `Signals at ${ref.name}` : undefined);
      const title = el('div', 'build-subtitle', this.signal);
      const a = signals.phaseOffsets[tls];
      const b = signals.phaseOffsets[tls + 1];
      let cycle = 0;
      for (let p = a; p < b; p++) cycle += signals.duration[p];
      title.textContent = `Signals ahead: ${b - a} phases, ${Math.round(cycle)} s cycle`;
      // Lights the player set are changed in the signal editor.
      if (playerSet) title.textContent += ', set by you';
      const row = el('div', 'build-row', this.signal);
      for (let p = a; p < b && !playerSet; p++) {
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

    // The junction ahead: a roundabout, traffic lights.
    this.junction.replaceChildren();
    const j = net.edgeTo[edge];
    const ring = (e: number) => (net.edgeFlags[e] & net.index.flags.roundabout) !== 0;
    const onRing = ring(edge) || turns.some((t) => ring(t.to));
    if (this.editor && this.editor.junction !== j) this.closeEditor();
    if (turns.length === 0 || onRing) return;
    const { junction: point, tls: lights } = junctionSignals(net, j, this.signals);
    const title = el('div', 'build-subtitle', this.junction);
    title.textContent = `The junction ahead: ${point.name}`;
    const row = el('div', 'build-row', this.junction);
    const ringLanes = el('select', 'build-select', row);
    ringLanes.setAttribute('aria-label', 'Roundabout lanes');
    for (const n of [1, 2]) {
      const o = el('option', '', ringLanes);
      o.value = String(n);
      o.textContent = `${n} lane${n === 1 ? '' : 's'}`;
    }
    button(
      'Make a roundabout',
      row,
      () => {
        const problem = this.callbacks.onNetworkEdit({
          kind: 'roundabout',
          junction: point,
          lanes: Number(ringLanes.value),
        });
        this.setStatus(
          problem ?? `${point.name} is now a roundabout: traffic re-plans its routes.`,
        );
      },
      'Replace the junction with a roundabout that traffic entering gives way on',
    );
    button(lights === undefined ? 'Add traffic lights' : 'Edit traffic lights', row, () =>
      this.openEditor(j),
    );
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
