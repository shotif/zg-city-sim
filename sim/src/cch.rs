//! Customizable contraction hierarchies (CCH; Dibbelt, Strasser and Wagner, 2016) over the
//! routing graph: exact fastest routes in microseconds, on travel times that change every
//! simulated minute.
//!
//! Three phases:
//! - *Order*, once per network. Road edges are ranked by nested dissection: the graph is
//!   cut in two along a small separator, recursively, and separators rank above what they
//!   separate. Each cut is found by inertial flow (Schild and Sommer, 2015): of four
//!   directions across the map, the smallest set of edges that separates the quarter of
//!   the edges furthest one way from the quarter furthest the other (a minimum vertex cut,
//!   by maximum flow).
//! - *Contraction*, also once per network. Every edge's higher-ranked neighbours are joined
//!   into a clique (shortcuts), which does not depend on travel times.
//! - *Customisation*, whenever travel times change: each arc's time is the fastest of the
//!   ways round its lower triangles, per class of vehicle (`Metric`).
//!
//! A query walks from the start up the elimination tree (each edge's lowest-ranked higher
//! neighbour), and from the destination likewise; the fastest meeting point gives the
//! route, whose shortcuts are then unpacked into road edges.

use crate::network::{NONE, Network, vclass};

/// Subgraphs this small are ordered by minimum degree instead of being cut further.
const LEAF: usize = 24;
/// Share of a subgraph on each side that the flow keeps apart (inertial flow's balance).
const BALANCE: f32 = 0.25;
/// Infinite capacity in the flow network.
const INF_CAP: u32 = u32::MAX / 4;

/// The hierarchy over a network's road edges, without travel times.
pub struct Cch {
    /// Rank of each edge (NONE: not in the hierarchy: inside junctions, or rails only), and
    /// the edge of each rank.
    pub rank: Vec<u32>,
    pub edge: Vec<u32>,
    /// Arcs to higher ranks, by their lower end: `head[first[v]..first[v + 1]]`, ascending.
    first: Vec<u32>,
    head: Vec<u32>,
    /// Lower end of each arc.
    tail: Vec<u32>,
    /// Elimination tree: each rank's lowest-ranked higher neighbour (NONE at a root).
    parent: Vec<u32>,
    /// For each of the network's successors (`Network::succ`): the arc it lies on and
    /// whether it runs up it (from the lower rank), NONE where an end is not in the
    /// hierarchy.
    input_arc: Vec<u32>,
    input_up: Vec<bool>,
}

/// Whether vehicles that route by the hierarchy may use an edge: any lane for anything but
/// trams and trains (as loaded: edits only take permissions away).
fn routable(net: &Network, e: u32) -> bool {
    !net.is_internal_edge(e)
        && net
            .edge_lanes(e)
            .any(|l| net.d.lane_allow[l as usize] & !(vclass::TRAM | vclass::RAIL) != 0)
}

/// The graph a hierarchy is built over: the edges in it (in edge order), the pairs of them
/// a move joins (by index, smaller first, each once) and where each edge's middle is.
pub struct RoutingGraph {
    pub edges: Vec<u32>,
    pub pairs: Vec<(u32, u32)>,
    pub pos: Vec<(f32, f32)>,
}

impl RoutingGraph {
    pub fn of(net: &Network) -> RoutingGraph {
        let n_edges = net.edge_count();
        let mut node = vec![NONE; n_edges];
        let mut edges = Vec::new();
        for e in 0..n_edges as u32 {
            if routable(net, e) {
                node[e as usize] = edges.len() as u32;
                edges.push(e);
            }
        }
        let mut pairs: Vec<(u32, u32)> = Vec::new();
        for (x, &e) in edges.iter().enumerate() {
            for s in net.successors(e) {
                let y = node[s.edge as usize];
                if y != NONE && y != x as u32 {
                    let (a, b) = (x as u32, y);
                    pairs.push((a.min(b), a.max(b)));
                }
            }
        }
        pairs.sort_unstable();
        pairs.dedup();
        let pos = edges.iter().map(|&e| net.edge_mid[e as usize]).collect();
        RoutingGraph { edges, pairs, pos }
    }

    /// The graph as words for another worker to order (`order_words`): nodes, pairs, the
    /// pairs' ends, the positions' bits, then the edges.
    pub fn to_words(&self) -> Vec<u32> {
        let mut words = vec![self.pos.len() as u32, self.pairs.len() as u32];
        words.extend(self.pairs.iter().flat_map(|&(a, b)| [a, b]));
        words.extend(
            self.pos
                .iter()
                .flat_map(|&(x, z)| [x.to_bits(), z.to_bits()]),
        );
        words.extend_from_slice(&self.edges);
        words
    }
}

/// The edges of a graph given as words (`RoutingGraph::to_words`) in nested dissection
/// order, lowest rank first; None if the words are not a graph.
pub fn order_words(words: &[u32]) -> Option<Vec<u32>> {
    let (&n, &m) = (words.first()?, words.get(1)?);
    let (n, m) = (n as usize, m as usize);
    if words.len() != 2 + 2 * m + 3 * n {
        return None;
    }
    let ends = &words[2..2 + 2 * m];
    let pairs: Vec<(u32, u32)> = ends.chunks_exact(2).map(|p| (p[0], p[1])).collect();
    if pairs.iter().any(|&(a, b)| a >= b || b as usize >= n) {
        return None;
    }
    let pos = words[2 + 2 * m..2 + 2 * m + 2 * n]
        .chunks_exact(2)
        .map(|p| (f32::from_bits(p[0]), f32::from_bits(p[1])))
        .collect::<Vec<_>>();
    let edges = &words[2 + 2 * m + 2 * n..];
    Some(
        order(&pairs, &pos)
            .into_iter()
            .map(|x| edges[x as usize])
            .collect(),
    )
}

