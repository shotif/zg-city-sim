//! The microscopic traffic simulation.
//!
//! Each step (`DT` seconds):
//! 1. traffic lights advance (actuated: a green phase ends early once nobody arrives);
//! 2. every vehicle plans its acceleration: the Intelligent Driver Model behind its leader,
//!    stopping at red lights, yielding at junctions, slowing for turns;
//! 3. vehicles move, crossing into junctions and onto the next road;
//! 4. vehicles change lanes, to reach their next turn or to overtake (MOBIL);
//! 5. new trips are routed and inserted; vehicles at their destination leave.
//!
//! Junction right-of-way comes from SUMO's request matrices: a link must yield to the
//! links in its `response` row and must not enter while a vehicle on a `foes` link is
//! inside the junction. Vehicles also wait before a junction they could not leave.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};

use crate::demand::Demand;
use crate::edits::{self, Edit, Loaded};
use crate::idm;
use crate::network::{NONE, Network, NetworkData, dir, vclass};
use crate::rng::Rng;
use crate::router::{LandmarkBuild, Landmarks, Router};
use crate::transit::{PendingRun, Transit, TransitRun};
use crate::vtype::{self, TYPES, VType};
use crate::weather::Weather;

// Swapping in a changed network while traffic runs (roads drawn in the app).
#[path = "patch.rs"]
mod patch;
pub use patch::LanePiece;

/// Simulation step (s).
pub const DT: f32 = 0.5;
/// 32-bit words per vehicle slot in the render buffer.
pub const RENDER_STRIDE: usize = 8;
/// Vehicles stopped this long are removed, as SUMO "teleports" them (same default), so
/// gridlocks clear. Long enough to sit out two red phases at the biggest junctions.
pub const STUCK_TIME: f32 = 300.0;
/// Seconds before a vehicle whose detour failed tries again.
const REROUTE_RETRY: f32 = 20.0;
/// Shortest stop of a bus, tram or train (s), for passengers to get on and off.
const MIN_DWELL: [f64; 5] = [0.0, 0.0, 15.0, 20.0, 30.0];
/// Trips that cannot start within this time (s), for lack of room at the stop, are dropped.
const MAX_TRANSIT_DELAY: f64 = 300.0;
/// Trips that cannot be inserted within this time are dropped.
const MAX_INSERT_DELAY: f64 = 120.0;
/// Trips from beyond the map wait longer: their queue reaches past the map's edge.
const MAX_ENTRY_DELAY: f64 = 600.0;
/// Safety margin (s) a yielding vehicle wants before a priority vehicle arrives.
const YIELD_MARGIN: f32 = 1.5;
/// After waiting this long at a junction (s, not counting red lights), a driver pushes in
/// where oncoming drivers can still brake comfortably, and drivers who could stop let it go
/// first.
const PUSH_IN_WAIT: f32 = 15.0;
/// After waiting this long (s, red lights included: between signals a metre apart the way on
/// may only clear at a red), a driver enters a junction even if the road behind it is full,
/// so gridlocks can unwind.
const BLOCK_BOX_WAIT: f32 = 60.0;
/// Level crossings (M8b): the lights start to flash this long (s) before a train gets to
/// the crossing, the barriers are down `CROSSING_WARN` s later (drivers who can stop in
/// comfort stop at the lights; at the barriers only those who cannot stop at all go on),
/// and they rise this long after the train's rear has cleared it. Trains look this far
/// ahead (m) for crossings.
const CROSSING_LEAD: f64 = 30.0;
const CROSSING_WARN: f64 = 5.0;
const CROSSING_RISE: f64 = 5.0;
const CROSSING_LOOK: f32 = 3000.0;
/// A vehicle standing inside a junction this long (s) no longer stops others from crossing
/// its path (SUMO's --ignore-junction-blocker), so gridlocks can unwind.
const JUNCTION_BLOCKER_TIME: f32 = 60.0;
/// Actuated signals keep a green phase while a vehicle arrives within this time (s).
const MAX_GAP: f32 = 3.0;
/// Lanes into a signal shorter than this (m), and than this plus a tram where trams run,
/// cannot show who waits for it: their links count as called, so their phases are never
/// skipped (`skip_idle_phases`).
const CALL_LANE: f32 = 20.0;
const TRAM_LENGTH: f32 = vtype::TYPES[vtype::TRAM as usize].length;
/// Longest an actuated green phase runs past its planned duration (s).
const MAX_EXTENSION: f32 = 20.0;
/// MOBIL lane changes: weight of the new follower's disadvantage and the gain needed.
const POLITENESS: f32 = 0.3;
const CHANGE_THRESHOLD: f32 = 0.3;
/// Lateral speed of a lane change, for drawing it (m/s).
const LATERAL_SPEED: f32 = 1.1;
/// Seconds between statistics updates of edge travel times and speeds.
const EDGE_STATS_INTERVAL: u32 = 120;
/// Drivers on their way weigh their route this often (s), and look for another way when the
/// rest of it takes this share and these seconds longer than they expected
/// (`reroute_en_route`). They take a new way that saves at least this share and these
/// seconds of the time left, and one that needs another lane only with this much road left
/// (m) to change lanes on.
const REROUTE_CHECK: f32 = 60.0;
const REROUTE_SLOWER: f32 = 0.25;
const REROUTE_LOSS: f32 = 60.0;
const REROUTE_GAIN: f32 = 0.1;
const REROUTE_GAIN_TIME: f32 = 60.0;
const REROUTE_LANE_ROOM: f32 = 100.0;
/// Edges at most this long (m), or this many seconds long at their speed limit, are too
/// short to change lanes on: lane choice looks past them. On a motorway at 100 km/h, a lane
/// that ends 190 m on needs looking out for before.
const LANE_CHANGE_ROOM: f32 = 150.0;
const LANE_CHANGE_SECONDS: f32 = 10.0;
/// How many short edges ahead lane choice looks through.
const SHORT_EDGE_LOOKAHEAD: u32 = 4;
/// Routing cost of a closed road (s): routes avoid it wherever there is another way.
const CLOSED_TIME: f32 = 3_600.0;
/// After an edit, every vehicle re-plans its route within this time (s); those whose way on
/// the edit closed re-plan at once.
const REPLAN_TIME: f32 = 60.0;
/// Vehicles this close (m) to the end of their lane keep their plan for the junction ahead.
const REPLAN_MARGIN: f32 = 25.0;
/// Landmark searches run per step while the tables are rebuilt after an edit.
const LANDMARK_SEARCHES_PER_STEP: usize = 1;

/// Flags in the render buffer's info word (bits 0-7: vehicle type, 16-31: colour seed).
pub mod info {
    pub const ABS_Y: u32 = 1 << 8;
    pub const BRAKE: u32 = 1 << 9;
    pub const BLINK_LEFT: u32 = 1 << 10;
    pub const BLINK_RIGHT: u32 = 1 << 11;
}

/// Slots in the statistics array (`Engine::stats_array`).
pub mod stat {
    pub const TIME: usize = 0;
    pub const RUNNING: usize = 1;
    pub const DEPARTED: usize = 2;
    pub const ARRIVED: usize = 3;
    pub const TELEPORTED: usize = 4;
    pub const NO_ROUTE: usize = 5;
    pub const INSERT_FAILED: usize = 6;
    pub const BACKLOG: usize = 7;
    pub const MEAN_SPEED: usize = 8;
    pub const STOPPED: usize = 9;
    pub const MEAN_TRIP_TIME: usize = 10;
    pub const MEAN_TRIP_KM: usize = 11;
    pub const PENDING: usize = 12;
    pub const SLOTS: usize = 13;
    pub const TRAMS: usize = 14;
    pub const BUSES: usize = 15;
    /// Vehicles coming from or going to places beyond the map.
    pub const OUTSIDE: usize = 16;
    /// Since the start: hours spent driving by road vehicles (not trams), hours of delay
    /// (time lost against driving at the speed limit) and kilometres driven.
    pub const VEHICLE_HOURS: usize = 17;
    pub const DELAY_HOURS: usize = 18;
    pub const VEHICLE_KM: usize = 19;
    /// HŽ trains running.
    pub const TRAINS: usize = 20;
    pub const LEN: usize = 21;
}

/// Trip flags.
pub mod trip {
    /// Comes from beyond the map: drives in at the start of its first edge, at speed.
    pub const ENTER: u8 = 1;
    /// Goes beyond the map: drives off the end of its last edge.
    pub const EXIT: u8 = 2;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trip {
    /// Departure time (s since midnight).
    pub depart: f64,
    pub from: u32,
    pub to: u32,
    pub vtype: u8,
    /// `trip::*` flags.
    pub flags: u8,
}

/// Min-heap entry by departure time.
struct Pending(Trip);

impl PartialEq for Pending {
    fn eq(&self, other: &Self) -> bool {
        self.0.depart == other.0.depart
    }
}
impl Eq for Pending {}
impl PartialOrd for Pending {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Pending {
    fn cmp(&self, other: &Self) -> Ordering {
        other.0.depart.total_cmp(&self.0.depart)
    }
}

/// A routed trip waiting for space to enter the road.
struct Waiting {
    trip: Trip,
    route: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct Vehicle {
    /// Generation of this slot; 0 means the slot is free.
    pub serial: u32,
    pub vtype: u8,
    /// Colour and variant seed for drawing.
    pub look: u16,
    pub lane: u32,
    /// Front bumper position along the lane (m).
    pub pos: f32,
    pub speed: f32,
    pub accel: f32,
    /// Drawn lateral offset after a lane change (m, left positive); decays to 0.
    pub lat: f32,
    /// Multiplier on the speed limit this driver aims for.
    pub speed_factor: f32,
    /// Edges to drive, origin first.
    pub route: Vec<u32>,
    /// Index in `route` of the current edge (the edge being left, inside a junction).
    pub route_idx: u32,
    /// Link this vehicle takes at the end of its current normal lane.
    pub next_link: u32,
    /// Link whose junction the vehicle is crossing (until its rear has left it).
    pub cur_link: u32,
    /// Lanes driven before the current one, most recent first (for drawing long vehicles).
    pub hist: [u32; 3],
    /// Where on the last edge the trip ends (m).
    pub arrival_pos: f32,
    /// Whether the vehicle may cross the stop line of `next_link` (decided each step).
    pub will_pass: bool,
    /// Link at whose stop sign the vehicle has already stopped.
    pub stop_done: u32,
    /// Time since the vehicle last moved (s).
    pub wait: f32,
    /// Of `wait`, the time not held by a red light (s): what makes a driver impatient to
    /// give way. A driver who has stood a minute at a red light pushes in no sooner than one
    /// who just arrived at the green.
    pub blocked: f32,
    pub wait_total: f32,
    /// Seconds until the next lane change is allowed.
    pub lc_timer: f32,
    /// Seconds until a failed detour may be tried again.
    pub reroute_timer: f32,
    /// When the driver last weighed its route on the way (s, simulation time; negative:
    /// not yet), and the seconds it then expected the rest of the way to take
    /// (`reroute_en_route`).
    pub plan_time: f64,
    pub plan_cost: f32,
    /// A vehicle that needs to change into this vehicle's lane just ahead of it.
    pub coop: u32,
    /// Indicator: 1 left, -1 right.
    pub blink: i8,
    pub depart: f64,
    pub distance: f32,
    /// `trip::*` flags of the trip.
    pub trip_flags: u8,
    /// Whether the driver's routes weigh motorway tolls (`Engine::weighs_tolls`).
    pub weighs_tolls: bool,
    /// Timetabled trip of a bus or tram.
    pub transit: Option<Box<TransitRun>>,
}

impl Vehicle {
    fn empty() -> Vehicle {
        Vehicle {
            serial: 0,
            vtype: 0,
            look: 0,
            lane: NONE,
            pos: 0.0,
            speed: 0.0,
            accel: 0.0,
            lat: 0.0,
            speed_factor: 1.0,
            route: Vec::new(),
            route_idx: 0,
            next_link: NONE,
            cur_link: NONE,
            hist: [NONE; 3],
            arrival_pos: 0.0,
            will_pass: true,
            stop_done: NONE,
            wait: 0.0,
            blocked: 0.0,
            wait_total: 0.0,
            lc_timer: 0.0,
            reroute_timer: 0.0,
            plan_time: -1.0,
            plan_cost: 0.0,
            coop: NONE,
            blink: 0,
            depart: 0.0,
            distance: 0.0,
            trip_flags: 0,
            weighs_tolls: true,
            transit: None,
        }
    }

    pub fn alive(&self) -> bool {
        self.serial != 0
    }

