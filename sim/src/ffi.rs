//! C ABI for the WebAssembly build (no bindings generator).
//!
//! Loading: for each network array, JS calls `zg_array(name, count)` to get a buffer inside
//! the module's memory, copies the typed array into it, then calls `zg_build(seed)`.
//! Running: `zg_step(n)` advances `n` steps and refreshes the render buffer; JS reads the
//! render, statistics and edge-speed buffers through the returned pointers. Pointers stay
//! valid until the next call into the module (memory may grow and vectors may move).

use std::sync::Mutex;

use crate::demand::{Demand, Gateway};
use crate::edits::Edit;
use crate::engine::{DT, Engine, LanePiece, RENDER_STRIDE, Trip, stat};
use crate::network::{Network, NetworkData};
use crate::pedestrians::{CrossingData, Pedestrians};
use crate::transit::{Transit, TransitData};
use crate::weather::Weather;

#[derive(Default)]
struct State {
    data: NetworkData,
    demand_edges: Vec<u32>,
    demand_home: Vec<f32>,
    demand_work: Vec<f32>,
    gateway_entry: Vec<u32>,
    gateway_exit: Vec<u32>,
    gateway_daily: Vec<f32>,
    gateway_through: Vec<f32>,
    transit: TransitData,
    crossings: CrossingData,
    crossing_hourly: Vec<f32>,
    /// Bikes (M8d): roads with a cycle track or lane, and the City's homes and jobs bike
    /// trips go between, with the trips a day (one number).
    edge_cycleway: Vec<u8>,
    bike_edges: Vec<u32>,
    bike_home: Vec<f32>,
    bike_work: Vec<f32>,
    bike_daily: Vec<f32>,
    engine: Option<Engine>,
    stats: [f64; stat::LEN],
    /// Pedestrians at each crossing, for drawing (`Pedestrians::write_state`).
    crossing_state: Vec<u8>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// The message of the first panic (what, in which file and line), kept for JS to read after
/// the module traps: built with `panic = "abort"`, a panic in WebAssembly only says
/// "unreachable". The first: a trap leaves the state locked, so every later call panics
/// on the lock.
static PANIC: Mutex<String> = Mutex::new(String::new());

fn keep_panic_messages() {
    std::panic::set_hook(Box::new(|info| {
        if let Ok(mut message) = PANIC.lock()
            && message.is_empty()
        {
            *message = info.to_string();
        }
    }));
}

/// Length in bytes of the first panic's message (0 if none); `zg_panic_ptr` points to it.
#[unsafe(no_mangle)]
pub extern "C" fn zg_panic_len() -> usize {
    PANIC.lock().map(|m| m.len()).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn zg_panic_ptr() -> *const u8 {
    PANIC.lock().map(|m| m.as_ptr()).unwrap_or(std::ptr::null())
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// Zeroed storage for `count` elements, returned as a pointer for JS to fill.
fn alloc<T: Copy + Default>(v: &mut Vec<T>, count: usize) -> *mut u8 {
    *v = vec![T::default(); count];
    v.as_mut_ptr() as *mut u8
}

/// Allocate one of the demand (per-edge home and work weights, gateways), timetable or
/// pedestrian crossing arrays.
fn alloc_extra_array(s: &mut State, name: &str, count: usize, elem_size: usize) -> Option<*mut u8> {
    let t = &mut s.transit;
    let c = &mut s.crossings;
    let (ptr, size) = match name {
        "demandEdge" => (alloc(&mut s.demand_edges, count), 4),
        "demandHome" => (alloc(&mut s.demand_home, count), 4),
        "demandWork" => (alloc(&mut s.demand_work, count), 4),
        "gatewayEntry" => (alloc(&mut s.gateway_entry, count), 4),
        "gatewayExit" => (alloc(&mut s.gateway_exit, count), 4),
        "gatewayDaily" => (alloc(&mut s.gateway_daily, count), 4),
        "gatewayThrough" => (alloc(&mut s.gateway_through, count), 4),
        "transitTripType" => (alloc(&mut t.trip_type, count), 1),
        "transitTripRoute" => (alloc(&mut t.trip_route, count), 2),
        "transitTripStops" => (alloc(&mut t.trip_stops, count), 4),
        "transitStopEdge" => (alloc(&mut t.stop_edge, count), 4),
        "transitStopFrac" => (alloc(&mut t.stop_frac, count), 4),
        "transitStopTime" => (alloc(&mut t.stop_time, count), 4),
        "crossingLaneOffsets" => (alloc(&mut c.lane_offsets, count), 4),
        "crossingLanes" => (alloc(&mut c.lanes, count), 4),
        "crossingPos" => (alloc(&mut c.pos, count), 4),
        "crossingKind" => (alloc(&mut c.kind, count), 1),
        "crossingLength" => (alloc(&mut c.length, count), 4),
        "crossingJunction" => (alloc(&mut c.junction, count), 4),
        "crossingDaily" => (alloc(&mut c.daily, count), 4),
        "crossingHourly" => (alloc(&mut s.crossing_hourly, count), 4),
        "edgeCycleway" => (alloc(&mut s.edge_cycleway, count), 1),
        "bikeEdge" => (alloc(&mut s.bike_edges, count), 4),
        "bikeHome" => (alloc(&mut s.bike_home, count), 4),
        "bikeWork" => (alloc(&mut s.bike_work, count), 4),
        "bikeDaily" => (alloc(&mut s.bike_daily, count), 4),
        _ => return None,
    };
    (size == elem_size).then_some(ptr)
}

/// Allocate `bytes` bytes (e.g. for passing a string). Free with `zg_free`.
#[unsafe(no_mangle)]
pub extern "C" fn zg_alloc(bytes: usize) -> *mut u8 {
    let mut v = vec![0u8; bytes.max(1)];
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

/// # Safety
/// `ptr` must come from `zg_alloc(bytes)` and not be freed twice.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zg_free(ptr: *mut u8, bytes: usize) {
    if !ptr.is_null() {
        unsafe { drop(Vec::from_raw_parts(ptr, bytes.max(1), bytes.max(1))) };
    }
}

/// Buffer for `count` elements of `elem_size` bytes for the named array; null if the name
/// is unknown or the element size is not the engine's.
///
/// # Safety
/// `name` must point to `name_len` bytes of UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zg_array(
    name: *const u8,
    name_len: usize,
    count: usize,
    elem_size: usize,
) -> *mut u8 {
    let bytes = unsafe { std::slice::from_raw_parts(name, name_len) };
    let Ok(name) = std::str::from_utf8(bytes) else {
        return std::ptr::null_mut();
    };
    with_state(|s| match s.data.alloc_array(name, count, elem_size) {
        Some(bytes) => bytes.as_mut_ptr(),
        None => alloc_extra_array(s, name, count, elem_size).unwrap_or(std::ptr::null_mut()),
    })
}

/// Build the network and a fresh engine from the loaded arrays. Returns 0 on success,
/// -1 if the arrays are inconsistent. Demand comes from the `demand*` arrays if loaded,
/// else from the network (placeholder), with `daily_trips` trips per day within the map,
/// plus traffic across the map's edge from the `gateway*` arrays if loaded.
#[unsafe(no_mangle)]
pub extern "C" fn zg_build(seed: u32, daily_trips: f64) -> i32 {
    keep_panic_messages();
    with_state(|s| {
        let data = std::mem::take(&mut s.data);
        let net = match Network::build(data) {
            Ok(net) => net,
            Err(_) => return -1,
        };
        let mut demand = if !s.demand_edges.is_empty()
            && s.demand_home.len() == s.demand_edges.len()
            && s.demand_work.len() == s.demand_edges.len()
        {
            let edges = std::mem::take(&mut s.demand_edges);
            Demand::new(&net, edges, &s.demand_home, &s.demand_work, daily_trips)
        } else {
            Demand::from_network(&net, daily_trips)
        };
        let n = s.gateway_entry.len();
        if n > 0
            && s.gateway_exit.len() == n
            && s.gateway_daily.len() == n
            && s.gateway_through.len() == n
        {
            let gateways: Vec<Gateway> = (0..n)
                .map(|i| Gateway {
                    entry: s.gateway_entry[i],
                    exit: s.gateway_exit[i],
                    daily: s.gateway_daily[i],
                    through: s.gateway_through[i],
                })
                .collect();
            demand.set_gateways(&net, &gateways);
        }
        let transit = std::mem::take(&mut s.transit);
        let has_transit = transit.trips() > 0 && transit.consistent(net.edge_count());
        let mut crossings = std::mem::take(&mut s.crossings);
        let has_crossings = crossings.count() > 0
            && s.crossing_hourly.len() == 24
            && crossings.consistent(net.lane_count());
        let mut engine = Engine::new(net, seed as u64);
        engine.demand = Some(demand);
        if has_transit {
            engine.transit = Some(Transit::new(transit));
        }
        if has_crossings {
            crossings.hourly.copy_from_slice(&s.crossing_hourly);
            engine.pedestrians = Some(Pedestrians::new(crossings, &engine.net));
        }
        let n = s.bike_edges.len();
        if n > 0
            && s.bike_home.len() == n
            && s.bike_work.len() == n
            && s.bike_daily.len() == 1
            && s.edge_cycleway.len() == engine.net.edge_count()
        {
            engine.set_cycleways(&s.edge_cycleway);
            let edges = std::mem::take(&mut s.bike_edges);
            let daily = s.bike_daily[0] as f64;
            engine.bikes = Some(Demand::bikes(
                &engine.net,
                edges,
                &s.bike_home,
                &s.bike_work,
                daily,
            ));
        }
        s.engine = Some(engine);
        0
    })
}

/// Set the time of day (s since midnight).
#[unsafe(no_mangle)]
pub extern "C" fn zg_set_time(t: f64) {
    with_state(|s| {
        if let Some(e) = s.engine.as_mut() {
            e.set_time(t)
        }
    })
}

/// Scale generated demand (1 = full day's traffic).
#[unsafe(no_mangle)]
pub extern "C" fn zg_set_demand_scale(scale: f32) {
    with_state(|s| {
        if let Some(e) = s.engine.as_mut() {
            e.demand_scale = scale.max(0.0)
        }
    })
}

/// Set the weather's effect on driving (`weather.rs`): desired speed as a share, time
/// headway as a multiple, acceleration and braking as a share; kept within sensible bounds.
#[unsafe(no_mangle)]
pub extern "C" fn zg_set_weather(speed: f32, headway: f32, accel: f32) {
    with_state(|s| {
        if let Some(e) = s.engine.as_mut() {
            e.weather = Weather {
                speed,
                headway,
                accel,
            }
            .clamped();
        }
    })
}

/// Replace the demand's home and work weights with the `demand*` arrays loaded again (the
/// city's and those of buildings grown since), and the trips per day within the map, while
/// the simulation runs. Returns 0, or -1 without an engine, demand or consistent arrays.
#[unsafe(no_mangle)]
pub extern "C" fn zg_set_demand(daily_trips: f64) -> i32 {
    with_state(|s| {
        let n = s.demand_edges.len();
        if n == 0 || s.demand_home.len() != n || s.demand_work.len() != n {
            return -1;
        }
        let Some(e) = s.engine.as_mut() else {
            return -1;
        };
        let edges = std::mem::take(&mut s.demand_edges);
        match e.demand.as_mut() {
            Some(d) => {
                d.set_weights(&e.net, edges, &s.demand_home, &s.demand_work, daily_trips);
                0
            }
            None => -1,
        }
    })
}

/// Add one trip between two edges.
#[unsafe(no_mangle)]
pub extern "C" fn zg_add_trip(depart: f64, from: u32, to: u32, vtype: u32) {
    with_state(|s| {
        if let Some(e) = s.engine.as_mut() {
            e.add_trip(Trip {
                depart,
                from,
                to,
                vtype: vtype.min(3) as u8,
                flags: 0,
            })
        }
    })
}

/// Close roads (live closures): `n` edge ids at `edges`, replacing earlier closures.
///
/// # Safety
/// `edges` must point to `n` u32 values (or `n` be 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zg_set_closed(edges: *const u32, n: usize) {
    let list: &[u32] = if n == 0 || edges.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(edges, n) }
    };
    with_state(|s| {
        if let Some(e) = s.engine.as_mut() {
            e.set_closed(list)
        }
    })
}