/// Nested dissection order of a graph's nodes, lowest rank first (seconds for a city).
pub fn order(pairs: &[(u32, u32)], pos: &[(f32, f32)]) -> Vec<u32> {
    nested_dissection(&Graph::undirected(pos.len(), pairs), pos)
}

impl Cch {
    /// Order, contract and index the hierarchy for a network's routing graph.
    pub fn build(net: &Network) -> Cch {
        let graph = RoutingGraph::of(net);
        let order = order(&graph.pairs, &graph.pos);
        Cch::with_order(net, &graph, &order).expect("an order of the graph's nodes")
    }

    /// The hierarchy for a network with roads drawn (M11c): this one's order for the edges
    /// both have (the network as loaded keeps its ids), the new edges ranked above them.
    /// Contraction takes a fraction of a second, against seconds for a new order.
    pub fn extend(&self, net: &Network) -> Cch {
        Cch::with_edge_order(net, &self.edge)
    }

    /// The hierarchy for a network in an order of edges, lowest rank first (`order_words`,
    /// for this network or one before roads were drawn): edges not in it ranked above those
    /// that are, by id. Any order is right; a poor one makes searches slower.
    pub fn with_edge_order(net: &Network, edges: &[u32]) -> Cch {
        let graph = RoutingGraph::of(net);
        let mut at = vec![NONE; net.edge_count()];
        for (k, &e) in edges.iter().enumerate() {
            if let Some(slot) = at.get_mut(e as usize) {
                *slot = k as u32;
            }
        }
        let mut order: Vec<u32> = (0..graph.edges.len() as u32).collect();
        let key = |i: u32| {
            let e = graph.edges[i as usize];
            match at[e as usize] {
                NONE => (1, e),
                k => (0, k),
            }
        };
        order.sort_unstable_by_key(|&i| key(i));
        Cch::with_order(net, &graph, &order).expect("a permutation")
    }

    /// The share of a network's routable edges an order of edges ranks.
    pub fn coverage(net: &Network, edges: &[u32]) -> f32 {
        let graph = RoutingGraph::of(net);
        let mut known = vec![false; net.edge_count()];
        for &e in edges {
            if let Some(k) = known.get_mut(e as usize) {
                *k = true;
            }
        }
        let covered = graph.edges.iter().filter(|&&e| known[e as usize]).count();
        covered as f32 / graph.edges.len().max(1) as f32
    }

    /// Contract and index the hierarchy for `graph` (a network's) in `order` (its node
    /// indices, lowest rank first); None if that is not an order of its nodes.
    pub fn with_order(net: &Network, graph: &RoutingGraph, order: &[u32]) -> Option<Cch> {
        let n = graph.edges.len();
        if order.len() != n {
            return None;
        }
        let mut rank_of_node = vec![NONE; n];
        for (r, &x) in order.iter().enumerate() {
            let slot = rank_of_node.get_mut(x as usize)?;
            if *slot != NONE {
                return None;
            }
            *slot = r as u32;
        }
        // Contract in rank order: each rank's higher neighbours become a clique, by adding
        // all but the lowest to the lowest's.
        let mut up: Vec<Vec<u32>> = vec![Vec::new(); n];
        for &(a, b) in &graph.pairs {
            let (ra, rb) = (rank_of_node[a as usize], rank_of_node[b as usize]);
            up[ra.min(rb) as usize].push(ra.max(rb));
        }
        let mut parent = vec![NONE; n];
        for v in 0..n {
            let mut list = std::mem::take(&mut up[v]);
            list.sort_unstable();
            list.dedup();
            if let Some(&p) = list.first() {
                parent[v] = p;
                let rest = list[1..].to_vec();
                up[p as usize].extend(rest);
            }
            up[v] = list;
        }
        let mut first = Vec::with_capacity(n + 1);
        let mut head = Vec::new();
        let mut tail = Vec::new();
        first.push(0u32);
        for (v, list) in up.iter().enumerate() {
            head.extend_from_slice(list);
            tail.extend(std::iter::repeat_n(v as u32, list.len()));
            first.push(head.len() as u32);
        }
        let mut rank = vec![NONE; net.edge_count()];
        let mut edge = vec![0u32; n];
        for (x, &e) in graph.edges.iter().enumerate() {
            rank[e as usize] = rank_of_node[x];
            edge[rank_of_node[x] as usize] = e;
        }
        let mut cch = Cch {
            rank,
            edge,
            first,
            head,
            tail,
            parent,
            input_arc: Vec::new(),
            input_up: Vec::new(),
        };
        cch.index_inputs(net);
        Some(cch)
    }

