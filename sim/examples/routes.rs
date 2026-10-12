//! Time route searches on the exported network: random pairs of edges, with travel times
//! made slower than free flow by a fixed pattern, so the landmark bounds are as loose as
//! they are in the rush hour.
//!
//!   cargo run --release --example routes -- web/public/data/network [pairs]
//!
//! Or replay the searches a run logged (the `run` example's `ROUTE_LOG`), on the travel
//! times each ran on, timing them and checking each finds the route it found then:
//!
//!   cargo run --release --example routes -- web/public/data/network --replay /tmp/log [n]

use std::time::Instant;

use zg_sim::cch::{Cch, Metric, Query};
use zg_sim::network::{Network, vclass};
use zg_sim::router::{Landmarks, Router, purpose, route_hash};

#[path = "run.rs"]
#[allow(dead_code)]
mod run;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args
        .get(1)
        .map(String::as_str)
        .unwrap_or("../web/public/data/network");
    if args.get(2).is_some_and(|a| a == "--cch") {
        let pairs: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3000);
        cch_check(dir, pairs);
        return;
    }
    if args.get(2).is_some_and(|a| a == "--replay") {
        let log = args.get(3).expect("--replay <log directory>");
        let limit: usize = args
            .get(4)
            .and_then(|s| s.parse().ok())
            .unwrap_or(usize::MAX);
        if args.iter().any(|a| a == "--cch") {
            replay_cch(dir, log, limit);
        } else {
            replay(dir, log, limit);
        }
        return;
    }
    let pairs: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3000);
    let net = Network::build(run::load(dir)).expect("consistent network");
    let n = net.edge_count();
    let free: Vec<f32> = (0..n)
        .map(|e| net.edge_length[e] / net.edge_speed[e].max(1.0))
        .collect();
    // Up to 2.5 times free flow, by a hash of the edge.
    let slow: Vec<f32> = (0..n)
        .map(|e| {
            let h = (e as u32).wrapping_mul(2_654_435_761) >> 16;
            free[e] * (1.0 + 1.5 * (h & 0xff) as f32 / 255.0)
        })
        .collect();
    let t = Instant::now();
    let landmarks = Landmarks::build(&net, &free);
    println!(
        "{n} edges; landmarks built in {:.0} ms",
        t.elapsed().as_secs_f64() * 1e3
    );
    let mut router = Router::new(n);
    router.landmarks = Some(landmarks);
    let ends: Vec<u32> = (0..n as u32)
        .filter(|&e| !net.is_internal_edge(e) && !net.successors(e).is_empty())
        .collect();
    let mut seed = 12345u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ends[(seed >> 33) as usize % ends.len()]
    };
    // Pairs with a route (in the engine nearly every search finds one).
    let mut found_pairs = Vec::new();
    while found_pairs.len() < pairs {
        let (a, b) = (next(), next());
        if router.route(&net, &free, a, b, vclass::PASSENGER).is_some() {
            found_pairs.push((a, b));
        }
    }
    let pairs = found_pairs;
    // The time a route takes on `times` (its first edge not counted, as in the search).
    let cost = |route: &[u32], times: &[f32]| -> f64 {
        route[1..].iter().map(|&e| times[e as usize] as f64).sum()
    };
    for (name, times) in [("free flow", &free), ("slowed", &slow)] {
        router.weight = 1.0;
        let best: Vec<f64> = pairs
            .iter()
            .map(|&(a, b)| {
                cost(
                    &router.route(&net, times, a, b, vclass::PASSENGER).unwrap(),
                    times,
                )
            })
            .collect();
        for weight in [1.0, 1.2, 1.4, 1.6, 2.0] {
            router.weight = weight;
            let (mut settled, mut worse, mut worst, mut failed) = (0usize, 0f64, 0f64, 0);
            let t = Instant::now();
            for (k, &(a, b)) in pairs.iter().enumerate() {
                let route = router.route(&net, times, a, b, vclass::PASSENGER);
                settled += router.last_settled;
                let Some(route) = route else {
                    failed += 1;
                    continue;
                };
                let ratio = cost(&route, times) / best[k].max(1e-9) - 1.0;
                worse += ratio;
                worst = worst.max(ratio);
            }
            let s = t.elapsed().as_secs_f64();
            println!(
                "{name}, weight {weight}: {:.0} µs each, {:.0} settled each, {:.0} ns per settled edge; routes {:.2} % slower on average, {:.1} % at worst; {failed} not found",
                s * 1e6 / pairs.len() as f64,
                settled as f64 / pairs.len() as f64,
                s * 1e9 / settled.max(1) as f64,
                100.0 * worse / pairs.len() as f64,
                100.0 * worst
            );
        }
    }
}

