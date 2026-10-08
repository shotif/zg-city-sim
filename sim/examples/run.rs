//! Run the engine natively on the network the pipeline exported, reporting traffic and
//! why vehicles are held up.
//!
//!   gunzip -kf web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
//!   cargo run --release --example run -- web/public/data/network [start_hour] [minutes] [daily_trips]

use std::collections::HashMap;
use std::time::Instant;

use zg_sim::demand::{Demand, Gateway};
use zg_sim::engine::{DT, Engine, Holdup};

/// Holdups in `Holdup` order.
const HOLDUP_NAMES: [&str; Holdup::COUNT] = [
    "in junction",
    "queued",
    "wrong lane",
    "red light",
    "exit full",
    "yielding",
    "stop sign",
    "blocked ahead",
    "other",
    "slow road",
    "standing mid-road",
];
use zg_sim::network::{Network, NetworkData};
use zg_sim::transit::{Transit, TransitData};

/// A packed file's arrays (pipeline/packed.py): name -> (type, byte offset, length).
type Packed = (HashMap<String, (String, usize, usize)>, Vec<u8>);

/// Read `<name>.json` (the packed index) and the uncompressed `<name>.bin` from `dir`.
fn read_packed(dir: &str, name: &str) -> Option<Packed> {
    let index = std::fs::read_to_string(format!("{dir}/{name}.json")).ok()?;
    let blob = std::fs::read(format!("{dir}/{name}.bin")).ok()?;
    let mut arrays = HashMap::new();
    // The index is simple enough to scan: "name": {"type": "u32", "offset": N, "length": N}
    let body = &index[index.find("\"arrays\"")?..];
    for part in body.split("}, ").chain(std::iter::once("")) {
        let Some(q) = part.rfind("{\"type\"") else {
            continue;
        };
        let name_end = part[..q].rfind("\":").unwrap();
        let name_start = part[..name_end].rfind('"').unwrap() + 1;
        let field = |key: &str| {
            let i = part.find(&format!("\"{key}\": ")).unwrap() + key.len() + 4;
            let rest = &part[i..];
            let end = rest.find([',', '}']).unwrap_or(rest.len());
            rest[..end].trim_matches('"').to_string()
        };
        arrays.insert(
            part[name_start..name_end].to_string(),
            (
                field("type"),
                field("offset").parse().unwrap(),
                field("length").parse().unwrap(),
            ),
        );
    }
    Some((arrays, blob))
}

fn elem_size(t: &str) -> usize {
    match t {
        "u8" | "i8" => 1,
        "u16" | "i16" => 2,
        _ => 4,
    }
}

/// Network arrays from `dir/net.*`, with lane shapes decoded like the app does.
pub fn load(dir: &str) -> NetworkData {
    let (decoded, blob) =
        read_packed(dir, "net").expect("net.json and net.bin (gunzip -kf net.bin.gz)");
    let mut data = NetworkData::default();
    for (name, (ty, offset, length)) in &decoded {
        let es = elem_size(ty);
        if let Some(bytes) = data.alloc_array(name, *length, es) {
            bytes.copy_from_slice(&blob[*offset..*offset + length * es]);
        }
    }
    // int32 cm origin, int16 cm steps, int16 cm elevation per point.
    let get = |name: &str| decoded[name].clone();
    let read_i32 = |o: usize| i32::from_le_bytes(blob[o..o + 4].try_into().unwrap());
    let read_i16 = |o: usize| i16::from_le_bytes(blob[o..o + 2].try_into().unwrap());
    let read_u32 = |o: usize| u32::from_le_bytes(blob[o..o + 4].try_into().unwrap());
    let (_, o_origin, _) = get("laneShapeOrigin");
    let (_, o_offsets, n_offsets) = get("laneShapeOffsets");
    let (_, o_delta, _) = get("laneShapeDelta");
    let (_, o_elev, n_points) = get("laneShapeElev");
    let mut shape = vec![0f32; n_points * 3];
    for i in 0..n_offsets - 1 {
        let mut x = read_i32(o_origin + i * 8) as i64;
        let mut z = read_i32(o_origin + i * 8 + 4) as i64;
        for p in read_u32(o_offsets + i * 4) as usize..read_u32(o_offsets + (i + 1) * 4) as usize {
            x += read_i16(o_delta + p * 4) as i64;
            z += read_i16(o_delta + p * 4 + 2) as i64;
            shape[p * 3] = x as f32 / 100.0;
            shape[p * 3 + 1] = z as f32 / 100.0;
            shape[p * 3 + 2] = read_i16(o_elev + p * 2) as f32 / 100.0;
        }
    }
    data.lane_shape = shape;
    data
}

