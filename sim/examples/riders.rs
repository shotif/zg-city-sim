//! Public transport's riders today (M9d): journeys between zones from the timetable, the
//! split of motorised trips, and public transport's constant calibrated to the Transport
//! Master Plan's 45.8 % of motorised trips within the City.
//!
//!   gunzip -kf web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
//!   cargo run --release --example riders -- web/public/data
//!
//! `FREQUENCY=2` also works the riders out with every tram and bus line twice as often.

use std::time::Instant;

use zg_sim::engine::Engine;
use zg_sim::network::Network;
use zg_sim::riders::ASC;
use zg_sim::transit::Transit;
use zg_sim::vtype;

#[path = "run.rs"]
#[allow(dead_code)]
mod run;

/// Share of motorised trips within the City by public transport (Transport Master Plan,
/// modelled split with walking left out: 44.1 % of 96.3 %).
const TARGET: f64 = 0.458;

fn main() {
    let root = std::env::args()
        .nth(1)
        .unwrap_or("../web/public/data".into());
    let net = Network::build(run::load(&format!("{root}/network"))).expect("network");
    let demand = run::demand_for(&net, &format!("{root}/demand"), 0.0);
    let districts = run::load_districts(&format!("{root}/demand"));
    let mut engine = Engine::new(net, 1);
    let data = run::load_transit(&format!("{root}/transit")).expect("timetable");
    engine.transit = Some(Transit::new(data));
    engine.demand = Some(demand);
    let t0 = Instant::now();
    engine.start_riders((!districts.is_empty()).then_some(&districts[..]));
    let riders = engine.riders.as_mut().expect("riders");
    println!(
        "{} zones, {} with a district; expected car trips drawn in {:.1} s",
        riders.zones.len(),
        riders.zones.district.iter().filter(|&&d| d < 17).count(),
        t0.elapsed().as_secs_f64()
    );
    let t1 = Instant::now();
    while riders.busy() {
        riders.advance();
    }
    println!(
        "journeys from every zone in {:.1} s",
        t1.elapsed().as_secs_f64()
    );
    let city = |d: u8| d < 17;
    for (name, within) in [("City", &city as &dyn Fn(u8) -> bool), ("all", &|_| true)] {
        let [with, without, car, pt] = riders.reach_today(within).unwrap();
        println!(
            "{name}: {with:.0} car trips a day between zones with public transport, {without:.0} without; generalised time by car {car:.1} min, by public transport {pt:.1} min"
        );
    }
    for asc in [-1.0, -0.5, 0.0, 0.5, 1.0] {
        println!(
            "ASC {asc:+.1}: {:.1} % within the City, {:.1} % in all",
            100.0 * riders.share_today(asc, city).unwrap(),
            100.0 * riders.share_today(asc, |_| true).unwrap()
        );
    }
    let (mut lo, mut hi) = (-5.0f32, 5.0f32);
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        if riders.share_today(mid, city).unwrap() < TARGET {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    println!(
        "ASC for {:.1} % within the City: {lo:.3} (now {ASC})",
        100.0 * TARGET
    );
    let tr = engine.transit.as_ref().unwrap();
    let mut mode_of = vec![u8::MAX; 1 << 16];
    for t in 0..tr.timetabled {
        mode_of[tr.data.trip_route[t] as usize] = tr.data.trip_type[t];
    }
    let summary = &engine.riders.as_ref().unwrap().summary;
    let by_mode = |list: &[f64], mode: u8| -> f64 {
        list.iter()
            .enumerate()
            .filter(|(r, _)| mode_of[*r] == mode)
            .map(|(_, b)| b)
            .sum()
    };
    println!(
        "today: {:.0} trips by public transport a weekday; boardings: tram {:.0}, bus {:.0}, train {:.0}",
        summary.trips_today,
        by_mode(&summary.boardings_today, vtype::TRAM),
        by_mode(&summary.boardings_today, vtype::BUS),
        by_mode(&summary.boardings_today, vtype::TRAIN),
    );

    if let Some(factor) = std::env::var("FREQUENCY")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
    {
        let edits = run::frequency_edits(&engine, factor);
        let t2 = Instant::now();
        engine.set_edits(&edits);
        let riders = engine.riders.as_mut().unwrap();
        while riders.busy() {
            riders.advance();
        }
        let s = &riders.summary;
        println!(
            "every tram and bus line {factor} times as often ({:.1} s): {:.0} trips by public transport ({:+.1} %), {:.0} car trips moved; boardings: tram {:.0}, bus {:.0}",
            t2.elapsed().as_secs_f64(),
            s.trips_now,
            100.0 * (s.trips_now / s.trips_today - 1.0),
            s.car_moved,
            by_mode(&s.boardings_now, vtype::TRAM),
            by_mode(&s.boardings_now, vtype::BUS),
        );
        // Tram lines' boardings, today and now.
        let trams: Vec<String> = (0..s.boardings_today.len())
            .filter(|&r| mode_of[r] == vtype::TRAM)
            .map(|r| {
                format!(
                    "{}: {:.0} -> {:.0}",
                    r,
                    s.boardings_today[r],
                    s.boardings_now.get(r).copied().unwrap_or(0.0)
                )
            })
            .collect();
        println!("tram routes' boardings: {}", trams.join(", "));
    }
}
