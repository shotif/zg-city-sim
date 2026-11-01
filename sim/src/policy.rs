//! Policies on areas the player draws (M18): a congestion charge for driving into an area,
//! a surcharge on parking in one, and a ban on lorries crossing one's edge.
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
//!
//! A parking surcharge (M18b) is paid, per hour within its hours, by car trips that end in
//! the area, for an estimated stay: commuters stay `WORK_STAY` and half of them pay (the rest
//! park at work), errands stay `ERRAND_STAY`, and trips home do not pay (residents park on
//! permits). Routes do not count it, as there is no way round it. The split counts half of
//! the expected payment on each leg of trips to and from the area, and car trips that still
//! end there pay it.
//!
//! A lorry ban (M18c) keeps lorries from crossing the area's edge, in or out, during its
//! hours, except to reach or leave places inside it. Lorry routes count `BAN_SECONDS` for
//! every road over the edge, so through lorries go round, and lorries to and from places
//! inside cross it once, as deliveries are let in. Cars, buses, trams and bikes are not
//! affected, and the split does not count it.
//!
//! Bans count lorries by weight (M21): the player's keep out every lorry (over 3.5 t), and
//! Zagreb's central zone, which the City keeps lorries over 12 t out of all day, is a ban of
//! its own on heavy lorries (`Policies::add_zone`), in force whatever the player does.

use crate::demand::{Demand, HOURLY, purposes};
use crate::network::Network;
use crate::rng::Rng;
use crate::vtype::LIGHT_LORRY_TONNES;

/// Seconds drivers count a euro as: the €16 an hour behind `network::TOLL_TIME` and
/// `network::FUEL_TIME` (an estimate).
pub const SECONDS_PER_EURO: f32 = 225.0;
/// Charges the player may set (€).
pub const CHARGE_RANGE: (f32, f32) = (0.0, 50.0);
/// Parking surcharges the player may set (€ an hour).
pub const PARKING_RANGE: (f32, f32) = (0.0, 20.0);
/// How long car trips to work park, and the share of them that pay (the rest park at work,
/// off the street): estimates, from an eight-hour working day.
pub const WORK_STAY: f32 = 8.0 * 3600.0;
pub const WORK_PAYING: f32 = 0.5;
/// How long other car trips park (an estimate; Zagreb's central zone allows two hours).
pub const ERRAND_STAY: f32 = 1.5 * 3600.0;
/// Trips of each purpose drawn to estimate which share ends in a parking area.
const PARKING_SAMPLES: usize = 4000;
/// What lorry routes count for each road over a lorry ban's edge while it applies (s): an
/// hour, more than any way round the area takes, so only lorries to or from places inside
/// it cross the edge.
pub const BAN_SECONDS: f32 = 3600.0;
/// Lorries the player's bans keep out: those over 3.5 t, every lorry the simulation has.
pub const BAN_TONNES: f32 = 3.5;
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
/// (s after midnight; `from` after `to` runs over midnight). Parking surcharges and lorry
/// bans take the same form (a ban's `euros` is 0).
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

    /// Seconds of [a, b) (s after midnight, b up to a day later) within the hours.
    pub fn seconds_within(&self, a: f32, b: f32) -> f32 {
        let mut sum = 0.0;
        for day in [0.0, 86_400.0] {
            sum += if self.from <= self.to {
                overlap(a, b, day + self.from, day + self.to)
            } else {
                overlap(a, b, day, day + self.to) + overlap(a, b, day + self.from, day + 86_400.0)
            };
        }
        sum
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
    /// Parking surcharges (M18b): `euros` an hour between `from` and `to`.
    pub parking: Vec<Charge>,
    /// For each edge, the parking areas it is in (sorted by edge).
    parking_by_edge: Vec<(u32, u16)>,
    /// For each parking surcharge, what a car trip ending in its area pays (€) by the hour it
    /// sets off, and over the day (`estimate_parking`).
    parking_pay: Vec<[f32; 24]>,
    parking_mean: Vec<f32>,
    /// Parking surcharges paid since the start (€), and car trips that ended in a parking
    /// area.
    pub parking_paid: f64,
    pub parking_arrivals: u64,
    /// Lorry bans (M18c), the weight (t) lorries they keep out are over (M21), whether each
    /// applies now, and for each edge over a ban's edge the ban and whether it leads in
    /// (sorted by edge). The player's bans come first, then standing ones (`add_zone`).
    pub bans: Vec<Charge>,
    pub ban_tonnes: Vec<f32>,
    pub ban_active: Vec<bool>,
    ban_by_edge: Vec<(u32, u16, bool)>,
    /// Lorries that drove into a ban's area while it applied, since the start.
    pub lorries_in: u64,
}

