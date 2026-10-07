//! The road network as the engine sees it: lanes (normal and junction-internal), links
//! between lanes with right-of-way and signal control, junction logic, traffic-light
//! programs and a routing graph over edges.

pub const NONE: u32 = u32::MAX;

/// Vehicle-class permission bits (pipeline/simnet.py VCLASS_BITS).
pub mod vclass {
    pub const PASSENGER: u16 = 1;
    pub const BUS: u16 = 2;
    pub const TRAM: u16 = 4;
    pub const TRUCK: u16 = 8;
    pub const RAIL: u16 = 16;
}

/// Edge flag bits (pipeline/simnet.py).
pub mod edge_flag {
    pub const BRIDGE: u8 = 1;
    pub const INTERNAL: u8 = 16;
    /// Tolled motorway (OSM `toll=yes`).
    pub const TOLL: u8 = 32;
}

/// Seconds drivers count for each metre of tolled motorway: Croatian motorway tolls are about
/// €0.08 a kilometre for cars, so 18 s a kilometre values drivers' time at about €16 an hour.
/// Routes avoid tolls where a free road is not much slower, as drivers do. Calibrated on the
/// A11's toll counts (docs/VALIDATION.md): at 36 s a kilometre it carried half of them.
pub const TOLL_TIME: f32 = 0.018;

/// Link directions (pipeline/simnet.py LINK_DIRS).
pub mod dir {
    pub const STRAIGHT: u8 = 0;
    pub const LEFT: u8 = 1;
    pub const RIGHT: u8 = 2;
    pub const TURN: u8 = 3;
    pub const PARTLEFT: u8 = 4;
    pub const PARTRIGHT: u8 = 5;
}

/// Link and signal states as ASCII, indexed by the pipeline's LINK_STATES table.
pub const LINK_STATE_CHARS: [u8; 13] = *b"Mm=swZOoGgyru";

/// Raw arrays as exported by the pipeline (and decoded shapes from the app).
#[derive(Default, Clone)]
pub struct NetworkData {
    pub lane_edge: Vec<u32>,
    pub lane_length: Vec<f32>,
    pub lane_speed: Vec<f32>,
    pub lane_width: Vec<f32>,
    pub lane_allow: Vec<u16>,
    pub lane_next: Vec<u32>,
    pub lane_link_offsets: Vec<u32>,
    pub lane_shape_offsets: Vec<u32>,
    /// Decoded lane shapes: (x, z, elevation offset) per point.
    pub lane_shape: Vec<f32>,
    /// Absolute height of each lane shape point on bridges (set by the app, which knows the
    /// terrain). Empty, or ignored for other lanes, whose heights are the elevation offsets.
    pub lane_shape_y: Vec<f32>,
    pub edge_flags: Vec<u8>,
    pub edge_lane_start: Vec<u32>,
    pub edge_lane_count: Vec<u8>,
    pub edge_from: Vec<u32>,
    pub edge_to: Vec<u32>,
    pub link_from: Vec<u32>,
    pub link_to: Vec<u32>,
    pub link_via: Vec<u32>,
    pub link_junction: Vec<u32>,
    pub link_request: Vec<u16>,
    pub link_dir: Vec<u8>,
    pub link_state: Vec<u8>,
    pub link_tls: Vec<u32>,
    pub link_tls_index: Vec<u16>,
    pub junction_pos: Vec<f32>,
    pub junction_link_count: Vec<u16>,
    pub junction_logic_offset: Vec<u32>,
    pub logic: Vec<u32>,
    pub tls_phase_offsets: Vec<u32>,
    pub tls_offset: Vec<f32>,
    pub phase_duration: Vec<f32>,
    pub phase_min_dur: Vec<f32>,
    pub phase_max_dur: Vec<f32>,
    pub phase_state_offsets: Vec<u32>,
    pub phase_states: Vec<u8>,
    /// Per signal program, 1 where the player set it (Build panel): the engine runs it as
    /// given, without merging or re-timing its phases. Empty for a network as loaded.
    pub tls_fixed: Vec<u8>,
}

