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
    /// One row of `ROW` values per edge slot: the times from each landmark to the edge, then
    /// those from the edge to each landmark (FAR where there is no way, and for landmarks
    /// beyond `edges.len()`). A row is contiguous, so a bound costs one or two cache lines.
    table: Vec<Row>,
    pub edges: Vec<u32>,
    /// Free-flow time of each edge the tables were built on: bounds stay valid while no
    /// edge is faster than this.
    pub free_time: Vec<f32>,
}

/// Values per edge in the landmark tables.
const ROW: usize = 2 * LANDMARKS;

/// One edge's landmark times.
#[derive(Clone, Copy)]
struct Row([u16; ROW]);

/// A search target's landmark times, as the bound uses them: where a time is missing, a
/// value that makes that landmark's term negative (so it never raises the bound).
struct Target {
    from: [i32; LANDMARKS],
    to: [i32; LANDMARKS],
}

impl Landmarks {
    /// Pick landmarks spread around the network's edge and compute their tables.
    pub fn build(net: &Network, free_time: &[f32]) -> Landmarks {
        let mut job = LandmarkBuild::new(net, free_time);
        while !job.step(net) {}
        job.finish()
    }

    /// Whether the bounds hold for these free-flow times (no edge faster than when built).
    pub fn valid_for(&self, free_time: &[f32]) -> bool {
        free_time.len() == self.free_time.len()
            && free_time
                .iter()
                .zip(&self.free_time)
                .all(|(&now, &then)| now >= then * 0.999)
    }

    /// Lower bound on the travel time from edge `e` to the target.
    #[inline]
    fn bound(&self, e: u32, t: &Target) -> f32 {
        let s = self.slot[e as usize];
        if s == NONE {
            return 0.0;
        }
        let row = &self.table[s as usize].0;
        let mut best = 0i32;
        // Triangle inequality both ways around each landmark (the -1 absorbs rounding). An
        // edge's missing time is FAR: from a landmark it makes the term negative; to one it
        // is left out. Written without branches, so it vectorises.
        for l in 0..LANDMARKS {
            let (fe, te) = (row[l] as i32, row[LANDMARKS + l] as i32);
            let a = t.from[l] - fe - 1;
            let b = if te == FAR as i32 {
                -1
            } else {
                te - t.to[l] - 1
            };
            best = best.max(a).max(b);
        }
        best as f32
    }

    fn target(&self, t: u32) -> Target {
        // Missing at the target: from a landmark, the term goes negative; to one, likewise.
        let mut target = Target {
            from: [-(FAR as i32) * 2; LANDMARKS],
            to: [FAR as i32 * 2; LANDMARKS],
        };
        let s = self.slot[t as usize];
        if s != NONE {
            let row = &self.table[s as usize].0;
            for l in 0..LANDMARKS {
                if row[l] != FAR {
                    target.from[l] = row[l] as i32;
                }
                if row[LANDMARKS + l] != FAR {
                    target.to[l] = row[LANDMARKS + l] as i32;
                }
            }
        }
        target
    }
}

/// Landmark tables built a search at a time (`step`), so the browser can rebuild them
/// between simulation steps after an edit makes roads faster.
pub struct LandmarkBuild {
    slot: Vec<u32>,
    edges: Vec<u32>,
    table: Vec<Row>,
    /// Free-flow time of each edge the tables are built on.
    free_time: Vec<f32>,
    pred_offset: Vec<u32>,
    pred: Vec<(u32, f32)>,
    /// Searches done: landmark `done / 2`, forward when even.
    done: usize,
    dist: Vec<f32>,
    heap: BinaryHeap<(Reverse<u32>, u32)>,
}

impl LandmarkBuild {
    pub fn new(net: &Network, free_time: &[f32]) -> LandmarkBuild {
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
        LandmarkBuild {
            table: vec![Row([FAR; ROW]); n],
            slot,
            edges,
            free_time: free_time.to_vec(),
            pred_offset,
            pred,
            done: 0,
            dist: vec![f32::INFINITY; n_edges],
            heap: BinaryHeap::new(),
        }
    }

    /// Searches still to run.
    pub fn remaining(&self) -> usize {
        self.edges.len() * 2 - self.done
    }

