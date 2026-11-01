/**
 * Career stages and goals (M19c): stages in order, each with goals judged at midnight on
 * the days played (`DayRecord`s). Meeting all of a stage's goals pays its grant and opens
 * the next. A career cannot be lost: debt only stops building.
 *
 * Traffic varies from run to run (about a sixth in the hours lost between two runs of the
 * same day), so goals on traffic take the mean of the last two whole days.
 */
import { cityKey } from './cities';
import data from './career.json';
import type { DayRecord } from './days';

/** Hours of the peaks a jam goal is judged in: 07:00-09:00 and 15:00-18:00. */
export const PEAKS = { am: [7, 9], pm: [15, 18] } as const;
export type Peak = keyof typeof PEAKS;

export type Goal =
  /** Residents (or jobs) in buildings grown on zoned land, in the City or one district. */
  | { kind: 'residents' | 'jobs'; target: number; district?: string }
  /** The balance above zero at midnight, `days` days running. */
  | { kind: 'balance'; days: number }
  /** Traffic on a news hotspot's roads at `target` of the speed limit or more in a peak
   * (`today`: as in day runs of today's roads). */
  | { kind: 'jam'; hotspot: string; peak: Peak; target: number; today: number }
  /** Public transport's share of trips `points` above the career's first days. */
  | { kind: 'transit'; points: number }
  /** Hours lost in traffic at most `most` times the career's first days. */
  | { kind: 'traffic'; most: number };

export interface Stage {
  id: string;
  name: string;
  text: string;
  /** Paid into the budget when the stage's goals are met (€). */
  grant: number;
  goals: Goal[];
}

export const STAGES: readonly Stage[] = data.stages as Stage[];

/** What a career has reached, kept with the city. */
export interface CareerState {
  version: 1;
  /** The stage being played (`STAGES.length` once all are done). */
  stage: number;
  /** Goals of the stage being played met so far: goal index, and the day met. */
  met: Record<number, number>;
  /** The career's first two whole days, to compare transit and traffic with. */
  reference?: { delayHours: number; ptShare?: number };
  /** Stages done, and the day each was. */
  done: { id: string; day: number }[];
}

export function newCareer(): CareerState {
  return { version: 1, stage: 0, met: {}, done: [] };
}

export function loadCareer(storage: Storage | undefined = globalThis.localStorage): CareerState {
  try {
    const v = JSON.parse(storage?.getItem(cityKey('career')) ?? 'null') as CareerState | null;
    if (
      v?.version === 1 &&
      Number.isInteger(v.stage) &&
      typeof v.met === 'object' &&
      v.met !== null &&
      Array.isArray(v.done)
    ) {
      return v;
    }
  } catch {
    // Nothing kept, or not readable.
  }
  return newCareer();
}

export function saveCareer(
  state: CareerState,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(cityKey('career'), JSON.stringify(state));
  } catch {
    // Storage full or blocked: the career lasts the visit.
  }
}

