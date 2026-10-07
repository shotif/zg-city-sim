"""Lots for zoning (M5a): free land along streets that buildings can grow on, and the City
of Zagreb's planned land use, for the app's Zones tool.

A lot is a rectangle beside a street, `FRONTAGE` m along it and `DEPTH` m deep, a family
house's plot in Zagreb's outskirts. Lots are laid along each side of every street that
local traffic uses (not motorways, trunk roads or slip roads), clear of the street's
ends, and kept where the land is free: no building, road, railway or tram track, and no
water on it, and not land the City's plan keeps open (forests, parks, protective green,
sport grounds, cemeteries, water, infrastructure, civic and military land). Where lots
from neighbouring streets overlap, the quieter street's lot stays.

Each lot records the street it faces (the edge its trips will use), its planned use, its
land cover (ESA WorldCover) and how tall the buildings around it are (median storeys
within `CONTEXT_RADIUS`), which picks the density of housing the plan's residential land
gets.

The planned land use is the City's own mosaic of the general, urban and detailed plans in
force in 2023 (`geoportal-planirana-namjena-2023`, 8,999 polygons, Otvorena dozvola),
grouped into `PLAN_CLASSES`. Outside the City there is no plan.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import numpy as np
import pyogrio
import shapely
from pyproj import Transformer
from scipy.spatial import cKDTree

from .buildings import ckan_resource, fetch_cached
from .config import CACHE_DIR, CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR, WORLD
from .demand import ring_points
from .landcover import landcover_grid
from .packed import read_packed, write_packed

log = logging.getLogger(__name__)

PLAN_PACKAGE = "geoportal-planirana-namjena-2023"
ATTRIBUTION = {
    "name": "City of Zagreb, planned land use 2023",
    "text": "Planned land use (Geoportal planirana namjena 2023, last modified 2024-09-13): "
    "City of Zagreb, the general, urban and detailed plans in force; uses grouped into classes "
    "and outlines simplified here. Otvorena dozvola (Open Licence of the Republic of Croatia).",
    "url": "https://data.zagreb.hr/dataset/geoportal-planirana-namjena-2023",
}

# Lot size (m): along the street, and back from it.
FRONTAGE = 20.0
DEPTH = 30.0
# Pavement between a street's outer lane edge and its lots (m).
SIDEWALK = 3.0
# Lots keep this far (m) from a street's ends, clear of its junctions.
END_CLEAR = 15.0
# Clearance (m) around buildings, and beyond a lane's half width, that lots keep free.
BUILDING_CLEAR = 2.0
LANE_CLEAR = 1.5
# Lots overlapping another by more than this share of their area are the same land.
OVERLAP = 0.05
# Radius (m) of the neighbourhood whose buildings set a lot's context storeys.
CONTEXT_RADIUS = 150.0
STOREY = 3.0
# WorldCover classes no lot is laid on: permanent water, herbaceous wetland.
NO_LOT_COVER = (80, 90)
# Map resolution (m) of the land cover lots are checked against.
COVER_RESOLUTION = 10.0
# Simplification (m) of the plan's outlines for the app's map.
PLAN_SIMPLIFY = 2.0

# Groups of the plan's uses: (id, label, colour, lots allowed).
PLAN_CLASSES = [
    ("residential", "Housing", "#e8c45a", True),
    ("mixed", "Mixed: housing and business", "#e89a4a", True),
    ("commercial", "Shops and services", "#4a90d9", True),
    ("office", "Offices and business", "#7a6fd0", True),
    ("industrial", "Industry and production", "#b07cc6", True),
    ("civic", "Public and social", "#d9534f", False),
    ("green", "Forests, parks, sport and cemeteries", "#5c9e4a", False),
    ("agricultural", "Farmland", "#c7d18a", True),
    ("water", "Water", "#3d7ab8", False),
    ("transport", "Roads, railways and infrastructure", "#9a9a9a", False),
    ("special", "Military", "#6b6b5a", False),
]
PLAN_IDS = {c[0]: k for k, c in enumerate(PLAN_CLASSES)}
NO_PLAN = 255

# Roads without lots: motorways, trunk roads and slip roads. (Not by speed: many town
# streets carry netconvert's rural default of 100 km/h where OSM has no limit.)
ROAD_TYPES_WITHOUT_LOTS = ("highway.motorway", "highway.trunk")


def plan_class(use: str, group: str) -> int:
    """The class of one of the plan's polygons, from its use (`Namjena`) and group of uses
    (`Skupna_namjena`)."""
    u = use.lower()
    g = group.lower()
    if g.startswith(("šume", "javne zelene", "zaštitne zelene", "sport", "groblje")):
        return PLAN_IDS["green"]
    if g.startswith(("vode", "vodocrpilišta")):
        return PLAN_IDS["water"]
    if g.startswith(("prometne", "infrastruktura", "javne gradske")):
        return PLAN_IDS["transport"]
    if g.startswith("posebna"):
        return PLAN_IDS["special"]
    if g.startswith("javna i društvena"):
        return PLAN_IDS["civic"]
    if g.startswith("poljoprivredne"):
        return PLAN_IDS["agricultural"]
    if "trgovač" in u:
        return PLAN_IDS["commercial"]
    if "mješovita" in u or "mješovita" in g:
        if "poslovn" in u:
            return PLAN_IDS["commercial"]
        return PLAN_IDS["mixed"]
    if "proizvodn" in u or "industrij" in u or g.startswith("proizvodna"):
        return PLAN_IDS["industrial"]
    if "poslovn" in u or "poslovna" in g:
        return PLAN_IDS["office"]
    if g.startswith("gospodarska"):
        return PLAN_IDS["industrial"]
    if "stamben" in u or "stanovanj" in u or "stambena" in g:
        return PLAN_IDS["residential"]
    log.warning("plan use %r (%s) not grouped; taken as residential", use, group)
    return PLAN_IDS["residential"]


def to_scene(geometries: np.ndarray, from_crs: str = "EPSG:4326") -> np.ndarray:
    """Geometries in `from_crs` to scene metres (x east, z south of the origin)."""
    to_crs = Transformer.from_crs(from_crs, CRS, always_xy=True)

    def project(coords: np.ndarray) -> np.ndarray:
        e, n = to_crs.transform(coords[:, 0], coords[:, 1])
        return np.column_stack([np.asarray(e) - ORIGIN_E, ORIGIN_N - np.asarray(n)])

    return shapely.transform(geometries, project)


def fetch_plan() -> Path:
    url, modified = ckan_resource(PLAN_PACKAGE, "GeoJSON")
    stamp = re.sub(r"\D", "", modified)[:8] or "latest"
    return fetch_cached(url, CACHE_DIR / "plan" / f"planirana_namjena_{stamp}.geojson")


def read_plan(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """The plan's polygons (scene metres, valid) and their classes."""
    _, _, wkb, fields = pyogrio.raw.read(
        path, read_geometry=True, columns=["Namjena", "Skupna_namjena"]
    )
    geoms = to_scene(shapely.force_2d(shapely.from_wkb(wkb)))
    geoms = shapely.make_valid(geoms)
    classes = np.array(
        [plan_class(str(u or ""), str(g or "")) for u, g in zip(*fields, strict=True)], np.uint8
    )
    keep = ~shapely.is_empty(geoms)
    return geoms[keep], classes[keep]