    /// Run the next search; true when the tables are complete.
    pub fn step(&mut self, net: &Network) -> bool {
        if self.done >= self.edges.len() * 2 {
            return true;
        }
        let (l, forward) = (self.done / 2, self.done.is_multiple_of(2));
        let landmark = self.edges[l];
        let (dist, heap, table) = (&mut self.dist, &mut self.heap, &mut self.table);
        dist.fill(f32::INFINITY);
        dist[landmark as usize] = 0.0;
        heap.clear();
        heap.push((Reverse(0f32.to_bits()), landmark));
        while let Some((Reverse(bits), e)) = heap.pop() {
            let g = f32::from_bits(bits);
            if g > dist[e as usize] {
                continue;
            }
            let s = self.slot[e as usize];
            if s != NONE {
                let i = if forward { l } else { LANDMARKS + l };
                table[s as usize].0[i] = g.min(FAR as f32 - 1.0) as u16;
            }
            let mut relax = |next: u32, cost: f32| {
                let c = g + cost;
                if c < dist[next as usize] {
                    dist[next as usize] = c;
                    heap.push((Reverse(c.to_bits()), next));
                }
            };
            if forward {
                for s in net.successors(e) {
                    relax(s.edge, self.free_time[s.edge as usize] + s.penalty);
                }
            } else {
                let (a, b) = (
                    self.pred_offset[e as usize] as usize,
                    self.pred_offset[e as usize + 1] as usize,
                );
                for &(p, cost) in &self.pred[a..b] {
                    relax(p, cost);
                }
            }
        }
        self.done += 1;
        self.done >= self.edges.len() * 2
    }

    /// The finished tables, and the free-flow times they were built on.
    pub fn finish(self) -> Landmarks {
        Landmarks {
            slot: self.slot,
            table: self.table,
            edges: self.edges,
            free_time: self.free_time,
        }
    }
}

/// A heap key: the estimate's bits (non-negative floats order as their bits) above the
/// edge's complement, so of equal estimates the higher-numbered edge comes first.
#[inline]
fn key(f: f32, edge: u32) -> u64 {
    (u64::from(f.to_bits()) << 32) | u64::from(!edge)
}

/// The estimate and the edge of a heap key.
#[inline]
fn unkey(key: u64) -> (f32, u32) {
    (f32::from_bits((key >> 32) as u32), !(key as u32))
}

/// Search state of one edge: the best time found to its end, the heuristic estimate from
/// there (computed once per search), the edge before it, and the search it belongs to.
/// Kept together so a relaxation touches one cache line.
#[derive(Clone, Copy, Default)]
struct Node {
    g: f32,
    h: f32,
    parent: u32,
    epoch: u32,
}

pub struct Router {
    nodes: Vec<Node>,
    current: u32,
    /// Edges to settle, smallest key first: `key(f, edge)`.
    heap: BinaryHeap<Reverse<u64>>,
    pub landmarks: Option<Landmarks>,
    /// Edges settled by the last query (for statistics and tuning).
    pub last_settled: usize,
    /// Whether routes weigh motorway tolls (`Successor::toll`).
    pub tolls: bool,
    /// Weight on the heuristic (`HEURISTIC_WEIGHT`; the `routes` example tries others).
    pub weight: f32,
    /// Time spent in `route` (s); counted only with the `profile` feature.
    pub seconds: f64,
    /// Searches, those that found no route, and edges settled by each kind.
    pub searches: u64,
    pub failed: u64,
    pub settled_found: u64,
    pub settled_failed: u64,
}

