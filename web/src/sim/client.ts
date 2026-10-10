import type { FromWorker, InitMessage, ToWorker } from './protocol';
import type { NumericArray, SignalPrograms } from './wasm';

export interface SimFrame {
  /** Simulated time (s since midnight). */
  time: number;
  render: Uint32Array;
  /** performance.now() when the frame arrived. */
  received: number;
}

/** The main thread's handle on the simulation worker. */
export class SimClient {
  private readonly worker: Worker;
  prev?: SimFrame;
  cur?: SimFrame;
  stats?: Float64Array;
  /** Pedestrians at each crossing as of the current frame (wasm.ts `crossings`). */
  crossings?: Uint8Array;
  /** The level crossings' state as of the current frame (wasm.ts `levelCrossings`). */
  levelCrossings?: Float32Array;
  /** Simulated seconds per real second the worker achieves. */
  rate = 0;
  /** Engine time per step lately (ms), and the step (s). */
  stepMs = 0;
  dt = 0.5;
  warming = true;
  ready = false;
  speed: number;
  paused = false;
  /** Mean speed / limit per edge (0-254; 255 = no traffic), refreshed every simulated minute. */
  edgeSpeeds?: Uint8Array;
  /** Signal programs as the engine runs them, once it is built and after each edit. */
  signals?: SignalPrograms;
  /** Edits in force: the latest id the worker has applied, and how many fit. */
  editsApplied?: { id: number; applied: number };
  onFrame?: () => void;
  /** Edits applied: how many fit, the signal programs and the trips that run. */
  onEdited?: (applied: number, signals: SignalPrograms, service: Uint32Array) => void;
  /** The latest network sent runs (`error`: it could not be swapped in). */
  onNetwork?: (signals: SignalPrograms, error?: string) => void;
  /** Id of the latest network the worker has swapped in (0: as loaded). */
  networkApplied = 0;
  onEdgeSpeeds?: (speeds: Uint8Array) => void;
  onReady?: (buildMs: number) => void;
  onError?: (message: string) => void;

  constructor(init: Omit<InitMessage, 'type'>, transfer: Transferable[] = []) {
    this.speed = init.speed;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    this.worker.onerror = (event) => this.onError?.(event.message || 'The simulation stopped');
    this.send({ type: 'init', ...init }, transfer);
  }

