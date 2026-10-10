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
    "pedestrians",
];
use zg_sim::edits::Edit;
use zg_sim::network::{Network, NetworkData};
use zg_sim::pedestrians::{CrossingData, Pedestrians};
use zg_sim::transit::{Transit, TransitData};
use zg_sim::vtype;

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

/// Pedestrian crossings from `dir/crossings.*` (M8c).
pub fn load_pedestrians(dir: &str) -> Option<CrossingData> {
    let (arrays, blob) = read_packed(dir, "crossings")?;
    let bytes = |name: &str, size: usize| -> Vec<u8> {
        let (_, offset, length) = &arrays[name];
        blob[*offset..*offset + length * size].to_vec()
    };
    let words = |name: &str| -> Vec<[u8; 4]> { bytes(name, 4).as_chunks::<4>().0.to_vec() };
    let u32s = |name: &str| words(name).into_iter().map(u32::from_le_bytes).collect();
    let f32s = |name: &str| words(name).into_iter().map(f32::from_le_bytes).collect();
    let index = std::fs::read_to_string(format!("{dir}/crossings.json")).ok()?;
    let list = &index[index.find("\"hourly\"")?..];
    let list = &list[list.find('[')? + 1..list.find(']')?];
    let mut hourly = [0.0f32; 24];
    for (h, v) in list.split(',').enumerate().take(24) {
        hourly[h] = v.trim().parse().ok()?;
    }
    Some(CrossingData {
        lane_offsets: u32s("crossingLaneOffsets"),
        lanes: u32s("crossingLanes"),
        pos: f32s("crossingPos"),
        kind: bytes("crossingKind", 1),
        length: f32s("crossingLength"),
        junction: u32s("crossingJunction"),
        daily: f32s("crossingDaily"),
        hourly,
    })
}

/// Pedestrians at the crossings in `dir` for `engine`, unless NO_PEDESTRIANS is set;
/// PEDESTRIAN_SCALE=0.5 lets half of them arrive.
pub fn attach_pedestrians(engine: &mut Engine, dir: &str) {
    if std::env::var("NO_PEDESTRIANS").is_ok() {
        println!("pedestrians: none (NO_PEDESTRIANS)");
        return;
    }
    match load_pedestrians(dir) {
        Some(data) if data.consistent(engine.net.lane_count()) => {
            println!("pedestrians: {} crossings", data.count());
            let mut ped = Pedestrians::new(data, &engine.net);
            if let Some(scale) = std::env::var("PEDESTRIAN_SCALE")
                .ok()
                .and_then(|s| s.parse().ok())
            {
                ped.scale = scale;
            }
            engine.pedestrians = Some(ped);
        }
        Some(_) => println!("pedestrians: crossings do not match the network"),
        None => println!("pedestrians: none (no pedestrians/crossings.bin)"),
    }
}

