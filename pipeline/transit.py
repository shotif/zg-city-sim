"""ZET trams and buses and HŽ trains: a weekday's timetable from ZET's and HŽ Putnički
prijevoz's GTFS feeds, with every stop placed on a lane of the network in its direction of
travel.

The engine (sim/src/transit.rs) starts each trip at its first departure, drives it from stop
to stop along the network and holds it at each stop until its scheduled departure.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import logging
import time
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from .config import CACHE_DIR, CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR, WORLD
from .packed import read_packed, write_packed

log = logging.getLogger(__name__)

GTFS_URL = "https://www.zet.hr/gtfs-scheduled/latest"
MAX_AGE_DAYS = 7
ATTRIBUTION = {
    "name": "ZET GTFS",
    "text": "Tram and bus timetables: Zagrebački električni tramvaj (ZET), GTFS feed. "
    "Otvorena dozvola (Open Licence of the Republic of Croatia).",
    "url": "https://www.zet.hr/preuzimanja/odredbe/datoteke-u-gtfs-formatu/669",
}

HZ_GTFS_URL = "https://www.hzpp.hr/GTFS_files.zip"
HZ_ATTRIBUTION = {
    "name": "HŽ Putnički prijevoz GTFS",
    "text": "Train timetables: HŽ Putnički prijevoz, GTFS feed published on the national open "
    "data portal for public use (no licence is stated).",
    "url": "https://data.gov.hr/ckan/dataset/vozni-red-h-putni-kog-prijevoza-u-gtfs-obliku",
}

# Engine vehicle types (sim/src/vtype.rs) and their lane permission bits (pipeline/simnet.py).
BUS, TRAM, TRAIN = 2, 3, 4
MODE_OF_ROUTE_TYPE = {"0": TRAM, "3": BUS}
VCLASS = {BUS: 2, TRAM: 4, TRAIN: 16}
# How far from a stop its lane may be (m): platforms sit beside the track or kerb, and a
# station spans several tracks.
STOP_RADIUS = {BUS: 40.0, TRAM: 30.0, TRAIN: 80.0}
# A stop visit that names no stop (a train crossing the map's edge), in `transitStopRef`.
NO_STOP = 0xFFFFFFFF
# A line's stop patterns kept for the app: those with this share of its trips, at most this
# many (both directions and the main variants).
PATTERN_SHARE = 0.05
MAX_PATTERNS = 6
# A train coming from beyond the map drives in where a track crosses the map's edge: track
# ends within this far (m) of the edge, and within this far (m) of the straight line between
# the stations either side of it.
EDGE_OF_MAP = 1500.0
TRACK_END_REACH = 4000.0
DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
# A lane serves a stop's direction if it runs within this angle of the route's shape.
MIN_ALIGNMENT = 0.5  # cosine
# Where a route's shape passes a stop: places on the shape (sampled this often, m) nearest
# the stop on each pass within this much (m) of the nearest of all. Stops are taken in order
# along the shape; one out of order counts as this far off it (m).
SHAPE_STEP = 5.0
SHAPE_SLACK = 20.0
SHAPE_BACK = 1000.0
# A station's track is one of the tracks running the train's way within `STOP_RADIUS` (the
# nearest this many), and a train from beyond the map enters on one of the track ends nearest
# the line from the station before: each trip takes those with the quickest way between its
# stations, so that it never has to turn back at a siding to reach a platform on a track its
# own does not lead to.
TRACK_CHOICES = 12
# Seconds counted for each metre a track lies off the station (or a track end off the line
# between the stations either side of it), so that of tracks equally quick the nearest wins.
OFF_STATION_COST = 0.2
# Seconds counted for a station a trip leaves out, as no track leads there from those before.
LEFT_OUT_COST = 3600.0


def fetch_gtfs(max_age_days: int = MAX_AGE_DAYS) -> Path:
    """The latest ZET GTFS feed, downloaded at most once every `max_age_days`."""
    return fetch_feed(GTFS_URL, "zet", max_age_days)


def fetch_hz_gtfs(max_age_days: int = MAX_AGE_DAYS) -> Path:
    """The latest HŽ Putnički prijevoz GTFS feed, downloaded at most once every
    `max_age_days`."""
    return fetch_feed(HZ_GTFS_URL, "hz", max_age_days)


def fetch_feed(url: str, name: str, max_age_days: int) -> Path:
    folder = CACHE_DIR / "gtfs"
    folder.mkdir(parents=True, exist_ok=True)
    cached = sorted(folder.glob(f"{name}_*.zip"))
    if cached and time.time() - cached[-1].stat().st_mtime < max_age_days * 86400:
        return cached[-1]
    path = folder / f"{name}_{dt.date.today():%Y%m%d}.zip"
    log.info("downloading %s", url)
    req = urllib.request.Request(url, headers={"User-Agent": "zg-city-sim pipeline"})
    with urllib.request.urlopen(req, timeout=600) as response:
        data = response.read()
    tmp = path.with_name(path.name + ".partial")
    tmp.write_bytes(data)
    tmp.rename(path)
    return path


def read_table(feed: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    with feed.open(name) as raw:
        return list(csv.DictReader(io.TextIOWrapper(raw, "utf-8-sig")))


def parse_time(hms: str) -> int:
    """GTFS time "25:10:00" -> seconds after the service day's midnight (may exceed 24 h)."""
    h, m, s = (int(part) for part in hms.strip().split(":"))
    return h * 3600 + m * 60 + s


