//! Synthetic travel demand: car and truck trips between road edges weighted by where people
//! live and work, timed by a typical weekday profile, with destinations chosen by a gravity
//! model (nearer places are likelier).

use crate::engine::Trip;
use crate::network::{Network, vclass};
use crate::rng::Rng;
use crate::vtype;

/// Share of a weekday's car trips starting in each hour (typical European city profile:
/// morning and afternoon peaks, the afternoon one longer).
pub const HOURLY: [f32; 24] = [
    0.6, 0.3, 0.2, 0.2, 0.4, 1.2, 3.5, 7.5, 7.0, 5.0, 4.6, 4.8, 5.2, 5.6, 6.6, 8.0, 8.2, 7.8, 6.4,
    4.8, 3.4, 2.6, 1.9, 1.2,
];

/// Candidate destinations the gravity model chooses between.
const CANDIDATES: usize = 8;

pub struct Demand {
    edges: Vec<u32>,
    pos: Vec<(f32, f32)>,
    truck_ok: Vec<bool>,
    home_cum: Vec<f64>,
    work_cum: Vec<f64>,
    any_cum: Vec<f64>,
    /// Trips per day at scale 1.
    pub daily_trips: f64,
    /// Distance (m) over which destination attractiveness falls by a factor e.
    pub decay: f32,
    hourly_sum: f32,
    acc: f64,
}

fn cumulative(w: &[f32]) -> Vec<f64> {
    let mut acc = 0.0;
    w.iter()
        .map(|&x| {
            acc += x.max(0.0) as f64;
            acc
        })
        .collect()
}

fn sample(cum: &[f64], rng: &mut Rng) -> Option<usize> {
    let total = *cum.last()?;
    if total <= 0.0 {
        return None;
    }
    let x = rng.f64() * total;
    Some(cum.partition_point(|&c| c <= x).min(cum.len() - 1))
}

impl Demand {
    /// Demand from per-edge home and work weights (e.g. residents and jobs).
    pub fn new(
        net: &Network,
        edges: Vec<u32>,
        home: &[f32],
        work: &[f32],
        daily_trips: f64,
    ) -> Demand {
        let pos = edges.iter().map(|&e| net.edge_mid[e as usize]).collect();
        let truck_ok = edges
            .iter()
            .map(|&e| {
                net.edge_lanes(e)
                    .any(|l| net.d.lane_allow[l as usize] & vclass::TRUCK != 0)
            })
            .collect();
        let home_total: f32 = home.iter().sum();
        let work_total: f32 = work.iter().sum();
        let any: Vec<f32> = home
            .iter()
            .zip(work)
            .map(|(&h, &w)| h / home_total.max(1e-6) + w / work_total.max(1e-6))
            .collect();
        Demand {
            edges,
            pos,
            truck_ok,
            home_cum: cumulative(home),
            work_cum: cumulative(work),
            any_cum: cumulative(&any),
            daily_trips,
            decay: 4000.0,
            hourly_sum: HOURLY.iter().sum(),
            acc: 0.0,
        }
    }

    /// Placeholder demand from the network alone: homes along local streets, work along
    /// main roads. Used until building-based weights are loaded.
    pub fn from_network(net: &Network, daily_trips: f64) -> Demand {
        let mut edges = Vec::new();
        let mut home = Vec::new();
        let mut work = Vec::new();
        for e in 0..net.edge_count() as u32 {
            if net.is_internal_edge(e) {
                continue;
            }
            let lanes = net.edge_lanes(e);
            if !lanes
                .clone()
                .any(|l| net.d.lane_allow[l as usize] & vclass::PASSENGER != 0)
            {
                continue;
            }
            let speed = net.edge_speed[e as usize];
            if speed > 22.0 {
                continue; // motorways and expressways have no doors
            }
            let len = net.edge_length[e as usize];
            edges.push(e);
            home.push(if speed <= 14.0 { len } else { 0.3 * len });
            work.push(if speed > 14.0 { 2.0 * len } else { len });
        }
        Demand::new(net, edges, &home, &work, daily_trips)
    }

    /// Share of the day's trips per hour at time `t` (s since midnight), interpolated.
    fn hourly_share(&self, t: f64) -> f32 {
        let x = (t / 3600.0 - 0.5).rem_euclid(24.0) as f32;
        let h0 = x.floor() as usize % 24;
        let f = x - x.floor();
        (HOURLY[h0] * (1.0 - f) + HOURLY[(h0 + 1) % 24] * f) / self.hourly_sum
    }

    /// Trips per second at time `t`.
    pub fn rate(&self, t: f64) -> f64 {
        self.daily_trips * self.hourly_share(t) as f64 / 3600.0
    }

    /// Emit the trips that start in [t, t + dt).
    pub fn generate(
        &mut self,
        t: f64,
        dt: f64,
        scale: f64,
        rng: &mut Rng,
        emit: &mut dyn FnMut(Trip),
    ) {
        if self.edges.is_empty() {
            return;
        }
        self.acc += self.rate(t) * dt * scale;
        let hour = ((t / 3600.0).rem_euclid(24.0)) as u32;
        // Shares of home->work and work->home trips; the rest are other errands.
        let (to_work, to_home) = match hour {
            5..=9 => (0.55, 0.05),
            10..=13 => (0.15, 0.15),
            14..=18 => (0.08, 0.5),
            _ => (0.05, 0.25),
        };
        let truck_share = if (6..20).contains(&hour) { 0.06 } else { 0.12 };
        while self.acc >= 1.0 {
            self.acc -= 1.0;
            let r = rng.f32();
            let (from_cum, to_cum) = if r < to_work {
                (&self.home_cum, &self.work_cum)
            } else if r < to_work + to_home {
                (&self.work_cum, &self.home_cum)
            } else {
                (&self.any_cum, &self.any_cum)
            };
            let Some(o) = sample(from_cum, rng) else {
                return;
            };
            let Some(d) = self.destination(o, to_cum, rng) else {
                continue;
            };
            let truck = rng.f32() < truck_share && self.truck_ok[o] && self.truck_ok[d];
            emit(Trip {
                depart: t + rng.f64() * dt,
                from: self.edges[o],
                to: self.edges[d],
                vtype: if truck { vtype::TRUCK } else { vtype::CAR },
            });
        }
    }

    /// Gravity model: draw candidates by attractiveness, keep one weighted by distance decay.
    fn destination(&self, origin: usize, cum: &[f64], rng: &mut Rng) -> Option<usize> {
        let (ox, oz) = self.pos[origin];
        let mut cand = [0usize; CANDIDATES];
        let mut weight = [0f32; CANDIDATES];
        let mut total = 0.0;
        let mut n = 0;
        for _ in 0..CANDIDATES * 2 {
            if n == CANDIDATES {
                break;
            }
            let c = sample(cum, rng)?;
            if c == origin {
                continue;
            }
            let (x, z) = self.pos[c];
            let dist = ((x - ox).powi(2) + (z - oz).powi(2)).sqrt();
            let w = (-dist / self.decay).exp() + 1e-9;
            cand[n] = c;
            weight[n] = w;
            total += w;
            n += 1;
        }
        if n == 0 {
            return None;
        }
        let mut x = rng.f32() * total;
        for k in 0..n {
            x -= weight[k];
            if x <= 0.0 {
                return Some(cand[k]);
            }
        }
        Some(cand[n - 1])
    }
}