macro_rules! named_arrays {
    ($($name:literal => $field:ident : $ty:ty),* $(,)?) => {
        impl NetworkData {
            /// Names of the arrays the engine reads, as the pipeline names them.
            pub const ARRAY_NAMES: &[&str] = &[$($name),*];

            /// Allocate `count` zeroed elements for the named array and return its bytes to
            /// fill (little-endian). None if the name is unknown or `elem_size` is not the
            /// engine's element size for it.
            pub fn alloc_array(&mut self, name: &str, count: usize, elem_size: usize) -> Option<&mut [u8]> {
                match name {
                    $($name => {
                        if std::mem::size_of::<$ty>() != elem_size {
                            return None;
                        }
                        self.$field = vec![<$ty>::default(); count];
                        let bytes = count * elem_size;
                        // SAFETY: plain numeric elements; any byte pattern is valid.
                        Some(unsafe {
                            std::slice::from_raw_parts_mut(self.$field.as_mut_ptr() as *mut u8, bytes)
                        })
                    })*
                    _ => None,
                }
            }
        }
    };
}

named_arrays! {
    "laneEdge" => lane_edge: u32,
    "laneLength" => lane_length: f32,
    "laneSpeed" => lane_speed: f32,
    "laneWidth" => lane_width: f32,
    "laneAllow" => lane_allow: u16,
    "laneNext" => lane_next: u32,
    "laneLinkOffsets" => lane_link_offsets: u32,
    "laneShapeOffsets" => lane_shape_offsets: u32,
    "laneShape" => lane_shape: f32,
    "laneShapeY" => lane_shape_y: f32,
    "edgeFlags" => edge_flags: u8,
    "edgeLaneStart" => edge_lane_start: u32,
    "edgeLaneCount" => edge_lane_count: u8,
    "edgeFrom" => edge_from: u32,
    "edgeTo" => edge_to: u32,
    "linkFrom" => link_from: u32,
    "linkTo" => link_to: u32,
    "linkVia" => link_via: u32,
    "linkJunction" => link_junction: u32,
    "linkRequest" => link_request: u16,
    "linkDir" => link_dir: u8,
    "linkState" => link_state: u8,
    "linkTls" => link_tls: u32,
    "linkTlsIndex" => link_tls_index: u16,
    "junctionPos" => junction_pos: f32,
    "junctionLinkCount" => junction_link_count: u16,
    "junctionLogicOffset" => junction_logic_offset: u32,
    "logic" => logic: u32,
    "tlsPhaseOffsets" => tls_phase_offsets: u32,
    "tlsOffset" => tls_offset: f32,
    "phaseDuration" => phase_duration: f32,
    "phaseMinDur" => phase_min_dur: f32,
    "phaseMaxDur" => phase_max_dur: f32,
    "phaseStateOffsets" => phase_state_offsets: u32,
    "phaseStates" => phase_states: u8,
    "tlsFixed" => tls_fixed: u8,
}

