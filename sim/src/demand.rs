//! Synthetic travel demand: car and truck trips between road edges weighted by where people
//! live and work, timed by a typical weekday profile, with destinations chosen by a gravity
//! model (nearer places are likelier).
//!
//! Traffic to, from and through places beyond the map enters and leaves at gateways, where
//! roads cross the map's edge: commuters coming in to work in the morning and going home in
//! the afternoon, residents doing the opposite, errands both ways, and through traffic
//! between two gateways (mostly on the motorway ring).

use std::cell::OnceCell;

use crate::engine::{Trip, trip};
use crate::network::{NONE, Network, vclass};
use crate::rng::Rng;
use crate::vtype;

/// Share of a weekday's car trips starting in each hour (%): the mean hourly profile of the
/// 33 Hrvatske ceste stations inside the map that are counted all year (2025, days outside
/// July and August; pipeline/data/hc_counts_2025.json). Traffic starts early, the morning
/// is flat from 06:00 to 08:00 and the afternoon peaks at 15:00, as Zagreb's working day
/// ends at 15:00-16:00. The charts average all days of the week, so a working day's peaks
/// are a little sharper.
pub const HOURLY: [f32; 24] = [
    0.50, 0.34, 0.32, 0.54, 1.60, 3.99, 5.92, 5.92, 5.38, 5.56, 5.80, 6.11, 6.45, 6.77, 7.46, 7.81,
    7.04, 5.85, 4.94, 4.06, 3.06, 2.19, 1.49, 0.90,
];

/// Shares of an hour's trips going from home to work and from work to home; the rest are
/// other errands. Over the day about 20 % of trips go to work and 22 % home.
fn purposes(hour: usize) -> (f32, f32) {
    match hour {
        4..=8 => (0.6, 0.05),
        9..=12 => (0.15, 0.1),
        13 => (0.1, 0.3),
        14..=17 => (0.05, 0.5),
        _ => (0.05, 0.15),
    }
}

/// Candidate destinations the gravity model chooses between: drawn by attractiveness, one
/// chosen by distance. Few candidates soften the distance decay; trips within the map and
/// on motorways across its edge are calibrated with 8.
const CANDIDATES: usize = 8;
/// Candidates for traffic across the map's edge on other roads: with 8, drawn from the
/// whole map's jobs and homes, a regional road's traffic at Zabok nearly all headed for
/// Zagreb, 25 km on.
const LOCAL_CANDIDATES: usize = 128;
/// Share of trips across the map's edge that are commutes (the rest are errands, business
/// and visits), and the share of those commuters who live beyond the map (the rest live
/// inside it and work beyond it).
const COMMUTE_SHARE: f32 = 0.55;
const COMMUTERS_FROM_OUTSIDE: f32 = 0.75;
/// Distance (m) over which places lose attractiveness by a factor e for trips across the
/// map's edge on motorways and expressways: people who come from far away mind the last
/// few kilometres less.
const GATEWAY_DECAY: f32 = 12_000.0;
/// The same for traffic across the map's edge on other roads, mostly between the towns on
/// either side of it.
/// Calibrated against the counts: 8 km cut gridlock by 15 % and brought the counts nearer
/// on the whole; 4 km left the counted roads with too little traffic.
pub const LOCAL_GATEWAY_DECAY: f32 = 8_000.0;
/// Roads at least this fast (m/s, 97 km/h) carry traffic from far away across the map's
/// edge: motorways and expressways.
const FAST_ROAD: f32 = 27.0;
/// Through traffic leaves at a gateway at least this far (m) from where it came in.
const THROUGH_MIN_DISTANCE: f32 = 10_000.0;
/// How much earlier (s) traffic coming in crosses the map's edge than the city's own trips
/// of the same purpose start: it still has 20-40 minutes to drive, and commuters from far
/// away set off early to be at work on time.
const INBOUND_LEAD: f64 = 2_700.0;
/// Share of through traffic that drives at the hours of city traffic; the rest is spread
/// evenly over the day (long-distance and freight traffic).
const THROUGH_PEAKED: f32 = 0.7;
/// Truck shares by day (6-20 h) and by night.
const TRUCKS: (f32, f32) = (0.06, 0.12);
const THROUGH_TRUCKS: (f32, f32) = (0.25, 0.5);

/// Where a road crosses the map's edge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gateway {
    /// Edge leading into the map (`NONE` if the road only leads out).
    pub entry: u32,
    /// Edge leading out of the map (`NONE` if the road only leads in).
    pub exit: u32,
    /// Vehicles crossing per day, both directions together.
    pub daily: f32,
    /// Share of them passing through: in here, out at another gateway.
    pub through: f32,
}

