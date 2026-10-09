"""Pedestrians at crossings (M8c): where people cross the drivable roads, and how many.

Pedestrians are not simulated one by one across the city. Each crossing OpenStreetMap maps on
a drivable road (a `highway=crossing` node) gets the lanes it crosses, its kind and an
estimated number of pedestrians on a weekday, from the homes and jobs within 400 m and the
tram and bus stops near it. The engine lets them arrive at random by the hour and cross: at
zebra crossings drivers give way to them; at signals they cross while the roads they cross
have red, and drivers turning across them give way.

No open counts of pedestrians in Zagreb were found, so the numbers are estimates: the uses a
day a crossing gets from each resident and job near it (`USES_PER_PERSON`), so that crossings
where many people live and work close together are the busiest, and the pedestrians each tram
or bus stopping brings to the crossings around its stop (`WALKERS_PER_STOP`).
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import numpy as np
import osmium
import shapely
from pyproj import Transformer
from scipy.spatial import cKDTree

from .config import CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR
from .osm import ATTRIBUTION as OSM_ATTRIBUTION
from .osm import fetch_osm
from .packed import read_packed, write_packed
from .transit import network_lanes, tangent

log = logging.getLogger(__name__)

# Kinds of crossing: drivers give way to pedestrians on a zebra (or other marked crossing);
# at a crossing of a signalled junction pedestrians walk while the roads they cross have red;
# a crossing with signals of its own turns red for drivers when pedestrians call it.
ZEBRA, JUNCTION_SIGNAL, OWN_SIGNAL = 0, 1, 2
PASSENGER = 1  # lane permission bit for cars (pipeline/simnet.py)
NONE = 0xFFFFFFFF
# A crossing takes the lanes passing within this far (m) of its node, and those ending or
# starting this far short of it (netconvert cuts lanes back from the junction).
REACH = 7.0
END_SLACK = 8.0
# Lanes of the road a crossing crosses run within this angle of each other, either way.
ALONG_ROAD = 0.7  # cosine
# A signalled crossing this close (m) to a signalled junction walks with its program.
NEAR_JUNCTION = 30.0
# Pedestrians come from the homes and jobs within this far (m), fewer the further, and from
# the tram and bus stops within `STOP_REACH`, shared among the crossings near each by distance.
CATCHMENT = 400.0
STOP_REACH = 150.0
# Uses a day a crossing gets per resident or job beside it (falling to none at `CATCHMENT`),
# and pedestrians each tram or bus stopping brings to the crossings near its stop (both
# estimated).
USES_PER_PERSON = 0.3
WALKERS_PER_STOP = 6.0
# Kerbs and refuges: a crossing is this much (m) longer than the lanes it crosses.
KERBS = 1.0
# Share of a weekday's pedestrians in each hour (estimated: busiest from the morning commute
# through the afternoon, as in city centres' counts elsewhere).
HOURLY = np.array(
    [3, 2, 1, 1, 2, 8, 30, 60, 65, 55, 55, 60, 65, 65, 65, 70, 75, 75, 65, 50, 40, 30, 20, 12],
    dtype=np.float64,
)
HOURLY = HOURLY / HOURLY.sum()

ATTRIBUTION = {
    **OSM_ATTRIBUTION,
    "text": "Pedestrian crossings from OpenStreetMap; pedestrians a day estimated from homes, "
    "jobs and stops near each.",
}


def crossing_kind(tags: dict[str, str]) -> int | None:
    """ZEBRA, JUNCTION_SIGNAL (refined later by where it is) or None for a crossing drivers
    need not give way at (unmarked)."""
    crossing = tags.get("crossing", "")
    markings = tags.get("crossing:markings", "")
    if crossing == "traffic_signals" or tags.get("crossing:signals") == "yes":
        return JUNCTION_SIGNAL
    if crossing in ("unmarked", "no", "informal") or markings == "no":
        return None
    return ZEBRA


def crossing_nodes(pbf: Path, scene) -> tuple[np.ndarray, np.ndarray]:
    """Scene positions and kinds of the crossings mapped as nodes."""
    pts, kinds = [], []
    for obj in osmium.FileProcessor(str(pbf), osmium.osm.NODE):
        tags = obj.tags
        if tags.get("highway") != "crossing" and "crossing" not in tags:
            continue
        kind = crossing_kind({t.k: t.v for t in tags})
        if kind is None or not obj.location.valid():
            continue
        pts.append((obj.location.lon, obj.location.lat))
        kinds.append(kind)
    if not pts:
        return np.zeros((0, 2)), np.zeros(0, np.uint8)
    lonlat = np.asarray(pts)
    return scene(lonlat[:, 0], lonlat[:, 1]), np.asarray(kinds, np.uint8)


def crossed_lanes(
    point: np.ndarray, tree: shapely.STRtree, lanes: tuple
) -> list[tuple[int, float, str]]:
    """Lanes a crossing at `point` crosses: (lane index into `lanes`, metres along it, where:
    'mid', 'end' (the lane ends just before it) or 'start'). Only the road of the nearest
    lane, either way: a crossing by a junction's corner is not across the side road too."""
    ids, _, lengths, lines = lanes
    p = shapely.Point(point)
    out = []
    for i in tree.query(p, predicate="dwithin", distance=REACH + END_SLACK):
        line = lines[i]
        along = line.project(p)
        scale = float(lengths[i]) / max(line.length, 1e-6)
        if 0.0 < along < line.length:
            if line.distance(p) <= REACH:
                out.append((int(i), along * scale, "mid"))
            continue
        # Beyond an end: only if the lane points at it (the crossing lies on its way on).
        end = np.asarray(line.coords[-1] if along >= line.length else line.coords[0])
        tip = np.asarray(line.coords[-2] if along >= line.length else line.coords[1])
        ahead = end - tip if along >= line.length else tip - end
        to = np.asarray(point) - end
        gap = float(np.hypot(*to))
        if gap > END_SLACK or gap == 0:
            continue
        side = abs(ahead[0] * to[1] - ahead[1] * to[0]) / max(float(np.hypot(*ahead)), 1e-6)
        if side > REACH / 2 or np.dot(ahead, to) * (1 if along >= line.length else -1) <= 0:
            continue
        if along >= line.length:
            out.append((int(i), max(float(lengths[i]) - 0.5, 0.0), "end"))
        else:
            out.append((int(i), min(0.5, float(lengths[i])), "start"))
    if len(out) > 1:
        nearest = min(out, key=lambda h: lines[h[0]].distance(p))
        axis = tangent(lines[nearest[0]], lines[nearest[0]].project(p))
        out = [
            h
            for h in out
            if abs(np.dot(tangent(lines[h[0]], lines[h[0]].project(p)), axis)) >= ALONG_ROAD
        ]
    return out


