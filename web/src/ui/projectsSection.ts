import { change } from '../edit/compare';
import { type ProjectInfo, comparisonRows } from '../edit/projects';
import { button, el, fmt, minutes, percent } from './buildPanel';

export interface ProjectsCallbacks {
  /** Run a project's network in place of today's (undefined: back to today's roads). */
  onOpen(id: string | undefined): void;
  /** Fly to where a project builds. */
  onShow(project: ProjectInfo): void;
}

const pad = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

/**
 * Planned projects in the Build panel: pick one to read what it builds, where it stands and
 * how the simulated morning peak changes with it, then open it to run its network.
 */
export class ProjectsSection {
  readonly element: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly card: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly projects: readonly ProjectInfo[],
    /** The project whose network is running, if any. */
    private readonly current: string | undefined,
    private readonly callbacks: ProjectsCallbacks,
  ) {
    this.element = el('section', 'build-projects', parent);
    const title = el('h3', 'build-count', this.element);
    title.textContent = 'Planned projects';
    const note = el('p', 'build-note', this.element);
    note.textContent = current
      ? "This map runs a planned project. Pick another, or go back to today's roads."
      : 'Roads Zagreb plans or is building, each simulated on a network of its own.';
    const label = el('label', 'build-label', this.element);
    label.append('Project ');
    this.select = el('select', 'build-select build-project-select', label);
    for (const p of [{ id: '', name: "Today's roads" }, ...projects]) {
      const option = el('option', '', this.select);
      option.value = p.id;
      option.textContent = p.name;
    }
    this.select.value = current ?? projects[0]?.id ?? '';
    this.select.addEventListener('change', () => this.render());
    this.card = el('div', 'build-project', this.element);
    this.render();
  }

  private render(): void {
    const id = this.select.value || undefined;
    const project = this.projects.find((p) => p.id === id);
    this.card.replaceChildren();
    const actions = el('div', 'build-row', this.card);
    if (!project) {
      if (this.current) {
        button("Back to today's roads", actions, () => this.callbacks.onOpen(undefined));
      }
      return;
    }
    const status = el('p', 'build-project-status', this.card);
    status.textContent = project.status;
    const summary = el('p', 'build-project-summary', this.card);
    summary.textContent = project.summary;
    const c = project.comparison;
    if (c) {
      const head = el('p', 'build-project-head', this.card);
      head.textContent =
        `Simulated morning peak, ${pad(c.fromHour)}–${pad(c.fromHour + c.hours)}, ` +
        `today and with the project:`;
      const table = el('table', 'build-project-table', this.card);
      table.innerHTML =
        '<thead><tr><th></th><th>Today</th><th>With it</th><th>Change</th></tr></thead>';
      const body = el('tbody', '', table);
      for (const row of comparisonRows(c)) {
        const tr = el('tr', '', body);
        el('th', '', tr).textContent = row.unit ? `${row.label} (${row.unit})` : row.label;
        el('td', '', tr).textContent = fmt(row.today, row.digits);
        el('td', '', tr).textContent = fmt(row.edited, row.digits);
        const rel = change(row.today, row.edited);
        const cell = el('td', '', tr);
        cell.textContent = percent(rel);
        if (Math.abs(rel) >= 0.005 && Number.isFinite(rel)) {
          cell.className = rel > 0 === row.moreIsBetter ? 'build-better' : 'build-worse';
        }
      }
      const lines = [
        `Travel times by car between the City's districts and four nearby towns: ` +
          `${percent(c.travel.mean) || 'no change'} on average over the four hours.`,
        ...c.travel.faster.map(
          (p) =>
            `Faster: ${p.from} → ${p.to}, ${minutes(p.today)} → ${minutes(p.project)} min ` +
            `(${percent(change(p.today, p.project))})`,
        ),
        ...c.travel.slower.map(
          (p) =>
            `Slower: ${p.from} → ${p.to}, ${minutes(p.today)} → ${minutes(p.project)} min ` +
            `(${percent(change(p.today, p.project))})`,
        ),
      ];
      for (const [i, text] of lines.entries()) {
        el('p', i === 0 ? 'build-project-head' : 'build-project-line', this.card).textContent =
          text;
      }
      if (c.roads.length) {
        el('p', 'build-project-head', this.card).textContent =
          'Roads nearby whose traffic changes most (vehicle-km in the four hours):';
        for (const r of c.roads) {
          const rel = change(r.today, r.project);
          el('p', 'build-project-line', this.card).textContent =
            `${r.name}: ${fmt(r.today, 0)} → ${fmt(r.project, 0)}` +
            (Number.isFinite(rel) ? ` (${percent(rel)})` : ' (new)');
        }
      }
      const noise = c.noise
        ? ` Today is the mean of two runs with other random trips, which differ by ` +
          `${Math.round(c.noise.delay * 100)} % in delay and ` +
          `${Math.round(c.noise.travel * 100)} % in travel times: smaller changes are noise.`
        : ' One run each: changes of a few per cent are noise.';
      el('p', 'build-note', this.card).textContent =
        `Simulated on ${c.computed} with ${Math.round(c.demandScale * 100)} % of the ` +
        `estimated demand.${noise}`;
    } else {
      el('p', 'build-note', this.card).textContent =
        project.id === this.current
          ? "No before and after numbers yet: compare it with today's roads under Before and after."
          : "No before and after numbers yet: open it, then compare it with today's roads.";
    }
    const sources = el('p', 'build-note build-project-sources', this.card);
    sources.append('Sources: ');
    project.sources.forEach((s, i) => {
      if (i) sources.append('; ');
      const a = el('a', '', sources);
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = s.title;
    });
    if (project.id === this.current) {
      button("Back to today's roads", actions, () => this.callbacks.onOpen(undefined));
    } else {
      button('Open this project', actions, () => this.callbacks.onOpen(project.id));
    }
    button('Show where', actions, () => this.callbacks.onShow(project), 'Fly to the project');
    // The buttons go below the text.
    this.card.append(actions);
  }
}
