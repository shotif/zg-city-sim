//! Public transport's riders, and the car trips they take off the roads or put back (M9d).
//!
//! The map is cut into squares of `ZONE` metres; those with homes or jobs are zones. Public
//! transport's journey between two zones is a generalised time from the timetable as it runs
//! in the morning peak (`PEAK`), frequency-based: walk to a stop (`ACCESS` at most, as the
//! crow flies), wait half the headway (at most `WAIT_CAP`), board (`BOARDING`), ride, change
//! (a walk of `TRANSFER` at most, another wait and boarding), and walk from the last stop.
//! Where several lines run between two stops, riders take the first of those worth taking
//! (common lines, as in Spiess and Florian's optimal strategies, M10c): they wait half the
//! lines' combined headway, and the lines share them by how often each runs.
//! Walking and waiting count `WALK_WEIGHT` and `WAIT_WEIGHT` times. A car's is estimated
//! from the distance between the zones. A logit on the two splits motorised trips between
//! them (`ASC`, `BETA`). A car's journey between two zones is the quickest way on the roads
//! as a day run had them in the morning peak (M10d: `Network::edge_peak`), from the busiest
//! street of one zone to that of the other, plus time to park and walk (`CAR_TERMINAL`); the
//! engine works the times out a few zones a step (`Riders::car_origin`), again when edits
//! change the roads.
//!
//! The car trips are the demand's (`Demand::expected_od`); the trips by public transport are
//! those the split adds to them. When edits change public transport, each zone pair's car
//! trips are kept (or added to) in the ratio of the car's share then to its share today, an
//! incremental logit: without edits nothing is drawn and the traffic stays as calibrated.
//! The figures are estimates: the weights, penalties, car times and `BETA` are typical
//! values, not measured in Zagreb; `ASC` is calibrated to the Transport Master Plan's split.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::Arc;

use crate::demand::{Demand, Shift};
use crate::network::Network;
use crate::rng::Rng;
use crate::transit::TransitData;

/// Zones are squares this wide (m).
pub const ZONE: f32 = 1_000.0;
/// The morning peak whose service the journey times use (s after midnight).
pub const PEAK: (f32, f32) = (6.5 * 3600.0, 8.5 * 3600.0);
/// Walking: speed (m/s), the way walked over the crow's, how far to a stop from a zone's
/// centre and between stops to change (m, as the crow flies).
pub const WALK_SPEED: f32 = 1.25;
pub const WALK_DETOUR: f32 = 1.3;
pub const ACCESS: f32 = 1_000.0;
pub const TRANSFER: f32 = 250.0;
/// How much a minute walking or waiting counts against one riding, the longest wait
/// counted (s) and each boarding's penalty (s).
pub const WALK_WEIGHT: f32 = 2.0;
pub const WAIT_WEIGHT: f32 = 2.0;
pub const WAIT_CAP: f32 = 900.0;
pub const BOARDING: f32 = 180.0;
/// A car's journey where the roads do not join two zones: the road's length over the crow's,
/// mean speed in the peak (m/s), and time parking and walking at both ends (s).
pub const CAR_DETOUR: f32 = 1.3;
pub const CAR_SPEED: f32 = 30.0 / 3.6;
pub const CAR_EXTRA: f32 = 480.0;
/// Time to park and walk at both ends of a car's journey on the roads (s; an estimate).
pub const CAR_TERMINAL: f32 = 300.0;
/// Zones whose car journeys the engine works out each simulation step.
pub const CAR_ORIGINS_PER_STEP: usize = 4;
/// The logit: utility per generalised minute, and public transport's constant (calibrated:
/// 45.8 % of motorised trips within the City by public transport).
pub const BETA: f32 = 0.04;
pub const ASC: f32 = 1.717;
/// Trips drawn for the expected car trips by zone pair.
pub const OD_SAMPLES: usize = 500_000;
/// Origins whose journeys are worked out each simulation step.
pub const ORIGINS_PER_STEP: usize = 8;
/// A demand edge in no zone.
pub const NO_ZONE: u32 = u32::MAX;
const NONE: u32 = u32::MAX;
/// Marks an arc that boards the first of several lines (`Graph::bundle_first`).
const BUNDLE: u32 = 1 << 31;

/// The zones: squares of `ZONE` m with homes or jobs, their centres (weighted by them) and
/// the City's district most of them are in (`districts` of them; that value outside).
pub struct Zones {
    cell: HashMap<(i32, i32), u32>,
    pub centre: Vec<(f32, f32)>,
    pub district: Vec<u8>,
    /// Each zone's busiest street (its demand edge with the most homes and jobs), where its
    /// car journeys start and end.
    pub edge: Vec<u32>,
}