    fn params(&self) -> &'static VType {
        &TYPES[self.vtype as usize]
    }
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub running: u32,
    pub departed: u64,
    pub arrived: u64,
    pub teleported: u64,
    pub no_route: u64,
    pub insert_failed: u64,
    pub mean_speed: f32,
    pub stopped: u32,
    /// Sums over finished trips (time in s, distance in km) and their number.
    pub trip_time_sum: f64,
    pub trip_km_sum: f64,
    pub trip_count: u64,
    pub mean_trip_time: f32,
    pub mean_trip_km: f32,
    /// Routes computed and edges the searches settled (routing cost).
    pub routes: u64,
    pub route_settled: u64,
    /// Vehicles that found themselves in a lane with no way on along their route and went
    /// another way (M7e).
    pub lane_reroutes: u64,
    /// Vehicles that took another way on their way because the roads ahead jammed.
    pub en_route_reroutes: u64,
    /// Why removed vehicles were stuck (`Holdup` names).
    pub teleport_reasons: std::collections::BTreeMap<String, u64>,
    /// Details of the first few removals per reason (with `Engine::debug`).
    pub teleport_log: Vec<String>,
    pub trams: u32,
    pub trains: u32,
    pub buses: u32,
    /// Running vehicles coming from or going beyond the map.
    pub outside: u32,
    /// Vehicles removed (stuck) per edge.
    pub removed_at: std::collections::BTreeMap<u32, u32>,
    /// Since the start, road vehicles (not trams): seconds driving, seconds of delay against
    /// the speed limit, metres driven.
    pub vehicle_seconds: f64,
    pub delay_seconds: f64,
    pub vehicle_metres: f64,
}

enum Finish {
    Arrived,
    Teleported,
}

/// A vehicle crossing or about to cross a junction on some link.
#[derive(Clone, Copy, Default)]
struct LinkUser {
    veh: u32,
    /// Seconds until it reaches the stop line (0 if already inside).
    arrive: f32,
    /// Seconds until its rear has left the junction.
    leave: f32,
    speed: f32,
    /// Whether it could still stop comfortably before the stop line.
    can_stop: bool,
}

/// What a vehicle decided this step.
struct Plan {
    acc: f32,
    /// Decision for the vehicle's own next link.
    pass: Option<bool>,
    blink: i8,
    /// Stop sign this vehicle has now stopped at.
    stopped_at: u32,
    /// A bus or tram standing at its next stop.
    at_stop: bool,
    /// A bus or tram that drove past its next stop.
    missed_stop: bool,
}

enum LaneChange {
    To(u32),
    /// Ask this vehicle (the follower on the target lane) to let us in.
    AskToYield(u32),
    Reroute,
}

/// Why a vehicle is not moving (for diagnostics and statistics).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Holdup {
    /// Inside a junction.
    InJunction,
    /// Behind another vehicle on the same lane.
    Queued,
    /// On a lane that does not lead on its route; waiting to change lanes.
    WrongLane,
    /// Red (or yellow) light.
    Signal,
    /// The road behind the junction is full.
    ExitFull,
    /// Yielding to traffic in or approaching the junction.
    Yielding,
    /// Waiting at a stop sign.
    StopSign,
    /// A vehicle just past the stop line, on the junction's lanes or beyond.
    BlockedAhead,
    Other,
    /// (Delay roots only, `queue_root`) the road beyond is full of traffic moving slowly,
    /// or of a queue standing away from its junction.
    SlowRoad,
    StandingMidRoad,
}

impl Holdup {
    /// Kinds of holdup, for tables indexed by `holdup as usize`.
    pub const COUNT: usize = 11;
}
const _: () = assert!(Holdup::StandingMidRoad as usize + 1 == Holdup::COUNT);

/// Junction delay is sampled every this many steps (`measure_delay`).
const DELAY_EVERY: u32 = 10;
/// A queue's front vehicle counts as waiting at the junction within this distance (m) of
/// its stop line.
const DELAY_REACH: f32 = 15.0;

pub struct Engine {
    pub net: Network,
    pub time: f64,
    pub step_no: u32,
    rng: Rng,
    pub vehs: Vec<Vehicle>,
    free: Vec<u32>,
    next_serial: u32,
    acc: Vec<f32>,
    /// Vehicles on each lane, sorted by position (rearmost first).
    lane_vehs: Vec<Vec<u32>>,
    /// Space on each lane promised to vehicles inside the junction before it (m).
    lane_reserved: Vec<f32>,
    /// Level crossings (M8b), as `net.crossings`: since when each has been closing for a
    /// train (s; NaN while open), and until when a train is due there.
    crossing_since: Vec<f64>,
    crossing_due: Vec<f64>,
    /// Closures of each level crossing since the start, and seconds closed.
    pub crossing_closures: Vec<u32>,
    pub crossing_seconds: Vec<f64>,
    lane_active: Vec<bool>,
    active_lanes: Vec<u32>,
    /// Current phase (index into the network's phase arrays) of each traffic light.
    pub tls_phase: Vec<u32>,
    tls_elapsed: Vec<f32>,
    tls_link_offsets: Vec<u32>,
    tls_links: Vec<u32>,
    /// Current travel time estimate of each edge (s), used for routing.
    pub travel_time: Vec<f32>,
    free_time: Vec<f32>,
    edge_speed_sum: Vec<f32>,
    edge_speed_n: Vec<u16>,
    /// Mean speed / speed limit per edge over the last interval (0-254; 255 = no vehicles).
    pub edge_speed_ratio: Vec<u8>,
    /// Vehicles that have driven onto each edge (from a junction, or from beyond the map),
    /// for comparison with traffic counts.
    pub edge_entered: Vec<u32>,
    /// Closed roads (sorted): routes avoid them.
    closed: Vec<u32>,
    /// Edits in force (`set_edits`), and the network as loaded to apply them to.
    edits: Vec<Edit>,
    loaded: Loaded,
    /// Vehicles (slot, serial) still to re-plan after the last edit, and how many per step.
    replan: Vec<(u32, u32)>,
    replan_per_step: usize,
    /// Landmark tables being rebuilt after an edit made roads faster.
    landmark_job: Option<LandmarkBuild>,
    /// Vehicle-seconds queued at each junction, by why the queue's front vehicle waits
    /// (`Holdup as usize`); measured only while `track_delay` is set (M7a).
    pub delay: Vec<[f32; Holdup::COUNT]>,
    /// The same delay charged to where it starts: a queue held up by a full exit is charged
    /// to the junction downstream whose queue fills that exit, and so on (`queue_root`).
    pub delay_root: Vec<[f32; Holdup::COUNT]>,
    pub track_delay: bool,
    /// Actuated signals skip green phases nobody is waiting for (`skip_idle_phases`).
    pub skip_phases: bool,
    /// Drivers look for another way when the roads ahead jam (`reroute_en_route`).
    pub reroute: bool,
    router: Router,
    pending: BinaryHeap<Pending>,
    waiting: VecDeque<Waiting>,
    pub demand: Option<Demand>,
    /// Timetabled trams and buses.
    pub transit: Option<Transit>,
    /// Scale applied to generated demand (1 = full).
    pub demand_scale: f32,
    /// How the weather changes driving (M6b).
    pub weather: Weather,
    pub stats: Stats,
    /// Per vehicle slot: x, y, z, heading, speed (f32), generation, info (u32), accel (f32).
    pub render: Vec<u32>,
    scratch: Vec<(u32, u32)>,
    /// Seconds spent per step phase (signals+demand, plan, move, lane changes, insertion,
    /// statistics); filled only with the `profile` feature.
    pub phase_seconds: [f64; 6],
    /// Keep diagnostics (`Stats::teleport_log`).
    pub debug: bool,
    /// With `debug`: log the first vehicles removed from these edges instead of the first
    /// few of each reason.
    pub debug_edges: Vec<u32>,
}

/// Shortest green a re-timed phase gets (s).
const MIN_GREEN: f32 = 6.0;
/// Cycle of programs with four or more green phases (s): Zagreb's big junctions run cycles
/// of 90-120 s.
const LONG_CYCLE: f32 = 120.0;

/// Netconvert's guessed signal programs give every phase about the same green, so a
/// six-lane avenue gets as long as a side street, and programs it joins for clusters of
/// junctions lose a third of the cycle to yellow. Split each cycle's green time between its
/// phases by the incoming lanes they let go (at least `MIN_GREEN` each), with a longer cycle
/// for programs with four or more green phases. Yellow and all-red phases keep their length.
fn retime_signals(net: &mut Network, tls_link_offsets: &[u32], tls_links: &[u32]) {
    let fixed: Vec<bool> = (0..net.d.tls_offset.len())
        .map(|t| net.tls_fixed(t))
        .collect();
    let d = &mut net.d;
    for t in 0..d.tls_offset.len() {
        if fixed[t] {
            continue;
        }
        let (a, b) = (
            d.tls_phase_offsets[t] as usize,
            d.tls_phase_offsets[t + 1] as usize,
        );
        if b <= a + 1 {
            continue;
        }
        let links = &tls_links[tls_link_offsets[t] as usize..tls_link_offsets[t + 1] as usize];
        let mut weights = vec![0f32; b - a];
        let mut cycle = 0.0;
        let mut fixed = 0.0;
        let mut lanes: Vec<(u32, f32)> = Vec::new();
        for p in a..b {
            cycle += d.phase_duration[p];
            let off = d.phase_state_offsets[p] as usize;
            let len = d.phase_state_offsets[p + 1] as usize - off;
            let states = &d.phase_states[off..off + len];
            if states.iter().any(|&c| matches!(c, b'y' | b'Y')) {
                fixed += d.phase_duration[p];
                continue;
            }
            let w = lanes_served(d, links, states, &mut lanes);
            if w == 0.0 {
                fixed += d.phase_duration[p];
            }
            weights[p - a] = w;
        }
        let greens = weights.iter().filter(|&&w| w > 0.0).count();
        if greens < 2 {
            continue;
        }
        let cycle = if greens >= 4 {
            cycle.max(LONG_CYCLE)
        } else {
            cycle
        };
        let floor = MIN_GREEN * greens as f32;
        let spare = (cycle - fixed - floor).max(0.0);
        let total: f32 = weights.iter().sum();
        for (k, &w) in weights.iter().enumerate() {
            if w > 0.0 {
                let p = a + k;
                let green = MIN_GREEN + spare * w / total;
                d.phase_duration[p] = green;
                d.phase_min_dur[p] = d.phase_min_dur[p].min(green);
                d.phase_max_dur[p] = d.phase_max_dur[p].max(green);
            }
        }
    }
}

/// Share of a lane a tram track counts as when splitting green time: a tram comes every few
/// minutes, and actuated signals end its phase early when none is near.
const TRAM_TRACK_SHARE: f32 = 0.25;

/// Incoming lanes a phase lets go: those with right of way fully, those that must yield
/// (permissive turns) half, tram tracks a quarter of that. `lanes` is scratch space.
fn lanes_served(d: &NetworkData, links: &[u32], states: &[u8], lanes: &mut Vec<(u32, f32)>) -> f32 {
    lanes.clear();
    for &l in links {
        let w = match states.get(d.link_tls_index[l as usize] as usize) {
            Some(b'G') => 1.0,
            Some(b'g') => 0.5,
            _ => continue,
        };
        let from = d.link_from[l as usize];
        let road = d.lane_allow[from as usize] & (vclass::PASSENGER | vclass::BUS) != 0;
        let w = if road { w } else { w * TRAM_TRACK_SHARE };
        match lanes.iter_mut().find(|(lane, _)| *lane == from) {
            Some(entry) => entry.1 = entry.1.max(w),
            None => lanes.push((from, w)),
        }
    }
    lanes.iter().map(|&(_, w)| w).sum()
}

/// Approaches at least this far apart in heading (radians, 135°) are opposite.
const OPPOSITE_APPROACHES: f32 = 2.356;

/// One phase of a rebuilt signal program.
struct ProgramPhase {
    duration: f32,
    min: f32,
    max: f32,
    states: Vec<u8>,
}

/// Netconvert's programs for clusters of junctions it joins can let approaches go one after
/// another that could go together: on Slavonska avenija at Ulica Josipa Marohnića, each
/// direction got one green phase of seven. Merge two green phases where each lets straight-on
/// traffic go that the other holds, and every conflict between them is a turn giving way to
/// traffic from the opposite approach (the turn then gets a permissive green, `g`). Phases
/// that only add turns (protected turns) are kept. A merged program keeps its cycle, so the
/// re-timing that follows shares out the time the merged phases saved.
fn merge_signal_phases(net: &mut Network, tls_link_offsets: &[u32], tls_links: &[u32]) {
    let n_tls = net.d.tls_offset.len();
    let programs: Vec<Option<Vec<ProgramPhase>>> = (0..n_tls)
        .map(|t| {
            if net.tls_fixed(t) {
                return None;
            }
            let links = &tls_links[tls_link_offsets[t] as usize..tls_link_offsets[t + 1] as usize];
            merged_program(net, t, links)
        })
        .collect();
    if programs.iter().all(Option::is_none) {
        return;
    }
    let d = &mut net.d;
    let mut offsets = Vec::with_capacity(n_tls + 1);
    let (mut duration, mut min_dur, mut max_dur) = (Vec::new(), Vec::new(), Vec::new());
    let (mut state_offsets, mut states) = (vec![0u32], Vec::new());
    for (t, program) in programs.into_iter().enumerate() {
        offsets.push(duration.len() as u32);
        let mut push = |p: ProgramPhase| {
            duration.push(p.duration);
            min_dur.push(p.min);
            max_dur.push(p.max);
            states.extend_from_slice(&p.states);
            state_offsets.push(states.len() as u32);
        };
        match program {
            Some(phases) => phases.into_iter().for_each(&mut push),
            None => {
                for p in d.tls_phase_offsets[t] as usize..d.tls_phase_offsets[t + 1] as usize {
                    let (a, b) = (
                        d.phase_state_offsets[p] as usize,
                        d.phase_state_offsets[p + 1] as usize,
                    );
                    push(ProgramPhase {
                        duration: d.phase_duration[p],
                        min: d.phase_min_dur[p],
                        max: d.phase_max_dur[p],
                        states: d.phase_states[a..b].to_vec(),
                    });
                }
            }
        }
    }
    offsets.push(duration.len() as u32);
    d.tls_phase_offsets = offsets;
    d.phase_duration = duration;
    d.phase_min_dur = min_dur;
    d.phase_max_dur = max_dur;
    d.phase_state_offsets = state_offsets;
    d.phase_states = states;
}

/// Program `t` with its green phases merged (`merge_signal_phases`), or None if none merge.
fn merged_program(net: &Network, t: usize, links: &[u32]) -> Option<Vec<ProgramPhase>> {
    let d = &net.d;
    let (a, b) = (
        d.tls_phase_offsets[t] as usize,
        d.tls_phase_offsets[t + 1] as usize,
    );
    let mut greens: Vec<ProgramPhase> = Vec::new();
    let (mut cycle, mut yellow) = (0.0f32, 0.0f32);
    let mut lanes = Vec::new();
    for p in a..b {
        let states = &d.phase_states
            [d.phase_state_offsets[p] as usize..d.phase_state_offsets[p + 1] as usize];
        cycle += d.phase_duration[p];
        if states.contains(&b'y') {
            yellow = yellow.max(d.phase_duration[p]);
            continue;
        }
        // Programs with other states (all-red phases, red-yellow, blinking) stay as they are.
        if !states.iter().all(|c| matches!(c, b'G' | b'g' | b'r'))
            || lanes_served(d, links, states, &mut lanes) == 0.0
        {
            return None;
        }
        greens.push(ProgramPhase {
            duration: d.phase_duration[p],
            min: d.phase_min_dur[p],
            max: d.phase_max_dur[p],
            states: states.to_vec(),
        });
    }
    let original = greens.len();
    if original < 3 {
        return None;
    }
    loop {
        let mut best: Option<(f32, usize, usize, Vec<u8>)> = None;
        for x in 0..greens.len() {
            for y in x + 1..greens.len() {
                if let Some(merged) =
                    merge_phase_states(net, links, &greens[x].states, &greens[y].states)
                {
                    let w = lanes_served(d, links, &merged, &mut lanes);
                    if best.as_ref().is_none_or(|b| w > b.0) {
                        best = Some((w, x, y, merged));
                    }
                }
            }
        }
        let Some((_, x, y, merged)) = best else {
            break;
        };
        let gone = greens.remove(y);
        let kept = &mut greens[x];
        kept.states = merged;
        kept.min = kept.min.max(gone.min);
        kept.max = kept.max.max(gone.max);
    }
    if greens.len() == original {
        return None;
    }

    // Each green phase is followed by a yellow for the links the next one holds.
    let yellow = if yellow > 0.0 { yellow } else { 3.0 };
    let n = greens.len();
    let yellows: Vec<Option<Vec<u8>>> = (0..n)
        .map(|i| {
            let (now, next) = (&greens[i].states, &greens[(i + 1) % n].states);
            let states: Vec<u8> = now
                .iter()
                .enumerate()
                .map(|(k, &c)| match (c, next.get(k)) {
                    (b'G' | b'g', Some(b'G' | b'g')) => c,
                    (b'G' | b'g', _) => b'y',
                    _ => b'r',
                })
                .collect();
            states.contains(&b'y').then_some(states)
        })
        .collect();
    // The cycle stays (with the long cycle of a big junction); re-timing splits it.
    let cycle = if original >= 4 {
        cycle.max(LONG_CYCLE)
    } else {
        cycle
    };
    let green_time =
        ((cycle - yellow * yellows.iter().flatten().count() as f32) / n as f32).max(MIN_GREEN);
    let mut program = Vec::with_capacity(2 * n);
    for (mut phase, yellow_states) in greens.into_iter().zip(yellows) {
        phase.duration = green_time;
        phase.min = phase.min.min(green_time);
        phase.max = phase.max.max(green_time);
        program.push(phase);
        if let Some(states) = yellow_states {
            program.push(ProgramPhase {
                duration: yellow,
                min: yellow,
                max: yellow,
                states,
            });
        }
    }
    Some(program)
}

/// Heading of the lane a link leaves from, at its end.
fn approach_heading(net: &Network, link: u32) -> f32 {
    let lane = net.d.link_from[link as usize];
    net.sample(lane, net.d.lane_length[lane as usize], 0.0)[3]
}

/// Green phases `a` and `b` of a program merged into one, if they may go together.
fn merge_phase_states(net: &Network, links: &[u32], a: &[u8], b: &[u8]) -> Option<Vec<u8>> {
    let d = &net.d;
    let index = |l: u32| d.link_tls_index[l as usize] as usize;
    let green = |states: &[u8], l: u32| matches!(states.get(index(l)), Some(b'G' | b'g'));
    // Each must let straight-on traffic go that the other holds.
    let own_straight = |x: &[u8], y: &[u8]| {
        links.iter().any(|&l| {
            d.link_dir[l as usize] == dir::STRAIGHT
                && x.get(index(l)) == Some(&b'G')
                && !green(y, l)
        })
    };
    if a.len() != b.len() || !own_straight(a, b) || !own_straight(b, a) {
        return None;
    }
    let mut merged = a.to_vec();
    for &l in links {
        if green(b, l) && !green(a, l) {
            merged[index(l)] = b[index(l)];
        }
    }
    for &la in links {
        if !green(a, la) || green(b, la) {
            continue;
        }
        for &lb in links {
            let j = d.link_junction[la as usize];
            if !green(b, lb) || green(a, lb) || d.link_junction[lb as usize] != j {
                continue;
            }
            let (ra, rb) = (
                d.link_request[la as usize] as u32,
                d.link_request[lb as usize] as u32,
            );
            if !net.foes(j, ra).any(|r| r == rb) && !net.foes(j, rb).any(|r| r == ra) {
                continue;
            }
            let turn = |l: u32| d.link_dir[l as usize] != dir::STRAIGHT;
            let apart = (approach_heading(net, la) - approach_heading(net, lb)).abs()
                % std::f32::consts::TAU;
            if apart.min(std::f32::consts::TAU - apart) < OPPOSITE_APPROACHES {
                return None;
            }
            if turn(la) && net.response(j, ra).any(|r| r == rb) {
                merged[index(la)] = b'g';
            } else if turn(lb) && net.response(j, rb).any(|r| r == ra) {
                merged[index(lb)] = b'g';
            } else {
                return None;
            }
        }
    }
    Some(merged)
}

/// Seconds to cover `d` metres from speed `v`, accelerating at `a` up to `vmax`.
/// The state of `link` at `time` (see `Engine::link_state`), with the crossings' closures
/// (`Engine::crossing_since`).
fn link_state(
    net: &Network,
    tls_phase: &[u32],
    crossing_since: &[f64],
    time: f64,
    link: u32,
) -> u8 {
    let c = net.link_crossing[link as usize];
    if c != NONE
        && let Some(&since) = crossing_since.get(c as usize)
        && !since.is_nan()
    {
        return if time - since < CROSSING_WARN {
            b'y'
        } else {
            b'r'
        };
    }
    net.link_state_char(link, tls_phase)
}

pub fn travel_time(d: f32, v: f32, a: f32, vmax: f32) -> f32 {
    if d <= 0.0 {
        return 0.0;
    }
    let vmax = vmax.max(0.5);
    if v >= vmax {
        return d / v.max(0.5);
    }
    let t_acc = (vmax - v) / a;
    let d_acc = (v + vmax) * 0.5 * t_acc;
    if d_acc >= d {
        ((v * v + 2.0 * a * d).sqrt() - v) / a
    } else {
        t_acc + (d - d_acc) / vmax
    }
}

/// IDM acceleration toward a stop line `d` metres ahead (stopping about 0.5 m before it).
fn stop_at(speed: f32, vmax: f32, d: f32, p: &VType, w: Weather) -> f32 {
    idm::acceleration(speed, vmax, (d - 0.5).max(0.0) + p.min_gap, 0.0, p, w)
}

fn is_left(direction: u8) -> bool {
    matches!(direction, dir::LEFT | dir::PARTLEFT | dir::TURN)
}

fn is_right(direction: u8) -> bool {
    matches!(direction, dir::RIGHT | dir::PARTRIGHT)
}

impl Engine {
    pub fn new(mut net: Network, seed: u64) -> Engine {
        let n_lanes = net.lane_count();
        let n_edges = net.edge_count();
        let n_tls = net.d.tls_offset.len();

        let (tls_link_offsets, tls_links) = patch::tls_links(&net);
        merge_signal_phases(&mut net, &tls_link_offsets, &tls_links);
        retime_signals(&mut net, &tls_link_offsets, &tls_links);

        let free_time: Vec<f32> = (0..n_edges)
            .map(|e| net.edge_length[e] / net.edge_speed[e].max(1.0))
            .collect();
        let mut router = Router::new(n_edges);
        router.landmarks = Some(Landmarks::build(&net, &free_time));
        let loaded = Loaded::of(&net);
        let mut engine = Engine {
            router,
            edits: Vec::new(),
            loaded,
            replan: Vec::new(),
            replan_per_step: 0,
            landmark_job: None,
            delay: Vec::new(),
            delay_root: Vec::new(),
            track_delay: false,
            skip_phases: true,
            reroute: true,
            travel_time: free_time.clone(),
            free_time,
            edge_speed_sum: vec![0.0; n_edges],
            edge_speed_n: vec![0; n_edges],
            edge_speed_ratio: vec![255; n_edges],
            edge_entered: vec![0; n_edges],
            closed: Vec::new(),
            lane_vehs: vec![Vec::new(); n_lanes],
            lane_reserved: vec![0.0; n_lanes],
            crossing_since: Vec::new(),
            crossing_due: Vec::new(),
            crossing_closures: Vec::new(),
            crossing_seconds: Vec::new(),
            lane_active: vec![false; n_lanes],
            active_lanes: Vec::new(),
            tls_phase: vec![0; n_tls],
            tls_elapsed: vec![0.0; n_tls],
            tls_link_offsets,
            tls_links,
            vehs: Vec::new(),
            free: Vec::new(),
            next_serial: 1,
            acc: Vec::new(),
            pending: BinaryHeap::new(),
            waiting: VecDeque::new(),
            demand: None,
            transit: None,
            demand_scale: 1.0,
            weather: Weather::CLEAR,
            stats: Stats::default(),
            render: Vec::new(),
            scratch: Vec::new(),
            phase_seconds: [0.0; 6],
            debug: false,
            debug_edges: Vec::new(),
            rng: Rng::new(seed),
            time: 0.0,
            step_no: 0,
            net,
        };
        engine.reset_signals();
        engine
    }

