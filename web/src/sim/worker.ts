/// <reference lib="webworker" />
/**
 * Runs the traffic engine off the main thread. Keeps simulated time in step with real time
 * times the chosen speed (slower if the engine cannot keep up) and posts a render frame
 * after each batch of steps.
 */
import type { FromWorker, InitMessage, ToWorker } from './protocol';
import { TrafficEngine } from './wasm';

declare const self: DedicatedWorkerGlobalScope;

/** Target interval between batches (ms). */
const TICK_MS = 33;
/** Most work per batch, so speed changes and frames stay responsive (ms). */
const BUDGET_MS = 40;
/** Simulated seconds between edge-speed updates for the congestion view. */
const EDGE_SPEED_INTERVAL = 60;

let engine: TrafficEngine | undefined;
let speed = 1;
let paused = false;
let held = false;
let warmUntil = 0;
let owed = 0;
let last = 0;
let msPerStep = 2;
let rate = 0;
/** Simulated and real seconds since the rate was last measured. */
let rateSim = 0;
let rateReal = 0;
let lastEdgeSpeeds = -Infinity;
/** Closed edges and edits, kept until the engine is built. */
let closed: Uint32Array | undefined;
let edits: { id: number; words: Uint32Array } | undefined;
/** Homes and jobs grown since the start, kept until the engine is built. */
let weights: Extract<ToWorker, { type: 'demandWeights' }> | undefined;
/** The weather's effect on driving, kept until the engine is built. */
let weather: Extract<ToWorker, { type: 'weather' }> | undefined;
/** A network with roads drawn that came before the engine was built. */
let network: Extract<ToWorker, { type: 'network' }> | undefined;
let render = true;
/** Travel-time queries being answered a few per batch, so frames keep coming. */
let routeJob: { id: number; pairs: Uint32Array; times: Float64Array; next: number } | undefined;
const ROUTES_PER_BATCH = 24;
/** Accessibility being measured a few milliseconds' worth of sources per batch. */
let reachJob:
  | {
      id: number;
      sources: Uint32Array;
      decay: number;
      max: number;
      values: Float32Array;
      next: number;
    }
  | undefined;
const REACH_MS = 8;
/** Time a tick may give the riders' journeys (M9d, M10d), at least one piece of work. */
const RIDERS_MS = 25;
/** Volume requests waiting for their simulated time. */
let volumeAsks: { id: number; at: number }[] = [];

const post = (message: FromWorker, transfer: Transferable[] = []) =>
  self.postMessage(message, transfer);

// A panic in the engine traps as "unreachable": say what it panicked at.
self.addEventListener('error', (event) => {
  const why = engine?.panicMessage();
  if (!why) return;
  event.preventDefault();
  post({ type: 'error', message: `${event.message} (${why})` });
});

async function init(message: InitMessage): Promise<void> {
  const t0 = performance.now();
  const response = await fetch(message.wasmUrl);
  if (!response.ok) throw new Error(`Could not load the traffic engine (HTTP ${response.status})`);
  engine = await TrafficEngine.create(await response.arrayBuffer());
  for (const [name, data] of Object.entries(message.arrays)) engine.setArray(name, data);
  engine.build(message.seed, message.dailyTrips);
  engine.setDemandScale(message.demandScale);
  engine.setTime(message.startTime);
  if (closed) engine.setClosed(closed);
  speed = message.speed;
  warmUntil = message.warmUntil;
  render = message.render ?? true;
  post({
    type: 'ready',
    buildMs: performance.now() - t0,
    signals: engine.signalPrograms(),
    dt: engine.dt,
  });
  if (network) swapNetwork(engine, network);
  if (edits) applyEdits(engine, edits);
  if (weights) applyWeights(engine, weights);
  if (weather) engine.setWeather(weather.speed, weather.headway, weather.accel);
  last = performance.now();
  tick();
}

function applyWeights(
  sim: TrafficEngine,
  message: Extract<ToWorker, { type: 'demandWeights' }>,
): void {
  for (const [name, data] of Object.entries(message.arrays)) sim.setArray(name, data);
  sim.setDemand(message.dailyTrips);
}

function applyEdits(sim: TrafficEngine, message: { id: number; words: Uint32Array }): void {
  const applied = sim.setEdits(message.words);
  const service = sim.transitService();
  post({ type: 'edited', id: message.id, applied, signals: sim.signalPrograms(), service }, [
    service.buffer,
  ]);
}

function swapNetwork(sim: TrafficEngine, message: Extract<ToWorker, { type: 'network' }>): void {
  let error: string | undefined;
  try {
    for (const [name, data] of Object.entries(message.arrays)) sim.setArray(name, data);
    sim.replaceNetwork(message.pieces);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    const why = sim.panicMessage();
    if (why) error += ` (${why})`;
  }
  network = undefined;
  // Edge statistics change size with the network: start them again.
  lastEdgeSpeeds = -Infinity;
  post({ type: 'networked', id: message.id, signals: sim.signalPrograms(), error });
}