fn cell_of((x, z): (f32, f32), size: f32) -> (i32, i32) {
    ((x / size).floor() as i32, (z / size).floor() as i32)
}

impl Zones {
    /// Zones of the places in `pos` (on `edges`) weighted by `weight`, with their districts
    /// if known.
    pub fn new(
        edges: &[u32],
        pos: &[(f32, f32)],
        weight: &[f32],
        district: Option<&[u8]>,
    ) -> Zones {
        let mut cell = HashMap::new();
        let mut sum: Vec<(f64, f64, f64)> = Vec::new();
        let mut votes: Vec<HashMap<u8, f32>> = Vec::new();
        let mut busiest: Vec<(u32, f64)> = Vec::new();
        for (i, &p) in pos.iter().enumerate() {
            let next = cell.len() as u32;
            let z = *cell.entry(cell_of(p, ZONE)).or_insert(next) as usize;
            if z == sum.len() {
                sum.push((0.0, 0.0, 0.0));
                votes.push(HashMap::new());
                busiest.push((NONE, -1.0));
            }
            let w = weight.get(i).copied().unwrap_or(0.0).max(1e-3) as f64;
            if w > busiest[z].1 {
                busiest[z] = (edges.get(i).copied().unwrap_or(NONE), w);
            }
            sum[z].0 += p.0 as f64 * w;
            sum[z].1 += p.1 as f64 * w;
            sum[z].2 += w;
            if let Some(d) = district.and_then(|d| d.get(i)) {
                *votes[z].entry(*d).or_insert(0.0) += w as f32;
            }
        }
        let centre = sum
            .iter()
            .map(|&(x, z, w)| ((x / w) as f32, (z / w) as f32))
            .collect();
        let district = votes
            .iter()
            .map(|v| {
                v.iter()
                    .max_by(|a, b| a.1.total_cmp(b.1))
                    .map_or(u8::MAX, |(&d, _)| d)
            })
            .collect();
        Zones {
            cell,
            centre,
            district,
            edge: busiest.iter().map(|&(e, _)| e).collect(),
        }
    }

    pub fn len(&self) -> usize {
        self.centre.len()
    }

    pub fn is_empty(&self) -> bool {
        self.centre.is_empty()
    }

    /// The zone a place is in (`NO_ZONE`: none).
    pub fn of(&self, p: (f32, f32)) -> u32 {
        self.cell.get(&cell_of(p, ZONE)).copied().unwrap_or(NO_ZONE)
    }

    /// A car's time (s) between two zones estimated from the distance between them, where
    /// the roads do not join them.
    pub fn distance_time(&self, a: usize, b: usize) -> f32 {
        let (p, q) = (self.centre[a], self.centre[b]);
        let d = ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt();
        d * CAR_DETOUR / CAR_SPEED + CAR_EXTRA
    }
}

/// Public transport's share of motorised trips with these generalised times (s; infinite
/// for none).
pub fn pt_share(pt: f32, car: f32) -> f32 {
    share_with(ASC, pt, car)
}

fn share_with(asc: f32, pt: f32, car: f32) -> f32 {
    if !pt.is_finite() {
        return 0.0;
    }
    1.0 / (1.0 + (-(asc - BETA * (pt - car) / 60.0)).exp())
}

/// The public transport network as it runs in the peak, for journeys: stops (walking), and
/// each stop pattern's stops (riding). Arcs in compressed rows.
pub struct Graph {
    stops: usize,
    stop_pos: Vec<(f32, f32)>,
    stop_cells: HashMap<(i32, i32), Vec<u32>>,
    first: Vec<u32>,
    head: Vec<u32>,
    cost: Vec<f32>,
    /// Each arc's time as it passes (s): walking and waiting not weighted, no boarding
    /// penalty (M9e: journey times to show).
    plain: Vec<f32>,
    /// The pattern an arc boards, or `BUNDLE` and the lines it boards the first of (`NONE`
    /// for other arcs).
    board: Vec<u32>,
    /// Each bundle's lines, in `bundle_pattern` from `bundle_first`, and their shares.
    bundle_first: Vec<u32>,
    bundle_pattern: Vec<u32>,
    bundle_share: Vec<f32>,
    /// Each pattern's route (the timetable's, or a new line's).
    pub pattern_route: Vec<u16>,
}