    /// Map the network's successors onto arcs (again after edits rebuild them: the pairs of
    /// edges stay the same).
    pub fn index_inputs(&mut self, net: &Network) {
        self.input_arc.clear();
        self.input_up.clear();
        for e in 0..net.edge_count() as u32 {
            let x = self.rank[e as usize];
            for s in net.successors(e) {
                let y = self.rank[s.edge as usize];
                let (arc, upward) = if x == NONE || y == NONE || x == y {
                    (NONE, false)
                } else if x < y {
                    (self.arc(x, y), true)
                } else {
                    (self.arc(y, x), false)
                };
                self.input_arc.push(arc);
                self.input_up.push(upward);
            }
        }
    }

    /// Ranks in the hierarchy.
    pub fn len(&self) -> usize {
        self.edge.len()
    }

    pub fn is_empty(&self) -> bool {
        self.edge.is_empty()
    }

    /// Arcs, shortcuts included.
    pub fn arcs(&self) -> usize {
        self.head.len()
    }

    /// Height of the elimination tree (the most ranks a query walks up).
    pub fn height(&self) -> usize {
        let n = self.len();
        let mut depth = vec![0u32; n];
        let mut most = 0;
        for v in (0..n).rev() {
            let p = self.parent[v];
            if p != NONE {
                depth[v] = depth[p as usize] + 1;
            }
            most = most.max(depth[v] as usize + 1);
        }
        most
    }

    /// The arc from rank `lo` up to rank `hi` (it exists wherever a lower triangle needs
    /// it).
    fn arc(&self, lo: u32, hi: u32) -> u32 {
        let (a, b) = (
            self.first[lo as usize] as usize,
            self.first[lo as usize + 1] as usize,
        );
        match self.head[a..b].binary_search(&hi) {
            Ok(i) => (a + i) as u32,
            Err(_) => NONE,
        }
    }
}

/// Travel times on the hierarchy's arcs for one class of vehicle.
pub struct Metric {
    /// Time along each arc from its lower end up, and from its upper end down (infinite
    /// where the class cannot pass).
    up: Vec<f32>,
    down: Vec<f32>,
    /// The lower rank whose triangle gave each time (NONE: a successor in the network).
    up_mid: Vec<u32>,
    down_mid: Vec<u32>,
    /// Scratch: for each rank, the arc to it from the rank being customised.
    mark: Vec<u32>,
    /// The class and whether tolls count, as customised.
    pub vclass: u16,
    pub tolls: bool,
    /// Whether routes are unpacked on it (else only times are read, `Query::one_to_all`, and
    /// the middles are not kept).
    paths: bool,
}

impl Metric {
    pub fn new(vclass: u16, tolls: bool) -> Metric {
        Metric::with_paths(vclass, tolls, true)
    }

    pub fn with_paths(vclass: u16, tolls: bool, paths: bool) -> Metric {
        Metric {
            up: Vec::new(),
            down: Vec::new(),
            up_mid: Vec::new(),
            down_mid: Vec::new(),
            mark: Vec::new(),
            vclass,
            tolls,
            paths,
        }
    }

    /// Times for travel times `times` (s per edge): moving from one edge onto the next
    /// takes the next one's time, plus the turn's penalty and, if tolls count, its toll, as
    /// `Router::route` counts it.
    pub fn customize(&mut self, cch: &Cch, net: &Network, times: &[f32]) {
        let m = cch.arcs();
        let n = cch.len();
        self.up.clear();
        self.up.resize(m, f32::INFINITY);
        self.down.clear();
        self.down.resize(m, f32::INFINITY);
        let mids = if self.paths { m } else { 0 };
        self.up_mid.clear();
        self.up_mid.resize(mids, NONE);
        self.down_mid.clear();
        self.down_mid.resize(mids, NONE);
        self.mark.clear();
        self.mark.resize(n, NONE);
        for (i, s) in net.succ.iter().enumerate() {
            let a = cch.input_arc[i];
            if a == NONE || s.allow & self.vclass == 0 {
                continue;
            }
            let toll = if self.tolls { s.toll } else { 0.0 };
            let w = times[s.edge as usize] + s.penalty + toll;
            let slot = if cch.input_up[i] {
                &mut self.up[a as usize]
            } else {
                &mut self.down[a as usize]
            };
            if w < *slot {
                *slot = w;
            }
        }
        // Lower triangles, lowest rank first: when rank v is reached, its arcs are final.
        let (first, head) = (&cch.first, &cch.head);
        let (up, down) = (&mut self.up, &mut self.down);
        let (up_mid, down_mid, mark) = (&mut self.up_mid, &mut self.down_mid, &mut self.mark);
        for v in 0..n {
            let (a0, a1) = (first[v] as usize, first[v + 1] as usize);
            for a in a0..a1 {
                mark[head[a] as usize] = a as u32;
            }
            for a in a0..a1 {
                let u = head[a] as usize;
                // u -> v and v -> u.
                let (to_v, from_v) = (down[a], up[a]);
                if to_v == f32::INFINITY && from_v == f32::INFINITY {
                    continue;
                }
                for b in first[u] as usize..first[u + 1] as usize {
                    let c = mark[head[b] as usize];
                    if c == NONE {
                        continue;
                    }
                    // Triangle v < u < w: a = (v, u), c = (v, w), b = (u, w).
                    let c = c as usize;
                    let via = to_v + up[c];
                    if via < up[b] {
                        up[b] = via;
                        if let Some(m) = up_mid.get_mut(b) {
                            *m = v as u32;
                        }
                    }
                    let via = down[c] + from_v;
                    if via < down[b] {
                        down[b] = via;
                        if let Some(m) = down_mid.get_mut(b) {
                            *m = v as u32;
                        }
                    }
                }
            }
            for a in a0..a1 {
                mark[head[a] as usize] = NONE;
            }
        }
    }
}

