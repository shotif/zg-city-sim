//! Pedestrians at crossings (M8c). Pedestrians are not simulated one by one: each crossing
//! OpenStreetMap maps on a drivable road (pipeline/pedestrians.py) gets arrivals at random,
//! at its estimated pedestrians a day spread over the hours, and the time they take to cross.
//! Drivers give way to them on zebra crossings; at a signalled junction they cross while the
//! traffic across their crossing has red, and drivers turning across it give way; a crossing
//! with signals of its own turns red for drivers when pedestrians have waited.

use crate::network::{NONE, Network};

pub mod kind {
    pub const ZEBRA: u8 = 0;
    pub const JUNCTION_SIGNAL: u8 = 1;
    pub const OWN_SIGNAL: u8 = 2;
}

/// Walking speed (m/s), and the seconds a group takes to step off the kerb.
pub const WALK_SPEED: f64 = 1.2;
pub const START_TIME: f64 = 2.0;
/// At a signal, pedestrians walk at least this long (s) before their clearance time (the
/// crossing's length at `WALK_SPEED`): a phase they walk in lasts that long once they start.
pub const MIN_WALK: f64 = 5.0;
/// A crossing with signals of its own turns red for drivers when pedestrians wait, at most
/// once in this many seconds, after this many seconds of yellow.
pub const OWN_SIGNAL_GAP: f64 = 60.0;
pub const OWN_SIGNAL_YELLOW: f64 = 3.0;

/// Whether a phase of signal program `tls` shows red (or nothing green or yellow) to every
/// one of `links`.
fn has_walk_phase(net: &Network, tls: u32, links: &[u32]) -> bool {
    let d = &net.d;
    let (a, b) = (
        d.tls_phase_offsets[tls as usize] as usize,
        d.tls_phase_offsets[tls as usize + 1] as usize,
    );
    (a..b).any(|p| {
        let states = &d.phase_states
            [d.phase_state_offsets[p] as usize..d.phase_state_offsets[p + 1] as usize];
        links.iter().all(|&l| {
            !matches!(
                states.get(d.link_tls_index[l as usize] as usize),
                Some(b'G' | b'g' | b'y' | b'Y')
            )
        })
    })
}

/// The crossings as the pipeline writes them.
#[derive(Clone, Debug, Default)]
pub struct CrossingData {
    /// Lanes each crossing crosses: `lanes[lane_offsets[c]..lane_offsets[c + 1]]`, with the
    /// metres along each lane where it is (`pos`).
    pub lane_offsets: Vec<u32>,
    pub lanes: Vec<u32>,
    pub pos: Vec<f32>,
    pub kind: Vec<u8>,
    /// Kerb to kerb (m).
    pub length: Vec<f32>,
    /// The signalled junction a `JUNCTION_SIGNAL` crossing belongs to, else NONE.
    pub junction: Vec<u32>,
    /// Estimated pedestrians a weekday.
    pub daily: Vec<f32>,
    /// Share of the day's pedestrians in each hour.
    pub hourly: [f32; 24],
}

impl CrossingData {
    pub fn count(&self) -> usize {
        self.kind.len()
    }

    pub fn lanes_of(&self, c: usize) -> std::ops::Range<usize> {
        self.lane_offsets[c] as usize..self.lane_offsets[c + 1] as usize
    }

    /// Whether the arrays fit together and name lanes of a network with `lane_count` lanes.
    pub fn consistent(&self, lane_count: usize) -> bool {
        let n = self.kind.len();
        self.lane_offsets.len() == n + 1
            && [self.length.len(), self.junction.len(), self.daily.len()]
                .iter()
                .all(|&len| len == n)
            && self.lanes.len() == self.pos.len()
            && self
                .lane_offsets
                .last()
                .is_some_and(|&o| o as usize == self.lanes.len())
            && self.lane_offsets.windows(2).all(|w| w[0] <= w[1])
            && self.lanes.iter().all(|&l| (l as usize) < lane_count)
    }
}