#[derive(Debug)]
pub enum NetworkError {
    Inconsistent(&'static str),
}

/// One-way successor of an edge in the routing graph.
#[derive(Clone, Copy, Debug)]
pub struct Successor {
    pub edge: u32,
    /// Vehicle classes that can make this move.
    pub allow: u16,
    /// Extra seconds for the turn (left turns and U-turns are slower).
    pub penalty: f32,
    /// Seconds the toll on the edge it leads to is worth (`TOLL_TIME`), 0 on free roads.
    pub toll: f32,
}

pub struct Network {
    pub d: NetworkData,
    /// Lane index within its edge (0 = rightmost).
    pub lane_index: Vec<u8>,
    pub lane_internal: Vec<bool>,
    /// Lanes whose sampled heights are absolute (bridges), not offsets above the ground.
    pub lane_abs_y: Vec<bool>,
    /// Geometric length of each lane's shape (SUMO lengths can differ slightly).
    pub lane_geom_length: Vec<f32>,
    /// Cumulative geometric distance at each shape point.
    pub shape_dist: Vec<f32>,
    /// Length of the internal path of each link (sum of its via lanes).
    pub link_via_length: Vec<f32>,
    /// Vehicle classes allowed on the whole link (from, via and to lanes).
    pub link_allow: Vec<u16>,
    /// Lane permissions as loaded: edits change `d.lane_allow`, and a vehicle already on a
    /// lane closed to it may still drive off it (`refresh_links`).
    pub lane_allow_loaded: Vec<u16>,
    /// Turns banned by edits: these links carry no traffic.
    pub link_banned: Vec<bool>,
    /// For each junction, the link id of each request index.
    pub junction_request_links: Vec<u32>,
    pub junction_request_offset: Vec<u32>,
    pub edge_length: Vec<f32>,
    pub edge_speed: Vec<f32>,
    /// Edge midpoint (x, z), for routing heuristics and demand distances.
    pub edge_mid: Vec<(f32, f32)>,
    pub succ_offset: Vec<u32>,
    pub succ: Vec<Successor>,
}

impl Network {
    /// Whether the player set signal program `t` (see `NetworkData::tls_fixed`).
    pub fn tls_fixed(&self, t: usize) -> bool {
        self.d.tls_fixed.get(t).is_some_and(|&f| f != 0)
    }

    pub fn build(d: NetworkData) -> Result<Network, NetworkError> {
        let n_lanes = d.lane_edge.len();
        let n_edges = d.edge_flags.len();
        let n_links = d.link_from.len();
        let n_junctions = d.junction_link_count.len();
        if d.lane_length.len() != n_lanes
            || d.lane_next.len() != n_lanes
            || d.lane_link_offsets.len() != n_lanes + 1
            || d.lane_shape_offsets.len() != n_lanes + 1
        {
            return Err(NetworkError::Inconsistent("lane arrays"));
        }
        if d.edge_lane_start.len() != n_edges || d.edge_lane_count.len() != n_edges {
            return Err(NetworkError::Inconsistent("edge arrays"));
        }
        if d.link_to.len() != n_links || d.link_request.len() != n_links {
            return Err(NetworkError::Inconsistent("link arrays"));
        }
        let n_points = *d.lane_shape_offsets.last().unwrap() as usize;
        if d.lane_shape.len() != n_points * 3 {
            return Err(NetworkError::Inconsistent("lane shapes"));
        }

        let mut lane_index = vec![0u8; n_lanes];
        let mut lane_internal = vec![false; n_lanes];
        for e in 0..n_edges {
            let start = d.edge_lane_start[e] as usize;
            for k in 0..d.edge_lane_count[e] as usize {
                lane_index[start + k] = k as u8;
            }
        }
        let has_y = d.lane_shape_y.len() == n_points;
        let mut lane_abs_y = vec![false; n_lanes];
        for (lane, &edge) in d.lane_edge.iter().enumerate() {
            let flags = d.edge_flags[edge as usize];
            lane_internal[lane] = flags & edge_flag::INTERNAL != 0;
            lane_abs_y[lane] = has_y && flags & edge_flag::BRIDGE != 0;
        }

        let mut shape_dist = vec![0f32; n_points];
        let mut lane_geom_length = vec![0f32; n_lanes];
        for lane in 0..n_lanes {
            let (a, b) = (
                d.lane_shape_offsets[lane] as usize,
                d.lane_shape_offsets[lane + 1] as usize,
            );
            let mut acc = 0.0;
            for p in a..b {
                if p > a {
                    let dx = d.lane_shape[p * 3] - d.lane_shape[(p - 1) * 3];
                    let dz = d.lane_shape[p * 3 + 1] - d.lane_shape[(p - 1) * 3 + 1];
                    acc += (dx * dx + dz * dz).sqrt();
                }
                shape_dist[p] = acc;
            }
            lane_geom_length[lane] = acc;
        }

        let mut link_via_length = vec![0f32; n_links];
        for l in 0..n_links {
            let mut lane = d.link_via[l];
            let mut len = 0.0;
            let mut guard = 0;
            while lane != NONE && lane_internal[lane as usize] && guard < 8 {
                len += d.lane_length[lane as usize];
                lane = d.lane_next[lane as usize];
                guard += 1;
            }
            link_via_length[l] = len;
        }

        // Request index -> link per junction.
        let mut junction_request_offset = vec![0u32; n_junctions + 1];
        for j in 0..n_junctions {
            junction_request_offset[j + 1] =
                junction_request_offset[j] + d.junction_link_count[j] as u32;
        }
        let mut junction_request_links = vec![NONE; junction_request_offset[n_junctions] as usize];
        for l in 0..n_links {
            let j = d.link_junction[l];
            let r = d.link_request[l];
            if j != NONE && r != u16::MAX && (r as u32) < d.junction_link_count[j as usize] as u32 {
                junction_request_links[(junction_request_offset[j as usize] + r as u32) as usize] =
                    l as u32;
            }
        }

        let mut edge_length = vec![0f32; n_edges];
        let mut edge_mid = vec![(0f32, 0f32); n_edges];
        for e in 0..n_edges {
            let lane0 = d.edge_lane_start[e] as usize;
            if d.edge_lane_count[e] > 0 {
                edge_length[e] = d.lane_length[lane0];
                let (a, b) = (
                    d.lane_shape_offsets[lane0] as usize,
                    d.lane_shape_offsets[lane0 + 1] as usize,
                );
                if b > a {
                    let m = (a + b - 1) / 2;
                    edge_mid[e] = (d.lane_shape[m * 3], d.lane_shape[m * 3 + 1]);
                }
            }
        }

        let lane_allow_loaded = d.lane_allow.clone();
        let mut net = Network {
            d,
            lane_index,
            lane_internal,
            lane_abs_y,
            lane_geom_length,
            shape_dist,
            link_via_length,
            link_allow: vec![0; n_links],
            lane_allow_loaded,
            link_banned: vec![false; n_links],
            junction_request_links,
            junction_request_offset,
            edge_length,
            edge_speed: vec![13.9; n_edges],
            edge_mid,
            succ_offset: vec![0; n_edges + 1],
            succ: Vec::new(),
        };
        net.refresh_speeds();
        net.refresh_links();
        Ok(net)
    }