impl Graph {
    /// The network of `trips` of `data` (stops placed on `net`): patterns by route and
    /// stops, each with its trips leaving its first stop in the peak; their headway, and
    /// times between stops from the one leaving nearest the peak's middle.
    pub fn new(net: &Network, data: &TransitData, trips: impl Iterator<Item = u32>) -> Graph {
        let mut stop_id: HashMap<(u32, u32), u32> = HashMap::new();
        let mut stop_pos = Vec::new();
        let mut patterns: HashMap<(u16, Vec<u32>), (u32, u32, f32)> = HashMap::new();
        let middle = (PEAK.0 + PEAK.1) / 2.0;
        for t in trips {
            let range = data.stops(t);
            let start = data.stop_time[range.start];
            let mut ids = Vec::with_capacity(range.len());
            for i in range {
                let (edge, frac) = (data.stop_edge[i], data.stop_frac[i]);
                let key = (edge, (frac * 1000.0).round() as u32);
                let next = stop_id.len() as u32;
                let id = *stop_id.entry(key).or_insert_with(|| {
                    let lane = net.d.edge_lane_start[edge as usize];
                    let s = frac * net.d.lane_length[lane as usize];
                    let [x, _, z, _] = net.sample(lane, s, 0.0);
                    stop_pos.push((x, z));
                    next
                });
                if ids.last() != Some(&id) {
                    ids.push(id);
                }
            }
            if ids.len() < 2 {
                continue;
            }
            let entry = patterns
                .entry((data.trip_route[t as usize], ids))
                .or_insert((0, NONE, f32::INFINITY));
            if (PEAK.0..PEAK.1).contains(&start) {
                entry.0 += 1;
                if (start - middle).abs() < entry.2 {
                    *entry = (entry.0, t, (start - middle).abs());
                }
            }
        }
        let stops = stop_pos.len();
        let mut arcs: Vec<Vec<(u32, f32, u32, f32)>> = vec![Vec::new(); stops];
        let mut pattern_route = Vec::new();
        let mut shared: Vec<(u32, u32, u32, f32)> = Vec::new();
        let mut frequency: Vec<f32> = Vec::new();
        let mut keys: Vec<_> = patterns.into_iter().filter(|(_, v)| v.0 > 0).collect();
        keys.sort_by(|a, b| a.0.cmp(&b.0));
        for ((route, ids), (count, rep, _)) in keys {
            let p = pattern_route.len() as u32;
            pattern_route.push(route);
            let headway = (PEAK.1 - PEAK.0) / count as f32;
            let waiting = (headway / 2.0).min(WAIT_CAP);
            let wait = WAIT_WEIGHT * waiting + BOARDING;
            // The rep trip's times at its stops (stops repeated on one spot count once).
            let range = data.stops(rep);
            let mut times = Vec::with_capacity(ids.len());
            let mut last = NONE;
            for i in range {
                let key = (
                    data.stop_edge[i],
                    (data.stop_frac[i] * 1000.0).round() as u32,
                );
                let id = stop_id[&key];
                if id != last {
                    times.push(data.stop_time[i]);
                    last = id;
                } else if let Some(t) = times.last_mut() {
                    *t = data.stop_time[i];
                }
            }
            // Rides between every two of its stops, for lines sharing them (below).
            let mut at = 0.0;
            let mut rides = Vec::with_capacity(ids.len());
            for k in 0..ids.len() {
                if k > 0 {
                    at += (times[k] - times[k - 1]).max(30.0);
                }
                rides.push(at);
            }
            for k in 0..ids.len() {
                for m in k + 1..ids.len() {
                    shared.push((ids[k], ids[m], p, rides[m] - rides[k]));
                }
            }
            frequency.push(count as f32 / (PEAK.1 - PEAK.0));
            let base = arcs.len() as u32;
            for (k, &s) in ids.iter().enumerate() {
                let node = base + k as u32;
                arcs.push(Vec::new());
                if k + 1 < ids.len() {
                    arcs[s as usize].push((node, wait, p, waiting));
                    let ride = (times[k + 1] - times[k]).max(30.0);
                    arcs[node as usize].push((node + 1, ride, NONE, ride));
                }
                if k > 0 {
                    arcs[node as usize].push((s, 0.0, NONE, 0.0));
                }
            }
        }
        // Common lines: where two or more lines run from one stop to another, an arc boards
        // the first of those worth taking.
        let mut bundles = Bundles::default();
        // Rides are positive, so their bits sort as they do.
        shared.sort_unstable_by_key(|a| (a.0, a.1, a.3.to_bits()));
        for group in shared.chunk_by(|a, b| (a.0, a.1) == (b.0, b.1)) {
            if group.len() < 2 {
                continue;
            }
            if let Some((cost, plain)) = bundles.add(group, &frequency) {
                let b = BUNDLE | (bundles.first.len() as u32 - 2);
                arcs[group[0].0 as usize].push((group[0].1, cost, b, plain));
            }
        }
        drop(shared);
        // Changing on foot between stops near each other.
        let mut stop_cells: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for (s, &p) in stop_pos.iter().enumerate() {
            stop_cells
                .entry(cell_of(p, TRANSFER))
                .or_default()
                .push(s as u32);
        }
        let near = |p: (f32, f32), r: f32, cells: &HashMap<(i32, i32), Vec<u32>>| {
            let (cx, cz) = cell_of(p, TRANSFER);
            let reach = (r / TRANSFER).ceil() as i32;
            let mut out = Vec::new();
            for dx in -reach..=reach {
                for dz in -reach..=reach {
                    for &s in cells.get(&(cx + dx, cz + dz)).into_iter().flatten() {
                        let q = stop_pos[s as usize];
                        let d = ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt();
                        if d <= r {
                            out.push((s, d));
                        }
                    }
                }
            }
            out
        };
        for s in 0..stops {
            for (t, d) in near(stop_pos[s], TRANSFER, &stop_cells) {
                if t as usize != s {
                    arcs[s].push((t, walk(d), NONE, walk(d) / WALK_WEIGHT));
                }
            }
        }
        let mut first = Vec::with_capacity(arcs.len() + 1);
        let (mut head, mut cost, mut board, mut plain) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        first.push(0);
        for list in &arcs {
            for &(h, c, b, t) in list {
                head.push(h);
                cost.push(c);
                board.push(b);
                plain.push(t);
            }
            first.push(head.len() as u32);
        }
        Graph {
            stops,
            stop_pos,
            stop_cells,
            first,
            head,
            cost,
            plain,
            board,
            bundle_first: bundles.first,
            bundle_pattern: bundles.pattern,
            bundle_share: bundles.share,
            pattern_route,
        }
    }