# ---- streets and lots ------------------------------------------------------------------------


def lane_lines(net: dict[str, np.ndarray]) -> list[np.ndarray]:
    """Every lane's shape as an (n, 2) array of scene metres."""
    offsets = net["laneShapeOffsets"].astype(np.int64)
    origin = net["laneShapeOrigin"].reshape(-1, 2).astype(np.int64)
    delta = net["laneShapeDelta"].reshape(-1, 2).astype(np.int64)
    return [
        (origin[k] + np.cumsum(delta[offsets[k] : offsets[k + 1]], axis=0)) / 100.0
        for k in range(len(offsets) - 1)
    ]


def lot_streets(net: dict[str, np.ndarray], index: dict) -> np.ndarray:
    """Edges that get lots: streets local traffic uses."""
    types = index["types"]
    excluded = np.array(
        [t.startswith(ROAD_TYPES_WITHOUT_LOTS) or "_link" in t.split("|")[0] for t in types]
    )
    internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
    lane0 = net["edgeLaneStart"].astype(np.int64)
    passenger = index.get("vclassBits", {}).get("passenger", 1)
    ok = (
        ~internal
        & ~excluded[net["edgeType"]]
        & (net["edgeLaneCount"] > 0)
        & ((net["laneAllow"][lane0] & passenger) != 0)
        & (net["laneLength"][lane0] >= 2 * END_CLEAR + FRONTAGE)
    )
    return np.flatnonzero(ok)


def along(points: np.ndarray, distances: np.ndarray) -> np.ndarray:
    """Points at `distances` metres along a polyline."""
    steps = np.hypot(*np.diff(points, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(steps)])
    return np.column_stack(
        [np.interp(distances, cum, points[:, 0]), np.interp(distances, cum, points[:, 1])]
    )