    /// Jump to a time of day (s since midnight); signals restart their cycles from it.
    pub fn set_time(&mut self, t: f64) {
        self.time = t;
        self.reset_signals();
        if let Some(mut tr) = self.transit.take() {
            // Trips under way start from the stop they last left.
            tr.day_start = (t / 86_400.0).floor() * 86_400.0;
            let tod = t - tr.day_start;
            tr.next_trip = 0;
            tr.waiting.clear();
            while tr.next_trip < tr.data.trips() && tr.start_time(tr.next_trip) <= tod {
                let trip = tr.next_trip;
                tr.next_trip += 1;
                if tr.end_time(trip) <= tod {
                    continue;
                }
                let stops = tr.data.stops(trip as u32);
                let from = stops
                    .clone()
                    .take_while(|&i| (tr.data.stop_time[i] as f64) <= tod)
                    .last()
                    .unwrap_or(stops.start);
                tr.waiting.push(PendingRun {
                    trip: trip as u32,
                    from_stop: from as u32,
                    since: t,
                });
            }
            self.transit = Some(tr);
        }
    }

    pub fn add_trip(&mut self, trip: Trip) {
        self.pending.push(Pending(trip));
    }

    /// Time spent searching routes (s); counted only with the `profile` feature.
    pub fn route_seconds(&self) -> f64 {
        self.router.seconds
    }

    /// Route searches: all, those that failed, and edges settled by found and failed ones.
    pub fn route_counts(&self) -> [u64; 4] {
        let r = &self.router;
        [r.searches, r.failed, r.settled_found, r.settled_failed]
    }

    pub fn vehicles_on(&self, lane: u32) -> &[u32] {
        &self.lane_vehs[lane as usize]
    }

    pub fn step(&mut self) {
        self.step_no = self.step_no.wrapping_add(1);
        #[cfg(feature = "profile")]
        let mut clock = std::time::Instant::now();
        #[cfg(feature = "profile")]
        let mut lap = |engine: &mut Engine, phase: usize| {
            engine.phase_seconds[phase] += clock.elapsed().as_secs_f64();
            clock = std::time::Instant::now();
        };
        #[cfg(not(feature = "profile"))]
        let lap = |_: &mut Engine, _: usize| {};
        self.generate_demand();
        self.update_signals();
        self.update_level_crossings();
        lap(self, 0);
        self.plan();
        lap(self, 1);
        self.move_vehicles();
        lap(self, 2);
        self.lane_changes();
        lap(self, 3);
        self.start_transit();
        self.insert_vehicles();
        self.replan_some();
        self.reroute_en_route();
        self.build_landmarks();
        lap(self, 4);
        self.collect_stats();
        if self.track_delay && self.step_no.is_multiple_of(DELAY_EVERY) {
            self.measure_delay();
        }
        lap(self, 5);
        self.time += DT as f64;
    }

    // ---- demand -------------------------------------------------------------------------

    fn generate_demand(&mut self) {
        let Engine {
            demand,
            rng,
            pending,
            time,
            demand_scale,
            ..
        } = self;
        if let Some(demand) = demand.as_mut() {
            demand.generate(*time, DT as f64, *demand_scale as f64, rng, &mut |trip| {
                pending.push(Pending(trip))
            });
        }
    }

    // ---- traffic lights -------------------------------------------------------------------

    fn phase_range(&self, t: usize) -> (usize, usize) {
        let d = &self.net.d;
        (
            d.tls_phase_offsets[t] as usize,
            d.tls_phase_offsets[t + 1] as usize,
        )
    }

    /// Put every signal where its fixed-time cycle would be at the current time.
    fn reset_signals(&mut self) {
        for t in 0..self.tls_phase.len() {
            let (a, b) = self.phase_range(t);
            if b <= a {
                continue;
            }
            let d = &self.net.d;
            let cycle: f32 = d.phase_duration[a..b].iter().sum();
            let mut into = if cycle > 0.0 {
                ((self.time - d.tls_offset[t] as f64).rem_euclid(cycle as f64)) as f32
            } else {
                0.0
            };
            let mut phase = a;
            while phase + 1 < b && into >= d.phase_duration[phase] {
                into -= d.phase_duration[phase];
                phase += 1;
            }
            self.tls_phase[t] = phase as u32;
            self.tls_elapsed[t] = into;
        }
    }

    fn update_signals(&mut self) {
        for t in 0..self.tls_phase.len() {
            let (a, b) = self.phase_range(t);
            if b <= a {
                continue;
            }
            self.tls_elapsed[t] += DT;
            let p = self.tls_phase[t] as usize;
            let elapsed = self.tls_elapsed[t];
            let d = &self.net.d;
            // Guessed programs allow 50 s extensions on every phase (cycles up to 10
            // minutes); Zagreb's signals run 60-120 s cycles, so extensions stay near plan.
            let min = d.phase_min_dur[p];
            let max = d.phase_max_dur[p].min(d.phase_duration[p].max(min) + MAX_EXTENSION);
            let advance = if d.phase_max_dur[p] > min + 0.5 {
                (elapsed >= max || (elapsed >= min && !self.phase_has_demand(t, p, false)))
                    // A green stays while nobody waits for another (`skip_idle_phases`).
                    && (!self.skip_phases || self.net.tls_fixed(t) || self.other_called(t, p))
            } else {
                elapsed >= d.phase_duration[p]
            };
            if advance {
                let next = if p + 1 >= b { a } else { p + 1 };
                self.tls_phase[t] = self.skip_idle_phases(t, p, next) as u32;
                self.tls_elapsed[t] = 0.0;
            }
        }
    }

    /// The phase an actuated signal goes to from phase `left` instead of `next`: a green
    /// phase nobody is waiting for (a tram phase with no tram near, a protected turn with
    /// nobody turning) is skipped with the yellow after it, as actuated controllers skip
    /// phases nobody has called; with nobody waiting anywhere, the green last shown comes
    /// back. Links green in a skipped phase that the following one holds go red without a
    /// yellow, but nobody is near them. Programs the player set run as given.
    fn skip_idle_phases(&self, t: usize, left: usize, next: usize) -> usize {
        let (a, b) = self.phase_range(t);
        let d = &self.net.d;
        if !self.skip_phases || self.net.tls_fixed(t) {
            return next;
        }
        let actuated_green = |p: usize| {
            let states = &d.phase_states
                [d.phase_state_offsets[p] as usize..d.phase_state_offsets[p + 1] as usize];
            d.phase_max_dur[p] > d.phase_min_dur[p] + 0.5
                && states.iter().any(|&c| matches!(c, b'G' | b'g'))
                && !states.iter().any(|&c| matches!(c, b'y' | b'Y' | b'u'))
        };
        let mut p = next;
        // At most once round the cycle.
        for _ in 0..b - a {
            if !actuated_green(p) || self.phase_has_demand(t, p, true) {
                return p;
            }
            // Past the phase and its yellow, to the next green.
            p = if p + 1 >= b { a } else { p + 1 };
            while !actuated_green(p) && p != next {
                let states = &d.phase_states
                    [d.phase_state_offsets[p] as usize..d.phase_state_offsets[p + 1] as usize];
                if !states.iter().any(|&c| matches!(c, b'y' | b'Y')) {
                    break;
                }
                p = if p + 1 >= b { a } else { p + 1 };
            }
            if p == next {
                break;
            }
        }
        // Nobody waiting anywhere: back to the green just shown (before its yellow).
        let mut last = left;
        for _ in 0..b - a {
            if actuated_green(last) {
                return last;
            }
            last = if last == a { b - 1 } else { last - 1 };
        }
        next
    }

    /// Whether a vehicle is about to use one of the links this phase shows green; with
    /// `called`, also one waiting for them that could not go now (at a red light).
    fn phase_has_demand(&self, t: usize, phase: usize, called: bool) -> bool {
        self.links_have_demand(t, phase, None, called)
    }

    /// Whether a vehicle waits for a link that phase `p` holds at red and another green
    /// phase of program `t` lets go.
    fn other_called(&self, t: usize, p: usize) -> bool {
        let (a, b) = self.phase_range(t);
        let d = &self.net.d;
        (a..b).any(|q| {
            let states = &d.phase_states
                [d.phase_state_offsets[q] as usize..d.phase_state_offsets[q + 1] as usize];
            q != p
                && !states.iter().any(|&c| matches!(c, b'y' | b'Y'))
                && self.links_have_demand(t, q, Some(p), true)
        })
    }

    /// `phase_has_demand`, for the links green in `phase` but not in `except`.
    fn links_have_demand(
        &self,
        t: usize,
        phase: usize,
        except: Option<usize>,
        called: bool,
    ) -> bool {
        let d = &self.net.d;
        let states = |p: usize| {
            &d.phase_states
                [d.phase_state_offsets[p] as usize..d.phase_state_offsets[p + 1] as usize]
        };
        let green = |p: usize, idx: usize| matches!(states(p).get(idx), Some(b'G' | b'g'));
        let links = &self.tls_links
            [self.tls_link_offsets[t] as usize..self.tls_link_offsets[t + 1] as usize];
        for &l in links {
            let idx = d.link_tls_index[l as usize] as usize;
            if !green(phase, idx) || except.is_some_and(|p| green(p, idx)) {
                continue;
            }
            let from = d.link_from[l as usize] as usize;
            let lane_len = d.lane_length[from];
            // Too short to hold the vehicle that waits for it, which stands in the junction
            // before (signals a few metres apart) or, a tram, at the signal before: the link
            // counts as called.
            let tram = d.lane_allow[from] & vclass::TRAM != 0;
            let reach = CALL_LANE + if tram { TRAM_LENGTH } else { 0.0 };
            if called && lane_len < reach {
                return true;
            }
            for &u in self.lane_vehs[from].iter().rev().take(3) {
                let uv = &self.vehs[u as usize];
                let dist = lane_len - uv.pos;
                if dist > 3.0 + uv.speed.max(5.0) * MAX_GAP {
                    break;
                }
                if uv.next_link == l && (uv.will_pass || called) {
                    return true;
                }
            }
        }
        false
    }

    // ---- planning -------------------------------------------------------------------------

    fn desired_speed(&self, veh: &Vehicle, lane: u32) -> f32 {
        (self.net.d.lane_speed[lane as usize] * veh.speed_factor * self.weather.speed)
            .min(veh.params().max_speed)
            .max(1.0)
    }

    /// Speed a vehicle can take a link at (the speed limit of its first junction lane).
    fn link_speed(&self, veh: &Vehicle, link: u32) -> f32 {
        let d = &self.net.d;
        let via = d.link_via[link as usize];
        let lane = if via != NONE {
            via
        } else {
            d.link_to[link as usize]
        };
        self.desired_speed(veh, lane)
    }

    fn plan(&mut self) {
        if self.acc.len() < self.vehs.len() {
            self.acc.resize(self.vehs.len(), 0.0);
        }
        for i in 0..self.active_lanes.len() {
            let lane = self.active_lanes[i] as usize;
            let n = self.lane_vehs[lane].len();
            for k in (0..n).rev() {
                let v = self.lane_vehs[lane][k];
                let leader = if k + 1 < n {
                    Some(self.lane_vehs[lane][k + 1])
                } else {
                    None
                };
                let plan = self.plan_vehicle(v, leader);
                if plan.at_stop || plan.missed_stop {
                    self.serve_stop(v, plan.missed_stop);
                }
                self.acc[v as usize] = plan.acc;
                let veh = &mut self.vehs[v as usize];
                if let Some(pass) = plan.pass {
                    veh.will_pass = pass;
                }
                if plan.stopped_at != NONE {
                    veh.stop_done = plan.stopped_at;
                }
                veh.blink = plan.blink;
                veh.coop = NONE;
            }
        }
    }

    fn plan_vehicle(&self, v: u32, leader: Option<u32>) -> Plan {
        let net = &self.net;
        let d_ = &net.d;
        let veh = &self.vehs[v as usize];
        let p = veh.params();
        let lane = veh.lane;
        let speed = veh.speed;
        let vmax = self.desired_speed(veh, lane);
        let mut acc = idm::acceleration(speed, vmax, f32::INFINITY, 0.0, p, self.weather);
        let mut plan = Plan {
            acc: 0.0,
            pass: None,
            blink: 0,
            stopped_at: NONE,
            at_stop: false,
            missed_stop: false,
        };

        let mut have_leader = false;
        if let Some(l) = leader {
            let lv = &self.vehs[l as usize];
            let gap = lv.pos - lv.params().length - veh.pos;
            acc = acc.min(idm::acceleration(
                speed,
                vmax,
                gap,
                lv.speed,
                p,
                self.weather,
            ));
            have_leader = true;
        }
        if veh.coop != NONE {
            acc = acc.min(self.yield_to_changer(veh, vmax));
        }

        // A bus or tram stops at its next stop: on this lane, or further ahead (below).
        let mut stop_ahead = self.next_stop_of(veh);
        if let Some((route_idx, frac)) = stop_ahead
            && route_idx == veh.route_idx
            && !net.lane_internal[lane as usize]
        {
            let gap = frac * d_.lane_length[lane as usize] - veh.pos;
            if gap < -2.0 {
                plan.missed_stop = true;
            } else {
                acc = acc.min(stop_at(speed, vmax, gap + 0.5, p, self.weather));
                plan.at_stop = gap < 2.0 && speed < 0.3;
            }
            stop_ahead = None;
        }

        // Look ahead along the route: stop lines, junction lanes, the next vehicle ahead.
        let horizon = (speed * speed / (2.0 * p.decel) + speed * 4.0 + 25.0).min(350.0);
        let last = veh.route.len() as u32 - 1;
        let mut route_i = veh.route_idx;
        let mut cur = lane;
        let mut dist = d_.lane_length[lane as usize] - veh.pos;
        let mut first_link = true;
        for _ in 0..16 {
            if dist > horizon {
                break;
            }
            let next;
            if net.lane_internal[cur as usize] {
                // A turn that waits inside the junction: at the point where it waits, until
                // what it crosses there is clear.
                let w = net.lane_wait[cur as usize];
                if w != NONE && !self.wait_clear(v, veh, w, cur, dist) {
                    acc = acc.min(stop_at(speed, vmax, dist, p, self.weather));
                    break;
                }
                next = d_.lane_next[cur as usize];
                if next == NONE {
                    break;
                }
                if !net.lane_internal[next as usize] {
                    route_i += 1;
                }
            } else {
                if route_i >= last {
                    break; // the trip ends on this edge
                }
                let own = cur == lane;
                let link = if own {
                    veh.next_link
                } else {
                    self.choose_link_or_detour(cur, &veh.route, route_i, p.vclass)
                };
                if link == NONE {
                    // No way on from this lane: wait at its end for a lane change, with the
                    // front on the lane even when it is very short.
                    let into = (0.5 * d_.lane_length[cur as usize]).min(0.5);
                    acc = acc.min(stop_at(speed, vmax, dist + 0.5 - into, p, self.weather));
                    break;
                }
                if first_link && dist < 80.0 {
                    let direction = d_.link_dir[link as usize];
                    plan.blink = if is_left(direction) {
                        1
                    } else if is_right(direction) {
                        -1
                    } else {
                        0
                    };
                }
                let state = self.link_state(link);
                let go = self.may_pass(v, veh, link, state, dist, own && !have_leader);
                if own {
                    plan.pass = Some(go);
                }
                if !go {
                    acc = acc.min(stop_at(speed, vmax, dist, p, self.weather));
                    if first_link && matches!(state, b's' | b'w') && dist < 3.0 && speed < 0.3 {
                        plan.stopped_at = link;
                    }
                    break;
                }
                first_link = false;
                let via = d_.link_via[link as usize];
                next = if via != NONE {
                    via
                } else {
                    route_i += 1;
                    d_.link_to[link as usize]
                };
            }

            // Slow down in time for the next lane's speed limit (turns are slow).
            let v_next = self.desired_speed(veh, next);
            if speed > v_next {
                let b = (speed * speed - v_next * v_next) / (2.0 * dist.max(0.5));
                if b > 0.2 {
                    acc = acc.min(-b);
                }
            }
            if let Some((route_idx, frac)) = stop_ahead
                && route_idx == route_i
                && !net.lane_internal[next as usize]
            {
                let gap = dist + frac * d_.lane_length[next as usize];
                acc = acc.min(stop_at(speed, vmax, gap + 0.5, p, self.weather));
                stop_ahead = None;
            }
            if let (false, Some(&r)) = (have_leader, self.lane_vehs[next as usize].first()) {
                let rv = &self.vehs[r as usize];
                let gap = dist + rv.pos - rv.params().length;
                acc = acc.min(idm::acceleration(
                    speed,
                    vmax,
                    gap,
                    rv.speed,
                    p,
                    self.weather,
                ));
                break;
            }
            dist += d_.lane_length[next as usize];
            cur = next;
        }
        plan.acc = acc;
        plan
    }

    /// Follow a vehicle that wants to change into our lane ahead of us, if that is gentle.
    fn yield_to_changer(&self, veh: &Vehicle, vmax: f32) -> f32 {
        let d = &self.net.d;
        let p = veh.params();
        let c = &self.vehs[veh.coop as usize];
        if !c.alive()
            || self.net.lane_internal[c.lane as usize]
            || d.lane_edge[c.lane as usize] != d.lane_edge[veh.lane as usize]
        {
            return p.accel;
        }
        let pos =
            c.pos * d.lane_length[veh.lane as usize] / d.lane_length[c.lane as usize].max(0.1);
        if pos <= veh.pos {
            return p.accel;
        }
        let a = idm::acceleration(
            veh.speed,
            vmax,
            pos - c.params().length - veh.pos,
            c.speed,
            p,
            self.weather,
        );
        if a < -3.0 { p.accel } else { a }
    }

    /// Whether a vehicle `dist` metres before the stop line of `link` may cross it.
    /// `full`: also check right-of-way and room behind the junction (only the first
    /// vehicle in a lane does; the others are stopped by it anyway).
    fn may_pass(&self, v: u32, veh: &Vehicle, link: u32, state: u8, dist: f32, full: bool) -> bool {
        let p = veh.params();
        let speed = veh.speed;
        let brake = if dist > 0.05 {
            speed * speed / (2.0 * dist)
        } else if speed > 0.1 {
            f32::INFINITY
        } else {
            0.0
        };
        match state {
            b'r' | b'u' => return brake > p.emergency_decel,
            b'y' if brake <= p.decel => return false,
            b's' | b'w' if veh.stop_done != link => return false,
            _ => {}
        }
        if !full {
            return true;
        }
        // Into a roundabout only with room at the exit taken off it, however long the wait:
        // a driver who stops on the ring for a full exit blocks everyone behind.
        let entering = self.enters_roundabout(link);
        let crossing = self.net.link_crossing[link as usize] != NONE;
        if (entering || crossing || veh.wait < BLOCK_BOX_WAIT)
            && dist < speed * speed / (2.0 * p.decel) + p.length + 5.0
            && (!self.exit_has_room(link, veh)
                || entering && !self.roundabout_exit_has_room(link, veh))
        {
            return false;
        }
        let net = &self.net;
        let v_link = self.link_speed(veh, link);
        let arrive = travel_time(dist, speed, p.accel, v_link);
        let v_arrive = (speed * speed + 2.0 * p.accel * dist)
            .sqrt()
            .min(v_link.max(speed));
        let leave = arrive
            + travel_time(
                net.link_via_length[link as usize] + p.length,
                v_arrive,
                p.accel,
                v_link,
            );
        let minor = !matches!(state, b'G' | b'M' | b'O' | b'y' | b'r' | b'u');
        let can_stop = speed * speed / (2.0 * p.decel) < dist - 1.0;
        !self.junction_conflict(v, veh, link, minor, arrive, leave, can_stop)
    }