impl Router {
    pub fn new(edge_count: usize) -> Self {
        Router {
            nodes: vec![Node::default(); edge_count],
            current: 0,
            heap: BinaryHeap::new(),
            landmarks: None,
            last_settled: 0,
            tolls: true,
            weight: HEURISTIC_WEIGHT,
            seconds: 0.0,
            searches: 0,
            failed: 0,
            settled_found: 0,
            settled_failed: 0,
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
        #[cfg(feature = "profile")]
        let start = std::time::Instant::now();
        let route = self.search(net, travel_time, from, to, vclass);
        self.searches += 1;
        if route.is_some() {
            self.settled_found += self.last_settled as u64;
        } else {
            self.failed += 1;
            self.settled_failed += self.last_settled as u64;
        }
        #[cfg(feature = "profile")]
        {
            self.seconds += start.elapsed().as_secs_f64();
        }
        route
    }

    /// A new search: entries of earlier ones no longer count.
    fn next_epoch(&mut self) -> u32 {
        self.current = self.current.wrapping_add(1);
        if self.current == 0 {
            self.nodes.fill(Node::default());
            self.current = 1;
        }
        self.heap.clear();
        self.current
    }

    fn search(
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
        let epoch = self.next_epoch();
        let Router {
            nodes,
            heap,
            landmarks,
            tolls,
            weight,
            ..
        } = self;
        let weight = *weight;
        let (tx, tz) = net.edge_mid[to as usize];
        let landmarks = landmarks.as_ref();
        let target = landmarks.map(|l| l.target(to));
        let h = |e: u32| {
            let (x, z) = net.edge_mid[e as usize];
            let straight = ((x - tx).powi(2) + (z - tz).powi(2)).sqrt() / HEURISTIC_SPEED;
            match (landmarks, &target) {
                (Some(l), Some(t)) => straight.max(l.bound(e, t)),
                _ => straight,
            }
        };

        let h_from = h(from);
        nodes[from as usize] = Node {
            g: 0.0,
            h: h_from,
            parent: NONE,
            epoch,
        };
        heap.push(Reverse(key(h_from, from)));
        let mut settled = 0;
        let mut found = false;
        while let Some(Reverse(k)) = heap.pop() {
            let (f, e) = unkey(k);
            let Node { g, h: rest, .. } = nodes[e as usize];
            // Stale entry: a better path to `e` was found after it was pushed (the start's
            // entry carries its estimate unweighted, so it is never stale).
            if f > g + weight * rest {
                continue;
            }
            if e == to {
                found = true;
                break;
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
                let toll = if *tolls { s.toll } else { 0.0 };
                let cost = g + travel_time[next as usize] + s.penalty + toll;
                let n = &mut nodes[next as usize];
                if n.epoch != epoch {
                    *n = Node {
                        g: cost,
                        h: h(next),
                        parent: e,
                        epoch,
                    };
                } else if cost < n.g {
                    n.g = cost;
                    n.parent = e;
                } else {
                    continue;
                }
                heap.push(Reverse(key(cost + weight * n.h, next)));
            }
        }
        self.last_settled = settled;
        found.then(|| self.path(to))
    }

    /// Every edge a vehicle of class `vclass` reaches from `from` within `max_time`
    /// seconds on `travel_time`, and how long it takes to reach its end (Dijkstra; `from`
    /// itself at 0 s).
    pub fn reach(
        &mut self,
        net: &Network,
        travel_time: &[f32],
        from: u32,
        max_time: f32,
        vclass: u16,
        mut visit: impl FnMut(u32, f32),
    ) {
        let epoch = self.next_epoch();
        let Router { nodes, heap, .. } = self;
        nodes[from as usize] = Node {
            g: 0.0,
            h: 0.0,
            parent: NONE,
            epoch,
        };
        heap.push(Reverse(key(0.0, from)));
        let mut settled = 0;
        while let Some(Reverse(k)) = heap.pop() {
            let (cost, e) = unkey(k);
            let g = nodes[e as usize].g;
            if cost > g {
                continue;
            }
            visit(e, g);
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
                if cost > max_time {
                    continue;
                }
                let n = &mut nodes[next as usize];
                if n.epoch != epoch || cost < n.g {
                    *n = Node {
                        g: cost,
                        h: 0.0,
                        parent: e,
                        epoch,
                    };
                    heap.push(Reverse(key(cost, next)));
                }
            }
        }
        self.last_settled = settled;
    }

    fn path(&self, to: u32) -> Vec<u32> {
        let mut path = vec![to];
        let mut e = to;
        while self.nodes[e as usize].parent != NONE {
            e = self.nodes[e as usize].parent;
            path.push(e);
        }
        path.reverse();
        path
    }
}
