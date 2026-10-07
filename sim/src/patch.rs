//! Swapping in a changed network while traffic runs (M4d: roads drawn in the app).
//!
//! The app builds every network it hands over from the loaded one (web/src/edit/builder.ts),
//! so the lanes, edges and junctions loaded keep their ids; roads drawn add lanes, edges and
//! junctions after them, re-sort the links by the lane they leave, and cut roads where a new
//! road joins them. It also says where the lanes of the network running now went
//! (`LanePiece`): a lane cut in two goes on as a new lane past the cut, the halves of a lane
//! whose cut was undone become one again, and the lanes of a road taken away go nowhere.
//! Lanes it does not mention keep their id and length.
//!
//! The engine keeps its vehicles: each moves to where its lane and position went, routes
//! follow their roads' pieces, links are matched again by the lanes they join, vehicles on a
//! road that was taken away leave, those whose route used it re-plan at once, and every other
//! vehicle re-plans within a minute, as after an edit.

use std::collections::HashMap;

use super::*;
use crate::network::{NetworkError, edge_flag};

/// Where part of a lane of the running network is in the new one: from `from` metres along
/// the old lane on, lane `lane` (NONE: gone), `shift` metres further along.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LanePiece {
    pub old: u32,
    pub from: f32,
    pub lane: u32,
    pub shift: f32,
}

/// Lane pieces by old lane, each lane's in order of `from`.
struct LaneMap {
    pieces: HashMap<u32, Vec<LanePiece>>,
}

impl LaneMap {
    fn new(pieces: &[LanePiece]) -> LaneMap {
        let mut map: HashMap<u32, Vec<LanePiece>> = HashMap::new();
        for p in pieces {
            map.entry(p.old).or_default().push(*p);
        }
        for list in map.values_mut() {
            list.sort_by(|a, b| a.from.total_cmp(&b.from));
        }
        LaneMap { pieces: map }
    }

    /// Where position `pos` on old lane `lane` is now: (lane, position), lane NONE if gone.
    fn place(&self, lane: u32, pos: f32) -> (u32, f32) {
        match self.pieces.get(&lane) {
            None => (lane, pos),
            Some(list) => {
                let piece = list
                    .iter()
                    .rev()
                    .find(|p| p.from <= pos)
                    .unwrap_or(&list[0]);
                (piece.lane, (pos + piece.shift).max(0.0))
            }
        }
    }

    /// The edges an old edge's road continues as, in order (empty: gone).
    fn edges(&self, old: &NetworkData, new: &NetworkData, edge: u32) -> Vec<u32> {
        let lane = old.edge_lane_start[edge as usize];
        match self.pieces.get(&lane) {
            None => vec![edge],
            Some(list) => {
                let mut out: Vec<u32> = Vec::new();
                for p in list {
                    if p.lane == NONE {
                        continue;
                    }
                    let e = new.lane_edge[p.lane as usize];
                    // Routes are of roads, not of the lanes across junctions.
                    if new.edge_flags[e as usize] & edge_flag::INTERNAL != 0 {
                        continue;
                    }
                    if out.last() != Some(&e) {
                        out.push(e);
                    }
                }
                out
            }
        }
    }
}