    /// Whether a vehicle `dist` metres before the point inside a junction where its turn
    /// waits (wait `w`, at the end of junction lane `lane`) may go on past it (M7b): nobody
    /// inside the junction on the lanes it crosses there, and nobody coming on a crossing
    /// way who gets there before it is through. As at a stop line, a driver who has waited
    /// pushes into gaps where the others can still brake comfortably.
    fn wait_clear(&self, v: u32, veh: &Vehicle, w: u32, lane: u32, dist: f32) -> bool {
        let net = &self.net;
        let d = &net.d;
        let p = veh.params();
        let v_lane = self.desired_speed(veh, lane);
        let arrive = travel_time(dist, veh.speed, p.accel, v_lane);
        // The rest of the way across: the junction lanes after this one, and its length.
        let mut rest = p.length;
        let mut next = d.lane_next[lane as usize];
        let mut guard = 0;
        while next != NONE && net.lane_internal[next as usize] && guard < 8 {
            rest += d.lane_length[next as usize];
            next = d.lane_next[next as usize];
            guard += 1;
        }
        let v_arrive = (veh.speed * veh.speed + 2.0 * p.accel * dist)
            .sqrt()
            .min(v_lane.max(veh.speed));
        let leave = arrive + travel_time(rest, v_arrive, p.accel, v_lane);
        let margin = if veh.blocked > 10.0 {
            0.5
        } else {
            YIELD_MARGIN
        };
        let pushing_in = veh.blocked > PUSH_IN_WAIT;
        let foes = net.wait_foes(w);
        for &f in foes {
            let len = d.lane_length[f as usize];
            if net.lane_internal[f as usize] {
                for &u in &self.lane_vehs[f as usize] {
                    let uv = &self.vehs[u as usize];
                    if u == v || self.stuck_in_junction(u) {
                        continue;
                    }
                    // Waiting at its own point there: it gives way to us.
                    if net.lane_wait[f as usize] != NONE && uv.speed < 0.5 && len - uv.pos < 1.5 {
                        continue;
                    }
                    let remaining = (len - uv.pos + uv.params().length).max(0.0);
                    if remaining / uv.speed.max(0.5) > arrive - 0.2 {
                        return false;
                    }
                }
                continue;
            }
            for &u in self.lane_vehs[f as usize].iter().rev().take(3) {
                let uv = &self.vehs[u as usize];
                if !uv.will_pass {
                    break; // it stops at the line, and so does everyone behind it
                }
                let du = len - uv.pos;
                if du > uv.speed * 10.0 + 30.0 {
                    break;
                }
                let ul = uv.next_link;
                if ul == NONE || !self.crosses_wait(ul, foes) {
                    continue;
                }
                let up = uv.params();
                let u_arrive = travel_time(du, uv.speed, up.accel, self.link_speed(uv, ul));
                let can_stop = uv.speed * uv.speed / (2.0 * up.decel) < du - 1.0;
                if pushing_in && can_stop {
                    continue;
                }
                if u_arrive <= leave + margin {
                    return false;
                }
            }
        }
        true
    }

    /// Whether `link`'s way across its junction passes one of `lanes`.
    fn crosses_wait(&self, link: u32, lanes: &[u32]) -> bool {
        let net = &self.net;
        let d = &net.d;
        let mut lane = d.link_via[link as usize];
        let mut guard = 0;
        while lane != NONE && net.lane_internal[lane as usize] && guard < 8 {
            if lanes.contains(&lane) {
                return true;
            }
            lane = d.lane_next[lane as usize];
            guard += 1;
        }
        false
    }

    /// The state of `link` right now: its signal's or its priority's, or, at a level
    /// crossing closed for a train, yellow while the lights flash and red once the barriers
    /// are down.
    pub fn link_state(&self, link: u32) -> u8 {
        link_state(
            &self.net,
            &self.tls_phase,
            &self.crossing_since,
            self.time,
            link,
        )
    }

    /// Close the level crossings trains are due at (M8b): from `CROSSING_LEAD` before a
    /// train gets there (at its speed, speeding up to the line's, after the rest of its
    /// stop if it stands at a station) until its rear has cleared the crossing and the
    /// barriers have risen.
    fn update_level_crossings(&mut self) {
        let n = self.net.crossings.len();
        if n == 0 {
            return;
        }
        if self.crossing_since.len() != n {
            self.crossing_since = vec![f64::NAN; n];
            self.crossing_due = vec![f64::NEG_INFINITY; n];
            self.crossing_closures = vec![0; n];
            self.crossing_seconds = vec![0.0; n];
        }
        let now = self.time;
        let mut due: Vec<u32> = Vec::new();
        for veh in &self.vehs {
            if !veh.alive() || veh.vtype != vtype::TRAIN {
                continue;
            }
            if veh.cur_link != NONE {
                let c = self.net.rail_crossing[veh.cur_link as usize];
                if c != NONE {
                    due.push(c);
                }
            }
            self.crossings_ahead(veh, &mut due);
        }
        for c in due {
            let c = c as usize;
            if self.crossing_since[c].is_nan() {
                self.crossing_since[c] = now;
                self.crossing_closures[c] += 1;
            }
            self.crossing_due[c] = now;
        }
        for c in 0..n {
            let since = self.crossing_since[c];
            if !since.is_nan() && now - self.crossing_due[c] >= CROSSING_RISE {
                self.crossing_seconds[c] += now - since;
                self.crossing_since[c] = f64::NAN;
            }
        }
    }

    /// The level crossings ahead of train `veh` it gets to within `CROSSING_LEAD`.
    fn crossings_ahead(&self, veh: &Vehicle, due: &mut Vec<u32>) {
        let net = &self.net;
        let d = &net.d;
        let p = veh.params();
        let standing = veh
            .transit
            .as_ref()
            .filter(|run| run.dwelling)
            .map_or(0.0, |run| (run.dwell_until - self.time).max(0.0));
        let v_line = self.desired_speed(veh, veh.lane).max(veh.speed);
        let last = veh.route.len() as u32 - 1;
        let mut route_i = veh.route_idx;
        let mut cur = veh.lane;
        let mut dist = d.lane_length[cur as usize] - veh.pos;
        for _ in 0..32 {
            if dist > CROSSING_LOOK {
                break;
            }
            let next;
            if net.lane_internal[cur as usize] {
                next = d.lane_next[cur as usize];
                if next == NONE {
                    break;
                }
                if !net.lane_internal[next as usize] {
                    route_i += 1;
                }
            } else {
                if route_i >= last {
                    break;
                }
                let link = if cur == veh.lane {
                    veh.next_link
                } else {
                    self.choose_link_or_detour(cur, &veh.route, route_i, p.vclass)
                };
                if link == NONE {
                    break;
                }
                let c = net.rail_crossing[link as usize];
                if c != NONE {
                    let eta = standing + travel_time(dist, veh.speed, p.accel, v_line) as f64;
                    if eta > CROSSING_LEAD {
                        break;
                    }
                    due.push(c);
                }
                let via = d.link_via[link as usize];
                next = if via != NONE {
                    via
                } else {
                    route_i += 1;
                    d.link_to[link as usize]
                };
            }
            dist += d.lane_length[next as usize];
            cur = next;
        }
    }

    /// Whether the light (or stop sign) at `link` lets a vehicle through right now.
    fn signal_allows(&self, link: u32, stop_done: u32) -> bool {
        match self.link_state(link) {
            b'r' | b'u' | b'y' => false,
            b's' | b'w' => stop_done == link,
            _ => true,
        }
    }

    /// Whether `link` leads from a road onto a roundabout's ring.
    fn enters_roundabout(&self, link: u32) -> bool {
        let d = &self.net.d;
        let edge = |lane: u32| d.lane_edge[lane as usize];
        !self.net.is_roundabout(edge(d.link_from[link as usize]))
            && self.net.is_roundabout(edge(d.link_to[link as usize]))
    }

    /// Room at the start of the road a vehicle entering a roundabout by `link` will leave
    /// it by (along its route round the ring).
    fn roundabout_exit_has_room(&self, link: u32, veh: &Vehicle) -> bool {
        let d = &self.net.d;
        let p = veh.params();
        let need = p.length + p.min_gap;
        let mut lane = d.link_to[link as usize];
        for idx in (veh.route_idx + 1..).take(16) {
            let l = lane as usize;
            if !self.net.is_roundabout(d.lane_edge[l]) {
                let room = need.min(d.lane_length[l]);
                return match self.lane_vehs[l].first() {
                    Some(&u) => {
                        let uv = &self.vehs[u as usize];
                        uv.speed > 3.0
                            || uv.pos - uv.params().length - self.lane_reserved[l] >= room
                    }
                    None => d.lane_length[l] - self.lane_reserved[l] >= room,
                };
            }
            let next = self.choose_link_or_detour(lane, &veh.route, idx, p.vclass);
            if next == NONE {
                return true;
            }
            lane = d.link_to[next as usize];
        }
        true
    }

    /// Room for a vehicle behind the junction, counting vehicles still inside it. When the
    /// lane behind is too short to hold the vehicle (junction clusters split by sub-metre
    /// edges), the vehicle must also be able to cross the next junction, or it would stop
    /// inside this one and block it.
    fn exit_has_room(&self, link: u32, veh: &Vehicle) -> bool {
        let d = &self.net.d;
        let p = veh.params();
        let mut need = p.length + p.min_gap;
        let mut link = link;
        for route_i in (veh.route_idx + 1..).take(4) {
            let to = d.link_to[link as usize] as usize;
            let len = d.lane_length[to];
            let reserved = self.lane_reserved[to];
            if let Some(&u) = self.lane_vehs[to].first() {
                let uv = &self.vehs[u as usize];
                return uv.speed > 3.0 || uv.pos - uv.params().length - reserved >= need.min(len);
            }
            if len - reserved >= need {
                return true;
            }
            // A short, empty lane: the way on through the next junction must be clear too.
            let next = self.choose_link_or_detour(to as u32, &veh.route, route_i, p.vclass);
            if next == NONE {
                return len - reserved >= need.min(len);
            }
            if !self.signal_allows(next, NONE) {
                return false;
            }
            let mut via = d.link_via[next as usize];
            while via != NONE && self.net.lane_internal[via as usize] {
                if !self.lane_vehs[via as usize].is_empty() {
                    return false;
                }
                via = d.lane_next[via as usize];
            }
            need -= (len - reserved).max(0.0);
            link = next;
        }
        true
    }

    /// Whether vehicle `u` has stood still inside a junction for so long it no longer blocks
    /// crossing traffic.
    fn stuck_in_junction(&self, u: u32) -> bool {
        self.vehs[u as usize].wait > JUNCTION_BLOCKER_TIME
    }

    /// Vehicles inside the junction on `link`, then (if `approaching`) those about to enter.
    /// With `past_wait`, only those past the point inside the junction where the link's turn
    /// waits (the others give way there).
    fn link_users(
        &self,
        link: u32,
        out: &mut [LinkUser; 8],
        approaching: bool,
        past_wait: bool,
    ) -> usize {
        let net = &self.net;
        let d = &net.d;
        let mut n = 0;
        let mut lane = d.link_via[link as usize];
        let mut rest = net.link_via_length[link as usize];
        let mut guard = 0;
        let mut waiting = past_wait && net.link_wait[link as usize] != NONE;
        while lane != NONE && net.lane_internal[lane as usize] && guard < 8 {
            let before_wait = waiting;
            waiting &= net.lane_wait[lane as usize] == NONE;
            if before_wait {
                rest -= d.lane_length[lane as usize];
                lane = d.lane_next[lane as usize];
                guard += 1;
                continue;
            }
            for &u in &self.lane_vehs[lane as usize] {
                if n == out.len() {
                    return n;
                }
                let uv = &self.vehs[u as usize];
                let remaining = (rest - uv.pos + uv.params().length).max(0.0);
                out[n] = LinkUser {
                    veh: u,
                    arrive: 0.0,
                    leave: remaining / uv.speed.max(0.5),
                    speed: uv.speed,
                    can_stop: false,
                };
                n += 1;
            }
            rest -= d.lane_length[lane as usize];
            lane = d.lane_next[lane as usize];
            guard += 1;
        }
        // Vehicles that have left the junction with their rear still in it.
        let to = d.link_to[link as usize] as usize;
        for &u in self.lane_vehs[to].iter().take(2) {
            let uv = &self.vehs[u as usize];
            let len = uv.params().length;
            if uv.cur_link == link && uv.pos < len && n < out.len() {
                out[n] = LinkUser {
                    veh: u,
                    arrive: 0.0,
                    leave: (len - uv.pos) / uv.speed.max(0.5),
                    speed: uv.speed,
                    can_stop: false,
                };
                n += 1;
            }
        }
        if approaching && !(past_wait && net.link_wait[link as usize] != NONE) {
            let from = d.link_from[link as usize] as usize;
            let lane_len = d.lane_length[from];
            let mut earliest = 0.0f32;
            for &u in self.lane_vehs[from].iter().rev().take(3) {
                if n == out.len() {
                    break;
                }
                let uv = &self.vehs[u as usize];
                if !uv.will_pass {
                    break; // it stops at the line, and so does everyone behind it
                }
                let dist = lane_len - uv.pos;
                if dist > uv.speed * 10.0 + 30.0 {
                    break;
                }
                let up = uv.params();
                let v_link = self.link_speed(uv, link);
                let arrive = travel_time(dist, uv.speed, up.accel, v_link).max(earliest);
                earliest = arrive + 1.0;
                if uv.next_link != link {
                    continue;
                }
                let v_arrive = (uv.speed * uv.speed + 2.0 * up.accel * dist)
                    .sqrt()
                    .min(v_link.max(uv.speed));
                let leave = arrive
                    + travel_time(
                        net.link_via_length[link as usize] + up.length,
                        v_arrive,
                        up.accel,
                        v_link,
                    );
                out[n] = LinkUser {
                    veh: u,
                    arrive: arrive.max(0.01),
                    leave,
                    speed: uv.speed,
                    can_stop: uv.speed * uv.speed / (2.0 * up.decel) < dist - 1.0,
                };
                n += 1;
            }
        }
        n
    }

    /// The vehicle stopped at the stop line of `link`, waiting to use it, if any.
    fn waiting_at(&self, link: u32) -> Option<&Vehicle> {
        let d = &self.net.d;
        let from = d.link_from[link as usize] as usize;
        let &u = self.lane_vehs[from].last()?;
        let uv = &self.vehs[u as usize];
        let at_line = d.lane_length[from] - uv.pos < 3.0 && uv.speed < 0.5;
        (uv.next_link == link && at_line).then_some(uv)
    }

    /// Whether entering `link` (arriving at the stop line in `arrive` s, clear of the
    /// junction after `leave` s) would conflict with other vehicles. `can_stop`: the vehicle
    /// could still stop comfortably at the line, so it can let others go first.
    #[allow(clippy::too_many_arguments)]
    fn junction_conflict(
        &self,
        v: u32,
        veh: &Vehicle,
        link: u32,
        minor: bool,
        arrive: f32,
        leave: f32,
        can_stop: bool,
    ) -> bool {
        let net = &self.net;
        let d = &net.d;
        let j = d.link_junction[link as usize];
        let r = d.link_request[link as usize];
        if j == NONE || r == u16::MAX || r >= d.junction_link_count[j as usize] {
            return false;
        }
        let r = r as u32;
        let mut users = [LinkUser::default(); 8];
        for f in net.foes(j, r) {
            let fl = net.request_link(j, f);
            // A turn that waits inside the junction gives way there, not at the stop line.
            if fl == NONE || fl == link || net.waits_for(link, fl) {
                continue;
            }
            // Never drive into a vehicle that is inside the junction on a crossing path
            // (unless it has been stuck there for long); one still before the point where
            // it waits for us does.
            let past = net.waits_for(fl, link);
            let n = self.link_users(fl, &mut users, false, past);
            if users[..n]
                .iter()
                .any(|u| u.veh != v && u.leave > arrive - 0.2 && !self.stuck_in_junction(u.veh))
            {
                return true;
            }
            // Courtesy: let a driver who has waited long at a crossing path go first, if it
            // can go (its light allows it and there is room past the junction).
            let waited_longer = |w: &Vehicle| {
                w.blocked > PUSH_IN_WAIT
                    && w.blocked > veh.blocked + 2.0
                    && self.signal_allows(fl, w.stop_done)
                    && self.exit_has_room(fl, w)
            };
            if can_stop && !past && self.waiting_at(fl).is_some_and(waited_longer) {
                return true;
            }
        }
        if !minor {
            return false;
        }
        // Yield: only go if we are through before a priority vehicle arrives, or after it.
        let impatient = veh.blocked > 10.0;
        let margin = if impatient { 0.5 } else { YIELD_MARGIN };
        let pushing_in = veh.blocked > PUSH_IN_WAIT;
        let my_to = d.link_to[link as usize];
        for f in net.response(j, r) {
            let fl = net.request_link(j, f);
            if fl == NONE || fl == link || net.waits_for(link, fl) {
                continue;
            }
            let same_target = d.link_to[fl as usize] == my_to;
            let past = net.waits_for(fl, link);
            let n = self.link_users(fl, &mut users, true, past);
            for u in &users[..n] {
                if u.veh == v {
                    continue;
                }
                if u.arrive <= 0.0 {
                    if u.leave > arrive - 0.2 && !self.stuck_in_junction(u.veh) {
                        return true;
                    }
                    continue;
                }
                // Stopped vehicles that waited less go after us; after a long wait, all of
                // them (everyone waiting for everyone else is a deadlock).
                if u.speed < 0.5
                    && (veh.blocked > 30.0
                        || (pushing_in && self.vehs[u.veh as usize].blocked < veh.blocked))
                {
                    continue;
                }
                // Pushing in: whoever can still brake comfortably will.
                if pushing_in && u.can_stop {
                    continue;
                }
                if u.leave < arrive {
                    if same_target && arrive - u.leave < 1.0 {
                        return true;
                    }
                } else if u.arrive <= leave + margin {
                    return true;
                }
            }
        }
        false
    }

    // ---- route helpers ----------------------------------------------------------------------