/// Search state for queries, reused between them.
pub struct Query {
    /// Time from the start to each rank going up, and from each rank to the destination.
    fwd: Vec<f32>,
    bwd: Vec<f32>,
    /// The arc each was reached by.
    fwd_arc: Vec<u32>,
    bwd_arc: Vec<u32>,
    /// Scratch for unpacking.
    stack: Vec<(u32, bool)>,
    path: Vec<u32>,
    /// Ranks visited by the last query (both ways), for statistics.
    pub last_visited: usize,
}

impl Query {
    pub fn new(cch: &Cch) -> Query {
        let n = cch.len();
        Query {
            fwd: vec![f32::INFINITY; n],
            bwd: vec![f32::INFINITY; n],
            fwd_arc: vec![NONE; n],
            bwd_arc: vec![NONE; n],
            stack: Vec::new(),
            path: Vec::new(),
            last_visited: 0,
        }
    }

    /// The fastest route from edge `from` to edge `to` (both included) and its time, on
    /// `metric`; None if there is none (or an end is not in the hierarchy).
    pub fn route(
        &mut self,
        cch: &Cch,
        metric: &Metric,
        from: u32,
        to: u32,
    ) -> Option<(Vec<u32>, f32)> {
        if self.fwd.len() != cch.len() {
            *self = Query::new(cch);
        }
        let rank = |e: u32| cch.rank.get(e as usize).copied().unwrap_or(NONE);
        let (s, t) = (rank(from), rank(to));
        if s == NONE || t == NONE {
            return None;
        }
        if s == t {
            return Some((vec![from], 0.0));
        }
        let (first, head, parent) = (&cch.first, &cch.head, &cch.parent);
        let mut visited = 0;
        // Up from the start: every rank above it on the elimination tree.
        self.fwd[s as usize] = 0.0;
        let mut x = s;
        while x != NONE {
            let d = self.fwd[x as usize];
            visited += 1;
            if d < f32::INFINITY {
                for a in first[x as usize] as usize..first[x as usize + 1] as usize {
                    let y = head[a] as usize;
                    let c = d + metric.up[a];
                    if c < self.fwd[y] {
                        self.fwd[y] = c;
                        self.fwd_arc[y] = a as u32;
                    }
                }
            }
            x = parent[x as usize];
        }
        // Up from the destination, meeting the start's search.
        self.bwd[t as usize] = 0.0;
        let (mut best, mut meet) = (f32::INFINITY, NONE);
        let mut x = t;
        while x != NONE {
            let d = self.bwd[x as usize];
            visited += 1;
            let total = self.fwd[x as usize] + d;
            if total < best {
                best = total;
                meet = x;
            }
            // Ranks reached from here are at least this far from the destination.
            if d < best {
                for a in first[x as usize] as usize..first[x as usize + 1] as usize {
                    let y = head[a] as usize;
                    let c = d + metric.down[a];
                    if c < self.bwd[y] {
                        self.bwd[y] = c;
                        self.bwd_arc[y] = a as u32;
                    }
                }
            }
            x = parent[x as usize];
        }
        self.last_visited = visited;
        let route = (meet != NONE).then(|| self.unpack(cch, metric, s, t, meet));
        // Reset what the searches touched: the ranks above each end.
        for start in [s, t] {
            let mut x = start;
            while x != NONE {
                self.fwd[x as usize] = f32::INFINITY;
                self.bwd[x as usize] = f32::INFINITY;
                x = parent[x as usize];
            }
        }
        route.map(|r| (r, best))
    }

    /// Times from edge `from` to every rank, in `out` (infinite where there is no way):
    /// PHAST, a walk up the elimination tree from it, then one sweep down over every rank,
    /// highest first. False if `from` is not in the hierarchy.
    pub fn one_to_all(
        &mut self,
        cch: &Cch,
        metric: &Metric,
        from: u32,
        out: &mut Vec<f32>,
    ) -> bool {
        let s = cch.rank.get(from as usize).copied().unwrap_or(NONE);
        if s == NONE {
            return false;
        }
        let n = cch.len();
        let (first, head, parent) = (&cch.first, &cch.head, &cch.parent);
        out.clear();
        out.resize(n, f32::INFINITY);
        out[s as usize] = 0.0;
        let mut x = s;
        while x != NONE {
            let d = out[x as usize];
            if d < f32::INFINITY {
                for a in first[x as usize] as usize..first[x as usize + 1] as usize {
                    let y = head[a] as usize;
                    let c = d + metric.up[a];
                    if c < out[y] {
                        out[y] = c;
                    }
                }
            }
            x = parent[x as usize];
        }
        // Down: each rank from those above it, which are final by then.
        for v in (0..n).rev() {
            let mut d = out[v];
            for a in first[v] as usize..first[v + 1] as usize {
                let c = out[head[a] as usize] + metric.down[a];
                if c < d {
                    d = c;
                }
            }
            out[v] = d;
        }
        true
    }