/// The timetable from `dir/transit.*`.
pub fn load_transit(dir: &str) -> Option<TransitData> {
    let (arrays, blob) = read_packed(dir, "transit")?;
    let bytes = |name: &str, size: usize| -> Vec<u8> {
        let (_, offset, length) = &arrays[name];
        blob[*offset..*offset + length * size].to_vec()
    };
    let words = |name: &str| -> Vec<[u8; 4]> { bytes(name, 4).as_chunks::<4>().0.to_vec() };
    Some(TransitData {
        trip_type: bytes("transitTripType", 1),
        trip_route: bytes("transitTripRoute", 2)
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&c| u16::from_le_bytes(c))
            .collect(),
        trip_stops: words("transitTripStops")
            .into_iter()
            .map(u32::from_le_bytes)
            .collect(),
        stop_edge: words("transitStopEdge")
            .into_iter()
            .map(u32::from_le_bytes)
            .collect(),
        stop_frac: words("transitStopFrac")
            .into_iter()
            .map(f32::from_le_bytes)
            .collect(),
        stop_time: words("transitStopTime")
            .into_iter()
            .map(f32::from_le_bytes)
            .collect(),
    })
}

/// Building-based demand from `dir/demand.*`: edges, residents and jobs per edge.
struct DemandData {
    edges: Vec<u32>,
    home: Vec<f32>,
    work: Vec<f32>,
    gateways: Vec<Gateway>,
}

fn load_demand(dir: &str) -> Option<DemandData> {
    let (arrays, blob) = read_packed(dir, "demand")?;
    let words = |name: &str| -> Vec<[u8; 4]> {
        let Some((_, offset, length)) = arrays.get(name) else {
            return Vec::new();
        };
        blob[*offset..*offset + length * 4]
            .as_chunks::<4>()
            .0
            .to_vec()
    };
    let u32s =
        |name: &str| -> Vec<u32> { words(name).into_iter().map(u32::from_le_bytes).collect() };
    let f32s =
        |name: &str| -> Vec<f32> { words(name).into_iter().map(f32::from_le_bytes).collect() };
    let (entry, exit) = (u32s("gatewayEntry"), u32s("gatewayExit"));
    let (daily, through) = (f32s("gatewayDaily"), f32s("gatewayThrough"));
    let gateways = (0..entry
        .len()
        .min(exit.len())
        .min(daily.len())
        .min(through.len()))
        .map(|i| Gateway {
            entry: entry[i],
            exit: exit[i],
            daily: daily[i],
            through: through[i],
        })
        .collect();
    Some(DemandData {
        edges: u32s("demandEdge"),
        home: f32s("demandHome"),
        work: f32s("demandWork"),
        gateways,
    })
}

/// Demand from `demand_dir` (with traffic across the map's edge unless NO_GATEWAYS is
/// set), or a placeholder from the network. `trips`: car trips a day within the map (0 =
/// from the residents).
pub fn demand_for(net: &Network, demand_dir: &str, trips: f64) -> Demand {
    match load_demand(demand_dir) {
        Some(d) => {
            let residents: f32 = d.home.iter().sum();
            // Car trips per resident: 1.84 trips per person, 46 % by car, 1.3 per car.
            let daily = if trips > 0.0 {
                trips
            } else {
                residents as f64 * 1.84 * 0.46 / 1.3
            };
            println!(
                "demand: {} edges, {residents:.0} residents, {daily:.0} car trips a day",
                d.edges.len()
            );
            let mut demand = Demand::new(net, d.edges, &d.home, &d.work, daily);
            if std::env::var("NO_GATEWAYS").is_err() {
                demand.set_gateways(net, &d.gateways);
            }
            let (inbound, outbound, through) = demand.gateway_trips();
            println!(
                "beyond the map: {} gateways, {inbound:.0} trips in, {outbound:.0} out, {through:.0} through a day",
                d.gateways.len()
            );
            demand
        }
        None => {
            println!("demand: placeholder from the network (no {demand_dir}/demand.bin)");
            Demand::from_network(net, if trips > 0.0 { trips } else { 500_000.0 })
        }
    }
}