    /// Whether `lane` has a link to `edge` usable by `vclass`.
    pub fn lane_reaches(&self, lane: u32, edge: u32, vclass: u16) -> bool {
        let d = &self.net.d;
        self.net.lane_links(lane).any(|l| {
            self.net.link_allow[l as usize] & vclass != 0
                && d.lane_edge[d.link_to[l as usize] as usize] == edge
        })
    }

    /// How well `lane` (on route edge `i`) suits the route: 0 it cannot reach the next edge,
    /// 1 it can, 2 it can and carries on along the route past the short edges ahead (too
    /// short to change lanes on). Lanes that do not allow the class score -1.
    fn lane_score(&self, lane: u32, route: &[u32], i: usize, vclass: u16) -> i32 {
        let d = &self.net.d;
        if d.lane_allow[lane as usize] & vclass == 0 {
            return -1;
        }
        let Some(&next) = route.get(i + 1) else {
            return 2;
        };
        let mut best = 0;
        for l in self.net.lane_links(lane) {
            let to = d.link_to[l as usize];
            if self.net.link_allow[l as usize] & vclass == 0 || d.lane_edge[to as usize] != next {
                continue;
            }
            let s = if self.lane_continues(to, route, i + 1, vclass, SHORT_EDGE_LOOKAHEAD) {
                2
            } else {
                1
            };
            best = best.max(s);
        }
        best
    }

    /// Whether a vehicle on `lane` (on route edge `i`) can follow the route past the short
    /// edges ahead without changing lanes, looking at most `depth` edges on.
    fn lane_continues(&self, lane: u32, route: &[u32], i: usize, vclass: u16, depth: u32) -> bool {
        let d = &self.net.d;
        let Some(&next) = route.get(i + 1) else {
            return true;
        };
        if depth == 0 || self.room_to_change_lanes(route[i]) {
            return true;
        }
        self.net.lane_links(lane).any(|l| {
            let to = d.link_to[l as usize];
            self.net.link_allow[l as usize] & vclass != 0
                && d.lane_edge[to as usize] == next
                && self.lane_continues(to, route, i + 1, vclass, depth - 1)
        })
    }

    /// Whether an edge is long enough to change lanes on at its speed limit.
    fn room_to_change_lanes(&self, edge: u32) -> bool {
        let e = edge as usize;
        self.net.edge_length[e] > LANE_CHANGE_ROOM.max(self.net.edge_speed[e] * LANE_CHANGE_SECONDS)
    }

    /// Link to take from `lane` (on route edge `i`) toward the next route edge.
    fn choose_link(&self, lane: u32, route: &[u32], i: u32, vclass: u16) -> u32 {
        let d = &self.net.d;
        let i = i as usize;
        let Some(&next) = route.get(i + 1) else {
            return NONE;
        };
        let after = route.get(i + 2).copied();
        let from_index = self.net.lane_index[lane as usize] as i32;
        let mut best = NONE;
        let mut best_score = i32::MIN;
        for l in self.net.lane_links(lane) {
            let to = d.link_to[l as usize];
            if self.net.link_allow[l as usize] & vclass == 0 || d.lane_edge[to as usize] != next {
                continue;
            }
            let mut score = -(self.net.lane_index[to as usize] as i32 - from_index).abs();
            // Prefer lanes that lead on to the edge after, past any short edges in between.
            if after.is_some_and(|after| {
                self.lane_reaches(to, after, vclass)
                    && self.lane_continues(to, route, i + 1, vclass, SHORT_EDGE_LOOKAHEAD)
            }) {
                score += 100;
            }
            if score > best_score {
                best_score = score;
                best = l;
            }
        }
        best
    }

    /// Whether a vehicle on `lane` that cannot follow its route from there should detour at
    /// once rather than try to change lanes: the lane is short or the only one.
    fn must_detour(&self, lane: u32) -> bool {
        let d = &self.net.d;
        d.lane_length[lane as usize] < 40.0
            || d.edge_lane_count[d.lane_edge[lane as usize] as usize] < 2
    }

    /// `choose_link`, or where a vehicle that must detour from `lane` would go.
    fn choose_link_or_detour(&self, lane: u32, route: &[u32], i: u32, vclass: u16) -> u32 {
        let link = self.choose_link(lane, route, i, vclass);
        if link != NONE || i as usize + 1 >= route.len() || !self.must_detour(lane) {
            return link;
        }
        self.net
            .lane_links(lane)
            .find(|&l| self.net.link_allow[l as usize] & vclass != 0)
            .unwrap_or(NONE)
    }

    // ---- scheduled trams and buses --------------------------------------------------------------

    /// (route index, lane fraction) of a bus or tram's next stop.
    fn next_stop_of(&self, veh: &Vehicle) -> Option<(u32, f32)> {
        let run = veh.transit.as_ref()?;
        run.target(&self.transit.as_ref()?.data)
    }

    /// A bus or tram at (or past) its next stop: wait for passengers and the timetable.
    fn serve_stop(&mut self, v: u32, missed: bool) {
        let Some(tr) = self.transit.as_ref() else {
            return;
        };
        let time = self.time;
        let veh = &mut self.vehs[v as usize];
        let vtype = veh.vtype as usize;
        let Some(run) = veh.transit.as_mut() else {
            return;
        };
        let Some(stop) = run.next_stop() else {
            return;
        };
        let scheduled = tr.day_start + tr.data.stop_time[stop as usize] as f64;
        let mut left_late = None;
        if missed {
            run.next += 1;
            run.dwelling = false;
        } else if !run.dwelling {
            run.dwelling = true;
            run.dwell_until = (time + MIN_DWELL[vtype]).max(scheduled);
        } else if time >= run.dwell_until {
            run.next += 1;
            run.dwelling = false;
            left_late = Some((time - scheduled).max(0.0));
        }
        if let (Some(late), Some(tr)) = (left_late, self.transit.as_mut()) {
            tr.departures[vtype] += 1;
            tr.late_sum[vtype] += late;
            tr.late_max[vtype] = tr.late_max[vtype].max(late);
        }
    }

    /// Start the trips due now (and retry those that found no room at their stop).
    fn start_transit(&mut self) {
        let Some(mut tr) = self.transit.take() else {
            return;
        };
        let horizon = self.time + DT as f64;
        loop {
            if tr.next_trip >= tr.data.trips() {
                // A new service day once the last trip has started and midnight passed.
                if tr.data.trips() == 0 || self.time < tr.day_start + 86_400.0 {
                    break;
                }
                tr.day_start += 86_400.0;
                tr.next_trip = 0;
            }
            let trip = tr.next_trip;
            if tr.day_start + tr.start_time(trip) > horizon {
                break;
            }
            tr.next_trip += 1;
            let from_stop = tr.data.trip_stops[trip];
            tr.waiting.push(PendingRun {
                trip: trip as u32,
                from_stop,
                since: self.time,
            });
        }
        let waiting = std::mem::take(&mut tr.waiting);
        for run in waiting {
            let vtype = tr.data.trip_type[run.trip as usize] as usize;
            match self.start_run(&mut tr, run.trip, run.from_stop) {
                Some(true) => {
                    tr.started += 1;
                    tr.started_by[vtype] += 1;
                }
                Some(false) if self.time - run.since < MAX_TRANSIT_DELAY => tr.waiting.push(run),
                _ => {
                    tr.failed += 1;
                    tr.failed_by[vtype] += 1;
                }
            }
        }
        self.transit = Some(tr);
    }

    /// Put a bus or tram on the road at stop `from_stop` of `trip`. Some(false): no room
    /// yet; None: the trip cannot be routed.
    fn start_run(&mut self, tr: &mut Transit, trip: u32, from_stop: u32) -> Option<bool> {
        let data = &tr.data;
        let stops = data.stops(trip);
        let vtype = data.trip_type[trip as usize];
        let p = &TYPES[vtype as usize];
        let first = from_stop as usize;
        let mut route = vec![data.stop_edge[first]];
        let mut served = vec![(first as u32, 0u32)];
        // Drive stop to stop; a stop the network cannot reach (or one behind the last on
        // the same edge) is skipped.
        let mut at = first;
        for next in first + 1..stops.end {
            let (e0, e1) = (data.stop_edge[at], data.stop_edge[next]);
            if e0 == e1 {
                if data.stop_frac[next] < data.stop_frac[at] {
                    tr.skipped_stops += 1;
                    continue;
                }
            } else {
                let key = (e0, e1, p.vclass);
                let leg = match tr.legs.get(&key) {
                    Some(leg) => leg.clone(),
                    None => {
                        self.router.tolls = true;
                        let leg = self
                            .router
                            .route(&self.net, &self.free_time, e0, e1, p.vclass);
                        tr.legs.insert(key, leg.clone());
                        leg
                    }
                };
                let Some(leg) = leg else {
                    tr.skipped_stops += 1;
                    continue;
                };
                route.extend_from_slice(&leg[1..]);
            }
            served.push((next as u32, route.len() as u32 - 1));
            at = next;
        }
        if served.len() < 2 {
            return None;
        }

        // On the lane of the first stop that suits the route (trams have one).
        let edge = route[0];
        let mut lane = NONE;
        let mut best = -1;
        for l in self.net.edge_lanes(edge) {
            let s = self.lane_score(l, &route, 0, p.vclass);
            if s > best {
                best = s;
                lane = l;
            }
        }
        if lane == NONE || best < 0 {
            return None;
        }
        let len = self.net.d.lane_length[lane as usize];
        let pos = (data.stop_frac[first] * len)
            .max(p.length.min(len))
            .min(len);
        let list = &self.lane_vehs[lane as usize];
        let idx = list.partition_point(|&u| self.vehs[u as usize].pos < pos);
        if let Some(&l) = list.get(idx) {
            let lv = &self.vehs[l as usize];
            if lv.pos - lv.params().length - pos < p.min_gap {
                return Some(false);
            }
        }
        if idx > 0 {
            let fv = &self.vehs[list[idx - 1] as usize];
            let fp = fv.params();
            let need = fp.min_gap + fv.speed * fv.speed / (2.0 * fp.decel);
            if pos - p.length - fv.pos < need {
                return Some(false);
            }
        }

        let last = *route.last().unwrap();
        let last_frac = data.stop_frac[served.last().unwrap().0 as usize];
        let last_len = self.net.edge_length[last as usize];
        let arrival_pos = (last_frac * last_len + 1.0).min(last_len - 0.1);
        let scheduled = tr.day_start + data.stop_time[first] as f64;
        let next_link = self.choose_link(lane, &route, 0, p.vclass);
        let run = TransitRun {
            trip,
            stops: served,
            next: 0,
            dwell_until: scheduled,
            dwelling: true,
        };
        let v = self.alloc_vehicle();
        let look = (self.rng.next_u32() & 0xffff) as u16;
        let veh = &mut self.vehs[v as usize];
        veh.vtype = vtype;
        veh.look = look;
        veh.lane = lane;
        veh.pos = pos;
        veh.route = route;
        veh.next_link = next_link;
        veh.arrival_pos = arrival_pos;
        veh.depart = self.time;
        veh.transit = Some(Box::new(run));
        self.lane_vehs[lane as usize].insert(idx, v);
        if !self.lane_active[lane as usize] {
            self.lane_active[lane as usize] = true;
            self.active_lanes.push(lane);
        }
        Some(true)
    }

    // ---- movement ---------------------------------------------------------------------------

    fn move_vehicles(&mut self) {
        let n_active = self.active_lanes.len();
        let mut done = std::mem::take(&mut self.scratch);
        done.clear();
        for i in 0..n_active {
            let lane = self.active_lanes[i] as usize;
            let internal = self.net.lane_internal[lane];
            for k in 0..self.lane_vehs[lane].len() {
                let v = self.lane_vehs[lane][k] as usize;
                let a = self.acc[v];
                let veh = &mut self.vehs[v];
                let v0 = veh.speed;
                let mut v1 = v0 + a * DT;
                let ds = if v1 <= 0.0 {
                    v1 = 0.0;
                    if a < 0.0 {
                        (v0 * v0 / (-2.0 * a)).min(v0 * DT)
                    } else {
                        0.0
                    }
                } else {
                    0.5 * (v0 + v1) * DT
                };
                veh.pos += ds;
                veh.speed = v1;
                veh.accel = a;
                veh.distance += ds;
                if v1 < 0.1 && !veh.transit.as_ref().is_some_and(|run| run.dwelling) {
                    veh.wait += DT;
                    veh.wait_total += DT;
                    let link = veh.next_link;
                    let red = link != NONE
                        && !internal
                        && matches!(
                            link_state(
                                &self.net,
                                &self.tls_phase,
                                &self.crossing_since,
                                self.time,
                                link
                            ),
                            b'r' | b'y' | b'u'
                        );
                    if !red {
                        veh.blocked += DT;
                    }
                } else {
                    veh.wait = 0.0;
                    veh.blocked = 0.0;
                }
                if veh.lat != 0.0 {
                    let step = LATERAL_SPEED * DT;
                    veh.lat = if veh.lat.abs() <= step {
                        0.0
                    } else {
                        veh.lat - step * veh.lat.signum()
                    };
                }
                if !internal {
                    if veh.cur_link != NONE && veh.pos >= veh.params().length {
                        veh.cur_link = NONE;
                    }
                    if veh.route_idx as usize + 1 == veh.route.len() && veh.pos >= veh.arrival_pos {
                        done.push((v as u32, veh.serial));
                    }
                }
            }
        }

        // Vehicles past the end of their lane move on, front first.
        for i in 0..n_active {
            let lane = self.active_lanes[i];
            while let Some(&v) = self.lane_vehs[lane as usize].last() {
                let veh = &self.vehs[v as usize];
                let len = self.net.d.lane_length[lane as usize];
                if veh.pos <= len {
                    break;
                }
                let internal = self.net.lane_internal[lane as usize];
                if !internal && veh.route_idx as usize + 1 == veh.route.len() {
                    self.lane_vehs[lane as usize].pop();
                    self.finish(v, Finish::Arrived);
                    continue;
                }
                if !internal && (veh.next_link == NONE || !veh.will_pass) {
                    let veh = &mut self.vehs[v as usize];
                    veh.pos = len;
                    veh.speed = 0.0;
                    break;
                }
                self.lane_vehs[lane as usize].pop();
                self.advance(v);
            }
        }

        for &(v, serial) in &done {
            if self.vehs[v as usize].serial == serial {
                self.remove_from_lane(v);
                self.finish(v, Finish::Arrived);
            }
        }
        self.scratch = done;
    }

    /// Carry a vehicle that drove past the end of its lane onto the following lanes.
    fn advance(&mut self, v: u32) {
        let mut crossed = false;
        loop {
            let (lane, pos) = (self.vehs[v as usize].lane, self.vehs[v as usize].pos);
            let len = self.net.d.lane_length[lane as usize];
            if pos <= len {
                break;
            }
            let next;
            if self.net.lane_internal[lane as usize] {
                next = self.net.d.lane_next[lane as usize];
                if next == NONE {
                    self.vehs[v as usize].pos = len;
                    break;
                }
            } else {
                let veh = &self.vehs[v as usize];
                if crossed || veh.next_link == NONE || !veh.will_pass {
                    // One junction per step: the next one is decided next step. A vehicle
                    // that may not pass stops at the line.
                    let veh = &mut self.vehs[v as usize];
                    veh.pos = len;
                    if veh.next_link == NONE || !veh.will_pass {
                        veh.speed = 0.0;
                    }
                    break;
                }
                crossed = true;
                let link = veh.next_link as usize;
                let p = veh.params();
                let to = self.net.d.link_to[link];
                self.lane_reserved[to as usize] += p.length + p.min_gap;
                let via = self.net.d.link_via[link];
                next = if via != NONE { via } else { to };
                let veh = &mut self.vehs[v as usize];
                veh.cur_link = link as u32;
                veh.next_link = NONE;
                veh.stop_done = NONE;
            }
            {
                let veh = &mut self.vehs[v as usize];
                veh.pos -= len;
                veh.hist = [lane, veh.hist[0], veh.hist[1]];
                veh.lane = next;
            }
            if !self.net.lane_internal[next as usize] {
                // Through the junction, onto the next road.
                self.edge_entered[self.net.d.lane_edge[next as usize] as usize] += 1;
                let veh = &self.vehs[v as usize];
                let p = veh.params();
                let reserved = &mut self.lane_reserved[next as usize];
                *reserved = (*reserved - (p.length + p.min_gap)).max(0.0);
                let route_idx = veh.route_idx + 1;
                let next_link = self.choose_link(next, &veh.route, route_idx, p.vclass);
                let detour = next_link == NONE
                    && (route_idx as usize + 1) < veh.route.len()
                    && veh.transit.is_none()
                    && self.must_detour(next);
                let will_pass = next_link != NONE && self.signal_allows(next_link, veh.stop_done);
                let veh = &mut self.vehs[v as usize];
                veh.route_idx = route_idx;
                veh.next_link = next_link;
                veh.will_pass = will_pass;
                if detour {
                    self.reroute_from_lane(v);
                }
            }
        }
        let lane = self.vehs[v as usize].lane;
        self.insert_sorted(lane, v);
    }

    fn insert_sorted(&mut self, lane: u32, v: u32) {
        let vehs = &self.vehs;
        let pos = vehs[v as usize].pos;
        let list = &mut self.lane_vehs[lane as usize];
        let idx = list.partition_point(|&u| vehs[u as usize].pos < pos);
        list.insert(idx, v);
        if !self.lane_active[lane as usize] {
            self.lane_active[lane as usize] = true;
            self.active_lanes.push(lane);
        }
    }

    fn remove_from_lane(&mut self, v: u32) {
        let lane = self.vehs[v as usize].lane;
        let list = &mut self.lane_vehs[lane as usize];
        if let Some(i) = list.iter().rposition(|&u| u == v) {
            list.remove(i);
        }
    }

    /// Free a vehicle's slot (it must already be off its lane's list).
    fn finish(&mut self, v: u32, how: Finish) {
        let veh = &mut self.vehs[v as usize];
        let p = &TYPES[veh.vtype as usize];
        if self.net.lane_internal[veh.lane as usize] && veh.cur_link != NONE {
            let to = self.net.d.link_to[veh.cur_link as usize] as usize;
            self.lane_reserved[to] = (self.lane_reserved[to] - (p.length + p.min_gap)).max(0.0);
        }
        match how {
            Finish::Arrived => {
                self.stats.arrived += 1;
                self.stats.trip_time_sum += self.time + DT as f64 - veh.depart;
                self.stats.trip_km_sum += veh.distance as f64 / 1000.0;
                self.stats.trip_count += 1;
            }
            Finish::Teleported => {
                self.stats.teleported += 1;
                let edge = self.net.d.lane_edge[veh.lane as usize];
                *self.stats.removed_at.entry(edge).or_default() += 1;
            }
        }
        veh.serial = 0;
        veh.route.clear();
        veh.lane = NONE;
        self.free.push(v);
    }

