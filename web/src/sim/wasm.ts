/**
 * Wrapper over the traffic engine's WebAssembly exports (sim/src/ffi.rs).
 *
 * Dependency-free on purpose: the browser worker and the Node benchmark
 * (sim/bench/bench.ts) both use it.
 */

export interface EngineExports {
  memory: WebAssembly.Memory;
  zg_alloc(bytes: number): number;
  zg_free(ptr: number, bytes: number): void;
  zg_array(name: number, nameLength: number, count: number, elemSize: number): number;
  zg_build(seed: number, dailyTrips: number): number;
  zg_set_time(seconds: number): void;
  zg_set_demand_scale(scale: number): void;
  zg_add_trip(depart: number, from: number, to: number, vtype: number): void;
  zg_step(steps: number): number;
  zg_dt(): number;
  zg_render_ptr(): number;
  zg_render_slots(): number;
  zg_render_stride(): number;
  zg_stats_ptr(): number;
  zg_stats_len(): number;
  zg_edge_speed_ptr(): number;
  zg_edge_count(): number;
}

/** Slots of the statistics array (engine::stat). */
export const STAT = {
  time: 0,
  running: 1,
  departed: 2,
  arrived: 3,
  teleported: 4,
  noRoute: 5,
  insertFailed: 6,
  backlog: 7,
  meanSpeed: 8,
  stopped: 9,
  meanTripTime: 10,
  meanTripKm: 11,
  pending: 12,
  slots: 13,
  trams: 14,
  buses: 15,
} as const;

/** Words per vehicle slot in the render buffer and what they hold (engine::write_render). */
export const RENDER = {
  stride: 8,
  /** f32 */
  x: 0,
  y: 1,
  z: 2,
  heading: 3,
  speed: 4,
  /** u32: changes when the slot gets a new vehicle; 0 = empty slot */
  serial: 5,
  /** u32: bits 0-7 vehicle type, 8+ flags (INFO), 16-31 colour seed */
  info: 6,
  accel: 7,
} as const;

export const INFO = {
  absoluteY: 1 << 8,
  brake: 1 << 9,
  blinkLeft: 1 << 10,
  blinkRight: 1 << 11,
} as const;

export const VEHICLE_TYPES = ['car', 'truck', 'bus', 'tram'] as const;

export type NumericArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

export class TrafficEngine {
  readonly exports: EngineExports;
  readonly dt: number;

  constructor(exports: EngineExports) {
    this.exports = exports;
    this.dt = exports.zg_dt();
  }

  static async create(wasm: BufferSource): Promise<TrafficEngine> {
    const { instance } = await WebAssembly.instantiate(wasm, {});
    return new TrafficEngine(instance.exports as unknown as EngineExports);
  }

  private get memory(): ArrayBuffer {
    return this.exports.memory.buffer;
  }

  /** Copy an array into the engine. False if the engine does not use an array of that name. */
  setArray(name: string, data: NumericArray): boolean {
    const ex = this.exports;
    const nameBytes = new TextEncoder().encode(name);
    const namePtr = ex.zg_alloc(nameBytes.length);
    new Uint8Array(this.memory, namePtr, nameBytes.length).set(nameBytes);
    const ptr = ex.zg_array(namePtr, nameBytes.length, data.length, data.BYTES_PER_ELEMENT);
    ex.zg_free(namePtr, nameBytes.length);
    if (ptr === 0) return false;
    // Views are made after the calls: memory may have grown and moved.
    const source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    new Uint8Array(this.memory, ptr, data.byteLength).set(source);
    return true;
  }

  /** Build the network from the arrays set so far and start a fresh simulation. */
  build(seed: number, dailyTrips: number): void {
    if (this.exports.zg_build(seed, dailyTrips) !== 0) {
      throw new Error('The traffic engine rejected the network data');
    }
  }

  setTime(secondsSinceMidnight: number): void {
    this.exports.zg_set_time(secondsSinceMidnight);
  }

  setDemandScale(scale: number): void {
    this.exports.zg_set_demand_scale(scale);
  }

  addTrip(depart: number, fromEdge: number, toEdge: number, vehicleType = 0): void {
    this.exports.zg_add_trip(depart, fromEdge, toEdge, vehicleType);
  }

  /** Advance `steps` steps; returns the simulated time. */
  step(steps: number): number {
    return this.exports.zg_step(steps);
  }

  /** Copy of the render buffer (RENDER.stride words per vehicle slot). */
  render(): Uint32Array {
    const ex = this.exports;
    const words = ex.zg_render_slots() * ex.zg_render_stride();
    return new Uint32Array(this.memory, ex.zg_render_ptr(), words).slice();
  }

  stats(): Float64Array {
    const ex = this.exports;
    return new Float64Array(this.memory, ex.zg_stats_ptr(), ex.zg_stats_len()).slice();
  }

  /** Mean speed / speed limit per edge over the last minute (0-254; 255 = no traffic). */
  edgeSpeeds(): Uint8Array {
    const ex = this.exports;
    return new Uint8Array(this.memory, ex.zg_edge_speed_ptr(), ex.zg_edge_count()).slice();
  }
}
