//! Network edits applied to the running simulation: closed roads and lanes, speed limits,
//! lanes reserved for some vehicle classes (bus lanes), banned turns and signal timings,
//! and how often a public transport line runs (M9b).
//!
//! Edits always apply to the network as loaded: `Engine::set_edits` restores the loaded lane
//! speeds, permissions and signal timings, applies the whole list, and rebuilds what depends
//! on them (link permissions, the routing graph, free-flow travel times). Removing an edit
//! is setting the list without it, in any order.

use crate::network::{Network, vclass};

/// Classes a closed road or lane keeps: buses and trams stay on their timetabled routes.
pub const CLOSED_KEEPS: u16 = vclass::BUS | vclass::TRAM | vclass::RAIL;
/// Speed limits edits may set (m/s): 5-130 km/h.
pub const SPEED_RANGE: (f32, f32) = (5.0 / 3.6, 130.0 / 3.6);
/// Green times edits may set (s).
pub const GREEN_RANGE: (f32, f32) = (3.0, 180.0);

/// One change to the network. Roads are edges, lanes count from the right (0), signal
/// phases from the start of their program.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Edit {
    /// Closed to cars and trucks.
    CloseRoad { edge: u32 },
    /// One lane closed to cars and trucks.
    CloseLane { edge: u32, lane: u8 },
    /// Speed limit on every lane (m/s).
    SpeedLimit { edge: u32, speed: f32 },
    /// Only these vehicle classes may use the lane (`vclass` bits), e.g. a bus lane.
    LaneClasses { edge: u32, lane: u8, classes: u16 },
    /// No turning from one road onto the other.
    BanTurn { from: u32, to: u32 },
    /// Green time (s) of one phase of a signal program.
    Green { tls: u32, phase: u16, seconds: f32 },
    /// A line (the timetable's route index) run `factor` times as often as timetabled
    /// (`transit::FREQUENCY_RANGE`; 0 is no service).
    Frequency { route: u32, factor: f32 },
}

/// Edit kinds in the four-word records the app sends (`Edit::decode`).
pub mod kind {
    pub const CLOSE_ROAD: u32 = 1;
    pub const CLOSE_LANE: u32 = 2;
    pub const SPEED_LIMIT: u32 = 3;
    pub const LANE_CLASSES: u32 = 4;
    pub const BAN_TURN: u32 = 5;
    pub const GREEN: u32 = 6;
    pub const FREQUENCY: u32 = 7;
}

impl Edit {
    /// Edits from records of four words: kind, two arguments and a value (f32 bits).
    /// Records of unknown kinds are skipped.
    pub fn decode(words: &[u32]) -> Vec<Edit> {
        words
            .chunks_exact(4)
            .filter_map(|r| {
                let value = f32::from_bits(r[3]);
                Some(match r[0] {
                    kind::CLOSE_ROAD => Edit::CloseRoad { edge: r[1] },
                    kind::CLOSE_LANE => Edit::CloseLane {
                        edge: r[1],
                        lane: r[2].min(255) as u8,
                    },
                    kind::SPEED_LIMIT => Edit::SpeedLimit {
                        edge: r[1],
                        speed: value,
                    },
                    kind::LANE_CLASSES => Edit::LaneClasses {
                        edge: r[1],
                        lane: r[2].min(255) as u8,
                        classes: value as u16,
                    },
                    kind::BAN_TURN => Edit::BanTurn {
                        from: r[1],
                        to: r[2],
                    },
                    kind::GREEN => Edit::Green {
                        tls: r[1],
                        phase: r[2].min(u16::MAX as u32) as u16,
                        seconds: value,
                    },
                    kind::FREQUENCY => Edit::Frequency {
                        route: r[1],
                        factor: value,
                    },
                    _ => return None,
                })
            })
            .collect()
    }

    /// The four-word record of this edit.
    pub fn encode(&self) -> [u32; 4] {
        match *self {
            Edit::CloseRoad { edge } => [kind::CLOSE_ROAD, edge, 0, 0],
            Edit::CloseLane { edge, lane } => [kind::CLOSE_LANE, edge, lane as u32, 0],
            Edit::SpeedLimit { edge, speed } => [kind::SPEED_LIMIT, edge, 0, speed.to_bits()],
            Edit::LaneClasses {
                edge,
                lane,
                classes,
            } => [
                kind::LANE_CLASSES,
                edge,
                lane as u32,
                (classes as f32).to_bits(),
            ],
            Edit::BanTurn { from, to } => [kind::BAN_TURN, from, to, 0],
            Edit::Green {
                tls,
                phase,
                seconds,
            } => [kind::GREEN, tls, phase as u32, seconds.to_bits()],
            Edit::Frequency { route, factor } => [kind::FREQUENCY, route, 0, factor.to_bits()],
        }
    }
}