/// One kind of trip across the map's edge.
#[derive(Default)]
struct Flow {
    /// Cumulative weight of each gateway.
    cum: Vec<f64>,
    /// Trips per day.
    daily: f64,
    /// Share of the day's trips per hour, by purpose: commuting to work, going home, other.
    profile: [[f32; 3]; 24],
    acc: f64,
}

impl Flow {
    /// The profile at time `t`, interpolated between the middles of the hours.
    fn at(&self, t: f64) -> [f32; 3] {
        let x = (t / 3600.0 - 0.5).rem_euclid(24.0) as f32;
        let h0 = x.floor() as usize % 24;
        let f = x - x.floor();
        let (a, b) = (self.profile[h0], self.profile[(h0 + 1) % 24]);
        [0, 1, 2].map(|i| a[i] * (1.0 - f) + b[i] * f)
    }

    /// Number of trips starting in [t, t + dt), and the purpose shares at `t`.
    fn due(&mut self, t: f64, dt: f64, scale: f64) -> (u32, [f32; 3]) {
        let mix = self.at(t);
        let share: f32 = mix.iter().sum();
        self.acc += self.daily * share as f64 / 3600.0 * dt * scale;
        let n = self.acc.floor();
        self.acc -= n;
        (n as u32, mix)
    }
}

pub struct Demand {
    edges: Vec<u32>,
    pos: Vec<(f32, f32)>,
    truck_ok: Vec<bool>,
    home_cum: Vec<f64>,
    work_cum: Vec<f64>,
    any_cum: Vec<f64>,
    /// Trips per day within the map at scale 1.
    pub daily_trips: f64,
    /// Distance (m) over which destination attractiveness falls by a factor e.
    pub decay: f32,
    hourly_sum: f32,
    acc: f64,
    gateways: Vec<Gateway>,
    gateway_pos: Vec<(f32, f32)>,
    /// Per gateway: the distance decay and candidates its traffic's destinations are chosen
    /// with (fast roads or others).
    gateway_reach: Vec<(f32, usize)>,
    /// Distance decay for traffic across the map's edge on roads other than fast ones.
    pub local_gateway_decay: f32,
    entry_truck_ok: Vec<bool>,
    exit_truck_ok: Vec<bool>,
    inbound: Flow,
    outbound: Flow,
    through: Flow,
    /// Through traffic leaving at each gateway (vehicles per day).
    through_exit: Vec<f32>,
    /// Home and work weights by edge id, made when first asked for.
    by_edge: OnceCell<(Vec<f32>, Vec<f32>)>,
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

/// Index drawn in proportion to `weights`.
fn pick(weights: [f32; 3], rng: &mut Rng) -> usize {
    let mut x = rng.f32() * weights.iter().sum::<f32>();
    for (i, &w) in weights.iter().enumerate() {
        x -= w;
        if x < 0.0 {
            return i;
        }
    }
    2
}

fn distance(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn allows(net: &Network, edge: u32, class: u16) -> bool {
    net.edge_lanes(edge)
        .any(|l| net.d.lane_allow[l as usize] & class != 0)
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
        // Ignore entries for edges the network does not have (stale or mismatched data).
        let n = net.edge_count() as u32;
        let keep: Vec<usize> = (0..edges.len().min(home.len()).min(work.len()))
            .filter(|&i| edges[i] < n && !net.is_internal_edge(edges[i]))
            .collect();
        let edges: Vec<u32> = keep.iter().map(|&i| edges[i]).collect();
        let home: Vec<f32> = keep.iter().map(|&i| home[i]).collect();
        let work: Vec<f32> = keep.iter().map(|&i| work[i]).collect();
        let (home, work) = (&home[..], &work[..]);
        let pos = edges.iter().map(|&e| net.edge_mid[e as usize]).collect();
        let truck_ok = edges
            .iter()
            .map(|&e| allows(net, e, vclass::TRUCK))
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
            gateways: Vec::new(),
            gateway_pos: Vec::new(),
            gateway_reach: Vec::new(),
            local_gateway_decay: LOCAL_GATEWAY_DECAY,
            entry_truck_ok: Vec::new(),
            exit_truck_ok: Vec::new(),
            inbound: Flow::default(),
            outbound: Flow::default(),
            through: Flow::default(),
            through_exit: Vec::new(),
            by_edge: OnceCell::new(),
        }
    }

