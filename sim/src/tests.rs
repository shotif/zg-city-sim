//! Engine tests on small hand-built networks.

use crate::demand::{Demand, Gateway};
use crate::engine::{DT, Engine, Trip, stat, travel_time, trip};
use crate::idm;
use crate::network::{LINK_STATE_CHARS, NONE, Network, NetworkData, dir, edge_flag};
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

    fn build(mut self) -> Network {
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
        Network::build(self.d).expect("consistent test network")
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
    Engine::new(b.build(), 1)
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
}
