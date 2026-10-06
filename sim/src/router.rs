//! Shortest-time routes over the edge graph: A* with landmark lower bounds (ALT).
//!
//! Edge costs are the engine's current travel-time estimates plus turn penalties, so routes
//! avoid congestion the simulation has measured. The heuristic uses travel times to and
//! from a dozen landmarks on the edge of the network, computed once at free-flow speed;
//! congestion only makes edges slower, so the bounds stay valid. The search state is reused
//! between queries: an epoch counter marks which entries belong to the current search.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::network::{NONE, Network};

/// Speed (m/s) the straight-line part of the heuristic divides distance by: faster than
/// any road, so it never overestimates.
const HEURISTIC_SPEED: f32 = 40.0;
/// Give up after this many settled edges (keeps a bad query from stalling a step).
const MAX_SETTLED: usize = 400_000;
/// Weight on the distance estimate (weighted A*): routes may be up to this factor slower
/// than the fastest, in exchange for searching far fewer roads once traffic is heavy and
/// travel times exceed the free-flow estimate.
const HEURISTIC_WEIGHT: f32 = 1.2;
/// Landmarks for the ALT heuristic.
pub const LANDMARKS: usize = 12;
/// Unreachable in landmark tables.
const FAR: u16 = u16::MAX;

/// Travel times (whole seconds) between landmarks and every routable edge.
pub struct Landmarks {
    /// Compact index of each edge in the tables (NONE for junction-internal edges).
    slot: Vec<u32>,
    /// Per edge slot and landmark `l`: `table[(slot * count + l) * 2]` is the time from
    /// the landmark to the edge, `+ 1` the time from the edge to the landmark. One edge's
    /// values are contiguous, so a bound costs one or two cache lines.
    table: Vec<u16>,
    count: usize,
    pub edges: Vec<u32>,
}

impl Landmarks {
    /// Pick landmarks spread around the network's edge and compute their tables.
    pub fn build(net: &Network, free_time: &[f32]) -> Landmarks {
        let n_edges = net.edge_count();
        let mut slot = vec![NONE; n_edges];
        let mut n = 0usize;
        for e in 0..n_edges {
            if !net.is_internal_edge(e as u32) {
                slot[e] = n as u32;
                n += 1;
            }
        }
        // Reverse graph for "time to the landmark".
        let mut pred_offset = vec![0u32; n_edges + 1];
        for e in 0..n_edges as u32 {
            for s in net.successors(e) {
                pred_offset[s.edge as usize + 1] += 1;
            }
        }
        for e in 0..n_edges {
            pred_offset[e + 1] += pred_offset[e];
        }
        let mut fill = pred_offset.clone();
        let mut pred = vec![(0u32, 0f32); pred_offset[n_edges] as usize];
        for e in 0..n_edges as u32 {
            for s in net.successors(e) {
                let i = &mut fill[s.edge as usize];
                // Cost of moving e -> s.edge is the time on s.edge plus the turn penalty.
                pred[*i as usize] = (e, free_time[s.edge as usize] + s.penalty);
                *i += 1;
            }
        }

        // Landmarks: in each of LANDMARKS sectors around the centre, the routable edge
        // furthest from it.
        let (mut cx, mut cz, mut m) = (0f64, 0f64, 0f64);
        for e in 0..n_edges {
            if slot[e] != NONE {
                cx += net.edge_mid[e].0 as f64;
                cz += net.edge_mid[e].1 as f64;
                m += 1.0;
            }
        }
        let (cx, cz) = ((cx / m.max(1.0)) as f32, (cz / m.max(1.0)) as f32);
        let mut best = [(NONE, -1f32); LANDMARKS];
        for e in 0..n_edges {
            if slot[e] == NONE || net.successors(e as u32).is_empty() {
                continue;
            }
            let (dx, dz) = (net.edge_mid[e].0 - cx, net.edge_mid[e].1 - cz);
            let angle = dz.atan2(dx) + std::f32::consts::PI;
            let sector =
                ((angle / std::f32::consts::TAU * LANDMARKS as f32) as usize).min(LANDMARKS - 1);
            let r = dx * dx + dz * dz;
            if r > best[sector].1 {
                best[sector] = (e as u32, r);
            }
        }
        let edges: Vec<u32> = best.iter().filter(|b| b.0 != NONE).map(|b| b.0).collect();
        let count = edges.len();

        let mut table = vec![FAR; count * n * 2];
        let mut dist = vec![f32::INFINITY; n_edges];
        let mut heap = BinaryHeap::new();
        for (l, &landmark) in edges.iter().enumerate() {
            for forward in [true, false] {
                dist.fill(f32::INFINITY);
                dist[landmark as usize] = 0.0;
                heap.clear();
                heap.push((Reverse(0f32.to_bits()), landmark));
                while let Some((Reverse(bits), e)) = heap.pop() {
                    let g = f32::from_bits(bits);
                    if g > dist[e as usize] {
                        continue;
                    }
                    let i = (slot[e as usize] as usize * count + l) * 2 + usize::from(!forward);
                    table[i] = g.min(FAR as f32 - 1.0) as u16;
                    let mut relax = |next: u32, cost: f32| {
                        let c = g + cost;
                        if c < dist[next as usize] {
                            dist[next as usize] = c;
                            heap.push((Reverse(c.to_bits()), next));
                        }
                    };
                    if forward {
                        for s in net.successors(e) {
                            relax(s.edge, free_time[s.edge as usize] + s.penalty);
                        }
                    } else {
                        let (a, b) = (
                            pred_offset[e as usize] as usize,
                            pred_offset[e as usize + 1] as usize,
                        );
                        for &(p, cost) in &pred[a..b] {
                            relax(p, cost);
                        }
                    }
                }
            }
        }
        Landmarks {
            slot,
            table,
            count,
            edges,
        }
    }

