/** Messages between the main thread (SimClient) and the simulation worker. */
import type { NumericArray } from './wasm';

export interface InitMessage {
  type: 'init';
  /** Absolute URL of the engine's WebAssembly module. */
  wasmUrl: string;
  /** Network arrays by their packed names, plus decoded `laneShape` and `laneShapeY`. */
  arrays: Record<string, NumericArray>;
  seed: number;
  /** Car trips per day at demand scale 1. */
  dailyTrips: number;
  /** Simulated time to start at (s since midnight). */
  startTime: number;
  /** Run as fast as possible until this time, so the city fills with traffic. */
  warmUntil: number;
  speed: number;
}

export type ToWorker =
  | InitMessage
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'demand'; scale: number }
  /** Close these edges to routing (live road closures), replacing earlier ones. */
  | { type: 'closures'; edges: Uint32Array };

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
  | { type: 'ready'; buildMs: number }
  | FrameMessage
  | { type: 'edgeSpeeds'; time: number; speeds: Uint8Array }
  | { type: 'error'; message: string };
