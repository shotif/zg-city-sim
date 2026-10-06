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
use crate::engine::{DT, Engine, RENDER_STRIDE, Trip, stat};
use crate::network::{Network, NetworkData};
use crate::transit::{Transit, TransitData};

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
    engine: Option<Engine>,
    stats: [f64; stat::LEN],
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// Zeroed storage for `count` elements, returned as a pointer for JS to fill.
fn alloc<T: Copy + Default>(v: &mut Vec<T>, count: usize) -> *mut u8 {
    *v = vec![T::default(); count];
    v.as_mut_ptr() as *mut u8
}

/// Allocate one of the demand (per-edge home and work weights, gateways) or timetable
/// arrays.
fn alloc_extra_array(s: &mut State, name: &str, count: usize, elem_size: usize) -> Option<*mut u8> {
    let t = &mut s.transit;
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
        let mut engine = Engine::new(net, seed as u64);
        engine.demand = Some(demand);
        if has_transit {
            engine.transit = Some(Transit::new(transit));
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
