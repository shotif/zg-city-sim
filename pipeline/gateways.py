"""Gateways: where roads cross the map's edge, and how much traffic crosses there.

The OpenStreetMap extract keeps every road that crosses its outline whole, so a road
leaving the map ends at its last node beyond the outline. Those road ends are the gateways:
trips to, from and through places beyond the map enter and leave there (sim/src/demand.rs).
A dual carriageway ends twice, once each way; the two ends make one gateway.

Traffic per day comes from Hrvatske ceste counts where a counted road leaves the map, and
from typical volumes for the class of road everywhere else.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import shapely
from pyproj import Transformer

from .config import CRS, ORIGIN_E, ORIGIN_N
from .counts import STATIONS, Station
from .osm import world_polygon

# Vehicles per day crossing the map's edge on an uncounted road of each class (both
# directions together): typical of state and county roads 20-30 km out of Zagreb, where
# Hrvatske ceste counts 3,000-8,000 on state roads and 500-2,500 on county roads.
CLASS_DAILY = {
    "motorway": 20_000,
    "trunk": 8_000,
    "primary": 5_000,
    "secondary": 1_500,
    "tertiary": 600,
    "link": 2_000,
    "unclassified": 150,
    "residential": 50,
    "road": 50,
}
# Share of the traffic only passing through (in at one gateway, out at another).
THROUGH_SHARE = {"motorway": 0.35, "trunk": 0.15, "primary": 0.08, "secondary": 0.03}
# One-way road ends at most this far apart (m) are the two carriageways of one road.
PAIR_DISTANCE = 300.0
# A counted road leaves the map at the gateway nearest to where the station says, if
# within this distance (m).
STATION_GATEWAY_DISTANCE = 2_000.0
PASSENGER = 1
NONE = 0xFFFFFFFF


@dataclass
class Gateway:
    x: float
    z: float
    road_class: str
    ref: str
    entry: int = NONE
    exit: int = NONE
    daily: float = 0.0
    through: float = 0.0
    source: str = ""
    stations: list[int] = field(default_factory=list)


def road_class(edge_type: str) -> str | None:
    """Class of a road for volumes ("primary", "link", ...); None for roads with no traffic
    across the map's edge (service roads, tracks, railways)."""
    if not edge_type.startswith("highway."):
        return None
    name = edge_type.removeprefix("highway.").split("|")[0]
    if name.endswith("_link"):
        return "link"
    return name if name in CLASS_DAILY else None


def to_scene(lon: float, lat: float) -> tuple[float, float]:
    e, n = Transformer.from_crs("EPSG:4326", CRS, always_xy=True).transform(lon, lat)
    return e - ORIGIN_E, ORIGIN_N - n


def map_outline() -> shapely.Polygon:
    """Outline of the OpenStreetMap extract in scene coordinates."""
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    ring = np.asarray(world_polygon()["coordinates"][0])
    e, n = to_crs.transform(ring[:, 0], ring[:, 1])
    return shapely.Polygon(np.column_stack([e - ORIGIN_E, ORIGIN_N - n]))


def road_ends(net: dict[str, np.ndarray], index: dict, outline: shapely.Geometry) -> list[Gateway]:
    """Road ends outside the outline: junctions with a single neighbour, with the edges that
    lead into the map from there and out of the map to there."""
    internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
    edges = np.flatnonzero(~internal)
    frm = net["edgeFrom"][edges].astype(np.int64)
    to = net["edgeTo"][edges].astype(np.int64)
    pairs = np.concatenate([np.column_stack([frm, to]), np.column_stack([to, frm])])
    pairs = np.unique(pairs[pairs[:, 0] != pairs[:, 1]], axis=0)
    pos = net["junctionPos"].reshape(-1, 2)
    degree = np.bincount(pairs[:, 0], minlength=len(pos))
    ends = np.flatnonzero(degree == 1)
    ends = ends[~shapely.contains_xy(outline, pos[ends, 0], pos[ends, 1])]

    lane0 = net["edgeLaneStart"]
    count = net["edgeLaneCount"]
    allow = net["laneAllow"]

    def drivable(e: int) -> bool:
        lanes = range(int(lane0[e]), int(lane0[e]) + int(count[e]))
        return any(allow[lane] & PASSENGER for lane in lanes)

    types = index["types"]
    refs = index.get("refs", [])
    out: list[Gateway] = []
    end_set = set(ends.tolist())
    entries: dict[int, list[int]] = {}
    exits: dict[int, list[int]] = {}
    for e, a, b in zip(edges, frm, to, strict=True):
        if a in end_set:
            entries.setdefault(int(a), []).append(int(e))
        if b in end_set:
            exits.setdefault(int(b), []).append(int(e))
    for j in ends:
        entry = [e for e in entries.get(int(j), []) if drivable(e)]
        exit_ = [e for e in exits.get(int(j), []) if drivable(e)]
        if not entry and not exit_:
            continue
        e0 = (entry or exit_)[0]
        cls = road_class(types[net["edgeType"][e0]])
        if cls is None:
            continue
        r = int(net["edgeRef"][e0]) if "edgeRef" in net else NONE
        out.append(
            Gateway(
                x=float(pos[j, 0]),
                z=float(pos[j, 1]),
                road_class=cls,
                ref=refs[r] if r != NONE and r < len(refs) else "",
                entry=entry[0] if entry else NONE,
                exit=exit_[0] if exit_ else NONE,
            )
        )
    return out


