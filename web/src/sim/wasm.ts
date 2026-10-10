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
  zg_set_demand(dailyTrips: number): number;
  zg_set_weather(speed: number, headway: number, accel: number): void;
  zg_add_trip(depart: number, from: number, to: number, vtype: number): void;
  zg_set_closed(edges: number, count: number): void;
  zg_set_edits(words: number, count: number): number;
  zg_replace_network(words: number, count: number): number;
  zg_signal_ptr(which: number): number;
  zg_signal_len(which: number): number;
  zg_route_time(from: number, to: number): number;
  zg_reach(sources: number, count: number, decay: number, max: number, out: number): number;
  zg_edge_entered_ptr(): number;
  zg_step(steps: number): number;
  zg_dt(): number;
  zg_panic_len(): number;
  zg_panic_ptr(): number;
  zg_render_ptr(): number;
  zg_render_slots(): number;
  zg_render_stride(): number;
  zg_stats_ptr(): number;
  zg_stats_len(): number;
  zg_crossings_update(): number;
  zg_crossings_ptr(): number;
  zg_level_crossings_update(): number;
  zg_level_crossings_ptr(): number;
  zg_transit_path(trip: number): number;
  zg_transit_path_ptr(): number;
  zg_transit_state(): number;
  zg_transit_state_ptr(): number;
  zg_transit_service(): number;
  zg_transit_service_ptr(): number;
  zg_plan_line(words: number, count: number): number;
  zg_line_plan_ptr(): number;
  zg_riders(): number;
  zg_riders_ptr(): number;
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
  /** Vehicles coming from or going to places beyond the map. */
  outside: 16,
  /** Since the start, road vehicles (not trams): hours driving, hours of delay against the
   * speed limit, kilometres driven. */
  vehicleHours: 17,
  delayHours: 18,
  vehicleKm: 19,
  /** HŽ trains running. */
  trains: 20,
  /** Cyclists riding. */
  bikes: 21,
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

export const VEHICLE_TYPES = ['car', 'truck', 'bus', 'tram', 'train', 'bike'] as const;

