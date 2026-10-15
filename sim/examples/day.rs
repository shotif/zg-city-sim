//! Simulate a whole weekday and record how many vehicles drove onto each road in each hour,
//! for comparison with traffic counts (pipeline/validate.py).
//!
//!   gunzip -kf web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
//!   cargo run --release --example day -- web/public/data <out_dir>
//!
//! Writes `<out_dir>/edge_counts.bin` (u32 edge count, then for each hour of the day from 0
//! to 23 the vehicles that drove onto each edge, u32 little-endian),
//! `<out_dir>/edge_speeds.bin` (u32 edge count, then for each hour the mean speed on each
//! edge as a share of its limit, 0-254, or 255 without traffic), `<out_dir>/junction_delay.bin`
//! (u32 junction count, u32 kinds of holdup, then for each junction the vehicle-seconds queued
//! there over the day by why the queue's front vehicle waited, f32, kinds as `delayKinds` in
//! day.json; then the same charged to the junction downstream each queue waited on in the
//! end), `<out_dir>/select_link.csv` with `SELECT_EDGES=12,34` (where the cars and lorries
//! driving onto those edges come from and go to: edge, town of origin, town of destination,
//! vehicles; towns as `demandTown`, beyond the map 40000 plus the gateway's index in the
//! demand's list (65534 if not known), 65535 unknown; M13),
//! `<out_dir>/town_commutes.bin` (commutes drawn from the demand by the town of home
//! and of work, against the census: `run::write_town_commutes`, M13) and `<out_dir>/day.json`
//! (traffic statistics per hour, with the vehicle-hours queued at junctions by holdup).
//!
//! `FREQUENCY=2` runs every tram and bus line twice as often, `PRIORITY=all` gives trams and
//! buses signal priority (see `run.rs`).
//! `SEED=2` runs the same day with another seed; `NO_PHASE_SKIP=1` runs actuated signals
//! through every phase of their cycle; `NO_REROUTE=1` keeps drivers on the route they chose
//! at the start, however the roads ahead jam. `WATCH_JUNCTIONS=j1,j2` with `WATCH_FROM=13`
//! prints every simulated minute from 13:00 the stopped front vehicle of each queue into
//! those junctions and why it waits (as the `run` example does), to watch a day that locks up.

use std::time::Instant;

use zg_sim::engine::{DT, Engine, Holdup, trip};
use zg_sim::network::{NONE, Network};
use zg_sim::transit::Transit;
use zg_sim::vtype;

#[path = "run.rs"]
#[allow(dead_code)]
mod run;

/// Names of the holdups in `Holdup` order, for day.json.
const HOLDUPS: [&str; Holdup::COUNT] = [
    "inJunction",
    "queued",
    "wrongLane",
    "signal",
    "exitFull",
    "yielding",
    "stopSign",
    "blockedAhead",
    "other",
    "slowRoad",
    "standingMidRoad",
    "pedestrians",
];