/// Replace the network edits in force (`edits.rs`): `n` u32 words at `words`, four per
/// edit (kind, two arguments, value as f32 bits). Returns how many edits fit the network.
///
/// # Safety
/// `words` must point to `n` u32 values (or `n` be 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zg_set_edits(words: *const u32, n: usize) -> u32 {
    let list: &[u32] = if n == 0 || words.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(words, n) }
    };
    let edits = Edit::decode(list);
    with_state(|s| s.engine.as_mut().map_or(0, |e| e.set_edits(&edits) as u32))
}

/// Replace the running network with the arrays loaded since (`zg_array`), keeping the
/// vehicles (`Engine::replace_network`): `n` u32 words at `words`, four per lane piece (old
/// lane, from as f32 bits, new lane, shift as f32 bits). Returns 0, or -1 if the arrays or
/// pieces are inconsistent (the network running is kept).
///
/// # Safety
/// `words` must point to `n` u32 values (or `n` be 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zg_replace_network(words: *const u32, n: usize) -> i32 {
    let list: &[u32] = if n == 0 || words.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(words, n) }
    };
    let pieces: Vec<LanePiece> = list
        .chunks_exact(4)
        .map(|w| LanePiece {
            old: w[0],
            from: f32::from_bits(w[1]),
            lane: w[2],
            shift: f32::from_bits(w[3]),
        })
        .collect();
    with_state(|s| {
        let data = std::mem::take(&mut s.data);
        match s.engine.as_mut().map(|e| e.replace_network(data, &pieces)) {
            Some(Ok(())) => 0,
            _ => -1,
        }
    })
}

