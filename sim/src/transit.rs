//! Scheduled trams and buses (ZET GTFS, placed on the network by pipeline/transit.py).
//!
//! Each trip starts at its first stop at the scheduled time, drives the fastest way for its
//! vehicle class from stop to stop, and at each stop waits for passengers and for its
//! scheduled departure. When the simulation starts mid-day, trips already under way start
//! from the stop they are scheduled to be at.
//!
//! Frequency edits (M9b) run a line more or less often: trips cancelled are not started, and
//! trips added are copies of the timetabled ones, appended to the arrays, so a trip's index
//! names the same trip for as long as the engine runs.

use std::collections::HashMap;

/// How many times as often edits may run a line (M9b): from not at all to three times.
pub const FREQUENCY_RANGE: (f32, f32) = (0.0, 3.0);
/// Trips are added only between trips this close (s): longer gaps are breaks in service.
pub const MAX_GAP: f32 = 7_200.0;

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
    /// The timetable, with the copies frequency edits added after its own trips.
    pub data: TransitData,
    /// Trips in the timetable as loaded.
    pub timetabled: usize,
    /// For each copy (trip `timetabled + k`): the timetabled trip it copies and how much
    /// later it runs (s).
    pub copy_of: Vec<(u32, f32)>,
    /// Copies made, by route and how many times as often (f32 bits): an edit set again
    /// runs the same ones.
    copies: HashMap<(u16, u32), Vec<u32>>,
    /// Trips that run, by first departure: the timetable's less those cancelled, and the
    /// copies in force.
    pub order: Vec<u32>,
    /// Next trip to start (index into `order`).
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
        let timetabled = data.trips();
        let mut tr = Transit {
            data,
            timetabled,
            copy_of: Vec::new(),
            copies: HashMap::new(),
            order: Vec::new(),
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
        };
        tr.order = (0..timetabled as u32).collect();
        tr.sort_order();
        tr
    }

    fn sort_order(&mut self) {
        let mut order = std::mem::take(&mut self.order);
        order.sort_by(|&a, &b| {
            self.start_time(a as usize)
                .total_cmp(&self.start_time(b as usize))
                .then(a.cmp(&b))
        });
        self.order = order;
    }

    /// Run each line in `edits` (route, how many times as often) more or less often than
    /// the timetable does, the rest as timetabled; the last edit of a route counts. Each of
    /// a line's stop patterns keeps its share: fewer trips keep an even spread of its trips;
    /// more add copies spread evenly between its trips, f - 1 to each gap between two (of
    /// at most `MAX_GAP`), so its first and last trips stay as they are. Trips due by `tod` (s since the service day's midnight) are not started
    /// again; vehicles on the road finish their trips.
    pub fn set_frequencies(&mut self, edits: &[(u16, f32)], tod: f64) {
        let mut factor: HashMap<u16, f32> = HashMap::new();
        for &(route, f) in edits {
            factor.insert(route, f);
        }
        let mut runs = vec![true; self.timetabled];
        let mut added = Vec::new();
        let mut routes: Vec<_> = factor.into_iter().collect();
        routes.sort_by_key(|&(r, _)| r);
        for (route, f) in routes {
            let patterns = self.patterns(route);
            if f < 1.0 {
                for trips in &patterns {
                    let n = trips.len();
                    let m = ((n as f32 * f).round() as usize).min(n);
                    // Keep one trip in each of m equal runs of the n.
                    for (k, &t) in trips.iter().enumerate() {
                        runs[t as usize] = (k + 1) * m / n > k * m / n;
                    }
                }
            } else if f > 1.0 {
                added.extend(self.copies_for(route, f, &patterns));
            }
        }
        self.order = (0..self.timetabled as u32)
            .filter(|&t| runs[t as usize])
            .chain(added)
            .collect();
        self.sort_order();
        self.next_trip = self
            .order
            .partition_point(|&t| self.start_time(t as usize) <= tod);
    }

    /// The timetabled trips of `route` by stop pattern (the roads of their stops, in
    /// order), each by first departure; patterns in the order their first trips come.
    fn patterns(&self, route: u16) -> Vec<Vec<u32>> {
        let d = &self.data;
        let mut index: HashMap<&[u32], usize> = HashMap::new();
        let mut patterns: Vec<Vec<u32>> = Vec::new();
        for t in 0..self.timetabled {
            if d.trip_route[t] != route {
                continue;
            }
            let stops = &d.stop_edge[d.stops(t as u32)];
            let k = *index.entry(stops).or_insert_with(|| {
                patterns.push(Vec::new());
                patterns.len() - 1
            });
            patterns[k].push(t as u32);
        }
        for trips in &mut patterns {
            trips.sort_by(|&a, &b| {
                self.start_time(a as usize)
                    .total_cmp(&self.start_time(b as usize))
                    .then(a.cmp(&b))
            });
        }
        patterns
    }

    /// The copies that run `route` `f` times as often (made once).
    fn copies_for(&mut self, route: u16, f: f32, patterns: &[Vec<u32>]) -> Vec<u32> {
        if let Some(made) = self.copies.get(&(route, f.to_bits())) {
            return made.clone();
        }
        let mut made = Vec::new();
        for trips in patterns {
            let gaps: Vec<(u32, f32)> = trips
                .windows(2)
                .filter_map(|w| {
                    let gap =
                        (self.start_time(w[1] as usize) - self.start_time(w[0] as usize)) as f32;
                    (gap > 0.0 && gap <= MAX_GAP).then_some((w[0], gap))
                })
                .collect();
            // `f` times as many trips between the first and last: f - 1 more in each gap.
            let g = gaps.len();
            let extra = (g as f32 * (f - 1.0)).round() as usize;
            for (k, &(trip, gap)) in gaps.iter().enumerate() {
                let c = (k + 1) * extra / g - k * extra / g;
                for j in 0..c {
                    let shift = gap * (j + 1) as f32 / (c + 1) as f32;
                    made.push(self.copy_trip(trip, shift));
                }
            }
        }
        self.copies.insert((route, f.to_bits()), made.clone());
        made
    }

    /// Append a copy of `trip` running `shift` seconds later; its index.
    fn copy_trip(&mut self, trip: u32, shift: f32) -> u32 {
        let d = &mut self.data;
        let t = trip as usize;
        let stops = d.stops(trip);
        d.trip_type.push(d.trip_type[t]);
        d.trip_route.push(d.trip_route[t]);
        d.stop_edge.extend_from_within(stops.clone());
        d.stop_frac.extend_from_within(stops.clone());
        let from = d.stop_time.len();
        d.stop_time.extend_from_within(stops);
        for time in &mut d.stop_time[from..] {
            *time += shift;
        }
        d.trip_stops.push(d.stop_edge.len() as u32);
        self.copy_of.push((trip, shift));
        (d.trips() - 1) as u32
    }

    /// For the app (M9b): the timetabled trips, the copies (each its trip and shift as f32
    /// bits), then the trips that run (`order`): `[timetabled, copies, running, (trip,
    /// shift) per copy, running trips]`.
    pub fn write_service(&self, out: &mut Vec<u32>) {
        out.clear();
        out.extend([
            self.timetabled as u32,
            self.copy_of.len() as u32,
            self.order.len() as u32,
        ]);
        for &(trip, shift) in &self.copy_of {
            out.extend([trip, shift.to_bits()]);
        }
        out.extend_from_slice(&self.order);
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