def candidate_lots(
    net: dict[str, np.ndarray], index: dict, edges: np.ndarray, lines: list[np.ndarray]
) -> dict[str, np.ndarray]:
    """Lots along both sides of the streets `edges` (lines: every lane's shape): the right of
    every edge, and the left of one-way streets. Each lot: its front corners (start, end
    along the street), its outward normal, its edge and its street's speed."""
    has_opposite = index["flags"]["hasOpposite"]
    starts, ends, normals, owner, speed = [], [], [], [], []
    for e in edges:
        lane0 = int(net["edgeLaneStart"][e])
        count = int(net["edgeLaneCount"][e])
        pts = lines[lane0]
        length = float(np.hypot(*np.diff(pts, axis=0).T).sum())
        n = int((length - 2 * END_CLEAR) // FRONTAGE)
        if n < 1 or len(pts) < 2:
            continue
        first = (length - n * FRONTAGE) / 2
        cuts = along(pts, first + FRONTAGE * np.arange(n + 1))
        a, b = cuts[:-1], cuts[1:]
        u = b - a
        u /= np.maximum(np.hypot(u[:, 0], u[:, 1]), 1e-9)[:, None]
        # Right of travel with x east and z south: (-u_z, u_x).
        right = np.column_stack([-u[:, 1], u[:, 0]])
        width = float(net["laneWidth"][lane0])
        sides = [(right, width / 2 + SIDEWALK)]
        if not net["edgeFlags"][e] & has_opposite:
            # A one-way street: its left side too, beyond its other lanes.
            sides.append((-right, width * (count - 0.5) + SIDEWALK))
        for normal, offset in sides:
            flip = normal is not right
            # Front corners in the street's direction on its right, against it on its left,
            # so every lot runs start -> end with its depth on the right.
            fa, fb = a + normal * offset, b + normal * offset
            starts.append(fb if flip else fa)
            ends.append(fa if flip else fb)
            normals.append(normal)
            owner.append(np.full(n, e))
            speed.append(np.full(n, net["laneSpeed"][lane0]))
    if not owner:
        empty = np.zeros((0, 2))
        return {"start": empty, "end": empty, "normal": empty, "edge": np.zeros(0, np.int64),
                "speed": np.zeros(0)}  # fmt: skip
    return {
        "start": np.concatenate(starts),
        "end": np.concatenate(ends),
        "normal": np.concatenate(normals),
        "edge": np.concatenate(owner).astype(np.int64),
        "speed": np.concatenate(speed),
    }


def lot_polygons(lots: dict[str, np.ndarray]) -> np.ndarray:
    a, b, n = lots["start"], lots["end"], lots["normal"]
    corners = np.stack([a, b, b + n * DEPTH, a + n * DEPTH, a], axis=1)
    return shapely.polygons(corners)


def resolve_overlaps(polys: np.ndarray, priority: np.ndarray) -> np.ndarray:
    """Which lots stay where lots overlap: the one of higher priority (lower value)."""
    tree = shapely.STRtree(polys)
    i, j = tree.query(polys, predicate="overlaps")
    pick = i < j
    i, j = i[pick], j[pick]
    if len(i):
        shared = shapely.area(shapely.intersection(polys[i], polys[j]))
        big = shared > OVERLAP * np.minimum(shapely.area(polys[i]), shapely.area(polys[j]))
        i, j = i[big], j[big]
    order = np.lexsort((np.arange(len(polys)), priority))
    rank = np.empty(len(polys), np.int64)
    rank[order] = np.arange(len(polys))
    # Each conflict as (better, worse); a lot goes if a better lot that stays overlaps it.
    better = np.where(rank[i] < rank[j], i, j)
    worse = np.where(rank[i] < rank[j], j, i)
    by_worse: dict[int, list[int]] = {}
    for w, bt in zip(worse.tolist(), better.tolist(), strict=True):
        by_worse.setdefault(w, []).append(bt)
    keep = np.ones(len(polys), bool)
    for k in order.tolist():
        if any(keep[bt] for bt in by_worse.get(k, ())):
            keep[k] = False
    return keep


def make_lots(
    net: dict[str, np.ndarray],
    index: dict,
    footprints: np.ndarray,
    plan: tuple[np.ndarray, np.ndarray],
    cover: tuple[np.ndarray, float, float, float],
    building_points: tuple[np.ndarray, np.ndarray],
) -> dict[str, np.ndarray]:
    """Lots on free land along streets.

    `footprints`: building outlines (scene metres); `plan`: the plan's polygons and classes;
    `cover`: WorldCover classes (row 0 north), its resolution and the scene x, z of its
    north-west corner; `building_points`: building centres (n, 2) and their storeys.
    """
    edges = lot_streets(net, index)
    lines = lane_lines(net)
    lots = candidate_lots(net, index, edges, lines)
    polys = lot_polygons(lots)
    n0 = len(polys)
    free = np.ones(n0, bool)

    # Buildings, and every lane (roads, junctions, railways, tram tracks).
    if len(footprints):
        tree = shapely.STRtree(shapely.buffer(footprints, BUILDING_CLEAR))
        hit, _ = tree.query(polys, predicate="intersects")
        free[hit] = False
    widths = net["laneWidth"].astype(float)
    corridors = shapely.buffer(_lines(lines), widths / 2 + LANE_CLEAR)
    hit, _ = shapely.STRtree(corridors).query(polys, predicate="intersects")
    free[hit] = False
    stats = {"candidates": n0, "onBuildingsOrRoads": int((~free).sum())}

    # Land the plan keeps open; each lot's planned use at its centre.
    centres = shapely.centroid(polys)
    plan_geoms, plan_classes = plan
    lot_plan = np.full(n0, NO_PLAN, np.uint8)
    if len(plan_geoms):
        k, g = shapely.STRtree(plan_geoms).query(centres, predicate="within")
        lot_plan[k] = plan_classes[g]
    allowed = np.array([c[3] for c in PLAN_CLASSES] + [True] * (256 - len(PLAN_CLASSES)))
    kept_open = free & ~allowed[lot_plan]
    stats["keptOpenByPlan"] = int(kept_open.sum())
    free &= allowed[lot_plan]

    # Water and wetland under any corner or the centre.
    grid, res, west, north = cover
    corners = np.stack(
        [lots["start"], lots["end"], lots["end"] + lots["normal"] * DEPTH,
         lots["start"] + lots["normal"] * DEPTH], axis=1
    )  # fmt: skip
    centre_xy = corners.mean(axis=1)
    samples = np.concatenate([corners, centre_xy[:, None, :]], axis=1)
    col = np.clip(((samples[..., 0] - west) / res).astype(np.int64), 0, grid.shape[1] - 1)
    row = np.clip(((samples[..., 1] - north) / res).astype(np.int64), 0, grid.shape[0] - 1)
    classes = grid[row, col]
    wet = np.isin(classes, NO_LOT_COVER).any(axis=1)
    stats["onWater"] = int((free & wet).sum())
    free &= ~wet
    lot_cover = classes[:, -1]

    # Overlaps: quieter streets first, then the order they were laid.
    keep = np.zeros(n0, bool)
    idx = np.flatnonzero(free)
    keep[idx[resolve_overlaps(polys[idx], lots["speed"][idx])]] = True
    stats["overlapping"] = int(free.sum() - keep.sum())

    # Context: median storeys of the buildings around.
    points, storeys = building_points
    context = np.zeros(n0, np.uint8)
    if len(points):
        tree = cKDTree(points)
        near = tree.query_ball_point(centre_xy[keep], CONTEXT_RADIUS)
        context[keep] = [min(255, round(float(np.median(storeys[n])))) if n else 0 for n in near]

    u = lots["end"] - lots["start"]
    sel = keep
    out = {
        "lotX": centre_xy[sel, 0].astype(np.float32),
        "lotZ": centre_xy[sel, 1].astype(np.float32),
        # Direction along the street (radians, atan2(dz, dx)); the lot lies to its right.
        "lotAngle": np.arctan2(u[sel, 1], u[sel, 0]).astype(np.float32),
        "lotFrontage": np.round(np.hypot(u[sel, 0], u[sel, 1])).astype(np.uint8),
        "lotDepth": np.full(int(sel.sum()), DEPTH, np.uint8),
        "lotEdge": lots["edge"][sel].astype(np.uint32),
        "lotPlan": lot_plan[sel],
        "lotCover": lot_cover[sel].astype(np.uint8),
        "lotContext": context[sel],
    }
    stats["lots"] = int(sel.sum())
    out["_stats"] = stats  # type: ignore[assignment]
    return out


def _lines(lines: list[np.ndarray]) -> np.ndarray:
    """Lane shapes as line strings (a lane of one point as a tiny line)."""
    fixed = [pts if len(pts) >= 2 else np.vstack([pts, pts + 0.01]) for pts in lines]
    return np.asarray([shapely.LineString(pts) for pts in fixed], dtype=object)


# ---- the plan for the app's map ------------------------------------------------------------


def plan_arrays(geoms: np.ndarray, classes: np.ndarray) -> dict[str, np.ndarray]:
    """The plan's polygons, simplified, as rings for the app: per polygon its first ring
    (outer, then holes), per ring its first point, points as x, z (m)."""
    simple = shapely.simplify(geoms, PLAN_SIMPLIFY)
    polys = shapely.get_parts(simple)
    owner = np.repeat(classes, shapely.get_num_geometries(simple))
    keep = (shapely.get_type_id(polys) == 3) & (shapely.area(polys) > 1.0)
    polys, owner = polys[keep], owner[keep]
    ring_starts, point_starts, xs = [0], [0], []
    for poly in polys:
        rings = [poly.exterior, *poly.interiors]
        for ring in rings:
            coords = np.asarray(ring.coords)[:-1]
            xs.append(coords)
            point_starts.append(point_starts[-1] + len(coords))
        ring_starts.append(ring_starts[-1] + len(rings))
    pts = np.concatenate(xs) if xs else np.zeros((0, 2))
    return {
        "planPolygonRings": np.asarray(ring_starts, np.uint32),
        "planRingPoints": np.asarray(point_starts, np.uint32),
        "planPoints": pts.reshape(-1).astype(np.float32),
        "planClass": owner.astype(np.uint8),
    }


# ---- the step --------------------------------------------------------------------------------


def building_inputs() -> tuple[np.ndarray, tuple[np.ndarray, np.ndarray]]:
    """Building outlines (scene metres), and their centres and storeys."""
    index = json.loads((OUTPUT_DIR / "buildings" / "buildings.json").read_text())
    b = read_packed(OUTPUT_DIR / "buildings" / index["file"], index)
    rings = b["buildingRings"][:-1].astype(np.int64)
    x, z, lengths = ring_points(b["ringOrigin"], b["ringOffsets"], b["deltas"], rings)
    owner = np.repeat(np.arange(len(rings)), lengths)
    centres = (
        np.column_stack([np.bincount(owner, x, len(rings)), np.bincount(owner, z, len(rings))])
        / np.maximum(lengths, 1)[:, None]
    )
    storeys = np.maximum(1.0, np.round(b["eave"] / STOREY))
    # Outlines of three points or more (others are slivers).
    ok = lengths >= 3
    pts = ok[owner]
    dense = np.cumsum(ok) - 1  # outline number of each kept building
    linear = shapely.linearrings(np.column_stack([x, z])[pts], indices=dense[owner[pts]])
    outlines = shapely.polygons(linear)
    return outlines, (centres[ok], storeys[ok])


def build_zoning() -> dict:
    out_dir = OUTPUT_DIR / "zoning"
    n_index = json.loads((OUTPUT_DIR / "network" / "net.json").read_text())
    net = read_packed(OUTPUT_DIR / "network" / n_index["file"], n_index)
    footprints, centres = building_inputs()
    plan_geoms, plan_classes = read_plan(fetch_plan())
    grid = landcover_grid(COVER_RESOLUTION)
    west = WORLD.min_e - ORIGIN_E
    north = ORIGIN_N - WORLD.max_n
    lots = make_lots(
        net,
        n_index,
        footprints,
        (plan_geoms, plan_classes),
        (grid, COVER_RESOLUTION, west, north),
        centres,
    )
    stats = lots.pop("_stats")  # type: ignore[arg-type]
    arrays = {**lots, **plan_arrays(plan_geoms, plan_classes)}
    index = write_packed(out_dir / "zoning.bin.gz", arrays)
    by_plan = np.bincount(lots["lotPlan"], minlength=256)
    stats["byPlan"] = {c[0]: int(by_plan[k]) for k, c in enumerate(PLAN_CLASSES) if by_plan[k]}
    stats["withoutPlan"] = int(by_plan[NO_PLAN])
    index.update(
        {
            "lot": {"frontage": FRONTAGE, "depth": DEPTH},
            "planClasses": [
                {"id": c[0], "label": c[1], "color": c[2], "lots": c[3]} for c in PLAN_CLASSES
            ],
            "noPlan": NO_PLAN,
            "stats": stats,
        }
    )
    (out_dir / "zoning.json").write_text(json.dumps(index, ensure_ascii=False))
    log.info("zoning: %s", stats)
    return {"index": "zoning/zoning.json", "lots": stats["lots"], "attribution": ATTRIBUTION}