    /// The edges of the route through `meet`.
    fn unpack(&mut self, cch: &Cch, metric: &Metric, s: u32, t: u32, meet: u32) -> Vec<u32> {
        // Arcs up from the start to the meeting rank, then down from it to the destination.
        let mut arcs = Vec::new();
        let mut y = meet;
        while y != s {
            let a = self.fwd_arc[y as usize];
            arcs.push((a, true));
            y = cch.tail[a as usize];
        }
        arcs.reverse();
        let mut y = meet;
        while y != t {
            let a = self.bwd_arc[y as usize];
            arcs.push((a, false));
            y = cch.tail[a as usize];
        }
        self.path.clear();
        self.path.push(s);
        for &(a, upward) in &arcs {
            self.stack.push((a, upward));
            // Each arc in order: an original successor, or two halves round a triangle.
            while let Some((a, upward)) = self.stack.pop() {
                let (lo, hi) = (cch.tail[a as usize], cch.head[a as usize]);
                let mid = if upward {
                    metric.up_mid[a as usize]
                } else {
                    metric.down_mid[a as usize]
                };
                if mid == NONE {
                    self.path.push(if upward { hi } else { lo });
                    continue;
                }
                let (to_lo, to_hi) = (cch.arc(mid, lo), cch.arc(mid, hi));
                // Pushed last first: lo -> mid -> hi going up, hi -> mid -> lo going down.
                if upward {
                    self.stack.push((to_hi, true));
                    self.stack.push((to_lo, false));
                } else {
                    self.stack.push((to_lo, true));
                    self.stack.push((to_hi, false));
                }
            }
        }
        self.path.iter().map(|&r| cch.edge[r as usize]).collect()
    }
}

/// An undirected graph in adjacency arrays.
struct Graph {
    first: Vec<u32>,
    adj: Vec<u32>,
}

impl Graph {
    /// From pairs (a < b, no duplicates).
    fn undirected(n: usize, pairs: &[(u32, u32)]) -> Graph {
        let mut first = vec![0u32; n + 1];
        for &(a, b) in pairs {
            first[a as usize + 1] += 1;
            first[b as usize + 1] += 1;
        }
        for i in 0..n {
            first[i + 1] += first[i];
        }
        let mut fill = first.clone();
        let mut adj = vec![0u32; first[n] as usize];
        for &(a, b) in pairs {
            adj[fill[a as usize] as usize] = b;
            fill[a as usize] += 1;
            adj[fill[b as usize] as usize] = a;
            fill[b as usize] += 1;
        }
        Graph { first, adj }
    }

    fn neighbours(&self, x: u32) -> &[u32] {
        &self.adj[self.first[x as usize] as usize..self.first[x as usize + 1] as usize]
    }
}

/// Nested dissection order of a graph's nodes, lowest rank first.
fn nested_dissection(graph: &Graph, pos: &[(f32, f32)]) -> Vec<u32> {
    let n = pos.len();
    let mut order = vec![NONE; n];
    // Subgraphs still to order, each with the first rank its nodes take.
    let mut work: Vec<(Vec<u32>, usize)> = vec![((0..n as u32).collect(), 0)];
    // Local index of each node in the subgraph being cut (NONE outside it).
    let mut local = vec![NONE; n];
    let mut flow = Flow::default();
    while let Some((nodes, lo)) = work.pop() {
        for (i, &x) in nodes.iter().enumerate() {
            local[x as usize] = i as u32;
        }
        let sub = subgraph(graph, &nodes, &local);
        let parts = components(&sub, &vec![false; nodes.len()]);
        if parts.len() > 1 {
            // Apart already: each part orders on its own.
            let mut at = lo;
            for part in parts {
                let size = part.len();
                work.push((part.iter().map(|&i| nodes[i as usize]).collect(), at));
                at += size;
            }
        } else if nodes.len() <= LEAF {
            for (k, i) in min_degree_order(&sub).into_iter().enumerate() {
                order[lo + k] = nodes[i as usize];
            }
        } else {
            let p: Vec<(f32, f32)> = nodes.iter().map(|&x| pos[x as usize]).collect();
            let cut = best_cut(&sub, &p, &mut flow);
            let mut in_cut = vec![false; nodes.len()];
            for &i in &cut {
                in_cut[i as usize] = true;
            }
            // The separator takes the subgraph's highest ranks; the parts it leaves below.
            let top = lo + nodes.len() - cut.len();
            for (k, &i) in cut.iter().enumerate() {
                order[top + k] = nodes[i as usize];
            }
            let mut at = lo;
            for part in components(&sub, &in_cut) {
                let size = part.len();
                work.push((part.iter().map(|&i| nodes[i as usize]).collect(), at));
                at += size;
            }
        }
        for &x in &nodes {
            local[x as usize] = NONE;
        }
    }
    debug_assert!(order.iter().all(|&x| x != NONE));
    order
}

/// The subgraph on `nodes` (local indices by `local`).
fn subgraph(graph: &Graph, nodes: &[u32], local: &[u32]) -> Graph {
    let mut first = Vec::with_capacity(nodes.len() + 1);
    let mut adj = Vec::new();
    first.push(0u32);
    for &x in nodes {
        for &y in graph.neighbours(x) {
            let j = local[y as usize];
            if j != NONE {
                adj.push(j);
            }
        }
        first.push(adj.len() as u32);
    }
    Graph { first, adj }
}