    /// Edge speeds from their lanes' limits (the rightmost lane's, as SUMO's edge speed).
    pub fn refresh_speeds(&mut self) {
        let d = &self.d;
        for e in 0..d.edge_flags.len() {
            if d.edge_lane_count[e] > 0 {
                self.edge_speed[e] = d.lane_speed[d.edge_lane_start[e] as usize].max(1.0);
            }
        }
    }

    /// Link permissions and the routing graph from the lanes' permissions and the banned
    /// turns. A link needs its junction lanes and the lane it leads to to allow a class; the
    /// lane it leaves counts as loaded, so vehicles on a lane an edit closed can drive off it.
    pub fn refresh_links(&mut self) {
        let d = &self.d;
        for l in 0..d.link_from.len() {
            let mut allow = self.lane_allow_loaded[d.link_from[l] as usize]
                & d.lane_allow[d.link_to[l] as usize];
            let mut lane = d.link_via[l];
            let mut guard = 0;
            while lane != NONE && self.lane_internal[lane as usize] && guard < 8 {
                allow &= d.lane_allow[lane as usize];
                lane = d.lane_next[lane as usize];
                guard += 1;
            }
            self.link_allow[l] = if self.link_banned[l] { 0 } else { allow };
        }
        self.build_routing();
    }