def weekday_service(calendar: list[dict], calendar_dates: list[dict]) -> tuple[set[str], str]:
    """Service ids running on a typical weekday (the first Wednesday the feed covers)."""
    by_date: dict[str, set[str]] = {}
    for row in calendar_dates:
        if row["exception_type"] == "1":
            by_date.setdefault(row["date"], set()).add(row["service_id"])
    for row in calendar:
        start = dt.datetime.strptime(row["start_date"], "%Y%m%d").date()
        if row.get("wednesday") == "1":
            for k in range(7):
                day = start + dt.timedelta(days=k)
                if day.weekday() == 2:
                    by_date.setdefault(f"{day:%Y%m%d}", set()).add(row["service_id"])
    for date in sorted(by_date):
        if dt.datetime.strptime(date, "%Y%m%d").weekday() == 2:
            return by_date[date], date
    raise LookupError("the GTFS feed has no Wednesday service")


def services_on(calendar: list[dict], calendar_dates: list[dict], date: str) -> set[str]:
    """Service ids running on `date` (YYYYMMDD)."""
    day = DAYS[dt.datetime.strptime(date, "%Y%m%d").weekday()]
    on = {
        r["service_id"]
        for r in calendar
        if r["start_date"] <= date <= r["end_date"] and r.get(day) == "1"
    }
    for r in calendar_dates:
        if r["date"] == date:
            if r["exception_type"] == "1":
                on.add(r["service_id"])
            else:
                on.discard(r["service_id"])
    return on


def tangent(line: shapely.LineString, distance: float, step: float = 8.0) -> np.ndarray:
    """Unit direction of a line around `distance` metres along it."""
    a = shapely.line_interpolate_point(line, max(0.0, distance - step))
    b = shapely.line_interpolate_point(line, min(line.length, distance + step))
    v = np.array([b.x - a.x, b.y - a.y])
    n = np.hypot(*v)
    return v / n if n > 0 else v


def along_shape(shape: shapely.LineString, points: np.ndarray) -> list[float]:
    """How far along `shape` each of `points` (a trip's stops, in order) lies. A shape can pass
    a stop more than once (a route running out and back along one street passes each stop
    on both sides): of the places nearest the stop on each pass, the stops take those in the
    order they are served that lie nearest them in all (Viterbi)."""
    d = np.minimum(np.arange(0.0, shape.length + SHAPE_STEP, SHAPE_STEP), shape.length)
    xy = shapely.get_coordinates(shapely.line_interpolate_point(shape, d))
    passes = []
    for p in points:
        dist = np.hypot(*(xy - p).T)
        padded = np.concatenate([[np.inf], dist, [np.inf]])
        nearest = (dist <= padded[:-2]) & (dist <= padded[2:]) & (dist <= dist.min() + SHAPE_SLACK)
        i = np.flatnonzero(nearest)
        passes.append((d[i], dist[i]))
    cost = passes[0][1]
    back = []
    for (here, off), (before, _) in zip(passes[1:], passes, strict=False):
        # Going back along the shape counts as this far off (m).
        total = cost[None, :] + np.where(before[None, :] <= here[:, None], 0.0, SHAPE_BACK)
        best = np.argmin(total, axis=1)
        cost = total[np.arange(len(here)), best] + off
        back.append(best)
    k = int(np.argmin(cost))
    out = [float(passes[-1][0][k])]
    for n in range(len(points) - 2, -1, -1):
        k = int(back[n][k])
        out.append(float(passes[n][0][k]))
    return out[::-1]


def network_lanes(net: dict[str, np.ndarray], index: dict, vclass: int):
    """Normal lanes allowing `vclass`: ids, edges, SUMO lengths and shapes as lines."""
    internal = (net["edgeFlags"][net["laneEdge"]] & index["flags"]["internal"]) != 0
    lanes = np.flatnonzero(~internal & ((net["laneAllow"] & vclass) != 0))
    offsets = net["laneShapeOffsets"].astype(np.int64)
    origin = net["laneShapeOrigin"].reshape(-1, 2).astype(np.int64)
    delta = net["laneShapeDelta"].reshape(-1, 2).astype(np.int64)
    lines = []
    keep = []
    for lane in lanes:
        pts = (origin[lane] + np.cumsum(delta[offsets[lane] : offsets[lane + 1]], axis=0)) / 100
        if len(pts) >= 2:
            lines.append(shapely.LineString(pts))
            keep.append(lane)
    keep = np.asarray(keep, np.int64)
    return keep, net["laneEdge"][keep], net["laneLength"][keep], np.asarray(lines, dtype=object)


