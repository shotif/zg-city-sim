//! Engine tests on small hand-built networks.

use crate::demand::{Demand, Gateway};
use crate::edits::Edit;
use crate::engine::{DT, Engine, LanePiece, Trip, stat, travel_time, trip};
use crate::idm;
use crate::network::{LINK_STATE_CHARS, NONE, Network, NetworkData, dir, edge_flag, vclass};
use crate::rng::Rng;
use crate::router::Router;
use crate::vtype::{self, TYPES};

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

/// Bumper-to-bumper gaps between consecutive vehicles on every lane must stay positive.
fn assert_no_overlaps(engine: &Engine) {
    for lane in 0..engine.net.lane_count() as u32 {
        let list = engine.vehicles_on(lane);
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
}

#[test]
fn idm_accelerates_on_free_road_and_brakes_for_obstacles() {
    let p = &TYPES[vtype::CAR as usize];
    assert!(idm::acceleration(0.0, 13.9, f32::INFINITY, 0.0, p) > 1.5);
    assert!(idm::acceleration(13.9, 13.9, f32::INFINITY, 0.0, p).abs() < 0.01);
    assert!(idm::acceleration(13.9, 13.9, 20.0, 0.0, p) < -2.0);
    // Standing still behind a standing car at the minimum gap: stay put.
    assert!(idm::acceleration(0.0, 13.9, p.min_gap, 0.0, p) <= 0.0);
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

#[test]
fn a_queue_leaves_a_green_light_at_a_realistic_saturation_flow() {
    // 30 cars queue at a red light on one lane, then get green.
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
    // Time each car crosses the stop line.
    let mut crossed = Vec::new();
    run_until(&mut engine, 120.0, |e| {
        while crossed.len() < 30 - e.vehicles_on(l0).len() {
            crossed.push(e.time);
        }
    });
    assert_eq!(crossed.len(), 30);
    // Saturation flow, from the fifth car on once the queue is moving: the Highway Capacity
    // Manual's base is 1,900 cars per lane per hour.
    let flow = 20.0 * 3600.0 / (crossed[24] - crossed[4]);
    assert!(
        (1_700.0..=2_100.0).contains(&flow),
        "saturation flow {flow:.0} per hour"
    );
    // The first car gets going within a few seconds of green.
    assert!(
        crossed[0] - 200.0 < 4.0,
        "first car crossed at {}",
        crossed[0]
    );
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
    ];
    let words: Vec<u32> = all.iter().flat_map(|e| e.encode()).collect();
    assert_eq!(Edit::decode(&words), all);
    // Unknown kinds and a trailing partial record are skipped.
    assert_eq!(Edit::decode(&[99, 1, 2, 3, 1, 5]), vec![]);
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