/// A logged search (`run::RouteLog`).
struct Logged {
    from: u32,
    to: u32,
    vclass: u16,
    tolls: bool,
    purpose: u8,
    found: bool,
    settled: u32,
    hash: u64,
    snapshot: u32,
}

fn read_times(path: &std::path::Path) -> Vec<f32> {
    std::fs::read(path)
        .unwrap_or_default()
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect()
}

fn read_log(dir: &std::path::Path, limit: usize) -> Vec<Logged> {
    let bytes = std::fs::read(dir.join("queries.bin")).expect("queries.bin");
    let u32_at = |r: &[u8], i: usize| u32::from_le_bytes(r[i..i + 4].try_into().unwrap());
    bytes
        .chunks_exact(run::QUERY_BYTES)
        .take(limit)
        .map(|r| Logged {
            from: u32_at(r, 0),
            to: u32_at(r, 4),
            vclass: u16::from_le_bytes([r[8], r[9]]),
            tolls: r[10] != 0,
            purpose: r[11],
            found: r[12] != 0,
            settled: u32_at(r, 13),
            hash: u64::from_le_bytes(r[17..25].try_into().unwrap()),
            snapshot: u32_at(r, 25),
        })
        .collect()
}

/// Replay logged searches with today's router: time them by purpose and check each finds
/// the same route as in the run.
fn replay(dir: &str, log: &str, limit: usize) {
    let log = std::path::Path::new(log);
    let net = Network::build(run::load(dir)).expect("consistent network");
    let queries = read_log(log, limit);
    let free = read_times(&log.join("free.bin"));
    let bike = read_times(&log.join("bike.bin"));
    assert_eq!(free.len(), net.edge_count(), "log from another network");
    let mut router = Router::new(net.edge_count());
    router.landmarks = Some(Landmarks::build(&net, &free));
    let mut snapshot = (u32::MAX, Vec::new());
    let n = purpose::NAMES.len();
    let (mut count, mut same, mut settled, mut logged) =
        (vec![0u64; n], vec![0u64; n], vec![0u64; n], vec![0u64; n]);
    let mut seconds = vec![0f64; n];
    for q in &queries {
        if q.purpose != purpose::TRANSIT && q.snapshot != snapshot.0 {
            snapshot = (
                q.snapshot,
                read_times(&log.join(format!("times-{}.bin", q.snapshot))),
            );
        }
        let times: &[f32] = if q.purpose == purpose::TRANSIT {
            &free
        } else if q.vclass == vclass::BICYCLE && !bike.is_empty() {
            &bike
        } else {
            &snapshot.1
        };
        router.tolls = q.tolls;
        let t = Instant::now();
        let route = router.route(&net, times, q.from, q.to, q.vclass);
        let p = q.purpose as usize;
        seconds[p] += t.elapsed().as_secs_f64();
        count[p] += 1;
        settled[p] += router.last_settled as u64;
        logged[p] += q.settled as u64;
        if route.is_some() == q.found && route.as_deref().map_or(0, route_hash) == q.hash {
            same[p] += 1;
        }
    }
    let total: f64 = seconds.iter().sum();
    println!(
        "{} searches replayed in {:.2} s ({:.0} µs each)",
        queries.len(),
        total,
        total * 1e6 / queries.len().max(1) as f64
    );
    for p in 0..n {
        if count[p] == 0 {
            continue;
        }
        println!(
            "  {:9} {:7} searches, {:5.1} % of the time, {:6.0} µs and {:6.0} edges settled each ({:.0} in the run); same route {:.2} %",
            purpose::NAMES[p],
            count[p],
            100.0 * seconds[p] / total.max(1e-9),
            seconds[p] * 1e6 / count[p] as f64,
            settled[p] as f64 / count[p] as f64,
            logged[p] as f64 / count[p] as f64,
            100.0 * same[p] as f64 / count[p] as f64
        );
    }
}

