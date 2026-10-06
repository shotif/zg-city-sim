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
let warmUntil = 0;
let owed = 0;
let last = 0;
let msPerStep = 2;
let rate = 0;
let lastEdgeSpeeds = -Infinity;
/** Closed edges, kept until the engine is built. */
let closed: Uint32Array | undefined;

const post = (message: FromWorker, transfer: Transferable[] = []) =>
  self.postMessage(message, transfer);

async function init(message: InitMessage): Promise<void> {
  const t0 = performance.now();
  const response = await fetch(message.wasmUrl);
  if (!response.ok) throw new Error(`Could not load the traffic engine (HTTP ${response.status})`);
  engine = await TrafficEngine.create(await response.arrayBuffer());
  for (const [name, data] of Object.entries(message.arrays)) engine.setArray(name, data);
  engine.build(message.seed, message.dailyTrips);
  engine.setTime(message.startTime);
  if (closed) engine.setClosed(closed);
  speed = message.speed;
  warmUntil = message.warmUntil;
  post({ type: 'ready', buildMs: performance.now() - t0 });
  last = performance.now();
  tick();
}

function tick(): void {
  const sim = engine;
  if (!sim) return;
  const start = performance.now();
  const elapsed = Math.min(1, (start - last) / 1000);
  last = start;
  const warming = sim.stats()[0] < warmUntil;
  let steps = 0;
  if (warming) {
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
  if (steps > 0) {
    const t0 = performance.now();
    const time = sim.step(steps);
    const ms = performance.now() - t0;
    msPerStep = 0.7 * msPerStep + 0.3 * (ms / steps);
    if (!warming) owed -= steps * sim.dt;
    const render = sim.render();
    rate = 0.8 * rate + 0.2 * ((steps * sim.dt) / Math.max(elapsed, 0.001));
    post({ type: 'frame', time, render, stats: sim.stats(), rate, warming }, [render.buffer]);
    if (time - lastEdgeSpeeds >= EDGE_SPEED_INTERVAL) {
      lastEdgeSpeeds = time;
      const speeds = sim.edgeSpeeds();
      post({ type: 'edgeSpeeds', time, speeds }, [speeds.buffer]);
    }
  }
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
    case 'demand':
      engine?.setDemandScale(message.scale);
      break;
    case 'closures':
      closed = message.edges;
      engine?.setClosed(closed);
      break;
  }
};