def place_stop(
    point: shapely.Point,
    direction: np.ndarray,
    tree: shapely.STRtree,
    lines: np.ndarray,
    radius: float,
) -> tuple[int, float] | None:
    """Nearest lane (index into `lines`) running in `direction` within `radius`, and the
    fraction of its length where the stop is."""
    best = None
    for i in tree.query(point, predicate="dwithin", distance=radius):
        line = lines[i]
        along = line.project(point)
        d = line.distance(point)
        if np.dot(tangent(line, along, 3.0), direction) < MIN_ALIGNMENT:
            continue
        if best is None or d < best[0]:
            best = (d, int(i), along / max(line.length, 1e-6))
    return (best[1], best[2]) if best else None


class TrackGraph:
    """The rail or tram network as a graph of its edges, for the quickest way between stops:
    the time to drive each edge at its speed limit, and which edges a vehicle of `vclass` can
    go on to."""

    def __init__(self, net: dict[str, np.ndarray], index: dict, vclass: int):
        internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
        lane_edge = net["laneEdge"].astype(np.int64)
        rail = (net["laneAllow"] & vclass) != 0
        lane_time = net["laneLength"] / np.maximum(net["laneSpeed"], 1.0)
        lanes = np.flatnonzero(rail & ~internal[lane_edge])
        self.edges = np.unique(lane_edge[lanes])
        self.node = np.full(len(net["edgeFrom"]), -1, np.int64)
        self.node[self.edges] = np.arange(len(self.edges))
        self.time = np.zeros(len(self.edges))
        self.time[self.node[lane_edge[lanes]]] = lane_time[lanes]
        frm, to, via = (net[k].astype(np.int64) for k in ("linkFrom", "linkTo", "linkVia"))
        a, b = self.node[lane_edge[frm]], self.node[lane_edge[to]]
        keep = rail[frm] & rail[to] & (a >= 0) & (b >= 0)
        a, b, via = a[keep], b[keep], via[keep]
        inside = via < len(lane_time)
        cost = self.time[b] + np.where(inside, lane_time[np.where(inside, via, 0)], 0.0)
        # One arc per pair of edges (the matrix would add repeats up), none of zero cost
        # (which it would leave out).
        order = np.lexsort((cost, b, a))
        first = np.ones(len(order), bool)
        first[1:] = (a[order][1:] != a[order][:-1]) | (b[order][1:] != b[order][:-1])
        pick = order[first]
        n = len(self.edges)
        self.graph = csr_matrix((cost[pick] + 1e-3, (a[pick], b[pick])), shape=(n, n))
        self.reached: dict[int, np.ndarray] = {}

    def between(self, a: int, frac_a: float, b: int, frac_b: float) -> float:
        """Seconds from `frac_a` along edge `a` to `frac_b` along edge `b` at the speed
        limits (infinite if no track leads there)."""
        na, nb = int(self.node[a]), int(self.node[b])
        if na < 0 or nb < 0:
            return np.inf
        if a == b and frac_b >= frac_a:
            return (frac_b - frac_a) * self.time[na]
        if na not in self.reached:
            self.reached[na] = dijkstra(self.graph, indices=na)
        reached = self.reached[na][nb]
        return (1 - frac_a) * self.time[na] + reached - (1 - frac_b) * self.time[nb]


def track_ends(
    net: dict[str, np.ndarray], lanes: tuple
) -> tuple[list[tuple[int, np.ndarray]], list[tuple[int, np.ndarray]]]:
    """Rail edges where trains drive into the map and off it, with the point where they cross
    its edge: those starting or ending at a junction no other track meets (only the same
    track back, where a two-way track ends), within `EDGE_OF_MAP` of the map's edge, not
    sidings that end inside it."""
    _, edges, _, lines = lanes
    edge_from, edge_to = net["edgeFrom"], net["edgeTo"]
    neighbours: dict[int, set[int]] = {}
    for edge in edges.tolist():
        a, b = int(edge_from[edge]), int(edge_to[edge])
        neighbours.setdefault(a, set()).add(b)
        neighbours.setdefault(b, set()).add(a)
    x0, x1 = WORLD.min_e - ORIGIN_E, WORLD.max_e - ORIGIN_E
    z0, z1 = ORIGIN_N - WORLD.max_n, ORIGIN_N - WORLD.min_n

    def end_of_map(p: np.ndarray) -> bool:
        return min(p[0] - x0, x1 - p[0], p[1] - z0, z1 - p[1]) < EDGE_OF_MAP

    sources, sinks = [], []
    for edge, line in zip(edges.tolist(), lines, strict=True):
        a, b = int(edge_from[edge]), int(edge_to[edge])
        start, end = np.asarray(line.coords[0]), np.asarray(line.coords[-1])
        if len(neighbours[a]) == 1 and end_of_map(start):
            sources.append((edge, start))
        if len(neighbours[b]) == 1 and end_of_map(end):
            sinks.append((edge, end))
    return sources, sinks