/// What edits change, as loaded (after the engine re-times the guessed signal programs).
pub struct Loaded {
    pub lane_speed: Vec<f32>,
    pub lane_allow: Vec<u16>,
    pub phase_duration: Vec<f32>,
    pub phase_min_dur: Vec<f32>,
    pub phase_max_dur: Vec<f32>,
}

impl Loaded {
    pub fn of(net: &Network) -> Loaded {
        Loaded {
            lane_speed: net.d.lane_speed.clone(),
            lane_allow: net.d.lane_allow.clone(),
            phase_duration: net.d.phase_duration.clone(),
            phase_min_dur: net.d.phase_min_dur.clone(),
            phase_max_dur: net.d.phase_max_dur.clone(),
        }
    }

    /// Put the network back as loaded.
    pub fn restore(&self, net: &mut Network) {
        net.d.lane_speed.copy_from_slice(&self.lane_speed);
        net.d.lane_allow.copy_from_slice(&self.lane_allow);
        net.d.phase_duration.copy_from_slice(&self.phase_duration);
        net.d.phase_min_dur.copy_from_slice(&self.phase_min_dur);
        net.d.phase_max_dur.copy_from_slice(&self.phase_max_dur);
        net.link_banned.fill(false);
    }
}

/// Apply one edit to the lane and signal arrays (the caller rebuilds links and routing).
/// False if it does not fit the network: an unknown or junction-internal road, a lane or
/// phase the road or program does not have, a value out of range, or a turn no link makes.
/// Frequency edits change the timetable, not the network (`Engine::set_edits`).
pub fn apply(net: &mut Network, edit: &Edit) -> bool {
    let n_edges = net.edge_count() as u32;
    let road = |e: u32| e < n_edges && !net.is_internal_edge(e);
    match *edit {
        Edit::CloseRoad { edge } => {
            if !road(edge) {
                return false;
            }
            for l in net.edge_lanes(edge) {
                net.d.lane_allow[l as usize] &= CLOSED_KEEPS;
            }
        }
        Edit::CloseLane { edge, lane } => {
            if !road(edge) || lane >= net.d.edge_lane_count[edge as usize] {
                return false;
            }
            let l = net.d.edge_lane_start[edge as usize] as usize + lane as usize;
            net.d.lane_allow[l] &= CLOSED_KEEPS;
        }
        Edit::SpeedLimit { edge, speed } => {
            if !road(edge) || !(SPEED_RANGE.0..=SPEED_RANGE.1).contains(&speed) {
                return false;
            }
            for l in net.edge_lanes(edge) {
                net.d.lane_speed[l as usize] = speed;
            }
        }
        Edit::LaneClasses {
            edge,
            lane,
            classes,
        } => {
            if !road(edge) || lane >= net.d.edge_lane_count[edge as usize] {
                return false;
            }
            let l = net.d.edge_lane_start[edge as usize] as usize + lane as usize;
            net.d.lane_allow[l] = classes;
        }
        Edit::BanTurn { from, to } => {
            if !road(from) || !road(to) {
                return false;
            }
            let d = &net.d;
            let mut any = false;
            for lane in net.edge_lanes(from) {
                for l in net.lane_links(lane) {
                    if d.lane_edge[d.link_to[l as usize] as usize] == to {
                        net.link_banned[l as usize] = true;
                        any = true;
                    }
                }
            }
            return any;
        }
        Edit::Green {
            tls,
            phase,
            seconds,
        } => {
            let d = &mut net.d;
            if tls as usize + 1 >= d.tls_phase_offsets.len()
                || !(GREEN_RANGE.0..=GREEN_RANGE.1).contains(&seconds)
            {
                return false;
            }
            let (a, b) = (
                d.tls_phase_offsets[tls as usize] as usize,
                d.tls_phase_offsets[tls as usize + 1] as usize,
            );
            let p = a + phase as usize;
            if p >= b {
                return false;
            }
            d.phase_duration[p] = seconds;
            d.phase_min_dur[p] = d.phase_min_dur[p].min(seconds);
            d.phase_max_dur[p] = d.phase_max_dur[p].max(seconds);
        }
        Edit::Frequency { .. } => return false,
    }
    true
}