    /// Routing graph: edge -> next edge, merged over all links. A class may plan a U-turn
    /// only where it has no other way on: U-turns are rare in Zagreb, and routes full of
    /// them gridlock short stretches of dual carriageway; buses still turn at terminals.
    /// Every pair of edges a link joins stays in the graph, even with no class allowed, so
    /// the landmark bounds (which ignore classes) stay valid as edits change permissions.
    fn build_routing(&mut self) {
        let d = &self.d;
        let n_edges = d.edge_flags.len();
        let n_links = d.link_from.len();
        let mut onward = vec![0u16; n_edges];
        for l in 0..n_links {
            if d.link_dir[l] != dir::TURN {
                onward[d.lane_edge[d.link_from[l] as usize] as usize] |= self.link_allow[l];
            }
        }
        let mut pairs: Vec<(u32, u32, u16, f32)> = Vec::with_capacity(n_links);
        for l in 0..n_links {
            let from = d.link_from[l] as usize;
            let to = d.link_to[l] as usize;
            let mut allow = self.link_allow[l];
            if d.link_dir[l] == dir::TURN {
                allow &= !onward[d.lane_edge[from] as usize] | vclass::BUS | vclass::TRAM;
            }
            let turn = match d.link_dir[l] {
                dir::LEFT | dir::PARTLEFT => 4.0,
                dir::TURN => 60.0,
                _ => 0.0,
            };
            pairs.push((d.lane_edge[from], d.lane_edge[to], allow, turn));
        }
        pairs.sort_unstable_by_key(|p| (p.0, p.1));
        let mut succ_offset = vec![0u32; n_edges + 1];
        let mut succ: Vec<Successor> = Vec::with_capacity(pairs.len());
        let mut i = 0;
        while i < pairs.len() {
            let (from, to) = (pairs[i].0, pairs[i].1);
            let mut allow = 0;
            let mut penalty = f32::INFINITY;
            while i < pairs.len() && pairs[i].0 == from && pairs[i].1 == to {
                allow |= pairs[i].2;
                penalty = penalty.min(pairs[i].3);
                i += 1;
            }
            succ_offset[from as usize + 1] += 1;
            let toll = if d.edge_flags[to as usize] & edge_flag::TOLL != 0 {
                let lane = d.edge_lane_start[to as usize] as usize;
                TOLL_TIME * d.lane_length[lane]
            } else {
                0.0
            };
            succ.push(Successor {
                edge: to,
                allow,
                penalty,
                toll,
            });
        }
        for e in 0..n_edges {
            succ_offset[e + 1] += succ_offset[e];
        }
        self.succ_offset = succ_offset;
        self.succ = succ;
    }

    pub fn lane_count(&self) -> usize {
        self.d.lane_edge.len()
    }

    pub fn edge_count(&self) -> usize {
        self.d.edge_flags.len()
    }

    pub fn is_internal_edge(&self, edge: u32) -> bool {
        self.d.edge_flags[edge as usize] & edge_flag::INTERNAL != 0
    }

    /// Whether an edge is tolled motorway.
    pub fn is_toll(&self, edge: u32) -> bool {
        self.d.edge_flags[edge as usize] & edge_flag::TOLL != 0
    }

    pub fn edge_lanes(&self, edge: u32) -> std::ops::Range<u32> {
        let start = self.d.edge_lane_start[edge as usize];
        start..start + self.d.edge_lane_count[edge as usize] as u32
    }

    pub fn lane_links(&self, lane: u32) -> std::ops::Range<u32> {
        self.d.lane_link_offsets[lane as usize]..self.d.lane_link_offsets[lane as usize + 1]
    }

    pub fn successors(&self, edge: u32) -> &[Successor] {
        &self.succ
            [self.succ_offset[edge as usize] as usize..self.succ_offset[edge as usize + 1] as usize]
    }

    /// Link with the given request index at a junction.
    pub fn request_link(&self, junction: u32, request: u32) -> u32 {
        self.junction_request_links
            [(self.junction_request_offset[junction as usize] + request) as usize]
    }

    fn logic_words(&self, junction: u32) -> usize {
        (self.d.junction_link_count[junction as usize] as usize)
            .div_ceil(32)
            .max(1)
    }

    /// Request indices `link` (index `request`) must yield to.
    pub fn response(&self, junction: u32, request: u32) -> BitIter<'_> {
        let w = self.logic_words(junction);
        let base =
            self.d.junction_logic_offset[junction as usize] as usize + request as usize * 2 * w;
        BitIter::new(&self.d.logic[base..base + w])
    }