def pair_carriageways(ends: list[Gateway]) -> list[Gateway]:
    """Merge each one-way road end leading in with the nearest one leading out of the same
    road (class and number) within PAIR_DISTANCE."""
    ins = [g for g in ends if g.entry != NONE and g.exit == NONE]
    outs = [g for g in ends if g.exit != NONE and g.entry == NONE]
    candidates = sorted(
        (np.hypot(a.x - b.x, a.z - b.z), i, k)
        for i, a in enumerate(ins)
        for k, b in enumerate(outs)
        if a.road_class == b.road_class and a.ref == b.ref
    )
    used_in: set[int] = set()
    used_out: set[int] = set()
    merged: list[Gateway] = []
    for dist, i, k in candidates:
        if dist > PAIR_DISTANCE or i in used_in or k in used_out:
            continue
        used_in.add(i)
        used_out.add(k)
        a, b = ins[i], outs[k]
        merged.append(
            Gateway(
                x=(a.x + b.x) / 2,
                z=(a.z + b.z) / 2,
                road_class=a.road_class,
                ref=a.ref,
                entry=a.entry,
                exit=b.exit,
            )
        )
    rest = [g for g in ends if g.entry != NONE and g.exit != NONE]
    rest += [g for i, g in enumerate(ins) if i not in used_in]
    rest += [g for k, g in enumerate(outs) if k not in used_out]
    return merged + rest


def assign_volumes(gateways: list[Gateway], stations: list[Station]) -> None:
    """Daily traffic and through share of each gateway: counted where a station measures
    the road leaving the map, typical for the road's class elsewhere."""
    for g in gateways:
        g.daily = float(CLASS_DAILY[g.road_class])
        g.through = THROUGH_SHARE.get(g.road_class, 0.0)
        g.source = f"typical for {g.road_class} roads"
    if not gateways:
        return
    xs = np.array([g.x for g in gateways])
    zs = np.array([g.z for g in gateways])
    for s in stations:
        if s.leaves_map is None:
            continue
        x, z = to_scene(*s.leaves_map)
        d = np.hypot(xs - x, zs - z)
        k = int(np.argmin(d))
        if d[k] > STATION_GATEWAY_DISTANCE:
            continue
        g = gateways[k]
        g.daily = float(s.aadt) * s.beyond
        share = "" if s.beyond == 1 else f", {s.beyond:.0%} of it"
        g.source = f"Hrvatske ceste count {s.id} {s.name} ({s.road}, 2025{share})"
        g.stations.append(s.id)


def build_gateways(
    net: dict[str, np.ndarray], index: dict
) -> tuple[dict[str, np.ndarray], list[dict]]:
    """Arrays for the engine and a description of each gateway."""
    gateways = pair_carriageways(road_ends(net, index, map_outline()))
    assign_volumes(gateways, STATIONS)
    gateways.sort(key=lambda g: -g.daily)
    arrays = {
        "gatewayEntry": np.array([g.entry for g in gateways], np.uint32),
        "gatewayExit": np.array([g.exit for g in gateways], np.uint32),
        "gatewayDaily": np.array([g.daily for g in gateways], np.float32),
        "gatewayThrough": np.array([g.through for g in gateways], np.float32),
    }
    info = [
        {
            "ref": g.ref,
            "class": g.road_class,
            "x": round(g.x),
            "z": round(g.z),
            "in": g.entry != NONE,
            "out": g.exit != NONE,
            "daily": round(g.daily),
            "through": g.through,
            "source": g.source,
        }
        for g in gateways
    ]
    return arrays, info
