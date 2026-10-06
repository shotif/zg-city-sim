"""Parse a SUMO network (.net.xml.gz) into packed arrays for the app and the traffic engine.

Everything vehicles need is kept: normal and junction-internal lanes with their shapes,
the links (connections) between lanes, each junction's right-of-way matrix (SUMO's
`request` response/foes rows) and the traffic-light programs.

Shapes are delta-encoded: per polyline an int32 origin in centimetres, then int16
centimetre steps (x, z) and an int16 elevation offset in centimetres per point.
"""

from __future__ import annotations

import gzip
import logging
import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .config import ORIGIN_E, ORIGIN_N

log = logging.getLogger(__name__)

NONE = 0xFFFFFFFF

# Vehicle-class bits in `laneAllow`.
VCLASS_BITS = {
    "passenger": 1,
    "bus": 2,
    "tram": 4,
    "truck": 8,
    "rail": 16,
    "bicycle": 32,
    "pedestrian": 64,
    "delivery": 128,
    "taxi": 256,
    "emergency": 512,
}
# SUMO classes folded into ours.
SUMO_CLASS = {
    "passenger": "passenger",
    "private": "passenger",
    "evehicle": "passenger",
    "motorcycle": "passenger",
    "moped": "passenger",
    "vip": "passenger",
    "hov": "passenger",
    "army": "passenger",
    "authority": "emergency",
    "emergency": "emergency",
    "bus": "bus",
    "coach": "bus",
    "tram": "tram",
    "truck": "truck",
    "trailer": "truck",
    "rail": "rail",
    "rail_urban": "rail",
    "rail_electric": "rail",
    "rail_fast": "rail",
    "subway": "rail",
    "bicycle": "bicycle",
    "pedestrian": "pedestrian",
    "delivery": "delivery",
    "taxi": "taxi",
}
ALL_BITS = sum(VCLASS_BITS.values())

FLAG_BRIDGE = 1
FLAG_TUNNEL = 2
FLAG_HAS_OPPOSITE = 4
FLAG_ROUNDABOUT = 8
FLAG_INTERNAL = 16

LINK_DIRS = ["s", "l", "r", "t", "L", "R", "invalid"]
# Static link states (connection `state`) and signal states (phase characters).
LINK_STATES = ["M", "m", "=", "s", "w", "Z", "O", "o", "G", "g", "y", "r", "u"]
MAX_STEP_CM = 30000  # int16 delta limit with margin


def permissions(allow: str | None, disallow: str | None) -> int:
    """Our vehicle-class bits for a SUMO allow/disallow pair."""
    if allow is not None:
        names, base = allow.split(), 0
    elif disallow is not None:
        names, base = disallow.split(), ALL_BITS
    else:
        return ALL_BITS
    bits = 0
    for name in names:
        ours = SUMO_CLASS.get(name)
        if ours:
            bits |= VCLASS_BITS[ours]
    if allow is not None:
        return bits
    # Disallow lists: a class is gone only if every SUMO class folding into it is gone.
    removed = 0
    for ours, bit in VCLASS_BITS.items():
        members = [s for s, o in SUMO_CLASS.items() if o == ours]
        if all(m in names for m in members):
            removed |= bit
    return base & ~removed


def parse_shape(text: str | None) -> list[tuple[float, float, float]]:
    """SUMO shape "x,y[,z] ..." -> scene (x, z, elevation)."""
    if not text:
        return []
    out = []
    for point in text.split():
        coords = point.split(",")
        e, n = float(coords[0]), float(coords[1])
        elev = float(coords[2]) if len(coords) > 2 else 0.0
        out.append((e - ORIGIN_E, ORIGIN_N - n, elev))
    return out


def internal_edge_junction(edge_id: str) -> str:
    """Junction id of an internal edge ":<junction>_<n>" (junction ids may contain "_")."""
    return edge_id[1:].rsplit("_", 1)[0]


@dataclass
class Lane:
    id: str
    edge: int
    index: int
    length: float
    speed: float
    width: float
    allow: int
    shape: list[tuple[float, float, float]]


@dataclass
class Edge:
    id: str
    from_node: str
    to_node: str
    type: str
    name: str
    internal: bool
    lanes: list[int] = field(default_factory=list)
    params: dict[str, str] = field(default_factory=dict)


