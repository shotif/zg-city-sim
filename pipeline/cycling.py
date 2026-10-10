"""Cyclists (M8d): the roads where bikes ride apart from cars, and where bike trips start and
end.

Bikes ride the drivable roads that allow them (not motorways or trunk roads). Where a cycle
track, path or lane runs along a road (the City's cycle lanes from data.zagreb.hr, and
OpenStreetMap's cycleways), bikes ride on it, apart from cars; elsewhere they ride in the
road's right-hand lane. Cycle paths away from roads (along the Sava's embankments, through
parks) are not in the network, so bikes do not use them.

Bike trips start and end in the City, by its homes and jobs: about 42,000 a day (3 % of trips
in the Transport Master Plan survey, an estimate for today).
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

import numpy as np
import osmium
import shapely
from pyproj import Transformer

from .buildings import city_boundary, ckan_resource, fetch_cached
from .config import CACHE_DIR, CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR
from .osm import ATTRIBUTION as OSM_ATTRIBUTION
from .osm import fetch_osm
from .packed import read_packed, write_packed
from .transit import network_lanes

log = logging.getLogger(__name__)

CYCLE_PACKAGE = "geoportal-biciklisticke-staze"
ATTRIBUTION = {
    "name": "Grad Zagreb, biciklističke staze",
    "text": "Cycle lanes and paths from the City of Zagreb's geoportal (data.zagreb.hr). "
    "Otvorena dozvola.",
    "url": "https://data.zagreb.hr/dataset/geoportal-biciklisticke-staze",
}
BICYCLE = 32  # lane permission bit (pipeline/simnet.py)
# A cycle line within this far (m) of a lane, running along it (either way), is beside it; an
# edge with one beside this share of its length has a cycle track or lane.
ALONG = 12.0
PARALLEL = 0.8  # cosine
SHARE = 0.5
# Samples along each lane (m) for the share.
STEP = 10.0
# Bike trips a weekday in the City (an estimate: 3 % of trips).
BIKE_TRIPS_DAILY = 42_000
# OpenStreetMap ways that are cycle tracks or lanes: cycleways, paths and footways bikes are
# meant to use, and roads tagged with a lane or track for bikes.
CYCLE_ROAD_TAGS = ("cycleway", "cycleway:right", "cycleway:left", "cycleway:both")
CYCLE_ROAD_VALUES = {"lane", "track", "opposite_lane", "opposite_track", "separate"}


def osm_cycle_lines(pbf: Path, scene) -> list[shapely.LineString]:
    """Cycleways and roads with a cycle lane or track, from OpenStreetMap, in scene metres."""
    lines = []
    for way in osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY).with_locations():
        if not way.is_way():
            continue
        tags = way.tags
        highway = tags.get("highway", "")
        cycle = highway == "cycleway" or (
            highway in ("path", "footway") and tags.get("bicycle") == "designated"
        )
        cycle = cycle or any(tags.get(k) in CYCLE_ROAD_VALUES for k in CYCLE_ROAD_TAGS)
        if not cycle:
            continue
        try:
            pts = [(n.lon, n.lat) for n in way.nodes]
        except osmium.InvalidLocationError:
            continue
        if len(pts) >= 2:
            ll = np.asarray(pts)
            lines.append(shapely.LineString(scene(ll[:, 0], ll[:, 1])))
    return lines


def city_cycle_lines(scene) -> list[shapely.LineString]:
    """The City's cycle lanes and paths, in scene metres."""
    url, modified = ckan_resource(CYCLE_PACKAGE, "GeoJSON")
    stamp = re.sub(r"\D", "", modified)[:8] or "latest"
    path = fetch_cached(url, CACHE_DIR / "cycling" / f"biciklisticke_staze_{stamp}.geojson")
    features = json.loads(path.read_text())["features"]
    lines = []
    for f in features:
        geom = f.get("geometry") or {}
        parts = geom.get("coordinates", [])
        if geom.get("type") == "LineString":
            parts = [parts]
        for part in parts:
            if len(part) >= 2:
                ll = np.asarray(part)[:, :2]
                lines.append(shapely.LineString(scene(ll[:, 0], ll[:, 1])))
    return lines


def segments(lines: list[shapely.LineString]) -> tuple[np.ndarray, np.ndarray]:
    """Every straight piece of `lines` as a two-point line, and its unit direction."""
    coords = [np.asarray(line.coords) for line in lines]
    a = np.concatenate([c[:-1] for c in coords]) if coords else np.zeros((0, 2))
    b = np.concatenate([c[1:] for c in coords]) if coords else np.zeros((0, 2))
    d = b - a
    n = np.hypot(d[:, 0], d[:, 1])
    keep = n > 0.01
    pieces = shapely.linestrings(np.stack([a[keep], b[keep]], axis=1))
    return pieces, d[keep] / n[keep, None]