def nearest_ends(
    ends: list[tuple[int, np.ndarray]], a: np.ndarray, b: np.ndarray, frac: float
) -> list[tuple[int, float, float]]:
    """The track ends within `TRACK_END_REACH` of the straight line from `a` to `b`, nearest
    first: (edge, `frac`, how far off the line in seconds)."""
    line = shapely.LineString([a, b])
    near = sorted((line.distance(shapely.Point(p)), edge) for edge, p in ends)
    return [
        (edge, frac, d * OFF_STATION_COST)
        for d, edge in near[:TRACK_CHOICES]
        if d <= TRACK_END_REACH
    ]


def station_tracks(
    point: shapely.Point,
    direction: np.ndarray | None,
    tree: shapely.STRtree,
    lanes: tuple,
    radius: float,
) -> list[tuple[int, float, float]]:
    """Tracks within `radius` of a station or stop (running in `direction`, if given),
    nearest first: (edge, fraction of its length where the stop is, how far off in seconds)."""
    lines = lanes[3]
    near = []
    for i in tree.query(point, predicate="dwithin", distance=radius):
        line = lines[i]
        along = line.project(point)
        if direction is not None and np.dot(tangent(line, along, 3.0), direction) < MIN_ALIGNMENT:
            continue
        near.append((line.distance(point), int(lanes[1][i]), along / max(line.length, 1e-6)))
    near.sort()
    return [(edge, frac, d * OFF_STATION_COST) for d, edge, frac in near[:TRACK_CHOICES]]


def quickest_tracks(
    graph: TrackGraph, choices: list[list[tuple[int, float, float]]]
) -> list[tuple[int, float] | None]:
    """For each station in turn, the track of its `choices` that makes the trip quickest
    (Viterbi), or None for a station left out: one no track before leads to, or one before
    those no track goes on from (each counted as `LEFT_OUT_COST`)."""
    stations = [i for i, here in enumerate(choices) if here]
    cost: dict[int, np.ndarray] = {}
    back: dict[int, list[tuple[int, int] | None]] = {}
    for n, i in enumerate(stations):
        here = choices[i]
        off = np.array([c[2] for c in here])
        # Starting here, leaving out the stations before.
        cost[i] = LEFT_OUT_COST * n + off
        back[i] = [None] * len(here)
        for m in range(max(0, n - 3), n):
            j = stations[m]
            prev = choices[j]
            step = np.array([[graph.between(p[0], p[1], h[0], h[1]) for p in prev] for h in here])
            total = step + cost[j][None, :] + LEFT_OUT_COST * (n - m - 1)
            best = np.argmin(total, axis=1)
            reached = total[np.arange(len(here)), best] + off
            for k in np.flatnonzero(reached < cost[i]):
                cost[i][k] = reached[k]
                back[i][k] = (j, int(best[k]))
    picked: list[tuple[int, float] | None] = [None] * len(choices)
    if not stations:
        return picked
    end = min(
        (
            (cost[i][k] + LEFT_OUT_COST * (len(stations) - n - 1), i, k)
            for n, i in enumerate(stations)
            for k in range(len(cost[i]))
        ),
    )
    at: tuple[int, int] | None = (end[1], end[2])
    while at is not None:
        i, k = at
        picked[i] = choices[i][k][:2]
        at = back[i][k]
    return picked


