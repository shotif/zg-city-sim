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
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer

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
# A train coming from beyond the map drives in where a track crosses the map's edge: track
# ends within this far (m) of the edge, and within this far (m) of the straight line between
# the stations either side of it.
EDGE_OF_MAP = 1500.0
TRACK_END_REACH = 4000.0
DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
# A lane serves a stop's direction if it runs within this angle of the route's shape.
MIN_ALIGNMENT = 0.5  # cosine


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


def nearest_end(
    ends: list[tuple[int, np.ndarray]], a: np.ndarray, b: np.ndarray
) -> tuple[int, np.ndarray] | None:
    """The track end nearest the straight line from `a` to `b`, if within `TRACK_END_REACH`."""
    line = shapely.LineString([a, b])
    best = min(ends, key=lambda e: line.distance(shapely.Point(e[1])), default=None)
    if best is None or line.distance(shapely.Point(best[1])) > TRACK_END_REACH:
        return None
    return best


def train_trips(
    path: Path,
    date: str,
    scene,
    net: dict[str, np.ndarray],
    lanes: tuple,
    tree: shapely.STRtree,
    route_base: int,
) -> tuple[list, list[dict], dict]:
    """HŽ's trains running on `date` that call at a station inside the map, each from where
    it enters the map (or its first station) to where it leaves (or its last). Stations go on
    a track running the way the train does, judged from the stations before and after; a
    train coming from beyond the map starts on the track crossing the map's edge nearest the
    line to its last station outside, at the time it would pass there (by distance between
    the stations), and one going beyond it ends on the track leaving the map."""
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
    placed: dict[tuple[str, int], tuple[int, float] | None] = {}

    def place(stop_id: str, direction: np.ndarray):
        n = np.hypot(*direction)
        if n == 0:
            return None
        direction = direction / n
        sector = int((np.arctan2(direction[1], direction[0]) + np.pi) / (2 * np.pi) * 8) % 8
        key = (stop_id, sector)
        if key not in placed:
            point = shapely.Point(xy[stop_id])
            hit = place_stop(point, direction, tree, lanes[3], STOP_RADIUS[TRAIN])
            placed[key] = (int(lanes[1][hit[0]]), float(hit[1])) if hit else None
        return placed[key]

    route_ids = sorted({t["route_id"] for t in trips})
    route_index = {r: route_base + i for i, r in enumerate(route_ids)}
    out = []
    entering = leaving = 0
    for trip in trips:
        seq = sorted(times.get(trip["trip_id"], []))
        pts = [xy[s[1]] for s in seq]
        hits = [
            place(seq[i][1], pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)])
            for i in range(len(seq))
        ]
        inside = [i for i, h in enumerate(hits) if h is not None]
        if not inside:
            continue
        first, last = inside[0], inside[-1]
        stops_out: list[tuple[int, float, float]] = []
        if first > 0 and (end := nearest_end(sources, pts[first - 1], pts[first])):
            d0 = np.hypot(*(end[1] - pts[first - 1]))
            d1 = np.hypot(*(pts[first] - end[1]))
            t0, t1 = seq[first - 1][3], seq[first][2]
            stops_out.append((end[0], 0.0, t0 + (t1 - t0) * d0 / max(d0 + d1, 1.0)))
            entering += 1
        for i in inside:
            edge, frac = hits[i]
            if stops_out and stops_out[-1][0] == edge and abs(stops_out[-1][1] - frac) < 0.02:
                continue
            stops_out.append((edge, frac, seq[i][3]))
        if last < len(seq) - 1 and (end := nearest_end(sinks, pts[last], pts[last + 1])):
            stops_out.append((end[0], 1.0, seq[last + 1][2]))
            leaving += 1
        if len(stops_out) >= 2:
            out.append((stops_out[0][2], TRAIN, route_index[trip["route_id"]], stops_out))
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
        "stationsPlaced": sum(1 for v in placed.values() if v is not None),
        "stationsUnplaced": sum(1 for v in placed.values() if v is None),
        "trackEnds": [len(sources), len(sinks)],
    }
    return out, table, stats


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
    directions: dict[tuple[str, str], np.ndarray | None] = {}
    placed: dict[tuple[str, int, int], tuple[int, float] | None] = {}

    def place(stop_id: str, mode: int, shape_id: str):
        shape = shapes.get(shape_id)
        if stop_id not in stop_xy or shape is None:
            return None
        point = shapely.Point(stop_xy[stop_id])
        if (stop_id, shape_id) not in directions:
            direction = tangent(shape, shape.project(point))
            directions[(stop_id, shape_id)] = direction if np.hypot(*direction) > 0 else None
        direction = directions[(stop_id, shape_id)]
        if direction is None:
            return None
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
    route_index = {r: i for i, r in enumerate(route_ids)}
    out_trips = []
    dropped_stops = 0
    for trip in trips:
        seq = sorted(times.get(trip["trip_id"], []))
        mode = MODE_OF_ROUTE_TYPE[routes[trip["route_id"]]["route_type"]]
        stops_out = []
        for _, stop_id, depart in seq:
            hit = place(stop_id, mode, trip["shape_id"])
            if hit is None:
                dropped_stops += 1
                continue
            # Consecutive stops on the same spot (timing points) count once.
            if stops_out and stops_out[-1][0] == hit[0] and abs(stops_out[-1][1] - hit[1]) < 0.02:
                stops_out[-1] = (hit[0], hit[1], depart)
                continue
            stops_out.append((hit[0], hit[1], depart))
        if len(stops_out) >= 2:
            out_trips.append((stops_out[0][2], mode, route_index[trip["route_id"]], stops_out))
    trains, train_routes, train_stats = train_trips(
        fetch_hz_gtfs(), date, scene, net, lanes[TRAIN], trees[TRAIN], len(route_ids)
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
        "stopsPlaced": sum(1 for v in placed.values() if v is not None),
        "stopsUnplaced": sum(1 for v in placed.values() if v is None),
        "stopVisitsDropped": dropped_stops,
    }
    (out_dir / "transit.json").write_text(
        json.dumps({**packed, "routes": route_table, **stats}, ensure_ascii=False)
    )
    log.info("transit: %s (%.0fs)", stats, time.monotonic() - started)
    return {
        "index": "transit/transit.json",
        **stats,
        "attribution": [ATTRIBUTION, HZ_ATTRIBUTION],
    }
