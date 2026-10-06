"""ZET trams and buses: a weekday's timetable from ZET's GTFS feed, with every stop placed on
a lane of the road network in its direction of travel.

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

from .config import CACHE_DIR, CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR
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

# Engine vehicle types (sim/src/vtype.rs) and their lane permission bits (pipeline/simnet.py).
BUS, TRAM = 2, 3
MODE_OF_ROUTE_TYPE = {"0": TRAM, "3": BUS}
VCLASS = {BUS: 2, TRAM: 4}
# How far from a stop its lane may be (m): platforms sit beside the track or kerb.
STOP_RADIUS = {BUS: 40.0, TRAM: 30.0}
# A lane serves a stop's direction if it runs within this angle of the route's shape.
MIN_ALIGNMENT = 0.5  # cosine


def fetch_gtfs(max_age_days: int = MAX_AGE_DAYS) -> Path:
    """The latest ZET GTFS feed, downloaded at most once every `max_age_days`."""
    folder = CACHE_DIR / "gtfs"
    folder.mkdir(parents=True, exist_ok=True)
    cached = sorted(folder.glob("zet_*.zip"))
    if cached and time.time() - cached[-1].stat().st_mtime < max_age_days * 86400:
        return cached[-1]
    path = folder / f"zet_{dt.date.today():%Y%m%d}.zip"
    log.info("downloading %s", GTFS_URL)
    req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "zg-city-sim pipeline"})
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
    lanes = {mode: network_lanes(net, n_index, VCLASS[mode]) for mode in (BUS, TRAM)}
    trees = {mode: shapely.STRtree(lanes[mode][3]) for mode in (BUS, TRAM)}

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
    ]
    stats = {
        "serviceDate": date,
        "trips": len(out_trips),
        "tramTrips": int((arrays["transitTripType"] == TRAM).sum()),
        "busTrips": int((arrays["transitTripType"] == BUS).sum()),
        "tripsWithoutStops": len(trips) - len(out_trips),
        "stopsPlaced": sum(1 for v in placed.values() if v is not None),
        "stopsUnplaced": sum(1 for v in placed.values() if v is None),
        "stopVisitsDropped": dropped_stops,
    }
    (out_dir / "transit.json").write_text(
        json.dumps({**packed, "routes": route_table, **stats}, ensure_ascii=False)
    )
    log.info("transit: %s (%.0fs)", stats, time.monotonic() - started)
    return {"index": "transit/transit.json", **stats, "attribution": ATTRIBUTION}