    // ---- lane changes -----------------------------------------------------------------------

    fn lane_changes(&mut self) {
        for v in 0..self.vehs.len() as u32 {
            let veh = &mut self.vehs[v as usize];
            if !veh.alive() {
                continue;
            }
            veh.reroute_timer = (veh.reroute_timer - DT).max(0.0);
            if veh.lc_timer > 0.0 {
                veh.lc_timer -= DT;
                continue;
            }
            match self.lane_change_decision(v) {
                Some(LaneChange::To(target)) => self.change_lane(v, target),
                Some(LaneChange::AskToYield(f)) => self.vehs[f as usize].coop = v,
                Some(LaneChange::Reroute) => {
                    self.stats.lane_reroutes += 1;
                    self.reroute_from_lane(v)
                }
                None => {}
            }
        }
    }

    fn lane_change_decision(&self, v: u32) -> Option<LaneChange> {
        let net = &self.net;
        let d = &net.d;
        let veh = &self.vehs[v as usize];
        let lane = veh.lane;
        // Trams stay on their rails; nobody changes lanes inside a junction.
        if net.lane_internal[lane as usize] || matches!(veh.vtype, vtype::TRAM | vtype::TRAIN) {
            return None;
        }
        let p = veh.params();
        let len = d.lane_length[lane as usize];
        let dist = len - veh.pos;
        // Stuck at the end of a lane with no way on along the route: go another way (buses
        // and trams keep to their route and stops).
        if veh.transit.is_none()
            && veh.next_link == NONE
            && veh.route_idx as usize + 1 < veh.route.len()
            && dist < 5.0
            && veh.wait > 20.0
            && veh.reroute_timer <= 0.0
        {
            return Some(LaneChange::Reroute);
        }
        if veh.pos < p.length.min(len * 0.5) {
            return None; // still partly in the junction behind
        }
        let edge = d.lane_edge[lane as usize];
        let n = d.edge_lane_count[edge as usize] as u32;
        if n < 2 {
            return None;
        }
        let start = d.edge_lane_start[edge as usize];
        let i = lane - start;
        let i_route = veh.route_idx as usize;
        let mut scores = [-1i32; 16];
        let n = n.min(16);
        for k in 0..n {
            scores[k as usize] = self.lane_score(start + k, &veh.route, i_route, p.vclass);
        }
        let best = *scores[..n as usize].iter().max().unwrap();
        let here = scores[i as usize];

        if here < best {
            // Strategic: head for the nearest lane that leads where we are going.
            let target_k = (0..n)
                .filter(|&k| scores[k as usize] == best)
                .min_by_key(|&k| (k as i32 - i as i32).abs())?;
            let step: i32 = if target_k > i { 1 } else { -1 };
            let changes = (target_k as i32 - i as i32).unsigned_abs() as f32;
            let urgent = dist < 30.0 + 40.0 * changes || dist < veh.speed * 4.0 * changes;
            let mut t = (i as i32 + step) as u32;
            if scores[t as usize] < 0 {
                // A lane closed to us (tram tracks, a bus lane) lies in between: cross it
                // when it is clear.
                let beyond = i as i32 + 2 * step;
                if beyond < 0 || beyond >= n as i32 || scores[beyond as usize] < 0 {
                    return None;
                }
                if self.change_safe(v, start + t, urgent).is_err() {
                    return None;
                }
                t = beyond as u32;
            }
            let target = start + t;
            return match self.change_safe(v, target, urgent) {
                Ok(()) => Some(LaneChange::To(target)),
                Err(Some(f)) if urgent => Some(LaneChange::AskToYield(f)),
                Err(_) => None,
            };
        }

        // Tactical (MOBIL), every other step: overtake slower vehicles on lanes that suit.
        if (self.step_no.wrapping_add(v)) & 1 != 0 || dist < 20.0 {
            return None;
        }
        let mut choice = None;
        let mut best_gain = CHANGE_THRESHOLD;
        for step in [-1i32, 1] {
            let k = i as i32 + step;
            if k < 0 || k >= n as i32 || scores[k as usize] != best {
                continue;
            }
            let target = start + k as u32;
            let gain = self.mobil_gain(v, target, step);
            if gain > best_gain {
                best_gain = gain;
                choice = Some(target);
            }
        }
        choice.map(LaneChange::To)
    }

    /// Position on `target` level with the vehicle, and its neighbours there.
    fn neighbours(&self, veh: &Vehicle, target: u32) -> (f32, Option<u32>, Option<u32>) {
        let d = &self.net.d;
        let pos =
            veh.pos * d.lane_length[target as usize] / d.lane_length[veh.lane as usize].max(0.1);
        let list = &self.lane_vehs[target as usize];
        let idx = list.partition_point(|&u| self.vehs[u as usize].pos < pos);
        let leader = list.get(idx).copied();
        let follower = if idx > 0 { Some(list[idx - 1]) } else { None };
        (pos, leader, follower)
    }

    /// Ok if changing to `target` is safe; Err(follower) names the vehicle in the way behind.
    fn change_safe(&self, v: u32, target: u32, urgent: bool) -> Result<(), Option<u32>> {
        let veh = &self.vehs[v as usize];
        let p = veh.params();
        let (pos, leader, follower) = self.neighbours(veh, target);
        let b_safe = if urgent { 4.5 } else { 2.5 };
        let vmax = self.desired_speed(veh, target);
        if let Some(l) = leader {
            let lv = &self.vehs[l as usize];
            let gap = lv.pos - lv.params().length - pos;
            if gap < 0.5
                || idm::acceleration(veh.speed, vmax, gap, lv.speed, p, self.weather) < -b_safe
            {
                return Err(None);
            }
        }
        if let Some(f) = follower {
            let fv = &self.vehs[f as usize];
            let gap = pos - p.length - fv.pos;
            let fmax = self.desired_speed(fv, target);
            if gap < 0.5
                || idm::acceleration(fv.speed, fmax, gap, veh.speed, fv.params(), self.weather)
                    < -b_safe
            {
                return Err(Some(f));
            }
        }
        Ok(())
    }

    fn mobil_gain(&self, v: u32, target: u32, step: i32) -> f32 {
        let veh = &self.vehs[v as usize];
        let p = veh.params();
        let list = &self.lane_vehs[veh.lane as usize];
        let me = list.iter().rposition(|&u| u == v).unwrap_or(0);
        let vmax = self.desired_speed(veh, veh.lane);
        let a_now = match list.get(me + 1) {
            Some(&l) => {
                let lv = &self.vehs[l as usize];
                idm::acceleration(
                    veh.speed,
                    vmax,
                    lv.pos - lv.params().length - veh.pos,
                    lv.speed,
                    p,
                    self.weather,
                )
            }
            None => idm::acceleration(veh.speed, vmax, f32::INFINITY, 0.0, p, self.weather),
        };
        let (pos, leader, follower) = self.neighbours(veh, target);
        let vmax_t = self.desired_speed(veh, target);
        let a_new = match leader {
            Some(l) => {
                let lv = &self.vehs[l as usize];
                let gap = lv.pos - lv.params().length - pos;
                if gap < p.min_gap {
                    return f32::NEG_INFINITY;
                }
                idm::acceleration(veh.speed, vmax_t, gap, lv.speed, p, self.weather)
            }
            None => idm::acceleration(veh.speed, vmax_t, f32::INFINITY, 0.0, p, self.weather),
        };
        let mut follower_loss = 0.0;
        if let Some(f) = follower {
            let fv = &self.vehs[f as usize];
            let fp = fv.params();
            let fmax = self.desired_speed(fv, target);
            let gap = pos - p.length - fv.pos;
            if gap < 1.0 {
                return f32::NEG_INFINITY;
            }
            let after = idm::acceleration(fv.speed, fmax, gap, veh.speed, fp, self.weather);
            if after < -2.5 {
                return f32::NEG_INFINITY;
            }
            let before = match leader {
                Some(l) => {
                    let lv = &self.vehs[l as usize];
                    idm::acceleration(
                        fv.speed,
                        fmax,
                        lv.pos - lv.params().length - fv.pos,
                        lv.speed,
                        fp,
                        self.weather,
                    )
                }
                None => idm::acceleration(fv.speed, fmax, f32::INFINITY, 0.0, fp, self.weather),
            };
            follower_loss = before - after;
        }
        // Keep right on fast roads.
        let keep_right = if vmax > 20.0 { 0.15 } else { 0.0 };
        let bias = if step < 0 { keep_right } else { -keep_right };
        a_new - a_now - POLITENESS * follower_loss + bias
    }

    fn change_lane(&mut self, v: u32, target: u32) {
        self.remove_from_lane(v);
        let d = &self.net.d;
        let veh = &self.vehs[v as usize];
        let from = veh.lane as usize;
        let side = self.net.lane_index[target as usize] as f32 - self.net.lane_index[from] as f32;
        let shift = side * 0.5 * (d.lane_width[from] + d.lane_width[target as usize]);
        let pos = veh.pos * d.lane_length[target as usize] / d.lane_length[from].max(0.1);
        let next_link = self.choose_link(target, &veh.route, veh.route_idx, veh.params().vclass);
        let veh = &mut self.vehs[v as usize];
        veh.lane = target;
        veh.pos = pos;
        veh.lat -= shift;
        veh.lc_timer = 3.0;
        veh.next_link = next_link;
        veh.will_pass = true;
        self.insert_sorted(target, v);
    }

    /// A vehicle stuck at the end of a lane that does not lead on its route takes any way
    /// out of the lane and routes again from there.
    fn reroute_from_lane(&mut self, v: u32) {
        let Engine {
            net,
            vehs,
            router,
            travel_time,
            ..
        } = self;
        let veh = &mut vehs[v as usize];
        let vclass = TYPES[veh.vtype as usize].vclass;
        let Some(&dest) = veh.route.last() else {
            return;
        };
        router.tolls = veh.weighs_tolls;
        let here = net.d.lane_edge[veh.lane as usize];
        for l in net.lane_links(veh.lane) {
            if net.link_allow[l as usize] & vclass == 0 {
                continue;
            }
            let to_edge = net.d.lane_edge[net.d.link_to[l as usize] as usize];
            if let Some(route) = router.route(net, travel_time, to_edge, dest, vclass) {
                veh.route.clear();
                veh.route.push(here);
                veh.route.extend_from_slice(&route);
                veh.route_idx = 0;
                veh.next_link = l;
                veh.will_pass = true;
                veh.wait = 0.0;
                veh.blocked = 0.0;
                veh.plan_time = -1.0;
                return;
            }
        }
        veh.reroute_timer = REROUTE_RETRY;
    }

    /// Whether a trip's driver weighs motorway tolls. Drivers already on a tolled motorway
    /// where they cross the map's edge (or heading for one) chose it before the map and pay
    /// the toll anyway, so they stay on it; everyone else avoids tolls where a free road is
    /// not much slower.
    pub fn weighs_tolls(&self, trip: &Trip) -> bool {
        let on_toll = |flag: u8, edge: u32| {
            trip.flags & flag != 0 && edge < self.net.edge_count() as u32 && self.net.is_toll(edge)
        };
        !on_toll(trip::ENTER, trip.from) && !on_toll(trip::EXIT, trip.to)
    }

    // ---- insertion --------------------------------------------------------------------------

    fn insert_vehicles(&mut self) {
        let horizon = self.time + DT as f64;
        while let Some(Pending(trip)) = self.pending.peek() {
            if trip.depart > horizon {
                break;
            }
            let trip = self.pending.pop().unwrap().0;
            let vclass = TYPES[trip.vtype as usize].vclass;
            let n_edges = self.net.edge_count() as u32;
            if trip.from >= n_edges || trip.to >= n_edges {
                self.stats.no_route += 1;
                continue;
            }
            self.router.tolls = self.weighs_tolls(&trip);
            let route = self
                .router
                .route(&self.net, &self.travel_time, trip.from, trip.to, vclass);
            self.stats.routes += 1;
            self.stats.route_settled += self.router.last_settled as u64;
            match route {
                Some(route) => self.waiting.push_back(Waiting { trip, route }),
                None => self.stats.no_route += 1,
            }
        }
        for _ in 0..self.waiting.len() {
            let mut w = self.waiting.pop_front().unwrap();
            if self.try_insert(&w.trip, &mut w.route) {
                continue;
            }
            let max_delay = if w.trip.flags & trip::ENTER != 0 {
                MAX_ENTRY_DELAY
            } else {
                MAX_INSERT_DELAY
            };
            if self.time - w.trip.depart > max_delay {
                self.stats.insert_failed += 1;
            } else {
                self.waiting.push_back(w);
            }
        }
    }

    fn alloc_vehicle(&mut self) -> u32 {
        let v = match self.free.pop() {
            Some(v) => v,
            None => {
                self.vehs.push(Vehicle::empty());
                self.acc.push(0.0);
                self.vehs.len() as u32 - 1
            }
        };
        let serial = self.next_serial;
        self.next_serial = self.next_serial.wrapping_add(1).max(1);
        let route = std::mem::take(&mut self.vehs[v as usize].route);
        self.vehs[v as usize] = Vehicle {
            serial,
            route,
            ..Vehicle::empty()
        };
        v
    }

    /// Put a routed trip on the road if there is room where it starts.
    fn try_insert(&mut self, trip: &Trip, route: &mut Vec<u32>) -> bool {
        let p = &TYPES[trip.vtype as usize];
        let edge = route[0];
        let mut lane = NONE;
        let mut best = 0;
        let mut ties = 0;
        for l in self.net.edge_lanes(edge) {
            let s = self.lane_score(l, route, 0, p.vclass);
            if s < 0 || s < best {
                continue;
            }
            if s > best || lane == NONE {
                best = s;
                lane = l;
                ties = 1;
            } else {
                ties += 1;
                if self.rng.next_u32().is_multiple_of(ties) {
                    lane = l;
                }
            }
        }
        if lane == NONE {
            return false;
        }
        let len = self.net.d.lane_length[lane as usize];
        let enter = trip.flags & trip::ENTER != 0;
        let pos = if enter {
            p.length.min(len)
        } else {
            let frac = if route.len() == 1 {
                self.rng.range(0.05, 0.5)
            } else {
                self.rng.range(0.1, 0.9)
            };
            (frac * len).max(p.length.min(len)).min(len)
        };
        let speed_factor = (1.04 + 0.1 * self.rng.normal()).clamp(0.8, 1.3);
        // Vehicles from beyond the map arrive at their driving speed, or at a speed from
        // which they can still stop behind the vehicle ahead (Krauss safe speed).
        let mut speed = if enter {
            (self.net.d.lane_speed[lane as usize] * speed_factor).min(p.max_speed)
        } else {
            0.0
        };

        let list = &self.lane_vehs[lane as usize];
        let idx = list.partition_point(|&u| self.vehs[u as usize].pos < pos);
        if let Some(&l) = list.get(idx) {
            let lv = &self.vehs[l as usize];
            let gap = lv.pos - lv.params().length - pos;
            if gap < p.min_gap {
                return false;
            }
            let bt = p.decel * p.tau;
            let safe = (bt * bt + lv.speed * lv.speed + 2.0 * p.decel * (gap - p.min_gap)).sqrt();
            speed = speed.min((safe - bt).max(0.0));
        }
        if idx > 0 {
            let fv = &self.vehs[list[idx - 1] as usize];
            let fp = fv.params();
            let need = fp.min_gap + fv.speed * fp.tau + fv.speed * fv.speed / (2.0 * fp.decel);
            if pos - p.length - fv.pos < need {
                return false;
            }
        }

        let last = *route.last().unwrap();
        let last_len = self.net.edge_length[last as usize];
        let arrival_pos = if trip.flags & trip::EXIT != 0 {
            (last_len - 0.5).max(0.0)
        } else if route.len() == 1 {
            (pos + (len - pos) * self.rng.range(0.3, 0.9)).min(len - 0.1)
        } else {
            self.rng.range(0.15, 0.95) * last_len
        };
        let look = (self.rng.next_u32() & 0xffff) as u16;
        let next_link = self.choose_link(lane, route, 0, p.vclass);
        let weighs_tolls = self.weighs_tolls(trip);

        let v = self.alloc_vehicle();
        let veh = &mut self.vehs[v as usize];
        veh.vtype = trip.vtype;
        veh.look = look;
        veh.lane = lane;
        veh.pos = pos;
        veh.speed = speed;
        veh.speed_factor = speed_factor;
        veh.trip_flags = trip.flags;
        veh.weighs_tolls = weighs_tolls;
        veh.route.clear();
        veh.route.append(route);
        veh.next_link = next_link;
        veh.arrival_pos = arrival_pos;
        veh.depart = self.time;
        veh.lc_timer = 1.0;
        self.lane_vehs[lane as usize].insert(idx, v);
        if !self.lane_active[lane as usize] {
            self.lane_active[lane as usize] = true;
            self.active_lanes.push(lane);
        }
        if enter {
            self.edge_entered[edge as usize] += 1;
        }
        self.stats.departed += 1;
        true
    }

    /// Put a vehicle on the road right away at a given place and speed (tests, scripted
    /// scenarios). Its trip ends at the end of the route's last edge. Returns its slot.
    pub fn insert_at(
        &mut self,
        vtype: u8,
        route: Vec<u32>,
        lane: u32,
        pos: f32,
        speed: f32,
    ) -> u32 {
        let p = &TYPES[vtype as usize];
        let last = *route.last().expect("empty route");
        let arrival_pos = self.net.edge_length[last as usize] - 1.0;
        let next_link = self.choose_link(lane, &route, 0, p.vclass);
        let v = self.alloc_vehicle();
        let veh = &mut self.vehs[v as usize];
        veh.vtype = vtype;
        veh.lane = lane;
        veh.pos = pos;
        veh.speed = speed;
        veh.route = route;
        veh.next_link = next_link;
        veh.arrival_pos = arrival_pos;
        veh.depart = self.time;
        self.insert_sorted(lane, v);
        self.stats.departed += 1;
        v
    }