    /// The lines arc `a` boards, with each one's share of its riders.
    fn boards(&self, a: usize) -> impl Iterator<Item = (u32, f32)> + '_ {
        let b = self.board[a];
        let (single, range) = if b == NONE {
            (None, 0..0)
        } else if b & BUNDLE != 0 {
            let k = (b & !BUNDLE) as usize;
            (
                None,
                self.bundle_first[k] as usize..self.bundle_first[k + 1] as usize,
            )
        } else {
            (Some((b, 1.0)), 0..0)
        };
        single
            .into_iter()
            .chain(range.map(|i| (self.bundle_pattern[i], self.bundle_share[i])))
    }

    /// Journey times (s, as they pass: walking, waiting, riding) between every two of
    /// `points`, by the way with the least generalised time; infinite where there is none,
    /// 0 from a place to itself.
    pub fn journeys(&self, points: &[(f32, f32)]) -> Vec<f32> {
        let n = points.len();
        let access: Vec<Vec<(u32, f32)>> = points.iter().map(|&p| self.access(p)).collect();
        let nodes = self.nodes();
        let (mut dist, mut time) = (vec![f32::INFINITY; nodes], vec![0f32; nodes]);
        let mut out = vec![f32::INFINITY; n * n];
        for (o, from) in access.iter().enumerate() {
            dist.fill(f32::INFINITY);
            let mut heap = BinaryHeap::new();
            for &(s, c) in from {
                if c < dist[s as usize] {
                    dist[s as usize] = c;
                    time[s as usize] = c / WALK_WEIGHT;
                    heap.push(Reverse((c.to_bits(), s)));
                }
            }
            while let Some(Reverse((bits, v))) = heap.pop() {
                let d = f32::from_bits(bits);
                if d > dist[v as usize] {
                    continue;
                }
                for a in self.first[v as usize] as usize..self.first[v as usize + 1] as usize {
                    let h = self.head[a] as usize;
                    let nd = d + self.cost[a];
                    if nd < dist[h] {
                        dist[h] = nd;
                        time[h] = time[v as usize] + self.plain[a];
                        heap.push(Reverse((nd.to_bits(), h as u32)));
                    }
                }
            }
            for (d, to) in access.iter().enumerate() {
                if d == o {
                    out[o * n + d] = 0.0;
                    continue;
                }
                let best = to
                    .iter()
                    .map(|&(s, c)| (dist[s as usize] + c, time[s as usize] + c / WALK_WEIGHT))
                    .min_by(|a, b| a.0.total_cmp(&b.0));
                if let Some((g, t)) = best
                    && g.is_finite()
                {
                    out[o * n + d] = t;
                }
            }
        }
        out
    }

    pub fn nodes(&self) -> usize {
        self.first.len() - 1
    }

    pub fn stops(&self) -> usize {
        self.stops
    }

    /// Stops within `ACCESS` of a place, with the generalised time to walk there (s).
    fn access(&self, p: (f32, f32)) -> Vec<(u32, f32)> {
        let (cx, cz) = cell_of(p, TRANSFER);
        let reach = (ACCESS / TRANSFER).ceil() as i32;
        let mut out = Vec::new();
        for dx in -reach..=reach {
            for dz in -reach..=reach {
                for &s in self
                    .stop_cells
                    .get(&(cx + dx, cz + dz))
                    .into_iter()
                    .flatten()
                {
                    let q = self.stop_pos[s as usize];
                    let d = ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt();
                    if d <= ACCESS {
                        out.push((s, walk(d)));
                    }
                }
            }
        }
        out
    }
}