    /// Lower bound on the travel time from edge `e` to edge `t` (whose table entries are
    /// `t_from`/`t_to`, looked up once per query).
    #[inline]
    fn bound(&self, e: u32, t_from: &[u16; LANDMARKS], t_to: &[u16; LANDMARKS]) -> f32 {
        let s = self.slot[e as usize];
        if s == NONE {
            return 0.0;
        }
        let mut best = 0i32;
        let row = &self.table[s as usize * self.count * 2..(s as usize + 1) * self.count * 2];
        for l in 0..self.count {
            let (fe, te) = (row[l * 2], row[l * 2 + 1]);
            // Triangle inequality both ways around landmark l (the -1 absorbs rounding).
            if fe != FAR && t_from[l] != FAR {
                best = best.max(t_from[l] as i32 - fe as i32 - 1);
            }
            if te != FAR && t_to[l] != FAR {
                best = best.max(te as i32 - t_to[l] as i32 - 1);
            }
        }
        best as f32
    }

    fn target(&self, t: u32) -> ([u16; LANDMARKS], [u16; LANDMARKS]) {
        let mut tf = [FAR; LANDMARKS];
        let mut tt = [FAR; LANDMARKS];
        let s = self.slot[t as usize];
        if s != NONE {
            for l in 0..self.count {
                tf[l] = self.table[(s as usize * self.count + l) * 2];
                tt[l] = self.table[(s as usize * self.count + l) * 2 + 1];
            }
        }
        (tf, tt)
    }
}

pub struct Router {
    g: Vec<f32>,
    parent: Vec<u32>,
    epoch: Vec<u32>,
    current: u32,
    heap: BinaryHeap<(Reverse<u32>, u32, u32)>,
    pub landmarks: Option<Landmarks>,
    /// Edges settled by the last query (for statistics and tuning).
    pub last_settled: usize,
}

impl Router {
    pub fn new(edge_count: usize) -> Self {
        Router {
            g: vec![0.0; edge_count],
            parent: vec![NONE; edge_count],
            epoch: vec![0; edge_count],
            current: 0,
            heap: BinaryHeap::new(),
            landmarks: None,
            last_settled: 0,
        }
    }

    /// Whether a vehicle of class `vclass` can drive on any lane of `edge`.
    pub fn edge_allows(net: &Network, edge: u32, vclass: u16) -> bool {
        net.edge_lanes(edge)
            .any(|l| net.d.lane_allow[l as usize] & vclass != 0)
    }

    /// Fastest route from `from` to `to` (both included) for a vehicle class, using
    /// `travel_time[edge]` seconds per edge. None if unreachable.
    pub fn route(
        &mut self,
        net: &Network,
        travel_time: &[f32],
        from: u32,
        to: u32,
        vclass: u16,
    ) -> Option<Vec<u32>> {
        if from == to {
            return Some(vec![from]);
        }
        self.current = self.current.wrapping_add(1);
        if self.current == 0 {
            self.epoch.fill(0);
            self.current = 1;
        }
        let epoch = self.current;
        self.heap.clear();
        let (tx, tz) = net.edge_mid[to as usize];
        let landmarks = self.landmarks.as_ref();
        let (t_from, t_to) = landmarks
            .map(|l| l.target(to))
            .unwrap_or(([FAR; LANDMARKS], [FAR; LANDMARKS]));
        let h = |e: u32| {
            let (x, z) = net.edge_mid[e as usize];
            let straight = ((x - tx).powi(2) + (z - tz).powi(2)).sqrt() / HEURISTIC_SPEED;
            match landmarks {
                Some(l) => straight.max(l.bound(e, &t_from, &t_to)),
                None => straight,
            }
        };

        self.g[from as usize] = 0.0;
        self.parent[from as usize] = NONE;
        self.epoch[from as usize] = epoch;
        self.heap
            .push((Reverse(h(from).to_bits()), from, 0f32.to_bits()));
        let mut settled = 0;
        while let Some((_, e, g_bits)) = self.heap.pop() {
            let g = self.g[e as usize];
            // Stale entry: a better path to `e` was found after it was pushed.
            if f32::from_bits(g_bits) > g {
                continue;
            }
            if e == to {
                self.last_settled = settled;
                return Some(self.path(to));
            }
            settled += 1;
            if settled > MAX_SETTLED {
                break;
            }
            for s in net.successors(e) {
                if s.allow & vclass == 0 {
                    continue;
                }
                let next = s.edge;
                let cost = g + travel_time[next as usize] + s.penalty;
                let i = next as usize;
                if self.epoch[i] != epoch || cost < self.g[i] {
                    self.epoch[i] = epoch;
                    self.g[i] = cost;
                    self.parent[i] = e;
                    let f = cost + HEURISTIC_WEIGHT * h(next);
                    self.heap.push((Reverse(f.to_bits()), next, cost.to_bits()));
                }
            }
        }
        self.last_settled = settled;
        None
    }

    fn path(&self, to: u32) -> Vec<u32> {
        let mut path = vec![to];
        let mut e = to;
        while self.parent[e as usize] != NONE {
            e = self.parent[e as usize];
            path.push(e);
        }
        path.reverse();
        path
    }
}