  private send(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.signals = message.signals;
        this.dt = message.dt;
        this.onReady?.(message.buildMs);
        break;
      case 'edited':
        this.signals = message.signals;
        this.editsApplied = { id: message.id, applied: message.applied };
        if (message.id === this.editsId)
          this.onEdited?.(message.applied, message.signals, message.service);
        break;
      case 'networked':
        this.signals = message.signals;
        this.networkApplied = message.id;
        if (message.id === this.networkId) this.onNetwork?.(message.signals, message.error);
        break;
      case 'frame':
        this.prev = this.cur;
        this.cur = { time: message.time, render: message.render, received: performance.now() };
        this.stats = message.stats;
        if (message.crossings?.length) this.crossings = message.crossings;
        if (message.levelCrossings) this.levelCrossings = message.levelCrossings;
        this.recordMinute(message.time, message.stats);
        this.rate = message.rate;
        this.stepMs = message.stepMs;
        this.warming = message.warming;
        this.onFrame?.();
        break;
      case 'edgeSpeeds':
        this.edgeSpeeds = message.speeds;
        this.onEdgeSpeeds?.(message.speeds);
        break;
      case 'routeTimes':
      case 'volumes':
      case 'transit':
      case 'linePlan':
      case 'riders':
      case 'reach': {
        const resolve = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        resolve?.(message);
        break;
      }
      case 'error':
        this.onError?.(message.message);
        break;
    }
  }

  private recordMinute(time: number, stats: Float64Array): void {
    const minute = Math.floor(time / 60);
    if (this.minutes.has(minute)) return;
    this.minutes.set(minute, stats);
    for (const old of this.minutes.keys()) {
      if (old < minute - 30) this.minutes.delete(old);
    }
  }

  /** How far (0-1) the display has moved from the previous frame toward the current one. */
  alpha(now: number): number {
    if (!this.prev || !this.cur) return 1;
    const interval = this.cur.received - this.prev.received;
    if (interval <= 0) return 1;
    return Math.min(1, Math.max(0, (now - this.cur.received) / interval));
  }

  /** Simulated time on screen, interpolated like the vehicles. */
  displayTime(now: number): number {
    if (!this.cur) return 0;
    if (!this.prev) return this.cur.time;
    return this.prev.time + (this.cur.time - this.prev.time) * this.alpha(now);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.send({ type: 'speed', speed });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.send({ type: 'pause', paused });
  }

  private held = false;

  /** Hold the simulation where it is, or let it go on (pausing stays as the player set it). */
  setHeld(held: boolean): void {
    if (held === this.held) return;
    this.held = held;
    this.send({ type: 'hold', held });
  }

  /** The weather's effect on driving (sim/src/weather.rs factors). */
  setWeather(effect: { speed: number; headway: number; accel: number }): void {
    this.send({ type: 'weather', ...effect });
  }

  setDemandScale(scale: number): void {
    this.send({ type: 'demand', scale });
  }

  /** Homes and jobs per edge (the city's and those grown since) and the car trips a day
   * they make, in place of those the simulation started with. */
  setDemandWeights(arrays: Record<string, NumericArray>, dailyTrips: number): void {
    this.demandTrips = dailyTrips;
    this.send({ type: 'demandWeights', arrays, dailyTrips });
  }

  /** Car trips a day of the homes last sent with `setDemandWeights` (none: the city's). */
  demandTrips?: number;

  /** Close these edges to routing (live road closures), replacing earlier closures. */
  setClosures(edges: Uint32Array): void {
    this.send({ type: 'closures', edges });
  }

  private requestId = 0;
  private readonly waiting = new Map<number, (message: FromWorker) => void>();

  private ask<T extends FromWorker>(message: ToWorker & { id: number }): Promise<T> {
    return new Promise((resolve) => {
      this.waiting.set(message.id, (reply) => resolve(reply as T));
      this.send(message);
    });
  }

  /** Travel times by car (s, -1: no route) between pairs of edges, on the travel times
   * the simulation measures now; and the simulated time they were measured at. */
  routeTimes(pairs: Uint32Array): Promise<{ time: number; times: Float64Array }> {
    return this.ask<Extract<FromWorker, { type: 'routeTimes' }>>({
      type: 'routeTimes',
      id: ++this.requestId,
      pairs,
    });
  }

  /** Vehicles that have driven onto each edge since the start, when the simulation
   * reaches simulated time `at` (s), and the time it answered at. */
  volumes(at: number): Promise<{ time: number; counts: Uint32Array }> {
    return this.ask<Extract<FromWorker, { type: 'volumes' }>>({
      type: 'volumes',
      id: ++this.requestId,
      at,
    });
  }

  /** Homes and jobs within reach by car of each source edge on the travel times the
   * simulation measures (two numbers per source; see wasm.ts `reach`), and the simulated
   * time they were measured by. A new request replaces one not yet answered, which then
   * never resolves. */
  reach(
    sources: Uint32Array,
    decay: number,
    max: number,
  ): Promise<{ time: number; values: Float32Array }> {
    return this.ask<Extract<FromWorker, { type: 'reach' }>>({
      type: 'reach',
      id: ++this.requestId,
      sources,
      decay,
      max,
    });
  }

  /** The buses, trams and trains running (trip and lateness, two numbers each) and, unless
   * `trip` is -1, the edges that trip drives along (M9a). */
  transit(trip: number): Promise<{ time: number; path: Uint32Array; running: Float32Array }> {
    return this.ask<Extract<FromWorker, { type: 'transit' }>>({
      type: 'transit',
      id: ++this.requestId,
      trip,
    });
  }

  /** Public transport's riders (M9d; `readRiders`). */
  riders(): Promise<Float32Array> {
    return this.ask<Extract<FromWorker, { type: 'riders' }>>({
      type: 'riders',
      id: ++this.requestId,
    }).then((m) => m.riders);
  }

  /** A new line's way through its stops (M9c; see `TrafficEngine.planLine`). */
  planLine(words: Uint32Array): Promise<Uint32Array> {
    return this.ask<Extract<FromWorker, { type: 'linePlan' }>>({
      type: 'planLine',
      id: ++this.requestId,
      words,
    }).then((m) => m.plan);
  }

  /** Statistics as of each simulated minute (the first frame at or past it), recent ones. */
  readonly minutes = new Map<number, Float64Array>();

  private editsId = 0;

  /** Replace the network edits in force (four words per edit, see edit/edits.ts). */
  setEdits(words: Uint32Array): void {
    this.editsId += 1;
    this.send({ type: 'edits', id: this.editsId, words });
  }

  private networkId = 0;

  /** Swap in a network with roads drawn, keeping the vehicles (see edit/builder.ts): its
   * arrays (copied to the worker) and where the lanes running now went. */
  setNetwork(arrays: Record<string, NumericArray>, pieces: Uint32Array): void {
    this.networkId += 1;
    this.send({ type: 'network', id: this.networkId, arrays, pieces });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