/// Build the contraction hierarchy (M11) and check its routes against exact A* on random
/// pairs, at free flow and slowed.
fn cch_check(dir: &str, pairs: usize) {
    let net = Network::build(run::load(dir)).expect("consistent network");
    let n = net.edge_count();
    let free: Vec<f32> = (0..n)
        .map(|e| net.edge_length[e] / net.edge_speed[e].max(1.0))
        .collect();
    let slow: Vec<f32> = (0..n)
        .map(|e| {
            let h = (e as u32).wrapping_mul(2_654_435_761) >> 16;
            free[e] * (1.0 + 1.5 * (h & 0xff) as f32 / 255.0)
        })
        .collect();
    let t = Instant::now();
    let cch = Cch::build(&net);
    println!(
        "hierarchy: {} edges, {} arcs ({:.1} per edge), elimination tree {} high; built in {:.2} s",
        cch.len(),
        cch.arcs(),
        cch.arcs() as f64 / cch.len() as f64,
        cch.height(),
        t.elapsed().as_secs_f64()
    );
    let mut router = Router::new(n);
    router.landmarks = Some(Landmarks::build(&net, &free));
    router.weight = 1.0;
    let ends: Vec<u32> = (0..n as u32)
        .filter(|&e| cch.rank[e as usize] != zg_sim::network::NONE)
        .collect();
    let mut seed = 12345u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ends[(seed >> 33) as usize % ends.len()]
    };
    let pairs: Vec<(u32, u32)> = (0..pairs).map(|_| (next(), next())).collect();
    // A route's time with its turns, as the searches count it.
    let cost = |route: &[u32], times: &[f32]| -> f64 {
        route
            .windows(2)
            .map(|p| {
                let turn = net
                    .successors(p[0])
                    .iter()
                    .find(|s| s.edge == p[1])
                    .map_or(f32::INFINITY, |s| s.penalty);
                (times[p[1] as usize] + turn) as f64
            })
            .sum()
    };
    let mut query = Query::new(&cch);
    for (name, times) in [("free flow", &free), ("slowed", &slow)] {
        let mut metric = Metric::new(vclass::PASSENGER, false);
        let t = Instant::now();
        metric.customize(&cch, &net, times);
        let custom = t.elapsed().as_secs_f64();
        let (mut astar, mut ch, mut visited) = (0f64, 0f64, 0usize);
        let (mut same_found, mut worse, mut worst, mut valid) = (0, 0f64, 0f64, 0);
        let (mut both, mut big) = (0, 0);
        router.tolls = false;
        for &(a, b) in &pairs {
            let t = Instant::now();
            let want = router.route(&net, times, a, b, vclass::PASSENGER);
            astar += t.elapsed().as_secs_f64();
            let t = Instant::now();
            let got = query.route(&cch, &metric, a, b);
            ch += t.elapsed().as_secs_f64();
            visited += query.last_visited;
            if want.is_some() == got.is_some() {
                same_found += 1;
            }
            if let (Some(w), Some((g, _))) = (&want, &got) {
                // A route: it starts and ends where asked, and each move is a successor.
                let ok = g.first() == Some(&a)
                    && g.last() == Some(&b)
                    && g.windows(2).all(|p| {
                        net.successors(p[0])
                            .iter()
                            .any(|s| s.edge == p[1] && s.allow & vclass::PASSENGER != 0)
                    });
                if ok {
                    valid += 1;
                } else if valid + 3 > both {
                    let bad: Vec<(u32, u32)> = g
                        .windows(2)
                        .filter(|p| {
                            !net.successors(p[0])
                                .iter()
                                .any(|s| s.edge == p[1] && s.allow & vclass::PASSENGER != 0)
                        })
                        .map(|p| (p[0], p[1]))
                        .collect();
                    println!(
                        "  invalid: {a} -> {b}, {} edges, first {:?} last {:?}, bad moves {:?}",
                        g.len(),
                        g.first(),
                        g.last(),
                        &bad[..bad.len().min(4)]
                    );
                }
                both += 1;
                let r = cost(g, times) / cost(w, times).max(1e-9) - 1.0;
                if r.abs() > 1e-3 && big < 3 {
                    big += 1;
                    println!(
                        "  {a} -> {b}: A* {:.2} s ({} edges), hierarchy {:.2} s ({} edges, says {:.2} s)",
                        cost(w, times),
                        w.len(),
                        cost(g, times),
                        g.len(),
                        got.as_ref().unwrap().1
                    );
                }
                worse += r;
                worst = worst.max(r.abs());
            }
        }
        let k = pairs.len() as f64;
        println!(
            "{name}: customised in {:.0} ms; A* (exact) {:.0} µs, hierarchy {:.1} µs a route ({:.0} ranks visited); found alike {same_found}/{}, valid routes {valid} of {both}; time against A* {:+.4} % on average, {:.4} % at most",
            custom * 1e3,
            astar * 1e6 / k,
            ch * 1e6 / k,
            visited as f64 / k,
            pairs.len(),
            100.0 * worse / k,
            100.0 * worst
        );
    }
}