    /// Replace the home and work weights and the trips a day within the map, keeping the
    /// gateways and the decay: residents and jobs added while the simulation runs (the
    /// buildings that grow on zoned land). Gateway traffic's destinations and origins
    /// follow the new weights too.
    pub fn set_weights(
        &mut self,
        net: &Network,
        edges: Vec<u32>,
        home: &[f32],
        work: &[f32],
        daily_trips: f64,
    ) {
        let fresh = Demand::new(net, edges, home, work, daily_trips);
        self.edges = fresh.edges;
        self.pos = fresh.pos;
        self.truck_ok = fresh.truck_ok;
        self.home_cum = fresh.home_cum;
        self.work_cum = fresh.work_cum;
        self.any_cum = fresh.any_cum;
        self.daily_trips = daily_trips;
        self.by_edge = OnceCell::new();
    }

    /// The home and work weights by edge id (0 on edges without any; edges past the last
    /// with a weight are left out).
    pub fn weights_by_edge(&self) -> (&[f32], &[f32]) {
        let (home, work) = self.by_edge.get_or_init(|| {
            let n = self
                .edges
                .iter()
                .map(|&e| e as usize + 1)
                .max()
                .unwrap_or(0);
            let mut home = vec![0.0; n];
            let mut work = vec![0.0; n];
            let (mut h0, mut w0) = (0.0, 0.0);
            for (i, &e) in self.edges.iter().enumerate() {
                let (h1, w1) = (self.home_cum[i], self.work_cum[i]);
                home[e as usize] += (h1 - h0) as f32;
                work[e as usize] += (w1 - w0) as f32;
                (h0, w0) = (h1, w1);
            }
            (home, work)
        });
        (home, work)
    }