/// Lines sharing stops, boarded as one (common lines, M10c).
struct Bundles {
    first: Vec<u32>,
    pattern: Vec<u32>,
    share: Vec<f32>,
}

impl Default for Bundles {
    fn default() -> Bundles {
        Bundles {
            first: vec![0],
            pattern: Vec::new(),
            share: Vec::new(),
        }
    }
}

impl Bundles {
    /// The lines worth taking from one stop to another, of those running there (`group`:
    /// stop, stop, pattern and ride, by ride), as a bundle if two or more are: its
    /// generalised time and its time as it passes (s). As in Spiess and Florian's optimal
    /// strategies, the quickest rides are taken while each lowers the time expected: half
    /// the combined headway waited, then the ride on whichever comes first.
    fn add(&mut self, group: &[(u32, u32, u32, f32)], frequency: &[f32]) -> Option<(f32, f32)> {
        let expected = |f: f32, fr: f32| {
            let waiting = (0.5 / f).min(WAIT_CAP);
            (WAIT_WEIGHT * waiting + BOARDING + fr / f, waiting + fr / f)
        };
        let (mut f, mut fr) = (0.0f32, 0.0f32);
        let mut taken: Vec<(u32, f32)> = Vec::new();
        for &(_, _, p, ride) in group {
            if taken.iter().any(|&(q, _)| q == p) {
                continue;
            }
            let fp = frequency[p as usize];
            if f > 0.0 && expected(f + fp, fr + fp * ride).0 >= expected(f, fr).0 {
                break;
            }
            f += fp;
            fr += fp * ride;
            taken.push((p, fp));
        }
        if taken.len() < 2 {
            return None;
        }
        for (p, fp) in taken {
            self.pattern.push(p);
            self.share.push(fp / f);
        }
        self.first.push(self.pattern.len() as u32);
        Some(expected(f, fr))
    }
}

/// The generalised time to walk `d` metres as the crow flies (s).
fn walk(d: f32) -> f32 {
    WALK_WEIGHT * d * WALK_DETOUR / WALK_SPEED
}

/// Journeys from every zone over a graph, a few origins at a time; and the trips by public
/// transport they make, boarding each route.
pub struct Skim {
    graph: Graph,
    access: Vec<Vec<(u32, f32)>>,
    next: usize,
    /// Generalised time (s) by zone pair; infinite where public transport does not go.
    pub time: Vec<f32>,
    /// Trips by public transport a weekday, all and boarding each route (by pattern).
    pub trips: f64,
    boardings: Vec<f64>,
    dist: Vec<f32>,
    pred: Vec<u32>,
    pred_arc: Vec<u32>,
}

impl Skim {
    fn new(graph: Graph, zones: &Zones) -> Skim {
        let access = zones.centre.iter().map(|&p| graph.access(p)).collect();
        let n = zones.len();
        let nodes = graph.nodes();
        let patterns = graph.pattern_route.len();
        Skim {
            graph,
            access,
            next: 0,
            time: vec![f32::INFINITY; n * n],
            trips: 0.0,
            boardings: vec![0.0; patterns],
            dist: vec![f32::INFINITY; nodes],
            pred: vec![NONE; nodes],
            pred_arc: vec![NONE; nodes],
        }
    }

    pub fn done(&self) -> bool {
        self.next >= self.access.len()
    }

    /// Boardings a weekday by route (`routes` of them).
    pub fn boardings_by_route(&self, routes: usize) -> Vec<f64> {
        let mut out = vec![0.0; routes];
        for (p, &b) in self.boardings.iter().enumerate() {
            let r = self.graph.pattern_route[p] as usize;
            if r < routes {
                out[r] += b;
            }
        }
        out
    }