@dataclass
class Junction:
    id: str
    type: str
    x: float
    z: float
    inc_lanes: list[str]
    int_lanes: list[str]
    shape: list[tuple[float, float, float]]
    response: dict[int, str] = field(default_factory=dict)
    foes: dict[int, str] = field(default_factory=dict)


@dataclass
class Connection:
    from_lane: str
    to_lane: str
    via: str | None
    dir: str
    state: str
    tl: str | None
    link_index: int | None


@dataclass
class TlsProgram:
    id: str
    type: str
    offset: float
    phases: list[tuple[float, float, float, str]]  # duration, minDur, maxDur, state


@dataclass
class SumoNet:
    lanes: list[Lane] = field(default_factory=list)
    lane_index: dict[str, int] = field(default_factory=dict)
    edges: list[Edge] = field(default_factory=list)
    junctions: list[Junction] = field(default_factory=list)
    connections: list[Connection] = field(default_factory=list)
    tls: list[TlsProgram] = field(default_factory=list)
    roundabout_edges: set[str] = field(default_factory=set)


def parse_net(path: Path) -> SumoNet:
    net = SumoNet()
    current_edge: Edge | None = None
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as f:
        context = ET.iterparse(f, events=("start", "end"))
        _, root = next(context)
        for event, el in context:
            tag = el.tag
            if event == "start":
                if tag == "edge":
                    function = el.get("function", "")
                    if function in ("crossing", "walkingarea"):
                        current_edge = None
                        continue
                    internal = function == "internal"
                    current_edge = Edge(
                        id=el.get("id"),
                        from_node=el.get("from") or internal_edge_junction(el.get("id")),
                        to_node=el.get("to") or internal_edge_junction(el.get("id")),
                        type=el.get("type", "internal" if internal else ""),
                        name=el.get("name", ""),
                        internal=internal,
                    )
                continue

            if tag == "lane" and current_edge is not None:
                lane = Lane(
                    id=el.get("id"),
                    edge=len(net.edges),
                    index=int(el.get("index", 0)),
                    length=float(el.get("length")),
                    speed=float(el.get("speed")),
                    width=float(el.get("width", 3.2)),
                    allow=permissions(el.get("allow"), el.get("disallow")),
                    shape=parse_shape(el.get("shape")),
                )
                net.lane_index[lane.id] = len(net.lanes)
                current_edge.lanes.append(len(net.lanes))
                net.lanes.append(lane)
            elif tag == "param" and current_edge is not None:
                current_edge.params[el.get("key")] = el.get("value", "")
            elif tag == "edge":
                if current_edge is not None:
                    net.edges.append(current_edge)
                current_edge = None
                root.clear()
            elif tag == "request":
                pass  # read with its junction
            elif tag == "junction":
                jid = el.get("id")
                if el.get("type") != "internal" and not jid.startswith(":"):
                    junction = Junction(
                        id=jid,
                        type=el.get("type"),
                        x=float(el.get("x")) - ORIGIN_E,
                        z=ORIGIN_N - float(el.get("y")),
                        inc_lanes=el.get("incLanes", "").split(),
                        int_lanes=el.get("intLanes", "").split(),
                        shape=parse_shape(el.get("shape")),
                    )
                    for req in el.findall("request"):
                        index = int(req.get("index"))
                        junction.response[index] = req.get("response", "")
                        junction.foes[index] = req.get("foes", "")
                    net.junctions.append(junction)
                root.clear()
            elif tag == "connection":
                from_edge, to_edge = el.get("from"), el.get("to")
                link_index = el.get("linkIndex")
                net.connections.append(
                    Connection(
                        from_lane=f"{from_edge}_{el.get('fromLane')}",
                        to_lane=f"{to_edge}_{el.get('toLane')}",
                        via=el.get("via"),
                        dir=el.get("dir", "s"),
                        state=el.get("state", "M"),
                        tl=el.get("tl"),
                        link_index=int(link_index) if link_index is not None else None,
                    )
                )
                root.clear()
            elif tag == "tlLogic":
                phases = [
                    (
                        float(p.get("duration")),
                        float(p.get("minDur", p.get("duration"))),
                        float(p.get("maxDur", p.get("duration"))),
                        p.get("state"),
                    )
                    for p in el.findall("phase")
                ]
                net.tls.append(
                    TlsProgram(
                        id=el.get("id"),
                        type=el.get("type", "static"),
                        offset=float(el.get("offset", 0)),
                        phases=phases,
                    )
                )
                root.clear()
            elif tag == "roundabout":
                net.roundabout_edges.update(el.get("edges", "").split())
                root.clear()
    return net