    /// Request indices whose paths cross `request`'s path.
    pub fn foes(&self, junction: u32, request: u32) -> BitIter<'_> {
        let w = self.logic_words(junction);
        let base =
            self.d.junction_logic_offset[junction as usize] as usize + request as usize * 2 * w + w;
        BitIter::new(&self.d.logic[base..base + w])
    }

    /// Signal or priority state character of a link right now.
    pub fn link_state_char(&self, link: u32, tls_phase: &[u32]) -> u8 {
        let tls = self.d.link_tls[link as usize];
        if tls != NONE {
            let phase = tls_phase[tls as usize] as usize;
            let off = self.d.phase_state_offsets[phase] as usize;
            let len = self.d.phase_state_offsets[phase + 1] as usize - off;
            let idx = self.d.link_tls_index[link as usize] as usize;
            if idx < len {
                return self.d.phase_states[off + idx];
            }
        }
        LINK_STATE_CHARS
            .get(self.d.link_state[link as usize] as usize)
            .copied()
            .unwrap_or(b'm')
    }

    /// Position (x, y, z) and heading of `s` metres along a lane, shifted `lateral` metres
    /// to the left of the direction of travel. Heading is atan2(dx, dz). `y` is absolute on
    /// bridges (`lane_abs_y`) and the elevation offset above the ground elsewhere.
    pub fn sample(&self, lane: u32, s: f32, lateral: f32) -> [f32; 4] {
        let lane = lane as usize;
        let a = self.d.lane_shape_offsets[lane] as usize;
        let b = self.d.lane_shape_offsets[lane + 1] as usize;
        let shape = &self.d.lane_shape;
        let abs_y = self.lane_abs_y[lane];
        let y_at = |p: usize| {
            if abs_y {
                self.d.lane_shape_y[p]
            } else {
                shape[p * 3 + 2]
            }
        };
        if b <= a {
            return [0.0; 4];
        }
        if b - a == 1 {
            return [shape[a * 3], y_at(a), shape[a * 3 + 1], 0.0];
        }
        let geom = self.lane_geom_length[lane];
        let len = self.d.lane_length[lane].max(0.01);
        let t = (s / len * geom).clamp(0.0, geom);
        let mut p = a;
        while p + 2 < b && self.shape_dist[p + 1] < t {
            p += 1;
        }
        let d0 = self.shape_dist[p];
        let seg = (self.shape_dist[p + 1] - d0).max(1e-6);
        let f = ((t - d0) / seg).clamp(0.0, 1.0);
        let (x0, z0) = (shape[p * 3], shape[p * 3 + 1]);
        let (x1, z1) = (shape[(p + 1) * 3], shape[(p + 1) * 3 + 1]);
        let (dx, dz) = (x1 - x0, z1 - z0);
        let inv = 1.0 / (dx * dx + dz * dz).sqrt().max(1e-6);
        let (nx, nz) = (dz * inv, -dx * inv); // left of travel
        let x = x0 + dx * f + nx * lateral;
        let z = z0 + dz * f + nz * lateral;
        let y = y_at(p) + (y_at(p + 1) - y_at(p)) * f;
        [x, y, z, dx.atan2(dz)]
    }
}

/// Iterator over set bits of a bitset slice.
pub struct BitIter<'a> {
    words: &'a [u32],
    index: usize,
    current: u32,
}

impl<'a> BitIter<'a> {
    fn new(words: &'a [u32]) -> Self {
        BitIter {
            words,
            index: 0,
            current: words.first().copied().unwrap_or(0),
        }
    }
}

impl Iterator for BitIter<'_> {
    type Item = u32;
    fn next(&mut self) -> Option<u32> {
        loop {
            if self.current != 0 {
                let bit = self.current.trailing_zeros();
                self.current &= self.current - 1;
                return Some(self.index as u32 * 32 + bit);
            }
            self.index += 1;
            if self.index >= self.words.len() {
                return None;
            }
            self.current = self.words[self.index];
        }
    }
}
