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
//! end) and `<out_dir>/day.json` (traffic statistics per hour, with the vehicle-hours
//! queued at junctions by holdup).
//!
//! `FREQUENCY=2` runs every tram and bus line twice as often, `PRIORITY=all` gives trams and
//! buses signal priority (see `run.rs`).
//! `SEED=2` runs the same day with another seed; `NO_PHASE_SKIP=1` runs actuated signals
//! through every phase of their cycle; `NO_REROUTE=1` keeps drivers on the route they chose
//! at the start, however the roads ahead jam.

use std::time::Instant;

use zg_sim::engine::{DT, Engine, Holdup};
use zg_sim::network::Network;
use zg_sim::transit::Transit;

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
    let mut by_hour = vec![Vec::new(); 24];
    let mut speeds_by_hour = vec![Vec::new(); 24];
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
        for i in 0..steps {
            engine.step();
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
         \"removed\": {}, \"noRoute\": {}, \"notInserted\": {}, \"enRouteReroutes\": {}, \"removedBecause\": {:?}, \
         \"removedAt\": [{}], \"transit\": {transit}, \"bikes\": {{\"departed\": {}, \"arrived\": {}, \"removed\": {}, \"km\": {:.0}}}, \"levelCrossings\": {}, \"crossingClosures\": [{}], \"delayKinds\": {:?}, \"delayHours\": [{}], \"hours\": [\n  {}\n]}}\n",
        engine.demand_scale,
        started.elapsed().as_secs_f64(),
        s.departed,
        s.arrived,
        s.teleported,
        s.no_route,
        s.insert_failed,
        s.en_route_reroutes,
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