def cycle_share(lanes: tuple, pieces: np.ndarray, dirs: np.ndarray) -> np.ndarray:
    """For each lane in `lanes`, the share of its length with a cycle line beside it."""
    _, _, _, lines = lanes
    tree = shapely.STRtree(pieces)
    counts = np.array([max(int(line.length // STEP), 1) for line in lines])
    owner = np.repeat(np.arange(len(lines)), counts)
    frac = np.concatenate([(np.arange(n) + 0.5) / n for n in counts])
    pts = shapely.line_interpolate_point(lines[owner], frac, normalized=True)
    ahead = shapely.line_interpolate_point(
        lines[owner], np.minimum(frac + 0.01, 1.0), normalized=True
    )
    behind = shapely.line_interpolate_point(
        lines[owner], np.maximum(frac - 0.01, 0.0), normalized=True
    )
    tangent = shapely.get_coordinates(ahead) - shapely.get_coordinates(behind)
    tangent /= np.maximum(np.hypot(tangent[:, 0], tangent[:, 1]), 1e-9)[:, None]
    hit_pt, hit_piece = tree.query(pts, predicate="dwithin", distance=ALONG)
    along = np.abs((tangent[hit_pt] * dirs[hit_piece]).sum(axis=1)) >= PARALLEL
    covered = np.zeros(len(pts), bool)
    covered[hit_pt[along]] = True
    return np.bincount(owner, covered, len(lines)) / counts


def build_cycling(root: Path = OUTPUT_DIR) -> dict:
    """The roads with a cycle track or lane, and the City's bike trip ends, written to
    `root`."""
    started = time.monotonic()
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)

    def scene(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        e, n = to_crs.transform(lon, lat)
        return np.column_stack([np.asarray(e) - ORIGIN_E, ORIGIN_N - np.asarray(n)])

    index = json.loads((root / "network" / "net.json").read_text())
    net = read_packed(root / "network" / index["file"], index)
    lanes = network_lanes(net, index, BICYCLE)
    city = city_cycle_lines(scene)
    osm = osm_cycle_lines(fetch_osm(), scene)
    pieces, dirs = segments(city + osm)
    share = cycle_share(lanes, pieces, dirs)

    # An edge has a cycle track or lane where its rightmost lane bikes may use has one.
    n_edges = len(net["edgeFrom"])
    edge_share = np.zeros(n_edges)
    rightmost = np.full(n_edges, -1)
    for i, (lane, edge) in enumerate(zip(lanes[0].tolist(), lanes[1].tolist(), strict=True)):
        if rightmost[edge] < 0 or lane < lanes[0][rightmost[edge]]:
            rightmost[edge] = i
    has = rightmost >= 0
    edge_share[has] = share[rightmost[has]]
    cycleway = (edge_share >= SHARE).astype(np.uint8)

    # Bike trips start and end in the City, by its homes and jobs.
    d_index = json.loads((root / "demand" / "demand.json").read_text())
    demand = read_packed(root / "demand" / d_index["file"], d_index)
    boundary = shapely.affinity.translate(
        shapely.affinity.scale(city_boundary(), 1, -1, origin=(0, 0)), -ORIGIN_E, ORIGIN_N
    )
    edges = demand["demandEdge"].astype(np.int64)
    mids = np.zeros((len(edges), 2))
    for k, e in enumerate(edges.tolist()):
        i = rightmost[e]
        if i >= 0:
            c = lanes[3][i].interpolate(0.5, normalized=True)
            mids[k] = (c.x, c.y)
    in_city = (rightmost[edges] >= 0) & shapely.contains_xy(boundary, mids[:, 0], mids[:, 1])

    arrays = {
        "edgeCycleway": cycleway,
        "bikeEdge": edges[in_city].astype(np.uint32),
        "bikeHome": demand["demandHome"][in_city].astype(np.float32),
        "bikeWork": demand["demandWork"][in_city].astype(np.float32),
    }
    out_dir = root / "cycling"
    packed = write_packed(out_dir / "cycling.bin.gz", arrays)
    lengths = np.zeros(n_edges)
    lengths[has] = lanes[2][rightmost[has]]
    stats = {
        "bikeTripsDaily": BIKE_TRIPS_DAILY,
        "cycleLines": len(city) + len(osm),
        "cityLines": len(city),
        "osmLines": len(osm),
        "edgesWithCycleway": int(cycleway.sum()),
        "cyclewayKm": round(float(lengths[cycleway == 1].sum()) / 1000, 1),
        "bikeRoadKm": round(float(lengths[has].sum()) / 1000, 1),
        "bikeTripEnds": int(in_city.sum()),
    }
    (out_dir / "cycling.json").write_text(json.dumps({**packed, **stats}))
    log.info("cycling: %s (%.0fs)", stats, time.monotonic() - started)
    return {
        "index": "cycling/cycling.json",
        **stats,
        "attribution": [ATTRIBUTION, OSM_ATTRIBUTION],
    }