def encode_polylines(
    shapes: list[list[tuple[float, float, float]]],
) -> dict[str, np.ndarray]:
    """Delta-encode polylines (x, z, elevation in metres); long steps are split."""
    origin = np.zeros((len(shapes), 2), np.int32)
    offsets = np.zeros(len(shapes) + 1, np.uint32)
    deltas: list[np.ndarray] = []
    elevs: list[np.ndarray] = []
    total = 0
    for i, shape in enumerate(shapes):
        if not shape:
            offsets[i + 1] = total
            continue
        pts = np.round(np.asarray(shape, np.float64) * 100).astype(np.int64)
        steps = np.abs(np.diff(pts[:, :2], axis=0)).max(axis=1) if len(pts) > 1 else []
        if len(pts) > 1 and np.max(steps) > MAX_STEP_CM:
            dense = [pts[0]]
            for p, q, s in zip(pts[:-1], pts[1:], steps, strict=True):
                n = int(math.ceil(s / MAX_STEP_CM))
                for k in range(1, n + 1):
                    dense.append(np.round(p + (q - p) * k / n).astype(np.int64))
            pts = np.asarray(dense)
        origin[i] = pts[0, :2]
        d = np.diff(pts[:, :2], axis=0, prepend=pts[:1, :2])
        deltas.append(d.astype(np.int16))
        elevs.append(np.clip(pts[:, 2], -32768, 32767).astype(np.int16))
        total += len(pts)
        offsets[i + 1] = total
    return {
        "origin": origin.ravel(),
        "offsets": offsets,
        "delta": np.concatenate(deltas).ravel() if deltas else np.zeros(0, np.int16),
        "elev": np.concatenate(elevs) if elevs else np.zeros(0, np.int16),
    }


