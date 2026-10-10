//! Engine tests on small hand-built networks.

use crate::demand::{Demand, Gateway};
use crate::edits::Edit;
use crate::engine::{DT, Engine, LanePiece, Trip, stat, travel_time, trip};
use crate::idm;
use crate::network::{LINK_STATE_CHARS, NONE, Network, NetworkData, dir, edge_flag, vclass};
use crate::rng::Rng;
use crate::router::Router;
use crate::vtype::{self, TYPES};
use crate::weather::Weather;

const ALL: u16 = 0xffff;
const LANE_WIDTH: f32 = 3.2;

fn state(c: u8) -> u8 {
    LINK_STATE_CHARS.iter().position(|&s| s == c).unwrap() as u8
}

/// Builds a `NetworkData` the way the pipeline exports SUMO networks: lanes grouped by
/// edge (rightmost first), one internal lane per link, links sorted by from-lane.
/// A signal: controlled links, and phases (duration, min, max, state string).
type Signal = (Vec<u32>, Vec<(f32, f32, f32, String)>);

#[derive(Default)]
struct Builder {
    d: NetworkData,
    junctions: Vec<(f32, f32)>,
    junction_links: Vec<Vec<u32>>,
    logic: Vec<Vec<(u32, u32)>>,
    signals: Vec<Signal>,
}

impl Builder {
    fn junction(&mut self, x: f32, z: f32) -> u32 {
        self.d.junction_pos.extend([x, z]);
        self.junctions.push((x, z));
        self.junction_links.push(Vec::new());
        self.logic.push(Vec::new());
        self.junctions.len() as u32 - 1
    }

    fn add_lane(&mut self, edge: u32, pts: &[(f32, f32)], speed: f32, allow: u16) -> u32 {
        let d = &mut self.d;
        let lane = d.lane_edge.len() as u32;
        let mut length = 0.0;
        for w in pts.windows(2) {
            length += ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt();
        }
        d.lane_edge.push(edge);
        d.lane_length.push(length.max(0.1));
        d.lane_speed.push(speed);
        d.lane_width.push(LANE_WIDTH);
        d.lane_allow.push(allow);
        d.lane_next.push(NONE);
        if d.lane_shape_offsets.is_empty() {
            d.lane_shape_offsets.push(0);
        }
        for &(x, z) in pts {
            d.lane_shape.extend([x, z, 0.0]);
        }
        d.lane_shape_offsets.push((d.lane_shape.len() / 3) as u32);
        lane
    }

    fn add_edge(&mut self, from: u32, to: u32, flags: u8) -> u32 {
        let d = &mut self.d;
        let e = d.edge_flags.len() as u32;
        d.edge_flags.push(flags);
        d.edge_from.push(from);
        d.edge_to.push(to);
        d.edge_lane_start.push(d.lane_edge.len() as u32);
        d.edge_lane_count.push(0);
        e
    }

    /// Straight road between two junctions, stopping 6 m short of each centre.
    fn road(&mut self, a: u32, b: u32, lanes: u32, speed: f32) -> u32 {
        let (ax, az) = self.junctions[a as usize];
        let (bx, bz) = self.junctions[b as usize];
        let len = ((bx - ax).powi(2) + (bz - az).powi(2)).sqrt();
        let (ux, uz) = ((bx - ax) / len, (bz - az) / len);
        let (nx, nz) = (uz, -ux); // left of travel
        let e = self.add_edge(a, b, 0);
        for k in 0..lanes {
            // Right-hand traffic: lane 0 is the rightmost, keep the centre line at offset 0.
            let lat = -((lanes - k) as f32 - 0.5) * LANE_WIDTH;
            let start = (ax + ux * 6.0 + nx * lat, az + uz * 6.0 + nz * lat);
            let end = (bx - ux * 6.0 + nx * lat, bz - uz * 6.0 + nz * lat);
            self.add_lane(e, &[start, end], speed, ALL);
        }
        self.d.edge_lane_count[e as usize] = lanes as u8;
        e
    }

    fn lane(&self, edge: u32, index: u32) -> u32 {
        self.d.edge_lane_start[edge as usize] + index
    }

    /// Link from the end of one lane to the start of another through an internal lane.
    fn connect(&mut self, from: u32, to: u32, j: u32, direction: u8, link_state: u8) -> u32 {
        let fp = self.d.lane_shape_offsets[from as usize + 1] as usize - 1;
        let tp = self.d.lane_shape_offsets[to as usize] as usize;
        let p0 = (self.d.lane_shape[fp * 3], self.d.lane_shape[fp * 3 + 1]);
        let p1 = (self.d.lane_shape[tp * 3], self.d.lane_shape[tp * 3 + 1]);
        let e = self.add_edge(j, j, edge_flag::INTERNAL);
        let speed = if direction == dir::STRAIGHT {
            13.9
        } else {
            7.0
        };
        let via = self.add_lane(e, &[p0, p1], speed, ALL);
        self.d.edge_lane_count[e as usize] = 1;
        self.d.lane_next[via as usize] = to;
        let d = &mut self.d;
        let link = d.link_from.len() as u32;
        d.link_from.push(from);
        d.link_to.push(to);
        d.link_via.push(via);
        d.link_junction.push(j);
        d.link_request
            .push(self.junction_links[j as usize].len() as u16);
        d.link_dir.push(direction);
        d.link_state.push(state(link_state));
        d.link_tls.push(NONE);
        d.link_tls_index.push(u16::MAX);
        self.junction_links[j as usize].push(link);
        link
    }

    /// Right-of-way rows of a junction: per request index, (response, foes) bit masks.
    fn set_logic(&mut self, j: u32, rows: &[(u32, u32)]) {
        self.logic[j as usize] = rows.to_vec();
    }

    /// Fixed-time signal over `links`; phases are (duration, state string).
    fn signal(&mut self, links: &[u32], phases: &[(f32, &str)]) {
        let phases = phases
            .iter()
            .map(|&(t, s)| (t, t, t, s.to_string()))
            .collect();
        self.signals.push((links.to_vec(), phases));
    }

    fn build(self) -> Network {
        Network::build(self.data()).expect("consistent test network")
    }

    /// The arrays as the pipeline exports them.
    fn data(mut self) -> NetworkData {
        let d = &mut self.d;
        // Links sorted by from-lane, as the pipeline writes them.
        let n = d.link_from.len();
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by_key(|&l| d.link_from[l]);
        let mut new_id = vec![0u32; n];
        for (new, &old) in order.iter().enumerate() {
            new_id[old] = new as u32;
        }
        macro_rules! permute {
            ($($f:ident),*) => { $( d.$f = order.iter().map(|&l| d.$f[l]).collect(); )* };
        }
        permute!(
            link_from,
            link_to,
            link_via,
            link_junction,
            link_request,
            link_dir,
            link_state,
            link_tls,
            link_tls_index
        );
        d.lane_link_offsets = vec![0; d.lane_edge.len() + 1];
        for &f in &d.link_from {
            d.lane_link_offsets[f as usize + 1] += 1;
        }
        for i in 0..d.lane_edge.len() {
            d.lane_link_offsets[i + 1] += d.lane_link_offsets[i];
        }
        for (j, links) in self.junction_links.iter().enumerate() {
            let count = links.len();
            d.junction_link_count.push(count as u16);
            d.junction_logic_offset.push(d.logic.len() as u32);
            for k in 0..count {
                let (response, foes) = self.logic[j].get(k).copied().unwrap_or((0, 0));
                d.logic.extend([response, foes]);
            }
        }
        d.tls_phase_offsets.push(0);
        d.phase_state_offsets.push(0);
        for (t, (links, phases)) in self.signals.iter().enumerate() {
            for (i, &l) in links.iter().enumerate() {
                let l = new_id[l as usize] as usize;
                d.link_tls[l] = t as u32;
                d.link_tls_index[l] = i as u16;
            }
            d.tls_offset.push(0.0);
            for (duration, min, max, s) in phases {
                d.phase_duration.push(*duration);
                d.phase_min_dur.push(*min);
                d.phase_max_dur.push(*max);
                d.phase_states.extend(s.bytes());
                d.phase_state_offsets.push(d.phase_states.len() as u32);
            }
            d.tls_phase_offsets.push(d.phase_duration.len() as u32);
        }
        self.d
    }
}

/// West-east road J0 -> J1 -> J2 with `lanes` lanes, 13.9 m/s, through priority junction J1.
fn straight_road(length: f32, lanes: u32) -> (Builder, u32, u32) {
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(length, 0.0);
    let j2 = b.junction(2.0 * length, 0.0);
    let e0 = b.road(j0, j1, lanes, 13.9);
    let e1 = b.road(j1, j2, lanes, 13.9);
    for k in 0..lanes {
        let (from, to) = (b.lane(e0, k), b.lane(e1, k));
        b.connect(from, to, j1, dir::STRAIGHT, b'M');
    }
    (b, e0, e1)
}

fn run_until(engine: &mut Engine, seconds: f32, mut check: impl FnMut(&Engine)) {
    let steps = (seconds / DT) as usize;
    for _ in 0..steps {
        engine.step();
        check(engine);
    }
}

/// Bumper-to-bumper gaps between consecutive vehicles on every lane must stay positive (bikes
/// and other traffic apart: drivers pass cyclists at the road's edge).
fn assert_no_overlaps(engine: &Engine) {
    for lane in 0..engine.net.lane_count() as u32 {
        // Each lane's list stays in order of position, cars that passed bikes included.
        let all = engine.vehicles_on(lane);
        assert!(
            all.windows(2)
                .all(|w| engine.vehs[w[0] as usize].pos <= engine.vehs[w[1] as usize].pos),
            "lane {lane} out of order at t={}",
            engine.time
        );
        for bikes in [false, true] {
            let list: Vec<u32> = engine
                .vehicles_on(lane)
                .iter()
                .copied()
                .filter(|&v| (engine.vehs[v as usize].vtype == vtype::BIKE) == bikes)
                .collect();
            assert_lane_gaps(engine, lane, &list);
        }
    }
}

fn assert_lane_gaps(engine: &Engine, lane: u32, list: &[u32]) {
    for w in list.windows(2) {
        let (f, l) = (&engine.vehs[w[0] as usize], &engine.vehs[w[1] as usize]);
        let gap = l.pos - TYPES[l.vtype as usize].length - f.pos;
        assert!(
            gap > -0.01,
            "vehicles overlap on lane {lane}: gap {gap} at t={}",
            engine.time
        );
    }
}

#[test]
fn idm_accelerates_on_free_road_and_brakes_for_obstacles() {
    let p = &TYPES[vtype::CAR as usize];
    assert!(idm::acceleration(0.0, 13.9, f32::INFINITY, 0.0, p, Weather::CLEAR) > 1.5);
    assert!(idm::acceleration(13.9, 13.9, f32::INFINITY, 0.0, p, Weather::CLEAR).abs() < 0.01);
    assert!(idm::acceleration(13.9, 13.9, 20.0, 0.0, p, Weather::CLEAR) < -2.0);
    // Standing still behind a standing car at the minimum gap: stay put.
    assert!(idm::acceleration(0.0, 13.9, p.min_gap, 0.0, p, Weather::CLEAR) <= 0.0);
}

#[test]
fn travel_time_accounts_for_acceleration() {
    // From standstill at 2 m/s² to 10 m/s: 25 m in 5 s, then 75 m at 10 m/s.
    assert!((travel_time(100.0, 0.0, 2.0, 10.0) - 12.5).abs() < 1e-4);
    assert!((travel_time(9.0, 0.0, 2.0, 10.0) - 3.0).abs() < 1e-4);
    assert_eq!(travel_time(0.0, 5.0, 2.0, 10.0), 0.0);
}

#[test]
fn single_car_drives_and_arrives() {
    let (b, e0, e1) = straight_road(500.0, 1);
    let mut engine = Engine::new(b.build(), 1);
    engine.add_trip(Trip {
        depart: 0.0,
        from: e0,
        to: e1,
        vtype: vtype::CAR,
        flags: 0,
    });
    let mut top = 0.0f32;
    run_until(&mut engine, 150.0, |e| {
        for v in &e.vehs {
            if v.alive() {
                top = top.max(v.speed);
            }
        }
    });
    let s = &engine.stats;
    assert_eq!((s.departed, s.arrived, s.teleported), (1, 1, 0));
    assert!(top > 12.0 && top < 13.9 * 1.31, "top speed {top}");
}