    /// Why vehicle `v` is held up right now.
    pub fn diagnose(&self, v: u32) -> Holdup {
        let net = &self.net;
        let d = &net.d;
        let veh = &self.vehs[v as usize];
        let lane = veh.lane;
        if net.lane_internal[lane as usize] {
            return Holdup::InJunction;
        }
        let list = &self.lane_vehs[lane as usize];
        let leader = list
            .iter()
            .position(|&u| u == v)
            .and_then(|i| list.get(i + 1));
        if let Some(&l) = leader {
            let lv = &self.vehs[l as usize];
            if lv.pos - lv.params().length - veh.pos < 15.0 {
                return Holdup::Queued;
            }
        }
        if veh.route_idx as usize + 1 >= veh.route.len() {
            return Holdup::Other;
        }
        let link = veh.next_link;
        if link == NONE {
            return Holdup::WrongLane;
        }
        let state = self.link_state(link);
        if matches!(state, b'r' | b'u' | b'y') {
            return Holdup::Signal;
        }
        if matches!(state, b's' | b'w') && veh.stop_done != link {
            return Holdup::StopSign;
        }
        if !self.exit_has_room(link, veh)
            || self.enters_roundabout(link) && !self.roundabout_exit_has_room(link, veh)
        {
            return Holdup::ExitFull;
        }
        let via = d.link_via[link as usize];
        let next = if via != NONE {
            via
        } else {
            d.link_to[link as usize]
        };
        if let Some(&r) = self.lane_vehs[next as usize].first() {
            let rv = &self.vehs[r as usize];
            if rv.pos - rv.params().length < 10.0 {
                return Holdup::BlockedAhead;
            }
        }
        let dist = d.lane_length[lane as usize] - veh.pos;
        let p = veh.params();
        let arrive = travel_time(dist, veh.speed, p.accel, self.link_speed(veh, link));
        let minor = !matches!(state, b'G' | b'M' | b'O');
        if self.junction_conflict(v, veh, link, minor, arrive, arrive + 3.0, false) {
            return Holdup::Yielding;
        }
        Holdup::Other
    }

    /// Charge the vehicles standing in each queue to the junction ahead, by why the queue's
    /// front vehicle, at the stop line, is waiting (M7a: where junctions lose time).
    fn measure_delay(&mut self) {
        let d = &self.net.d;
        let junctions = d.junction_link_count.len();
        if self.delay.len() != junctions {
            self.delay = vec![[0.0; Holdup::COUNT]; junctions];
            self.delay_root = vec![[0.0; Holdup::COUNT]; junctions];
        }
        let dt = DELAY_EVERY as f32 * DT;
        for i in 0..self.active_lanes.len() {
            let lane = self.active_lanes[i] as usize;
            if self.net.lane_internal[lane] {
                continue;
            }
            let list = &self.lane_vehs[lane];
            let Some(&front) = list.last() else {
                continue;
            };
            let fv = &self.vehs[front as usize];
            if fv.speed > 1.0 || d.lane_length[lane] - fv.pos > DELAY_REACH {
                continue;
            }
            let stopped = list
                .iter()
                .filter(|&&u| self.vehs[u as usize].speed < 1.0)
                .count();
            let junction = d.edge_to[d.lane_edge[lane] as usize];
            let why = self.diagnose(front);
            let (root, root_why) = if why == Holdup::ExitFull {
                self.queue_root(lane as u32, front)
            } else {
                (junction, why)
            };
            let charge = stopped as f32 * dt;
            if let Some(row) = self.delay.get_mut(junction as usize) {
                row[why as usize] += charge;
            }
            if let Some(row) = self.delay_root.get_mut(root as usize) {
                row[root_why as usize] += charge;
            }
        }
    }

    /// Where a queue whose front waits for room behind the junction is held up in the end:
    /// the junction whose queue fills the exit, following full exits downstream (at most
    /// 12 junctions), and why that queue's front waits. A short exit that is empty counts
    /// as full when the way on beyond it is (`exit_has_room`), so the walk goes on along the
    /// front vehicle's route; an exit taken up by vehicles still inside the junction counts
    /// as `InJunction`, and one full of traffic moving slowly, or queued with its front away
    /// from a junction, as `SlowRoad` or `StandingMidRoad` at the junction it leads to.
    fn queue_root(&self, lane: u32, front: u32) -> (u32, Holdup) {
        let d = &self.net.d;
        let junction_of = |lane: u32| d.edge_to[d.lane_edge[lane as usize] as usize];
        let (mut lane, mut v) = (lane, front);
        let mut link = self.vehs[v as usize].next_link;
        let mut idx = self.vehs[v as usize].route_idx;
        for _ in 0..12 {
            if link == NONE {
                break;
            }
            let to = d.link_to[link as usize];
            let Some(&f) = self.lane_vehs[to as usize].last() else {
                if self.lane_reserved[to as usize] > 0.0 {
                    return (junction_of(lane), Holdup::InJunction);
                }
                // An empty lane: on along the same vehicle's route.
                let veh = &self.vehs[v as usize];
                idx += 1;
                link = self.choose_link_or_detour(to, &veh.route, idx, veh.params().vclass);
                lane = to;
                continue;
            };
            let fv = &self.vehs[f as usize];
            if fv.speed > 1.0 {
                return (junction_of(to), Holdup::SlowRoad);
            }
            if d.lane_length[to as usize] - fv.pos > DELAY_REACH {
                return (junction_of(to), Holdup::StandingMidRoad);
            }
            let why = self.diagnose(f);
            if why != Holdup::ExitFull {
                return (junction_of(to), why);
            }
            (lane, v) = (to, f);
            link = fv.next_link;
            idx = fv.route_idx;
        }
        (junction_of(lane), Holdup::ExitFull)
    }

    /// Who a vehicle waiting at its next junction has to look out for (diagnostics): the
    /// vehicles inside or approaching the links it gives way to and those crossing it, with
    /// their type, the link's state, and when they arrive and leave (s).
    pub fn describe_conflicts(&self, v: u32) -> String {
        let net = &self.net;
        let d = &net.d;
        let link = self.vehs[v as usize].next_link;
        if link == NONE {
            return String::from("no link");
        }
        let j = d.link_junction[link as usize];
        let r = d.link_request[link as usize];
        if j == NONE || r == u16::MAX {
            return String::from("no right of way here");
        }
        let mut out = Vec::new();
        let mut users = [LinkUser::default(); 8];
        for (kind, list) in [
            (
                "gives way to",
                net.response(j, r as u32).collect::<Vec<_>>(),
            ),
            ("crosses", net.foes(j, r as u32).collect::<Vec<_>>()),
        ] {
            for f in list {
                let fl = net.request_link(j, f);
                if fl == NONE || fl == link {
                    continue;
                }
                let n = self.link_users(fl, &mut users, true, false);
                for u in &users[..n] {
                    let uv = &self.vehs[u.veh as usize];
                    out.push(format!(
                        "{kind} link {fl} '{}' veh {} type {} arrive {:.1} leave {:.1} speed {:.1}",
                        self.link_state(fl) as char,
                        u.veh,
                        uv.vtype,
                        u.arrive,
                        u.leave,
                        u.speed
                    ));
                }
            }
        }
        if out.is_empty() {
            String::from("nobody")
        } else {
            out.join("; ")
        }
    }

    /// The vehicles inside a junction that the vehicle waiting at it gives way to or
    /// crosses, each with what lies ahead of it (diagnostics: why they are still there).
    pub fn describe_blockers(&self, v: u32) -> Vec<String> {
        let net = &self.net;
        let d = &net.d;
        let link = self.vehs[v as usize].next_link;
        if link == NONE {
            return Vec::new();
        }
        let (j, r) = (
            d.link_junction[link as usize],
            d.link_request[link as usize],
        );
        if j == NONE || r == u16::MAX {
            return Vec::new();
        }
        let mut seen = Vec::new();
        let mut users = [LinkUser::default(); 8];
        for f in net.response(j, r as u32).chain(net.foes(j, r as u32)) {
            let fl = net.request_link(j, f);
            if fl == NONE || fl == link {
                continue;
            }
            let n = self.link_users(fl, &mut users, false, false);
            for u in &users[..n] {
                if u.veh != v && !seen.contains(&u.veh) {
                    seen.push(u.veh);
                }
            }
        }
        seen.iter()
            .map(|&u| format!("{}{}", self.describe(u), self.describe_ahead(u)))
            .collect()
    }

    /// The signal programs at junction `j` as the engine runs them, after merging and
    /// re-timing (diagnostics): each link by its index in the program (tram or road, its
    /// direction, the lanes it joins), then each phase with its durations and states.
    pub fn describe_program(&self, j: u32) -> String {
        let d = &self.net.d;
        let mut programs: Vec<u32> = (0..d.link_from.len())
            .filter(|&l| d.link_junction[l] == j && d.link_tls[l] != NONE)
            .map(|l| d.link_tls[l])
            .collect();
        programs.sort_unstable();
        programs.dedup();
        let mut out = String::new();
        for t in programs {
            let t = t as usize;
            out.push_str(&format!("  program {t}:\n"));
            let mut links: Vec<u32> = self.tls_links
                [self.tls_link_offsets[t] as usize..self.tls_link_offsets[t + 1] as usize]
                .to_vec();
            links.sort_by_key(|&l| d.link_tls_index[l as usize]);
            for l in links {
                let from = d.link_from[l as usize] as usize;
                let road = d.lane_allow[from] & (vclass::PASSENGER | vclass::BUS) != 0;
                out.push_str(&format!(
                    "    {:2} link {l} {} {} lane {from} -> lane {}\n",
                    d.link_tls_index[l as usize],
                    if road { "road" } else { "tram" },
                    // The pipeline's linkDirs: straight, left, right, turn, partly left/right.
                    b"slrtLR?"[(d.link_dir[l as usize] as usize).min(6)] as char,
                    d.link_to[l as usize],
                ));
            }
            let (a, b) = self.phase_range(t);
            for p in a..b {
                let states = &d.phase_states
                    [d.phase_state_offsets[p] as usize..d.phase_state_offsets[p + 1] as usize];
                out.push_str(&format!(
                    "    phase {:5.1} s ({:5.1}-{:5.1}) {}\n",
                    d.phase_duration[p],
                    d.phase_min_dur[p],
                    d.phase_max_dur[p],
                    String::from_utf8_lossy(states)
                ));
            }
        }
        out
    }

    /// The queue a vehicle held up by a full road waits on, followed downstream as
    /// `queue_root` follows it (diagnostics): each road's front vehicle, where it stands and
    /// why it waits, until one waits for something else (or 12 roads on).
    pub fn describe_queue_chain(&self, front: u32) -> String {
        let d = &self.net.d;
        let mut out = String::new();
        let mut v = front;
        let mut link = self.vehs[v as usize].next_link;
        let mut idx = self.vehs[v as usize].route_idx;
        for _ in 0..12 {
            if link == NONE {
                out += " | no link";
                break;
            }
            let to = d.link_to[link as usize];
            let edge = d.lane_edge[to as usize];
            let junction = d.edge_to[edge as usize];
            let Some(&f) = self.lane_vehs[to as usize].last() else {
                out += &format!(
                    " | lane {to} (edge {edge}, {:.1} m) empty, reserved {:.1}",
                    d.lane_length[to as usize], self.lane_reserved[to as usize]
                );
                let veh = &self.vehs[v as usize];
                idx += 1;
                link = self.choose_link_or_detour(to, &veh.route, idx, veh.params().vclass);
                continue;
            };
            let fv = &self.vehs[f as usize];
            let why = self.diagnose(f);
            out += &format!(
                " | lane {to} (edge {edge}, {:.1} m, {} vehicles) front {f} at {:.1} speed {:.1} {why:?} at junction {junction}",
                d.lane_length[to as usize],
                self.lane_vehs[to as usize].len(),
                fv.pos,
                fv.speed
            );
            if fv.speed > 1.0 || why != Holdup::ExitFull {
                break;
            }
            v = f;
            link = fv.next_link;
            idx = fv.route_idx;
        }
        out
    }

    /// Human-readable state of the lane behind a vehicle's next junction (diagnostics).
    pub fn describe_exit(&self, v: u32) -> String {
        let d = &self.net.d;
        let veh = &self.vehs[v as usize];
        let link = veh.next_link;
        if link == NONE {
            return "no link".into();
        }
        let to = d.link_to[link as usize] as usize;
        let rear = self.lane_vehs[to].first().map(|&u| {
            let uv = &self.vehs[u as usize];
            format!(
                "rear veh {u} pos {:.1} len {:.1} speed {:.1} wait {:.0} holdup {:?} route {}/{} next_link {}",
                uv.pos,
                uv.params().length,
                uv.speed,
                uv.wait,
                self.diagnose(u),
                uv.route_idx,
                uv.route.len(),
                uv.next_link
            )
        });
        format!(
            "to lane {to} len {:.1} reserved {:.1} vehicles {} {}",
            d.lane_length[to],
            self.lane_reserved[to],
            self.lane_vehs[to].len(),
            rear.unwrap_or_default()
        )
    }

    /// The vehicle directly ahead of `v` (same lane, or the rearmost on the lanes ahead
    /// along its way), if any within 50 m.
    pub fn leader_of(&self, v: u32) -> Option<u32> {
        let d = &self.net.d;
        let veh = &self.vehs[v as usize];
        let list = &self.lane_vehs[veh.lane as usize];
        let i = list.iter().position(|&u| u == v)?;
        if let Some(&l) = list.get(i + 1) {
            return Some(l);
        }
        let mut lane = veh.lane;
        let mut dist = d.lane_length[lane as usize] - veh.pos;
        let mut route_i = veh.route_idx;
        for _ in 0..6 {
            if dist > 50.0 {
                return None;
            }
            let next = if self.net.lane_internal[lane as usize] {
                d.lane_next[lane as usize]
            } else {
                let link = if lane == veh.lane {
                    veh.next_link
                } else {
                    self.choose_link(lane, &veh.route, route_i, veh.params().vclass)
                };
                if link == NONE {
                    return None;
                }
                let via = d.link_via[link as usize];
                if via != NONE {
                    via
                } else {
                    d.link_to[link as usize]
                }
            };
            if next == NONE {
                return None;
            }
            if !self.net.lane_internal[next as usize] {
                route_i += 1;
            }
            if let Some(&r) = self.lane_vehs[next as usize].first() {
                return Some(r);
            }
            dist += d.lane_length[next as usize];
            lane = next;
        }
        None
    }

    /// One line about a vehicle's state (diagnostics).
    pub fn describe(&self, v: u32) -> String {
        let d = &self.net.d;
        let veh = &self.vehs[v as usize];
        let lane = veh.lane as usize;
        let link = veh.next_link;
        let state = if link != NONE {
            self.link_state(link) as char
        } else {
            '-'
        };
        format!(
            "veh {v} lane {lane}{} edge {} pos {:.1}/{:.1} speed {:.1} wait {:.0} {:?} link {} '{}' pass {} route {}/{}",
            if self.net.lane_internal[lane] {
                " (junction)"
            } else {
                ""
            },
            d.lane_edge[lane],
            veh.pos,
            d.lane_length[lane],
            veh.speed,
            veh.wait,
            self.diagnose(v),
            if link == NONE { -1 } else { link as i64 },
            state,
            veh.will_pass,
            veh.route_idx,
            veh.route.len(),
        )
    }

    /// The lanes and stop lines ahead of a vehicle as its look-ahead sees them (diagnostics).
    pub fn describe_ahead(&self, v: u32) -> String {
        let net = &self.net;
        let d = &net.d;
        let veh = &self.vehs[v as usize];
        let p = veh.params();
        let mut out = String::new();
        let mut cur = veh.lane;
        let mut dist = d.lane_length[cur as usize] - veh.pos;
        let mut route_i = veh.route_idx;
        for _ in 0..5 {
            let next;
            if net.lane_internal[cur as usize] {
                next = d.lane_next[cur as usize];
                out += &format!(" | internal {cur} -> next {}", next as i64);
                if next == NONE {
                    break;
                }
                if !net.lane_internal[next as usize] {
                    route_i += 1;
                }
            } else {
                if route_i as usize + 1 >= veh.route.len() {
                    out += " | destination edge";
                    break;
                }
                let own = cur == veh.lane;
                let link = if own {
                    veh.next_link
                } else {
                    self.choose_link_or_detour(cur, &veh.route, route_i, p.vclass)
                };
                if link == NONE {
                    out += &format!(
                        " | lane {cur} (len {:.1}) has no link to edge {}",
                        d.lane_length[cur as usize],
                        veh.route[route_i as usize + 1]
                    );
                    break;
                }
                let state = self.link_state(link);
                let go = self.may_pass(v, veh, link, state, dist, own);
                out += &format!(
                    " | stop line of link {link} at {dist:.1} m state '{}' go {go} exit room {} tls {}",
                    state as char,
                    self.exit_has_room(link, veh),
                    d.link_tls[link as usize] as i64
                );
                if !go {
                    break;
                }
                let via = d.link_via[link as usize];
                next = if via != NONE {
                    via
                } else {
                    route_i += 1;
                    d.link_to[link as usize]
                };
            }
            out += &format!(
                " -> lane {next} len {:.1} vehicles {}",
                d.lane_length[next as usize],
                self.lane_vehs[next as usize].len()
            );
            dist += d.lane_length[next as usize];
            cur = next;
        }
        out
    }

    /// Vehicle slots in use.
    pub fn live_vehicles(&self) -> impl Iterator<Item = u32> + '_ {
        (0..self.vehs.len() as u32).filter(|&v| self.vehs[v as usize].alive())
    }

    // ---- statistics -------------------------------------------------------------------------

