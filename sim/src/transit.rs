//! Scheduled trams and buses (ZET GTFS, placed on the network by pipeline/transit.py).
//!
//! Each trip starts at its first stop at the scheduled time, drives the fastest way for its
//! vehicle class from stop to stop, and at each stop waits for passengers and for its
//! scheduled departure. When the simulation starts mid-day, trips already under way start
//! from the stop they are scheduled to be at.

use std::collections::HashMap;

/// Timetable arrays (names as in the packed file).
#[derive(Default, Clone)]
pub struct TransitData {
    /// Engine vehicle type per trip (bus or tram).
    pub trip_type: Vec<u8>,
    /// Route per trip (index into the app's route table).
    pub trip_route: Vec<u16>,
    /// Offsets of each trip's stops (trips + 1).
    pub trip_stops: Vec<u32>,
    pub stop_edge: Vec<u32>,
    /// Position of the stop along its lane, as a fraction of the lane's length.
    pub stop_frac: Vec<f32>,
    /// Scheduled departure (s after the service day's midnight; may exceed 24 h).
    pub stop_time: Vec<f32>,
}

impl TransitData {
    pub fn trips(&self) -> usize {
        self.trip_type.len()
    }

    pub fn stops(&self, trip: u32) -> std::ops::Range<usize> {
        self.trip_stops[trip as usize] as usize..self.trip_stops[trip as usize + 1] as usize
    }

    /// Whether the arrays are complete and agree with each other.
    pub fn consistent(&self, edge_count: usize) -> bool {
        let n = self.trip_type.len();
        let s = self.stop_edge.len();
        self.trip_route.len() == n
            && self.trip_stops.len() == n + 1
            && self.trip_stops.windows(2).all(|w| w[0] <= w[1])
            && self
                .trip_stops
                .last()
                .is_some_and(|&last| last as usize == s)
            && self.stop_frac.len() == s
            && self.stop_time.len() == s
            && self.stop_edge.iter().all(|&e| (e as usize) < edge_count)
    }
}

/// A vehicle's progress through its trip.
#[derive(Clone, Debug)]
pub struct TransitRun {
    pub trip: u32,
    /// Stops this run serves: (index into the timetable's stop arrays, route index of the
    /// stop's edge). Stops the network cannot reach are left out.
    pub stops: Vec<(u32, u32)>,
    /// Next stop to serve (index into `stops`).
    pub next: usize,
    /// Leave the stop at this time (while dwelling).
    pub dwell_until: f64,
    pub dwelling: bool,
    /// How late it left its last stop (s).
    pub late: f32,
}

impl TransitRun {
    /// (route index, lane fraction) of the next stop, if any.
    pub fn target(&self, data: &TransitData) -> Option<(u32, f32)> {
        let &(stop, route_idx) = self.stops.get(self.next)?;
        Some((route_idx, data.stop_frac[stop as usize]))
    }

    /// Timetable index of the next stop.
    pub fn next_stop(&self) -> Option<u32> {
        self.stops.get(self.next).map(|&(stop, _)| stop)
    }
}

/// A run that could not start yet (no room at its stop).
pub struct PendingRun {
    pub trip: u32,
    pub from_stop: u32,
    pub since: f64,
}

pub struct Transit {
    pub data: TransitData,
    /// Next trip to start; trips are sorted by first departure.
    pub next_trip: usize,
    /// Simulation time when the current service day began.
    pub day_start: f64,
    /// Routes between consecutive stops, by (from edge, to edge, vehicle class).
    pub legs: HashMap<(u32, u32, u16), Option<Vec<u32>>>,
    pub waiting: Vec<PendingRun>,
    /// Trips that could not be routed (part of their way missing from the network).
    pub failed: u64,
    pub started: u64,
    /// Stops skipped because the network cannot reach them.
    pub skipped_stops: u64,
    /// By vehicle type (`vtype`): runs started and runs that could not be routed, and
    /// departures from stops with how late they left (s, summed, and the latest).
    pub started_by: [u64; 5],
    pub failed_by: [u64; 5],
    pub departures: [u64; 5],
    pub late_sum: [f64; 5],
    pub late_max: [f64; 5],
}

impl Transit {
    pub fn new(data: TransitData) -> Transit {
        Transit {
            data,
            next_trip: 0,
            day_start: 0.0,
            legs: HashMap::new(),
            waiting: Vec::new(),
            failed: 0,
            started: 0,
            skipped_stops: 0,
            started_by: [0; 5],
            failed_by: [0; 5],
            departures: [0; 5],
            late_sum: [0.0; 5],
            late_max: [0.0; 5],
        }
    }

    /// First departure of a trip (s after the service day's midnight).
    pub fn start_time(&self, trip: usize) -> f64 {
        self.data.stop_time[self.data.trip_stops[trip] as usize] as f64
    }

    /// Last departure of a trip.
    pub fn end_time(&self, trip: usize) -> f64 {
        self.data.stop_time[self.data.trip_stops[trip + 1] as usize - 1] as f64
    }
}