/// The simulated day runs from 3:00 to 3:00, starting on empty roads at the quietest hour.
const START_HOUR: usize = 3;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = args.get(1).map(String::as_str).unwrap_or("web/public/data");
    let out = args.get(2).map(String::as_str).unwrap_or("day");
    std::fs::create_dir_all(out).expect("output directory");

    let net = Network::build(run::load(&format!("{root}/network"))).expect("network");
    let demand = run::demand_for(&net, &format!("{root}/demand"), 0.0);
    let towns = run::load_towns(&format!("{root}/demand"));
    if !towns.is_empty() {
        run::write_town_commutes(
            &demand,
            &towns,
            2_000_000,
            &format!("{out}/town_commutes.bin"),
        );
    }
    // SEED: another run of the same day (runs differ under congestion).
    let seed = std::env::var("SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let mut engine = Engine::new(net, seed);
    match run::load_transit(&format!("{root}/transit")) {
        Some(data) if data.consistent(engine.net.edge_count()) => {
            engine.transit = Some(Transit::new(data));
        }
        _ => println!("transit: none"),
    }
    run::attach_pedestrians(&mut engine, &format!("{root}/pedestrians"));
    run::attach_bikes(&mut engine, &format!("{root}/cycling"));
    run::attach_hierarchy(&mut engine);
    engine.demand = Some(demand);
    engine.demand_scale = run::demand_scale(&format!("{root}/demand"));
    println!("demand scale: {}", engine.demand_scale);
    // Public transport's riders (M9d); FREQUENCY=2: every tram and bus line that many times
    // as often, and the car trips that moves.
    let districts = run::load_districts(&format!("{root}/demand"));
    engine.start_riders((!districts.is_empty()).then_some(&districts[..]));
    // PRIORITY=all (or routes): signal priority for trams and buses (M10b).
    let mut edits = Vec::new();
    if let Some(factor) = std::env::var("FREQUENCY")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
    {
        edits.extend(run::frequency_edits(&engine, factor));
        println!("frequency: {} lines {factor} times as often", edits.len());
    }
    if let Ok(which) = std::env::var("PRIORITY") {
        let priority = run::priority_edits(&mut engine, &which);
        println!("priority for trams and buses at {} signals", priority.len());
        edits.extend(priority);
    }
    if !edits.is_empty() {
        let applied = engine.set_edits(&edits);
        println!("edits: {applied} of {} applied", edits.len());
    }
    engine.set_time((START_HOUR * 3600) as f64);
    // Where junctions lose time (M7a).
    engine.track_delay = true;
    engine.skip_phases = std::env::var("NO_PHASE_SKIP").is_err();
    engine.reroute = std::env::var("NO_REROUTE").is_err();
    let delay_total = |e: &Engine| -> [f64; Holdup::COUNT] {
        let mut sum = [0f64; Holdup::COUNT];
        for row in &e.delay {
            for (k, v) in row.iter().enumerate() {
                sum[k] += *v as f64;
            }
        }
        sum
    };
    let mut delay_hours = Vec::new();

    let n = engine.net.edge_count();
    // SELECT_EDGES: where the traffic on those edges comes from and goes to (M13).
    let select: Vec<u32> = std::env::var("SELECT_EDGES")
        .ok()
        .map(|v| v.split(',').filter_map(|e| e.trim().parse().ok()).collect())
        .unwrap_or_default();
    let (edge_towns, edge_gateways) = if select.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        (
            run::load_edge_towns(&format!("{root}/demand"), n),
            run::load_gateway_edges(&format!("{root}/demand"), n),
        )
    };
    let mut seen = std::collections::HashSet::new();
    let mut select_counts: std::collections::HashMap<(u32, u16, u16), u32> =
        std::collections::HashMap::new();
    let mut by_hour = vec![Vec::new(); 24];
    let mut speeds_by_hour = vec![Vec::new(); 24];
    // WATCH_JUNCTIONS=j1,j2 and WATCH_FROM=13: from that hour of the day, every simulated
    // minute, the stopped front vehicle of each queue into those junctions (as in `run`).
    let watch: Vec<u32> = std::env::var("WATCH_JUNCTIONS")
        .map(|v| v.split(',').filter_map(|s| s.trim().parse().ok()).collect())
        .unwrap_or_default();
    let watch_from: usize = std::env::var("WATCH_FROM")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(START_HOUR);
    let mut speed_sum = vec![0u32; n];
    let mut speed_n = vec![0u8; n];
    let mut hours = Vec::new();
    let steps = (3600.0 / DT) as u32;
    let started = Instant::now();
    for k in 0..24 {
        let hour = (START_HOUR + k) % 24;
        let entered = engine.edge_entered.clone();
        let delay0 = delay_total(&engine);
        let s0 = engine.stats.clone();
        let (mut running, mut outside, mut speed, mut stopped, mut samples) = (0, 0, 0.0, 0, 0);
        let mut bikes = 0u64;
        speed_sum.fill(0);
        speed_n.fill(0);
        let watching = !watch.is_empty() && k >= (watch_from + 24 - START_HOUR) % 24;
        for i in 0..steps {
            engine.step();
            if watching && (i + 1) % (60.0 / DT) as u32 == 0 {
                let minute = (i + 1) / (60.0 / DT) as u32;
                println!("{hour:02}:{minute:02}");
                run::print_watch(&engine, &watch);
            }
            for &e in &select {
                for lane in engine.net.edge_lanes(e) {
                    for &v in engine.vehicles_on(lane) {
                        let veh = &engine.vehs[v as usize];
                        if veh.vtype > vtype::TRUCK || !seen.insert((e, v, veh.serial)) {
                            continue;
                        }
                        let town = |edge: u32, beyond: bool| {
                            if beyond {
                                match edge_gateways.get(edge as usize) {
                                    Some(&g) if g < 20_000 => 40_000 + g,
                                    _ => u16::MAX - 1,
                                }
                            } else {
                                edge_towns.get(edge as usize).copied().unwrap_or(u16::MAX)
                            }
                        };
                        let from = town(veh.origin, veh.trip_flags & trip::ENTER != 0);
                        let dest = *veh.route.last().unwrap_or(&NONE);
                        let to = town(dest, veh.trip_flags & trip::EXIT != 0);
                        *select_counts.entry((e, from, to)).or_default() += 1;
                    }
                }
            }
            // Speeds every 10 minutes (the engine averages them over its last minute).
            if i % (600.0 / DT) as u32 == (600.0 / DT) as u32 - 1 {
                for (e, &r) in engine.edge_speed_ratio.iter().enumerate() {
                    if r < 255 {
                        speed_sum[e] += r as u32;
                        speed_n[e] += 1;
                    }
                }
            }
            if i % (60.0 / DT) as u32 == 0 {
                let s = &engine.stats;
                running += s.running as u64;
                bikes += s.bikes as u64;
                outside += s.outside as u64;
                stopped += s.stopped as u64;
                speed += s.mean_speed as f64;
                samples += 1;
            }
        }
        by_hour[hour] = engine
            .edge_entered
            .iter()
            .zip(&entered)
            .map(|(a, b)| a - b)
            .collect::<Vec<u32>>();
        speeds_by_hour[hour] = speed_sum
            .iter()
            .zip(&speed_n)
            .map(|(&sum, &k)| if k > 0 { (sum / k as u32) as u8 } else { 255 })
            .collect::<Vec<u8>>();
        // Vehicle-hours queued at junctions this hour, by why each queue waited.
        let delay: Vec<String> = delay_total(&engine)
            .iter()
            .zip(&delay0)
            .map(|(a, b)| format!("{:.1}", (a - b) / 3600.0))
            .collect();
        delay_hours.push(format!("[{}]", delay.join(", ")));
        let s = &engine.stats;
        let trips = s.trip_count - s0.trip_count;
        let line = format!(
            "{{\"hour\": {hour}, \"running\": {:.0}, \"outside\": {:.0}, \"stopped\": {:.0}, \
             \"meanSpeedKmh\": {:.1}, \"departed\": {}, \"arrived\": {}, \"removed\": {}, \
             \"noRoute\": {}, \"notInserted\": {}, \"tripMinutes\": {:.1}, \"tripKm\": {:.2}, \
             \"bikes\": {:.0}, \"bikesDeparted\": {}, \"bikesArrived\": {}, \"bikesRemoved\": {}}}",
            running as f64 / samples as f64,
            outside as f64 / samples as f64,
            stopped as f64 / samples as f64,
            speed / samples as f64 * 3.6,
            s.departed - s0.departed,
            s.arrived - s0.arrived,
            s.teleported - s0.teleported,
            s.no_route - s0.no_route,
            s.insert_failed - s0.insert_failed,
            (s.trip_time_sum - s0.trip_time_sum) / trips.max(1) as f64 / 60.0,
            (s.trip_km_sum - s0.trip_km_sum) / trips.max(1) as f64,
            bikes as f64 / samples as f64,
            s.bike_departed - s0.bike_departed,
            s.bike_arrived - s0.bike_arrived,
            s.bike_removed - s0.bike_removed,
        );
        println!("{line}  ({:.0} s)", started.elapsed().as_secs_f64());
        hours.push(line);
    }

    let mut bytes = Vec::with_capacity(4 + 24 * n * 4);
    bytes.extend((n as u32).to_le_bytes());
    for counts in &by_hour {
        for c in counts {
            bytes.extend(c.to_le_bytes());
        }
    }
    std::fs::write(format!("{out}/edge_counts.bin"), bytes).expect("write counts");
    // Bikes over the whole day per edge (M8d): u32 edge count, then u32 per edge.
    let mut bytes = Vec::with_capacity(4 + engine.edge_bikes.len() * 4);
    bytes.extend((engine.edge_bikes.len() as u32).to_le_bytes());
    for &n in &engine.edge_bikes {
        bytes.extend(n.to_le_bytes());
    }
    std::fs::write(format!("{out}/edge_bikes.bin"), bytes).expect("write bikes");
    let mut bytes = Vec::with_capacity(4 + 24 * n);
    bytes.extend((n as u32).to_le_bytes());
    for speeds in &speeds_by_hour {
        bytes.extend(speeds);
    }
    std::fs::write(format!("{out}/edge_speeds.bin"), bytes).expect("write speeds");
    // Vehicle-seconds queued at each junction over the day, by holdup (f32 each).
    let junctions = engine.net.d.junction_link_count.len();
    let mut bytes = Vec::with_capacity(4 + junctions * Holdup::COUNT * 4);
    bytes.extend((junctions as u32).to_le_bytes());
    bytes.extend((Holdup::COUNT as u32).to_le_bytes());
    for table in [&engine.delay, &engine.delay_root] {
        for j in 0..junctions {
            let row = table.get(j).copied().unwrap_or([0.0; Holdup::COUNT]);
            for v in row {
                bytes.extend(v.to_le_bytes());
            }
        }
    }
    std::fs::write(format!("{out}/junction_delay.bin"), bytes).expect("write delay");
    if !select.is_empty() {
        let mut rows: Vec<_> = select_counts.into_iter().collect();
        rows.sort();
        let csv: String = rows
            .iter()
            .map(|((e, from, to), k)| format!("{e},{from},{to},{k}\n"))
            .collect();
        std::fs::write(
            format!("{out}/select_link.csv"),
            format!("edge,from,to,vehicles\n{csv}"),
        )
        .expect("write select link");
    }
    let s = &engine.stats;
    // The edges vehicles were most often removed from, as [edge, vehicles].
    let mut places: Vec<(u32, u32)> = s.removed_at.iter().map(|(&e, &n)| (n, e)).collect();
    places.sort_unstable_by(|a, b| b.cmp(a));
    let removed_at: Vec<String> = places
        .iter()
        .take(25)
        .map(|(n, e)| format!("[{e}, {n}]"))
        .collect();
    // Buses, trams and trains (engine types 2-4): runs started and not routed, departures
    // from stops, and how late they left them (mean and most, s).
    let transit = engine.transit.as_ref().map_or("null".to_string(), |tr| {
        let k = 2..5;
        format!(
            "{{\"types\": [\"bus\", \"tram\", \"train\"], \"started\": {:?}, \"notRouted\": {:?}, \
             \"departures\": {:?}, \"lateMean\": {:?}, \"lateMax\": {:?}}}",
            &tr.started_by[k.clone()],
            &tr.failed_by[k.clone()],
            &tr.departures[k.clone()],
            k.clone()
                .map(|i| (tr.late_sum[i] / tr.departures[i].max(1) as f64).round())
                .collect::<Vec<_>>(),
            k.map(|i| tr.late_max[i].round()).collect::<Vec<_>>(),
        )
    });
    // Level crossings (M8b): per crossing closed for trains, [junction, closures, seconds].
    let crossings: Vec<String> = (0..engine.crossing_closures.len())
        .filter(|&c| engine.crossing_closures[c] > 0)
        .map(|c| {
            format!(
                "[{}, {}, {:.0}]",
                engine.net.crossings[c], engine.crossing_closures[c], engine.crossing_seconds[c]
            )
        })
        .collect();
    let riders = engine.riders.as_ref().map_or("null".to_string(), |r| {
        let m = &r.summary;
        format!(
            "{{\"tripsToday\": {:.0}, \"tripsNow\": {:.0}, \"carMoved\": {:.0}}}",
            m.trips_today, m.trips_now, m.car_moved
        )
    });
    let summary = format!(
        "{{\"startHour\": {START_HOUR}, \"demandScale\": {}, \"riders\": {riders}, \"seconds\": {:.0}, \"departed\": {}, \"arrived\": {}, \
         \"removed\": {}, \"noRoute\": {}, \"notInserted\": {}, \"enRouteReroutes\": {}, \"rounds\": {}, \"removedBecause\": {:?}, \
         \"removedAt\": [{}], \"transit\": {transit}, \"bikes\": {{\"departed\": {}, \"arrived\": {}, \"removed\": {}, \"km\": {:.0}}}, \"levelCrossings\": {}, \"crossingClosures\": [{}], \"delayKinds\": {:?}, \"delayHours\": [{}], \"hours\": [\n  {}\n]}}\n",
        engine.demand_scale,
        started.elapsed().as_secs_f64(),
        s.departed,
        s.arrived,
        s.teleported,
        s.no_route,
        s.insert_failed,
        s.en_route_reroutes,
        s.rounds,
        s.teleport_reasons,
        removed_at.join(", "),
        s.bike_departed,
        s.bike_arrived,
        s.bike_removed,
        s.bike_km,
        engine.net.crossings.len(),
        crossings.join(", "),
        HOLDUPS,
        delay_hours.join(", "),
        hours.join(",\n  "),
    );
    std::fs::write(format!("{out}/day.json"), summary).expect("write summary");
}