    fn collect_stats(&mut self) {
        let mut sum = 0.0f64;
        let mut running = 0u32;
        let mut stopped = 0u32;
        let (mut trams, mut buses, mut trains, mut outside) = (0u32, 0u32, 0u32, 0u32);
        let (mut driving, mut delay, mut metres) = (0f64, 0f64, 0f64);
        let mut stuck = std::mem::take(&mut self.scratch);
        stuck.clear();
        let d = &self.net.d;
        for &lane in &self.active_lanes {
            let internal = self.net.lane_internal[lane as usize];
            let edge = d.lane_edge[lane as usize] as usize;
            for &v in &self.lane_vehs[lane as usize] {
                let veh = &self.vehs[v as usize];
                sum += veh.speed as f64;
                running += 1;
                match veh.vtype {
                    vtype::TRAM => trams += 1,
                    vtype::BUS => buses += 1,
                    vtype::TRAIN => trains += 1,
                    _ => {}
                }
                if veh.trip_flags != 0 {
                    outside += 1;
                }
                if !matches!(veh.vtype, vtype::TRAM | vtype::TRAIN) {
                    let limit = d.lane_speed[lane as usize].min(veh.params().max_speed);
                    driving += 1.0;
                    delay += (1.0 - veh.speed / limit.max(1.0)).clamp(0.0, 1.0) as f64;
                    metres += veh.speed as f64;
                }
                if veh.speed < 0.1 {
                    stopped += 1;
                    if veh.wait > STUCK_TIME {
                        stuck.push((v, veh.serial));
                    }
                }
                if !internal {
                    self.edge_speed_sum[edge] += veh.speed;
                    self.edge_speed_n[edge] = self.edge_speed_n[edge].saturating_add(1);
                }
            }
        }
        for &(v, _) in &stuck {
            let reason = self.diagnose(v);
            let count = self
                .stats
                .teleport_reasons
                .entry(format!("{reason:?}"))
                .or_default();
            *count += 1;
            let edge = self.net.d.lane_edge[self.vehs[v as usize].lane as usize];
            let log = if self.debug_edges.is_empty() {
                *count <= 4
            } else {
                self.debug_edges.contains(&edge)
                    && self.stats.removed_at.get(&edge).copied().unwrap_or(0) < 6
            };
            if self.debug && log {
                let line = format!(
                    "{}\n      sees:{}",
                    self.describe(v),
                    self.describe_ahead(v)
                );
                self.stats.teleport_log.push(line);
            }
            self.remove_from_lane(v);
            self.finish(v, Finish::Teleported);
        }
        self.scratch = stuck;

        // Drop lanes that emptied from the active list.
        let Engine {
            active_lanes,
            lane_active,
            lane_vehs,
            ..
        } = self;
        active_lanes.retain(|&l| {
            let keep = !lane_vehs[l as usize].is_empty();
            if !keep {
                lane_active[l as usize] = false;
            }
            keep
        });

        let s = &mut self.stats;
        s.vehicle_seconds += driving * DT as f64;
        s.delay_seconds += delay * DT as f64;
        s.vehicle_metres += metres * DT as f64;
        s.running = running;
        s.stopped = stopped;
        s.trams = trams;
        s.trains = trains;
        s.buses = buses;
        s.outside = outside;
        s.mean_speed = if running > 0 {
            (sum / running as f64) as f32
        } else {
            0.0
        };
        if self.step_no.is_multiple_of(EDGE_STATS_INTERVAL) {
            if s.trip_count > 0 {
                s.mean_trip_time = (s.trip_time_sum / s.trip_count as f64) as f32;
                s.mean_trip_km = (s.trip_km_sum / s.trip_count as f64) as f32;
            }
            self.update_edge_times();
        }
    }

    /// Fold the measured speeds into the travel times routing uses.
    fn update_edge_times(&mut self) {
        for e in 0..self.travel_time.len() {
            let n = self.edge_speed_n[e];
            let free = self.free_time[e];
            if n > 0 {
                let mean = self.edge_speed_sum[e] / n as f32;
                let measured =
                    (self.net.edge_length[e] / mean.max(0.3)).clamp(free, free * 30.0 + 60.0);
                self.travel_time[e] = 0.5 * self.travel_time[e] + 0.5 * measured;
                self.edge_speed_ratio[e] = ((mean / self.net.edge_speed[e]).min(1.0) * 254.0) as u8;
            } else {
                self.travel_time[e] = 0.8 * self.travel_time[e] + 0.2 * free;
                self.edge_speed_ratio[e] = 255;
            }
            self.edge_speed_sum[e] = 0.0;
            self.edge_speed_n[e] = 0;
        }
        for &e in &self.closed {
            self.travel_time[e as usize] = CLOSED_TIME;
        }
    }

    /// Close these roads (replacing earlier closures): new routes avoid them where they can,
    /// and vehicles whose way on uses one look for another. Buses and trams keep their routes.
    pub fn set_closed(&mut self, edges: &[u32]) {
        for &e in &self.closed {
            self.travel_time[e as usize] = self.free_time[e as usize];
        }
        let n = self.net.edge_count() as u32;
        let mut closed: Vec<u32> = edges
            .iter()
            .copied()
            .filter(|&e| e < n && !self.net.is_internal_edge(e))
            .collect();
        closed.sort_unstable();
        closed.dedup();
        for &e in &closed {
            self.travel_time[e as usize] = CLOSED_TIME;
        }
        self.closed = closed;
        if self.closed.is_empty() {
            return;
        }
        let live: Vec<u32> = self.live_vehicles().collect();
        for v in live {
            let veh = &self.vehs[v as usize];
            if veh.transit.is_some() || self.net.lane_internal[veh.lane as usize] {
                continue;
            }
            let ahead = &veh.route[(veh.route_idx as usize + 1).min(veh.route.len())..];
            if ahead.iter().any(|e| self.closed.binary_search(e).is_ok()) {
                self.reroute_from_lane(v);
            }
        }
    }

    /// Roads closed with `set_closed`.
    pub fn closed(&self) -> &[u32] {
        &self.closed
    }

    // ---- edits --------------------------------------------------------------------------

    /// Replace the edits in force with `edits` (see `edits.rs`), on the network as loaded.
    /// Returns how many fit the network; the others are ignored. Vehicles whose way on is
    /// no longer open re-plan at once, the rest within `REPLAN_TIME`. Where an edit makes a
    /// road faster, the landmark tables are rebuilt over the next steps, and routes use the
    /// straight-line bound meanwhile.
    pub fn set_edits(&mut self, edits: &[Edit]) -> usize {
        self.loaded.restore(&mut self.net);
        let mut applied = Vec::with_capacity(edits.len());
        for edit in edits {
            if edits::apply(&mut self.net, edit) {
                applied.push(*edit);
            }
        }
        self.net.refresh_speeds();
        self.net.refresh_links();
        for e in 0..self.free_time.len() {
            let free = self.net.edge_length[e] / self.net.edge_speed[e].max(1.0);
            if (free - self.free_time[e]).abs() > 1e-3 * self.free_time[e] {
                self.free_time[e] = free;
                self.travel_time[e] = free;
            }
        }
        for &e in &self.closed {
            self.travel_time[e as usize] = CLOSED_TIME;
        }
        let valid = self
            .router
            .landmarks
            .as_ref()
            .is_some_and(|l| l.valid_for(&self.free_time));
        if !valid || self.landmark_job.is_some() {
            self.router.landmarks = None;
            self.landmark_job = Some(LandmarkBuild::new(&self.net, &self.free_time));
        }
        self.edits = applied;

        // Re-plan: at once where the way on is closed, gradually everywhere else.
        let live: Vec<u32> = self.live_vehicles().collect();
        let mut later = Vec::new();
        for v in live {
            let veh = &self.vehs[v as usize];
            if veh.transit.is_some() {
                continue;
            }
            if !self.net.lane_internal[veh.lane as usize] && self.route_blocked(v) {
                self.replan_vehicle(v, true);
            } else {
                later.push((v, veh.serial));
            }
        }
        self.replan_per_step = later.len().div_ceil((REPLAN_TIME / DT) as usize).max(1);
        self.replan = later;
        self.edits.len()
    }

    /// Travel time (s) of the fastest route for a car from one road to another on the
    /// travel times measured now (None if there is no route).
    pub fn route_time(&mut self, from: u32, to: u32) -> Option<f32> {
        let n = self.net.edge_count() as u32;
        if from >= n || to >= n {
            return None;
        }
        self.router.tolls = true;
        let route = self
            .router
            .route(&self.net, &self.travel_time, from, to, vclass::PASSENGER)?;
        Some(
            route[1..]
                .iter()
                .map(|&e| self.travel_time[e as usize])
                .sum(),
        )
    }

    /// Homes and jobs within reach by car of each road in `sources` on the travel times
    /// measured now (gravity accessibility): the demand's home and work weights (residents
    /// and jobs) of the roads reached within `max` seconds, each weighted by
    /// `exp(-time / decay)`. Without demand, or from a road the network does not have, none.
    pub fn reach(&mut self, sources: &[u32], decay: f32, max: f32) -> Vec<[f32; 2]> {
        let n = self.net.edge_count();
        let Some(demand) = self.demand.as_ref() else {
            return vec![[0.0; 2]; sources.len()];
        };
        let (home, work) = demand.weights_by_edge();
        let decay = decay.max(1.0);
        sources
            .iter()
            .map(|&from| {
                let mut sum = [0.0f32; 2];
                if (from as usize) < n {
                    self.router.reach(
                        &self.net,
                        &self.travel_time,
                        from,
                        max,
                        vclass::PASSENGER,
                        |e, t| {
                            let w = (-t / decay).exp();
                            sum[0] += w * home.get(e as usize).copied().unwrap_or(0.0);
                            sum[1] += w * work.get(e as usize).copied().unwrap_or(0.0);
                        },
                    );
                }
                sum
            })
            .collect()
    }

    /// Edits in force.
    pub fn edits(&self) -> &[Edit] {
        &self.edits
    }

    /// Whether the landmark tables are complete (false while being rebuilt after an edit).
    pub fn landmarks_ready(&self) -> bool {
        self.landmark_job.is_none()
    }

    /// Whether a vehicle's route ahead uses a move its class may no longer make.
    fn route_blocked(&self, v: u32) -> bool {
        let veh = &self.vehs[v as usize];
        let vclass = veh.params().vclass;
        veh.route[veh.route_idx as usize..].windows(2).any(|w| {
            !self
                .net
                .successors(w[0])
                .iter()
                .any(|s| s.edge == w[1] && s.allow & vclass != 0)
        })
    }

    /// Plan a vehicle's route again from the road it is on. `now`: even right before the
    /// junction ahead (its way on is closed). Keeps the old route if there is no other.
    fn replan_vehicle(&mut self, v: u32, now: bool) {
        let veh = &self.vehs[v as usize];
        let lane = veh.lane;
        if self.net.lane_internal[lane as usize] {
            return;
        }
        if !now && self.net.d.lane_length[lane as usize] - veh.pos < REPLAN_MARGIN {
            return;
        }
        let Some(&dest) = veh.route.last() else {
            return;
        };
        let vclass = veh.params().vclass;
        let here = self.net.d.lane_edge[lane as usize];
        self.router.tolls = veh.weighs_tolls;
        let Some(route) = self
            .router
            .route(&self.net, &self.travel_time, here, dest, vclass)
        else {
            return;
        };
        if route[..] == veh.route[veh.route_idx as usize..] {
            return;
        }
        let link = self.choose_link(lane, &route, 0, vclass);
        let veh = &mut self.vehs[v as usize];
        veh.route = route;
        veh.route_idx = 0;
        veh.next_link = link;
        veh.reroute_timer = 0.0;
        veh.plan_time = -1.0;
    }

    /// Drivers on their way weigh their route every `REROUTE_CHECK` seconds, each at its own
    /// moment: when the rest of it now takes a quarter and a minute longer than they expected
    /// (the roads ahead have jammed), they look for a faster way, as drivers with navigation
    /// apps do (SUMO's rerouting device). A new way is taken when it saves a tenth of the time
    /// left and at least a minute, and only where the lane they are in leads on along it or
    /// there is room to change lanes first.
    fn reroute_en_route(&mut self) {
        if !self.reroute {
            return;
        }
        let period = (REROUTE_CHECK / DT) as u32;
        let mut v = self.step_no % period;
        while (v as usize) < self.vehs.len() {
            self.weigh_route(v);
            v += period;
        }
    }

    /// The time the rest of a vehicle's route takes at today's measured speeds (s).
    fn route_cost_ahead(&self, veh: &Vehicle) -> f32 {
        self.route_cost(veh, &veh.route[veh.route_idx as usize + 1..])
    }

    /// The time from where a vehicle is to the end of its road, then along `rest` (s).
    fn route_cost(&self, veh: &Vehicle, rest: &[u32]) -> f32 {
        let d = &self.net.d;
        let lane = veh.lane as usize;
        let here = self.travel_time[d.lane_edge[lane] as usize]
            * (1.0 - veh.pos / d.lane_length[lane].max(0.1)).max(0.0);
        here + rest
            .iter()
            .map(|&e| self.travel_time[e as usize])
            .sum::<f32>()
    }

    fn weigh_route(&mut self, v: u32) {
        let veh = &self.vehs[v as usize];
        if !veh.alive()
            || veh.transit.is_some()
            || veh.lane == NONE
            || self.net.lane_internal[veh.lane as usize]
            || veh.route_idx as usize + 2 >= veh.route.len()
        {
            return;
        }
        let cost = self.route_cost_ahead(veh);
        let now = self.time;
        if veh.plan_time < 0.0 {
            let veh = &mut self.vehs[v as usize];
            (veh.plan_time, veh.plan_cost) = (now, cost);
            return;
        }
        let expected = (veh.plan_cost - (now - veh.plan_time) as f32).max(0.0);
        if cost <= expected * (1.0 + REROUTE_SLOWER) + REROUTE_LOSS {
            return;
        }
        // Look for another way, but not right before the junction ahead, where the way on is
        // already chosen; whatever is found, what the rest of the way takes now is what the
        // driver expects from here on.
        let d = &self.net.d;
        let lane = veh.lane;
        let room = d.lane_length[lane as usize] - veh.pos;
        if room < REPLAN_MARGIN {
            return;
        }
        let vclass = veh.params().vclass;
        let here = d.lane_edge[lane as usize];
        let dest = *veh.route.last().unwrap();
        self.router.tolls = veh.weighs_tolls;
        let found = self
            .router
            .route(&self.net, &self.travel_time, here, dest, vclass);
        let veh = &self.vehs[v as usize];
        if let Some(route) = found
            && route[..] != veh.route[veh.route_idx as usize..]
        {
            let link = self.choose_link(lane, &route, 0, vclass);
            let saved = cost - self.route_cost(veh, &route[1..]);
            if saved >= (REROUTE_GAIN * cost).max(REROUTE_GAIN_TIME)
                && (link != NONE || room > REROUTE_LANE_ROOM)
            {
                self.stats.en_route_reroutes += 1;
                let veh = &mut self.vehs[v as usize];
                veh.route = route;
                veh.route_idx = 0;
                veh.next_link = link;
            }
        }
        let veh = &self.vehs[v as usize];
        let cost = self.route_cost_ahead(veh);
        let veh = &mut self.vehs[v as usize];
        (veh.plan_time, veh.plan_cost) = (now, cost);
    }

    /// Re-plan the next few vehicles waiting since the last edit.
    fn replan_some(&mut self) {
        for _ in 0..self.replan_per_step {
            let Some((v, serial)) = self.replan.pop() else {
                return;
            };
            let veh = &self.vehs[v as usize];
            if veh.alive() && veh.serial == serial {
                self.replan_vehicle(v, false);
            }
        }
    }

    /// Run the next landmark searches; swap the tables in when complete.
    fn build_landmarks(&mut self) {
        let Some(job) = self.landmark_job.as_mut() else {
            return;
        };
        let mut done = false;
        for _ in 0..LANDMARK_SEARCHES_PER_STEP {
            if job.step(&self.net) {
                done = true;
                break;
            }
        }
        if done && let Some(job) = self.landmark_job.take() {
            self.router.landmarks = Some(job.finish());
        }
    }

    pub fn stats_array(&self) -> [f64; stat::LEN] {
        let s = &self.stats;
        let mut out = [0.0; stat::LEN];
        out[stat::TIME] = self.time;
        out[stat::RUNNING] = s.running as f64;
        out[stat::DEPARTED] = s.departed as f64;
        out[stat::ARRIVED] = s.arrived as f64;
        out[stat::TELEPORTED] = s.teleported as f64;
        out[stat::NO_ROUTE] = s.no_route as f64;
        out[stat::INSERT_FAILED] = s.insert_failed as f64;
        out[stat::BACKLOG] = self.waiting.len() as f64;
        out[stat::MEAN_SPEED] = s.mean_speed as f64;
        out[stat::STOPPED] = s.stopped as f64;
        out[stat::MEAN_TRIP_TIME] = s.mean_trip_time as f64;
        out[stat::MEAN_TRIP_KM] = s.mean_trip_km as f64;
        out[stat::PENDING] = self.pending.len() as f64;
        out[stat::SLOTS] = self.vehs.len() as f64;
        out[stat::TRAMS] = s.trams as f64;
        out[stat::BUSES] = s.buses as f64;
        out[stat::OUTSIDE] = s.outside as f64;
        out[stat::VEHICLE_HOURS] = s.vehicle_seconds / 3600.0;
        out[stat::DELAY_HOURS] = s.delay_seconds / 3600.0;
        out[stat::VEHICLE_KM] = s.vehicle_metres / 1000.0;
        out[stat::TRAINS] = s.trains as f64;
        out
    }

    // ---- drawing ----------------------------------------------------------------------------

    /// Lane and position `back` metres behind a vehicle's front, following the lanes it
    /// came from.
    fn behind(&self, veh: &Vehicle, back: f32) -> (u32, f32) {
        let mut s = veh.pos - back;
        let mut lane = veh.lane;
        let mut i = 0;
        while s < 0.0 && i < 3 && veh.hist[i] != NONE {
            lane = veh.hist[i];
            s += self.net.d.lane_length[lane as usize];
            i += 1;
        }
        (lane, s.max(0.0))
    }

    /// Fill `render` with every vehicle slot's pose (see `RENDER_STRIDE`).
    pub fn write_render(&mut self) {
        let n = self.vehs.len();
        self.render.resize(n * RENDER_STRIDE, 0);
        for v in 0..n {
            let o = v * RENDER_STRIDE;
            let veh = &self.vehs[v];
            if !veh.alive() {
                self.render[o + 5] = 0;
                continue;
            }
            let p = veh.params();
            // Mid-lane-change, the front is further over than the rear.
            let lean = if veh.lat != 0.0 {
                (p.length * LATERAL_SPEED / veh.speed.max(2.0)).min(veh.lat.abs())
                    * 0.5
                    * veh.lat.signum()
            } else {
                0.0
            };
            let front = self.net.sample(veh.lane, veh.pos, veh.lat - lean);
            let (cl, cs) = self.behind(veh, p.length * 0.5);
            let center = self.net.sample(cl, cs, veh.lat);
            let (rl, rs) = self.behind(veh, p.length);
            let rear = self.net.sample(rl, rs, veh.lat + lean);
            let (dx, dz) = (front[0] - rear[0], front[2] - rear[2]);
            let heading = if dx * dx + dz * dz > 0.25 {
                dx.atan2(dz)
            } else {
                center[3]
            };
            let mut flags = veh.vtype as u32 | (veh.look as u32) << 16;
            if self.net.lane_abs_y[cl as usize] {
                flags |= info::ABS_Y;
            }
            if veh.accel < -0.6 || veh.speed < 0.1 {
                flags |= info::BRAKE;
            }
            if veh.blink > 0 || veh.lat < -0.3 {
                flags |= info::BLINK_LEFT;
            } else if veh.blink < 0 || veh.lat > 0.3 {
                flags |= info::BLINK_RIGHT;
            }
            let out = &mut self.render[o..o + RENDER_STRIDE];
            out[0] = center[0].to_bits();
            out[1] = center[1].to_bits();
            out[2] = center[2].to_bits();
            out[3] = heading.to_bits();
            out[4] = veh.speed.to_bits();
            out[5] = veh.serial;
            out[6] = flags;
            out[7] = veh.accel.to_bits();
        }
    }
}
