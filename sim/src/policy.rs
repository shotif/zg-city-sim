//! Policies on areas the player draws (M18): a congestion charge for driving into an area.
//!
//! An area is a polygon in scene coordinates (x east, z south, metres). Its junctions are
//! those whose position is inside it and more than `EDGE_FREE` from its edge, and the roads
//! into it are the edges from a junction outside to one inside. Roads along the edge are
//! free, as an area drawn along streets would otherwise charge some of their junctions and
//! not others. A charge is paid by cars and lorries each time they drive onto a road into
//! the area during its hours; buses, trams and bikes do not pay.
//!
//! It works through the simulation in two ways. Routes count the charge as time, at the
//! €16 an hour behind the tolls and fuel (`SECONDS_PER_EURO`), so through traffic goes round
//! the area. The split between car and public transport (`Riders`) counts it on trips to and
//! from the area: a round trip into it pays once, so half the charge on each leg, weighted
//! by the share of the day's trips that start within the hours (`HOURLY`). The charges paid
//! are counted for the budget.

use crate::demand::HOURLY;
use crate::network::Network;

/// Seconds drivers count a euro as: the €16 an hour behind `network::TOLL_TIME` and
/// `network::FUEL_TIME` (an estimate).
pub const SECONDS_PER_EURO: f32 = 225.0;
/// Charges the player may set (€).
pub const CHARGE_RANGE: (f32, f32) = (0.0, 50.0);
/// Most points an area may have.
pub const MAX_POINTS: usize = 256;
/// Junctions within this distance of an area's edge (m) count as outside it, so the roads
/// along the edge are free, as London's Inner Ring Road was (an area drawn along a street
/// is within about 25 m of its middle).
pub const EDGE_FREE: f32 = 40.0;

/// Whether `p` is inside the polygon `points` (even-odd rule).
pub fn inside(points: &[(f32, f32)], p: (f32, f32)) -> bool {
    let mut is_in = false;
    let n = points.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, zi) = points[i];
        let (xj, zj) = points[j];
        if (zi > p.1) != (zj > p.1) && p.0 < (xj - xi) * (p.1 - zi) / (zj - zi) + xi {
            is_in = !is_in;
        }
        j = i;
    }
    is_in
}

