//! Simulate a whole weekday and record how many vehicles drove onto each road in each hour,
//! for comparison with traffic counts (pipeline/validate.py).
//!
//!   gunzip -k web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
//!   cargo run --release --example day -- web/public/data <out_dir>
//!
//! Writes `<out_dir>/edge_counts.bin` (u32 edge count, then for each hour of the day from 0
//! to 23 the vehicles that drove onto each edge, u32 little-endian),
//! `<out_dir>/edge_speeds.bin` (u32 edge count, then for each hour the mean speed on each
//! edge as a share of its limit, 0-254, or 255 without traffic) and `<out_dir>/day.json`
//! (traffic statistics per hour).

use std::time::Instant;

use zg_sim::engine::{DT, Engine};
use zg_sim::network::Network;
use zg_sim::transit::Transit;

#[path = "run.rs"]
#[allow(dead_code)]
mod run;

/// The simulated day runs from 3:00 to 3:00, starting on empty roads at the quietest hour.
const START_HOUR: usize = 3;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = args.get(1).map(String::as_str).unwrap_or("web/public/data");
    let out = args.get(2).map(String::as_str).unwrap_or("day");
    std::fs::create_dir_all(out).expect("output directory");

    let net = Network::build(run::load(&format!("{root}/network"))).expect("network");
    let demand = run::demand_for(&net, &format!("{root}/demand"), 0.0);
    let mut engine = Engine::new(net, 1);
    match run::load_transit(&format!("{root}/transit")) {
        Some(data) if data.consistent(engine.net.edge_count()) => {
            engine.transit = Some(Transit::new(data));
        }
        _ => println!("transit: none"),
    }
    engine.demand = Some(demand);
    engine.demand_scale = run::demand_scale();
    engine.set_time((START_HOUR * 3600) as f64);

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
        let s0 = engine.stats.clone();
        let (mut running, mut outside, mut speed, mut stopped, mut samples) = (0, 0, 0.0, 0, 0);
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
        let s = &engine.stats;
        let trips = s.trip_count - s0.trip_count;
        let line = format!(
            "{{\"hour\": {hour}, \"running\": {:.0}, \"outside\": {:.0}, \"stopped\": {:.0}, \
             \"meanSpeedKmh\": {:.1}, \"departed\": {}, \"arrived\": {}, \"removed\": {}, \
             \"noRoute\": {}, \"notInserted\": {}, \"tripMinutes\": {:.1}, \"tripKm\": {:.2}}}",
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
    let mut bytes = Vec::with_capacity(4 + 24 * n);
    bytes.extend((n as u32).to_le_bytes());
    for speeds in &speeds_by_hour {
        bytes.extend(speeds);
    }
    std::fs::write(format!("{out}/edge_speeds.bin"), bytes).expect("write speeds");
    let s = &engine.stats;
    let summary = format!(
        "{{\"startHour\": {START_HOUR}, \"seconds\": {:.0}, \"departed\": {}, \"arrived\": {}, \
         \"removed\": {}, \"noRoute\": {}, \"notInserted\": {}, \"removedBecause\": {:?}, \
         \"hours\": [\n  {}\n]}}\n",
        started.elapsed().as_secs_f64(),
        s.departed,
        s.arrived,
        s.teleported,
        s.no_route,
        s.insert_failed,
        s.teleport_reasons,
        hours.join(",\n  "),
    );
    std::fs::write(format!("{out}/day.json"), summary).expect("write summary");
}
