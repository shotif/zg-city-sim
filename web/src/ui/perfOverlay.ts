/**
 * How fast the app runs (M6f), shown with `?perf`: frames drawn a second, the main
 * thread's time per frame, what the GPU is asked to draw, and how fast the simulation
 * steps. The same numbers are on `__ZG__.perf` for scripted measurements.
 */

export interface FrameSample {
  /** performance.now() at the start of the frame (ms). */
  at: number;
  /** Main-thread time spent in the frame (ms). */
  ms: number;
  /** Whether the scene was drawn (it is not when nothing moved). */
  drawn: boolean;
  drawCalls: number;
  triangles: number;
}

export interface FrameSummary {
  /** Frames drawn per second, and animation-loop calls per second. */
  fps: number;
  loops: number;
  /** Main-thread time of the frames drawn: mean, 95th percentile and worst (ms). */
  meanMs: number;
  p95Ms: number;
  worstMs: number;
  /** Of the last frame drawn. */
  drawCalls: number;
  triangles: number;
}

/** Frames over the last `window` ms. */
export class FrameStats {
  private readonly samples: FrameSample[] = [];

  constructor(private readonly window = 2000) {}

  add(sample: FrameSample): void {
    this.samples.push(sample);
    const from = sample.at - this.window;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].at < from) drop++;
    if (drop > 0) this.samples.splice(0, drop);
  }

  summary(): FrameSummary {
    const all = this.samples;
    const drawn = all.filter((s) => s.drawn);
    const span = all.length > 1 ? Math.max(1, all[all.length - 1].at - all[0].at) / 1000 : Infinity;
    const times = drawn.map((s) => s.ms).sort((a, b) => a - b);
    const last = drawn[drawn.length - 1];
    return {
      fps: all.length > 1 ? (drawn.length - (all[0].drawn ? 1 : 0)) / span : 0,
      loops: all.length > 1 ? (all.length - 1) / span : 0,
      meanMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
      p95Ms: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0,
      worstMs: times.length ? times[times.length - 1] : 0,
      drawCalls: last?.drawCalls ?? 0,
      triangles: last?.triangles ?? 0,
    };
  }
}

export interface SimPerf {
  /** Engine time per step (ms), simulated seconds per step, and per real second. */
  stepMs: number;
  dt: number;
  rate: number;
  /** The speed asked for (×), and vehicles running. */
  speed: number;
  vehicles: number;
}

export interface Perf extends FrameSummary {
  sim?: SimPerf;
}

const format = (n: number, digits = 1) =>
  n.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits });

/** The numbers as a few lines of text. */
export function perfText(p: Perf): string {
  const lines = [
    `${format(p.fps, 0)} fps drawn (${format(p.loops, 0)} loops/s)`,
    `frame ${format(p.meanMs)} ms, 95 % ${format(p.p95Ms)} ms, worst ${format(p.worstMs)} ms`,
    `${p.drawCalls.toLocaleString('en-GB')} draw calls, ${format(p.triangles / 1e6, 2)} M triangles`,
  ];
  if (p.sim) {
    const s = p.sim;
    // Real time at a speed needs speed / dt steps a second, each stepMs long.
    const load = (s.stepMs * s.speed) / s.dt / 10;
    lines.push(
      `sim ${format(s.stepMs, 2)} ms/step (${format(s.dt)} s), ${format(s.rate, 0)}× of ${format(s.speed, 0)}×, ` +
        `${format(load, 0)} % of a core`,
      `${s.vehicles.toLocaleString('en-GB')} vehicles`,
    );
  }
  return lines.join('\n');
}

export class PerfOverlay {
  readonly element: HTMLElement;
  private lastShown = 0;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('pre');
    this.element.className = 'perf-overlay';
    this.element.setAttribute('aria-label', 'Performance');
    parent.append(this.element);
  }

  /** Show the numbers (at most twice a second). */
  show(perf: Perf, now = performance.now()): void {
    if (now - this.lastShown < 500) return;
    this.lastShown = now;
    this.element.textContent = perfText(perf);
  }
}