/// Bike trips and cycle tracks from `dir/cycling.*` (M8d) for `engine`, unless NO_BIKES is
/// set; BIKE_SCALE=0.5 runs half of the estimated bike trips.
pub fn attach_bikes(engine: &mut Engine, dir: &str) {
    if std::env::var("NO_BIKES").is_ok() {
        println!("bikes: none (NO_BIKES)");
        return;
    }
    let Some((arrays, blob)) = read_packed(dir, "cycling") else {
        println!("bikes: none (no cycling/cycling.bin)");
        return;
    };
    let bytes = |name: &str, size: usize| -> Vec<u8> {
        let (_, offset, length) = &arrays[name];
        blob[*offset..*offset + length * size].to_vec()
    };
    let words = |name: &str| -> Vec<[u8; 4]> { bytes(name, 4).as_chunks::<4>().0.to_vec() };
    let cycleway = bytes("edgeCycleway", 1);
    if cycleway.len() != engine.net.edge_count() {
        println!("bikes: cycle tracks do not match the network");
        return;
    }
    let edges: Vec<u32> = words("bikeEdge")
        .into_iter()
        .map(u32::from_le_bytes)
        .collect();
    let home: Vec<f32> = words("bikeHome")
        .into_iter()
        .map(f32::from_le_bytes)
        .collect();
    let work: Vec<f32> = words("bikeWork")
        .into_iter()
        .map(f32::from_le_bytes)
        .collect();
    let index = std::fs::read_to_string(format!("{dir}/cycling.json")).unwrap_or_default();
    let daily: f64 = index
        .find("\"bikeTripsDaily\": ")
        .and_then(|i| {
            let rest = &index[i + 18..];
            rest[..rest.find([',', '}'])?].trim().parse().ok()
        })
        .unwrap_or(0.0);
    engine.set_cycleways(&cycleway);
    engine.bikes = Some(Demand::bikes(&engine.net, edges, &home, &work, daily));
    if let Some(scale) = std::env::var("BIKE_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
    {
        engine.bike_scale = scale;
    }
    println!("bikes: {daily} trips a day");
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

/// Edits running every tram and bus line `factor` times as often (M9b).
pub fn frequency_edits(engine: &Engine, factor: f32) -> Vec<Edit> {
    // FREQUENCY_MODES=tram (or bus) changes only that mode's lines; FREQUENCY_ROUTES=5,6
    // only those routes (the timetable's indices: tram 6 is 5).
    let modes = std::env::var("FREQUENCY_MODES").unwrap_or_default();
    let only: Vec<u16> = std::env::var("FREQUENCY_ROUTES")
        .unwrap_or_default()
        .split(',')
        .filter_map(|r| r.trim().parse().ok())
        .collect();
    let changed = |vt: u8| match modes.as_str() {
        "tram" => vt == vtype::TRAM,
        "bus" => vt == vtype::BUS,
        _ => matches!(vt, vtype::TRAM | vtype::BUS),
    };
    let routes: std::collections::BTreeSet<u16> = engine
        .transit
        .as_ref()
        .map(|tr| {
            let d = &tr.data;
            (0..tr.timetabled)
                .filter(|&t| {
                    changed(d.trip_type[t]) && (only.is_empty() || only.contains(&d.trip_route[t]))
                })
                .map(|t| d.trip_route[t])
                .collect()
        })
        .unwrap_or_default();
    routes
        .iter()
        .map(|&route| Edit::Frequency {
            route: route as u32,
            factor,
        })
        .collect()
}

/// Signal priority for trams and buses (M10b): `which` is `all` (every signal a tram or bus
/// crosses) or routes (the timetable's indices, comma-separated: tram 6 is 5).
pub fn priority_edits(engine: &mut Engine, which: &str) -> Vec<Edit> {
    let only: Vec<u16> = which
        .split(',')
        .filter_map(|r| r.trim().parse().ok())
        .collect();
    let d = &engine.net.d;
    let mut junction_tls = vec![u32::MAX; d.junction_link_count.len()];
    for l in 0..d.link_tls.len() {
        if d.link_tls[l] != u32::MAX {
            junction_tls[d.link_junction[l] as usize] = d.link_tls[l];
        }
    }
    // One trip of each route and its ends (its directions and variants).
    let mut trips = Vec::new();
    if let Some(tr) = &engine.transit {
        let td = &tr.data;
        let mut seen = std::collections::HashSet::new();
        for t in 0..tr.timetabled {
            let route = td.trip_route[t];
            let stops = td.stops(t as u32);
            if !matches!(td.trip_type[t], vtype::TRAM | vtype::BUS)
                || which != "all" && !only.contains(&route)
                || stops.is_empty()
            {
                continue;
            }
            let key = (
                route,
                td.stop_edge[stops.start],
                td.stop_edge[stops.end - 1],
            );
            if seen.insert(key) {
                trips.push(t as u32);
            }
        }
    }
    let mut tls = std::collections::BTreeSet::new();
    for trip in trips {
        let path = engine.transit_path(trip);
        for &e in &path[..path.len().saturating_sub(1)] {
            let t = junction_tls[engine.net.d.edge_to[e as usize] as usize];
            if t != u32::MAX {
                tls.insert(t);
            }
        }
    }
    tls.into_iter().map(|tls| Edit::Priority { tls }).collect()
}

/// The City's district of each demand edge (M9d; empty if the data has none).
pub fn load_districts(demand_dir: &str) -> Vec<u8> {
    let Some((arrays, blob)) = read_packed(demand_dir, "demand") else {
        return Vec::new();
    };
    match arrays.get("demandDistrict") {
        Some((_, offset, length)) => blob[*offset..*offset + length].to_vec(),
        None => Vec::new(),
    }
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
            // GATEWAY_LOCAL_KM=8: another decay for traffic across the map's edge on roads
            // other than motorways, to calibrate.
            if let Some(km) = std::env::var("GATEWAY_LOCAL_KM")
                .ok()
                .and_then(|v| v.parse::<f32>().ok())
            {
                demand.local_gateway_decay = km * 1000.0;
            }
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
    attach_pedestrians(&mut engine, &format!("{dir}/../pedestrians"));
    attach_bikes(&mut engine, &format!("{dir}/../cycling"));
    println!(
        "engine with routing landmarks ready in {:.0} ms",
        t0.elapsed().as_secs_f64() * 1e3
    );
    engine.demand = Some(demand);
    engine.demand_scale = demand_scale(&format!("{dir}/../demand"));
    println!("demand scale: {}", engine.demand_scale);
    // Public transport's riders (M9d); FREQUENCY=2: every tram and bus line run that many
    // times as often (M9b).
    let districts = load_districts(&format!("{dir}/../demand"));
    engine.start_riders((!districts.is_empty()).then_some(&districts[..]));
    // PRIORITY=all (or routes): signal priority for trams and buses (M10b).
    let mut edits = Vec::new();
    if let Some(factor) = std::env::var("FREQUENCY")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
    {
        edits.extend(frequency_edits(&engine, factor));
        println!("frequency: {} lines {factor} times as often", edits.len());
    }
    if let Ok(which) = std::env::var("PRIORITY") {
        let priority = priority_edits(&mut engine, &which);
        println!("priority for trams and buses at {} signals", priority.len());
        edits.extend(priority);
    }
    if !edits.is_empty() {
        let applied = engine.set_edits(&edits);
        println!("edits: {applied} of {} applied", edits.len());
    }
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
    // TRAM_HOLDUPS=1: where trams stand still off their stops, and why, printed at the end.
    let tram_holdups = std::env::var("TRAM_HOLDUPS").is_ok();
    let mut held: HashMap<(u32, Holdup), f32> = HashMap::new();
    let steps_per_minute = (60.0 / DT) as u32;
    let mut total = 0.0;
    for m in 1..=minutes {
        let t = Instant::now();
        for k in 0..steps_per_minute {
            engine.step();
            if tram_holdups && k % 10 == 0 {
                for v in engine.live_vehicles() {
                    let veh = &engine.vehs[v as usize];
                    if veh.vtype == vtype::TRAM
                        && veh.speed < 0.5
                        && !veh.transit.as_ref().is_some_and(|run| run.dwelling)
                    {
                        *held.entry((veh.lane, engine.diagnose(v))).or_default() += 10.0 * DT;
                    }
                }
            }
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
        // WATCH_LANES=l1,l2: every 5 simulated minutes, the vehicles on those lanes.
        if m % 5 == 0 {
            for lane in std::env::var("WATCH_LANES")
                .unwrap_or_default()
                .split(',')
                .filter_map(|s| s.trim().parse::<u32>().ok())
            {
                println!("  lane {lane}:");
                for &v in engine.vehicles_on(lane).iter().rev() {
                    let veh = &engine.vehs[v as usize];
                    let dwell = veh.transit.as_ref().map(|run| {
                        format!(
                            " dwelling {} until {:.0} late {:.0}",
                            run.dwelling,
                            run.dwell_until - engine.time,
                            run.late
                        )
                    });
                    println!(
                        "    {} pos {:.0} speed {:.1} {:?}{}",
                        veh.vtype,
                        veh.pos,
                        veh.speed,
                        engine.diagnose(v),
                        dwell.unwrap_or_default()
                    );
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
    // DEBUG_LOOPS: bikes riding round in circles (an edge twice on their route).
    if std::env::var("DEBUG_LOOPS").is_ok() {
        let mut shown = 0;
        for (v, veh) in engine.vehs.iter().enumerate() {
            if !veh.alive() || veh.vtype != zg_sim::vtype::BIKE {
                continue;
            }
            let mut seen = std::collections::HashSet::new();
            if veh.route.iter().all(|e| seen.insert(*e)) {
                continue;
            }
            if shown < 6 {
                println!("loop: {} route {:?}", engine.describe(v as u32), veh.route);
            }
            shown += 1;
        }
        println!("bikes with a loop in their route: {shown}");
    }
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
        let late: Vec<String> = (2..5)
            .map(|k| format!("{:.0}", tr.late_sum[k] / tr.departures[k].max(1) as f64))
            .collect();
        println!(
            "by type (bus, tram, train): started {:?}, not routed {:?}, departures {:?}, left {} s late on average, at most {:?} s; now {} trains",
            &tr.started_by[2..],
            &tr.failed_by[2..],
            &tr.departures[2..],
            late.join(", "),
            tr.late_max[2..]
                .iter()
                .map(|x| x.round())
                .collect::<Vec<_>>(),
            s.trains
        );
    }
    if engine.bikes.is_some() {
        println!(
            "bikes: {} trips started, {} arrived, {} removed, {:.0} km ridden; now {} riding",
            s.bike_departed, s.bike_arrived, s.bike_removed, s.bike_km, s.bikes
        );
    }
    // Level crossings (M8b): how often and how long the barriers were down.
    let closures: u32 = engine.crossing_closures.iter().sum();
    if closures > 0 {
        let seconds: f64 = engine.crossing_seconds.iter().sum();
        let used = engine.crossing_closures.iter().filter(|&&n| n > 0).count();
        println!(
            "level crossings: {} in the network, {used} closed for trains, {closures} closures of {:.0} s on average",
            engine.net.crossings.len(),
            seconds / closures as f64
        );
        let mut busiest: Vec<usize> = (0..engine.crossing_closures.len()).collect();
        busiest.sort_by(|&a, &b| engine.crossing_seconds[b].total_cmp(&engine.crossing_seconds[a]));
        for &c in busiest.iter().take(8) {
            let n = engine.crossing_closures[c];
            if n == 0 {
                break;
            }
            let j = engine.net.crossings[c] as usize;
            let (x, z) = (
                engine.net.d.junction_pos[2 * j],
                engine.net.d.junction_pos[2 * j + 1],
            );
            println!(
                "  crossing at junction {j} ({x:.0}, {z:.0}): {n} closures, {:.0} s on average",
                engine.crossing_seconds[c] / n as f64
            );
        }
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
    if tram_holdups {
        // By lane, the tram-hours stood still and the main reasons.
        let mut by_lane: HashMap<u32, (f32, Vec<(Holdup, f32)>)> = HashMap::new();
        let mut by_kind: HashMap<Holdup, f32> = HashMap::new();
        for (&(lane, why), &secs) in &held {
            let e = by_lane.entry(lane).or_default();
            e.0 += secs;
            e.1.push((why, secs));
            *by_kind.entry(why).or_default() += secs;
        }
        let mut kinds: Vec<_> = by_kind.into_iter().collect();
        kinds.sort_by(|a, b| b.1.total_cmp(&a.1));
        let parts: Vec<String> = kinds
            .iter()
            .map(|(k, s)| format!("{k:?} {:.1}", s / 3600.0))
            .collect();
        println!("trams standing off their stops (h): {}", parts.join(", "));
        if let Some(tr) = &engine.transit {
            println!(
                "late on average: buses {:.0} s, trams {:.0} s; trips started {:?}, failed {:?}",
                tr.late_sum[vtype::BUS as usize] / tr.departures[vtype::BUS as usize].max(1) as f64,
                tr.late_sum[vtype::TRAM as usize]
                    / tr.departures[vtype::TRAM as usize].max(1) as f64,
                tr.started_by,
                tr.failed_by
            );
        }
        let mut lanes: Vec<_> = by_lane.into_iter().collect();
        lanes.sort_by(|a, b| b.1.0.total_cmp(&a.1.0));
        for (lane, (secs, mut whys)) in lanes.into_iter().take(30) {
            whys.sort_by(|a, b| b.1.total_cmp(&a.1));
            let d = &engine.net.d;
            let edge = d.lane_edge[lane as usize] as usize;
            let shape = d.lane_shape_offsets[lane as usize + 1] as usize - 1;
            let parts: Vec<String> = whys
                .iter()
                .take(3)
                .map(|(k, s)| format!("{k:?} {:.1}", s / 3600.0))
                .collect();
            println!(
                "  lane {lane} (edge {edge} to junction {}) at ({:.0}, {:.0}): {:.1} h; {}",
                d.edge_to[edge],
                d.lane_shape[shape * 3],
                d.lane_shape[shape * 3 + 1],
                secs / 3600.0,
                parts.join(", ")
            );
        }
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