def train_trips(
    path: Path,
    date: str,
    scene,
    net: dict[str, np.ndarray],
    index: dict,
    lanes: tuple,
    tree: shapely.STRtree,
    route_base: int,
) -> tuple[list, list[dict], dict, list[dict], dict]:
    """HŽ's trains running on `date` that call at a station inside the map, each from where
    it enters the map (or its first station) to where it leaves (or its last). Stations go on
    a track running the way the train does, judged from the stations before and after; a
    train coming from beyond the map starts on a track crossing the map's edge near the line
    to its last station outside, at the time it would pass there (by distance between the
    stations), and one going beyond it ends on a track leaving the map. Of the tracks that
    could serve, each trip takes those with the quickest way between them. Also the stations
    served, each with its calls: [arrival, departure (s), train number, from, to], where `from`
    is empty at the train's first station and `to` at its last; and each station's name and
    position, by ("hz", stop id) as the trips' stops name them (None where a train crosses
    the map's edge)."""
    with zipfile.ZipFile(path) as feed:
        routes = {r["route_id"]: r for r in read_table(feed, "routes.txt")}
        names = feed.namelist()
        dates = read_table(feed, "calendar_dates.txt") if "calendar_dates.txt" in names else []
        service = services_on(read_table(feed, "calendar.txt"), dates, date)
        trips = [
            t
            for t in read_table(feed, "trips.txt")
            if t["service_id"] in service and routes[t["route_id"]]["route_type"] == "2"
        ]
        trip_ids = {t["trip_id"] for t in trips}
        stops = {s["stop_id"]: s for s in read_table(feed, "stops.txt")}
        times: dict[str, list[tuple[int, str, int, int]]] = {}
        with feed.open("stop_times.txt") as raw:
            for row in csv.DictReader(io.TextIOWrapper(raw, "utf-8-sig")):
                if row["trip_id"] in trip_ids:
                    times.setdefault(row["trip_id"], []).append(
                        (
                            int(row["stop_sequence"]),
                            row["stop_id"],
                            parse_time(row["arrival_time"]),
                            parse_time(row["departure_time"]),
                        )
                    )
    stop_ids = sorted(stops)
    xy = dict(
        zip(
            stop_ids,
            scene(
                np.array([float(stops[s]["stop_lon"]) for s in stop_ids]),
                np.array([float(stops[s]["stop_lat"]) for s in stop_ids]),
            ),
            strict=True,
        )
    )
    sources, sinks = track_ends(net, lanes)
    graph = TrackGraph(net, index, VCLASS[TRAIN])
    tracks: dict[tuple[str, int], list[tuple[int, float, float]]] = {}

    def choices(
        stop_id: str, direction: np.ndarray, either: bool
    ) -> list[tuple[int, float, float]]:
        # At a train's first or last station its way is judged from one neighbour only, and
        # the line may curve into the station (from Zagreb Klara, trains run north into
        # Glavni kolodvor's east-west platforms): there, tracks running either way.
        if either:
            key = (stop_id, -1)
            if key not in tracks:
                point = shapely.Point(xy[stop_id])
                tracks[key] = station_tracks(point, None, tree, lanes, STOP_RADIUS[TRAIN])
            return tracks[key]
        n = np.hypot(*direction)
        if n == 0:
            return []
        direction = direction / n
        sector = int((np.arctan2(direction[1], direction[0]) + np.pi) / (2 * np.pi) * 8) % 8
        key = (stop_id, sector)
        if key not in tracks:
            point = shapely.Point(xy[stop_id])
            tracks[key] = station_tracks(point, direction, tree, lanes, STOP_RADIUS[TRAIN])
        return tracks[key]

    route_ids = sorted({t["route_id"] for t in trips})
    route_index = {r: route_base + i for i, r in enumerate(route_ids)}
    source_point = dict(sources)
    out = []
    entering = leaving = unreached = 0
    served: set[str] = set()
    calls: dict[str, list[tuple[int, int, str, str, str]]] = {}
    tight: list[float] = []
    for trip in trips:
        seq = sorted(times.get(trip["trip_id"], []))
        pts = [xy[s[1]] for s in seq]
        options = [
            choices(
                seq[i][1],
                pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)],
                i in (0, len(seq) - 1),
            )
            for i in range(len(seq))
        ]
        inside = [i for i, c in enumerate(options) if c]
        if not inside:
            continue
        first, last = inside[0], inside[-1]
        # Stations inside the map, between the tracks entering and leaving it if it comes
        # from or goes beyond the map.
        entry = nearest_ends(sources, pts[first - 1], pts[first], 0.0) if first > 0 else []
        exit_ = nearest_ends(sinks, pts[last], pts[last + 1], 1.0) if last < len(seq) - 1 else []
        picked = quickest_tracks(graph, [entry] + [options[i] for i in inside] + [exit_])
        stops_out: list[tuple[int, float, float, tuple[str, str] | None]] = []
        trip_calls = []
        if picked[0] is not None:
            end = source_point[picked[0][0]]
            d0 = np.hypot(*(end - pts[first - 1]))
            d1 = np.hypot(*(pts[first] - end))
            t0, t1 = seq[first - 1][3], seq[first][2]
            stops_out.append((picked[0][0], 0.0, t0 + (t1 - t0) * d0 / max(d0 + d1, 1.0), None))
            entering += 1
        for i, hit in zip(inside, picked[1:-1], strict=True):
            if hit is None:
                unreached += 1
                continue
            edge, frac = hit
            served.add(seq[i][1])
            trip_calls.append(
                (
                    seq[i][1],
                    (
                        seq[i][2],
                        seq[i][3],
                        trip["trip_short_name"],
                        stops[seq[0][1]]["stop_name"] if i > 0 else "",
                        stops[seq[-1][1]]["stop_name"] if i < len(seq) - 1 else "",
                    ),
                )
            )
            if stops_out and stops_out[-1][0] == edge and abs(stops_out[-1][1] - frac) < 0.02:
                continue
            stops_out.append((edge, frac, seq[i][3], ("hz", seq[i][1])))
        if picked[-1] is not None:
            stops_out.append((picked[-1][0], 1.0, seq[last + 1][2], None))
            leaving += 1
        for a, b in zip(stops_out, stops_out[1:], strict=False):
            tight.append(graph.between(a[0], a[1], b[0], b[1]) - (b[2] - a[2]))
        if len(stops_out) >= 2:
            headsign = stops[seq[-1][1]]["stop_name"]
            out.append((stops_out[0][2], TRAIN, route_index[trip["route_id"]], stops_out, headsign))
            for stop_id, call in trip_calls:
                calls.setdefault(stop_id, []).append(call)
    stations = [
        {
            "name": stops[s]["stop_name"],
            "x": round(float(xy[s][0]), 1),
            "z": round(float(xy[s][1]), 1),
            "calls": [list(c) for c in sorted(calls[s], key=lambda c: (c[1], c[2]))],
        }
        for s in sorted(calls, key=lambda s: stops[s]["stop_name"])
    ]
    table = [
        {
            "name": routes[r]["route_short_name"],
            "longName": routes[r]["route_long_name"],
            "mode": "train",
        }
        for r in route_ids
    ]
    stats = {
        "trainTrips": len(out),
        "trainsEntering": entering,
        "trainsLeaving": leaving,
        "stationsServed": len(served),
        # Calls left out: at a station no track from the one before leads to.
        "stationCallsLeftOut": unreached,
        # Legs between stations a train cannot drive in the time the timetable gives, even
        # at the speed limits all the way (dwell, speeding up and slowing down aside).
        "legsTooShort": int(sum(1 for t in tight if t > 0)),
        "legsTooShortBy": round(float(max(tight, default=0.0)), 1),
        "trackEnds": [len(sources), len(sinks)],
    }
    stop_info = {
        ("hz", s): (stops[s]["stop_name"], float(xy[s][0]), float(xy[s][1])) for s in served
    }
    return out, table, stats, stations, stop_info