/// For each junction of `net`, whether it is in `area` (`within`).
fn junctions_within(net: &Network, area: &[(f32, f32)]) -> Vec<bool> {
    let n_junctions = net.d.junction_pos.len() / 2;
    let (mut lo, mut hi) = ((f32::MAX, f32::MAX), (f32::MIN, f32::MIN));
    for &(x, z) in area {
        (lo, hi) = ((lo.0.min(x), lo.1.min(z)), (hi.0.max(x), hi.1.max(z)));
    }
    (0..n_junctions)
        .map(|j| {
            let p = (net.d.junction_pos[2 * j], net.d.junction_pos[2 * j + 1]);
            (lo.0..=hi.0).contains(&p.0) && (lo.1..=hi.1).contains(&p.1) && within(area, p)
        })
        .collect()
}

/// The roads over `area`'s edge, in or out, for ban `b`: each edge and whether it leads in.
fn roads_across(net: &Network, area: &[(f32, f32)], b: u16) -> Vec<(u32, u16, bool)> {
    let n_junctions = net.d.junction_pos.len() / 2;
    let is_in = junctions_within(net, area);
    let mut out = Vec::new();
    for e in 0..net.edge_count() {
        let (a, z) = (net.d.edge_from[e] as usize, net.d.edge_to[e] as usize);
        if net.is_internal_edge(e as u32) || a >= n_junctions || z >= n_junctions {
            continue;
        }
        if is_in[a] != is_in[z] {
            out.push((e as u32, b, is_in[z]));
        }
    }
    out
}