pub struct Pedestrians {
    pub data: CrossingData,
    /// Share of the estimated pedestrians that arrive.
    pub scale: f32,
    /// Pedestrians waiting at the kerb of each crossing.
    pub waiting: Vec<u32>,
    /// Until when pedestrians are on each crossing (s); in the past when nobody is.
    pub busy_until: Vec<f64>,
    /// When pedestrians last started across (s).
    pub walk_since: Vec<f64>,
    /// Crossings with signals of their own: since when drivers have had yellow then red
    /// (s), NaN while they have green.
    pub stop_since: Vec<f64>,
    /// (lane, metres along it, crossing), sorted: the crossings on each lane.
    by_lane: Vec<(u32, f32, u32)>,
    /// Crossings at a signalled junction: the links whose green keeps pedestrians at the kerb
    /// (traffic across the crossing: all leaving the road it crosses towards the junction,
    /// and straight on into it), and their signal program (NONE: none found, so the crossing
    /// works as one with signals of its own).
    blocking_offsets: Vec<u32>,
    blocking: Vec<u32>,
    pub tls: Vec<u32>,
    /// (signal program, crossing), sorted: the crossings that walk with each program.
    by_tls: Vec<(u32, u32)>,
    /// Pedestrians who have crossed; vehicle-seconds drivers stood for them.
    pub crossed: u64,
    pub stood: f64,
}

impl Pedestrians {
    pub fn new(data: CrossingData, net: &Network) -> Pedestrians {
        let n = data.count();
        let mut p = Pedestrians {
            data,
            scale: 1.0,
            waiting: vec![0; n],
            busy_until: vec![f64::NEG_INFINITY; n],
            walk_since: vec![f64::NEG_INFINITY; n],
            stop_since: vec![f64::NAN; n],
            by_lane: Vec::new(),
            blocking_offsets: vec![0; n + 1],
            blocking: Vec::new(),
            tls: vec![NONE; n],
            by_tls: Vec::new(),
            crossed: 0,
            stood: 0.0,
        };
        p.attach(net);
        p
    }

    /// Fit the crossings to `net` (again after roads are drawn: lanes keep their ids, links
    /// do not): which lanes they are on, and which links' green keeps pedestrians waiting.
    pub fn attach(&mut self, net: &Network) {
        let d = &net.d;
        let n_lanes = d.lane_edge.len();
        self.by_lane.clear();
        for c in 0..self.data.count() {
            for i in self.data.lanes_of(c) {
                let lane = self.data.lanes[i];
                if (lane as usize) < n_lanes && !net.lane_internal[lane as usize] {
                    self.by_lane.push((lane, self.data.pos[i], c as u32));
                }
            }
        }
        self.by_lane
            .sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        self.blocking.clear();
        self.blocking_offsets.clear();
        self.blocking_offsets.push(0);
        for c in 0..self.data.count() {
            let j = self.data.junction[c];
            // Links from the crossed lanes into the junction, and straight on out of it into
            // them, under its signals.
            let (mut from, mut into) = (Vec::new(), Vec::new());
            let mut tls = NONE;
            if j != NONE && (j as usize) < d.junction_link_count.len() {
                let (a, b) = (
                    net.junction_request_offset[j as usize] as usize,
                    net.junction_request_offset[j as usize + 1] as usize,
                );
                for i in self.data.lanes_of(c) {
                    let lane = self.data.lanes[i] as usize;
                    if lane >= n_lanes {
                        continue;
                    }
                    let edge = d.lane_edge[lane] as usize;
                    for &link in &net.junction_request_links[a..b] {
                        if link == NONE || d.link_tls[link as usize] == NONE {
                            continue;
                        }
                        let l = link as usize;
                        if d.link_from[l] as usize == lane && d.edge_to[edge] == j {
                            from.push(link);
                            tls = d.link_tls[l];
                        } else if d.link_to[l] as usize == lane
                            && d.edge_from[edge] == j
                            && d.link_dir[l] == crate::network::dir::STRAIGHT
                        {
                            into.push(link);
                            tls = d.link_tls[l];
                        }
                    }
                }
            }
            // Pedestrians walk in a phase where all of these have red; failing one, in a
            // phase where the traffic coming to the crossing has; failing that, the crossing
            // works with signals of its own.
            let mut blocking: Vec<u32> = from.iter().chain(&into).copied().collect();
            if tls != NONE && !has_walk_phase(net, tls, &blocking) {
                blocking = from;
                if blocking.is_empty() || !has_walk_phase(net, tls, &blocking) {
                    blocking.clear();
                    tls = NONE;
                }
            }
            self.blocking.extend(&blocking);
            self.tls[c] = tls;
            self.blocking_offsets.push(self.blocking.len() as u32);
        }
        self.by_tls = (0..self.data.count())
            .filter(|&c| self.tls[c] != NONE && self.data.kind[c] == kind::JUNCTION_SIGNAL)
            .map(|c| (self.tls[c], c as u32))
            .collect();
        self.by_tls.sort_unstable();
    }