/// Connected components of a graph without the nodes in `removed`.
fn components(graph: &Graph, removed: &[bool]) -> Vec<Vec<u32>> {
    let n = removed.len();
    let mut seen = removed.to_vec();
    let mut parts = Vec::new();
    let mut queue = Vec::new();
    for start in 0..n {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        queue.clear();
        queue.push(start as u32);
        let mut i = 0;
        while i < queue.len() {
            let x = queue[i];
            i += 1;
            for &y in graph.neighbours(x) {
                if !seen[y as usize] {
                    seen[y as usize] = true;
                    queue.push(y);
                }
            }
        }
        parts.push(queue.clone());
    }
    parts
}

/// Minimum-degree elimination order of a small graph.
fn min_degree_order(graph: &Graph) -> Vec<u32> {
    let n = graph.first.len() - 1;
    let mut adj: Vec<Vec<u32>> = (0..n as u32)
        .map(|x| graph.neighbours(x).to_vec())
        .collect();
    let mut done = vec![false; n];
    let mut order = Vec::with_capacity(n);
    for _ in 0..n {
        let x = (0..n)
            .filter(|&x| !done[x])
            .min_by_key(|&x| adj[x].len())
            .unwrap();
        done[x] = true;
        order.push(x as u32);
        let nb: Vec<u32> = adj[x]
            .iter()
            .copied()
            .filter(|&y| !done[y as usize])
            .collect();
        for &y in &nb {
            let list = &mut adj[y as usize];
            list.retain(|&z| z != x as u32);
            for &z in &nb {
                if z != y && !list.contains(&z) {
                    list.push(z);
                }
            }
        }
    }
    order
}

/// The smallest vertex separator inertial flow finds over four directions (local indices).
fn best_cut(graph: &Graph, pos: &[(f32, f32)], flow: &mut Flow) -> Vec<u32> {
    let n = pos.len();
    let side = ((n as f32 * BALANCE).ceil() as usize).max(1);
    let mut best: Option<Vec<u32>> = None;
    let mut idx: Vec<u32> = (0..n as u32).collect();
    for k in 0..4 {
        let angle = k as f32 * std::f32::consts::FRAC_PI_4;
        let (c, s) = (angle.cos(), angle.sin());
        let key = |i: u32| pos[i as usize].0 * c + pos[i as usize].1 * s;
        idx.sort_unstable_by(|&a, &b| key(a).total_cmp(&key(b)).then(a.cmp(&b)));
        let limit = best.as_ref().map_or(INF_CAP, |b| b.len() as u32);
        if let Some(cut) = flow.min_vertex_cut(graph, &idx[..side], &idx[n - side..], limit)
            && best.as_ref().is_none_or(|b| cut.len() < b.len())
        {
            best = Some(cut);
        }
    }
    // No cut short of the limit in any direction: fall back to a median split's boundary.
    best.unwrap_or_else(|| {
        let half: Vec<bool> = {
            let mut h = vec![false; n];
            for &i in &idx[..n / 2] {
                h[i as usize] = true;
            }
            h
        };
        (0..n as u32)
            .filter(|&x| half[x as usize] && graph.neighbours(x).iter().any(|&y| !half[y as usize]))
            .collect()
    })
}

/// Maximum flow (Dinic) on a node-split graph, kept between cuts to reuse its buffers.
#[derive(Default)]
struct Flow {
    first: Vec<u32>,
    to: Vec<u32>,
    cap: Vec<u32>,
    level: Vec<u32>,
    next: Vec<u32>,
    queue: Vec<u32>,
    stack: Vec<u32>,
}

