//! Run the engine natively on the network the pipeline exported, reporting traffic and
//! why vehicles are held up.
//!
//!   gunzip -k web/public/data/network/net.bin.gz
//!   cargo run --release --example run -- web/public/data/network [start_hour] [minutes] [daily_trips]

use std::collections::HashMap;
use std::time::Instant;

use zg_sim::demand::Demand;
use zg_sim::engine::{DT, Engine, Holdup};
use zg_sim::network::{Network, NetworkData};

/// Read `net.json` (the packed index) and the uncompressed `net.bin` from `dir`.
fn load(dir: &str) -> NetworkData {
    let index = std::fs::read_to_string(format!("{dir}/net.json")).expect("net.json");
    let blob = std::fs::read(format!("{dir}/net.bin")).expect("net.bin (gunzip -k net.bin.gz)");
    let mut data = NetworkData::default();
    let mut decoded: HashMap<String, (String, usize, usize)> = HashMap::new();
    // The index is simple enough to scan: "name": {"type": "u32", "offset": N, "length": N}
    let arrays = &index[index.find("\"arrays\"").unwrap()..];
    for part in arrays.split("}, ").chain(std::iter::once("")) {
        let Some(q) = part.rfind("{\"type\"") else {
            continue;
        };
        let name_end = part[..q].rfind("\":").unwrap();
        let name_start = part[..name_end].rfind('"').unwrap() + 1;
        let name = &part[name_start..name_end];
        let field = |key: &str| {
            let i = part.find(&format!("\"{key}\": ")).unwrap() + key.len() + 4;
            let rest = &part[i..];
            let end = rest.find([',', '}']).unwrap_or(rest.len());
            rest[..end].trim_matches('"').to_string()
        };
        decoded.insert(
            name.to_string(),
            (
                field("type"),
                field("offset").parse().unwrap(),
                field("length").parse().unwrap(),
            ),
        );
    }
    let size = |t: &str| match t {
        "u8" | "i8" => 1,
        "u16" | "i16" => 2,
        _ => 4,
    };
    for (name, (ty, offset, length)) in &decoded {
        let es = size(ty);
        if let Some(bytes) = data.alloc_array(name, *length, es) {
            bytes.copy_from_slice(&blob[*offset..*offset + length * es]);
        }
    }
    // Decode lane shapes like the app: int32 cm origin, int16 cm steps, int16 cm elevation.
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args
        .get(1)
        .map(String::as_str)
        .unwrap_or("web/public/data/network");
    let start: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(7.0);
    let minutes: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let trips: f64 = args
        .get(4)
        .and_then(|s| s.parse().ok())
        .unwrap_or(500_000.0);

    let t0 = Instant::now();
    let net = Network::build(load(dir)).expect("consistent network");
    println!(
        "network: {} lanes, {} links ({:.0} ms)",
        net.lane_count(),
        net.d.link_from.len(),
        t0.elapsed().as_secs_f64() * 1e3
    );
    let demand = Demand::from_network(&net, trips);
    let t0 = Instant::now();
    let mut engine = Engine::new(net, 1);
    println!(
        "engine with routing landmarks ready in {:.0} ms",
        t0.elapsed().as_secs_f64() * 1e3
    );
    engine.demand = Some(demand);
    engine.set_time(start * 3600.0);

    let steps_per_minute = (60.0 / DT) as u32;
    let mut total = 0.0;
    for m in 1..=minutes {
        let t = Instant::now();
        for _ in 0..steps_per_minute {
            engine.step();
        }
        total += t.elapsed().as_secs_f64();
        if m % 5 == 0 || m == minutes {
            let s = &engine.stats;
            let h = engine.time / 3600.0;
            println!(
                "{:02}:{:02} running {:6} departed {:7} arrived {:7} removed {:5} no-route {:4} mean {:5.1} km/h stopped {:5} trip {:4.1} min {:4.1} km | {:.2} ms/step",
                h as u32 % 24,
                (engine.time / 60.0) as u32 % 60,
                s.running,
                s.departed,
                s.arrived,
                s.teleported,
                s.no_route,
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
        println!("time by phase: {}", parts.join(", "));
    }
}