/** The last two whole days kept, oldest first (fewer if not played yet). */
function lastWhole(days: readonly DayRecord[]): DayRecord[] {
  return days.filter((d) => d.from === 0).slice(-2);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A goal's measure now, and whether it is met (`value` undefined: not measured yet). */
export interface Progress {
  value?: number;
  met: boolean;
}

/** Where goal `goal` stands on the days played. */
export function progress(goal: Goal, days: readonly DayRecord[], state: CareerState): Progress {
  const last = days.at(-1);
  const two = lastWhole(days);
  switch (goal.kind) {
    case 'residents':
    case 'jobs': {
      if (!last) return { met: false };
      const value = goal.district
        ? (last.districts?.[goal.district]?.[goal.kind === 'residents' ? 0 : 1] ?? 0)
        : ((goal.kind === 'residents' ? last.residents : last.jobs) ?? 0);
      return { value, met: value >= goal.target };
    }
    case 'balance': {
      // The last `days` days, one after another, each above zero at midnight.
      const run = days.slice(-goal.days);
      let count = 0;
      for (let i = run.length - 1; i >= 0; i--) {
        const d = run[i];
        if (d.balance === undefined || d.balance <= 0) break;
        if (i < run.length - 1 && run[i + 1].day !== d.day + 1) break;
        count++;
      }
      return { value: count, met: count >= goal.days };
    }
    case 'jam': {
      const shares = two
        .map((d) => d.peaks?.[goal.hotspot]?.[goal.peak === 'am' ? 0 : 1])
        .filter((s): s is number => typeof s === 'number');
      if (shares.length < 2) return { value: shares[0], met: false };
      const value = mean(shares);
      return { value, met: value >= goal.target };
    }
    case 'transit': {
      const base = state.reference?.ptShare;
      const shares = two.map((d) => d.ptShare).filter((s): s is number => typeof s === 'number');
      if (base === undefined || shares.length < 2) return { value: shares.at(-1), met: false };
      const value = mean(shares);
      return { value, met: value >= base + goal.points / 100 };
    }
    case 'traffic': {
      const base = state.reference?.delayHours;
      if (base === undefined || two.length < 2)
        return { value: two.at(-1)?.delayHours, met: false };
      const value = mean(two.map((d) => d.delayHours));
      return { value, met: value <= base * goal.most };
    }
  }
}

/**
 * Judge the stage being played on the days played (at midnight, or when a city is
 * opened): set the reference once two whole days are kept, mark goals met, and when all
 * of the stage's are, close it. Returns the stages done now, whose grants are to be paid.
 */
export function judge(state: CareerState, days: readonly DayRecord[]): Stage[] {
  const whole = days.filter((d) => d.from === 0);
  if (!state.reference && whole.length >= 2) {
    const first = whole.slice(0, 2);
    const pt = first.map((d) => d.ptShare).filter((s): s is number => typeof s === 'number');
    state.reference = {
      delayHours: mean(first.map((d) => d.delayHours)),
      ptShare: pt.length === 2 ? mean(pt) : undefined,
    };
  }
  const today = days.at(-1)?.day ?? 0;
  const done: Stage[] = [];
  while (state.stage < STAGES.length) {
    const stage = STAGES[state.stage];
    stage.goals.forEach((goal, i) => {
      // Traffic must hold when the stage closes; the rest stay met once met.
      if (goal.kind === 'traffic') {
        if (progress(goal, days, state).met) state.met[i] = state.met[i] ?? today;
        else delete state.met[i];
      } else if (state.met[i] === undefined && progress(goal, days, state).met) {
        state.met[i] = today;
      }
    });
    if (!stage.goals.every((_, i) => state.met[i] !== undefined)) break;
    done.push(stage);
    state.done.push({ id: stage.id, day: today });
    state.stage += 1;
    state.met = {};
  }
  return done;
}

const n = (x: number) => Math.round(x).toLocaleString('en-GB');
const pct = (x: number) => `${Math.round(100 * x)} %`;
/** A district's name as shown ("Novi Zagreb – zapad"). */
export const districtName = (name: string) => name.replace(' - ', ' – ');

/** What a goal asks, in plain words; `place`: a hotspot's name. */
export function goalText(goal: Goal, place: (id: string) => string = (id) => id): string {
  switch (goal.kind) {
    case 'residents':
    case 'jobs':
      return (
        `${n(goal.target)} ${goal.kind} in buildings grown on zoned land` +
        (goal.district ? ` in ${districtName(goal.district)}` : '')
      );
    case 'balance':
      return `The balance above zero at midnight, ${goal.days} days running`;
    case 'jam': {
      const [a, b] = PEAKS[goal.peak];
      return (
        `Traffic at ${place(goal.hotspot)} at ${pct(goal.target)} of the speed limit or more ` +
        `from ${String(a).padStart(2, '0')}:00 to ${String(b).padStart(2, '0')}:00, over two ` +
        `whole days (today about ` +
        `${pct(goal.today)})`
      );
    }
    case 'transit':
      return (
        `Public transport's share of trips ${goal.points} points above the career's first ` +
        'two whole days, over two whole days'
      );
    case 'traffic':
      return (
        `Hours lost in traffic no more than ${Math.round(100 * (goal.most - 1))} % above the ` +
        "career's first two whole days, over two whole days"
      );
  }
}

/** Where a goal stands, in a few words ("1,200 of 2,000", "14 % now"). */
export function progressText(goal: Goal, p: Progress, state: CareerState): string {
  if (p.value === undefined) return 'not measured yet';
  switch (goal.kind) {
    case 'residents':
    case 'jobs':
      return `${n(p.value)} of ${n(goal.target)}`;
    case 'balance':
      return `${p.value} of ${goal.days} days`;
    case 'jam':
      return `${pct(p.value)} now`;
    case 'transit': {
      const base = state.reference?.ptShare;
      return base === undefined
        ? `${(100 * p.value).toFixed(1)} % now; the first two whole days are not played yet`
        : `${(100 * p.value).toFixed(1)} % now, against ${(100 * base).toFixed(1)} % at first`;
    }
    case 'traffic': {
      const base = state.reference?.delayHours;
      return base === undefined
        ? 'the first two whole days are not played yet'
        : `${n(p.value)} hours a day now, against ${n(base)} at first`;
    }
  }
}