impl Engine {
    /// Replace the network with `d`, built from the loaded one as described above, keeping
    /// the vehicles on it. The edits in force are applied to the new network again.
    pub fn replace_network(
        &mut self,
        d: NetworkData,
        pieces: &[LanePiece],
    ) -> Result<(), NetworkError> {
        let mut net = Network::build(d)?;
        let n_lanes = net.lane_count();
        let n_edges = net.edge_count();
        for p in pieces {
            if p.old as usize >= self.net.lane_count()
                || (p.lane != NONE && p.lane as usize >= n_lanes)
            {
                return Err(NetworkError::Inconsistent("lane pieces"));
            }
        }
        let lanes = LaneMap::new(pieces);

        // Signals as `Engine::new` reworks them; programs that kept their phases keep
        // running where they are, the others restart.
        let (tls_link_offsets, tls_links) = tls_links(&net);
        merge_signal_phases(&mut net, &tls_link_offsets, &tls_links);
        retime_signals(&mut net, &tls_link_offsets, &tls_links);
        let n_tls = net.d.tls_offset.len();
        let mut tls_phase = vec![0u32; n_tls];
        let mut tls_elapsed = vec![0f32; n_tls];
        for t in 0..n_tls {
            let same = t < self.tls_phase.len()
                && self.net.d.tls_phase_offsets.get(t..t + 2)
                    == net.d.tls_phase_offsets.get(t..t + 2);
            if same {
                tls_phase[t] = self.tls_phase[t];
                tls_elapsed[t] = self.tls_elapsed[t];
            } else {
                tls_phase[t] = net.d.tls_phase_offsets[t];
            }
        }

        // Links again by the lanes they join: the end of the lane they leave, the start of
        // the lane they reach.
        let mut link_of: HashMap<(u32, u32), u32> = HashMap::new();
        for l in 0..net.d.link_from.len() {
            link_of.insert((net.d.link_from[l], net.d.link_to[l]), l as u32);
        }
        let old = &self.net.d;
        let remap = |link: u32| -> u32 {
            if link == NONE || link as usize >= old.link_from.len() {
                return NONE;
            }
            let (from, to) = (old.link_from[link as usize], old.link_to[link as usize]);
            let (from, _) = lanes.place(from, old.lane_length[from as usize]);
            let (to, _) = lanes.place(to, 0.0);
            link_of.get(&(from, to)).copied().unwrap_or(NONE)
        };
        let mut edge_memo: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut edges_of = |e: u32| -> Vec<u32> {
            edge_memo
                .entry(e)
                .or_insert_with(|| lanes.edges(old, &net.d, e))
                .clone()
        };

        // Timetabled stops go where their road went.
        let mut stop_moved = Vec::new();
        let mut stop_edge = Vec::new();
        if let Some(tr) = self.transit.as_mut() {
            // Routes between stops are planned again on the new network.
            tr.legs.clear();
            let data = &mut tr.data;
            stop_moved = vec![false; data.stop_edge.len()];
            for i in 0..data.stop_edge.len() {
                let e = data.stop_edge[i];
                let lane = old.edge_lane_start[e as usize];
                let at = data.stop_frac[i] * old.lane_length[lane as usize];
                let (to, pos) = lanes.place(lane, at);
                if to == NONE || (to == lane && pos == at) {
                    continue;
                }
                data.stop_edge[i] = net.d.lane_edge[to as usize];
                data.stop_frac[i] = (pos / net.d.lane_length[to as usize].max(0.1)).min(1.0);
                stop_moved[i] = true;
            }
            stop_edge = data.stop_edge.clone();
        }

        let live: Vec<u32> = self.live_vehicles().collect();
        let mut gone = Vec::new();
        let mut replan_now = Vec::new();
        for &v in &live {
            let veh = &mut self.vehs[v as usize];
            let (lane, pos) = lanes.place(veh.lane, veh.pos);
            // Off a road taken away, or past the new end of a road shortened (a junction
            // made a roundabout).
            if lane == NONE || pos > net.d.lane_length[lane as usize] + 0.5 {
                gone.push(v);
                continue;
            }
            veh.cur_link = remap(veh.cur_link);
            veh.stop_done = remap(veh.stop_done);
            veh.coop = NONE;
            // Routes follow their roads' pieces; a route over a road taken away re-plans.
            let mut route: Vec<u32> = Vec::with_capacity(veh.route.len() + 2);
            let mut index = Vec::with_capacity(veh.route.len());
            let mut lost = false;
            for &e in &veh.route {
                index.push(route.len());
                let pieces = edges_of(e);
                lost |= pieces.is_empty();
                for p in pieces {
                    if route.last() != Some(&p) {
                        route.push(p);
                    }
                }
            }
            let start = index[veh.route_idx as usize].min(route.len());
            let here = net.d.lane_edge[lane as usize];
            // Where it is on the new route: ahead of where it was, or just behind it where
            // two halves became one road again.
            let found = route[start..]
                .iter()
                .position(|&e| e == here)
                .map(|k| start + k)
                .or_else(|| route[..start].iter().rposition(|&e| e == here));
            if let Some(run) = veh.transit.as_mut() {
                for (stop, idx) in run.stops.iter_mut() {
                    let mut k = index[*idx as usize].min(route.len());
                    if stop_moved[*stop as usize] {
                        let edge = stop_edge[*stop as usize];
                        k = route[k..]
                            .iter()
                            .position(|&e| e == edge)
                            .map_or(k, |j| k + j);
                    }
                    *idx = k as u32;
                }
            }
            veh.route = route;
            match found {
                Some(i) => veh.route_idx = i as u32,
                None => {
                    // Inside a junction: on from the edge it is leaving.
                    veh.route_idx = start.min(veh.route.len().saturating_sub(1)) as u32;
                    lost |= !net.lane_internal[lane as usize];
                }
            }
            if lost {
                replan_now.push(v);
            }
            veh.lane = lane;
            veh.pos = pos;
        }

        let lists = std::mem::take(&mut self.lane_vehs);
        self.net = net;
        for v in gone {
            // Off a road that is gone: not a trip that ended or got stuck.
            self.drop_vehicle(v);
        }
        self.lane_vehs = vec![Vec::new(); n_lanes];
        self.lane_reserved = vec![0.0; n_lanes];
        self.lane_active = vec![false; n_lanes];
        self.active_lanes.clear();
        for v in lists.into_iter().flatten() {
            if self.vehs[v as usize].alive() {
                let lane = self.vehs[v as usize].lane;
                self.insert_sorted(lane, v);
            }
        }
        for v in self.live_vehicles().collect::<Vec<_>>() {
            let veh = &self.vehs[v as usize];
            if self.net.lane_internal[veh.lane as usize] {
                if veh.cur_link != NONE {
                    let p = veh.params();
                    let to = self.net.d.link_to[veh.cur_link as usize] as usize;
                    self.lane_reserved[to] += p.length + p.min_gap;
                }
                continue;
            }
            let link = self.choose_link_or_detour(
                veh.lane,
                &veh.route,
                veh.route_idx,
                veh.params().vclass,
            );
            let veh = &mut self.vehs[v as usize];
            veh.next_link = link;
            veh.will_pass = false;
        }

        self.tls_link_offsets = tls_link_offsets;
        self.tls_links = tls_links;
        self.tls_phase = tls_phase;
        self.tls_elapsed = tls_elapsed;

        // Per edge: measured times stay for the roads that did not change.
        let old_times = std::mem::take(&mut self.travel_time);
        let free: Vec<f32> = (0..n_edges)
            .map(|e| self.net.edge_length[e] / self.net.edge_speed[e].max(1.0))
            .collect();
        let mut travel = free.clone();
        for e in 0..old_times.len().min(n_edges) {
            if edge_memo
                .get(&(e as u32))
                .is_none_or(|p| p[..] == [e as u32])
            {
                travel[e] = old_times[e].max(free[e]);
            }
        }
        self.free_time = free;
        self.travel_time = travel;
        self.edge_speed_sum = vec![0.0; n_edges];
        self.edge_speed_n = vec![0; n_edges];
        self.edge_speed_ratio.resize(n_edges, 255);
        self.edge_entered.resize(n_edges, 0);
        self.closed.retain(|&e| (e as usize) < n_edges);
        self.router = Router::new(n_edges);
        self.landmark_job = None;
        self.loaded = Loaded::of(&self.net);
        let edits = std::mem::take(&mut self.edits);
        // Applies the edits, starts rebuilding the landmarks and has vehicles re-plan.
        self.set_edits(&edits);
        // Buses and trams are mended below instead: a new route would leave their stops
        // pointing at the old one.
        for v in replan_now {
            let veh = &self.vehs[v as usize];
            if veh.alive() && veh.transit.is_none() {
                self.replan_vehicle(v, true);
            }
        }
        // Buses and trams keep their stops: where their way on no longer joins up (a
        // junction made again), they take the shortest way across.
        for v in self.live_vehicles().collect::<Vec<_>>() {
            if self.vehs[v as usize].transit.is_some() && !self.mend_transit_route(v) {
                self.drop_vehicle(v);
            }
        }
        Ok(())
    }