/// Replay logged searches with the contraction hierarchy (M11): time them, with the
/// customisations their travel times need, and compare each route's time with the route
/// found in the run (by weighted A*) on the same times.
fn replay_cch(dir: &str, log: &str, limit: usize) {
    let log = std::path::Path::new(log);
    let net = Network::build(run::load(dir)).expect("consistent network");
    let queries = read_log(log, limit);
    let free = read_times(&log.join("free.bin"));
    let bike = read_times(&log.join("bike.bin"));
    let t = Instant::now();
    let cch = Cch::build(&net);
    println!(
        "hierarchy: {} edges, {} arcs, built in {:.2} s",
        cch.len(),
        cch.arcs(),
        t.elapsed().as_secs_f64()
    );
    let mut router = Router::new(net.edge_count());
    router.landmarks = Some(Landmarks::build(&net, &free));
    // Metrics by (class, tolls), customised when their times change.
    let kinds = [
        (vclass::PASSENGER, true),
        (vclass::PASSENGER, false),
        (vclass::TRUCK, true),
        (vclass::TRUCK, false),
    ];
    let mut metrics: Vec<Metric> = kinds.iter().map(|&(v, t)| Metric::new(v, t)).collect();
    let mut bike_metric = Metric::new(vclass::BICYCLE, true);
    bike_metric.customize(&cch, &net, &bike);
    let mut query = Query::new(&cch);
    let mut snapshot = (u32::MAX, Vec::new());
    let (mut custom, mut customs) = (0f64, 0);
    let n = purpose::NAMES.len();
    let mut count = vec![0u64; n];
    let mut seconds = vec![0f64; n];
    let (mut same, mut faster, mut gain, mut slower, mut astar_only, mut cch_only) =
        (0u64, 0u64, 0f64, 0u64, 0u64, 0u64);
    let mut saved = Vec::new();
    // A route's time on `times` with its turns, tolls and fuel, as the searches count it.
    let cost = |route: &[u32], times: &[f32], vc: u16, tolls: bool| -> f64 {
        route
            .windows(2)
            .map(|p| {
                let s = net
                    .successors(p[0])
                    .iter()
                    .find(|s| s.edge == p[1] && s.allow & vc != 0);
                s.map_or(f64::INFINITY, |s| {
                    let toll = if tolls { s.toll } else { 0.0 };
                    let fuel = if vc != vclass::BICYCLE { s.fuel } else { 0.0 };
                    (times[p[1] as usize] + s.penalty + toll + fuel) as f64
                })
            })
            .sum()
    };
    for q in &queries {
        if q.purpose == purpose::TRANSIT {
            continue;
        }
        let p = q.purpose as usize;
        let bike_q = q.vclass == vclass::BICYCLE && !bike.is_empty();
        if !bike_q && q.snapshot != snapshot.0 {
            snapshot = (
                q.snapshot,
                read_times(&log.join(format!("times-{}.bin", q.snapshot))),
            );
            let t = Instant::now();
            for m in &mut metrics {
                m.customize(&cch, &net, &snapshot.1);
            }
            custom += t.elapsed().as_secs_f64();
            customs += 1;
        }
        let (times, metric): (&[f32], &Metric) = if bike_q {
            (&bike, &bike_metric)
        } else {
            let k = kinds
                .iter()
                .position(|&(v, t)| v == q.vclass && t == q.tolls)
                .expect("a class with a metric");
            (&snapshot.1, &metrics[k])
        };
        let t = Instant::now();
        let got = query.route(&cch, metric, q.from, q.to);
        seconds[p] += t.elapsed().as_secs_f64();
        count[p] += 1;
        // The run's route, again (weighted A*, as logged).
        router.tolls = q.tolls;
        let had = router.route(&net, times, q.from, q.to, q.vclass);
        match (&had, &got) {
            (Some(a), Some((b, _))) => {
                if route_hash(b) == route_hash(a) {
                    same += 1;
                } else {
                    let (ta, tb) = (
                        cost(a, times, q.vclass, q.tolls),
                        cost(b, times, q.vclass, q.tolls),
                    );
                    if tb < ta - 1e-3 {
                        faster += 1;
                        gain += (ta - tb) / ta.max(1e-9);
                        saved.push(ta - tb);
                    } else if tb > ta + 1e-3 {
                        slower += 1;
                    }
                }
            }
            (Some(_), None) => astar_only += 1,
            (None, Some(_)) => cch_only += 1,
            _ => {}
        }
    }
    let total: f64 = seconds.iter().sum();
    let k: u64 = count.iter().sum();
    println!(
        "{k} searches in {:.2} s ({:.1} µs each), plus {customs} customisations of 4 metrics in {:.2} s ({:.0} ms each)",
        total,
        total * 1e6 / k.max(1) as f64,
        custom,
        custom * 1e3 / customs.max(1) as f64
    );
    for p in 0..n {
        if count[p] > 0 {
            println!(
                "  {:9} {:7} searches, {:5.1} µs each",
                purpose::NAMES[p],
                count[p],
                seconds[p] * 1e6 / count[p] as f64
            );
        }
    }
    saved.sort_by(f64::total_cmp);
    let pct = |q: f64| {
        saved
            .get(((saved.len() as f64 - 1.0) * q) as usize)
            .copied()
            .unwrap_or(0.0)
    };
    println!(
        "against the run's routes: {same} the same, {faster} faster by {:.1} % on average (by {:.0} s median, {:.0} s at the 90th percentile), {slower} slower; {astar_only} found only by A*, {cch_only} only by the hierarchy",
        100.0 * gain / faster.max(1) as f64,
        pct(0.5),
        pct(0.9)
    );
}