    /// Journeys from the next `count` origins; the trips they make by public transport: `od`
    /// car trips by zone pair today, `car` the car's times now by zone pair, `base` public
    /// transport's and the car's times today (none: this is today's skim).
    fn advance(
        &mut self,
        count: usize,
        zones: &Zones,
        od: &[f32],
        car: &[f32],
        base: Option<(&[f32], &[f32])>,
    ) {
        let n = zones.len();
        for _ in 0..count {
            if self.done() {
                return;
            }
            let o = self.next;
            self.next += 1;
            self.search(o);
            let row = o * n;
            let mut best_stop = vec![NONE; n];
            for d in 0..n {
                if d == o {
                    continue;
                }
                let mut best = f32::INFINITY;
                for &(s, c) in &self.access[d] {
                    let t = self.dist[s as usize] + c;
                    if t < best {
                        best = t;
                        best_stop[d] = s;
                    }
                }
                self.time[row + d] = best;
            }
            // Trips by public transport: all motorised trips today (the car's over its
            // share) times public transport's share now; boarded along the quickest way.
            for d in 0..n {
                let trips = od[row + d];
                if trips <= 0.0 || d == o {
                    continue;
                }
                let k = row + d;
                let (pt_today, car_today) =
                    base.map_or((self.time[k], car[k]), |(p, c)| (p[k], c[k]));
                let all = trips / (1.0 - pt_share(pt_today, car_today)).max(1e-3);
                let pt = (all * pt_share(self.time[k], car[k])) as f64;
                if pt <= 0.0 || best_stop[d] == NONE {
                    continue;
                }
                self.trips += pt;
                let mut node = best_stop[d];
                let mut guard = 0;
                while self.pred[node as usize] != NONE && guard < 10_000 {
                    let arc = self.pred_arc[node as usize] as usize;
                    for (p, share) in self.graph.boards(arc) {
                        self.boardings[p as usize] += pt * share as f64;
                    }
                    node = self.pred[node as usize];
                    guard += 1;
                }
            }
        }
    }

    /// Generalised times from zone `o` to every node.
    fn search(&mut self, o: usize) {
        let g = &self.graph;
        self.dist.fill(f32::INFINITY);
        self.pred.fill(NONE);
        let mut heap = BinaryHeap::new();
        for &(s, c) in &self.access[o] {
            if c < self.dist[s as usize] {
                self.dist[s as usize] = c;
                heap.push(Reverse((c.to_bits(), s)));
            }
        }
        while let Some(Reverse((bits, v))) = heap.pop() {
            let d = f32::from_bits(bits);
            if d > self.dist[v as usize] {
                continue;
            }
            for a in g.first[v as usize] as usize..g.first[v as usize + 1] as usize {
                let h = g.head[a] as usize;
                let nd = d + g.cost[a];
                if nd < self.dist[h] {
                    self.dist[h] = nd;
                    self.pred[h] = v;
                    self.pred_arc[h] = a as u32;
                    heap.push(Reverse((nd.to_bits(), h as u32)));
                }
            }
        }
    }
}

/// What the app shows: trips by public transport a weekday today and now, car trips moved
/// to it (fewer: back to the car), and boardings by route today and now.
#[derive(Clone, Debug, Default)]
pub struct Summary {
    pub ready: bool,
    pub trips_today: f64,
    pub trips_now: f64,
    pub car_moved: f64,
    /// Car trips a weekday within the map at full demand today (M9e).
    pub car_today: f64,
    pub boardings_today: Vec<f64>,
    pub boardings_now: Vec<f64>,
}

/// Riders today and with the edits in force, worked out a few origins each step.
pub struct Riders {
    pub zones: Zones,
    /// Car trips a weekday at full demand by zone pair, as the demand draws them.
    od: Vec<f32>,
    /// Public transport's generalised times today, once worked out.
    today: Option<Vec<f32>>,
    job: Option<(Skim, bool)>,
    /// The network with the edits (none: as today) and whether the roads changed, waiting
    /// for today's to finish.
    waiting: Option<(Option<Graph>, bool)>,
    /// Car journey times by zone pair (s), today and with the edits (none: as today), and
    /// those being worked out: the times so far, the next zone and whether today's.
    car_today: Option<Vec<f32>>,
    car_now: Option<Vec<f32>>,
    car_job: Option<(Vec<f32>, usize, bool)>,
    /// The zone whose busiest street each edge is (`NO_ZONE`: none).
    edge_zone: Vec<u32>,
    /// Routes (for boardings by route).
    routes: usize,
    pub summary: Summary,
    /// Car trips now over today's by zone pair, once worked out (none: as today).
    pub factor: Option<Arc<Vec<f32>>>,
    /// Bumped whenever `factor` changes.
    pub version: u32,
    /// The networks journeys were last worked out on, today's and with the edits (none: as
    /// today), for journey times between places (M9e).
    graph_today: Option<Graph>,
    graph_now: Option<Graph>,
}