def response_words(row: str, n: int) -> list[int]:
    """SUMO request row ("0110", rightmost char = link 0) -> 32-bit words, bit k = link k."""
    words = [0] * max(1, math.ceil(n / 32))
    for k in range(n):
        if k < len(row) and row[len(row) - 1 - k] == "1":
            words[k // 32] |= 1 << (k % 32)
    return words


def pack_network(net: SumoNet) -> tuple[dict[str, np.ndarray], dict]:
    """Arrays and string tables for the app and the engine."""
    names: dict[str, int] = {}
    refs: dict[str, int] = {}
    types: dict[str, int] = {}
    junction_types: dict[str, int] = {}

    def intern(table: dict[str, int], value: str) -> int:
        return table.setdefault(value, len(table))

    junction_index = {j.id: i for i, j in enumerate(net.junctions)}
    edge_ids = {e.id for e in net.edges if not e.internal}

    # Edges.
    edge_from, edge_to, edge_type, edge_flags, edge_name, edge_ref = [], [], [], [], [], []
    edge_lane_start, edge_lane_count = [], []
    lane_order: list[int] = []  # lanes grouped by edge, edges in file order
    for e in net.edges:
        flags = FLAG_INTERNAL if e.internal else 0
        if e.params.get("bridge", "no") not in ("no", ""):
            flags |= FLAG_BRIDGE
        if e.params.get("tunnel", "no") not in ("no", ""):
            flags |= FLAG_TUNNEL
        if not e.internal:
            opposite = e.id[1:] if e.id.startswith("-") else "-" + e.id
            if opposite in edge_ids:
                flags |= FLAG_HAS_OPPOSITE
        if e.id in net.roundabout_edges:
            flags |= FLAG_ROUNDABOUT
        edge_from.append(junction_index.get(e.from_node, NONE))
        edge_to.append(junction_index.get(e.to_node, NONE))
        edge_type.append(intern(types, e.type))
        edge_flags.append(flags)
        edge_name.append(intern(names, e.name) if e.name else NONE)
        ref = e.params.get("ref", "").strip()
        edge_ref.append(intern(refs, ref) if ref else NONE)
        edge_lane_start.append(len(lane_order))
        edge_lane_count.append(len(e.lanes))
        lane_order.extend(sorted(e.lanes, key=lambda li: net.lanes[li].index))

    # Lanes, renumbered so each edge's lanes are contiguous (index 0 = rightmost).
    new_index = np.empty(len(net.lanes), np.int64)
    new_index[np.asarray(lane_order)] = np.arange(len(lane_order))
    lanes = [net.lanes[i] for i in lane_order]
    lane_id = {lane.id: int(new_index[net.lane_index[lane.id]]) for lane in lanes}

    # Successor of each internal lane, and links out of normal lanes.
    lane_next = np.full(len(lanes), NONE, np.uint32)
    links = []
    for c in net.connections:
        if c.from_lane not in lane_id or c.to_lane not in lane_id:
            continue
        frm, to = lane_id[c.from_lane], lane_id[c.to_lane]
        via = lane_id.get(c.via) if c.via else None
        if c.from_lane.startswith(":"):
            lane_next[frm] = via if via is not None else to
        else:
            links.append((frm, to, via, c))

    # Request index of a link = position of the last internal lane of its chain in the
    # junction's intLanes list.
    int_lane_pos = {}
    for j, junction in enumerate(net.junctions):
        for k, lane in enumerate(junction.int_lanes):
            int_lane_pos[lane] = (j, k)
    reverse_id = {v: k for k, v in lane_id.items()}
    tls_index = {}
    for t, program in enumerate(net.tls):
        tls_index.setdefault(program.id, t)

    link_from, link_to, link_via, link_junction, link_request = [], [], [], [], []
    link_dir, link_state, link_tls, link_tls_index = [], [], [], []
    unmatched = 0
    for frm, to, via, c in sorted(links, key=lambda link: link[0]):
        request = NONE
        junction = junction_index.get(net.edges[lanes[frm].edge].to_node, NONE)
        if via is not None:
            chain = [via]
            while lane_next[chain[-1]] != NONE and reverse_id[int(lane_next[chain[-1]])].startswith(
                ":"
            ):
                chain.append(int(lane_next[chain[-1]]))
                if len(chain) > 8:
                    break
            for lane in reversed(chain):
                hit = int_lane_pos.get(reverse_id[lane])
                if hit:
                    junction, request = hit
                    break
        if request == NONE:
            unmatched += 1
        link_from.append(frm)
        link_to.append(to)
        link_via.append(via if via is not None else NONE)
        link_junction.append(junction)
        link_request.append(request if request != NONE else 0xFFFF)
        link_dir.append(
            LINK_DIRS.index(c.dir) if c.dir in LINK_DIRS else LINK_DIRS.index("invalid")
        )
        link_state.append(LINK_STATES.index(c.state) if c.state in LINK_STATES else 1)
        # SUMO writes linkIndex="-1" for connections a traffic light doesn't control.
        controlled = c.tl is not None and c.link_index is not None and c.link_index >= 0
        link_tls.append(tls_index.get(c.tl, NONE) if controlled else NONE)
        link_tls_index.append(c.link_index if controlled else 0xFFFF)
    if unmatched:
        log.warning("%d links have no junction request index", unmatched)

    lane_link_offsets = np.zeros(len(lanes) + 1, np.uint32)
    np.add.at(lane_link_offsets, np.asarray(link_from, np.int64) + 1, 1)
    lane_link_offsets = np.cumsum(lane_link_offsets).astype(np.uint32)

    # Junction right-of-way: per link, `response` words then `foes` words.
    junction_link_count = np.zeros(len(net.junctions), np.uint16)
    junction_logic_offset = np.zeros(len(net.junctions), np.uint32)
    logic: list[int] = []
    for j, junction in enumerate(net.junctions):
        n = len(junction.response)
        junction_link_count[j] = n
        junction_logic_offset[j] = len(logic)
        for k in range(n):
            logic.extend(response_words(junction.response[k], n))
            logic.extend(response_words(junction.foes[k], n))

    # Traffic lights.
    tls_phase_offsets = [0]
    tls_offset, tls_type = [], []
    tls_types: dict[str, int] = {}
    phase_duration, phase_min, phase_max, phase_state_offsets = [], [], [], [0]
    phase_states = bytearray()
    for program in net.tls:
        tls_offset.append(program.offset)
        tls_type.append(intern(tls_types, program.type))
        for duration, min_dur, max_dur, state in program.phases:
            phase_duration.append(duration)
            phase_min.append(min_dur)
            phase_max.append(max_dur)
            phase_states.extend(state.encode("ascii"))
            phase_state_offsets.append(len(phase_states))
        tls_phase_offsets.append(len(phase_duration))

    lane_shapes = encode_polylines([lane.shape for lane in lanes])
    junction_shapes = encode_polylines([j.shape for j in net.junctions])

    arrays = {
        # junctions
        "junctionPos": np.asarray([(j.x, j.z) for j in net.junctions], np.float32).ravel(),
        "junctionType": np.asarray(
            [intern(junction_types, j.type) for j in net.junctions], np.uint8
        ),
        "junctionShapeOrigin": junction_shapes["origin"],
        "junctionShapeOffsets": junction_shapes["offsets"],
        "junctionShapeDelta": junction_shapes["delta"],
        "junctionShapeElev": junction_shapes["elev"],
        "junctionLinkCount": junction_link_count,
        "junctionLogicOffset": junction_logic_offset,
        "logic": np.asarray(logic, np.uint32),
        # edges
        "edgeFrom": np.asarray(edge_from, np.uint32),
        "edgeTo": np.asarray(edge_to, np.uint32),
        "edgeType": np.asarray(edge_type, np.uint16),
        "edgeFlags": np.asarray(edge_flags, np.uint8),
        "edgeName": np.asarray(edge_name, np.uint32),
        "edgeRef": np.asarray(edge_ref, np.uint32),
        "edgeLaneStart": np.asarray(edge_lane_start, np.uint32),
        "edgeLaneCount": np.asarray(edge_lane_count, np.uint8),
        # lanes
        "laneEdge": np.asarray([lane.edge for lane in lanes], np.uint32),
        "laneLength": np.asarray([lane.length for lane in lanes], np.float32),
        "laneSpeed": np.asarray([lane.speed for lane in lanes], np.float32),
        "laneWidth": np.asarray([lane.width for lane in lanes], np.float32),
        "laneAllow": np.asarray([lane.allow for lane in lanes], np.uint16),
        "laneNext": lane_next,
        "laneLinkOffsets": lane_link_offsets,
        "laneShapeOrigin": lane_shapes["origin"],
        "laneShapeOffsets": lane_shapes["offsets"],
        "laneShapeDelta": lane_shapes["delta"],
        "laneShapeElev": lane_shapes["elev"],
        # links
        "linkFrom": np.asarray(link_from, np.uint32),
        "linkTo": np.asarray(link_to, np.uint32),
        "linkVia": np.asarray(link_via, np.uint32),
        "linkJunction": np.asarray(link_junction, np.uint32),
        "linkRequest": np.asarray(link_request, np.uint16),
        "linkDir": np.asarray(link_dir, np.uint8),
        "linkState": np.asarray(link_state, np.uint8),
        "linkTls": np.asarray(link_tls, np.uint32),
        "linkTlsIndex": np.asarray(link_tls_index, np.uint16),
        # traffic lights
        "tlsPhaseOffsets": np.asarray(tls_phase_offsets, np.uint32),
        "tlsOffset": np.asarray(tls_offset, np.float32),
        "tlsType": np.asarray(tls_type, np.uint8),
        "phaseDuration": np.asarray(phase_duration, np.float32),
        "phaseMinDur": np.asarray(phase_min, np.float32),
        "phaseMaxDur": np.asarray(phase_max, np.float32),
        "phaseStateOffsets": np.asarray(phase_state_offsets, np.uint32),
        "phaseStates": np.frombuffer(bytes(phase_states), np.uint8),
    }
    tables = {
        "types": list(types),
        "junctionTypes": list(junction_types),
        "names": list(names),
        "refs": list(refs),
        "tlsTypes": list(tls_types),
        "linkDirs": LINK_DIRS,
        "linkStates": LINK_STATES,
        "vclassBits": VCLASS_BITS,
        "flags": {
            "bridge": FLAG_BRIDGE,
            "tunnel": FLAG_TUNNEL,
            "hasOpposite": FLAG_HAS_OPPOSITE,
            "roundabout": FLAG_ROUNDABOUT,
            "internal": FLAG_INTERNAL,
        },
        "none": NONE,
    }
    return arrays, tables
