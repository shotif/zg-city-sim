/**
 * Run the WebAssembly traffic engine on the real Zagreb network in Node and report speed
 * and traffic statistics.
 *
 *   cargo build --release --target wasm32-unknown-unknown   (in sim/)
 *   node --experimental-strip-types sim/bench/bench.ts [--start 7] [--minutes 30] [--trips 500000]
 *
 * `--data` loads the demand, timetable, pedestrians and bikes as the app does (with the
 * demand's trips a day and share), and `--hierarchy` routes on a contraction hierarchy
 * (M11), ordered first as the app's order worker does.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';

import { STAT, TrafficEngine, type NumericArray } from '../../web/src/sim/wasm.ts';

const { values: args } = parseArgs({
  options: {
    start: { type: 'string', default: '7' },
    minutes: { type: 'string', default: '30' },
    trips: { type: 'string', default: '500000' },
    scale: { type: 'string', default: '1' },
    seed: { type: 'string', default: '1' },
    data: { type: 'boolean', default: false },
    hierarchy: { type: 'boolean', default: false },
  },
});

const root = new URL('../../', import.meta.url);

const CONSTRUCTORS = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
};
/** A packed data file's index and arrays (`pipeline/packed.py`). */
function readPacked(path: string): { index: any; arrays: Record<string, NumericArray> } {
  const dir = new URL(`web/public/data/${path.slice(0, path.lastIndexOf('/') + 1)}`, root);
  const index = JSON.parse(readFileSync(new URL(`web/public/data/${path}`, root), 'utf8'));
  const raw = gunzipSync(readFileSync(new URL(index.file, dir)));
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const arrays: Record<string, NumericArray> = {};
  for (const [name, spec] of Object.entries(index.arrays) as [string, any][]) {
    arrays[name] = new CONSTRUCTORS[spec.type as keyof typeof CONSTRUCTORS](
      buffer,
      spec.offset,
      spec.length,
    );
  }
  return { index, arrays };
}
const { arrays } = readPacked('network/net.json');
let dailyTrips = Number(args.trips);
let demandScale = Number(args.scale);
if (args.data) {
  const demand = readPacked('demand/demand.json');
  Object.assign(arrays, demand.arrays);
  dailyTrips = demand.index.dailyCarTrips;
  demandScale = demand.index.demandScale ?? 1;
  Object.assign(arrays, readPacked('transit/transit.json').arrays);
  const crossings = readPacked('pedestrians/crossings.json');
  Object.assign(arrays, crossings.arrays, { crossingHourly: Float32Array.from(crossings.index.hourly) });
  const bikes = readPacked('cycling/cycling.json');
  Object.assign(arrays, bikes.arrays, { bikeDaily: Float32Array.of(bikes.index.bikeTripsDaily) });
}

// Lane shapes, decoded as the app does (web/src/world/roadNetwork.ts decodePolylines).
const offsets = arrays.laneShapeOffsets;
const origin = arrays.laneShapeOrigin;
const delta = arrays.laneShapeDelta;
const elev = arrays.laneShapeElev;
const shape = new Float32Array(elev.length * 3);
for (let i = 0; i < offsets.length - 1; i++) {
  let x = origin[i * 2];
  let z = origin[i * 2 + 1];
  for (let p = offsets[i]; p < offsets[i + 1]; p++) {
    x += delta[p * 2];
    z += delta[p * 2 + 1];
    shape[p * 3] = x / 100;
    shape[p * 3 + 1] = z / 100;
    shape[p * 3 + 2] = elev[p] / 100;
  }
}
arrays.laneShape = shape;

const wasm = readFileSync(new URL('sim/target/wasm32-unknown-unknown/release/zg_sim.wasm', root));
const engine = await TrafficEngine.create(wasm);
let t0 = performance.now();
const used = Object.entries(arrays).filter(([name, data]) => engine.setArray(name, data));
engine.build(Number(args.seed), dailyTrips);
console.log(`loaded ${used.length} arrays and built the engine in ${(performance.now() - t0).toFixed(0)} ms`);
if (args.hierarchy) {
  t0 = performance.now();
  const graph = engine.hierarchyGraph();
  const order = engine.order(graph);
  const t1 = performance.now();
  const fits = engine.setOrder(order);
  console.log(
    `contraction hierarchy: ordered in ${((t1 - t0) / 1000).toFixed(1)} s, contracted in ` +
      `${(performance.now() - t1).toFixed(0)} ms${fits ? '' : ' (did not fit: A*)'}`,
  );
}

engine.setTime(Number(args.start) * 3600);
engine.setDemandScale(demandScale);
const minutes = Number(args.minutes);
const stepsPerMinute = Math.round(60 / engine.dt);
const clock = (t: number) =>
  `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`;

let worst = 0;
let total = 0;
for (let m = 1; m <= minutes; m++) {
  t0 = performance.now();
  engine.step(stepsPerMinute);
  const ms = performance.now() - t0;
  total += ms;
  worst = Math.max(worst, ms);
  if (m % 5 === 0 || m === minutes) {
    const s = engine.stats();
    console.log(
      `${clock(s[STAT.time])}  running ${s[STAT.running].toFixed(0).padStart(6)}  ` +
        `departed ${s[STAT.departed].toFixed(0).padStart(7)}  arrived ${s[STAT.arrived].toFixed(0).padStart(7)}  ` +
        `removed ${s[STAT.teleported].toFixed(0).padStart(5)}  no route ${s[STAT.noRoute].toFixed(0).padStart(5)}  ` +
        `backlog ${s[STAT.backlog].toFixed(0).padStart(5)}  ` +
        `mean ${(s[STAT.meanSpeed] * 3.6).toFixed(1).padStart(5)} km/h  stopped ${s[STAT.stopped].toFixed(0).padStart(6)}  ` +
        `trip ${(s[STAT.meanTripTime] / 60).toFixed(1)} min ${s[STAT.meanTripKm].toFixed(1)} km  ` +
        `| ${(ms / stepsPerMinute).toFixed(2)} ms/step`,
    );
  }
}
const simSeconds = minutes * 60;
console.log(
  `${minutes} simulated minutes in ${(total / 1000).toFixed(1)} s ` +
    `(${(simSeconds / (total / 1000)).toFixed(1)}x real time; worst minute ${worst.toFixed(0)} ms)`,
);
const render = engine.render();
console.log(`render buffer: ${render.length / 8} slots`);
console.log(`memory: ${(engine.memoryBytes / 2 ** 20).toFixed(0)} MiB`);