impl Riders {
    /// Riders for `demand`'s trips (districts by demand edge if known) on today's network
    /// `graph`; `routes` routes.
    pub fn new(demand: &Demand, district: Option<&[u8]>, graph: Graph, routes: usize) -> Riders {
        let (edges, pos) = demand.edges();
        let (home, work) = demand.weights_by_edge();
        let weight: Vec<f32> = edges
            .iter()
            .map(|&e| {
                home.get(e as usize).copied().unwrap_or(0.0)
                    + work.get(e as usize).copied().unwrap_or(0.0)
            })
            .collect();
        let district = district.filter(|d| d.len() == edges.len());
        let zones = Zones::new(edges, pos, &weight, district);
        let mut edge_zone = Vec::new();
        for (z, &e) in zones.edge.iter().enumerate() {
            if e != NONE {
                if e as usize >= edge_zone.len() {
                    edge_zone.resize(e as usize + 1, NO_ZONE);
                }
                edge_zone[e as usize] = z as u32;
            }
        }
        let n = zones.len();
        let zone: Vec<u32> = pos.iter().map(|&p| zones.of(p)).collect();
        let mut rng = Rng::new(0x005E_ED0D);
        let od = demand.expected_od(&zone, zones.len(), OD_SAMPLES, &mut rng);
        let skim = Skim::new(graph, &zones);
        Riders {
            zones,
            od,
            today: None,
            job: Some((skim, true)),
            waiting: None,
            car_today: None,
            car_now: None,
            car_job: Some((vec![f32::INFINITY; n * n], 0, true)),
            edge_zone,
            routes,
            summary: Summary::default(),
            factor: None,
            version: 0,
            graph_today: None,
            graph_now: None,
        }
    }

    /// Journey times by public transport (s, walking, waiting and riding) between every two
    /// of `points`, today and with the edits in force (as last worked out); none until
    /// today's are.
    pub fn journeys(&self, points: &[(f32, f32)]) -> Option<(Vec<f32>, Vec<f32>)> {
        let today = self.graph_today.as_ref()?;
        let times = today.journeys(points);
        let now = match &self.graph_now {
            Some(g) => g.journeys(points),
            None => times.clone(),
        };
        Some((times, now))
    }

    /// Public transport runs as `graph` now (none: as today), and the roads are as today or
    /// changed (`roads`; then `graph` is the network public transport runs on now, edited or
    /// not): work the journeys out again.
    pub fn set_now(&mut self, graph: Option<Graph>, roads: bool, routes: usize) {
        self.routes = self.routes.max(routes);
        if self.today.is_none() {
            self.waiting = Some((graph, roads));
            return;
        }
        let n = self.zones.len();
        self.car_now = None;
        self.car_job = roads.then(|| (vec![f32::INFINITY; n * n], 0, false));
        match graph {
            Some(g) => {
                let skim = Skim::new(g, &self.zones);
                self.job = Some((skim, false));
            }
            None => {
                self.job = None;
                self.graph_now = None;
                self.clear_now();
            }
        }
    }

    fn clear_now(&mut self) {
        self.summary.trips_now = self.summary.trips_today;
        self.summary.boardings_now = self.summary.boardings_today.clone();
        self.summary.car_moved = 0.0;
        if self.factor.take().is_some() {
            self.version += 1;
        }
    }

    /// The next zone whose car journeys are to be worked out, and its busiest street; none
    /// while none are.
    pub fn car_origin(&self) -> Option<(usize, u32)> {
        let (_, next, _) = self.car_job.as_ref()?;
        Some((*next, self.zones.edge[*next]))
    }

    /// The zone whose busiest street edge `e` is (`NO_ZONE`: none).
    pub fn zone_of_edge(&self, e: u32) -> u32 {
        self.edge_zone.get(e as usize).copied().unwrap_or(NO_ZONE)
    }

    /// The car journeys from zone `car_origin` gave: the time (s) to each zone's busiest
    /// street, infinite where the roads do not reach it.
    pub fn set_car_row(&mut self, times: &[f32]) {
        let Riders { car_job, zones, .. } = self;
        let Some((rows, next, _)) = car_job.as_mut() else {
            return;
        };
        let (n, o) = (zones.len(), *next);
        for d in 0..n {
            rows[o * n + d] = if d == o {
                0.0
            } else if times[d].is_finite() {
                times[d] + CAR_TERMINAL
            } else {
                zones.distance_time(o, d)
            };
        }
        *next += 1;
        if *next >= n {
            let (rows, _, today) = car_job.take().unwrap();
            if today {
                self.car_today = Some(rows);
            } else {
                self.car_now = Some(rows);
            }
        }
    }

