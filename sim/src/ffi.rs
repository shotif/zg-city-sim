//! C ABI for the WebAssembly build (no bindings generator).
//!
//! Loading: for each network array, JS calls `zg_array(name, count)` to get a buffer inside
//! the module's memory, copies the typed array into it, then calls `zg_build(seed)`.
//! Running: `zg_step(n)` advances `n` steps and refreshes the render buffer; JS reads the
//! render, statistics and edge-speed buffers through the returned pointers. Pointers stay
//! valid until the next call into the module (memory may grow and vectors may move).

use std::sync::Mutex;

use crate::demand::Demand;
use crate::engine::{DT, Engine, RENDER_STRIDE, Trip, stat};
use crate::network::{Network, NetworkData};
use crate::transit::{Transit, TransitData};

#[derive(Default)]
struct State {
    data: NetworkData,
    demand_edges: Vec<u32>,
    demand_home: Vec<f32>,
    demand_work: Vec<f32>,
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

/// Allocate one of the demand (per-edge home and work weights) or timetable arrays.
fn alloc_extra_array(s: &mut State, name: &str, count: usize, elem_size: usize) -> Option<*mut u8> {
    let t = &mut s.transit;
    let (ptr, size) = match name {
        "demandEdge" => (alloc(&mut s.demand_edges, count), 4),
        "demandHome" => (alloc(&mut s.demand_home, count), 4),
        "demandWork" => (alloc(&mut s.demand_work, count), 4),
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
/// else from the network (placeholder), with `daily_trips` trips per day.
#[unsafe(no_mangle)]
pub extern "C" fn zg_build(seed: u32, daily_trips: f64) -> i32 {
    with_state(|s| {
        let data = std::mem::take(&mut s.data);
        let net = match Network::build(data) {
            Ok(net) => net,
            Err(_) => return -1,
        };
        let demand = if !s.demand_edges.is_empty()
            && s.demand_home.len() == s.demand_edges.len()
            && s.demand_work.len() == s.demand_edges.len()
        {
            let edges = std::mem::take(&mut s.demand_edges);
            Demand::new(&net, edges, &s.demand_home, &s.demand_work, daily_trips)
        } else {
            Demand::from_network(&net, daily_trips)
        };
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
            })
        }
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