/// Share of the day's demand to simulate: DEMAND_SCALE if set, else the calibrated
/// `demandScale` in `demand_dir/demand.json`, else 1.
pub fn demand_scale(demand_dir: &str) -> f32 {
    if let Some(scale) = std::env::var("DEMAND_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
    {
        return scale;
    }
    let index = std::fs::read_to_string(format!("{demand_dir}/demand.json")).unwrap_or_default();
    index
        .find("\"demandScale\": ")
        .and_then(|i| {
            let rest = &index[i + 15..];
            rest[..rest.find([',', '}']).unwrap_or(rest.len())]
                .trim()
                .parse()
                .ok()
        })
        .unwrap_or(1.0)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args
        .get(1)
        .map(String::as_str)
        .unwrap_or("web/public/data/network");
    let start: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(7.0);
    let minutes: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    // Daily car trips; 0 = from the demand data.
    let trips: f64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(0.0);

    let t0 = Instant::now();
    let net = Network::build(load(dir)).expect("consistent network");
    println!(
        "network: {} lanes, {} links ({:.0} ms)",
        net.lane_count(),
        net.d.link_from.len(),
        t0.elapsed().as_secs_f64() * 1e3
    );
    let demand = demand_for(&net, &format!("{dir}/../demand"), trips);
    let t0 = Instant::now();
    let seed = std::env::var("SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let mut engine = Engine::new(net, seed);
    engine.debug = std::env::var("DEBUG_TELEPORT").is_ok();
    // DEBUG_EDGES=e1,e2: log the vehicles removed from these edges.
    if let Ok(list) = std::env::var("DEBUG_EDGES") {
        engine.debug = true;
        engine.debug_edges = list
            .split(',')
            .filter_map(|e| e.trim().trim_start_matches('e').parse().ok())
            .collect();
    }
    match load_transit(&format!("{dir}/../transit")) {
        Some(data) if data.consistent(engine.net.edge_count()) => {
            println!("transit: {} trips", data.trips());
            engine.transit = Some(Transit::new(data));
        }
        Some(_) => println!("transit: timetable does not match the network"),
        None => println!("transit: none (no transit/transit.bin)"),
    }
    println!(
        "engine with routing landmarks ready in {:.0} ms",
        t0.elapsed().as_secs_f64() * 1e3
    );
    engine.demand = Some(demand);
    engine.demand_scale = demand_scale(&format!("{dir}/../demand"));
    println!("demand scale: {}", engine.demand_scale);
    engine.set_time(start * 3600.0);
    engine.track_delay = true;
    engine.skip_phases = std::env::var("NO_PHASE_SKIP").is_err();
    engine.reroute = std::env::var("NO_REROUTE").is_err();

    // WATCH_JUNCTIONS=j1,j2: every simulated minute, the stopped front vehicle of each queue
    // into those junctions, why it waits and who it looks out for.
    let watch: Vec<u32> = std::env::var("WATCH_JUNCTIONS")
        .map(|v| v.split(',').filter_map(|s| s.trim().parse().ok()).collect())
        .unwrap_or_default();
    for &j in &watch {
        print!("junction {j}:\n{}", engine.describe_program(j));
    }
    let steps_per_minute = (60.0 / DT) as u32;
    let mut total = 0.0;
    for m in 1..=minutes {
        let t = Instant::now();
        for _ in 0..steps_per_minute {
            engine.step();
        }
        total += t.elapsed().as_secs_f64();
        for &j in &watch {
            let d = &engine.net.d;
            for lane in 0..d.lane_edge.len() as u32 {
                let edge = d.lane_edge[lane as usize] as usize;
                if d.edge_to[edge] != j || engine.net.lane_internal[lane as usize] {
                    continue;
                }
                let Some(&front) = engine.vehicles_on(lane).last() else {
                    continue;
                };
                let fv = &engine.vehs[front as usize];
                if fv.speed > 1.0 || d.lane_length[lane as usize] - fv.pos > 15.0 {
                    continue;
                }
                println!(
                    "  watch {j}: {} queued {}; {}",
                    engine.describe(front),
                    engine.vehicles_on(lane).len(),
                    engine.describe_conflicts(front)
                );
                for b in engine.describe_blockers(front) {
                    println!("    blocked by {b}");
                }
                if engine.diagnose(front) == zg_sim::engine::Holdup::ExitFull {
                    println!("    queue:{}", engine.describe_queue_chain(front));
                }
            }
        }
        if m % 5 == 0 || m == minutes {
            let s = &engine.stats;
            let h = engine.time / 3600.0;
            println!(
                "{:02}:{:02} running {:6} (outside {:5}) departed {:7} arrived {:7} removed {:5} no-route {:4} late {:5} backlog {:5} mean {:5.1} km/h stopped {:5} trip {:4.1} min {:4.1} km | {:.2} ms/step",
                h as u32 % 24,
                (engine.time / 60.0) as u32 % 60,
                s.running,
                s.outside,
                s.departed,
                s.arrived,
                s.teleported,
                s.no_route,
                s.insert_failed,
                engine.stats_array()[zg_sim::engine::stat::BACKLOG],
                s.mean_speed * 3.6,
                s.stopped,
                s.mean_trip_time / 60.0,
                s.mean_trip_km,
                t.elapsed().as_secs_f64() * 1e3 / steps_per_minute as f64,
            );
            // Vehicles waiting over a minute, by reason.
            let mut reasons: HashMap<Holdup, (u32, Vec<u32>)> = HashMap::new();
            for v in engine.live_vehicles() {
                if engine.vehs[v as usize].wait > 60.0 {
                    let e = reasons.entry(engine.diagnose(v)).or_default();
                    e.0 += 1;
                    if e.1.len() < 3 {
                        e.1.push(v);
                    }
                }
            }
            let mut list: Vec<_> = reasons.into_iter().collect();
            list.sort_by_key(|(_, (n, _))| std::cmp::Reverse(*n));
            for (reason, (n, examples)) in list {
                let where_: Vec<String> = examples
                    .iter()
                    .map(|&v| {
                        let veh = &engine.vehs[v as usize];
                        let lane = veh.lane as usize;
                        let shape = engine.net.d.lane_shape_offsets[lane + 1] as usize - 1;
                        format!(
                            "lane {} at ({:.0}, {:.0}) link {}",
                            veh.lane,
                            engine.net.d.lane_shape[shape * 3],
                            engine.net.d.lane_shape[shape * 3 + 1],
                            veh.next_link
                        )
                    })
                    .collect();
                println!("    {reason:?}: {n}   e.g. {}", where_.join("; "));
                if reason == Holdup::ExitFull && std::env::var("DEBUG_EXIT").is_ok() {
                    for &v in &examples {
                        println!("        {}", engine.describe_exit(v));
                    }
                }
                if std::env::var("DEBUG_CHAIN").is_ok_and(|r| r == format!("{reason:?}")) {
                    for &v in &examples {
                        let mut u = v;
                        println!("        {}", engine.describe(u));
                        println!("          sees:{}", engine.describe_ahead(u));
                        for _ in 0..14 {
                            let Some(l) = engine.leader_of(u) else { break };
                            println!("          ahead: {}", engine.describe(l));
                            u = l;
                        }
                    }
                }
            }
        }
    }
    println!(
        "{minutes} simulated minutes in {total:.1} s ({:.0}x real time)",
        minutes as f64 * 60.0 / total
    );
    let s = &engine.stats;
    println!(
        "routing: {} routes, {:.0} edges settled per route",
        s.routes,
        s.route_settled as f64 / s.routes.max(1) as f64
    );
    let [searches, failed, found_settled, failed_settled] = engine.route_counts();
    println!(
        "route searches: {searches}, {failed} failed; {:.0} edges settled per search found, {:.0} per search failed",
        found_settled as f64 / (searches - failed).max(1) as f64,
        failed_settled as f64 / failed.max(1) as f64
    );
    println!(
        "lane changes missed: {} vehicles went another way from a lane with no way on",
        s.lane_reroutes
    );
    println!(
        "routes changed on the way, around jams ahead: {}",
        s.en_route_reroutes
    );
    println!("removed vehicles were: {:?}", s.teleport_reasons);
    let mut places: Vec<(u32, u32)> = s.removed_at.iter().map(|(&e, &n)| (n, e)).collect();
    places.sort_unstable_by(|a, b| b.cmp(a));
    let top: Vec<String> = places
        .iter()
        .take(25)
        .map(|(n, e)| format!("e{e}:{n}"))
        .collect();
    println!("removed most often on: {}", top.join(" "));
    // Where vehicles stand in queues: vehicles stopped over 30 s per edge (DUMP_QUEUES=file).
    if let Ok(path) = std::env::var("DUMP_QUEUES") {
        let mut stopped = vec![0u32; engine.net.edge_count()];
        let mut waiting = vec![0f32; engine.net.edge_count()];
        for v in engine.live_vehicles() {
            let veh = &engine.vehs[v as usize];
            if veh.wait > 30.0 {
                let e = engine.net.d.lane_edge[veh.lane as usize] as usize;
                stopped[e] += 1;
                waiting[e] += veh.wait;
            }
        }
        let mut out = String::from("edge,stopped,mean_wait\n");
        for (e, &n) in stopped.iter().enumerate() {
            if n > 0 {
                out += &format!("{e},{n},{:.0}\n", waiting[e] / n as f32);
            }
        }
        std::fs::write(&path, out).expect("write queue dump");
    }
    if let Some(tr) = &engine.transit {
        println!(
            "transit: {} runs started, {} could not be routed, {} stops skipped, {} waiting; now {} trams, {} buses",
            tr.started,
            tr.failed,
            tr.skipped_stops,
            tr.waiting.len(),
            s.trams,
            s.buses
        );
    }
    for line in &s.teleport_log {
        println!("  removed: {line}");
    }
    // Where junctions lose time: vehicle-hours queued, other than at red lights, charged to
    // the junction each queue waited on in the end.
    let mut total = [0f64; Holdup::COUNT];
    let mut lost: Vec<(f64, usize)> = Vec::new();
    for (j, row) in engine.delay_root.iter().enumerate() {
        for (k, v) in row.iter().enumerate() {
            total[k] += *v as f64 / 3600.0;
        }
        let other: f32 = row.iter().sum::<f32>() - row[Holdup::Signal as usize];
        lost.push((other as f64 / 3600.0, j));
    }
    lost.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));
    println!(
        "queued at junctions (vehicle-hours): {}",
        HOLDUP_NAMES
            .iter()
            .zip(total)
            .filter(|(_, v)| *v >= 0.05)
            .map(|(n, v)| format!("{n} {v:.0}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    for &(hours, j) in lost.iter().take(12) {
        let row = &engine.delay_root[j];
        let (x, z) = (
            engine.net.d.junction_pos[j * 2],
            engine.net.d.junction_pos[j * 2 + 1],
        );
        let parts: Vec<String> = HOLDUP_NAMES
            .iter()
            .zip(row)
            .filter(|(_, v)| **v >= 180.0)
            .map(|(n, v)| format!("{n} {:.1}", v / 3600.0))
            .collect();
        println!(
            "  junction {j} at ({x:.0}, {z:.0}): {hours:.1} h lost; {}",
            parts.join(", ")
        );
    }
    if engine.phase_seconds.iter().any(|&t| t > 0.0) {
        let names = [
            "signals+demand",
            "plan",
            "move",
            "lane changes",
            "insertion+routing",
            "statistics",
        ];
        let parts: Vec<String> = names
            .iter()
            .zip(engine.phase_seconds)
            .map(|(n, t)| format!("{n} {:.1} s", t))
            .collect();
        println!(
            "time by phase: {}; route searches {:.1} s",
            parts.join(", "),
            engine.route_seconds()
        );
    }
}