    /// Work on the journeys (once the car's are worked out); true when the car trips'
    /// factors changed.
    pub fn advance(&mut self) -> bool {
        if self.car_job.is_some() {
            return false;
        }
        let Riders {
            job,
            zones,
            od,
            today,
            car_today,
            car_now,
            ..
        } = self;
        let (Some((skim, is_today)), Some(car_today)) = (job.as_mut(), car_today.as_deref()) else {
            return false;
        };
        let car = car_now.as_deref().unwrap_or(car_today);
        let base = if *is_today {
            None
        } else {
            today.as_deref().map(|t| (t, car_today))
        };
        skim.advance(ORIGINS_PER_STEP, zones, od, car, base);
        if !skim.done() {
            return false;
        }
        let (skim, is_today) = self.job.take().unwrap();
        let boardings = skim.boardings_by_route(self.routes);
        if is_today {
            self.summary.trips_today = skim.trips;
            self.summary.boardings_today = boardings;
            self.summary.car_today = self.od.iter().map(|&t| t as f64).sum();
            self.summary.ready = true;
            self.today = Some(skim.time);
            self.graph_today = Some(skim.graph);
            self.clear_now();
            if let Some((graph, roads)) = self.waiting.take() {
                self.set_now(graph, roads, self.routes);
            }
            return false;
        }
        let today = self.today.as_deref().unwrap_or(&[]);
        let car_today = self.car_today.as_deref().unwrap_or(&[]);
        let car_now = self.car_now.as_deref().unwrap_or(car_today);
        let n = self.zones.len();
        let mut factor = vec![1f32; n * n];
        let mut moved = 0.0;
        for o in 0..n {
            for d in 0..n {
                let k = o * n + d;
                if o == d || skim.time[k] == today[k] && car_now[k] == car_today[k] {
                    continue;
                }
                let before = pt_share(today[k], car_today[k]);
                let after = pt_share(skim.time[k], car_now[k]);
                factor[k] = ((1.0 - after) / (1.0 - before).max(1e-3)).min(2.0);
                moved += (self.od[k] / (1.0 - before).max(1e-3) * (after - before)) as f64;
            }
        }
        self.summary.trips_now = skim.trips;
        self.summary.boardings_now = boardings;
        self.summary.car_moved = moved;
        self.graph_now = Some(skim.graph);
        self.factor = Some(Arc::new(factor));
        self.version += 1;
        true
    }

    /// The demand's shift for its edges now (none: as today).
    pub fn shift_for(&self, demand: &Demand) -> Option<Shift> {
        let factor = self.factor.clone()?;
        let (_, pos) = demand.edges();
        Some(Shift {
            zone: pos.iter().map(|&p| self.zones.of(p)).collect(),
            zones: self.zones.len(),
            factor,
        })
    }

    /// Whether journeys are being worked out.
    pub fn busy(&self) -> bool {
        self.job.is_some() || self.waiting.is_some() || self.car_job.is_some()
    }

    /// For tests: the car's time today between two zones (s), once worked out.
    pub fn car_today(&self, o: usize, d: usize) -> f32 {
        let k = o * self.zones.len() + d;
        self.car_today.as_ref().map_or(f32::NAN, |t| t[k])
    }

    /// For tests: the car trips and public transport's time today between two zones.
    pub fn pair_today(&self, o: usize, d: usize) -> (f32, f32) {
        let k = o * self.zones.len() + d;
        (self.od[k], self.today.as_ref().map_or(f32::NAN, |t| t[k]))
    }

    /// For checking (M9d): within zones `within` takes, the car trips today with public
    /// transport between their zones and without, and their mean generalised times by car
    /// and public transport (min).
    pub fn reach_today(&self, within: impl Fn(u8) -> bool) -> Option<[f64; 4]> {
        let today = self.today.as_deref()?;
        let n = self.zones.len();
        let (mut with, mut without, mut car, mut pt) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for o in 0..n {
            for d in 0..n {
                let k = o * n + d;
                let w = self.od[k] as f64;
                if o == d
                    || w <= 0.0
                    || !within(self.zones.district[o])
                    || !within(self.zones.district[d])
                {
                    continue;
                }
                if today[k].is_finite() {
                    with += w;
                    car += w * self.car_today(o, d) as f64 / 60.0;
                    pt += w * today[k] as f64 / 60.0;
                } else {
                    without += w;
                }
            }
        }
        Some([with, without, car / with.max(1.0), pt / with.max(1.0)])
    }

    /// Public transport's share of motorised trips today between zones `within` takes (by
    /// their district), with constant `asc` (for calibrating `ASC`); none until worked out.
    pub fn share_today(&self, asc: f32, within: impl Fn(u8) -> bool) -> Option<f64> {
        let today = self.today.as_deref()?;
        let n = self.zones.len();
        let (mut pt, mut all) = (0.0f64, 0.0f64);
        for o in 0..n {
            if !within(self.zones.district[o]) {
                continue;
            }
            for d in 0..n {
                let k = o * n + d;
                if o == d || self.od[k] <= 0.0 || !within(self.zones.district[d]) {
                    continue;
                }
                let s = share_with(asc, today[k], self.car_today(o, d)) as f64;
                let total = self.od[k] as f64 / (1.0 - s).max(1e-3);
                pt += total * s;
                all += total;
            }
        }
        Some(pt / all.max(1.0))
    }
}