/// Distance from `p` to the nearest side of the polygon `points` (m).
pub fn distance_to_edge(points: &[(f32, f32)], p: (f32, f32)) -> f32 {
    let mut best = f32::INFINITY;
    let n = points.len();
    for i in 0..n {
        let (a, b) = (points[i], points[(i + 1) % n]);
        let (dx, dz) = (b.0 - a.0, b.1 - a.1);
        let len2 = dx * dx + dz * dz;
        let t = if len2 > 0.0 {
            (((p.0 - a.0) * dx + (p.1 - a.1) * dz) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        best = best.min((p.0 - a.0 - t * dx).hypot(p.1 - a.1 - t * dz));
    }
    best
}

/// Whether a junction at `p` is in the area `points`: inside it and more than `EDGE_FREE`
/// from its edge.
pub fn within(points: &[(f32, f32)], p: (f32, f32)) -> bool {
    inside(points, p) && distance_to_edge(points, p) > EDGE_FREE
}

/// A congestion charge on an area: `euros` for driving into it between `from` and `to`
/// (s after midnight; `from` after `to` runs over midnight).
#[derive(Clone, Debug, PartialEq)]
pub struct Charge {
    pub area: Vec<(f32, f32)>,
    pub euros: f32,
    pub from: f32,
    pub to: f32,
}

impl Charge {
    /// Whether the charge applies at `time` (s; any day).
    pub fn applies(&self, time: f64) -> bool {
        let t = time.rem_euclid(86_400.0) as f32;
        if self.from <= self.to {
            (self.from..self.to).contains(&t)
        } else {
            t >= self.from || t < self.to
        }
    }

    /// The share of the day's trips that start while it applies, by `HOURLY` (hours counted
    /// by the part of them within the charging hours).
    pub fn day_share(&self) -> f32 {
        let total: f32 = HOURLY.iter().sum();
        let mut share = 0.0;
        for (h, &w) in HOURLY.iter().enumerate() {
            let (a, b) = (h as f32 * 3600.0, (h + 1) as f32 * 3600.0);
            let part = if self.from <= self.to {
                overlap(a, b, self.from, self.to)
            } else {
                overlap(a, b, self.from, 86_400.0) + overlap(a, b, 0.0, self.to)
            };
            share += w * part / 3600.0;
        }
        if total > 0.0 { share / total } else { 0.0 }
    }
}

fn overlap(a: f32, b: f32, c: f32, d: f32) -> f32 {
    (b.min(d) - a.max(c)).max(0.0)
}

/// The policies in force, matched to a network.
#[derive(Default)]
pub struct Policies {
    pub charges: Vec<Charge>,
    /// The roads into each charge's area.
    pub entries: Vec<Vec<u32>>,
    /// Whether each charge applies now (as last refreshed).
    pub active: Vec<bool>,
    /// For each edge, the charges it leads into (sorted by edge; empty if none).
    by_edge: Vec<(u32, u16)>,
    /// Charges paid since the start (€), and vehicles that paid.
    pub paid: f64,
    pub payers: u64,
}

impl Policies {
    /// The policies `charges` on network `net`.
    pub fn new(net: &Network, charges: Vec<Charge>) -> Policies {
        let n_junctions = net.d.junction_pos.len() / 2;
        let mut entries = Vec::with_capacity(charges.len());
        let mut by_edge = Vec::new();
        for (c, charge) in charges.iter().enumerate() {
            let (mut lo, mut hi) = ((f32::MAX, f32::MAX), (f32::MIN, f32::MIN));
            for &(x, z) in &charge.area {
                (lo, hi) = ((lo.0.min(x), lo.1.min(z)), (hi.0.max(x), hi.1.max(z)));
            }
            let is_in: Vec<bool> = (0..n_junctions)
                .map(|j| {
                    let p = (net.d.junction_pos[2 * j], net.d.junction_pos[2 * j + 1]);
                    (lo.0..=hi.0).contains(&p.0)
                        && (lo.1..=hi.1).contains(&p.1)
                        && within(&charge.area, p)
                })
                .collect();
            let mut roads = Vec::new();
            for e in 0..net.edge_count() {
                if net.is_internal_edge(e as u32) {
                    continue;
                }
                let (a, b) = (net.d.edge_from[e] as usize, net.d.edge_to[e] as usize);
                if a < n_junctions && b < n_junctions && !is_in[a] && is_in[b] {
                    roads.push(e as u32);
                    by_edge.push((e as u32, c as u16));
                }
            }
            entries.push(roads);
        }
        by_edge.sort_unstable();
        Policies {
            active: vec![false; charges.len()],
            charges,
            entries,
            by_edge,
            paid: 0.0,
            payers: 0,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.charges.is_empty()
    }

    /// Which charges apply at `time`; true if that changed since last asked.
    pub fn refresh(&mut self, time: f64) -> bool {
        let mut changed = false;
        for (c, charge) in self.charges.iter().enumerate() {
            let now = charge.applies(time);
            if now != self.active[c] {
                self.active[c] = now;
                changed = true;
            }
        }
        changed
    }

    /// Seconds car and lorry routes count for driving onto each edge now (`charges[e]`;
    /// zero where nothing is charged), into `out` sized for the network's edges.
    pub fn route_seconds(&self, out: &mut Vec<f32>, edges: usize) {
        out.clear();
        out.resize(edges, 0.0);
        for &(e, c) in &self.by_edge {
            if self.active[c as usize] && (e as usize) < edges {
                out[e as usize] += self.charges[c as usize].euros * SECONDS_PER_EURO;
            }
        }
    }

    /// A car or lorry drove onto edge `e`: it pays the charges in force for the areas it
    /// leads into.
    pub fn entered(&mut self, e: u32) {
        let start = self.by_edge.partition_point(|&(x, _)| x < e);
        let mut paid = 0.0;
        for &(x, c) in &self.by_edge[start..] {
            if x != e {
                break;
            }
            if self.active[c as usize] {
                paid += self.charges[c as usize].euros as f64;
            }
        }
        if paid > 0.0 {
            self.paid += paid;
            self.payers += 1;
        }
    }

    /// The car's extra generalised time (s) between every two zones with centres
    /// `centres` (row-major, origin then destination), for the split with public transport;
    /// none if nothing is charged.
    pub fn split_seconds(&self, centres: &[(f32, f32)]) -> Option<Vec<f32>> {
        if self.charges.iter().all(|c| c.euros <= 0.0) {
            return None;
        }
        let n = centres.len();
        let mut extra = vec![0f32; n * n];
        for charge in &self.charges {
            let is_in: Vec<bool> = centres.iter().map(|&p| inside(&charge.area, p)).collect();
            let leg = 0.5 * charge.euros * SECONDS_PER_EURO * charge.day_share();
            for o in 0..n {
                for d in 0..n {
                    if is_in[o] != is_in[d] {
                        extra[o * n + d] += leg;
                    }
                }
            }
        }
        Some(extra)
    }
}