/// Pointer to one of the engine's signal arrays as it runs them (the guessed programs
/// re-timed, with edits): 0 `tlsPhaseOffsets` (u32), 1 `phaseDuration` (f32),
/// 2 `phaseStateOffsets` (u32), 3 `phaseStates` (u8). Its length is `zg_signal_len`.
#[unsafe(no_mangle)]
pub extern "C" fn zg_signal_ptr(which: u32) -> *const u8 {
    with_state(|s| {
        let Some(e) = s.engine.as_ref() else {
            return std::ptr::null();
        };
        let d = &e.net.d;
        match which {
            0 => d.tls_phase_offsets.as_ptr() as *const u8,
            1 => d.phase_duration.as_ptr() as *const u8,
            2 => d.phase_state_offsets.as_ptr() as *const u8,
            3 => d.phase_states.as_ptr(),
            _ => std::ptr::null(),
        }
    })
}

/// Fill the crossings' state for drawing (two bytes per crossing, see
/// `Pedestrians::write_state`) and return its length in bytes (0 without pedestrians);
/// `zg_crossings_ptr` points to it.
#[unsafe(no_mangle)]
pub extern "C" fn zg_crossings_update() -> u32 {
    with_state(|s| {
        let mut out = std::mem::take(&mut s.crossing_state);
        out.clear();
        if let Some(e) = s.engine.as_ref()
            && let Some(ped) = e.pedestrians.as_ref()
        {
            ped.write_state(e.time, &mut out);
        }
        let len = out.len() as u32;
        s.crossing_state = out;
        len
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn zg_crossings_ptr() -> *const u8 {
    with_state(|s| s.crossing_state.as_ptr())
}

/// Number of elements of the signal array `which` (see `zg_signal_ptr`).
#[unsafe(no_mangle)]
pub extern "C" fn zg_signal_len(which: u32) -> u32 {
    with_state(|s| {
        let Some(e) = s.engine.as_ref() else {
            return 0;
        };
        let d = &e.net.d;
        (match which {
            0 => d.tls_phase_offsets.len(),
            1 => d.phase_duration.len(),
            2 => d.phase_state_offsets.len(),
            3 => d.phase_states.len(),
            _ => 0,
        }) as u32
    })
}

/// Travel time (s) by car from edge `from` to edge `to` on the measured travel times, or
/// -1 without a route.
#[unsafe(no_mangle)]
pub extern "C" fn zg_route_time(from: u32, to: u32) -> f64 {
    with_state(|s| {
        s.engine
            .as_mut()
            .and_then(|e| e.route_time(from, to))
            .map_or(-1.0, |t| t as f64)
    })
}

/// Homes and jobs within reach by car of `n` roads at `sources` on the measured travel
/// times (`Engine::reach`: weighted by `exp(-time / decay)`, up to `max` seconds), written
/// to `out` as two f32 per road. Returns 0, or -1 without an engine.
///
/// # Safety
/// `sources` must point to `n` u32 values and `out` to room for `2 * n` f32 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zg_reach(
    sources: *const u32,
    n: usize,
    decay: f32,
    max: f32,
    out: *mut f32,
) -> i32 {
    if n == 0 || sources.is_null() || out.is_null() {
        return 0;
    }
    let list = unsafe { std::slice::from_raw_parts(sources, n) };
    let out = unsafe { std::slice::from_raw_parts_mut(out, 2 * n) };
    with_state(|s| {
        let Some(e) = s.engine.as_mut() else {
            return -1;
        };
        for (k, r) in e.reach(list, decay, max).into_iter().enumerate() {
            out[2 * k] = r[0];
            out[2 * k + 1] = r[1];
        }
        0
    })
}

/// Pointer to the number of vehicles that have driven onto each edge since the start
/// (u32 per edge, `zg_edge_count` of them).
#[unsafe(no_mangle)]
pub extern "C" fn zg_edge_entered_ptr() -> *const u32 {
    with_state(|s| {
        s.engine
            .as_ref()
            .map_or(std::ptr::null(), |e| e.edge_entered.as_ptr())
    })
}

/// Advance `n` steps of `zg_dt()` seconds, then refresh the render buffer. Returns the time.
#[unsafe(no_mangle)]
pub extern "C" fn zg_step(n: u32) -> f64 {
    with_state(|s| {
        let Some(e) = s.engine.as_mut() else {
            return 0.0;
        };
        for _ in 0..n {
            e.step();
        }
        e.write_render();
        s.stats = e.stats_array();
        e.time
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn zg_dt() -> f32 {
    DT
}

/// Render buffer: `zg_render_slots()` slots of `zg_render_stride()` 32-bit words.
#[unsafe(no_mangle)]
pub extern "C" fn zg_render_ptr() -> *const u32 {
    with_state(|s| {
        s.engine
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render.as_ptr())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn zg_render_slots() -> u32 {
    with_state(|s| {
        s.engine
            .as_ref()
            .map_or(0, |e| (e.render.len() / RENDER_STRIDE) as u32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn zg_render_stride() -> u32 {
    RENDER_STRIDE as u32
}

/// Statistics (`engine::stat` slots), refreshed by `zg_step`.
#[unsafe(no_mangle)]
pub extern "C" fn zg_stats_ptr() -> *const f64 {
    with_state(|s| s.stats.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn zg_stats_len() -> u32 {
    stat::LEN as u32
}

/// Mean speed / limit per edge over the last minute (0-254; 255 = no traffic).
#[unsafe(no_mangle)]
pub extern "C" fn zg_edge_speed_ptr() -> *const u8 {
    with_state(|s| {
        s.engine
            .as_ref()
            .map_or(std::ptr::null(), |e| e.edge_speed_ratio.as_ptr())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn zg_edge_count() -> u32 {
    with_state(|s| s.engine.as_ref().map_or(0, |e| e.net.edge_count() as u32))
}