def allocate(
    sources: np.ndarray, weights: np.ndarray, sinks: np.ndarray, reach: float, shared: bool
):
    """Each source's weight at the sinks within `reach`, times 1 - distance / reach: shared
    among them (the shares adding up to the weight) or not (each sink near a source gets it
    in full beside it)."""
    out = np.zeros(len(sinks))
    if len(sources) == 0 or len(sinks) == 0:
        return out
    tree = cKDTree(sinks)
    for src, w in zip(sources, weights, strict=True):
        if w <= 0:
            continue
        near = tree.query_ball_point(src, reach)
        if not near:
            continue
        d = np.hypot(*(sinks[near] - src).T)
        share = 1.0 - d / reach
        total = share.sum() if shared else 1.0
        if total > 0:
            out[near] += w * share / total
    return out


def build_pedestrians(root: Path = OUTPUT_DIR) -> dict:
    """The crossings placed on the network in `root`, with pedestrians a day, written there."""
    started = time.monotonic()
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)

    def scene(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        e, n = to_crs.transform(lon, lat)
        return np.column_stack([np.asarray(e) - ORIGIN_E, ORIGIN_N - np.asarray(n)])

    index = json.loads((root / "network" / "net.json").read_text())
    net = read_packed(root / "network" / index["file"], index)
    lanes = network_lanes(net, index, PASSENGER)
    tree = shapely.STRtree(lanes[3])
    points, kinds = crossing_nodes(fetch_osm(), scene)

    tls_junction = np.zeros(len(net["junctionLinkCount"]), bool)
    with_tls = net["linkTls"] != index["none"]
    tls_junction[net["linkJunction"][with_tls]] = True
    edge_from, edge_to = net["edgeFrom"], net["edgeTo"]

    offsets = [0]
    lane_ids: list[int] = []
    lane_pos: list[float] = []
    kind_out, length_out, junction_out, xy_out = [], [], [], []
    skipped = 0
    for point, kind in zip(points, kinds, strict=True):
        hits = crossed_lanes(point, tree, lanes)
        if not hits:
            skipped += 1
            continue
        junction = NONE
        if kind == JUNCTION_SIGNAL:
            near = []
            for i, pos, where in hits:
                edge = int(lanes[1][i])
                if where == "end" or pos > float(lanes[2][i]) - NEAR_JUNCTION:
                    near.append(int(edge_to[edge]))
                if where == "start" or pos < NEAR_JUNCTION:
                    near.append(int(edge_from[edge]))
            near = [j for j in near if j != NONE and tls_junction[j]]
            if near:
                junction = max(set(near), key=near.count)
            else:
                kind = OWN_SIGNAL
        width = sum(float(net["laneWidth"][lanes[0][i]]) for i, _, _ in hits)
        for i, pos, _ in hits:
            lane_ids.append(int(lanes[0][i]))
            lane_pos.append(pos)
        offsets.append(len(lane_ids))
        kind_out.append(kind)
        length_out.append(width + KERBS)
        junction_out.append(junction)
        xy_out.append(point)
    xy = np.asarray(xy_out).reshape(-1, 2)

    # Pedestrians a day: homes and jobs near each crossing, and its tram and bus stops.
    d_index = json.loads((root / "demand" / "demand.json").read_text())
    demand = read_packed(root / "demand" / d_index["file"], d_index)
    edge_xy = np.zeros((len(edge_from), 2))
    first_lane = {}
    for i, edge in enumerate(lanes[1].tolist()):
        first_lane.setdefault(edge, i)
    for edge, i in first_lane.items():
        c = lanes[3][i].interpolate(0.5, normalized=True)
        edge_xy[edge] = (c.x, c.y)
    homes_jobs = demand["demandHome"].astype(np.float64) + demand["demandWork"]
    people = allocate(
        edge_xy[demand["demandEdge"]], homes_jobs * USES_PER_PERSON, xy, CATCHMENT, False
    )
    t_index = json.loads((root / "transit" / "transit.json").read_text())
    transit = read_packed(root / "transit" / t_index["file"], t_index)
    stop_edges, visits = np.unique(transit["transitStopEdge"], return_counts=True)
    keep = np.isin(stop_edges, list(first_lane))
    riders = allocate(
        edge_xy[stop_edges[keep]], visits[keep] * WALKERS_PER_STOP, xy, STOP_REACH, True
    )
    daily = people + riders

    arrays = {
        "crossingLaneOffsets": np.asarray(offsets, np.uint32),
        "crossingLanes": np.asarray(lane_ids, np.uint32),
        "crossingPos": np.asarray(lane_pos, np.float32),
        "crossingKind": np.asarray(kind_out, np.uint8),
        "crossingLength": np.asarray(length_out, np.float32),
        "crossingJunction": np.asarray(junction_out, np.uint32),
        "crossingDaily": daily.astype(np.float32),
        "crossingXY": xy.astype(np.float32).ravel(),
    }
    out_dir = root / "pedestrians"
    out_dir.mkdir(parents=True, exist_ok=True)
    packed = write_packed(out_dir / "crossings.bin.gz", arrays)
    kind_counts = np.bincount(np.asarray(kind_out, np.int64), minlength=3)
    stats = {
        "crossings": len(kind_out),
        "zebra": int(kind_counts[ZEBRA]),
        "atSignals": int(kind_counts[JUNCTION_SIGNAL]),
        "ownSignals": int(kind_counts[OWN_SIGNAL]),
        "notOnRoads": skipped,
        "pedestriansDaily": round(float(daily.sum())),
        "busiestDaily": round(float(daily.max())) if len(daily) else 0,
        "medianDaily": round(float(np.median(daily))) if len(daily) else 0,
    }
    (out_dir / "crossings.json").write_text(
        json.dumps({**packed, **stats, "hourly": HOURLY.round(5).tolist()})
    )
    log.info("pedestrians: %s (%.0fs)", stats, time.monotonic() - started)
    return {"index": "pedestrians/crossings.json", **stats, "attribution": ATTRIBUTION}