impl Flow {
    /// The smallest set of nodes whose removal separates `sources` from `sinks` (local
    /// indices), or None if it has `limit` nodes or more (or they touch). Sources and sinks
    /// themselves are never cut: they are merged into the flow's source and sink, so the
    /// flow runs on the nodes between them only.
    fn min_vertex_cut(
        &mut self,
        graph: &Graph,
        sources: &[u32],
        sinks: &[u32],
        limit: u32,
    ) -> Option<Vec<u32>> {
        let n = graph.first.len() - 1;
        // Index of each node between the two sides; SOURCE or SINK for the others.
        const SOURCE: u32 = u32::MAX;
        const SINK: u32 = u32::MAX - 1;
        let mut mid = vec![0u32; n];
        for &x in sources {
            mid[x as usize] = SOURCE;
        }
        for &x in sinks {
            mid[x as usize] = SINK;
        }
        // A source next to a sink: no cut keeps them apart.
        if sources
            .iter()
            .any(|&x| graph.neighbours(x).iter().any(|&y| mid[y as usize] == SINK))
        {
            return None;
        }
        let mut between = Vec::with_capacity(n);
        for x in 0..n {
            if mid[x] == 0 {
                mid[x] = between.len() as u32;
                between.push(x as u32);
            }
        }
        let m = between.len();
        // Nodes: in(i) = 2i, out(i) = 2i + 1, source 2m, sink 2m + 1. Arcs in pairs (k, k ^ 1).
        let (src, snk) = (2 * m as u32, 2 * m as u32 + 1);
        let n_nodes = 2 * m + 2;
        let mut arcs: Vec<(u32, u32, u32)> = Vec::with_capacity(4 * m + 2 * graph.adj.len());
        let mut add = |a: u32, b: u32, cap: u32| {
            arcs.push((a, b, cap));
            arcs.push((b, a, 0));
        };
        for (i, &x) in between.iter().enumerate() {
            let i = i as u32;
            add(2 * i, 2 * i + 1, 1);
            for &y in graph.neighbours(x) {
                match mid[y as usize] {
                    SOURCE => add(src, 2 * i, INF_CAP),
                    SINK => add(2 * i + 1, snk, INF_CAP),
                    j => add(2 * i + 1, 2 * j, INF_CAP),
                }
            }
        }
        // Adjacency arrays: arcs by tail; `pair[k]` is the position of arc k's reverse.
        self.first.clear();
        self.first.resize(n_nodes + 1, 0);
        for &(a, _, _) in &arcs {
            self.first[a as usize + 1] += 1;
        }
        for i in 0..n_nodes {
            self.first[i + 1] += self.first[i];
        }
        let mut fill = self.first.clone();
        let mut slot = vec![0u32; arcs.len()];
        for (id, &(a, _, _)) in arcs.iter().enumerate() {
            slot[id] = fill[a as usize];
            fill[a as usize] += 1;
        }
        self.to.clear();
        self.to.resize(arcs.len(), 0);
        self.cap.clear();
        self.cap.resize(arcs.len(), 0);
        let mut pair = vec![0u32; arcs.len()];
        for (id, &(_, b, c)) in arcs.iter().enumerate() {
            let k = slot[id] as usize;
            self.to[k] = b;
            self.cap[k] = c;
            pair[k] = slot[id ^ 1];
        }
        let mut total = 0u32;
        while self.levels(src, snk, n_nodes, true) {
            self.next.clear();
            self.next.extend_from_slice(&self.first[..n_nodes]);
            loop {
                let pushed = self.augment(src, snk, &pair);
                if pushed == 0 {
                    break;
                }
                total = total.saturating_add(pushed);
                if total >= limit {
                    return None;
                }
            }
        }
        // Nodes reachable from the source in what is left: a cut node has its in-node
        // reachable and its out-node not.
        self.levels(src, snk, n_nodes, false);
        let reach = |v: usize| self.level[v] != u32::MAX;
        Some(
            between
                .iter()
                .enumerate()
                .filter(|&(i, _)| reach(2 * i) && !reach(2 * i + 1))
                .map(|(_, &x)| x)
                .collect(),
        )
    }

    /// Breadth-first levels from the source over arcs with room left; whether the sink is
    /// reached. `to_sink`: stop at the sink's level (enough for augmenting paths).
    fn levels(&mut self, src: u32, snk: u32, n_nodes: usize, to_sink: bool) -> bool {
        self.level.clear();
        self.level.resize(n_nodes, u32::MAX);
        self.queue.clear();
        self.level[src as usize] = 0;
        self.queue.push(src);
        let mut i = 0;
        while i < self.queue.len() {
            let v = self.queue[i];
            i += 1;
            let lv = self.level[v as usize];
            if to_sink && lv >= self.level[snk as usize] {
                break;
            }
            for k in self.first[v as usize] as usize..self.first[v as usize + 1] as usize {
                let w = self.to[k];
                if self.cap[k] > 0 && self.level[w as usize] == u32::MAX {
                    self.level[w as usize] = lv + 1;
                    self.queue.push(w);
                }
            }
        }
        self.level[snk as usize] != u32::MAX
    }

    /// One augmenting path along the levels (depth first, without recursion); the flow it
    /// carries, 0 if none is left.
    fn augment(&mut self, src: u32, snk: u32, pair: &[u32]) -> u32 {
        // `stack` holds the positions of the arcs taken.
        self.stack.clear();
        let mut v = src;
        loop {
            if v == snk {
                let push = self
                    .stack
                    .iter()
                    .map(|&k| self.cap[k as usize])
                    .min()
                    .unwrap_or(0);
                for &k in &self.stack {
                    self.cap[k as usize] -= push;
                    self.cap[pair[k as usize] as usize] += push;
                }
                return push;
            }
            let end = self.first[v as usize + 1];
            let mut advanced = false;
            while self.next[v as usize] < end {
                let k = self.next[v as usize] as usize;
                let w = self.to[k];
                if self.cap[k] > 0 && self.level[w as usize] == self.level[v as usize] + 1 {
                    self.stack.push(k as u32);
                    v = w;
                    advanced = true;
                    break;
                }
                self.next[v as usize] += 1;
            }
            if !advanced {
                // Dead end: retreat and skip the arc that led here.
                let Some(k) = self.stack.pop() else {
                    return 0;
                };
                self.level[v as usize] = u32::MAX;
                let back = self.to[pair[k as usize] as usize];
                self.next[back as usize] += 1;
                v = back;
            }
        }
    }
}

/// Whether trucks may make exactly the moves cars may.
fn trucks_as_cars(net: &Network) -> bool {
    net.succ
        .iter()
        .all(|s| (s.allow & vclass::PASSENGER != 0) == (s.allow & vclass::TRUCK != 0))
}

/// Which travel times a search runs on (`Hierarchy::kind`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Times {
    /// As measured on the roads (`Engine::travel_time`).
    Travel,
    /// At the speed limits (transit legs).
    Free,
    /// As bikes choose routes (`Engine::bike_time`).
    Bike,
    /// In the morning peak as day runs had it (`Engine::peak_time`, M10d), for the riders'
    /// car journeys.
    Peak,
}