    /// Fill each gap in a bus or tram's route ahead (two roads that no longer join) with the
    /// shortest way between them, keeping its stops. False if there is none.
    fn mend_transit_route(&mut self, v: u32) -> bool {
        let vclass = self.vehs[v as usize].params().vclass;
        let mut k = self.vehs[v as usize].route_idx as usize;
        loop {
            let veh = &self.vehs[v as usize];
            let Some(gap) = (k..veh.route.len().saturating_sub(1)).find(|&i| {
                !self
                    .net
                    .successors(veh.route[i])
                    .iter()
                    .any(|s| s.edge == veh.route[i + 1] && s.allow & vclass != 0)
            }) else {
                if k > veh.route_idx as usize && !self.net.lane_internal[veh.lane as usize] {
                    let link =
                        self.choose_link_or_detour(veh.lane, &veh.route, veh.route_idx, vclass);
                    self.vehs[v as usize].next_link = link;
                }
                return true;
            };
            let (a, b) = (veh.route[gap], veh.route[gap + 1]);
            self.router.tolls = true;
            let Some(leg) = self.router.route(&self.net, &self.free_time, a, b, vclass) else {
                return false;
            };
            if leg.len() < 2 {
                return false;
            }
            let veh = &mut self.vehs[v as usize];
            let shift = leg.len() as u32 - 2;
            veh.route.splice(gap..gap + 2, leg);
            if let Some(run) = veh.transit.as_mut() {
                for (_, idx) in run.stops.iter_mut() {
                    if *idx as usize > gap {
                        *idx += shift;
                    }
                }
            }
            k = gap + 1 + shift as usize;
        }
    }

    /// Take a vehicle off the network without counting it as arrived or stuck.
    fn drop_vehicle(&mut self, v: u32) {
        let veh = &mut self.vehs[v as usize];
        veh.serial = 0;
        veh.route.clear();
        veh.transit = None;
        veh.lane = NONE;
        self.free.push(v);
    }
}

/// Links each signal program controls (as offsets into a list), as `Engine::new` needs them.
pub(super) fn tls_links(net: &Network) -> (Vec<u32>, Vec<u32>) {
    let n_tls = net.d.tls_offset.len();
    let n_links = net.d.link_from.len();
    let mut offsets = vec![0u32; n_tls + 1];
    for l in 0..n_links {
        let t = net.d.link_tls[l];
        if t != NONE && (t as usize) < n_tls {
            offsets[t as usize + 1] += 1;
        }
    }
    for t in 0..n_tls {
        offsets[t + 1] += offsets[t];
    }
    let mut fill = offsets.clone();
    let mut links = vec![0u32; offsets[n_tls] as usize];
    for l in 0..n_links {
        let t = net.d.link_tls[l];
        if t != NONE && (t as usize) < n_tls {
            links[fill[t as usize] as usize] = l as u32;
            fill[t as usize] += 1;
        }
    }
    (offsets, links)
}