impl Policies {
    /// The policies `charges`, `parking` and `bans` on network `net`. What parking costs is
    /// estimated with `estimate_parking`.
    pub fn new(
        net: &Network,
        charges: Vec<Charge>,
        parking: Vec<Charge>,
        bans: Vec<Charge>,
    ) -> Policies {
        let n_junctions = net.d.junction_pos.len() / 2;
        let mut entries = Vec::with_capacity(charges.len());
        let mut by_edge = Vec::new();
        for (c, charge) in charges.iter().enumerate() {
            let is_in = junctions_within(net, &charge.area);
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
        let mut parking_by_edge = Vec::new();
        for (p, park) in parking.iter().enumerate() {
            for e in 0..net.edge_count() {
                if !net.is_internal_edge(e as u32) && inside(&park.area, net.edge_mid[e]) {
                    parking_by_edge.push((e as u32, p as u16));
                }
            }
        }
        parking_by_edge.sort_unstable();
        let mut ban_by_edge = Vec::new();
        for (b, ban) in bans.iter().enumerate() {
            ban_by_edge.extend(roads_across(net, &ban.area, b as u16));
        }
        ban_by_edge.sort_unstable();
        Policies {
            active: vec![false; charges.len()],
            charges,
            entries,
            by_edge,
            paid: 0.0,
            payers: 0,
            parking_pay: vec![[0.0; 24]; parking.len()],
            parking_mean: vec![0.0; parking.len()],
            parking,
            parking_by_edge,
            parking_paid: 0.0,
            parking_arrivals: 0,
            ban_active: vec![false; bans.len()],
            ban_tonnes: vec![BAN_TONNES; bans.len()],
            bans,
            ban_by_edge,
            lorries_in: 0,
        }
    }

    /// Keep lorries over `tonnes` out of `area` all day, as Zagreb keeps lorries over 12 t
    /// out of its central zone (M21): a standing ban, after the player's.
    pub fn add_zone(&mut self, net: &Network, area: Vec<(f32, f32)>, tonnes: f32) {
        if area.len() < 3 {
            return;
        }
        let b = self.bans.len() as u16;
        self.ban_by_edge.extend(roads_across(net, &area, b));
        self.ban_by_edge.sort_unstable();
        self.bans.push(Charge {
            area,
            euros: 0.0,
            from: 0.0,
            to: 86_400.0,
        });
        self.ban_tonnes.push(tonnes);
        self.ban_active.push(false);
    }

    pub fn is_empty(&self) -> bool {
        self.charges.is_empty() && self.parking.is_empty() && self.bans.is_empty()
    }

    /// The roads over each lorry ban's edge, in and out.
    pub fn ban_roads(&self, b: usize) -> Vec<u32> {
        let mut roads: Vec<u32> = self
            .ban_by_edge
            .iter()
            .filter(|&&(_, x, _)| x as usize == b)
            .map(|&(e, _, _)| e)
            .collect();
        roads.dedup();
        roads
    }

    /// What car trips ending in each parking area pay, from the trips `demand` draws: the
    /// share of each purpose's trips that end there, and their stays within the hours (setting
    /// off in the middle of the hour and arriving half an hour later).
    pub fn estimate_parking(&mut self, demand: &Demand) {
        if self.parking.is_empty() {
            return;
        }
        let (_, pos) = demand.edges();
        let mut rng = Rng::new(0x9a4c);
        // Destinations of trips to work, home and errands, drawn once for all areas.
        let mut drawn: [Vec<usize>; 3] = Default::default();
        for (purpose, list) in drawn.iter_mut().enumerate() {
            for _ in 0..PARKING_SAMPLES {
                let pair = match purpose {
                    0 => demand.draw_commute(&mut rng),
                    1 => demand.draw_home(&mut rng),
                    _ => demand.draw_errand(&mut rng),
                };
                if let Some((_, d)) = pair {
                    list.push(d);
                }
            }
        }
        for (p, park) in self.parking.iter().enumerate() {
            let share = |list: &Vec<usize>| {
                let n = list.iter().filter(|&&d| inside(&park.area, pos[d])).count();
                n as f32 / PARKING_SAMPLES as f32
            };
            let ends = [share(&drawn[0]), share(&drawn[1]), share(&drawn[2])];
            let (mut paid, mut trips) = (0.0, 0.0);
            for h in 0..24 {
                let (work, home) = purposes(h);
                let weights = [
                    work * ends[0],
                    home * ends[1],
                    (1.0 - work - home) * ends[2],
                ];
                let arrive = (h as f32 + 1.0) * 3600.0;
                let pays = [
                    WORK_PAYING * park.seconds_within(arrive, arrive + WORK_STAY),
                    0.0,
                    park.seconds_within(arrive, arrive + ERRAND_STAY),
                ];
                let n: f32 = weights.iter().sum();
                let euros: f32 =
                    weights.iter().zip(pays).map(|(w, s)| w * s).sum::<f32>() * park.euros / 3600.0;
                self.parking_pay[p][h] = if n > 0.0 { euros / n } else { 0.0 };
                paid += HOURLY[h] * euros;
                trips += HOURLY[h] * n;
            }
            self.parking_mean[p] = if trips > 0.0 { paid / trips } else { 0.0 };
        }
    }

    /// What a car trip ending in each parking area pays on average (€), as estimated.
    pub fn parking_mean(&self) -> &[f32] {
        &self.parking_mean
    }

    /// A car trip that set off at `depart` (s) ended on edge `e`: it pays the parking
    /// surcharges of the areas it ends in.
    pub fn arrived(&mut self, e: u32, depart: f64) {
        let start = self.parking_by_edge.partition_point(|&(x, _)| x < e);
        let hour = (depart.rem_euclid(86_400.0) / 3600.0) as usize % 24;
        for &(x, p) in &self.parking_by_edge[start..] {
            if x != e {
                break;
            }
            self.parking_arrivals += 1;
            self.parking_paid += self.parking_pay[p as usize][hour] as f64;
        }
    }

    /// Which charges and lorry bans apply at `time`; true if that changed since last asked.
    pub fn refresh(&mut self, time: f64) -> bool {
        let mut changed = false;
        for (policies, active) in [
            (&self.charges, &mut self.active),
            (&self.bans, &mut self.ban_active),
        ] {
            for (c, policy) in policies.iter().enumerate() {
                let now = policy.applies(time);
                if now != active[c] {
                    active[c] = now;
                    changed = true;
                }
            }
        }
        changed
    }

    /// Seconds lorry routes count for driving onto each edge for the lorry bans in force
    /// now, into `out` sized for the network's edges: for bans on every lorry, or (`heavy`)
    /// for those on heavy lorries alone (M21).
    pub fn ban_seconds(&self, out: &mut Vec<f32>, edges: usize, heavy: bool) {
        out.clear();
        out.resize(edges, 0.0);
        for &(e, b, _) in &self.ban_by_edge {
            let light = self.ban_tonnes[b as usize] < LIGHT_LORRY_TONNES;
            if self.ban_active[b as usize] && (e as usize) < edges && light != heavy {
                out[e as usize] += BAN_SECONDS;
            }
        }
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

    /// A car or lorry (`weight`: a lorry's, t; 0 for a car) drove onto edge `e`: it pays the
    /// charges in force for the areas it leads into, and lorries driving into an area banned
    /// to them are counted.
    pub fn entered(&mut self, e: u32, weight: f32) {
        if weight > 0.0 && !self.bans.is_empty() {
            let start = self.ban_by_edge.partition_point(|&(x, _, _)| x < e);
            let into = self.ban_by_edge[start..]
                .iter()
                .take_while(|&&(x, _, _)| x == e)
                .any(|&(_, b, into)| {
                    into && self.ban_active[b as usize] && weight > self.ban_tonnes[b as usize]
                });
            if into {
                self.lorries_in += 1;
            }
        }
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
        if self.charges.iter().all(|c| c.euros <= 0.0)
            && self.parking_mean.iter().all(|&m| m <= 0.0)
        {
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
        // Parking: a round trip that parks in the area pays once, half on each leg: the leg
        // that ends there, and the leg that leaves it for outside.
        for (park, &mean) in self.parking.iter().zip(&self.parking_mean) {
            let is_in: Vec<bool> = centres.iter().map(|&p| inside(&park.area, p)).collect();
            let leg = 0.5 * mean * SECONDS_PER_EURO;
            for o in 0..n {
                for d in 0..n {
                    if is_in[d] || is_in[o] {
                        extra[o * n + d] += leg;
                    }
                }
            }
        }
        Some(extra)
    }
}