/// The metrics the engine routes on: cars and trucks on the measured times, each with and
/// without tolls, bikes on their own times, and cars in the morning peak (times only, for
/// the riders). Each is customised only once a search needs it.
const KINDS: [(Times, u16, bool); 6] = [
    (Times::Travel, vclass::PASSENGER, true),
    (Times::Travel, vclass::PASSENGER, false),
    (Times::Travel, vclass::TRUCK, true),
    (Times::Travel, vclass::TRUCK, false),
    (Times::Bike, vclass::BICYCLE, true),
    (Times::Peak, vclass::PASSENGER, false),
];

/// A hierarchy with a metric per kind of search (M11b), each customised when a search
/// first needs it after its travel times changed.
pub struct Hierarchy {
    pub cch: Cch,
    metrics: Vec<Metric>,
    stale: Vec<bool>,
    /// Whether trucks may make every move cars may and no other (true of Zagreb's roads as
    /// mapped): then they route on the cars' metrics.
    trucks_as_cars: bool,
    query: Query,
    /// Searches, ranks they visited, and customisations so far.
    pub searches: u64,
    pub visited: u64,
    pub customisations: u64,
    /// Time spent searching and customising (s); counted only with the `profile` feature.
    pub seconds: f64,
    pub custom_seconds: f64,
}

impl Hierarchy {
    pub fn new(cch: Cch, net: &Network) -> Hierarchy {
        let query = Query::new(&cch);
        Hierarchy {
            metrics: KINDS
                .iter()
                .map(|&(times, v, t)| Metric::with_paths(v, t, times != Times::Peak))
                .collect(),
            stale: vec![true; KINDS.len()],
            trucks_as_cars: trucks_as_cars(net),
            cch,
            query,
            searches: 0,
            visited: 0,
            customisations: 0,
            seconds: 0.0,
            custom_seconds: 0.0,
        }
    }

    /// The metric a search on `times` for `vclass` uses (tolls counted or not), if any:
    /// other searches (buses, trams and trains, transit legs at the speed limits) are left
    /// to A*.
    pub fn kind(&self, times: Times, vclass: u16, tolls: bool) -> Option<usize> {
        let vclass = if vclass == vclass::TRUCK && self.trucks_as_cars {
            vclass::PASSENGER
        } else {
            vclass
        };
        KINDS.iter().position(|&(t, v, toll)| {
            t == times && v == vclass && (toll == tolls || times == Times::Bike)
        })
    }

    /// The measured times changed: cars and trucks customise again.
    pub fn travel_changed(&mut self) {
        for (k, &(t, _, _)) in KINDS.iter().enumerate() {
            if t == Times::Travel {
                self.stale[k] = true;
            }
        }
    }

    /// The network's successors or permissions changed (edits): index them again, and
    /// every metric customises again.
    pub fn network_changed(&mut self, net: &Network) {
        self.cch.index_inputs(net);
        self.trucks_as_cars = trucks_as_cars(net);
        self.stale.fill(true);
    }

    /// The peak times changed.
    pub fn peak_changed(&mut self) {
        for (k, &(t, _, _)) in KINDS.iter().enumerate() {
            if t == Times::Peak {
                self.stale[k] = true;
            }
        }
    }

    /// Bikes' times changed.
    pub fn bike_changed(&mut self) {
        for (k, &(t, _, _)) in KINDS.iter().enumerate() {
            if t == Times::Bike {
                self.stale[k] = true;
            }
        }
    }

    /// The fastest route from `from` to `to` for metric `kind` on `times` (the travel times
    /// that kind runs on), customising it first if they changed.
    pub fn route(
        &mut self,
        net: &Network,
        times: &[f32],
        kind: usize,
        from: u32,
        to: u32,
    ) -> Option<Vec<u32>> {
        #[cfg(feature = "profile")]
        let start = std::time::Instant::now();
        if self.stale[kind] {
            self.metrics[kind].customize(&self.cch, net, times);
            self.stale[kind] = false;
            self.customisations += 1;
            #[cfg(feature = "profile")]
            {
                self.custom_seconds += start.elapsed().as_secs_f64();
            }
        }
        #[cfg(feature = "profile")]
        let start = std::time::Instant::now();
        let route = self
            .query
            .route(&self.cch, &self.metrics[kind], from, to)
            .map(|(r, _)| r);
        self.searches += 1;
        self.visited += self.query.last_visited as u64;
        #[cfg(feature = "profile")]
        {
            self.seconds += start.elapsed().as_secs_f64();
        }
        route
    }

    /// Times from edge `from` to every edge in the hierarchy for metric `kind` on `times`
    /// (`Query::one_to_all`), in `out` by rank (`cch.edge` names each rank's edge). False
    /// if `from` is not in the hierarchy.
    pub fn one_to_all(
        &mut self,
        net: &Network,
        times: &[f32],
        kind: usize,
        from: u32,
        out: &mut Vec<f32>,
    ) -> bool {
        if self.stale[kind] {
            self.metrics[kind].customize(&self.cch, net, times);
            self.stale[kind] = false;
            self.customisations += 1;
        }
        self.query
            .one_to_all(&self.cch, &self.metrics[kind], from, out)
    }

    /// Ranks the last search visited.
    pub fn last_visited(&self) -> usize {
        self.query.last_visited
    }
}