def line_patterns(out_trips: list, refs: np.ndarray) -> list[dict]:
    """Each line's stop patterns, most trips first: its trips grouped by headsign and the
    stops they call at (`refs`, per stop visit in `out_trips`' order), keeping those with
    `PATTERN_SHARE` of the line's trips (at most `MAX_PATTERNS`)."""
    patterns: dict[int, Counter] = {}
    k = 0
    for trip in out_trips:
        n = len(trip[3])
        seq = tuple(int(r) for r in refs[k : k + n] if r != NO_STOP)
        k += n
        patterns.setdefault(trip[2], Counter())[(trip[4], seq)] += 1
    lines = []
    for route in sorted(patterns):
        counts = patterns[route]
        total = sum(counts.values())
        kept = [
            {"headsign": headsign, "stops": list(seq), "trips": n}
            for (headsign, seq), n in counts.most_common(MAX_PATTERNS)
            if n >= PATTERN_SHARE * total
        ]
        lines.append({"route": route, "trips": total, "patterns": kept})
    return lines


def build_transit(root: Path = OUTPUT_DIR) -> dict:
    """The timetable placed on the network in `root`, written there."""
    started = time.monotonic()
    path = fetch_gtfs()
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)

    def scene(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        e, n = to_crs.transform(lon, lat)
        return np.column_stack([np.asarray(e) - ORIGIN_E, ORIGIN_N - np.asarray(n)])

    with zipfile.ZipFile(path) as feed:
        routes = {r["route_id"]: r for r in read_table(feed, "routes.txt")}
        service, date = weekday_service(
            read_table(feed, "calendar.txt"), read_table(feed, "calendar_dates.txt")
        )
        trips = [t for t in read_table(feed, "trips.txt") if t["service_id"] in service]
        trips = [t for t in trips if routes[t["route_id"]]["route_type"] in MODE_OF_ROUTE_TYPE]
        trip_ids = {t["trip_id"] for t in trips}
        stops = {s["stop_id"]: s for s in read_table(feed, "stops.txt")}
        times: dict[str, list[tuple[int, str, int]]] = {}
        with feed.open("stop_times.txt") as raw:
            for row in csv.DictReader(io.TextIOWrapper(raw, "utf-8-sig")):
                if row["trip_id"] in trip_ids:
                    times.setdefault(row["trip_id"], []).append(
                        (
                            int(row["stop_sequence"]),
                            row["stop_id"],
                            parse_time(row["departure_time"]),
                        )
                    )
        shape_points: dict[str, list[tuple[int, float, float]]] = {}
        with feed.open("shapes.txt") as raw:
            for row in csv.DictReader(io.TextIOWrapper(raw, "utf-8-sig")):
                shape_points.setdefault(row["shape_id"], []).append(
                    (
                        int(row["shape_pt_sequence"]),
                        float(row["shape_pt_lon"]),
                        float(row["shape_pt_lat"]),
                    )
                )
    shapes = {}
    for sid, pts in shape_points.items():
        pts.sort()
        xy = scene(np.array([p[1] for p in pts]), np.array([p[2] for p in pts]))
        if len(xy) >= 2:
            shapes[sid] = shapely.LineString(xy)
    stop_ids = sorted(stops)
    stop_xy = dict(
        zip(
            stop_ids,
            scene(
                np.array([float(stops[s]["stop_lon"]) for s in stop_ids]),
                np.array([float(stops[s]["stop_lat"]) for s in stop_ids]),
            ),
            strict=True,
        )
    )

    n_index = json.loads((root / "network" / "net.json").read_text())
    net = read_packed(root / "network" / n_index["file"], n_index)
    lanes = {mode: network_lanes(net, n_index, VCLASS[mode]) for mode in (BUS, TRAM, TRAIN)}
    trees = {mode: shapely.STRtree(lanes[mode][3]) for mode in (BUS, TRAM, TRAIN)}

    # Each stop goes on a lane of its mode running the way the route's shape does there
    # (stops served in both directions, as at terminal loops, get a lane for each).
    directions: dict[tuple[str, tuple[str, ...]], list[np.ndarray | None]] = {}
    placed: dict[tuple[str, int, int], tuple[int, float] | None] = {}

    def shape_directions(shape_id: str, stop_ids: tuple[str, ...]) -> list[np.ndarray | None]:
        key = (shape_id, stop_ids)
        if key not in directions:
            shape = shapes.get(shape_id)
            known = [n for n, s in enumerate(stop_ids) if s in stop_xy]
            found: list[np.ndarray | None] = [None] * len(stop_ids)
            if shape is not None and known:
                at = along_shape(shape, np.array([stop_xy[stop_ids[n]] for n in known]))
                for n, d in zip(known, at, strict=True):
                    v = tangent(shape, d)
                    found[n] = v if np.hypot(*v) > 0 else None
            directions[key] = found
        return directions[key]

    def place(stop_id: str, mode: int, direction: np.ndarray | None):
        if stop_id not in stop_xy or direction is None:
            return None
        point = shapely.Point(stop_xy[stop_id])
        sector = int((np.arctan2(direction[1], direction[0]) + np.pi) / (2 * np.pi) * 8) % 8
        key = (stop_id, mode, sector)
        if key not in placed:
            hit = place_stop(point, direction, trees[mode], lanes[mode][3], STOP_RADIUS[mode])
            placed[key] = (int(lanes[mode][1][hit[0]]), float(hit[1])) if hit else None
        return placed[key]

    route_ids = sorted(
        routes,
        key=lambda r: (
            routes[r]["route_type"],
            len(routes[r]["route_short_name"]),
            routes[r]["route_short_name"],
        ),
    )
    # A tram stop goes on any tram track within reach, whichever way it runs (some routes'
    # shapes wander back and forth): each run of stops takes the tracks with the quickest way
    # between them, as trains do.
    tram_graph = TrackGraph(net, n_index, VCLASS[TRAM])
    tram_choices: dict[str, list[tuple[int, float, float]]] = {}
    tram_runs: dict[tuple[str, ...], list[tuple[int, float] | None]] = {}

    def tram_tracks(stop_ids: tuple[str, ...]) -> list[tuple[int, float] | None]:
        if stop_ids not in tram_runs:
            for s in stop_ids:
                if s not in tram_choices:
                    tram_choices[s] = (
                        station_tracks(
                            shapely.Point(stop_xy[s]),
                            None,
                            trees[TRAM],
                            lanes[TRAM],
                            STOP_RADIUS[TRAM],
                        )
                        if s in stop_xy
                        else []
                    )
            tram_runs[stop_ids] = quickest_tracks(tram_graph, [tram_choices[s] for s in stop_ids])
        return tram_runs[stop_ids]

    route_index = {r: i for i, r in enumerate(route_ids)}
    out_trips = []
    dropped_stops = 0
    for trip in trips:
        seq = sorted(times.get(trip["trip_id"], []))
        mode = MODE_OF_ROUTE_TYPE[routes[trip["route_id"]]["route_type"]]
        stops_out = []
        ids = tuple(s[1] for s in seq)
        if mode == TRAM:
            hits = tram_tracks(ids)
        else:
            heading = shape_directions(trip["shape_id"], ids)
            hits = [place(s, mode, d) for s, d in zip(ids, heading, strict=True)]
        for (_, stop_id, depart), hit in zip(seq, hits, strict=True):
            if hit is None:
                dropped_stops += 1
                continue
            # Consecutive stops on the same spot (timing points) count once.
            if stops_out and stops_out[-1][0] == hit[0] and abs(stops_out[-1][1] - hit[1]) < 0.02:
                stops_out[-1] = (hit[0], hit[1], depart, ("zet", stop_id))
                continue
            stops_out.append((hit[0], hit[1], depart, ("zet", stop_id)))
        if len(stops_out) >= 2:
            out_trips.append(
                (
                    stops_out[0][2],
                    mode,
                    route_index[trip["route_id"]],
                    stops_out,
                    trip.get("trip_headsign", ""),
                )
            )
    trains, train_routes, train_stats, stations, train_stops = train_trips(
        fetch_hz_gtfs(), date, scene, net, n_index, lanes[TRAIN], trees[TRAIN], len(route_ids)
    )
    out_trips.extend(trains)
    out_trips.sort(key=lambda t: t[0])

    offsets = np.zeros(len(out_trips) + 1, np.uint32)
    offsets[1:] = np.cumsum([len(t[3]) for t in out_trips])
    all_stops = [s for t in out_trips for s in t[3]]
    arrays = {
        "transitTripType": np.asarray([t[1] for t in out_trips], np.uint8),
        "transitTripRoute": np.asarray([t[2] for t in out_trips], np.uint16),
        "transitTripStops": offsets,
        "transitStopEdge": np.asarray([s[0] for s in all_stops], np.uint32),
        "transitStopFrac": np.asarray([s[1] for s in all_stops], np.float32),
        "transitStopTime": np.asarray([s[2] for s in all_stops], np.float32),
    }
    # The stops the trips call at, for the app's Transit panel (M9a): each stop visit names
    # its stop (NO_STOP where a train crosses the map's edge), and lines.json lists the
    # stops' names and positions and each line's stop patterns.
    stop_index: dict[tuple[str, str], int] = {}
    stop_rows: list[list] = []

    def stop_ref(key: tuple[str, str] | None) -> int:
        if key is None:
            return NO_STOP
        if key not in stop_index:
            if key[0] == "zet":
                name = stops[key[1]]["stop_name"]
                x, z = stop_xy[key[1]]
            else:
                name, x, z = train_stops[key]
            stop_index[key] = len(stop_rows)
            stop_rows.append([name, round(float(x), 1), round(float(z), 1)])
        return stop_index[key]

    refs = np.asarray([stop_ref(s[3]) for s in all_stops], np.uint32)
    arrays["transitStopRef"] = refs
    lines = line_patterns(out_trips, refs)
    out_dir = root / "transit"
    packed = write_packed(out_dir / "transit.bin.gz", arrays)
    route_table = [
        {
            "name": routes[r]["route_short_name"],
            "longName": routes[r]["route_long_name"],
            "mode": "tram" if routes[r]["route_type"] == "0" else "bus",
        }
        for r in route_ids
    ] + train_routes
    stats = {
        "serviceDate": date,
        "trips": len(out_trips),
        "tramTrips": int((arrays["transitTripType"] == TRAM).sum()),
        "busTrips": int((arrays["transitTripType"] == BUS).sum()),
        **train_stats,
        "tripsWithoutStops": len(trips) - (len(out_trips) - len(trains)),
        "stopsPlaced": sum(1 for v in placed.values() if v is not None)
        + sum(1 for v in tram_choices.values() if v),
        "stopsUnplaced": sum(1 for v in placed.values() if v is None)
        + sum(1 for v in tram_choices.values() if not v),
        "stopVisitsDropped": dropped_stops,
    }
    # HŽ's stations in the map and their trains, for the app's station panel (M8e).
    (out_dir / "stations.json").write_text(
        json.dumps({"stations": stations}, ensure_ascii=False, separators=(",", ":"))
    )
    # Where each trip goes, as its signs say (HŽ's trains: their last station), by trip.
    headsigns = sorted({t[4] for t in out_trips})
    sign_index = {h: i for i, h in enumerate(headsigns)}
    (out_dir / "lines.json").write_text(
        json.dumps(
            {
                "stops": stop_rows,
                "lines": lines,
                "headsigns": headsigns,
                "tripHeadsign": [sign_index[t[4]] for t in out_trips],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    (out_dir / "transit.json").write_text(
        json.dumps(
            {
                **packed,
                "routes": route_table,
                "stations": "stations.json",
                "lines": "lines.json",
                **stats,
            },
            ensure_ascii=False,
        )
    )
    log.info("transit: %s (%.0fs)", stats, time.monotonic() - started)
    return {
        "index": "transit/transit.json",
        **stats,
        "attribution": [ATTRIBUTION, HZ_ATTRIBUTION],
    }