#[test]
fn queue_of_cars_never_collides_and_all_arrive() {
    let (b, e0, e1) = straight_road(800.0, 1);
    let mut engine = Engine::new(b.build(), 7);
    for k in 0..40 {
        engine.add_trip(Trip {
            depart: k as f64 * 2.0,
            from: e0,
            to: e1,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    run_until(&mut engine, 600.0, assert_no_overlaps);
    let s = &engine.stats;
    assert_eq!(s.departed + s.insert_failed, 40);
    assert!(s.departed >= 30, "departed {}", s.departed);
    assert_eq!(s.arrived, s.departed);
    assert_eq!(s.teleported, 0);
}

#[test]
fn red_light_holds_traffic_until_green() {
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(1000.0, 0.0);
    let j2 = b.junction(1500.0, 0.0);
    let e0 = b.road(j0, j1, 1, 13.9);
    let e1 = b.road(j1, j2, 1, 13.9);
    let (l0, l1) = (b.lane(e0, 0), b.lane(e1, 0));
    let link = b.connect(l0, l1, j1, dir::STRAIGHT, b'O');
    b.signal(&[link], &[(200.0, "r"), (100.0, "G")]);
    let net = b.build();
    let stop_line = net.d.lane_length[l0 as usize];
    let mut engine = Engine::new(net, 3);
    for k in 0..5 {
        engine.add_trip(Trip {
            depart: k as f64 * 3.0,
            from: e0,
            to: e1,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    run_until(&mut engine, 199.0, |e| {
        for &v in e.vehicles_on(l0) {
            assert!(e.vehs[v as usize].pos <= stop_line + 1e-3);
        }
        assert!(
            e.vehicles_on(l1).is_empty(),
            "a car ran the red light at t={}",
            e.time
        );
    });
    let first = *engine.vehicles_on(l0).last().unwrap();
    let front = &engine.vehs[first as usize];
    assert!(
        front.speed < 0.1 && stop_line - front.pos < 3.0,
        "first car waits at the line"
    );
    run_until(&mut engine, 150.0, assert_no_overlaps);
    assert_eq!(engine.stats.arrived, engine.stats.departed);
    assert_eq!(engine.stats.teleported, 0);
}

/// T-junction: main road west-east through J1, minor road from the south turning right
/// onto the main road east of J1 (both links end on the same lane).
fn t_junction() -> (Builder, [u32; 4]) {
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(500.0, 0.0);
    let j2 = b.junction(1000.0, 0.0);
    let j3 = b.junction(500.0, 500.0); // south of J1 (z points south)
    let main_in = b.road(j0, j1, 1, 13.9);
    let main_out = b.road(j1, j2, 1, 13.9);
    let minor_in = b.road(j3, j1, 1, 13.9);
    let (a, c, m) = (b.lane(main_in, 0), b.lane(main_out, 0), b.lane(minor_in, 0));
    b.connect(a, c, j1, dir::STRAIGHT, b'M'); // request 0
    b.connect(m, c, j1, dir::RIGHT, b'm'); // request 1 yields to 0
    b.set_logic(j1, &[(0b00, 0b10), (0b01, 0b01)]);
    (b, [main_in, main_out, minor_in, j1])
}

#[test]
fn minor_road_yields_to_priority_traffic() {
    let (b, [main_in, main_out, minor_in, _]) = t_junction();
    let net = b.build();
    let main_lane = net.edge_lanes(main_in).start;
    let minor_lane = net.edge_lanes(minor_in).start;
    let main_len = net.d.lane_length[main_lane as usize];
    let minor_len = net.d.lane_length[minor_lane as usize];
    let mut engine = Engine::new(net, 5);
    // The main-road car is ~3 s from the junction; the minor-road car waits at its line.
    let main = engine.insert_at(
        vtype::CAR,
        vec![main_in, main_out],
        main_lane,
        main_len - 40.0,
        13.9,
    );
    let minor = engine.insert_at(
        vtype::CAR,
        vec![minor_in, main_out],
        minor_lane,
        minor_len - 3.0,
        0.0,
    );
    let (main_serial, minor_serial) = (
        engine.vehs[main as usize].serial,
        engine.vehs[minor as usize].serial,
    );
    let mut entered: [Option<f64>; 2] = [None, None];
    run_until(&mut engine, 120.0, |e| {
        for (k, (v, serial)) in [(main, main_serial), (minor, minor_serial)]
            .into_iter()
            .enumerate()
        {
            let veh = &e.vehs[v as usize];
            if entered[k].is_none()
                && veh.serial == serial
                && e.net.lane_internal[veh.lane as usize]
            {
                entered[k] = Some(e.time);
            }
        }
        assert_no_overlaps(e);
    });
    let (t_main, t_minor) = (
        entered[0].expect("main car crossed"),
        entered[1].expect("minor car crossed"),
    );
    assert!(
        t_minor > t_main + 1.0,
        "minor entered at {t_minor}, main at {t_main}"
    );
    assert!(
        t_minor < t_main + 15.0,
        "minor car waited too long ({t_minor} vs {t_main})"
    );
    assert_eq!(engine.stats.arrived, 2);
}

#[test]
fn minor_road_goes_when_main_road_is_empty() {
    let (b, [_, main_out, minor_in, _]) = t_junction();
    let net = b.build();
    let minor_lane = net.edge_lanes(minor_in).start;
    let minor_len = net.d.lane_length[minor_lane as usize];
    let mut engine = Engine::new(net, 5);
    let minor = engine.insert_at(
        vtype::CAR,
        vec![minor_in, main_out],
        minor_lane,
        minor_len - 3.0,
        0.0,
    );
    let serial = engine.vehs[minor as usize].serial;
    let mut crossed_at = None;
    run_until(&mut engine, 20.0, |e| {
        let veh = &e.vehs[minor as usize];
        if crossed_at.is_none() && veh.serial == serial && e.net.lane_internal[veh.lane as usize] {
            crossed_at = Some(e.time);
        }
    });
    assert!(crossed_at.expect("crossed") < 5.0);
}

#[test]
fn car_changes_lanes_to_make_its_turn() {
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(400.0, 0.0);
    let j2 = b.junction(800.0, 0.0);
    let j3 = b.junction(400.0, -400.0); // north
    let e0 = b.road(j0, j1, 2, 13.9);
    let straight = b.road(j1, j2, 1, 13.9);
    let left = b.road(j1, j3, 1, 13.9);
    let (r, l) = (b.lane(e0, 0), b.lane(e0, 1));
    let (s0, l0) = (b.lane(straight, 0), b.lane(left, 0));
    b.connect(r, s0, j1, dir::STRAIGHT, b'M');
    b.connect(l, l0, j1, dir::LEFT, b'M');
    let net = b.build();
    let mut engine = Engine::new(net, 11);
    let v = engine.insert_at(vtype::CAR, vec![e0, left], r, 20.0, 10.0);
    let serial = engine.vehs[v as usize].serial;
    let mut on_left_road = false;
    run_until(&mut engine, 120.0, |e| {
        let veh = &e.vehs[v as usize];
        if veh.serial == serial && veh.lane == l0 {
            on_left_road = true;
        }
    });
    assert!(on_left_road);
    assert_eq!((engine.stats.arrived, engine.stats.teleported), (1, 0));
}

#[test]
fn router_prefers_the_faster_route() {
    // From A to D: via B is shorter but slow, via C longer but fast. Then out of D.
    let mut b = Builder::default();
    let a = b.junction(0.0, 0.0);
    let bj = b.junction(500.0, 300.0);
    let c = b.junction(500.0, -600.0);
    let dj = b.junction(1000.0, 0.0);
    let ej = b.junction(1500.0, 0.0);
    let start = b.road(ej, a, 1, 13.9);
    let ab = b.road(a, bj, 1, 5.0);
    let bd = b.road(bj, dj, 1, 5.0);
    let ac = b.road(a, c, 1, 25.0);
    let cd = b.road(c, dj, 1, 25.0);
    let exit = b.road(dj, ej, 1, 13.9);
    for (from, to, j) in [
        (start, ab, a),
        (start, ac, a),
        (ab, bd, bj),
        (ac, cd, c),
        (bd, exit, dj),
        (cd, exit, dj),
    ] {
        let (fl, tl) = (b.lane(from, 0), b.lane(to, 0));
        b.connect(fl, tl, j, dir::STRAIGHT, b'M');
    }
    let net = b.build();
    let tt: Vec<f32> = (0..net.edge_count())
        .map(|e| net.edge_length[e] / net.edge_speed[e])
        .collect();
    let mut router = Router::new(net.edge_count());
    let car = crate::network::vclass::PASSENGER;
    assert_eq!(
        router.route(&net, &tt, start, exit, car),
        Some(vec![start, ac, cd, exit])
    );
    // Slow the fast road down (as congestion would) and the route switches.
    let mut jammed = tt.clone();
    jammed[ac as usize] *= 10.0;
    assert_eq!(
        router.route(&net, &jammed, start, exit, car),
        Some(vec![start, ab, bd, exit])
    );
    // Unreachable: nothing leads on from `exit`.
    assert_eq!(router.route(&net, &tt, exit, start, car), None);
    // A class the roads do not allow.
    assert_eq!(router.route(&net, &tt, start, exit, 0), None);
}

#[test]
fn same_seed_gives_the_same_run() {
    let run = || {
        let (b, e0, e1) = straight_road(600.0, 2);
        let mut engine = Engine::new(b.build(), 42);
        for k in 0..30 {
            engine.add_trip(Trip {
                depart: k as f64 * 1.5,
                from: e0,
                to: e1,
                vtype: (k % 2) as u8,
                flags: 0,
            });
        }
        run_until(&mut engine, 90.0, |_| {});
        let poses: Vec<(u32, u32, u32)> = engine
            .vehs
            .iter()
            .map(|v| (v.serial, v.lane, v.pos.to_bits()))
            .collect();
        (engine.stats_array()[stat::ARRIVED], poses)
    };
    assert_eq!(run(), run());
}

#[test]
fn render_buffer_places_vehicles_on_their_lane() {
    let (b, e0, e1) = straight_road(500.0, 1);
    let net = b.build();
    let lane = net.edge_lanes(e0).start;
    let mut engine = Engine::new(net, 1);
    let v = engine.insert_at(vtype::CAR, vec![e0, e1], lane, 100.0, 0.0);
    engine.write_render();
    let o = v as usize * crate::engine::RENDER_STRIDE;
    let x = f32::from_bits(engine.render[o]);
    let z = f32::from_bits(engine.render[o + 2]);
    let heading = f32::from_bits(engine.render[o + 3]);
    // The lane starts 6 m east of J0, 1.6 m south of the centre line; the car's centre is
    // half a car length behind its front bumper; heading east is +90°.
    assert!((x - (6.0 + 100.0 - 2.25)).abs() < 0.01, "x {x}");
    assert!((z - 1.6).abs() < 0.01, "z {z}");
    assert!(
        (heading - std::f32::consts::FRAC_PI_2).abs() < 1e-3,
        "heading {heading}"
    );
    assert_eq!(engine.render[o + 5], engine.vehs[v as usize].serial);
}

#[test]
fn bus_keeps_its_timetable() {
    use crate::transit::{Transit, TransitData};
    let (b, e0, e1) = straight_road(500.0, 1);
    let net = b.build();
    let lane0 = net.edge_lanes(e0).start;
    let len0 = net.d.lane_length[lane0 as usize];
    let mut engine = Engine::new(net, 3);
    // Stops at 20 % and 80 % of the first road and half way along the second; the bus is
    // due at the middle stop only at 100 s, long after it can get there.
    engine.transit = Some(Transit::new(TransitData {
        trip_type: vec![vtype::BUS],
        trip_route: vec![0],
        trip_stops: vec![0, 3],
        stop_edge: vec![e0, e0, e1],
        stop_frac: vec![0.2, 0.8, 0.5],
        stop_time: vec![10.0, 100.0, 140.0],
    }));
    engine.set_time(0.0);
    let middle = 0.8 * len0;
    let mut left_middle_at = None;
    let mut waited_at_middle = false;
    run_until(&mut engine, 300.0, |e| {
        for v in e.vehs.iter().filter(|v| v.alive() && v.vtype == vtype::BUS) {
            if v.lane == lane0 && (v.pos - middle).abs() < 2.5 && v.speed < 0.3 {
                waited_at_middle = true;
            }
            if left_middle_at.is_none()
                && (v.lane != lane0 || v.pos > middle + 3.0)
                && waited_at_middle
            {
                left_middle_at = Some(e.time);
            }
        }
    });
    assert!(waited_at_middle, "the bus stopped at the middle stop");
    let left = left_middle_at.expect("the bus went on");
    assert!(
        left >= 100.0,
        "left the middle stop at {left}, before its scheduled 100 s"
    );
    assert!(
        left < 120.0,
        "left the middle stop at {left}, long after 100 s"
    );
    let tr = engine.transit.as_ref().unwrap();
    assert_eq!((tr.started, tr.failed), (1, 0));
    assert_eq!(engine.stats.arrived, 1);
}

#[test]
fn trips_under_way_start_from_their_current_stop() {
    use crate::transit::{Transit, TransitData};
    let (b, e0, e1) = straight_road(500.0, 1);
    let net = b.build();
    let lane1 = net.edge_lanes(e1).start;
    let mut engine = Engine::new(net, 3);
    engine.transit = Some(Transit::new(TransitData {
        trip_type: vec![vtype::TRAM],
        trip_route: vec![0],
        trip_stops: vec![0, 3],
        stop_edge: vec![e0, e1, e1],
        stop_frac: vec![0.2, 0.3, 0.9],
        stop_time: vec![3600.0, 3700.0, 3800.0],
    }));
    // Joining at 3720 s: the tram has left its second stop, on the second road.
    engine.set_time(3720.0);
    engine.step();
    let tram = engine
        .vehs
        .iter()
        .find(|v| v.alive())
        .expect("the tram is on the road");
    assert_eq!((tram.vtype, tram.lane), (vtype::TRAM, lane1));
}

#[test]
fn traffic_from_beyond_the_map_drives_in_at_speed_and_off_the_far_end() {
    let (b, e0, e1) = straight_road(500.0, 1);
    let mut engine = Engine::new(b.build(), 5);
    engine.add_trip(Trip {
        depart: 0.0,
        from: e0,
        to: e1,
        vtype: vtype::CAR,
        flags: trip::ENTER | trip::EXIT,
    });
    engine.step();
    let v = engine.vehs.iter().find(|v| v.alive()).expect("inserted");
    assert!(
        v.pos < 10.0,
        "enters at the start of the road, not at {}",
        v.pos
    );
    assert!(v.speed > 10.0, "enters at speed, not {}", v.speed);
    assert_eq!(engine.edge_entered[e0 as usize], 1);
    let last_lane = engine.net.edge_lanes(e1).start;
    let mut furthest = 0.0f32;
    run_until(&mut engine, 120.0, |e| {
        for v in e.vehs.iter().filter(|v| v.alive() && v.lane == last_lane) {
            furthest = furthest.max(v.pos);
        }
    });
    assert_eq!(engine.stats.arrived, 1);
    assert_eq!(engine.edge_entered[e1 as usize], 1);
    let end = engine.net.d.lane_length[last_lane as usize];
    assert!(furthest > end - 15.0, "left at {furthest} of {end} m");
}

#[test]
fn gateway_traffic_matches_daily_counts_and_commuter_peaks() {
    // Two two-way roads leaving the map 30 km apart.
    let mut b = Builder::default();
    let j = [
        b.junction(0.0, 0.0),
        b.junction(15_000.0, 0.0),
        b.junction(30_000.0, 0.0),
    ];
    let (west_in, west_out) = (b.road(j[0], j[1], 1, 25.0), b.road(j[1], j[0], 1, 25.0));
    let (east_in, east_out) = (b.road(j[2], j[1], 1, 25.0), b.road(j[1], j[2], 1, 25.0));
    let net = b.build();
    let mut demand = Demand::new(&net, vec![west_out, east_out], &[1.0; 2], &[1.0; 2], 0.0);
    demand.set_gateways(
        &net,
        &[
            Gateway {
                entry: west_in,
                exit: west_out,
                daily: 10_000.0,
                through: 0.2,
            },
            Gateway {
                entry: east_in,
                exit: east_out,
                daily: 6_000.0,
                through: 0.2,
            },
            // Unknown edges: ignored.
            Gateway {
                entry: 99,
                exit: NONE,
                daily: 5_000.0,
                through: 0.0,
            },
        ],
    );
    let (inbound, outbound, through) = demand.gateway_trips();
    assert!((inbound - 6_400.0).abs() < 0.1 && (outbound - 6_400.0).abs() < 0.1);
    assert!((through - 1_600.0).abs() < 0.1);

    let mut rng = Rng::new(3);
    // Trips into, out of and through the map: all day, 6-10 h, 14-19 h.
    let mut day = [0u32; 3];
    let mut morning = [0u32; 3];
    let mut afternoon = [0u32; 3];
    let mut t = 0.0;
    while t < 86_400.0 {
        let hour = t / 3600.0;
        demand.generate(t, 0.5, 1.0, &mut rng, &mut |trip| {
            let kind = match trip.flags {
                trip::ENTER => 0,
                trip::EXIT => 1,
                _ => 2,
            };
            if kind == 2 {
                // Through traffic leaves by the other road.
                assert!(
                    (trip.from, trip.to) == (west_in, east_out)
                        || (trip.from, trip.to) == (east_in, west_out)
                );
            }
            day[kind] += 1;
            if (6.0..10.0).contains(&hour) {
                morning[kind] += 1;
            }
            if (14.0..19.0).contains(&hour) {
                afternoon[kind] += 1;
            }
        });
        t += 0.5;
    }
    for (count, expected) in day.iter().zip([6_400.0, 6_400.0, 1_600.0]) {
        assert!((*count as f64 - expected).abs() < 2.0, "{day:?}");
    }
    // Commuters come in in the morning and leave in the afternoon.
    assert!(morning[0] as f32 > 1.5 * morning[1] as f32, "{morning:?}");
    assert!(
        afternoon[1] as f32 > 1.3 * afternoon[0] as f32,
        "{afternoon:?}"
    );
}

#[test]
fn closed_roads_are_avoided_where_there_is_another_way() {
    // Two ways from A to B: straight (1 km), or a 1.4 km detour through C.
    let mut b = Builder::default();
    let a = b.junction(0.0, 0.0);
    let m = b.junction(1000.0, 0.0);
    let c = b.junction(500.0, 500.0);
    let z = b.junction(1500.0, 0.0);
    let direct = b.road(a, m, 1, 13.9);
    let up = b.road(a, c, 1, 13.9);
    let down = b.road(c, m, 1, 13.9);
    let last = b.road(m, z, 1, 13.9);
    let (l_direct, l_up, l_down, l_last) = (
        b.lane(direct, 0),
        b.lane(up, 0),
        b.lane(down, 0),
        b.lane(last, 0),
    );
    b.connect(l_up, l_down, c, dir::STRAIGHT, b'M');
    b.connect(l_direct, l_last, m, dir::STRAIGHT, b'M');
    b.connect(l_down, l_last, m, dir::STRAIGHT, b'M');
    let mut engine = Engine::new(b.build(), 9);
    let route = |e: &mut Engine, from: u32| {
        let mut router = Router::new(e.net.edge_count());
        router
            .route(&e.net, &e.travel_time, from, last, vtype::TYPES[0].vclass)
            .unwrap()
    };
    // From the start of the network: the direct road, unless it is closed.
    let start = direct;
    assert_eq!(route(&mut engine, start), vec![direct, last]);
    engine.set_closed(&[up]);
    assert_eq!(route(&mut engine, up), vec![up, down, last]);
    engine.set_closed(&[direct]);
    assert_eq!(engine.closed(), &[direct]);
    // The closed road is still the only way from its own start.
    assert_eq!(route(&mut engine, direct), vec![direct, last]);
    engine.set_closed(&[]);
    assert!(engine.closed().is_empty());
}

#[test]
fn guessed_signal_programs_give_green_by_the_lanes_served() {
    // A three-lane main road and a one-lane side road into one junction, with equal greens.
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(300.0, 0.0);
    let j2 = b.junction(600.0, 0.0);
    let js = b.junction(300.0, -300.0);
    let main_in = b.road(j0, j1, 3, 13.9);
    let main_out = b.road(j1, j2, 3, 13.9);
    let side_in = b.road(js, j1, 1, 13.9);
    let mut links: Vec<u32> = (0..3)
        .map(|k| {
            let (from, to) = (b.lane(main_in, k), b.lane(main_out, k));
            b.connect(from, to, j1, dir::STRAIGHT, b'O')
        })
        .collect();
    let (from, to) = (b.lane(side_in, 0), b.lane(main_out, 0));
    links.push(b.connect(from, to, j1, dir::RIGHT, b'O'));
    b.signal(
        &links,
        &[(30.0, "GGGr"), (3.0, "yyyr"), (30.0, "rrrG"), (3.0, "rrry")],
    );
    let engine = Engine::new(b.build(), 1);
    let d = &engine.net.d;
    // 60 s of green: 6 s each, the other 48 s by lanes (3 to 1); yellow unchanged.
    let durations: Vec<f32> = (0..4).map(|p| d.phase_duration[p]).collect();
    assert_eq!(durations, vec![42.0, 3.0, 18.0, 3.0]);
}

/// 30 cars queue at a red light on one lane, then get green: the times they cross the stop
/// line (s after green), in `weather`.
fn queue_discharge(weather: Weather) -> Vec<f64> {
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(1000.0, 0.0);
    let j2 = b.junction(1500.0, 0.0);
    let e0 = b.road(j0, j1, 1, 13.9);
    let e1 = b.road(j1, j2, 1, 13.9);
    let (l0, l1) = (b.lane(e0, 0), b.lane(e1, 0));
    let link = b.connect(l0, l1, j1, dir::STRAIGHT, b'O');
    b.signal(&[link], &[(200.0, "r"), (200.0, "G")]);
    let mut engine = Engine::new(b.build(), 5);
    engine.weather = weather;
    for k in 0..30 {
        engine.add_trip(Trip {
            depart: k as f64 * 3.0,
            from: e0,
            to: e1,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    run_until(&mut engine, 200.0, |_| {});
    assert_eq!(engine.vehicles_on(l0).len(), 30);
    let mut crossed = Vec::new();
    run_until(&mut engine, 150.0, |e| {
        while crossed.len() < 30 - e.vehicles_on(l0).len() {
            crossed.push(e.time - 200.0);
        }
    });
    assert_eq!(crossed.len(), 30);
    crossed
}

/// Saturation flow (cars per hour) from the fifth car on, once the queue is moving.
fn saturation_flow(crossed: &[f64]) -> f64 {
    20.0 * 3600.0 / (crossed[24] - crossed[4])
}

#[test]
fn a_queue_leaves_a_green_light_at_a_realistic_saturation_flow() {
    let crossed = queue_discharge(Weather::CLEAR);
    // The Highway Capacity Manual's base is 1,900 cars per lane per hour.
    let flow = saturation_flow(&crossed);
    assert!(
        (1_700.0..=2_100.0).contains(&flow),
        "saturation flow {flow:.0} per hour"
    );
    // The first car gets going within a few seconds of green.
    assert!(crossed[0] < 4.0, "first car crossed at {}", crossed[0]);
}

#[test]
fn rain_and_snow_slow_the_queue_at_a_green_light_and_free_flow() {
    let clear = saturation_flow(&queue_discharge(Weather::CLEAR));
    let share = |w: Weather| saturation_flow(&queue_discharge(w)) / clear;
    // Lower saturation flow, as observed at signals (2-21 %) and in the HCM's capacity
    // factors: rain about 8 %, heavy rain about 14 %, snow about 10 %, heavy snow 25-30 %.
    let rain = share(Weather::RAIN);
    let heavy_rain = share(Weather::HEAVY_RAIN);
    let snow = share(Weather::SNOW);
    let heavy_snow = share(Weather::HEAVY_SNOW);
    let fog = share(Weather::FOG);
    for (name, s, lo, hi) in [
        ("rain", rain, 0.88, 0.96),
        ("heavy rain", heavy_rain, 0.8, 0.9),
        ("snow", snow, 0.84, 0.94),
        ("heavy snow", heavy_snow, 0.65, 0.8),
        ("fog", fog, 0.85, 0.95),
    ] {
        assert!(
            (lo..=hi).contains(&s),
            "{name}: {:.1} % of clear",
            s * 100.0
        );
    }
    assert!(heavy_rain < rain && heavy_snow < snow);

    // Free flow: a lone car on an open road settles at a lower speed.
    let cruise = |w: Weather| {
        let (b, e0, e1) = straight_road(2000.0, 1);
        let mut engine = Engine::new(b.build(), 3);
        engine.weather = w;
        engine.add_trip(Trip {
            depart: 0.0,
            from: e0,
            to: e1,
            vtype: vtype::CAR,
            flags: 0,
        });
        run_until(&mut engine, 120.0, |_| {});
        engine
            .live_vehicles()
            .map(|v| engine.vehs[v as usize].speed)
            .sum::<f32>()
    };
    let free = cruise(Weather::CLEAR);
    assert!(free > 12.0, "clear: {free} m/s");
    assert!((cruise(Weather::RAIN) / free - 0.95).abs() < 0.02);
    assert!((cruise(Weather::HEAVY_SNOW) / free - 0.65).abs() < 0.03);
}

/// Crossroads with two-lane east-west approaches (straight, left) and one-lane north-south
/// ones (straight), under a signal program of the given phases.
fn signalled_crossroads(phases: &[(f32, &str)]) -> Engine {
    Engine::new(
        Network::build(signalled_crossroads_data(phases)).unwrap(),
        1,
    )
}

fn signalled_crossroads_data(phases: &[(f32, &str)]) -> NetworkData {
    let mut b = Builder::default();
    let jw = b.junction(0.0, 0.0);
    let j = b.junction(300.0, 0.0);
    let je = b.junction(600.0, 0.0);
    let jn = b.junction(300.0, -300.0);
    let js = b.junction(300.0, 300.0);
    let eb_in = b.road(jw, j, 2, 13.9);
    let eb_out = b.road(j, je, 1, 13.9);
    let wb_in = b.road(je, j, 2, 13.9);
    let wb_out = b.road(j, jw, 1, 13.9);
    let nb_in = b.road(js, j, 1, 13.9);
    let nb_out = b.road(j, jn, 1, 13.9);
    let sb_in = b.road(jn, j, 1, 13.9);
    let sb_out = b.road(j, js, 1, 13.9);
    let mut links = Vec::new();
    for (from, to, direction) in [
        (b.lane(eb_in, 0), b.lane(eb_out, 0), dir::STRAIGHT),
        (b.lane(eb_in, 1), b.lane(nb_out, 0), dir::LEFT),
        (b.lane(wb_in, 0), b.lane(wb_out, 0), dir::STRAIGHT),
        (b.lane(wb_in, 1), b.lane(sb_out, 0), dir::LEFT),
        (b.lane(nb_in, 0), b.lane(nb_out, 0), dir::STRAIGHT),
        (b.lane(sb_in, 0), b.lane(sb_out, 0), dir::STRAIGHT),
    ] {
        links.push(b.connect(from, to, j, direction, b'O'));
    }
    // (response, foes) per request: left turns give way to oncoming straight traffic; the
    // north-south road crosses the east-west one.
    b.set_logic(
        j,
        &[
            (0, 0b111000),
            (0b000100, 0b110100),
            (0, 0b110010),
            (0b000001, 0b110001),
            (0, 0b001111),
            (0, 0b001111),
        ],
    );
    b.signal(&links, phases);
    b.data()
}

fn program(engine: &Engine) -> Vec<(String, f32)> {
    let d = &engine.net.d;
    (0..d.phase_duration.len())
        .map(|p| {
            let (a, b) = (
                d.phase_state_offsets[p] as usize,
                d.phase_state_offsets[p + 1] as usize,
            );
            let states = String::from_utf8(d.phase_states[a..b].to_vec()).unwrap();
            (states, d.phase_duration[p])
        })
        .collect()
}

#[test]
fn split_signal_phases_of_opposite_approaches_go_together() {
    // Eastbound, westbound and the north-south road each on their own.
    let engine = signalled_crossroads(&[
        (20.0, "GGrrrr"),
        (3.0, "yyrrrr"),
        (20.0, "rrGGrr"),
        (3.0, "rryyrr"),
        (20.0, "rrrrGG"),
        (3.0, "rrrryy"),
    ]);
    let phases = program(&engine);
    let states: Vec<&str> = phases.iter().map(|(s, _)| s.as_str()).collect();
    // Both directions together, turning left on a permissive green.
    assert_eq!(states, ["GgGgrr", "yyyyrr", "rrrrGG", "rrrryy"]);
    // Same 69 s cycle, split 3 lanes' worth to 2.
    let cycle: f32 = phases.iter().map(|(_, t)| t).sum();
    assert!((cycle - 69.0).abs() < 0.01, "cycle {cycle}");
    assert!((phases[0].1 - 36.6).abs() < 0.01 && (phases[2].1 - 26.4).abs() < 0.01);

    // A protected left-turn phase stays.
    let engine = signalled_crossroads(&[
        (20.0, "GgGgrr"),
        (3.0, "yGyGrr"),
        (10.0, "rGrGrr"),
        (3.0, "ryryrr"),
        (20.0, "rrrrGG"),
        (3.0, "rrrryy"),
    ]);
    let states: Vec<String> = program(&engine).into_iter().map(|(s, _)| s).collect();
    assert_eq!(
        states,
        ["GgGgrr", "yGyGrr", "rGrGrr", "ryryrr", "rrrrGG", "rrrryy"]
    );
}

#[test]
fn actuated_signals_skip_phases_nobody_waits_for() {
    // Actuated greens: east-west, then north-south, each with its yellow.
    let mut d = signalled_crossroads_data(&[
        (30.0, "GGGGrr"),
        (3.0, "yyyyrr"),
        (30.0, "rrrrGG"),
        (3.0, "rrrryy"),
    ]);
    for p in [0, 2] {
        d.phase_min_dur[p] = 5.0;
        d.phase_max_dur[p] = 50.0;
    }
    let mut engine = Engine::new(Network::build(d).unwrap(), 1);
    engine.set_time(0.0);
    // Roads in the order the crossroads builds them.
    let (eb_in, eb_out, nb_in, nb_out) = (0, 1, 4, 5);
    for k in 0..75 {
        engine.add_trip(Trip {
            depart: k as f64 * 4.0,
            from: eb_in,
            to: eb_out,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    // Nobody comes from the north or south: their green never shows, however often the
    // east-west green ends in a gap.
    let mut north_south = false;
    let mut changes = 0;
    let mut last = engine.tls_phase[0];
    run_until(&mut engine, 150.0, |e| {
        north_south |= e.tls_phase[0] == 2;
        changes += (e.tls_phase[0] != last) as u32;
        last = e.tls_phase[0];
    });
    assert!(
        !north_south,
        "the north-south green showed with nobody waiting"
    );
    // Nor does the east-west green end in a yellow for nobody.
    assert_eq!(
        changes, 0,
        "the east-west green ended with nobody waiting elsewhere"
    );
    // A car arrives from the south: it gets its green.
    let lane = engine.net.edge_lanes(nb_in).start;
    let length = engine.net.d.lane_length[lane as usize];
    let car = engine.insert_at(vtype::CAR, vec![nb_in, nb_out], lane, length - 40.0, 8.0);
    let serial = engine.vehs[car as usize].serial;
    let mut through = false;
    run_until(&mut engine, 90.0, |e| {
        let v = &e.vehs[car as usize];
        through |= !v.alive() || v.serial != serial || v.route_idx >= 1;
    });
    assert!(through, "the car from the south never got a green");
}

/// Crossroads where turning left from the east-west road waits for oncoming traffic at a
/// point inside the junction (M7b): one lane in from the west, straight on or left; one lane
/// in from the east, straight on. Returns the network, its roads (eastbound in and out,
/// westbound in and out, northbound out) and the junction lane where the turn waits.
fn waiting_left_turn() -> (NetworkData, [u32; 5], u32) {
    let mut b = Builder::default();
    let jw = b.junction(0.0, 0.0);
    let j = b.junction(300.0, 0.0);
    let je = b.junction(600.0, 0.0);
    let jn = b.junction(300.0, -300.0);
    let eb_in = b.road(jw, j, 1, 13.9);
    let eb_out = b.road(j, je, 1, 13.9);
    let wb_in = b.road(je, j, 1, 13.9);
    let wb_out = b.road(j, jw, 1, 13.9);
    let nb_out = b.road(j, jn, 1, 13.9);
    let (eb, wb) = (b.lane(eb_in, 0), b.lane(wb_in, 0));
    b.connect(eb, b.lane(eb_out, 0), j, dir::STRAIGHT, b'O');
    let left = b.connect(eb, b.lane(nb_out, 0), j, dir::LEFT, b'o');
    let oncoming = b.connect(wb, b.lane(wb_out, 0), j, dir::STRAIGHT, b'O');
    // The left turn crosses the junction in two lanes, waiting between them.
    let wait = b.d.link_via[left as usize];
    let to = b.d.lane_next[wait as usize];
    let end = *b.d.lane_shape_offsets.last().unwrap() as usize;
    let (x, z) = (b.d.lane_shape[end * 3 - 3], b.d.lane_shape[end * 3 - 2]);
    let e = b.add_edge(j, j, edge_flag::INTERNAL);
    let second = b.add_lane(e, &[(x, z), (x, z - 2.0)], 7.0, ALL);
    b.d.edge_lane_count[e as usize] = 1;
    b.d.lane_next[wait as usize] = second;
    b.d.lane_next[second as usize] = to;
    // The turn gives way to oncoming traffic (at the point where it waits).
    b.set_logic(j, &[(0, 0), (0b100, 0b100), (0, 0b010)]);
    b.d.wait_lane = vec![wait];
    b.d.wait_foe_offsets = vec![0, 2];
    b.d.wait_foes = vec![b.d.link_via[oncoming as usize], wb];
    (b.data(), [eb_in, eb_out, wb_in, wb_out, nb_out], wait)
}

#[test]
fn a_left_turn_waits_inside_the_junction_and_lets_traffic_behind_it_pass() {
    let (data, [eb_in, eb_out, wb_in, wb_out, nb_out], wait) = waiting_left_turn();
    let mut engine = Engine::new(Network::build(data).unwrap(), 1);
    engine.set_time(0.0);
    // Oncoming traffic every 3 s for a minute and a half.
    for k in 0..30 {
        engine.add_trip(Trip {
            depart: k as f64 * 3.0,
            from: wb_in,
            to: wb_out,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    run_until(&mut engine, 30.0, assert_no_overlaps);
    // A car turning left, and one going straight on behind it.
    let lane = engine.net.edge_lanes(eb_in).start;
    let left = engine.insert_at(vtype::CAR, vec![eb_in, nb_out], lane, 220.0, 10.0);
    let straight = engine.insert_at(vtype::CAR, vec![eb_in, eb_out], lane, 190.0, 10.0);
    let (left_serial, straight_serial) = (
        engine.vehs[left as usize].serial,
        engine.vehs[straight as usize].serial,
    );
    let mut waited_inside = false;
    let mut straight_through = None;
    let mut oncoming_stopped = false;
    run_until(&mut engine, 40.0, |e| {
        assert_no_overlaps(e);
        let l = &e.vehs[left as usize];
        if l.serial == left_serial && l.lane == wait && l.speed < 0.1 {
            waited_inside = true;
        }
        let s = &e.vehs[straight as usize];
        if straight_through.is_none() && (s.serial != straight_serial || s.route_idx >= 1) {
            straight_through = Some(e.time);
        }
        let wb = e.net.edge_lanes(wb_in).start;
        oncoming_stopped |= e
            .vehicles_on(wb)
            .iter()
            .any(|&u| e.vehs[u as usize].wait > 3.0);
    });
    assert!(
        waited_inside,
        "the left turn waited at the stop line, not inside"
    );
    assert!(
        straight_through.is_some(),
        "the car going straight on waited behind the left turn"
    );
    assert!(
        !oncoming_stopped,
        "oncoming traffic stopped for the left turn"
    );
    // Once the oncoming traffic has passed, the turn is made.
    run_until(&mut engine, 60.0, assert_no_overlaps);
    let l = &engine.vehs[left as usize];
    assert!(
        l.serial != left_serial || !l.alive() || l.route_idx >= 1,
        "the left turn never went"
    );
}

#[test]
fn a_lane_that_ends_merges_into_a_queue_beside_it() {
    // Two lanes narrow to one; a light further on keeps the queue in the lane that goes
    // on stopping and starting. A car coming up the lane that ends gets in when the queue
    // moves: the car beside it holds back for it.
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(200.0, 0.0);
    let j2 = b.junction(300.0, 0.0);
    let j3 = b.junction(600.0, 0.0);
    let wide = b.road(j0, j1, 2, 13.9);
    let narrow = b.road(j1, j2, 1, 13.9);
    let beyond = b.road(j2, j3, 1, 13.9);
    b.connect(b.lane(wide, 0), b.lane(narrow, 0), j1, dir::STRAIGHT, b'M');
    let light = b.connect(
        b.lane(narrow, 0),
        b.lane(beyond, 0),
        j2,
        dir::STRAIGHT,
        b'O',
    );
    b.signal(&[light], &[(20.0, "G"), (40.0, "r")]);
    let mut engine = Engine::new(b.build(), 1);
    engine.set_time(0.0);
    // Steady traffic in the lane that goes on: it queues back from the light.
    for k in 0..200 {
        engine.add_trip(Trip {
            depart: k as f64,
            from: wide,
            to: beyond,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    run_until(&mut engine, 90.0, |_| {});
    let lane0 = engine.net.edge_lanes(wide).start;
    assert!(
        engine.vehicles_on(lane0).len() > 10,
        "the queue reaches back"
    );
    // A car comes up the lane that ends.
    let lane1 = lane0 + 1;
    let merging = engine.insert_at(vtype::CAR, vec![wide, narrow, beyond], lane1, 20.0, 10.0);
    let serial = engine.vehs[merging as usize].serial;
    let mut merged = None;
    run_until(&mut engine, 180.0, |e| {
        assert_no_overlaps(e);
        let m = &e.vehs[merging as usize];
        if merged.is_none() && (m.serial != serial || m.lane != lane1) {
            merged = Some(e.time);
        }
    });
    assert!(
        merged.is_some_and(|t| t < 150.0),
        "the car in the lane that ends got in at {merged:?}"
    );
}

#[test]
fn routes_avoid_tolls_where_a_free_road_is_not_much_slower() {
    // From A to D over 10.2 km: a tolled motorway at 130 km/h or a free road at 80 km/h.
    let mut b = Builder::default();
    let s = b.junction(-500.0, 0.0);
    let a = b.junction(0.0, 0.0);
    let m = b.junction(5000.0, -1000.0);
    let f = b.junction(5000.0, 1000.0);
    let dj = b.junction(10_000.0, 0.0);
    let ej = b.junction(10_500.0, 0.0);
    let start = b.road(s, a, 1, 13.9);
    let am = b.road(a, m, 2, 36.1);
    let md = b.road(m, dj, 2, 36.1);
    let af = b.road(a, f, 1, 22.2);
    let fd = b.road(f, dj, 1, 22.2);
    let exit = b.road(dj, ej, 1, 13.9);
    for e in [am, md] {
        b.d.edge_flags[e as usize] |= edge_flag::TOLL;
    }
    for (from, to, j) in [
        (start, am, a),
        (start, af, a),
        (am, md, m),
        (af, fd, f),
        (md, exit, dj),
        (fd, exit, dj),
    ] {
        let (fl, tl) = (b.lane(from, 0), b.lane(to, 0));
        b.connect(fl, tl, j, dir::STRAIGHT, b'M');
    }
    let net = b.build();
    let tt: Vec<f32> = (0..net.edge_count())
        .map(|e| net.edge_length[e] / net.edge_speed[e])
        .collect();
    let mut router = Router::new(net.edge_count());
    let car = crate::network::vclass::PASSENGER;
    // 282 s on the motorway plus 367 s for the toll, against 459 s on the free road.
    assert_eq!(
        router.route(&net, &tt, start, exit, car),
        Some(vec![start, af, fd, exit])
    );
    // A jam on the free road makes the toll worth paying.
    let mut jammed = tt.clone();
    jammed[af as usize] *= 2.0;
    jammed[fd as usize] *= 2.0;
    assert_eq!(
        router.route(&net, &jammed, start, exit, car),
        Some(vec![start, am, md, exit])
    );
    // Drivers who do not weigh the toll take the motorway.
    router.tolls = false;
    assert_eq!(
        router.route(&net, &tt, start, exit, car),
        Some(vec![start, am, md, exit])
    );

    // Those are the drivers who cross the map's edge on a tolled motorway.
    let engine = Engine::new(net, 1);
    let trip = |flags: u8, from: u32, to: u32| Trip {
        depart: 0.0,
        from,
        to,
        vtype: vtype::CAR,
        flags,
    };
    assert!(engine.weighs_tolls(&trip(0, start, exit)));
    assert!(engine.weighs_tolls(&trip(trip::ENTER, af, exit)));
    assert!(!engine.weighs_tolls(&trip(trip::ENTER, am, exit)));
    assert!(!engine.weighs_tolls(&trip(trip::EXIT, start, md)));
}

#[test]
fn tram_tracks_count_a_quarter_lane_when_splitting_green() {
    // A one-lane road and a tram track crossing it, each with its own phase.
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(300.0, 0.0);
    let j2 = b.junction(600.0, 0.0);
    let jn = b.junction(300.0, -300.0);
    let js = b.junction(300.0, 300.0);
    let road_in = b.road(j0, j1, 1, 13.9);
    let road_out = b.road(j1, j2, 1, 13.9);
    let track_in = b.road(js, j1, 1, 13.9);
    let track_out = b.road(j1, jn, 1, 13.9);
    for e in [track_in, track_out] {
        let lane = b.lane(e, 0) as usize;
        b.d.lane_allow[lane] = crate::network::vclass::TRAM;
    }
    let links = [
        b.connect(
            b.lane(road_in, 0),
            b.lane(road_out, 0),
            j1,
            dir::STRAIGHT,
            b'O',
        ),
        b.connect(
            b.lane(track_in, 0),
            b.lane(track_out, 0),
            j1,
            dir::STRAIGHT,
            b'O',
        ),
    ];
    b.signal(
        &links,
        &[(30.0, "Gr"), (3.0, "yr"), (30.0, "rG"), (3.0, "ry")],
    );
    let engine = Engine::new(b.build(), 1);
    let d = &engine.net.d;
    // 48 s beyond the 6 s minimum each, split 1 to 0.25.
    let durations: Vec<f32> = (0..4).map(|p| d.phase_duration[p]).collect();
    assert!((durations[0] - 44.4).abs() < 0.01 && (durations[2] - 15.6).abs() < 0.01);
}

// ---- edits (M4a) ----------------------------------------------------------------------------

/// Two ways from A to Z: straight on through M (1 km), or a 1.4 km detour through C; then
/// on to Z. Returns the engine and the edges (direct, up, down, last).
fn two_ways() -> (Engine, [u32; 4]) {
    let mut b = Builder::default();
    let a = b.junction(0.0, 0.0);
    let m = b.junction(1000.0, 0.0);
    let c = b.junction(500.0, 500.0);
    let z = b.junction(1500.0, 0.0);
    let direct = b.road(a, m, 1, 13.9);
    let up = b.road(a, c, 1, 13.9);
    let down = b.road(c, m, 1, 13.9);
    let last = b.road(m, z, 1, 13.9);
    let (l_direct, l_up, l_down, l_last) = (
        b.lane(direct, 0),
        b.lane(up, 0),
        b.lane(down, 0),
        b.lane(last, 0),
    );
    b.connect(l_up, l_down, c, dir::STRAIGHT, b'M');
    b.connect(l_direct, l_last, m, dir::STRAIGHT, b'M');
    b.connect(l_down, l_last, m, dir::STRAIGHT, b'M');
    (Engine::new(b.build(), 9), [direct, up, down, last])
}

fn car_route(engine: &mut Engine, from: u32, to: u32) -> Option<Vec<u32>> {
    let mut router = Router::new(engine.net.edge_count());
    router.route(
        &engine.net,
        &engine.travel_time,
        from,
        to,
        vclass::PASSENGER,
    )
}

#[test]
fn edits_survive_encoding_for_the_app() {
    let all = [
        Edit::CloseRoad { edge: 7 },
        Edit::CloseLane { edge: 3, lane: 1 },
        Edit::SpeedLimit {
            edge: 9,
            speed: 8.33,
        },
        Edit::LaneClasses {
            edge: 4,
            lane: 0,
            classes: vclass::BUS,
        },
        Edit::BanTurn { from: 1, to: 2 },
        Edit::Green {
            tls: 0,
            phase: 2,
            seconds: 31.5,
        },
        Edit::Frequency {
            route: 12,
            factor: 1.5,
        },
        Edit::Line(crate::edits::Line {
            route: 300,
            vtype: vtype::BUS,
            headway: 600.0,
            first: 18_000.0,
            last: 82_800.0,
            stops: vec![(4, 0.25), (9, 0.5), (2, 0.75)],
        }),
        Edit::CloseRoad { edge: 8 },
        Edit::Priority { tls: 3 },
    ];
    let words: Vec<u32> = all.iter().flat_map(|e| e.encode()).collect();
    assert_eq!(Edit::decode(&words), all);
    // Unknown kinds and a trailing partial record are skipped, and a line missing a stop.
    assert_eq!(Edit::decode(&[99, 1, 2, 3, 1, 5]), vec![]);
    let line_words = all[7].encode();
    assert_eq!(Edit::decode(&line_words[..line_words.len() - 4]), vec![]);
}

#[test]
fn a_banned_turn_sends_traffic_the_other_way() {
    let (mut engine, [direct, up, down, last]) = two_ways();
    assert_eq!(
        car_route(&mut engine, direct, last),
        Some(vec![direct, last])
    );
    // From the start of the network (the direct road or the detour), with the turn from the
    // direct road onto the last one banned, only the detour remains.
    assert_eq!(
        engine.set_edits(&[Edit::BanTurn {
            from: direct,
            to: last
        }]),
        1
    );
    assert_eq!(car_route(&mut engine, direct, last), None);
    assert_eq!(car_route(&mut engine, up, last), Some(vec![up, down, last]));
    // Turns no link makes are rejected.
    assert_eq!(engine.set_edits(&[Edit::BanTurn { from: up, to: last }]), 0);
}

#[test]
fn a_closed_road_keeps_cars_out_but_lets_those_on_it_leave() {
    let (b, e0, e1) = straight_road(300.0, 1);
    let mut engine = Engine::new(b.build(), 4);
    let lane0 = engine.net.edge_lanes(e0).start;
    let v = engine.insert_at(vtype::CAR, vec![e0, e1], lane0, 50.0, 10.0);
    let serial = engine.vehs[v as usize].serial;
    // Close the road the car is on: it still drives off it, and nothing else can route in.
    assert_eq!(engine.set_edits(&[Edit::CloseRoad { edge: e0 }]), 1);
    assert_eq!(car_route(&mut engine, e0, e1), Some(vec![e0, e1]));
    run_until(&mut engine, 120.0, assert_no_overlaps);
    assert!(engine.vehs[v as usize].serial != serial || !engine.vehs[v as usize].alive());
    assert_eq!((engine.stats.arrived, engine.stats.teleported), (1, 0));
    // Closing the road it leads to: no route for cars, but buses keep theirs.
    engine.set_edits(&[Edit::CloseRoad { edge: e1 }]);
    assert_eq!(car_route(&mut engine, e0, e1), None);
    let mut router = Router::new(engine.net.edge_count());
    assert!(
        router
            .route(&engine.net, &engine.travel_time, e0, e1, vclass::BUS)
            .is_some()
    );
}

#[test]
fn a_closed_lane_or_bus_lane_empties_of_cars() {
    for edit in [
        Edit::CloseLane { edge: 1, lane: 1 },
        Edit::LaneClasses {
            edge: 1,
            lane: 1,
            classes: vclass::BUS,
        },
    ] {
        let (b, e0, e1) = straight_road(600.0, 2);
        assert_eq!(e1, 1);
        let mut engine = Engine::new(b.build(), 8);
        let closed = engine.net.edge_lanes(e1).start + 1;
        assert_eq!(engine.set_edits(&[edit]), 1);
        for k in 0..30 {
            engine.add_trip(Trip {
                depart: k as f64 * 2.0,
                from: e0,
                to: e1,
                vtype: vtype::CAR,
                flags: 0,
            });
        }
        run_until(&mut engine, 300.0, |e| {
            assert!(
                e.vehicles_on(closed).is_empty(),
                "a car on the closed lane at t={}",
                e.time
            );
            assert_no_overlaps(e);
        });
        let s = &engine.stats;
        assert!(s.departed >= 25, "departed {}", s.departed);
        assert_eq!((s.arrived, s.teleported), (s.departed, 0));
    }
}

#[test]
fn a_faster_road_draws_routes_once_the_landmarks_are_rebuilt() {
    // From A to D: via B is shorter but slow, via C longer but fast.
    let mut b = Builder::default();
    let a = b.junction(0.0, 0.0);
    let bj = b.junction(500.0, 300.0);
    let c = b.junction(500.0, -600.0);
    let dj = b.junction(1000.0, 0.0);
    let ej = b.junction(1500.0, 0.0);
    let start = b.road(ej, a, 1, 13.9);
    let ab = b.road(a, bj, 1, 5.0);
    let bd = b.road(bj, dj, 1, 5.0);
    let ac = b.road(a, c, 1, 25.0);
    let cd = b.road(c, dj, 1, 25.0);
    let exit = b.road(dj, ej, 1, 13.9);
    for (from, to, j) in [
        (start, ab, a),
        (start, ac, a),
        (ab, bd, bj),
        (ac, cd, c),
        (bd, exit, dj),
        (cd, exit, dj),
    ] {
        let (fl, tl) = (b.lane(from, 0), b.lane(to, 0));
        b.connect(fl, tl, j, dir::STRAIGHT, b'M');
    }
    let mut engine = Engine::new(b.build(), 2);
    let fast = vec![start, ac, cd, exit];
    let slow = vec![start, ab, bd, exit];
    let v = engine.insert_at(
        vtype::CAR,
        fast.clone(),
        engine.net.edge_lanes(start).start,
        10.0,
        10.0,
    );
    // Raise the limit on the short way to 70 km/h: it becomes the fastest, the landmark
    // tables no longer bound it and are rebuilt step by step, and the car on its way
    // re-plans within a minute.
    let quick = 70.0 / 3.6;
    let edits = [
        Edit::SpeedLimit {
            edge: ab,
            speed: quick,
        },
        Edit::SpeedLimit {
            edge: bd,
            speed: quick,
        },
    ];
    assert_eq!(engine.set_edits(&edits), 2);
    assert!(!engine.landmarks_ready());
    assert_eq!(car_route(&mut engine, start, exit), Some(slow.clone()));
    run_until(&mut engine, 30.0, |_| {});
    assert!(engine.landmarks_ready());
    assert_eq!(
        engine.vehs[v as usize].route, slow,
        "the car on its way takes the faster road"
    );
    // Slowing roads keeps the tables valid: no rebuild.
    engine.set_edits(&[Edit::SpeedLimit {
        edge: ac,
        speed: 10.0,
    }]);
    assert!(engine.landmarks_ready());
}

#[test]
fn removing_edits_restores_the_network_as_loaded() {
    let mut engine = signalled_crossroads(&[(30.0, "GGrrrr"), (5.0, "yyrrrr"), (30.0, "rrGGGG")]);
    let before = (
        engine.net.d.lane_allow.clone(),
        engine.net.d.lane_speed.clone(),
        engine.net.link_allow.clone(),
        program(&engine),
    );
    let edits = [
        Edit::CloseLane { edge: 0, lane: 1 },
        Edit::SpeedLimit {
            edge: 2,
            speed: 5.0,
        },
        Edit::BanTurn { from: 2, to: 7 },
        Edit::Green {
            tls: 0,
            phase: 0,
            seconds: 45.0,
        },
    ];
    assert_eq!(engine.set_edits(&edits), 4);
    assert_eq!(engine.edits(), &edits);
    assert_eq!(program(&engine)[0].1, 45.0);
    assert!(engine.net.link_allow != before.2);
    run_until(&mut engine, 30.0, |_| {});
    assert_eq!(engine.set_edits(&[]), 0);
    assert_eq!(engine.net.d.lane_allow, before.0);
    assert_eq!(engine.net.d.lane_speed, before.1);
    assert_eq!(engine.net.link_allow, before.2);
    assert_eq!(program(&engine), before.3);
    // Out-of-range values and unknown roads, lanes and phases are rejected.
    let bad = [
        Edit::SpeedLimit {
            edge: 2,
            speed: 0.1,
        },
        Edit::CloseLane { edge: 2, lane: 5 },
        Edit::CloseRoad { edge: 9999 },
        Edit::Green {
            tls: 0,
            phase: 9,
            seconds: 20.0,
        },
        Edit::Green {
            tls: 0,
            phase: 0,
            seconds: 1000.0,
        },
    ];
    assert_eq!(engine.set_edits(&bad), 0);
}

#[test]
fn delay_counts_time_lost_against_the_speed_limit() {
    // One car on a free road loses little time; a car that reaches a red light after about
    // 35 s and waits until it turns green at 100 s loses those 65 s and a little braking.
    for (red, min_delay, max_delay) in [(0.0, 0.0, 15.0), (100.0, 62.0, 85.0)] {
        let mut b = Builder::default();
        let j0 = b.junction(0.0, 0.0);
        let j1 = b.junction(500.0, 0.0);
        let j2 = b.junction(1000.0, 0.0);
        let e0 = b.road(j0, j1, 1, 13.9);
        let e1 = b.road(j1, j2, 1, 13.9);
        let link = b.connect(b.lane(e0, 0), b.lane(e1, 0), j1, dir::STRAIGHT, b'O');
        if red > 0.0 {
            b.signal(&[link], &[(red, "r"), (200.0, "G")]);
        }
        let mut engine = Engine::new(b.build(), 3);
        let lane0 = engine.net.edge_lanes(e0).start;
        engine.insert_at(vtype::CAR, vec![e0, e1], lane0, 0.0, 13.9);
        // Free-flow time from the start of e0 to the end of e1, as routing estimates it.
        let free = engine.route_time(e0, e1).unwrap();
        assert!((free - engine.net.edge_length[e1 as usize] / 13.9).abs() < 0.5);
        run_until(&mut engine, 300.0, |_| {});
        let s = &engine.stats;
        assert_eq!(s.arrived, 1);
        let delay = s.delay_seconds;
        assert!(
            (min_delay..max_delay).contains(&delay),
            "red {red}: delay {delay}"
        );
        let km = engine.stats_array()[stat::VEHICLE_KM];
        assert!((0.9..1.1).contains(&km), "driven {km} km");
    }
}

/// From W to E either by a detour to the north, or (`direct`) straight across: W -> J0 ->
/// (N ->) J1 -> E. The direct road and its links come last, as the app appends them.
fn detour(direct: bool) -> (NetworkData, [u32; 4]) {
    let mut b = Builder::default();
    let w = b.junction(-200.0, 0.0);
    let j0 = b.junction(0.0, 0.0);
    let n = b.junction(300.0, -500.0);
    let j1 = b.junction(600.0, 0.0);
    let e = b.junction(800.0, 0.0);
    let entry = b.road(w, j0, 1, 13.9);
    let up = b.road(j0, n, 1, 13.9);
    let down = b.road(n, j1, 1, 13.9);
    let exit = b.road(j1, e, 1, 13.9);
    for (from, to, j) in [(entry, up, j0), (up, down, n), (down, exit, j1)] {
        let (fl, tl) = (b.lane(from, 0), b.lane(to, 0));
        b.connect(fl, tl, j, dir::STRAIGHT, b'M');
    }
    let mut across = NONE;
    if direct {
        across = b.road(j0, j1, 1, 13.9);
        let (el, al, xl) = (b.lane(entry, 0), b.lane(across, 0), b.lane(exit, 0));
        b.connect(el, al, j0, dir::STRAIGHT, b'M');
        b.connect(al, xl, j1, dir::STRAIGHT, b'm');
        // At J1 the new road gives way to the old one where they merge.
        b.set_logic(j1, &[(0, 0b10), (0b01, 0b01)]);
    }
    (b.data(), [entry, up, exit, across])
}

#[test]
fn a_new_road_takes_traffic_while_vehicles_drive() {
    let (base, [entry, up, exit, _]) = detour(false);
    let (patched, [.., across]) = detour(true);
    let mut engine = Engine::new(Network::build(base).unwrap(), 4);
    let route = |engine: &Engine| {
        let down = engine.net.d.lane_edge[engine.net.d.link_to[1] as usize];
        vec![entry, up, down, exit]
    };
    let r = route(&engine);
    let on_detour = engine.insert_at(
        vtype::CAR,
        r.clone(),
        engine.net.edge_lanes(up).start,
        300.0,
        10.0,
    );
    let coming = engine.insert_at(
        vtype::CAR,
        r,
        engine.net.edge_lanes(entry).start,
        10.0,
        10.0,
    );
    run_until(&mut engine, 2.0, |_| {});
    let lanes = engine.net.lane_count();
    engine
        .replace_network(patched, &[])
        .expect("a consistent network");
    assert!(engine.net.lane_count() > lanes);
    assert!(!engine.landmarks_ready());
    // The car still on the way in takes the new road; the one on the detour drives on.
    let mut took = false;
    run_until(&mut engine, 120.0, |e| {
        assert_no_overlaps(e);
        let veh = &e.vehs[coming as usize];
        took |= veh.alive() && veh.route.contains(&across);
    });
    assert!(took, "the car coming in re-planned onto the new road");
    assert!(engine.edge_entered[across as usize] >= 1);
    assert!(!engine.vehs[on_detour as usize].alive() && !engine.vehs[coming as usize].alive());
    assert_eq!((engine.stats.arrived, engine.stats.teleported), (2, 0));
    assert!(engine.landmarks_ready());
}

#[test]
fn a_cyclist_rides_on_a_network_with_roads_drawn() {
    // Bike routes and counts grow with the network: a bike sets off after the new road is
    // built and rides through.
    let (base, [entry, _, exit, _]) = detour(false);
    let (patched, [.., across]) = detour(true);
    let mut engine = Engine::new(Network::build(base).unwrap(), 4);
    engine.set_cycleways(&[]);
    engine.set_time(0.0);
    engine
        .replace_network(patched, &[])
        .expect("a consistent network");
    assert_eq!(engine.edge_bikes.len(), engine.net.edge_count());
    engine.add_trip(Trip {
        depart: 1.0,
        from: entry,
        to: exit,
        vtype: vtype::BIKE,
        flags: 0,
    });
    run_until(&mut engine, 400.0, assert_no_overlaps);
    assert_eq!(engine.stats.bike_arrived, 1, "the bike got through");
    assert!(engine.edge_bikes[across as usize] + engine.edge_bikes[exit as usize] >= 1);
}

/// The straight road J0 -> J1 -> J2 with its first road split in the middle by a new
/// junction J3, as the app builds it: the first half keeps its id and ends 6 m before J3,
/// the second half is a new edge from 6 m after J3 to J1 that the old links now leave.
/// Returns both networks, the lane, the second half's lane and the cut (m along the lane).
fn split_road() -> (NetworkData, NetworkData, u32, u32, f32) {
    let (base, e0, _) = straight_road(400.0, 1);
    let base = base.data();
    let (mut b, _, _) = straight_road(400.0, 1);
    let lane = b.lane(e0, 0);
    let j3 = b.junction(200.0, 0.0);
    let z = b.d.lane_shape[1];
    let end = b.d.lane_shape_offsets[lane as usize + 1] as usize - 1;
    b.d.lane_shape[end * 3] = 194.0;
    b.d.lane_length[lane as usize] = 188.0;
    b.d.edge_to[e0 as usize] = j3;
    let second = b.add_edge(j3, 1, 0);
    let onto = b.add_lane(second, &[(206.0, z), (394.0, z)], 13.9, ALL);
    b.d.edge_lane_count[second as usize] = 1;
    for l in 0..b.d.link_from.len() {
        if b.d.link_from[l] == lane {
            b.d.link_from[l] = onto;
        }
    }
    b.connect(lane, onto, j3, dir::STRAIGHT, b'M');
    (base, b.data(), lane, onto, 188.0)
}

#[test]
fn splitting_a_road_keeps_the_vehicles_on_it() {
    let (base, patched, lane, onto, cut) = split_road();
    let mut engine = Engine::new(Network::build(base).unwrap(), 5);
    let (e0, e1) = (0, 1);
    let cars: Vec<u32> = [50.0, 150.0, 250.0, 350.0]
        .iter()
        .map(|&pos| engine.insert_at(vtype::CAR, vec![e0, e1], lane, pos, 10.0))
        .collect();
    run_until(&mut engine, 1.0, |_| {});
    let before: Vec<f32> = cars.iter().map(|&v| engine.vehs[v as usize].pos).collect();
    // Past the cut, the old lane goes on 12 m further on as the second half's lane.
    let pieces = [
        LanePiece {
            old: lane,
            from: 0.0,
            lane,
            shift: 0.0,
        },
        LanePiece {
            old: lane,
            from: cut,
            lane: onto,
            shift: -(cut + 12.0),
        },
    ];
    engine
        .replace_network(patched, &pieces)
        .expect("a consistent network");
    let second = engine.net.d.lane_edge[onto as usize];
    for (k, &v) in cars.iter().enumerate() {
        let veh = &engine.vehs[v as usize];
        assert_eq!(veh.route, vec![e0, second, e1]);
        if before[k] > cut {
            assert_eq!((veh.lane, veh.route_idx), (onto, 1));
            assert!((veh.pos - (before[k] - 200.0)).abs() < 0.01);
        } else {
            assert_eq!((veh.lane, veh.route_idx, veh.pos), (lane, 0, before[k]));
        }
        assert_ne!(veh.next_link, NONE);
    }
    run_until(&mut engine, 120.0, assert_no_overlaps);
    assert_eq!((engine.stats.arrived, engine.stats.teleported), (4, 0));
}

#[test]
fn a_car_just_off_a_road_taken_away_is_drawn_along_the_lanes_left() {
    let (with_road, [_, _, exit, across]) = detour(true);
    let (without, _) = detour(false);
    let mut engine = Engine::new(Network::build(with_road).unwrap(), 6);
    let lane_across = engine.net.edge_lanes(across).start;
    let length = engine.net.d.lane_length[lane_across as usize];
    let car = engine.insert_at(
        vtype::CAR,
        vec![across, exit],
        lane_across,
        length - 2.0,
        10.0,
    );
    // Onto the road out: the lanes behind it are the direct road's, about to go.
    let mut steps = 0;
    while engine.net.d.lane_edge[engine.vehs[car as usize].lane as usize] != exit {
        engine.step();
        steps += 1;
        assert!(steps < 100, "the car never left the direct road");
    }
    assert!(engine.vehs[car as usize].hist.contains(&lane_across));
    let gone: Vec<LanePiece> = (lane_across..engine.net.lane_count() as u32)
        .map(|old| LanePiece {
            old,
            from: 0.0,
            lane: NONE,
            shift: 0.0,
        })
        .collect();
    engine
        .replace_network(without, &gone)
        .expect("a consistent network");
    let n = engine.net.lane_count() as u32;
    let veh = &engine.vehs[car as usize];
    assert!(veh.alive());
    assert!(
        veh.hist.iter().all(|&h| h == NONE || h < n),
        "{:?}",
        veh.hist
    );
    // Drawing it follows only lanes the network has.
    for _ in 0..20 {
        engine.write_render();
        engine.step();
    }
}

#[test]
fn taking_a_road_away_again_merges_the_halves_and_drops_its_traffic() {
    // The detour network with the direct road, and the split straight road: back to the
    // networks without them.
    let (with_road, [entry, up, exit, across]) = detour(true);
    let (without, _) = detour(false);
    let mut engine = Engine::new(Network::build(with_road).unwrap(), 6);
    let lane_across = engine.net.edge_lanes(across).start;
    let on_it = engine.insert_at(vtype::CAR, vec![across, exit], lane_across, 100.0, 10.0);
    let r = vec![entry, across, exit];
    let coming = engine.insert_at(
        vtype::CAR,
        r,
        engine.net.edge_lanes(entry).start,
        10.0,
        10.0,
    );
    run_until(&mut engine, 1.0, |_| {});
    // The direct road's lane and the internal lanes of its two links go.
    let gone: Vec<LanePiece> = (lane_across..engine.net.lane_count() as u32)
        .map(|old| LanePiece {
            old,
            from: 0.0,
            lane: NONE,
            shift: 0.0,
        })
        .collect();
    let added_internal = engine.net.d.lane_edge.len() - lane_across as usize;
    assert_eq!(added_internal, 3);
    engine
        .replace_network(without, &gone)
        .expect("a consistent network");
    assert!(
        !engine.vehs[on_it as usize].alive(),
        "the car on the road taken away left"
    );
    let veh = &engine.vehs[coming as usize];
    assert!(
        veh.alive() && veh.route.contains(&up),
        "the car coming in re-planned"
    );
    run_until(&mut engine, 150.0, assert_no_overlaps);
    assert_eq!((engine.stats.arrived, engine.stats.teleported), (1, 0));

    let (split, base, lane, onto, cut) = {
        let (base, split, lane, onto, cut) = split_road();
        (split, base, lane, onto, cut)
    };
    let mut engine = Engine::new(Network::build(split).unwrap(), 7);
    let second = engine.net.d.lane_edge[onto as usize];
    let car = engine.insert_at(vtype::CAR, vec![0, second, 1], onto, 50.0, 10.0);
    let via = engine.net.lane_count() as u32 - 1;
    let pieces = [
        LanePiece {
            old: onto,
            from: 0.0,
            lane,
            shift: cut + 12.0,
        },
        LanePiece {
            old: via,
            from: 0.0,
            lane,
            shift: cut,
        },
    ];
    engine
        .replace_network(base, &pieces)
        .expect("a consistent network");
    let veh = &engine.vehs[car as usize];
    assert_eq!(
        (veh.lane, veh.route.clone(), veh.route_idx),
        (lane, vec![0, 1], 0)
    );
    assert!((veh.pos - 250.0).abs() < 0.01);
    run_until(&mut engine, 60.0, assert_no_overlaps);
    assert_eq!((engine.stats.arrived, engine.stats.teleported), (1, 0));
}

#[test]
fn signal_programs_the_player_sets_run_as_given() {
    // The program the engine would merge (above), set by the player: it runs as given.
    let phases = [
        (20.0, "GGrrrr"),
        (3.0, "yyrrrr"),
        (20.0, "rrGGrr"),
        (3.0, "rryyrr"),
        (20.0, "rrrrGG"),
        (3.0, "rrrryy"),
    ];
    let mut d = signalled_crossroads_data(&phases);
    d.tls_fixed = vec![1];
    let engine = Engine::new(Network::build(d).unwrap(), 1);
    let given: Vec<(String, f32)> = phases.iter().map(|&(t, s)| (s.to_string(), t)).collect();
    assert_eq!(program(&engine), given);
}

#[test]
fn time_at_a_red_light_does_not_make_drivers_impatient() {
    // Eastbound waits 90 s at red, then has 30 s of green with the road out east full.
    let mut d = signalled_crossroads_data(&[(90.0, "rrrrGG"), (30.0, "GgGgrr")]);
    d.tls_fixed = vec![1];
    let mut engine = Engine::new(Network::build(d).unwrap(), 1);
    engine.set_time(0.0);
    // Roads in the order the crossroads builds them.
    let (eb_in, eb_out, wb_in) = (0, 1, 2);
    let lane = |engine: &Engine, e: u32| engine.net.edge_lanes(e).start;
    let out = lane(&engine, eb_out);
    let length = engine.net.d.lane_length[out as usize];
    let car = &vtype::TYPES[vtype::CAR as usize];
    let mut pos = length - 1.0;
    while pos > car.length {
        engine.insert_at(vtype::CAR, vec![eb_out, wb_in], out, pos, 0.0);
        pos -= car.length + car.min_gap + 0.05;
    }
    let east = engine.insert_at(
        vtype::CAR,
        vec![eb_in, eb_out],
        lane(&engine, eb_in),
        250.0,
        10.0,
    );
    // A minute and more at the red light: standing, but not held up by anything that
    // makes a driver push in.
    run_until(&mut engine, 89.0, |_| {});
    let v = &engine.vehs[east as usize];
    assert!(
        v.wait > 60.0 && v.blocked == 0.0,
        "{} {}",
        v.wait,
        v.blocked
    );
    // Held at the green by the full road beyond: that counts.
    run_until(&mut engine, 30.0, |_| {});
    let v = &engine.vehs[east as usize];
    assert_eq!(engine.net.d.lane_edge[v.lane as usize], eb_in);
    assert!(
        v.blocked > 20.0 && v.blocked <= v.wait,
        "{} {}",
        v.wait,
        v.blocked
    );
}

/// A crossroads of two-way roads, one lane each way, or (`roundabout`) the same made a
/// roundabout as the app builds it: each road ends at a junction of its own on a ring 20 m
/// across, anticlockwise, the roads keeping their ids and the ring coming after them.
/// Returns the network and the roads: eastbound in and out, then westbound, northbound and
/// southbound, then (on the roundabout) the ring from the east, north, west and south.
fn crossroads(roundabout: bool) -> (NetworkData, Vec<u32>) {
    let mut b = Builder::default();
    let jw = b.junction(0.0, 0.0);
    let j = b.junction(300.0, 0.0);
    let je = b.junction(600.0, 0.0);
    let jn = b.junction(300.0, -300.0);
    let js = b.junction(300.0, 300.0);
    let [nw, ne, nn, ns] = if roundabout {
        [
            b.junction(280.0, 0.0),
            b.junction(320.0, 0.0),
            b.junction(300.0, -20.0),
            b.junction(300.0, 20.0),
        ]
    } else {
        [j; 4]
    };
    let mut roads = vec![
        b.road(jw, nw, 1, 13.9),
        b.road(ne, je, 1, 13.9),
        b.road(je, ne, 1, 13.9),
        b.road(nw, jw, 1, 13.9),
        b.road(js, ns, 1, 13.9),
        b.road(nn, jn, 1, 13.9),
        b.road(jn, nn, 1, 13.9),
        b.road(ns, js, 1, 13.9),
    ];
    let [eb_in, eb_out, wb_in, wb_out, nb_in, nb_out, sb_in, sb_out] = roads[..] else {
        unreachable!()
    };
    let lane = |b: &Builder, e: u32| b.lane(e, 0);
    if !roundabout {
        for (from, to) in [
            (eb_in, eb_out),
            (wb_in, wb_out),
            (nb_in, nb_out),
            (sb_in, sb_out),
        ] {
            let (f, t) = (lane(&b, from), lane(&b, to));
            b.connect(f, t, j, dir::STRAIGHT, b'M');
        }
        return (b.data(), roads);
    }
    let ring = [
        b.road(ne, nn, 1, 6.9),
        b.road(nn, nw, 1, 6.9),
        b.road(nw, ns, 1, 6.9),
        b.road(ns, ne, 1, 6.9),
    ];
    for e in ring {
        b.d.edge_flags[e as usize] |= edge_flag::ROUNDABOUT;
    }
    roads.extend(ring);
    // At each leg's junction: round the ring, onto it (giving way) and off it.
    for (node, ring_in, ring_out, way_in, way_out) in [
        (ne, ring[3], ring[0], wb_in, eb_out),
        (nn, ring[0], ring[1], sb_in, nb_out),
        (nw, ring[1], ring[2], eb_in, wb_out),
        (ns, ring[2], ring[3], nb_in, sb_out),
    ] {
        let (ri, ro, wi, wo) = (
            lane(&b, ring_in),
            lane(&b, ring_out),
            lane(&b, way_in),
            lane(&b, way_out),
        );
        b.connect(ri, ro, node, dir::STRAIGHT, b'M');
        b.connect(wi, ro, node, dir::RIGHT, b'm');
        b.connect(ri, wo, node, dir::RIGHT, b'M');
        b.set_logic(node, &[(0, 0b010), (0b001, 0b001), (0, 0)]);
    }
    (b.data(), roads)
}

#[test]
fn drivers_do_not_enter_a_roundabout_whose_exit_is_full() {
    // The road out east is full: cars stand along it, going nowhere (no way on at its end).
    let (ring, roads) = crossroads(true);
    let [
        eb_in,
        eb_out,
        wb_in,
        _,
        nb_in,
        nb_out,
        _,
        _,
        ring_n,
        _,
        ring_s,
        ring_e,
    ] = roads[..]
    else {
        unreachable!()
    };
    let mut engine = Engine::new(Network::build(ring).unwrap(), 3);
    engine.set_time(0.0);
    let lane = |engine: &Engine, e: u32| engine.net.edge_lanes(e).start;
    let out = lane(&engine, eb_out);
    let length = engine.net.d.lane_length[out as usize];
    let car = &vtype::TYPES[vtype::CAR as usize];
    let mut pos = length - 1.0;
    while pos > car.length {
        engine.insert_at(vtype::CAR, vec![eb_out, wb_in], out, pos, 0.0);
        pos -= car.length + car.min_gap + 0.05;
    }
    // A car heading east would have to wait on the ring for that road; one heading north
    // passes the same stretch of ring afterwards.
    let east = engine.insert_at(
        vtype::CAR,
        vec![eb_in, ring_s, ring_e, eb_out],
        lane(&engine, eb_in),
        250.0,
        10.0,
    );
    let north = engine.insert_at(
        vtype::CAR,
        vec![nb_in, ring_e, ring_n, nb_out],
        lane(&engine, nb_in),
        200.0,
        10.0,
    );
    let serial = engine.vehs[north as usize].serial;
    let mut north_through = false;
    run_until(&mut engine, 150.0, |e| {
        let n = &e.vehs[north as usize];
        if !n.alive() || n.serial != serial || n.route_idx >= 3 {
            north_through = true;
        }
    });
    // The car heading east waits on its own road, even after a minute and more, so the ring
    // stays clear for the car heading north.
    let e = &engine.vehs[east as usize];
    assert_eq!(
        engine.net.d.lane_edge[e.lane as usize], eb_in,
        "the eastbound car entered"
    );
    assert!(north_through, "the northbound car was held up on the ring");
}

#[test]
fn a_bus_at_its_stop_before_a_signal_neither_calls_nor_holds_the_green() {
    use crate::transit::{Transit, TransitData};
    // Actuated greens: east-west, then north-south, each with its yellow.
    let mut d = signalled_crossroads_data(&[
        (30.0, "GGGGrr"),
        (3.0, "yyyyrr"),
        (30.0, "rrrrGG"),
        (3.0, "rrrryy"),
    ]);
    for p in [0, 2] {
        d.phase_min_dur[p] = 5.0;
        d.phase_max_dur[p] = 50.0;
    }
    let mut engine = Engine::new(Network::build(d).unwrap(), 1);
    // Roads in the order the crossroads builds them.
    let (nb_in, nb_out) = (4, 5);
    // A bus from the south waits at a stop 9 m before the line until 60 s, its timetable.
    engine.transit = Some(Transit::new(TransitData {
        trip_type: vec![vtype::BUS],
        trip_route: vec![0],
        trip_stops: vec![0, 3],
        stop_edge: vec![nb_in, nb_in, nb_out],
        stop_frac: vec![0.5, 0.97, 0.5],
        stop_time: vec![5.0, 60.0, 120.0],
    }));
    engine.set_time(0.0);
    let mut green_at = None;
    let mut through_at = None;
    run_until(&mut engine, 90.0, |e| {
        if green_at.is_none() && e.tls_phase[0] == 2 {
            green_at = Some(e.time);
        }
        let bus = e.vehs.iter().find(|v| v.alive() && v.vtype == vtype::BUS);
        if through_at.is_none() && bus.is_some_and(|v| v.route_idx >= 1) {
            through_at = Some(e.time);
        }
    });
    assert_eq!(engine.transit.as_ref().unwrap().started, 1);
    // Nobody else waits: the north-south green comes only once the bus has left its stop.
    let green_at = green_at.expect("the bus never got a green");
    assert!(
        green_at >= 60.0,
        "green for the bus at {green_at} s, while it stood at its stop"
    );
    let through_at = through_at.expect("the bus never crossed");
    assert!(through_at < 75.0, "the bus crossed at {through_at} s");
}

/// When a bus from the south crosses the actuated crossroads, with traffic streaming from
/// the west, with or without signal priority (M10b), and whether it stopped on the way.
fn bus_through_crossroads(priority: bool) -> (f64, bool) {
    use crate::transit::{Transit, TransitData};
    let mut d = signalled_crossroads_data(&[
        (30.0, "GGGGrr"),
        (3.0, "yyyyrr"),
        (30.0, "rrrrGG"),
        (3.0, "rrrryy"),
    ]);
    for p in [0, 2] {
        d.phase_min_dur[p] = 5.0;
        d.phase_max_dur[p] = 50.0;
    }
    let mut engine = Engine::new(Network::build(d).unwrap(), 1);
    // Roads in the order the crossroads builds them.
    let (eb_in, eb_out, nb_in, nb_out) = (0, 1, 4, 5);
    engine.transit = Some(Transit::new(TransitData {
        trip_type: vec![vtype::BUS],
        trip_route: vec![0],
        trip_stops: vec![0, 2],
        stop_edge: vec![nb_in, nb_out],
        stop_frac: vec![0.1, 0.5],
        stop_time: vec![5.0, 90.0],
    }));
    if priority {
        assert_eq!(engine.set_edits(&[Edit::Priority { tls: 0 }]), 1);
    }
    engine.set_time(0.0);
    for k in 0..60 {
        engine.add_trip(Trip {
            depart: k as f64 * 2.0,
            from: eb_in,
            to: eb_out,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    let mut through_at = None;
    let mut stopped = false;
    run_until(&mut engine, 90.0, |e| {
        if let Some(bus) = e.vehs.iter().find(|v| v.alive() && v.vtype == vtype::BUS) {
            if through_at.is_none() && bus.route_idx >= 1 {
                through_at = Some(e.time);
            }
            stopped |= bus.route_idx == 0 && bus.pos > 40.0 && bus.speed < 0.5;
        }
    });
    (through_at.expect("the bus never crossed"), stopped)
}

#[test]
fn signal_priority_gets_a_bus_its_green_sooner() {
    // Without priority the bus waits for the east-west green to run to its longest.
    let (without, stopped) = bus_through_crossroads(false);
    assert!(stopped && without > 45.0, "without priority: {without} s");
    // With it, the east-west green ends as soon as it may and the bus drives through.
    let (with, stopped) = bus_through_crossroads(true);
    assert!(
        !stopped && with < 35.0,
        "with priority: {with} s, stopped {stopped}"
    );
}

#[test]
fn a_queue_of_trams_keeps_its_green_while_it_moves_up() {
    // Actuated greens: north-south first, then east-west, each with its yellow.
    let mut d = signalled_crossroads_data(&[
        (30.0, "rrrrGG"),
        (3.0, "rrrryy"),
        (30.0, "GGGGrr"),
        (3.0, "yyyyrr"),
    ]);
    for p in [0, 2] {
        d.phase_min_dur[p] = 5.0;
        d.phase_max_dur[p] = 50.0;
    }
    let mut engine = Engine::new(Network::build(d).unwrap(), 1);
    engine.set_time(0.0);
    // Roads in the order the crossroads builds them.
    let (eb_in, eb_out, nb_in, nb_out) = (0, 1, 4, 5);
    // Three trams wait at the red from the west, nose to tail; cars keep coming from the
    // south, calling their green back as soon as they can.
    let lane = engine.net.edge_lanes(eb_in).start;
    let length = engine.net.d.lane_length[lane as usize];
    let trams: Vec<(u32, u32)> = (0..3)
        .map(|k| {
            let pos = length - 1.0 - 34.0 * k as f32;
            let v = engine.insert_at(vtype::TRAM, vec![eb_in, eb_out], lane, pos, 0.0);
            (v, engine.vehs[v as usize].serial)
        })
        .collect();
    for k in 0..60 {
        engine.add_trip(Trip {
            depart: k as f64 * 3.0,
            from: nb_in,
            to: nb_out,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    let mut greens = 0;
    let mut last = engine.tls_phase[0];
    let mut crossed_in = Vec::new();
    run_until(&mut engine, 180.0, |e| {
        if e.tls_phase[0] == 2 && last != 2 {
            greens += 1;
        }
        last = e.tls_phase[0];
        for (i, &(v, serial)) in trams.iter().enumerate() {
            let veh = &e.vehs[v as usize];
            let gone = !veh.alive() || veh.serial != serial || veh.route_idx >= 1;
            if gone && !crossed_in.iter().any(|&(t, _)| t == i) {
                crossed_in.push((i, greens));
            }
        }
    });
    assert_eq!(crossed_in.len(), 3, "trams through: {crossed_in:?}");
    assert!(
        crossed_in.iter().all(|&(_, g)| g == 1),
        "the trams needed more than one green: {crossed_in:?}"
    );
}

#[test]
fn a_tram_held_behind_another_at_its_stop_serves_it_there() {
    use crate::transit::{Transit, TransitData};
    let (b, e0, e1) = straight_road(500.0, 1);
    let mut engine = Engine::new(b.build(), 3);
    // Two trams 5 s apart, both due to leave the stop half way along the first road at 60 s.
    engine.transit = Some(Transit::new(TransitData {
        trip_type: vec![vtype::TRAM, vtype::TRAM],
        trip_route: vec![0, 1],
        trip_stops: vec![0, 3, 6],
        stop_edge: vec![e0, e0, e1, e0, e0, e1],
        stop_frac: vec![0.1, 0.5, 0.5, 0.1, 0.5, 0.5],
        stop_time: vec![5.0, 60.0, 150.0, 10.0, 60.0, 150.0],
    }));
    engine.set_time(0.0);
    let lane0 = engine.net.edge_lanes(e0).start;
    let stop = 0.5 * engine.net.d.lane_length[lane0 as usize];
    let mut past: Vec<f64> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    run_until(&mut engine, 120.0, |e| {
        for v in e
            .vehs
            .iter()
            .filter(|v| v.alive() && v.vtype == vtype::TRAM)
        {
            let beyond = v.lane != lane0 || v.pos > stop + 40.0;
            if beyond && seen.insert(v.serial) {
                past.push(e.time);
            }
        }
    });
    assert_eq!(past.len(), 2, "trams past the stop: {past:?}");
    // The second served the stop behind the first and followed it out, instead of moving up
    // and standing there again for its minimum dwell.
    assert!(past[0] >= 60.0, "the first left early: {past:?}");
    assert!(past[1] - past[0] < 10.0, "the second left late: {past:?}");
}

#[test]
fn buses_keep_to_the_rightmost_lane_a_bus_lane_where_there_is_one() {
    let (b, e0, e1) = straight_road(600.0, 2);
    let mut engine = Engine::new(b.build(), 4);
    // The second road's right lane is for buses.
    let edit = Edit::LaneClasses {
        edge: e1,
        lane: 0,
        classes: vclass::BUS,
    };
    assert_eq!(engine.set_edits(&[edit]), 1);
    let left = engine.net.edge_lanes(e0).start + 1;
    let bus = engine.insert_at(vtype::BUS, vec![e0, e1], left, 50.0, 10.0);
    let bus_lane = engine.net.edge_lanes(e1).start;
    for k in 0..40 {
        engine.add_trip(Trip {
            depart: k as f64 * 2.0,
            from: e0,
            to: e1,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    let mut moved_right = false;
    let mut on_bus_lane = false;
    run_until(&mut engine, 100.0, |e| {
        let v = &e.vehs[bus as usize];
        if v.alive() && v.route_idx == 0 && v.lane == left - 1 {
            moved_right = true;
        }
        if v.alive() && v.route_idx == 1 {
            assert!(
                moved_right,
                "the bus reached the second road in the left lane"
            );
            on_bus_lane |= v.lane == bus_lane;
            assert!(
                !on_bus_lane || v.lane == bus_lane,
                "the bus left the bus lane at t={}",
                e.time
            );
        }
        for &u in e.vehicles_on(bus_lane) {
            assert_eq!(
                e.vehs[u as usize].vtype,
                vtype::BUS,
                "a car in the bus lane"
            );
        }
    });
    assert!(on_bus_lane, "the bus never drove in the bus lane");
}

#[test]
fn a_bus_line_shows_its_path_and_how_late_its_buses_run() {
    use crate::transit::{Transit, TransitData};
    // A bus from a stop on the first road to one on the second, due there 20 s after it
    // leaves: it cannot make it (200 m), so it runs late.
    let (b, e0, e1) = straight_road(400.0, 1);
    let mut engine = Engine::new(b.build(), 2);
    engine.transit = Some(Transit::new(TransitData {
        trip_type: vec![vtype::BUS],
        trip_route: vec![0],
        trip_stops: vec![0, 2],
        stop_edge: vec![e0, e1],
        stop_frac: vec![0.5, 0.5],
        stop_time: vec![10.0, 30.0],
    }));
    engine.set_time(0.0);
    assert_eq!(engine.transit_path(0), vec![e0, e1]);
    assert!(engine.transit_path(1).is_empty());
    let mut state = Vec::new();
    let mut late_seen = 0.0f32;
    run_until(&mut engine, 60.0, |e| {
        e.write_transit_state(&mut state);
        if let [trip, late] = state[..] {
            assert_eq!(trip, 0.0);
            late_seen = late_seen.max(late);
        }
    });
    assert!(late_seen > 5.0, "the bus ran {late_seen} s late");
}

use crate::transit::{Added, LINE_DWELL, LINE_PACE, LINE_TAG};

/// A bus line on a 400 m road both ways: `per_way` trips each way every 600 s from 06:00,
/// and one trip of another line.
fn bus_line(per_way: usize) -> (Engine, u32, u32) {
    use crate::transit::{Transit, TransitData};
    let mut b = Builder::default();
    let (j0, j1) = (b.junction(0.0, 0.0), b.junction(400.0, 0.0));
    let east = b.road(j0, j1, 1, 13.9);
    let west = b.road(j1, j0, 1, 13.9);
    let mut d = TransitData {
        trip_stops: vec![0],
        ..TransitData::default()
    };
    let mut add = |route: u16, edge: u32, start: f32| {
        d.trip_type.push(vtype::BUS);
        d.trip_route.push(route);
        d.stop_edge.extend([edge, edge]);
        d.stop_frac.extend([0.2, 0.8]);
        d.stop_time.extend([start, start + 60.0]);
        d.trip_stops.push(d.stop_edge.len() as u32);
    };
    for k in 0..per_way {
        add(0, east, 21_600.0 + 600.0 * k as f32);
        add(0, west, 21_900.0 + 600.0 * k as f32);
    }
    add(1, east, 21_700.0);
    let mut engine = Engine::new(b.build(), 3);
    engine.transit = Some(Transit::new(d));
    (engine, east, west)
}

/// The first departures of the trips that run, by road.
fn departures(engine: &Engine, edge: u32) -> Vec<f32> {
    let tr = engine.transit.as_ref().unwrap();
    tr.order
        .iter()
        .filter(|&&t| tr.data.stop_edge[tr.data.trip_stops[t as usize] as usize] == edge)
        .map(|&t| tr.start_time(t as usize) as f32)
        .collect()
}

#[test]
fn a_line_run_twice_as_often_gets_trips_between_its_own() {
    let (mut engine, east, west) = bus_line(4);
    engine.set_time(21_000.0);
    let twice = Edit::Frequency {
        route: 0,
        factor: 2.0,
    };
    assert_eq!(engine.set_edits(std::slice::from_ref(&twice)), 1);
    // Four trips each way become seven: a copy halfway between each two of the
    // timetable's, none past its last trip; the other line's trip runs as before.
    let east_times = departures(&engine, east);
    assert_eq!(east_times.len(), 4 + 3 + 1);
    assert!(east_times.contains(&21_900.0) && east_times.contains(&21_700.0));
    assert_eq!(*east_times.last().unwrap(), 23_400.0);
    assert_eq!(departures(&engine, west).len(), 7);
    let tr = engine.transit.as_ref().unwrap();
    assert_eq!(tr.timetabled, 9);
    assert_eq!(tr.added.len(), 6);
    assert_eq!(
        tr.added[0],
        Added::Copy {
            trip: 0,
            shift: 300.0
        }
    );
    // Set again, the same copies run: the arrays do not grow.
    engine.set_edits(std::slice::from_ref(&twice));
    assert_eq!(engine.transit.as_ref().unwrap().added.len(), 6);
    // Taken back, the timetable runs as loaded.
    engine.set_edits(&[]);
    assert_eq!(departures(&engine, east).len(), 5);
    let mut service = Vec::new();
    engine.transit.as_ref().unwrap().write_service(&mut service);
    assert_eq!(service[..4], [9, 6, 9, 0]);
    assert_eq!(service[4..6], [0, 300f32.to_bits()]);

    // The copies drive: buses start every 300 s eastbound from 06:00 to its last trip.
    engine.set_edits(&[twice]);
    let mut started = Vec::new();
    run_until(&mut engine, 2_600.0, |e| {
        for v in e.vehs.iter().filter(|v| v.alive()) {
            if let Some(run) = &v.transit
                && !started.contains(&run.trip)
            {
                started.push(run.trip);
            }
        }
    });
    let tr = engine.transit.as_ref().unwrap();
    let mut east_started: Vec<f64> = started
        .iter()
        .filter(|&&t| tr.data.stop_edge[tr.data.trip_stops[t as usize] as usize] == east)
        .map(|&t| tr.start_time(t as usize))
        .collect();
    east_started.sort_by(f64::total_cmp);
    assert_eq!(
        east_started,
        [
            21_600.0, 21_700.0, 21_900.0, 22_200.0, 22_500.0, 22_800.0, 23_100.0, 23_400.0
        ]
    );
}

#[test]
fn a_line_run_less_often_keeps_an_even_spread_and_buses_on_the_road_finish() {
    let (mut engine, east, west) = bus_line(6);
    // Half as often from 06:00: every other trip each way.
    engine.set_time(21_000.0);
    let half = Edit::Frequency {
        route: 0,
        factor: 0.5,
    };
    engine.set_edits(&[half]);
    assert_eq!(
        departures(&engine, east),
        [21_700.0, 22_200.0, 23_400.0, 24_600.0]
    );
    assert_eq!(departures(&engine, west).len(), 3);
    // No service, out of range and unknown lines: the last two do not fit.
    let none = Edit::Frequency {
        route: 0,
        factor: 0.0,
    };
    let too_many = Edit::Frequency {
        route: 0,
        factor: 5.0,
    };
    let unknown = Edit::Frequency {
        route: 9,
        factor: 2.0,
    };
    assert_eq!(engine.set_edits(&[none.clone(), too_many, unknown]), 1);
    assert_eq!(departures(&engine, east), [21_700.0]);
    assert!(departures(&engine, west).is_empty());

    // A bus on the road when its line is cut finishes its trip; trips already due are not
    // started again when the timetable is restored.
    engine.set_edits(&[]);
    run_until(&mut engine, 630.0, |_| {});
    let on_road = |engine: &Engine| {
        engine
            .vehs
            .iter()
            .filter(|v| v.alive() && v.transit.as_ref().is_some_and(|r| r.trip == 0))
            .count()
    };
    assert_eq!(on_road(&engine), 1);
    engine.set_edits(std::slice::from_ref(&none));
    assert_eq!(on_road(&engine), 1);
    let started = engine.transit.as_ref().unwrap().started;
    engine.set_edits(&[]);
    run_until(&mut engine, 10.0, |_| {});
    assert_eq!(engine.transit.as_ref().unwrap().started, started);
}

#[test]
fn a_new_bus_line_runs_from_stop_to_stop_every_headway() {
    // The road both ways with one timetabled trip (another line's), and a new line on the
    // eastbound road: three stops, every 10 min from 06:00 to 06:30.
    let (mut engine, east, west) = bus_line(0);
    engine.set_time(21_000.0);
    let line = crate::edits::Line {
        route: 2,
        vtype: vtype::BUS,
        headway: 600.0,
        first: 21_600.0,
        last: 23_400.0,
        stops: vec![(east, 0.1), (east, 0.5), (east, 0.9)],
    };
    assert_eq!(engine.set_edits(&[Edit::Line(line.clone())]), 1);
    assert_eq!(
        departures(&engine, east),
        [21_600.0, 21_700.0, 22_200.0, 22_800.0, 23_400.0]
    );
    // Timed at the speed limit times LINE_PACE, with LINE_DWELL at each stop.
    let free = engine.net.edge_length[east as usize] / engine.net.edge_speed[east as usize];
    let leg = 0.4 * free * LINE_PACE + LINE_DWELL;
    let tr = engine.transit.as_ref().unwrap();
    let plan = &tr.made[0].plan;
    assert_eq!(plan.path, [east]);
    assert_eq!(plan.served.len(), 3);
    assert!((plan.served[2].1 - 2.0 * leg).abs() < 0.01);
    assert!((plan.metres - 0.8 * engine.net.edge_length[east as usize]).abs() < 0.01);
    let first = tr.made[0].trips[0] as usize;
    assert_eq!(tr.data.trip_route[first], 2);
    assert!(
        (tr.data.stop_time[tr.data.trip_stops[first] as usize + 1] - 21_600.0 - leg).abs() < 0.01
    );

    // The app hears of it: four trips of line 0, and its stops' times.
    let mut service = Vec::new();
    tr.write_service(&mut service);
    assert_eq!(service[..4], [1, 4, 5, 1]);
    assert_eq!(service[4..6], [LINE_TAG, 21_600f32.to_bits()]);
    let section = &service[4 + 2 * 4 + 5..];
    assert_eq!(section[0], 0);
    assert_eq!(section[2], 3);
    assert_eq!(section[3..5], [0, 0]);

    // Set again, the same trips run.
    engine.set_edits(&[Edit::Line(line.clone())]);
    assert_eq!(engine.transit.as_ref().unwrap().added.len(), 4);

    // A stop behind the last on its road, or on a road it cannot reach, is left out; with
    // one stop left the line does not run.
    let back = crate::edits::Line {
        stops: vec![(east, 0.9), (east, 0.1), (west, 0.5)],
        ..line.clone()
    };
    assert_eq!(engine.set_edits(&[Edit::Line(back.clone())]), 0);
    assert!(engine.plan_line(vtype::BUS, &back.stops).is_none());
    assert_eq!(departures(&engine, east), [21_700.0]);
    // Neither does a train, nor a headway out of range.
    let train = crate::edits::Line {
        vtype: vtype::TRAIN,
        ..line.clone()
    };
    let often = crate::edits::Line {
        headway: 30.0,
        ..line.clone()
    };
    assert_eq!(engine.set_edits(&[Edit::Line(train), Edit::Line(often)]), 0);

    // Its buses drive the line: four start and serve all three stops.
    engine.set_edits(&[Edit::Line(line)]);
    let mut served = std::collections::HashMap::new();
    run_until(&mut engine, 2_500.0, |e| {
        for v in e.vehs.iter().filter(|v| v.alive()) {
            if let Some(run) = &v.transit
                && e.transit.as_ref().unwrap().data.trip_route[run.trip as usize] == 2
            {
                let n = served.entry(run.trip).or_insert(0);
                *n = (*n).max(run.next);
            }
        }
    });
    assert_eq!(served.len(), 4, "{served:?}");
    assert!(served.values().all(|&n| n >= 2), "{served:?}");
}

/// Two zones 3 km apart on a road east, both with homes and jobs (at the roads' starts),
/// and a bus between them every 10 min through the morning peak.
fn two_zones() -> (Engine, u32, u32) {
    use crate::transit::{Transit, TransitData};
    let (b, e0, e1) = straight_road(3000.0, 1);
    let mut engine = Engine::new(b.build(), 4);
    let mut d = TransitData {
        trip_stops: vec![0],
        ..TransitData::default()
    };
    for k in 0..12 {
        let start = 6.5 * 3600.0 + 600.0 * k as f32;
        d.trip_type.push(vtype::BUS);
        d.trip_route.push(0);
        d.stop_edge.extend([e0, e1]);
        d.stop_frac.extend([0.1, 0.1]);
        d.stop_time.extend([start, start + 300.0]);
        d.trip_stops.push(d.stop_edge.len() as u32);
    }
    engine.transit = Some(Transit::new(d));
    let demand = Demand::new(
        &engine.net,
        vec![e0, e1],
        &[1.0, 1.0],
        &[1.0, 1.0],
        10_000.0,
    );
    engine.demand = Some(demand);
    (engine, e0, e1)
}

#[test]
fn riders_take_the_bus_and_more_buses_take_cars_off_the_road() {
    use crate::riders::{
        ASC, BETA, BOARDING, CAR_EXTRA, WAIT_WEIGHT, WALK_DETOUR, WALK_SPEED, WALK_WEIGHT, pt_share,
    };
    let (mut engine, _, _) = two_zones();
    engine.set_time(0.0);
    engine.start_riders(None);
    for _ in 0..10 {
        engine.step();
    }
    let riders = engine.riders.as_ref().unwrap();
    assert_eq!(riders.zones.len(), 2);
    assert!(riders.summary.ready && !riders.busy());
    // East: walk to the stop 300 m away, wait half of 10 min, board, ride 5 min and walk
    // again (walking and waiting count twice); no bus west.
    let (east, west) = if riders.zones.centre[0].0 < riders.zones.centre[1].0 {
        (0, 1)
    } else {
        (1, 0)
    };
    let walk = WALK_WEIGHT * 298.8 * WALK_DETOUR / WALK_SPEED;
    let (trips, time) = riders.pair_today(east, west);
    assert!(trips > 4_000.0, "{trips}");
    assert!((time - (2.0 * walk + WAIT_WEIGHT * 300.0 + BOARDING + 300.0)).abs() < 2.0);
    assert!(riders.pair_today(west, east).1.is_infinite());
    let share = pt_share(time, 3000.0 * 1.3 / (30.0 / 3.6) + CAR_EXTRA);
    assert!(share > 0.3 && share < 0.95, "{share} ({ASC}, {BETA})");
    let today = riders.summary.trips_today;
    assert!(today > 0.0);
    assert!((riders.summary.boardings_today[0] - today).abs() < 1e-6 * today);
    assert!(riders.factor.is_none());

    // Twice as often: shorter waits, more riders, fewer car trips east (none moved west,
    // where no bus runs).
    let twice = Edit::Frequency {
        route: 0,
        factor: 2.0,
    };
    engine.set_edits(&[twice]);
    for _ in 0..10 {
        engine.step();
    }
    let riders = engine.riders.as_ref().unwrap();
    let factor = riders.factor.clone().expect("car trips moved");
    let (to_east, to_west) = (factor[east * 2 + west], factor[west * 2 + east]);
    assert!(to_east < 1.0 && to_east > 0.3, "{to_east}");
    assert_eq!(to_west, 1.0);
    assert!(riders.summary.trips_now > today);
    assert!(riders.summary.car_moved > 0.0);

    // Taken back: as today.
    engine.set_edits(&[]);
    let riders = engine.riders.as_ref().unwrap();
    assert!(riders.factor.is_none());
    assert_eq!(riders.summary.trips_now, today);
}

#[test]
fn journey_times_between_places_walk_wait_and_ride() {
    use crate::riders::{WALK_DETOUR, WALK_SPEED};
    let (mut engine, _, _) = two_zones();
    engine.set_time(0.0);
    engine.start_riders(None);
    let places = [(6.0, 1.6), (3006.0, 1.6), (90_000.0, 0.0)];
    assert!(engine.riders.as_ref().unwrap().journeys(&places).is_none());
    for _ in 0..10 {
        engine.step();
    }
    // East: walk 300 m to the stop, wait half of 10 min, ride 5 min, walk 300 m; no way
    // west, nor to a place far from any stop.
    let walk = 298.8 * WALK_DETOUR / WALK_SPEED;
    let (today, now) = engine.riders.as_ref().unwrap().journeys(&places).unwrap();
    assert!(
        (today[1] - (2.0 * walk + 300.0 + 300.0)).abs() < 2.0,
        "{}",
        today[1]
    );
    assert!(today[3].is_infinite() && today[2].is_infinite());
    assert_eq!(today[0], 0.0);
    assert_eq!(now, today);
    // Twice as often: 23 buses in the peak's two hours (one between each two of the 12),
    // so a wait of half of 7,200 s / 23.
    engine.set_edits(&[Edit::Frequency {
        route: 0,
        factor: 2.0,
    }]);
    for _ in 0..10 {
        engine.step();
    }
    let (today2, now) = engine.riders.as_ref().unwrap().journeys(&places).unwrap();
    assert_eq!(today2, today);
    assert!(
        (now[1] - (today[1] - 300.0 + 3600.0 / 23.0)).abs() < 2.0,
        "{}",
        now[1]
    );
}

#[test]
fn car_trips_moved_to_public_transport_are_drawn_only_where_it_changed() {
    use crate::demand::Shift;
    use std::sync::Arc;
    let count = |factor: Option<f32>| {
        let (engine, e0, _) = two_zones();
        let mut demand = Demand::new(
            &engine.net,
            vec![e0, e0 + 1],
            &[1.0, 1.0],
            &[1.0, 1.0],
            20_000.0,
        );
        demand.set_shift(factor.map(|f| Shift {
            zone: vec![0, 1],
            zones: 2,
            factor: Arc::new(vec![1.0, f, f, 1.0]),
        }));
        let mut rng = Rng::new(9);
        let mut trips = Vec::new();
        for k in 0..2_880 {
            demand.generate(k as f64 * 30.0, 30.0, 1.0, &mut rng, &mut |t| {
                trips.push((t.from, t.to, t.depart.to_bits()))
            });
        }
        trips
    };
    // A factor of 1 draws nothing: the same trips as without.
    let today = count(None);
    assert_eq!(count(Some(1.0)), today);
    // Half the car trips between the zones, or half as many again; none within one.
    let between = |trips: &[(u32, u32, u64)]| trips.iter().filter(|t| t.0 != t.1).count() as f64;
    let n = between(&today);
    assert!(n > 5_000.0, "{n}");
    let half = between(&count(Some(0.5))) / n;
    let more = between(&count(Some(1.5))) / n;
    assert!((half - 0.5).abs() < 0.05, "{half}");
    assert!((more - 1.5).abs() < 0.05, "{more}");
}

#[test]
fn a_crossroads_made_a_roundabout_keeps_traffic_and_buses_going() {
    use crate::transit::{Transit, TransitData};
    let (base, roads) = crossroads(false);
    let (ring, _) = crossroads(true);
    let mut engine = Engine::new(Network::build(base).unwrap(), 8);
    let lane = |engine: &Engine, e: u32| engine.net.edge_lanes(e).start;
    let (eb_in, eb_out) = (roads[0], roads[1]);
    // A bus from the eastbound road in to a stop on the road out, due there at 60 s.
    engine.transit = Some(Transit::new(TransitData {
        trip_type: vec![vtype::BUS],
        trip_route: vec![0],
        trip_stops: vec![0, 2],
        stop_edge: vec![eb_in, eb_out],
        stop_frac: vec![0.2, 0.5],
        stop_time: vec![1.0, 60.0],
    }));
    engine.set_time(0.0);
    let (lane_in, lane_out) = (lane(&engine, eb_in), lane(&engine, eb_out));
    let near_end = engine.insert_at(vtype::CAR, vec![eb_in, eb_out], lane_in, 275.0, 0.0);
    let coming = engine.insert_at(vtype::CAR, vec![eb_in, eb_out], lane_in, 150.0, 10.0);
    let leaving = engine.insert_at(vtype::CAR, vec![eb_out], lane_out, 100.0, 10.0);
    run_until(&mut engine, 2.0, |_| {});
    let bus = engine
        .vehs
        .iter()
        .position(|v| v.alive() && v.vtype == vtype::BUS)
        .expect("the bus started") as u32;
    let leaving_at = engine.vehs[leaving as usize].pos;

    // The roads in end 20 m sooner, the roads out start 20 m later; the lanes across the
    // junction go.
    let mut pieces: Vec<LanePiece> = roads
        .iter()
        .enumerate()
        .map(|(k, &e)| LanePiece {
            old: lane(&engine, e),
            from: 0.0,
            lane: lane(&engine, e),
            shift: if k % 2 == 0 { 0.0 } else { -20.0 },
        })
        .collect();
    for old in roads.len() as u32..engine.net.lane_count() as u32 {
        pieces.push(LanePiece {
            old,
            from: 0.0,
            lane: NONE,
            shift: 0.0,
        });
    }
    engine
        .replace_network(ring, &pieces)
        .expect("a consistent network");
    let [_, _, west_south, south_east] = [8, 9, 10, 11];
    assert!(
        !engine.vehs[near_end as usize].alive(),
        "the car where the ring now is left"
    );
    let car = &engine.vehs[coming as usize];
    assert_eq!(car.route, vec![eb_in, west_south, south_east, eb_out]);
    let out = &engine.vehs[leaving as usize];
    assert!((out.pos - (leaving_at - 20.0)).abs() < 0.01);
    let bus_veh = &engine.vehs[bus as usize];
    assert_eq!(bus_veh.route, vec![eb_in, west_south, south_east, eb_out]);
    let stops: Vec<u32> = bus_veh
        .transit
        .as_ref()
        .unwrap()
        .stops
        .iter()
        .map(|&(_, idx)| idx)
        .collect();
    assert_eq!(stops, vec![0, 3], "the bus keeps its stop on the road out");

    run_until(&mut engine, 150.0, assert_no_overlaps);
    assert!(engine.edge_entered[west_south as usize] >= 2);
    assert_eq!((engine.stats.arrived, engine.stats.teleported), (3, 0));
    let tr = engine.transit.as_ref().unwrap();
    assert_eq!((tr.started, tr.failed), (1, 0));
}

#[test]
fn homes_and_jobs_added_while_running_make_and_draw_trips() {
    use crate::demand::Demand;
    // Homes along the direct road, jobs past the junction it leads to.
    let (mut engine, [direct, up, down, last]) = two_ways();
    let mut demand = Demand::new(
        &engine.net,
        vec![direct, last],
        &[1.0, 0.0],
        &[0.0, 1.0],
        20_000.0,
    );
    demand.decay = 1e6;
    engine.demand = Some(demand);
    engine.set_time(8.0 * 3600.0);
    let made = |e: &Engine| e.stats.departed + e.stats.no_route + e.stats.insert_failed;
    let lane_up = engine.net.edge_lanes(up).start;
    let mut up_there = 0;
    run_until(&mut engine, 120.0, |e| {
        up_there += e.vehicles_on(lane_up).len()
    });
    let before = made(&engine);
    assert!(before > 0, "the homes make trips");
    assert_eq!(up_there, 0, "no homes up there yet");

    // Homes grow along the road up, with as many trips a day again.
    engine.demand.as_mut().unwrap().set_weights(
        &engine.net,
        vec![direct, up, last],
        &[1.0, 1.0, 0.0],
        &[0.0, 0.0, 1.0],
        40_000.0,
    );
    run_until(&mut engine, 120.0, |e| {
        up_there += e.vehicles_on(lane_up).len()
    });
    assert!(up_there > 0, "the new homes make trips");
    let after = made(&engine) - before;
    assert!(
        after as f64 > before as f64 * 1.5,
        "twice the trips a day: {before} then {after} in two minutes"
    );

    // Jobs grow along the road down: trips go there too.
    let mut to_down = 0;
    let ends_down = |e: &Engine| {
        e.vehs
            .iter()
            .filter(|v| v.alive() && v.route.last() == Some(&down))
            .count()
    };
    assert_eq!(ends_down(&engine), 0);
    engine.demand.as_mut().unwrap().set_weights(
        &engine.net,
        vec![direct, up, down, last],
        &[1.0, 1.0, 0.0, 0.0],
        &[0.0, 0.0, 1.0, 1.0],
        40_000.0,
    );
    run_until(&mut engine, 120.0, |e| to_down = to_down.max(ends_down(e)));
    assert!(to_down > 0, "the new jobs draw trips");
}

#[test]
fn reach_counts_homes_and_jobs_by_travel_time_measured() {
    use crate::demand::Demand;
    let (mut engine, [direct, up, down, last]) = two_ways();
    assert_eq!(engine.reach(&[up], 360.0, 1200.0), vec![[0.0, 0.0]]);
    // Homes past the junction the roads meet at, jobs on the way down to it.
    engine.demand = Some(Demand::new(
        &engine.net,
        vec![direct, down, last],
        &[200.0, 0.0, 1000.0],
        &[0.0, 500.0, 0.0],
        10_000.0,
    ));
    // From the last road: its own homes, nothing it cannot drive to.
    assert_eq!(engine.reach(&[last], 360.0, 1200.0), vec![[1000.0, 0.0]]);
    // From the road up: jobs one road on, homes two roads on, each weighted by the time
    // to get to the end of its road.
    let t_down = engine.travel_time[down as usize];
    let t_last = engine.travel_time[last as usize];
    assert!(t_down > 30.0 && t_last > 30.0);
    let [homes, jobs] = engine.reach(&[up], 360.0, 1200.0)[0];
    assert!(
        (jobs - 500.0 * (-t_down / 360.0).exp()).abs() < 1.0,
        "{jobs}"
    );
    assert!(
        (homes - 1000.0 * (-(t_down + t_last) / 360.0).exp()).abs() < 2.0,
        "{homes}"
    );
    // Not beyond the time allowed.
    let [homes, jobs] = engine.reach(&[up], 360.0, t_down + 1.0)[0];
    assert!(jobs > 0.0 && homes == 0.0);
    // A jam on the road down puts both further away.
    engine.travel_time[down as usize] *= 3.0;
    let [later_homes, later_jobs] = engine.reach(&[up], 360.0, 1200.0)[0];
    assert!(later_jobs < 0.8 * jobs && later_homes > 0.0);
    // Closed, nothing past it is in reach; sources off the network count nothing.
    engine.set_closed(&[down]);
    assert_eq!(
        engine.reach(&[up, 9999], 360.0, 1200.0),
        vec![[0.0, 0.0]; 2]
    );
}

#[test]
fn drivers_take_another_way_when_the_road_ahead_jams() {
    // On a 3 km road towards A, with two ways on from A: straight (1 km) or a 1.4 km detour
    // through C. The straight way jams while the car is on its way to A, after it first
    // weighed its route (a minute in).
    let run = |jam: bool, reroute: bool| {
        let mut b = Builder::default();
        let s = b.junction(-3000.0, 0.0);
        let a = b.junction(0.0, 0.0);
        let m = b.junction(1000.0, 0.0);
        let c = b.junction(500.0, 500.0);
        let z = b.junction(1500.0, 0.0);
        let entry = b.road(s, a, 1, 13.9);
        let direct = b.road(a, m, 1, 13.9);
        let up = b.road(a, c, 1, 13.9);
        let down = b.road(c, m, 1, 13.9);
        let last = b.road(m, z, 1, 13.9);
        let lane = |b: &Builder, e| b.lane(e, 0);
        for (from, to, j) in [
            (entry, direct, a),
            (entry, up, a),
            (up, down, c),
            (direct, last, m),
            (down, last, m),
        ] {
            let (fl, tl) = (lane(&b, from), lane(&b, to));
            b.connect(fl, tl, j, dir::STRAIGHT, b'M');
        }
        let mut engine = Engine::new(b.build(), 3);
        engine.reroute = reroute;
        let start = engine.net.edge_lanes(entry).start;
        let v = engine.insert_at(vtype::CAR, vec![entry, direct, last], start, 10.0, 13.0);
        let mut took_detour = false;
        let steps = (400.0 / DT) as u32;
        for k in 0..steps {
            if jam && k == (70.0 / DT) as u32 {
                engine.travel_time[direct as usize] = 1000.0;
            }
            engine.step();
            let veh = &engine.vehs[v as usize];
            if veh.alive() && veh.lane != NONE && engine.net.d.lane_edge[veh.lane as usize] == up {
                took_detour = true;
            }
        }
        assert_eq!(engine.stats.arrived, 1);
        (took_detour, engine.stats.en_route_reroutes)
    };
    assert_eq!(run(true, true), (true, 1));
    // Nothing jams: the driver keeps to the way chosen.
    assert_eq!(run(false, true), (false, 0));
    // Without re-routing, drivers stay in the jam.
    assert_eq!(run(true, false), (false, 0));
}

#[test]
fn drivers_move_over_for_an_exit_lane_before_it_begins() {
    // A two-lane motorway (600 m at 100 km/h) widens to three for the last 190 m before an
    // exit, which only the new right-hand lane leads off: as on the A3 at Jankomir. A driver
    // in the left lane bound for the exit gets into the right lane before the third begins,
    // as drivers do from the signs, rather than crossing two lanes in 190 m.
    let mut b = Builder::default();
    let a = b.junction(0.0, 0.0);
    let m = b.junction(600.0, 0.0);
    let x = b.junction(790.0, 0.0);
    let r = b.junction(900.0, 60.0);
    let z = b.junction(1500.0, 0.0);
    let approach = b.road(a, m, 2, 27.8);
    let widened = b.road(m, x, 3, 27.8);
    let ramp = b.road(x, r, 1, 16.7);
    let on = b.road(x, z, 2, 27.8);
    for (from, to) in [(0, 0), (0, 1), (1, 2)] {
        let (fl, tl) = (b.lane(approach, from), b.lane(widened, to));
        b.connect(fl, tl, m, dir::STRAIGHT, b'M');
    }
    let (fl, tl) = (b.lane(widened, 0), b.lane(ramp, 0));
    b.connect(fl, tl, x, dir::RIGHT, b'M');
    for (from, to) in [(1, 0), (2, 1)] {
        let (fl, tl) = (b.lane(widened, from), b.lane(on, to));
        b.connect(fl, tl, x, dir::STRAIGHT, b'M');
    }
    let mut engine = Engine::new(b.build(), 5);
    let left = engine.net.edge_lanes(approach).start + 1;
    let v = engine.insert_at(vtype::CAR, vec![approach, widened, ramp], left, 10.0, 25.0);
    let mut last_on_approach = NONE;
    let mut took_ramp = false;
    run_until(&mut engine, 90.0, |e| {
        let veh = &e.vehs[v as usize];
        if !veh.alive() || veh.lane == NONE {
            return;
        }
        match e.net.d.lane_edge[veh.lane as usize] {
            edge if edge == approach => last_on_approach = veh.lane,
            edge if edge == ramp => took_ramp = true,
            _ => {}
        }
    });
    assert_eq!(last_on_approach, engine.net.edge_lanes(approach).start);
    assert!(took_ramp);
    assert_eq!((engine.stats.arrived, engine.stats.teleported), (1, 0));
}

#[test]
fn regional_traffic_across_the_map_s_edge_stays_regional() {
    // A road leaves the map 2 km from a town and 24 km from a city with 20 times its jobs
    // and homes. On a regional road, much of the traffic coming in stops in the town; on a
    // motorway, most of it drives on to the city.
    let town_share = |speed: f32| {
        let mut b = Builder::default();
        let j: Vec<u32> = [0.0, 2_000.0, 2_500.0, 24_000.0, 25_000.0]
            .iter()
            .map(|&x| b.junction(x, 0.0))
            .collect();
        let entry = b.road(j[0], j[1], 1, speed);
        let exit = b.road(j[1], j[0], 1, speed);
        let town = b.road(j[1], j[2], 1, 13.9);
        b.road(j[2], j[3], 1, 25.0);
        let city = b.road(j[3], j[4], 1, 13.9);
        let net = b.build();
        let mut demand = Demand::new(&net, vec![town, city], &[1.0, 20.0], &[1.0, 20.0], 0.0);
        demand.set_gateways(
            &net,
            &[Gateway {
                entry,
                exit,
                daily: 10_000.0,
                through: 0.0,
            }],
        );
        let mut rng = Rng::new(5);
        let (mut to_town, mut all) = (0u32, 0u32);
        let mut t = 0.0;
        while t < 86_400.0 {
            demand.generate(t, 0.5, 1.0, &mut rng, &mut |trip| {
                if trip.flags == trip::ENTER {
                    all += 1;
                    to_town += (trip.to == town) as u32;
                }
            });
            t += 0.5;
        }
        assert!(all > 4_000, "{all} trips in");
        to_town as f32 / all as f32
    };
    let (regional, motorway) = (town_share(22.2), town_share(36.1));
    assert!(
        regional > 0.35 && regional > 2.0 * motorway,
        "to the town: {regional:.2} on a regional road, {motorway:.2} on a motorway"
    );
}

#[test]
fn a_train_keeps_its_timetable_and_dwells_at_stations() {
    use crate::transit::{Transit, TransitData};
    // A 3 km single track at 120 km/h with three stations. The train is due out of the middle
    // one at 10 s, long before it can get there: it still stands there half a minute.
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(3000.0, 0.0);
    let track = b.road(j0, j1, 1, 33.3);
    let lane = b.lane(track, 0);
    b.d.lane_allow[lane as usize] = vclass::RAIL;
    let mut engine = Engine::new(b.build(), 2);
    engine.transit = Some(Transit::new(TransitData {
        trip_type: vec![vtype::TRAIN],
        trip_route: vec![0],
        trip_stops: vec![0, 3],
        stop_edge: vec![track, track, track],
        stop_frac: vec![0.05, 0.5, 0.95],
        stop_time: vec![0.0, 10.0, 200.0],
    }));
    engine.set_time(0.0);
    let middle = 0.5 * engine.net.d.lane_length[lane as usize];
    let (mut stood, mut top, mut seen) = (0.0f32, 0.0f32, false);
    run_until(&mut engine, 300.0, |e| {
        for v in e
            .vehs
            .iter()
            .filter(|v| v.alive() && v.vtype == vtype::TRAIN)
        {
            seen = true;
            top = top.max(v.speed);
            if (v.pos - middle).abs() < 3.0 && v.speed < 0.1 {
                stood += DT;
            }
        }
    });
    assert!(seen, "the train never started");
    // Half a minute from when it comes to a stand (the count misses the last of braking).
    assert!(stood >= 28.0, "stood {stood} s at the middle station");
    assert!(top > 25.0, "top speed {top} m/s");
    let tr = engine.transit.as_ref().unwrap();
    assert_eq!((tr.started, tr.failed), (1, 0));
    assert_eq!(engine.stats.arrived, 1);
}

#[test]
fn a_level_crossing_closes_for_a_train_and_opens_after_it() {
    use crate::transit::{Transit, TransitData};
    // A railway west to east at 120 km/h, crossed 1.5 km along by a road north to south with
    // a car every 5 s. The train starts 1.4 km before the crossing.
    let mut b = Builder::default();
    let (w, c, e) = (
        b.junction(0.0, 0.0),
        b.junction(1500.0, 0.0),
        b.junction(3000.0, 0.0),
    );
    let (n, s) = (b.junction(1500.0, -500.0), b.junction(1500.0, 500.0));
    let rail_in = b.road(w, c, 1, 33.3);
    let rail_out = b.road(c, e, 1, 33.3);
    let road_in = b.road(n, c, 1, 13.9);
    let road_out = b.road(c, s, 1, 13.9);
    let road = vclass::PASSENGER | vclass::TRUCK | vclass::BUS;
    for (edge, allow) in [
        (rail_in, vclass::RAIL),
        (rail_out, vclass::RAIL),
        (road_in, road),
        (road_out, road),
    ] {
        let lane = b.lane(edge, 0);
        b.d.lane_allow[lane as usize] = allow;
    }
    let (ri, ro) = (b.lane(rail_in, 0), b.lane(rail_out, 0));
    let train_link = b.connect(ri, ro, c, dir::STRAIGHT, b'M');
    let (ci, co) = (b.lane(road_in, 0), b.lane(road_out, 0));
    let car_link = b.connect(ci, co, c, dir::STRAIGHT, b'o');
    b.set_logic(c, &[(0, 0b10), (0b01, 0b01)]);
    let mut engine = Engine::new(b.build(), 4);
    assert_eq!(engine.net.crossings, vec![c]);
    assert_eq!(engine.net.link_crossing[car_link as usize], 0);
    assert_eq!(engine.net.rail_crossing[train_link as usize], 0);
    engine.transit = Some(Transit::new(TransitData {
        trip_type: vec![vtype::TRAIN],
        trip_route: vec![0],
        trip_stops: vec![0, 2],
        stop_edge: vec![rail_in, rail_out],
        stop_frac: vec![0.05, 0.95],
        stop_time: vec![0.0, 150.0],
    }));
    engine.set_time(0.0);
    for k in 0..30 {
        engine.add_trip(Trip {
            depart: 5.0 * k as f64,
            from: road_in,
            to: road_out,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    let car_via = engine.net.d.link_via[car_link as usize];
    let train_via = engine.net.d.link_via[train_link as usize];
    let (mut closed_at, mut opened_at, mut train_at) = (None, None, None);
    let mut cars_waited = 0.0f32;
    run_until(&mut engine, 300.0, |e| {
        assert_no_overlaps(e);
        let red = e.link_state(car_link) == b'r';
        if e.link_state(car_link) != b'o' && closed_at.is_none() {
            closed_at = Some(e.time);
        }
        if closed_at.is_some() && opened_at.is_none() && e.link_state(car_link) == b'o' {
            opened_at = Some(e.time);
        }
        if train_at.is_none() && !e.vehicles_on(train_via).is_empty() {
            train_at = Some(e.time);
        }
        // Nobody drives onto the crossing once the barriers are down while the train is near.
        if red && train_at.is_some() {
            assert!(
                e.vehicles_on(car_via).is_empty(),
                "a car on the crossing at {}",
                e.time
            );
        }
        if red {
            cars_waited += e
                .vehicles_on(ci)
                .iter()
                .filter(|&&v| e.vehs[v as usize].speed < 0.1)
                .count() as f32
                * DT;
        }
    });
    let (closed, opened, train) = (closed_at.unwrap(), opened_at.unwrap(), train_at.unwrap());
    assert!(
        (25.0..40.0).contains(&(train - closed)),
        "closed {closed} s, train there at {train} s"
    );
    assert!(
        (36.0..50.0).contains(&(opened - closed)),
        "closed from {closed} s to {opened} s"
    );
    assert_eq!(engine.crossing_closures, vec![1]);
    // What the app is told: the crossing's junction, open, closed once, for as long.
    let mut out = Vec::new();
    engine.write_level_crossings(&mut out);
    assert_eq!(&out[..3], &[c as f32, 0.0, 1.0]);
    assert!(
        (out[3] - (opened - closed) as f32).abs() < 1.0,
        "closed {} s",
        out[3]
    );
    assert!(
        cars_waited > 20.0,
        "cars waited {cars_waited} s at the barriers"
    );
    let s = &engine.stats;
    assert_eq!(
        (s.arrived, s.teleported),
        (31, 0),
        "every car and the train arrive"
    );
}

fn crossing(
    lane: u32,
    pos: f32,
    kind: u8,
    junction: u32,
    per_hour: f32,
) -> crate::pedestrians::CrossingData {
    crate::pedestrians::CrossingData {
        lane_offsets: vec![0, 1],
        lanes: vec![lane],
        pos: vec![pos],
        kind: vec![kind],
        length: vec![7.0],
        junction: vec![junction],
        daily: vec![per_hour * 24.0],
        hourly: [1.0 / 24.0; 24],
    }
}

#[test]
fn drivers_give_way_to_pedestrians_on_a_zebra() {
    use crate::pedestrians::{Pedestrians, kind};
    // A zebra 200 m along a road with a car every 4 s; about a pedestrian every 20 s.
    let (b, e0, e1) = straight_road(500.0, 1);
    let net = b.build();
    let lane = net.edge_lanes(e0).start;
    let mut engine = Engine::new(net, 5);
    let data = crossing(lane, 200.0, kind::ZEBRA, NONE, 180.0);
    engine.pedestrians = Some(Pedestrians::new(data, &engine.net));
    for k in 0..75 {
        engine.add_trip(Trip {
            depart: 4.0 * k as f64,
            from: e0,
            to: e1,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    let (mut slowed, mut through_busy) = (0.0f32, 0);
    run_until(&mut engine, 500.0, |e| {
        assert_no_overlaps(e);
        let ped = e.pedestrians.as_ref().unwrap();
        let busy = ped.busy_until[0] > e.time + 1.0 && e.time - ped.walk_since[0] > 1.0;
        for &v in e.vehicles_on(lane) {
            let veh = &e.vehs[v as usize];
            if busy
                && veh.pos > 200.0
                && veh.pos - TYPES[veh.vtype as usize].length < 200.0
                && veh.speed > 1.0
            {
                through_busy += 1;
            }
            // Slow just before the crossing while pedestrians are on it.
            if busy && veh.pos > 170.0 && veh.pos < 200.0 && veh.speed < 5.0 {
                slowed += DT;
            }
        }
    });
    let ped = engine.pedestrians.as_ref().unwrap();
    assert!(ped.crossed >= 10, "{} pedestrians crossed", ped.crossed);
    assert!(
        slowed > 10.0,
        "drivers slowed for pedestrians for {slowed} s"
    );
    assert_eq!(through_busy, 0, "drivers drove through pedestrians");
    assert_eq!((engine.stats.arrived, engine.stats.teleported), (75, 0));
}

#[test]
fn a_crossing_with_its_own_signals_stops_drivers_at_most_once_a_minute() {
    use crate::pedestrians::{OWN_SIGNAL_GAP, Pedestrians, kind};
    let (b, e0, e1) = straight_road(500.0, 1);
    let net = b.build();
    let lane = net.edge_lanes(e0).start;
    let mut engine = Engine::new(net, 6);
    let data = crossing(lane, 200.0, kind::OWN_SIGNAL, NONE, 600.0);
    engine.pedestrians = Some(Pedestrians::new(data, &engine.net));
    for k in 0..100 {
        engine.add_trip(Trip {
            depart: 3.0 * k as f64,
            from: e0,
            to: e1,
            vtype: vtype::CAR,
            flags: 0,
        });
    }
    let mut reds: Vec<f64> = Vec::new();
    let mut was_red = false;
    run_until(&mut engine, 400.0, |e| {
        assert_no_overlaps(e);
        let red = e.pedestrians.as_ref().unwrap().state(0, e.time) != b'G';
        if red && !was_red {
            reds.push(e.time);
        }
        was_red = red;
    });
    assert!(reds.len() >= 4, "turned red at {reds:?}");
    assert!(
        reds.windows(2).all(|w| w[1] - w[0] >= OWN_SIGNAL_GAP),
        "turned red at {reds:?}"
    );
    let ped = engine.pedestrians.as_ref().unwrap();
    assert!(ped.crossed >= 30, "{} pedestrians crossed", ped.crossed);
    assert_eq!(engine.stats.teleported, 0);
}

#[test]
fn pedestrians_cross_a_signalled_junction_while_the_traffic_across_has_red() {
    use crate::pedestrians::{MIN_WALK, Pedestrians, kind};
    // The east-west road has 30 s of green, the north-south one 10 s (actuated, 5-60 s). A
    // crossing over the north road's southbound lane, just before the junction, gets a
    // pedestrian every 10 s: they walk only while north-south traffic has red, and the
    // east-west green (the phase they walk in) lasts at least their walk and clearance.
    let mut data = signalled_crossroads_data(&[
        (30.0, "GGGGrr"),
        (3.0, "yyyyrr"),
        (10.0, "rrrrGG"),
        (3.0, "rrrryy"),
    ]);
    for p in 0..4 {
        data.phase_min_dur[p] = if p % 2 == 0 { 5.0 } else { 3.0 };
        data.phase_max_dur[p] = if p % 2 == 0 { 60.0 } else { 3.0 };
    }
    let net = Network::build(data).unwrap();
    // Southbound lane in: the north road's edge into the junction (junction 1).
    let sb_in = (0..net.edge_count() as u32)
        .find(|&e| net.d.edge_to[e as usize] == 1 && net.edge_mid[e as usize].1 < -100.0)
        .unwrap();
    let lane = net.edge_lanes(sb_in).start;
    let len = net.d.lane_length[lane as usize];
    let mut engine = Engine::new(net, 7);
    let data = crossing(lane, len - 0.5, kind::JUNCTION_SIGNAL, 1, 360.0);
    let ped = Pedestrians::new(data, &engine.net);
    assert!(!ped.blocking_links(0).is_empty() && ped.tls[0] != NONE);
    engine.pedestrians = Some(ped);
    let (mut walked_on_green, mut cut_short, mut walks) = (0, 0, 0);
    run_until(&mut engine, 600.0, |e| {
        let ped = e.pedestrians.as_ref().unwrap();
        let since = ped.walk_since[0];
        let green = ped
            .blocking_links(0)
            .iter()
            .any(|&l| e.link_state(l) == b'G');
        if (e.time - since).abs() < 0.01 {
            walks += 1;
            if green {
                walked_on_green += 1;
            }
        }
        // Green for the traffic across before the walk and clearance are over.
        if green && e.time < since + MIN_WALK + ped.crossing_time(0) - DT as f64 {
            cut_short += 1;
        }
    });
    let ped = engine.pedestrians.as_ref().unwrap();
    assert!(
        ped.crossed >= 40,
        "{} pedestrians crossed in {walks} walks",
        ped.crossed
    );
    assert_eq!(
        walked_on_green, 0,
        "pedestrians started while traffic across had green"
    );
    assert_eq!(cut_short, 0, "the walk was cut short");
}

#[test]
fn drivers_pass_cyclists_and_cyclists_ride_at_their_pace() {
    // A bike sets off on a 500 m road, then a car every 5 s behind it.
    let (b, e0, e1) = straight_road(500.0, 1);
    let mut engine = Engine::new(b.build(), 8);
    let trip = |depart: f64, vtype: u8| Trip {
        depart,
        from: e0,
        to: e1,
        vtype,
        flags: 0,
    };
    engine.add_trip(trip(0.0, vtype::BIKE));
    for k in 1..10 {
        engine.add_trip(trip(5.0 * k as f64, vtype::CAR));
    }
    let (mut bike_top, mut car_slow) = (0.0f32, 0);
    // Cars that have reached 12 m/s, by serial: none slows below 8 m/s before the junction.
    let mut cruising = std::collections::HashSet::new();
    run_until(&mut engine, 250.0, |e| {
        assert_no_overlaps(e);
        for v in e.vehs.iter().filter(|v| v.alive()) {
            if v.vtype == vtype::BIKE {
                bike_top = bike_top.max(v.speed);
                continue;
            }
            if v.speed > 12.0 {
                cruising.insert(v.serial);
            }
            let len = e.net.d.lane_length[v.lane as usize];
            if cruising.contains(&v.serial)
                && v.speed < 8.0
                && !e.net.lane_internal[v.lane as usize]
                && v.pos < len - 40.0
            {
                car_slow += 1;
            }
        }
    });
    assert!(
        (3.5..=6.0).contains(&bike_top),
        "the bike rode at up to {bike_top} m/s"
    );
    assert_eq!(car_slow, 0, "cars slowed behind the bike");
    let s = &engine.stats;
    assert_eq!((s.arrived, s.bike_arrived, s.teleported), (9, 1, 0));
    assert_eq!(engine.edge_bikes[e1 as usize], 1);
    assert_eq!(engine.edge_entered[e1 as usize], 9);
}

#[test]
fn a_cyclist_rides_on_past_a_queue_a_driver_waits_behind() {
    // The road beyond the junction is full of cars standing (no way on at its end). A bike
    // rides into it beside them; a car waits for room before the junction.
    let (b, e0, e1) = straight_road(200.0, 1);
    let mut engine = Engine::new(b.build(), 3);
    engine.set_time(0.0);
    let out = engine.net.edge_lanes(e1).start;
    let car = &vtype::TYPES[vtype::CAR as usize];
    // From the end of the lane to its start, as close as drivers stand: no room for another.
    let mut pos = engine.net.d.lane_length[out as usize] - 0.5;
    while pos >= car.length {
        engine.insert_at(vtype::CAR, vec![e1, e0], out, pos, 0.0);
        pos -= car.length + car.min_gap;
    }
    let into = engine.net.edge_lanes(e0).start;
    let bike = engine.insert_at(vtype::BIKE, vec![e0, e1], into, 150.0, 4.0);
    let waiting = engine.insert_at(vtype::CAR, vec![e0, e1], into, 100.0, 10.0);
    let bike_serial = engine.vehs[bike as usize].serial;
    let mut bike_beyond = false;
    // Less than `BLOCK_BOX_WAIT` after the car gets to the junction.
    run_until(&mut engine, 50.0, |e| {
        let v = &e.vehs[bike as usize];
        if !v.alive() || v.serial != bike_serial || e.net.d.lane_edge[v.lane as usize] == e1 {
            bike_beyond = true;
        }
    });
    assert!(bike_beyond, "the bike waited for room behind the cars");
    let w = &engine.vehs[waiting as usize];
    assert_eq!(
        engine.net.d.lane_edge[w.lane as usize], e0,
        "the car entered a junction with no room beyond"
    );
}

#[test]
fn a_cyclist_gets_into_the_lane_for_its_turn_on_a_short_road() {
    // A short two-lane road (36 m): only its right lane turns right, and the way in leads
    // into its left lane. Straight on, a way round the block leads back to the way in.
    // Bikes cross to the right lane rather than go round, again and again.
    let mut b = Builder::default();
    let j0 = b.junction(0.0, 0.0);
    let j1 = b.junction(200.0, 0.0);
    let j2 = b.junction(236.0, 0.0);
    let j3 = b.junction(236.0, 200.0);
    let j4 = b.junction(436.0, 0.0);
    let j5 = b.junction(436.0, -200.0);
    let j6 = b.junction(0.0, -200.0);
    let into = b.road(j0, j1, 1, 13.9);
    let short = b.road(j1, j2, 2, 13.9);
    let right = b.road(j2, j3, 1, 13.9);
    let ahead = b.road(j2, j4, 1, 13.9);
    let up = b.road(j4, j5, 1, 13.9);
    let back = b.road(j5, j6, 1, 13.9);
    let down = b.road(j6, j0, 1, 13.9);
    b.connect(b.lane(into, 0), b.lane(short, 1), j1, dir::STRAIGHT, b'M');
    b.connect(b.lane(short, 0), b.lane(right, 0), j2, dir::RIGHT, b'M');
    b.connect(b.lane(short, 1), b.lane(ahead, 0), j2, dir::STRAIGHT, b'M');
    b.connect(b.lane(ahead, 0), b.lane(up, 0), j4, dir::LEFT, b'M');
    b.connect(b.lane(up, 0), b.lane(back, 0), j5, dir::LEFT, b'M');
    b.connect(b.lane(back, 0), b.lane(down, 0), j6, dir::LEFT, b'M');
    b.connect(b.lane(down, 0), b.lane(into, 0), j0, dir::LEFT, b'M');
    let mut engine = Engine::new(b.build(), 1);
    engine.set_time(0.0);
    for k in 0..3 {
        engine.add_trip(Trip {
            depart: 10.0 * k as f64,
            from: into,
            to: right,
            vtype: vtype::BIKE,
            flags: 0,
        });
    }
    run_until(&mut engine, 300.0, assert_no_overlaps);
    let s = &engine.stats;
    assert_eq!(s.bike_arrived, 3, "every bike turned right");
    assert_eq!(engine.edge_bikes[ahead as usize], 0, "no bike went round");
}

#[test]
fn cyclists_take_a_road_with_a_cycle_track_over_a_busy_one() {
    // Two ways from west to east: straight along a two-lane road (1 km), or 10 % further
    // round by a one-lane road with a cycle track. Cars take the straight road, bikes the
    // cycle track.
    let mut b = Builder::default();
    let w = b.junction(0.0, 0.0);
    let e = b.junction(1000.0, 0.0);
    let n = b.junction(500.0, -230.0);
    let start = b.junction(-300.0, 0.0);
    let end = b.junction(1300.0, 0.0);
    let into = b.road(start, w, 1, 13.9);
    let main = b.road(w, e, 2, 13.9);
    let up = b.road(w, n, 1, 13.9);
    let down = b.road(n, e, 1, 13.9);
    let out = b.road(e, end, 1, 13.9);
    let (i0, m0, m1, u0, d0, o0) = (
        b.lane(into, 0),
        b.lane(main, 0),
        b.lane(main, 1),
        b.lane(up, 0),
        b.lane(down, 0),
        b.lane(out, 0),
    );
    b.connect(i0, m0, w, dir::STRAIGHT, b'M');
    b.connect(i0, u0, w, dir::LEFT, b'M');
    b.connect(m0, o0, e, dir::STRAIGHT, b'M');
    b.connect(m1, o0, e, dir::STRAIGHT, b'M');
    b.connect(u0, d0, n, dir::STRAIGHT, b'M');
    b.connect(d0, o0, e, dir::RIGHT, b'M');
    let net = b.build();
    let mut engine = Engine::new(net, 9);
    let mut cycleway = vec![0u8; engine.net.edge_count()];
    cycleway[up as usize] = 1;
    cycleway[down as usize] = 1;
    engine.set_cycleways(&cycleway);
    engine.add_trip(Trip {
        depart: 0.0,
        from: into,
        to: out,
        vtype: vtype::BIKE,
        flags: 0,
    });
    engine.add_trip(Trip {
        depart: 1.0,
        from: into,
        to: out,
        vtype: vtype::CAR,
        flags: 0,
    });
    run_until(&mut engine, 500.0, assert_no_overlaps);
    assert_eq!((engine.stats.arrived, engine.stats.bike_arrived), (1, 1));
    assert_eq!(
        engine.edge_bikes[up as usize], 1,
        "the bike took the cycle track"
    );
    assert_eq!(
        engine.edge_entered[main as usize], 1,
        "the car took the straight road"
    );
}