/** The signal programs as the engine runs them: netconvert's guesses re-timed, with edits. */
export interface SignalPrograms {
  /** Phases of program t: phaseOffsets[t] to phaseOffsets[t + 1]. */
  phaseOffsets: Uint32Array;
  /** Seconds per phase. */
  duration: Float32Array;
  /** States of phase p's links: states[stateOffsets[p] to stateOffsets[p + 1]], one ASCII
   * character per controlled link ('G', 'g' green, 'y' yellow, 'r' red). */
  stateOffsets: Uint32Array;
  states: Uint8Array;
}

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

  /** What the engine panicked at (message, file and line), if it did: a panic only traps
   * as "unreachable". */
  panicMessage(): string | undefined {
    const length = this.exports.zg_panic_len();
    if (length === 0) return undefined;
    const bytes = new Uint8Array(this.memory, this.exports.zg_panic_ptr(), length);
    return new TextDecoder().decode(bytes.slice());
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

  /** Take the `demand*` arrays set again (homes and jobs, with those grown since) and the
   * car trips a day they make, while the simulation runs. */
  setDemand(dailyTrips: number): void {
    if (this.exports.zg_set_demand(dailyTrips) !== 0) {
      throw new Error('The traffic engine rejected the demand data');
    }
  }

  /** The weather's effect on driving: desired speed as a share, time headway as a
   * multiple, acceleration and braking as a share (sim/src/weather.rs). */
  setWeather(speed: number, headway: number, accel: number): void {
    this.exports.zg_set_weather(speed, headway, accel);
  }

  addTrip(depart: number, fromEdge: number, toEdge: number, vehicleType = 0): void {
    this.exports.zg_add_trip(depart, fromEdge, toEdge, vehicleType);
  }

  /** Close these edges to routing (live road closures), replacing earlier closures. */
  setClosed(edges: Uint32Array): void {
    const ex = this.exports;
    const bytes = edges.byteLength;
    const ptr = ex.zg_alloc(bytes);
    new Uint8Array(this.memory, ptr, bytes).set(
      new Uint8Array(edges.buffer, edges.byteOffset, bytes),
    );
    ex.zg_set_closed(ptr, edges.length);
    ex.zg_free(ptr, bytes);
  }

  /** Replace the network edits in force (four words per edit, see edits.ts); returns how
   * many fit the network. */
  setEdits(words: Uint32Array): number {
    const ex = this.exports;
    const bytes = words.byteLength;
    const ptr = bytes > 0 ? ex.zg_alloc(bytes) : 0;
    if (bytes > 0) {
      new Uint8Array(this.memory, ptr, bytes).set(
        new Uint8Array(words.buffer, words.byteOffset, bytes),
      );
    }
    const applied = ex.zg_set_edits(ptr, words.length);
    if (bytes > 0) ex.zg_free(ptr, bytes);
    return applied;
  }

  /** Swap in the network whose arrays were set since (roads drawn, web/src/edit/builder.ts),
   * keeping the vehicles: `pieces` say where the lanes running now went (four words each:
   * old lane, from as f32 bits, new lane, shift as f32 bits). */
  replaceNetwork(pieces: Uint32Array): void {
    const ex = this.exports;
    const bytes = pieces.byteLength;
    const ptr = bytes > 0 ? ex.zg_alloc(bytes) : 0;
    if (bytes > 0) {
      new Uint8Array(this.memory, ptr, bytes).set(
        new Uint8Array(pieces.buffer, pieces.byteOffset, bytes),
      );
    }
    const result = ex.zg_replace_network(ptr, pieces.length);
    if (bytes > 0) ex.zg_free(ptr, bytes);
    if (result !== 0) throw new Error('The traffic engine rejected the changed network');
  }

  /** Copies of the signal programs the engine runs. */
  signalPrograms(): SignalPrograms {
    const ex = this.exports;
    const view = <T>(which: number, make: (buffer: ArrayBuffer, ptr: number, n: number) => T) =>
      make(this.memory, ex.zg_signal_ptr(which), ex.zg_signal_len(which));
    return {
      phaseOffsets: view(0, (b, p, n) => new Uint32Array(b, p, n).slice()),
      duration: view(1, (b, p, n) => new Float32Array(b, p, n).slice()),
      stateOffsets: view(2, (b, p, n) => new Uint32Array(b, p, n).slice()),
      states: view(3, (b, p, n) => new Uint8Array(b, p, n).slice()),
    };
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

  /** Pedestrians at each crossing (M8c): two bytes each, those waiting (at most 255) and
   * how far across the last to start are (0-254; 255: nobody on it). Empty without them. */
  crossings(): Uint8Array {
    const ex = this.exports;
    const len = ex.zg_crossings_update();
    return len > 0
      ? new Uint8Array(this.memory, ex.zg_crossings_ptr(), len).slice()
      : new Uint8Array(0);
  }

  /** The level crossings (M8b), four numbers each: the junction; 0 open, 1 lights flashing,
   * 2 barriers down; the times closed; the seconds closed (the closure going on included). */
  levelCrossings(): Float32Array {
    const ex = this.exports;
    const len = ex.zg_level_crossings_update();
    return len > 0
      ? new Float32Array(this.memory, ex.zg_level_crossings_ptr(), len).slice()
      : new Float32Array(0);
  }

  /** The edges timetabled trip `trip` drives along, stop to stop (M9a). */
  transitPath(trip: number): Uint32Array {
    const ex = this.exports;
    const len = ex.zg_transit_path(trip);
    return len > 0
      ? new Uint32Array(this.memory, ex.zg_transit_path_ptr(), len).slice()
      : new Uint32Array(0);
  }

  /** Two numbers per bus, tram or train running: its trip and how late it is (s) (M9a). */
  transitState(): Float32Array {
    const ex = this.exports;
    const len = ex.zg_transit_state();
    return len > 0
      ? new Float32Array(this.memory, ex.zg_transit_state_ptr(), len).slice()
      : new Float32Array(0);
  }

  /** A new line's way (M9c): `words` are the vehicle type, then edge and fraction (f32
   * bits) per stop; the answer `[roads, roads..., stops served, (stop, time after the
   * first as f32 bits) per stop, metres as f32 bits]`, empty if it cannot run. */
  planLine(words: Uint32Array): Uint32Array {
    const ex = this.exports;
    const bytes = words.byteLength;
    const ptr = bytes > 0 ? ex.zg_alloc(bytes) : 0;
    if (bytes > 0) {
      new Uint8Array(this.memory, ptr, bytes).set(
        new Uint8Array(words.buffer, words.byteOffset, bytes),
      );
    }
    const len = ex.zg_plan_line(ptr, words.length);
    if (bytes > 0) ex.zg_free(ptr, bytes);
    return len > 0
      ? new Uint32Array(this.memory, ex.zg_line_plan_ptr(), len).slice()
      : new Uint32Array(0);
  }

  /** Public transport's riders (M9d; `readRiders`). */
  riders(): Float32Array {
    const ex = this.exports;
    const len = ex.zg_riders();
    return len > 0
      ? new Float32Array(this.memory, ex.zg_riders_ptr(), len).slice()
      : new Float32Array(0);
  }

  /** The trips that run with the frequency edits in force (M9b; `Timetable.setService`). */
  transitService(): Uint32Array {
    const ex = this.exports;
    const len = ex.zg_transit_service();
    return len > 0
      ? new Uint32Array(this.memory, ex.zg_transit_service_ptr(), len).slice()
      : new Uint32Array(0);
  }

  stats(): Float64Array {
    const ex = this.exports;
    return new Float64Array(this.memory, ex.zg_stats_ptr(), ex.zg_stats_len()).slice();
  }

  /** Seconds by car from one edge to another on the measured travel times (-1: no route). */
  routeTime(from: number, to: number): number {
    return this.exports.zg_route_time(from, to);
  }

  /** Homes and jobs within reach by car of each source edge on the measured travel times,
   * weighted by `exp(-time / decay)` up to `max` seconds: two numbers per source. */
  reach(sources: Uint32Array, decay: number, max: number): Float32Array {
    const ex = this.exports;
    const n = sources.length;
    if (n === 0) return new Float32Array(0);
    const ptr = ex.zg_alloc(4 * n);
    const out = ex.zg_alloc(8 * n);
    new Uint32Array(this.memory, ptr, n).set(sources);
    ex.zg_reach(ptr, n, decay, max, out);
    const result = new Float32Array(this.memory, out, 2 * n).slice();
    ex.zg_free(ptr, 4 * n);
    ex.zg_free(out, 8 * n);
    return result;
  }

  /** Vehicles that have driven onto each edge since the start. */
  edgeEntered(): Uint32Array {
    const ex = this.exports;
    return new Uint32Array(this.memory, ex.zg_edge_entered_ptr(), ex.zg_edge_count()).slice();
  }

  /** Mean speed / speed limit per edge over the last minute (0-254; 255 = no traffic). */
  edgeSpeeds(): Uint8Array {
    const ex = this.exports;
    return new Uint8Array(this.memory, ex.zg_edge_speed_ptr(), ex.zg_edge_count()).slice();
  }
}