function tick(): void {
  const sim = engine;
  if (!sim) return;
  const start = performance.now();
  const elapsed = Math.min(1, (start - last) / 1000);
  last = start;
  const warming = sim.stats()[0] < warmUntil;
  let steps = 0;
  if (held) {
    owed = 0;
  } else if (warming) {
    steps = Math.max(1, Math.floor(BUDGET_MS / msPerStep));
  } else if (!paused) {
    owed += elapsed * speed;
    steps = Math.floor(owed / sim.dt);
    const affordable = Math.max(1, Math.floor(BUDGET_MS / msPerStep));
    if (steps > affordable) {
      // Falling behind: run what fits and let the rest go rather than spiral.
      steps = affordable;
      owed = Math.min(owed, steps * sim.dt * 2);
    }
  }
  // The rate over the last second or so (steps come every few ticks at low speeds).
  rateSim += steps * sim.dt;
  rateReal += elapsed;
  if (rateReal >= 1) {
    rate = rateSim / rateReal;
    rateSim = rateReal = 0;
  }
  if (steps > 0) {
    const t0 = performance.now();
    const time = sim.step(steps);
    const ms = performance.now() - t0;
    msPerStep = 0.7 * msPerStep + 0.3 * (ms / steps);
    if (!warming) owed -= steps * sim.dt;
    const frame = render ? sim.render() : new Uint32Array(0);
    const crossings = render ? sim.crossings() : new Uint8Array(0);
    const levelCrossings = sim.levelCrossings();
    post(
      {
        type: 'frame',
        time,
        render: frame,
        crossings,
        levelCrossings,
        stats: sim.stats(),
        rate,
        stepMs: msPerStep,
        warming,
      },
      [frame.buffer, crossings.buffer, levelCrossings.buffer],
    );
    if (time - lastEdgeSpeeds >= EDGE_SPEED_INTERVAL) {
      lastEdgeSpeeds = time;
      const speeds = sim.edgeSpeeds();
      post({ type: 'edgeSpeeds', time, speeds }, [speeds.buffer]);
    }
  }
  if (volumeAsks.length > 0) {
    const now = sim.stats()[0];
    const due = volumeAsks.filter((a) => now >= a.at);
    volumeAsks = volumeAsks.filter((a) => now < a.at);
    for (const ask of due) {
      const counts = sim.edgeEntered();
      post({ type: 'volumes', id: ask.id, time: now, counts }, [counts.buffer]);
    }
  }
  const job = routeJob;
  if (job) {
    const end = Math.min(job.pairs.length / 2, job.next + ROUTES_PER_BATCH);
    for (let k = job.next; k < end; k++) {
      job.times[k] = sim.routeTime(job.pairs[k * 2], job.pairs[k * 2 + 1]);
    }
    job.next = end;
    if (end * 2 >= job.pairs.length) {
      routeJob = undefined;
      post({ type: 'routeTimes', id: job.id, time: sim.stats()[0], times: job.times }, [
        job.times.buffer,
      ]);
    }
  }
  const reach = reachJob;
  if (reach) {
    const t0 = performance.now();
    while (reach.next < reach.sources.length && performance.now() - t0 < REACH_MS) {
      const k = reach.next++;
      reach.values.set(sim.reach(reach.sources.subarray(k, k + 1), reach.decay, reach.max), 2 * k);
    }
    if (reach.next >= reach.sources.length) {
      reachJob = undefined;
      post({ type: 'reach', id: reach.id, time: sim.stats()[0], values: reach.values }, [
        reach.values.buffer,
      ]);
    }
  }
  // Public transport's riders and the car journeys they need, a little each tick; not in a
  // simulation only compared with (the player's works them out for both).
  const t1 = performance.now();
  while (render && sim.workRiders() && performance.now() - t1 < RIDERS_MS);
  setTimeout(tick, Math.max(0, TICK_MS - (performance.now() - start)));
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      init(message).catch((error: unknown) =>
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
      );
      break;
    case 'speed':
      speed = message.speed;
      break;
    case 'pause':
      paused = message.paused;
      owed = 0;
      break;
    case 'hold':
      held = message.held;
      break;
    case 'demand':
      engine?.setDemandScale(message.scale);
      break;
    case 'weather':
      weather = message;
      engine?.setWeather(message.speed, message.headway, message.accel);
      break;
    case 'demandWeights':
      weights = message;
      if (engine) applyWeights(engine, message);
      break;
    case 'closures':
      closed = message.edges;
      engine?.setClosed(closed);
      break;
    case 'edits':
      edits = message;
      if (engine) applyEdits(engine, message);
      break;
    case 'network':
      if (engine) swapNetwork(engine, message);
      else network = message;
      break;
    case 'routeTimes':
      routeJob = {
        id: message.id,
        pairs: message.pairs,
        times: new Float64Array(message.pairs.length / 2),
        next: 0,
      };
      break;
    case 'volumes':
      volumeAsks.push({ id: message.id, at: message.at });
      break;
    case 'transit': {
      if (!engine) break;
      const path = message.trip >= 0 ? engine.transitPath(message.trip) : new Uint32Array(0);
      const running = engine.transitState();
      post({ type: 'transit', id: message.id, time: engine.stats()[0], path, running }, [
        path.buffer,
        running.buffer,
      ]);
      break;
    }
    case 'journeys': {
      const times = engine ? engine.ptJourneys(message.points) : new Float32Array(0);
      post({ type: 'journeys', id: message.id, times }, [times.buffer]);
      break;
    }
    case 'riders': {
      const riders = engine ? engine.riders() : new Float32Array(0);
      post({ type: 'riders', id: message.id, riders }, [riders.buffer]);
      break;
    }
    case 'planLine': {
      const plan = engine ? engine.planLine(message.words) : new Uint32Array(0);
      post({ type: 'linePlan', id: message.id, plan }, [plan.buffer]);
      break;
    }
    case 'reach':
      reachJob = {
        ...message,
        values: new Float32Array(2 * message.sources.length),
        next: 0,
      };
      break;
  }
};