    /// The crossings whose pedestrians walk with signal program `t`.
    pub fn at_signal(&self, t: u32) -> impl Iterator<Item = u32> + '_ {
        let start = self.by_tls.partition_point(|e| e.0 < t);
        self.by_tls[start..]
            .iter()
            .take_while(move |e| e.0 == t)
            .map(|e| e.1)
    }

    /// The crossings on `lane`, by position: (metres along it, crossing).
    pub fn on_lane(&self, lane: u32) -> impl Iterator<Item = (f32, u32)> + '_ {
        let start = self.by_lane.partition_point(|e| e.0 < lane);
        self.by_lane[start..]
            .iter()
            .take_while(move |e| e.0 == lane)
            .map(|e| (e.1, e.2))
    }

    pub fn blocking_links(&self, c: usize) -> &[u32] {
        &self.blocking[self.blocking_offsets[c] as usize..self.blocking_offsets[c + 1] as usize]
    }

    /// Whether crossing `c` works with its own signals (drivers stop when pedestrians call).
    pub fn own_signal(&self, c: usize) -> bool {
        self.data.kind[c] == kind::OWN_SIGNAL
            || self.data.kind[c] == kind::JUNCTION_SIGNAL && self.tls[c] == NONE
    }

    /// What crossing `c` shows drivers at `time`: b'G' (go on), b'y' (stop if you can: lights
    /// turning red at a crossing with signals of its own) or b'r' (pedestrians on it).
    pub fn state(&self, c: usize, time: f64) -> u8 {
        if self.own_signal(c) {
            let since = self.stop_since[c];
            if !since.is_nan() {
                return if time - since < OWN_SIGNAL_YELLOW {
                    b'y'
                } else {
                    b'r'
                };
            }
        }
        if self.busy_until[c] > time {
            b'r'
        } else {
            b'G'
        }
    }

    /// Seconds pedestrians need from starting across crossing `c` until it is clear.
    pub fn crossing_time(&self, c: usize) -> f64 {
        START_TIME + self.data.length[c] as f64 / WALK_SPEED
    }

    /// For drawing, two bytes per crossing: pedestrians waiting (at most 255), and how far
    /// across the last to start are (0-254 of the way; 255: nobody on it).
    pub fn write_state(&self, time: f64, out: &mut Vec<u8>) {
        out.clear();
        for c in 0..self.data.count() {
            out.push(self.waiting[c].min(255) as u8);
            let walk = self.data.length[c] as f64 / WALK_SPEED;
            let since = time - (self.busy_until[c] - self.crossing_time(c)) - START_TIME;
            out.push(if self.busy_until[c] > time {
                ((since / walk).clamp(0.0, 1.0) * 254.0) as u8
            } else {
                255
            });
        }
    }

    /// Pedestrians waiting at `c` start across at `time`.
    pub fn start(&mut self, c: usize, time: f64) {
        let until = time + self.crossing_time(c);
        if self.busy_until[c] <= time {
            self.walk_since[c] = time;
        }
        self.busy_until[c] = self.busy_until[c].max(until);
        self.crossed += self.waiting[c] as u64;
        self.waiting[c] = 0;
    }
}
