//! Time route searches on the exported network: random pairs of edges, with travel times
//! made slower than free flow by a fixed pattern, so the landmark bounds are as loose as
//! they are in the rush hour.
//!
//!   cargo run --release --example routes -- web/public/data/network [pairs]

use std::time::Instant;

use zg_sim::network::{Network, vclass};
use zg_sim::router::{Landmarks, Router};

#[path = "run.rs"]
#[allow(dead_code)]
mod run;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args
        .get(1)
        .map(String::as_str)
        .unwrap_or("../web/public/data/network");
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
