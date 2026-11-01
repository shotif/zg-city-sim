import {
  type CareerState,
  STAGES,
  type Stage,
  goalText,
  progress,
  progressText,
} from '../game/career';
import type { DayRecord } from '../game/days';
import { euros } from '../grow/economy';
import { el } from './buildPanel';

/**
 * The Career panel (M19c): the stage being played, its goals and where each stands, its
 * grant, and the stages done.
 */
export class CareerPanel {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private shown = false;

  constructor(
    parent: HTMLElement,
    onClose: () => void,
    /** A news hotspot's name, by its id. */
    private readonly place: (id: string) => string,
  ) {
    this.panel = el('aside', 'hud-panel cities-panel career-panel', parent);
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Career');
    const header = el('div', 'news-header', this.panel);
    el('h2', 'build-title', header).textContent = 'Career';
    const close = el('button', 'hud-button hud-icon', header);
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close (G)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', onClose);
    this.body = el('div', '', this.panel);
    el('p', 'budget-note', this.panel).textContent =
      'Goals are judged at midnight. Traffic differs from one run of a day to the next by ' +
      'about a sixth in the hours lost, so goals on traffic take the mean of the last two ' +
      'whole days. A career cannot be lost: in debt, building stops until money comes in.';
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(on: boolean): void {
    this.shown = on;
    this.panel.hidden = !on;
  }

  show(state: CareerState, days: readonly DayRecord[]): void {
    this.body.replaceChildren();
    const total = STAGES.length;
    if (state.stage >= total) {
      el('h3', 'build-count', this.body).textContent = `Career done: all ${total} stages`;
    } else {
      const stage = STAGES[state.stage];
      el('h3', 'build-count', this.body).textContent =
        `Stage ${state.stage + 1} of ${total}: ${stage.name}`;
      el('p', 'build-note', this.body).textContent = stage.text;
      const goals = el('ul', 'cities-list career-goals', this.body);
      stage.goals.forEach((goal, i) => {
        const item = el('li', '', goals);
        const met = state.met[i];
        const p = progress(goal, days, state);
        item.classList.toggle('career-met', met !== undefined);
        el('strong', '', item).textContent =
          `${met !== undefined ? '✓' : '○'} ${goalText(goal, this.place)}`;
        el('span', 'cities-meta', item).textContent =
          met !== undefined ? `Met on day ${met}.` : `${progressText(goal, p, state)}.`;
      });
      el('p', 'build-note', this.body).textContent =
        `Grant when its goals are met: ${euros(stage.grant)}.`;
    }
    if (state.done.length) {
      el('h3', 'build-count', this.body).textContent = 'Stages done';
      const list = el('ul', 'cities-list', this.body);
      for (const d of state.done) {
        const stage = STAGES.find((s) => s.id === d.id);
        el('li', 'cities-meta', list).textContent =
          `${stage?.name ?? d.id}, on day ${d.day}: ${euros(stage?.grant ?? 0)} grant.`;
      }
    }
  }
}

/** The notice for stages just done. */
export function stagesDoneNotice(done: readonly Stage[], next: Stage | undefined): string {
  const names = done.map((s) => s.name).join(', ');
  const grant = done.reduce((sum, s) => sum + s.grant, 0);
  return (
    `Stage done: ${names}. A grant of ${euros(grant)} has been paid in.` +
    (next ? ` Next: ${next.name}. Career (G) has its goals.` : ' The career is done.')
  );
}
