/**
 * The budget wired to the city (M5e): building paid for as edits come into force, what
 * grows taxed and charged as simulated time passes, and the Budget panel kept up to date.
 */
import { BudgetPanel } from '../ui/budgetPanel';
import { Budget, buildingIncome, contribution, loadBudget, saveBudget } from './economy';
import { type Grown, type Growth, finished } from './growth';

export interface BudgetDeps {
  hud: HTMLElement;
  onClose(): void;
  /** What has grown, and land value per lot (none yet: undefined). */
  growth(): { growth: Growth; value?: Float32Array } | undefined;
}

/** Simulated seconds between savings of the balance. */
const SAVE_EVERY = 600;
/** Real milliseconds between updates of the panel. */
const SHOW_EVERY = 500;

export class BudgetTool {
  readonly budget = new Budget(loadBudget());
  readonly panel: BudgetPanel;
  /** Buildings counted finished (paid their contribution, or restored finished). */
  private readonly counted = new WeakSet<Grown>();
  private edits = 0;
  private minute = -Infinity;
  private savedAt = -Infinity;
  private shownAt = 0;

  constructor(private readonly deps: BudgetDeps) {
    this.panel = new BudgetPanel(deps.hud, deps.onClose);
    this.show();
  }

  /** Why the edits in force cannot become `build` euros' worth (undefined: they can). */
  afford(build: number): string | undefined {
    return this.budget.afford(build - this.budget.spent);
  }

  /** The edits in force (`count` of them) cost `build` to build, and `upkeep` and
   * `service` (public transport run more or less) a year. */
  setEdits(cost: { build: number; upkeep: number; service?: number }, count: number): void {
    this.budget.setSpent(cost.build);
    this.budget.yearly.upkeep = cost.upkeep;
    this.budget.yearly.service = cost.service ?? 0;
    this.edits = count;
    saveBudget(this.budget);
    this.show();
  }

  /** Fares a year from the riders public transport edits gain or lose (M9d). */
  setFares(fares: number): void {
    if (Math.abs(fares - this.budget.yearly.fares) < 1) return;
    this.budget.yearly.fares = fares;
    this.show();
  }

  /** Simulated time now (s). */
  tick(now: number): void {
    const minute = Math.floor(now / 60);
    if (minute !== this.minute) {
      this.minute = minute;
      this.collect(now);
    }
    this.budget.tick(now);
    if (now < this.savedAt || now - this.savedAt >= SAVE_EVERY) {
      this.savedAt = now;
      saveBudget(this.budget);
    }
    if (performance.now() - this.shownAt > SHOW_EVERY) this.show();
  }

  setVisible(on: boolean): void {
    this.panel.setVisible(on);
    this.show();
  }

  show(): void {
    this.shownAt = performance.now();
    this.panel.show(this.budget, this.edits);
  }

  /** The taxes and fees of what has grown, and the contributions of buildings just
   * finished. */
  private collect(now: number): void {
    const grown = this.deps.growth();
    let [tax, fee] = [0, 0];
    for (const b of grown?.growth.buildings ?? []) {
      if (!b || !finished(b, now)) continue;
      const value = grown?.value?.[b.lots[0]];
      if (!this.counted.has(b)) {
        this.counted.add(b);
        // Restored buildings (finished at 0) paid when they were built.
        if (b.done > 0 && now >= b.done) this.budget.contribute(contribution(b, value));
      }
      const income = buildingIncome(b, value);
      tax += income.tax;
      fee += income.fee;
    }
    this.budget.yearly.tax = tax;
    this.budget.yearly.fee = fee;
  }
}