    /// Placeholder demand from the network alone: homes along local streets, work along
    /// main roads. Used until building-based weights are loaded.
    pub fn from_network(net: &Network, daily_trips: f64) -> Demand {
        let mut edges = Vec::new();
        let mut home = Vec::new();
        let mut work = Vec::new();
        for e in 0..net.edge_count() as u32 {
            if net.is_internal_edge(e) || !allows(net, e, vclass::PASSENGER) {
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

    /// Add traffic to, from and through places beyond the map. Gateways whose edges the
    /// network does not have, or that cars may not use, are ignored.
    pub fn set_gateways(&mut self, net: &Network, gateways: &[Gateway]) {
        let n = net.edge_count() as u32;
        let usable = |e: u32| {
            e != NONE && e < n && !net.is_internal_edge(e) && allows(net, e, vclass::PASSENGER)
        };
        self.gateways = gateways
            .iter()
            .map(|g| Gateway {
                entry: if usable(g.entry) { g.entry } else { NONE },
                exit: if usable(g.exit) { g.exit } else { NONE },
                daily: g.daily.max(0.0),
                through: g.through.clamp(0.0, 1.0),
            })
            .filter(|g| (g.entry != NONE || g.exit != NONE) && g.daily > 0.0)
            .collect();
        let gs = &self.gateways;
        self.gateway_pos = gs
            .iter()
            .map(|g| net.edge_mid[if g.entry != NONE { g.entry } else { g.exit } as usize])
            .collect();
        self.gateway_reach = gs
            .iter()
            .map(|g| {
                let e = if g.entry != NONE { g.entry } else { g.exit };
                if net.edge_speed[e as usize] >= FAST_ROAD {
                    (GATEWAY_DECAY, CANDIDATES)
                } else {
                    (self.local_gateway_decay, LOCAL_CANDIDATES)
                }
            })
            .collect();
        self.entry_truck_ok = gs
            .iter()
            .map(|g| g.entry != NONE && allows(net, g.entry, vclass::TRUCK))
            .collect();
        self.exit_truck_ok = gs
            .iter()
            .map(|g| g.exit != NONE && allows(net, g.exit, vclass::TRUCK))
            .collect();

        // Local traffic (not passing through) splits evenly between the two directions of
        // a two-way road; a one-way road carries it all one way.
        let share_in = |g: &Gateway| match (g.entry != NONE, g.exit != NONE) {
            (true, true) => 0.5,
            (true, false) => 1.0,
            _ => 0.0,
        };
        let inbound: Vec<f32> = gs
            .iter()
            .map(|g| g.daily * (1.0 - g.through) * share_in(g))
            .collect();
        let outbound: Vec<f32> = gs
            .iter()
            .map(|g| g.daily * (1.0 - g.through) * (1.0 - share_in(g)))
            .collect();
        let through_in: Vec<f32> = gs
            .iter()
            .map(|g| g.daily * g.through * share_in(g))
            .collect();
        let through_out: Vec<f32> = gs
            .iter()
            .map(|g| g.daily * g.through * (1.0 - share_in(g)))
            .collect();

        // Hourly profiles by purpose, from the city's own: commuters from beyond the map
        // come in for work in the morning and go home in the afternoon; residents who work
        // beyond the map do the opposite.
        let mut hw = [0f32; 24];
        let mut wh = [0f32; 24];
        let mut other = [0f32; 24];
        for h in 0..24 {
            let (to_work, to_home) = purposes(h);
            hw[h] = HOURLY[h] * to_work;
            wh[h] = HOURLY[h] * to_home;
            other[h] = HOURLY[h] * (1.0 - to_work - to_home);
        }
        let (hw_sum, wh_sum, other_sum): (f32, f32, f32) =
            (hw.iter().sum(), wh.iter().sum(), other.iter().sum());
        let (c, a) = (COMMUTE_SHARE, COMMUTERS_FROM_OUTSIDE);
        let mut profile_in = [[0f32; 3]; 24];
        let mut profile_out = [[0f32; 3]; 24];
        let mut profile_through = [[0f32; 3]; 24];
        for h in 0..24 {
            let other = (1.0 - c) * other[h] / other_sum;
            profile_in[h] = [
                c * a * hw[h] / hw_sum,
                c * (1.0 - a) * wh[h] / wh_sum,
                other,
            ];
            profile_out[h] = [
                c * (1.0 - a) * hw[h] / hw_sum,
                c * a * wh[h] / wh_sum,
                other,
            ];
            profile_through[h][2] =
                THROUGH_PEAKED * HOURLY[h] / self.hourly_sum + (1.0 - THROUGH_PEAKED) / 24.0;
        }
        let total = |w: &[f32]| w.iter().map(|&x| x as f64).sum::<f64>();
        self.inbound = Flow {
            daily: total(&inbound),
            cum: cumulative(&inbound),
            profile: profile_in,
            acc: 0.0,
        };
        self.outbound = Flow {
            daily: total(&outbound),
            cum: cumulative(&outbound),
            profile: profile_out,
            acc: 0.0,
        };
        self.through = Flow {
            daily: total(&through_in),
            cum: cumulative(&through_in),
            profile: profile_through,
            acc: 0.0,
        };
        self.through_exit = through_out;
    }

    /// Trips per day into, out of and through the map at scale 1.
    pub fn gateway_trips(&self) -> (f64, f64, f64) {
        (self.inbound.daily, self.outbound.daily, self.through.daily)
    }

    /// Share of the day's trips per hour at time `t` (s since midnight), interpolated.
    fn hourly_share(&self, t: f64) -> f32 {
        let x = (t / 3600.0 - 0.5).rem_euclid(24.0) as f32;
        let h0 = x.floor() as usize % 24;
        let f = x - x.floor();
        (HOURLY[h0] * (1.0 - f) + HOURLY[(h0 + 1) % 24] * f) / self.hourly_sum
    }

    /// Trips per second within the map at time `t`.
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
        self.generate_local(t, dt, scale, rng, emit);
        self.generate_gateways(t, dt, scale, rng, emit);
    }

    fn generate_local(
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
        let hour = ((t / 3600.0).rem_euclid(24.0)) as usize;
        let (to_work, to_home) = purposes(hour);
        let truck_share = if (6..20).contains(&hour) {
            TRUCKS.0
        } else {
            TRUCKS.1
        };
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
            let Some(d) = self.near(self.pos[o], o, to_cum, self.decay, CANDIDATES, rng) else {
                continue;
            };
            let truck = rng.f32() < truck_share && self.truck_ok[o] && self.truck_ok[d];
            emit(Trip {
                depart: t + rng.f64() * dt,
                from: self.edges[o],
                to: self.edges[d],
                vtype: if truck { vtype::TRUCK } else { vtype::CAR },
                flags: 0,
            });
        }
    }

    fn generate_gateways(
        &mut self,
        t: f64,
        dt: f64,
        scale: f64,
        rng: &mut Rng,
        emit: &mut dyn FnMut(Trip),
    ) {
        if self.gateways.is_empty() || self.edges.is_empty() {
            return;
        }
        let day = (6..20).contains(&((t / 3600.0).rem_euclid(24.0) as u32));
        let (trucks, through_trucks) = if day {
            (TRUCKS.0, THROUGH_TRUCKS.0)
        } else {
            (TRUCKS.1, THROUGH_TRUCKS.1)
        };
        let vtype = |truck: bool| if truck { vtype::TRUCK } else { vtype::CAR };

        // Into the map: commuters to work, residents coming home, everyone else.
        let (n, mix) = self.inbound.due(t + INBOUND_LEAD, dt, scale);
        for _ in 0..n {
            let Some(g) = sample(&self.inbound.cum, rng) else {
                break;
            };
            let cum = [&self.work_cum, &self.home_cum, &self.any_cum][pick(mix, rng)];
            let (decay, candidates) = self.gateway_reach[g];
            let Some(d) = self.near(self.gateway_pos[g], usize::MAX, cum, decay, candidates, rng)
            else {
                continue;
            };
            let truck = rng.f32() < trucks && self.entry_truck_ok[g] && self.truck_ok[d];
            emit(Trip {
                depart: t + rng.f64() * dt,
                from: self.gateways[g].entry,
                to: self.edges[d],
                vtype: vtype(truck),
                flags: trip::ENTER,
            });
        }

        // Out of the map: residents to work, commuters going home, everyone else.
        let (n, mix) = self.outbound.due(t, dt, scale);
        for _ in 0..n {
            let Some(g) = sample(&self.outbound.cum, rng) else {
                break;
            };
            let cum = [&self.home_cum, &self.work_cum, &self.any_cum][pick(mix, rng)];
            let (decay, candidates) = self.gateway_reach[g];
            let Some(o) = self.near(self.gateway_pos[g], usize::MAX, cum, decay, candidates, rng)
            else {
                continue;
            };
            let truck = rng.f32() < trucks && self.exit_truck_ok[g] && self.truck_ok[o];
            emit(Trip {
                depart: t + rng.f64() * dt,
                from: self.edges[o],
                to: self.gateways[g].exit,
                vtype: vtype(truck),
                flags: trip::EXIT,
            });
        }

        // Through the map, between gateways far enough apart.
        let (n, _) = self.through.due(t, dt, scale);
        for _ in 0..n {
            let Some(g) = sample(&self.through.cum, rng) else {
                break;
            };
            let Some(h) = self.far_exit(g, rng) else {
                continue;
            };
            let truck =
                rng.f32() < through_trucks && self.entry_truck_ok[g] && self.exit_truck_ok[h];
            emit(Trip {
                depart: t + rng.f64() * dt,
                from: self.gateways[g].entry,
                to: self.gateways[h].exit,
                vtype: vtype(truck),
                flags: trip::ENTER | trip::EXIT,
            });
        }
    }

    /// A gateway for through traffic from gateway `g` to leave by, drawn in proportion to
    /// the through traffic leaving there, among those at least `THROUGH_MIN_DISTANCE` away.
    fn far_exit(&self, g: usize, rng: &mut Rng) -> Option<usize> {
        let from = self.gateway_pos[g];
        let far = |h: &usize| distance(from, self.gateway_pos[*h]) >= THROUGH_MIN_DISTANCE;
        let n = self.gateways.len();
        let total: f64 = (0..n)
            .filter(far)
            .map(|h| self.through_exit[h] as f64)
            .sum();
        if total <= 0.0 {
            return None;
        }
        let mut x = rng.f64() * total;
        let mut last = None;
        for h in (0..n).filter(far) {
            if self.through_exit[h] <= 0.0 {
                continue;
            }
            x -= self.through_exit[h] as f64;
            last = Some(h);
            if x < 0.0 {
                break;
            }
        }
        last
    }

    /// Gravity model: draw candidates by attractiveness (`cum`), keep one weighted by its
    /// distance from `from`. `exclude` (an index into the demand edges) is never chosen.
    fn near(
        &self,
        from: (f32, f32),
        exclude: usize,
        cum: &[f64],
        decay: f32,
        candidates: usize,
        rng: &mut Rng,
    ) -> Option<usize> {
        let candidates = candidates.min(LOCAL_CANDIDATES);
        let mut cand = [0usize; LOCAL_CANDIDATES];
        let mut weight = [0f32; LOCAL_CANDIDATES];
        let mut total = 0.0;
        let mut n = 0;
        for _ in 0..candidates * 2 {
            if n == candidates {
                break;
            }
            let c = sample(cum, rng)?;
            if c == exclude {
                continue;
            }
            let w = (-distance(from, self.pos[c]) / decay).exp() + 1e-9;
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
