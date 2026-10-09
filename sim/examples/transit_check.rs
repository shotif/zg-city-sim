//! Check that every leg between consecutive stops of the timetable can be driven.
//!
//!   cargo run --release --example transit_check -- web/public/data

use std::collections::HashMap;

use zg_sim::network::{Network, vclass};
use zg_sim::router::Router;

#[path = "run.rs"]
#[allow(dead_code)]
mod run;

fn main() {
    let root = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "web/public/data".into());
    let net = Network::build(run::load(&format!("{root}/network"))).expect("network");
    let data = run::load_transit(&format!("{root}/transit")).expect("transit");
    let tt: Vec<f32> = (0..net.edge_count())
        .map(|e| net.edge_length[e] / net.edge_speed[e].max(1.0))
        .collect();
    let mut router = Router::new(net.edge_count());
    let mut cache: HashMap<(u32, u32, u16), bool> = HashMap::new();
    let mut failed: HashMap<(u32, u32, u16), u32> = HashMap::new();
    let mut trips_ok = [0u32; 5];
    let mut trips_cut = [0u32; 5];
    for trip in 0..data.trips() as u32 {
        let vtype = data.trip_type[trip as usize];
        let class = match vtype {
            3 => vclass::TRAM,
            4 => vclass::RAIL,
            _ => vclass::BUS,
        };
        let stops = data.stops(trip);
        let mut ok = true;
        for i in stops.start..stops.end - 1 {
            let (a, b) = (data.stop_edge[i], data.stop_edge[i + 1]);
            if a == b {
                continue;
            }
            let good = *cache
                .entry((a, b, class))
                .or_insert_with(|| router.route(&net, &tt, a, b, class).is_some());
            if !good {
                *failed.entry((a, b, class)).or_default() += 1;
                ok = false;
            }
        }
        if ok {
            trips_ok[vtype as usize] += 1;
        } else {
            trips_cut[vtype as usize] += 1;
        }
    }
    println!(
        "trams: {} trips fine, {} with a missing leg",
        trips_ok[3], trips_cut[3]
    );
    println!(
        "buses: {} trips fine, {} with a missing leg",
        trips_ok[2], trips_cut[2]
    );
    println!(
        "trains: {} trips fine, {} with a missing leg",
        trips_ok[4], trips_cut[4]
    );
    let mut worst: Vec<_> = failed.into_iter().collect();
    worst.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    for ((a, b, class), n) in worst.iter().take(25) {
        let (ax, az) = net.edge_mid[*a as usize];
        let (bx, bz) = net.edge_mid[*b as usize];
        let mode = match *class {
            vclass::TRAM => "tram",
            vclass::RAIL => "train",
            _ => "bus",
        };
        println!("  {mode} edge {a} ({ax:.0}, {az:.0}) -> edge {b} ({bx:.0}, {bz:.0}): {n} trips");
    }
}
