/** Messages between the main thread (SimClient) and the simulation worker. */
import type { NumericArray, SignalPrograms } from './wasm';

export interface InitMessage {
  type: 'init';
  /** Absolute URL of the engine's WebAssembly module. */
  wasmUrl: string;
  /** Network arrays by their packed names, plus decoded `laneShape` and `laneShapeY`. */
  arrays: Record<string, NumericArray>;
  seed: number;
  /** Car trips per day at demand scale 1. */
  dailyTrips: number;
  /** Share of the demand to run. */
  demandScale: number;
  /** Simulated time to start at (s since midnight). */
  startTime: number;
  /** Run as fast as possible until this time, so the city fills with traffic. */
  warmUntil: number;
  speed: number;
  /** Post vehicle positions with each frame (false for a simulation only compared). */
  render?: boolean;
}

export type ToWorker =
  | InitMessage
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean }
  /** Wait (even while filling the streets): keeps two compared simulations in step. */
  | { type: 'hold'; held: boolean }
  | { type: 'demand'; scale: number }
  /** The weather's effect on driving (sim/src/weather.rs). */
  | { type: 'weather'; speed: number; headway: number; accel: number }
  /** Homes and jobs per edge again (`demandEdge`, `demandHome`, `demandWork`: the city's and
   * those of buildings grown since), and the car trips a day they make. */
  | { type: 'demandWeights'; arrays: Record<string, NumericArray>; dailyTrips: number }
  /** Close these edges to routing (live road closures), replacing earlier ones. */
  | { type: 'closures'; edges: Uint32Array }
  /** Replace the network edits in force: four words per edit (edit/edits.ts). */
  | { type: 'edits'; id: number; words: Uint32Array }
  /** Swap in a network with roads drawn (edit/builder.ts), keeping the vehicles: its
   * arrays, and where the lanes running now went (four words per lane piece). */
  | { type: 'network'; id: number; arrays: Record<string, NumericArray>; pieces: Uint32Array }
  /** Travel times by car between pairs of edges (from, to, from, to, ...). */
  | { type: 'routeTimes'; id: number; pairs: Uint32Array }
  /** Vehicles that have driven onto each edge since the start, once the simulation has
   * reached simulated time `at` (s). */
  | { type: 'volumes'; id: number; at: number }
  /** Homes and jobs within reach by car of each source edge on the measured travel times,
   * weighted by exp(-time / decay) up to `max` seconds (engine `reach`). */
  | { type: 'reach'; id: number; sources: Uint32Array; decay: number; max: number };

export interface FrameMessage {
  type: 'frame';
  /** Simulated time of `render` (s since midnight, growing past 86 400 on later days). */
  time: number;
  /** Vehicle slots, RENDER.stride words each (see wasm.ts). */
  render: Uint32Array;
  stats: Float64Array;
  /** Simulated seconds per real second over the last few seconds. */
  rate: number;
  warming: boolean;
}

export type FromWorker =
  | { type: 'ready'; buildMs: number; signals: SignalPrograms }
  /** Edits `id` are in force: how many fit the network, and the signal programs now. */
  | { type: 'edited'; id: number; applied: number; signals: SignalPrograms }
  /** Network `id` runs (or could not be swapped in: `error`), and its signal programs. */
  | { type: 'networked'; id: number; signals: SignalPrograms; error?: string }
  | FrameMessage
  | { type: 'edgeSpeeds'; time: number; speeds: Uint8Array }
  /** Seconds per pair asked for (-1: no route), at simulated time `time`. */
  | { type: 'routeTimes'; id: number; time: number; times: Float64Array }
  | { type: 'volumes'; id: number; time: number; counts: Uint32Array }
  /** Homes and jobs within reach of each source asked for (two numbers each), measured
   * over a few batches ending at simulated time `time`. */
  | { type: 'reach'; id: number; time: number; values: Float32Array }
  | { type: 'error'; message: string };
