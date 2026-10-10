//! Before and after: one network simulated through the morning peak, for comparing a
//! project's network (M4c) with today's. `python -m pipeline.projects compare` summarises a
//! run of today's network and a run of the project's.
//!
//!   gunzip -kf web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
//!   cargo run --release --example compare -- web/public/data today.json [from_hour=6] [hours=4] [seed=1]
//!
//! (and the same with `web/public/data/projects/<id>`). The run starts an hour before
//! `from_hour` on empty roads and is measured from it: delay against the speed limit,
//! kilometres driven, trips and their mean time, per hour; at the end of each hour, travel
//! times by car between the City's districts and the four largest towns around it (the
//! places of web/src/edit/compare.ts); and the vehicles that drove onto each edge while
//! measured.

use zg_sim::engine::{DT, Engine, stat};
use zg_sim::network::{Network, vclass};
use zg_sim::transit::Transit;

#[path = "run.rs"]
#[allow(dead_code)]
mod run;

/// Places travel times are compared between (scene x, z), as in web/src/edit/compare.ts.
const PLACES: [(&str, f32, f32); 21] = [
    ("Brezovica", -6770.0, 12690.0),
    ("Črnomerec", -3041.0, -1127.0),
    ("Donja Dubrava", 6395.0, -805.0),
    ("Donji grad", 291.0, 380.0),
    ("Gornja Dubrava", 6075.0, -3729.0),
    ("Gornji grad – Medveščak", -113.0, -1104.0),
    ("Maksimir", 2295.0, -1777.0),
    ("Novi Zagreb – istok", 1526.0, 4983.0),
    ("Novi Zagreb – zapad", -2650.0, 5604.0),
    ("Peščenica – Žitnjak", 4362.0, 1651.0),
    ("Podsljeme", 722.0, -5725.0),
    ("Podsused – Vrapče", -7560.0, -967.0),
    ("Sesvete", 11910.0, -4088.0),
    ("Stenjevec", -6004.0, 850.0),
    ("Trešnjevka – jug", -3967.0, 2532.0),
    ("Trešnjevka – sjever", -2749.0, 1331.0),
    ("Trnje", 530.0, 1853.0),
    ("Velika Gorica", 7286.0, 10882.0),
    ("Samobor", -20701.0, 1177.0),
    ("Zaprešić", -13185.0, -4977.0),
    ("Dugo Selo", 20343.0, 1003.0),
];

fn engine_for(root: &str, seed: u64) -> Engine {
    let net = Network::build(run::load(&format!("{root}/network"))).expect("network");
    let demand = run::demand_for(&net, &format!("{root}/demand"), 0.0);
    let mut engine = Engine::new(net, seed);
    if let Some(data) = run::load_transit(&format!("{root}/transit"))
        && data.consistent(engine.net.edge_count())
    {
        engine.transit = Some(Transit::new(data));
    }
    run::attach_pedestrians(&mut engine, &format!("{root}/pedestrians"));
    run::attach_bikes(&mut engine, &format!("{root}/cycling"));
    engine.demand = Some(demand);
    engine.demand_scale = run::demand_scale(&format!("{root}/demand"));
    engine
}

/// The road cars can start on nearest each place.
fn place_edges(net: &Network) -> Vec<Option<u32>> {
    PLACES
        .iter()
        .map(|&(_, x, z)| {
            (0..net.edge_count() as u32)
                .filter(|&e| {
                    !net.is_internal_edge(e)
                        && net
                            .edge_lanes(e)
                            .any(|l| net.d.lane_allow[l as usize] & vclass::PASSENGER != 0)
                })
                .map(|e| {
                    let (ex, ez) = net.edge_mid[e as usize];
                    (((ex - x).powi(2) + (ez - z).powi(2)).sqrt(), e)
                })
                .filter(|&(d, _)| d < 600.0)
                .min_by(|a, b| a.0.total_cmp(&b.0))
                .map(|(_, e)| e)
        })
        .collect()
}

fn travel_times(engine: &mut Engine, edges: &[Option<u32>]) -> Vec<f32> {
    let mut out = Vec::new();
    for (i, a) in edges.iter().enumerate() {
        for (j, b) in edges.iter().enumerate() {
            if i == j {
                continue;
            }
            out.push(match (a, b) {
                (Some(a), Some(b)) => engine.route_time(*a, *b).unwrap_or(-1.0),
                _ => -1.0,
            });
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (root, out) = (&args[1], &args[2]);
    let from: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(6);
    let hours: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(4);
    // Another seed gives other trips: two runs of one network show the noise.
    let seed: u64 = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(1);

    let mut engine = engine_for(root, seed);
    let edges = place_edges(&engine.net);
    engine.set_time(((from - 1) * 3600) as f64);
    for _ in 0..(3600.0 / DT) as u32 {
        engine.step();
    }
    let entered = engine.edge_entered.clone();
    let mut lines = Vec::new();
    let mut last = engine.stats_array();
    for h in 0..hours {
        let s0 = (
            engine.stats.trip_count,
            engine.stats.trip_time_sum,
            engine.stats.arrived,
        );
        for _ in 0..(3600.0 / DT) as u32 {
            engine.step();
        }
        let now = engine.stats_array();
        let times = travel_times(&mut engine, &edges);
        let s = &engine.stats;
        let trips = (s.trip_count - s0.0).max(1);
        lines.push(format!(
            "{{\"hour\": {}, \"delayHours\": {:.1}, \"vehicleKm\": {:.0}, \"arrived\": {}, \
             \"tripMinutes\": {:.2}, \"running\": {}, \"travelSeconds\": [{}]}}",
            from + h,
            now[stat::DELAY_HOURS] - last[stat::DELAY_HOURS],
            now[stat::VEHICLE_KM] - last[stat::VEHICLE_KM],
            s.arrived - s0.2,
            (s.trip_time_sum - s0.1) / trips as f64 / 60.0,
            s.running,
            times
                .iter()
                .map(|t| format!("{t:.0}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
        println!("{}:00 done", from + h + 1);
        last = now;
    }
    let volumes: Vec<String> = engine
        .edge_entered
        .iter()
        .zip(&entered)
        .map(|(a, b)| (a - b).to_string())
        .collect();
    let names: Vec<String> = PLACES.iter().map(|p| format!("{:?}", p.0)).collect();
    std::fs::write(
        out,
        format!(
            "{{\"fromHour\": {from}, \"hours\": {hours}, \"demandScale\": {}, \"places\": [{}],\n  \
             \"perHour\": [\n    {}\n  ],\n  \"volumes\": [{}]\n}}\n",
            engine.demand_scale,
            names.join(", "),
            lines.join(",\n    "),
            volumes.join(",")
        ),
    )
    .expect("write the run");
}
