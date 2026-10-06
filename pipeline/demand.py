"""Travel demand: where people live and work, attached to the street network.

Every building gets residents and jobs from its floor area and use. The use comes from its
OpenStreetMap type, else from the OpenStreetMap land use around it, else from its shape.
Each of the City's 17 districts has its census population spread over the residential floor
area inside it, and the City's jobs are spread over work floor area; the towns around it get
their estimated totals the same way. Each building is attached to the
nearest street a car can use, and the engine draws trips between street edges weighted by
these numbers (sim/src/demand.rs).
"""

from __future__ import annotations

import json
import logging
import re
import time

import numpy as np
import osmium
import shapely
from pyproj import Transformer

from .buildings import city_boundary, city_districts
from .config import CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR
from .osm import fetch_osm
from .packed import read_packed, write_packed

log = logging.getLogger(__name__)

ATTRIBUTION = {
    "name": "DZS, Census 2021",
    "text": "Population of the City of Zagreb from the Croatian Bureau of Statistics (Državni "
    "zavod za statistiku), Census of Population, Households and Dwellings 2021; travel "
    "rates from the City of Zagreb Transport Master Plan survey.",
    "url": "https://dzs.gov.hr/",
}

# Census 2021 population of the City's districts (gradske četvrti), named as in the City's
# register of spatial units.
DISTRICT_POPULATION = {
    "Brezovica": 12_046,
    "Črnomerec": 38_084,
    "Donja Dubrava": 33_537,
    "Donji grad": 31_209,
    "Gornja Dubrava": 58_255,
    "Gornji grad - Medveščak": 26_423,
    "Maksimir": 47_356,
    "Novi Zagreb - istok": 55_898,
    "Novi Zagreb - zapad": 63_917,
    "Peščenica - Žitnjak": 53_023,
    "Podsljeme": 18_974,
    "Podsused - Vrapče": 44_910,
    "Sesvete": 70_800,
    "Stenjevec": 53_862,
    "Trešnjevka - jug": 65_324,
    "Trešnjevka - sjever": 52_974,
    "Trnje": 40_539,
}
# Census 2021, City of Zagreb (767,131).
POPULATION = sum(DISTRICT_POPULATION.values())
# Persons working in the City (DZS employment by place of work, about 430k).
JOBS = 430_000
# The towns and municipalities around the City inside the map (Velika Gorica, Samobor,
# Zaprešić, Sveta Nedelja, Dugo Selo and smaller ones; census 2021, rounded).
OUTSIDE_POPULATION = 260_000
OUTSIDE_JOBS = 80_000
# Car trips per resident and day: 1.84 trips per person (Master Plan survey), 46 % by car,
# 1.3 people per car.
CAR_TRIPS_PER_RESIDENT = 1.84 * 0.46 / 1.3
# Height of one storey, used when a building's number of storeys is unknown.
STOREY = 3.0
# Share of floor area that is usable (walls, stairs, plant rooms excluded).
NET_AREA = 0.8
# Share of residential floor area used for shops and offices in the old centre.
CENTRE_RADIUS = 2_000.0
CENTRE_WORK_SHARE = 0.3

# Land-use classes, in order of precedence when areas overlap.
LANDUSE_CLASSES = ["civic", "commercial", "industrial", "residential"]
LANDUSE_TAGS = {
    ("landuse", "residential"): "residential",
    ("landuse", "commercial"): "commercial",
    ("landuse", "retail"): "commercial",
    ("landuse", "industrial"): "industrial",
    ("landuse", "port"): "industrial",
    ("landuse", "education"): "civic",
    ("landuse", "institutional"): "civic",
    ("amenity", "school"): "civic",
    ("amenity", "university"): "civic",
    ("amenity", "college"): "civic",
    ("amenity", "kindergarten"): "civic",
    ("amenity", "hospital"): "civic",
    ("amenity", "clinic"): "civic",
    ("amenity", "marketplace"): "commercial",
    ("shop", "mall"): "commercial",
}

# Road types buildings are never attached to.
NO_ACCESS = ("highway.motorway", "highway.trunk")
# Prefer streets up to this speed limit (m/s), within this distance (m).
LOCAL_SPEED = 16.7
LOCAL_DISTANCE = 300.0
# Buildings further than this from any street get no trips (forest huts and the like).
MAX_DISTANCE = 1_500.0
PASSENGER = 1


def outer_rings(
    ring_origin: np.ndarray, ring_offsets: np.ndarray, deltas: np.ndarray, rings: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Area (m²) and centroid (scene x, z) of each building's outer ring.

    `rings` holds each building's first ring index (its outer ring); rings are delta-encoded
    in centimetres (pipeline/buildings.py encode_rings).
    """
    n = len(rings)
    starts = ring_offsets[rings].astype(np.int64)
    ends = ring_offsets[rings + 1].astype(np.int64)
    lengths = ends - starts
    owner = np.repeat(np.arange(n), lengths)
    point = (
        np.concatenate([np.arange(a, b) for a, b in zip(starts, ends, strict=True)]) if n else []
    )
    point = np.asarray(point, np.int64)
    steps = deltas.reshape(-1, 2)[point].astype(np.int64)
    # Running sum within each ring: a global cumulative sum minus the sum before the ring.
    csum = np.cumsum(steps, axis=0)
    first = np.concatenate([[0], np.cumsum(lengths)[:-1]])
    before = np.where(first[:, None] > 0, csum[np.maximum(first - 1, 0)], 0)
    xy = (
        csum
        - np.repeat(before, lengths, axis=0)
        + np.repeat(ring_origin.reshape(-1, 2)[rings], lengths, axis=0)
    )
    x = xy[:, 0] / 100.0
    z = xy[:, 1] / 100.0
    # Next point within the ring, wrapping to its first point.
    nxt = np.arange(len(x)) + 1
    last = first + lengths - 1
    nxt[last] = first
    cross = x * z[nxt] - x[nxt] * z
    signed = np.bincount(owner, cross, n) / 2.0
    cx = np.bincount(owner, (x + x[nxt]) * cross, n)
    cz = np.bincount(owner, (z + z[nxt]) * cross, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        cx = cx / (6.0 * signed)
        cz = cz / (6.0 * signed)
    # Degenerate rings: fall back to the mean of their points.
    flat = ~np.isfinite(cx) | (np.abs(signed) < 1e-6)
    if flat.any():
        counts = np.maximum(lengths, 1)
        cx[flat] = (np.bincount(owner, x, n) / counts)[flat]
        cz[flat] = (np.bincount(owner, z, n) / counts)[flat]
    return np.abs(signed), cx, cz


def storeys(levels: np.ndarray, eave: np.ndarray) -> np.ndarray:
    """Number of storeys: mapped levels, else wall height over a typical storey."""
    estimated = np.maximum(1, np.round(eave / STOREY))
    return np.where(levels > 0, levels, estimated).astype(np.float64)


def use_shares(
    kinds: list[str],
    kind: np.ndarray,
    landuse: np.ndarray,
    area: np.ndarray,
    eave: np.ndarray,
    centre: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Shares of each building's floor area used for living and for work.

    `landuse` is the index in LANDUSE_CLASSES of the area each building stands in (-1 if
    none); `centre` marks buildings in the old centre, where homes share floors with shops.
    """
    name = np.asarray(kinds, dtype=object)[kind]
    home = np.zeros(len(kind))
    work = np.zeros(len(kind))
    living = np.isin(name, ["house", "residential"])
    working = np.isin(name, ["commercial", "industrial", "civic"])
    home[living] = 1.0
    work[working] = 1.0
    unknown = name == "other"
    land = np.asarray(LANDUSE_CLASSES + ["none"], dtype=object)[np.where(landuse >= 0, landuse, -1)]
    in_work_area = unknown & np.isin(land, ["civic", "commercial", "industrial"])
    work[in_work_area] = 1.0
    in_homes = unknown & (land == "residential")
    home[in_homes] = 1.0
    # Unknown buildings outside mapped land use: big and low are sheds, halls and stores;
    # the rest are mostly homes with some work.
    rest = unknown & ~in_work_area & ~in_homes
    hall = rest & (area >= 2_000) & (eave <= 15)
    work[hall] = 1.0
    other = rest & ~hall
    home[other] = 0.8
    work[other] = 0.2
    # Shops and offices on the lower floors in the old centre and in commercial areas.
    mixed = (home > 0) & (centre | (living & np.isin(land, ["commercial"])))
    work[mixed] = np.maximum(work[mixed], CENTRE_WORK_SHARE)
    home[mixed] = np.minimum(home[mixed], 1.0 - CENTRE_WORK_SHARE)
    return home, work


def spread(floor_area: np.ndarray, zone: np.ndarray, totals: list[float]) -> np.ndarray:
    """Distribute each zone's total over the floor area in it (`zone`: index into `totals`
    per building)."""
    area = np.bincount(zone, floor_area, len(totals))
    scale = np.divide(totals, area, out=np.zeros(len(totals)), where=area > 0)
    return floor_area * scale[zone]


def normalize_name(name: str) -> str:
    """Name without case, punctuation or spacing differences ("Novi Zagreb – Istok")."""
    return " ".join(re.findall(r"\w+", name.lower()))


def district_population(names: list[str]) -> list[int]:
    """Census population of each district, matched by name; every district must match."""
    census = {normalize_name(k): v for k, v in DISTRICT_POPULATION.items()}
    found = [census.get(normalize_name(n)) for n in names]
    missing = [n for n, p in zip(names, found, strict=True) if p is None]
    if missing or len(set(map(normalize_name, names))) != len(census):
        raise ValueError(f"districts do not match the census: {missing or names}")
    return [int(p) for p in found]


def district_of(x: np.ndarray, z: np.ndarray, districts: np.ndarray) -> np.ndarray:
    """Index of the district each point lies in. Points in no district (slivers between
    outlines) go to the nearest one."""
    points = shapely.points(x, z)
    tree = shapely.STRtree(districts)
    out = np.full(len(x), -1, np.int64)
    p, d = tree.query(points, predicate="within")
    out[p] = d
    rest = np.flatnonzero(out < 0)
    if len(rest):
        p, d = tree.query_nearest(points[rest], all_matches=False)
        out[rest[p]] = d
    return out


def read_landuse() -> tuple[list[shapely.Polygon], list[int]]:
    """OpenStreetMap land-use and amenity areas (scene coordinates) and their classes."""
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    geoms: list[shapely.Polygon] = []
    classes: list[int] = []
    keys = {k for k, _ in LANDUSE_TAGS}
    for area in osmium.FileProcessor(str(fetch_osm())).with_areas():
        if not area.is_area():
            continue
        tags = area.tags
        cls = None
        for key in keys:
            value = tags.get(key)
            if value and (key, value) in LANDUSE_TAGS:
                found = LANDUSE_TAGS[(key, value)]
                if cls is None or LANDUSE_CLASSES.index(found) < LANDUSE_CLASSES.index(cls):
                    cls = found
        if cls is None:
            continue
        for outer in area.outer_rings():
            rings = []
            for ring in [outer, *area.inner_rings(outer)]:
                lon = np.fromiter((n.lon for n in ring), float)
                lat = np.fromiter((n.lat for n in ring), float)
                e, n = to_crs.transform(lon, lat)
                if len(e) >= 4:
                    rings.append(np.column_stack([e - ORIGIN_E, ORIGIN_N - n]))
            if rings:
                geoms.append(shapely.Polygon(rings[0], rings[1:]))
                classes.append(LANDUSE_CLASSES.index(cls))
    return geoms, classes


def classify_landuse(x: np.ndarray, z: np.ndarray, geoms: list, classes: list[int]) -> np.ndarray:
    """Index in LANDUSE_CLASSES of the land use at each point (-1 if none); the class
    earliest in LANDUSE_CLASSES wins where areas overlap."""
    out = np.full(len(x), len(LANDUSE_CLASSES), np.int64)
    if geoms:
        valid = shapely.make_valid(np.asarray(geoms, dtype=object))
        tree = shapely.STRtree(valid)
        points, polys = tree.query(shapely.points(x, z), predicate="intersects")
        np.minimum.at(out, points, np.asarray(classes)[polys])
    out[out == len(LANDUSE_CLASSES)] = -1
    return out


def street_lines(
    net: dict[str, np.ndarray], index: dict
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Edges buildings can be attached to: their rightmost lane as a line, and whether they
    are local streets (preferred)."""
    types = index["types"]
    no_access = np.array([t.startswith(NO_ACCESS) for t in types])
    internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
    lane0 = net["edgeLaneStart"].astype(np.int64)
    ok = (
        ~internal
        & ~no_access[net["edgeType"]]
        & (net["edgeLaneCount"] > 0)
        & ((net["laneAllow"][lane0] & PASSENGER) != 0)
    )
    edges = np.flatnonzero(ok)
    offsets = net["laneShapeOffsets"].astype(np.int64)
    origin = net["laneShapeOrigin"].reshape(-1, 2).astype(np.int64)
    delta = net["laneShapeDelta"].reshape(-1, 2).astype(np.int64)
    lines = []
    for e in edges:
        lane = lane0[e]
        pts = (origin[lane] + np.cumsum(delta[offsets[lane] : offsets[lane + 1]], axis=0)) / 100.0
        lines.append(shapely.LineString(pts) if len(pts) >= 2 else shapely.Point(pts[0]))
    local = net["laneSpeed"][lane0[edges]] <= LOCAL_SPEED
    return edges, np.asarray(lines, dtype=object), local


def attach(
    x: np.ndarray, z: np.ndarray, edges: np.ndarray, lines: np.ndarray, local: np.ndarray
) -> np.ndarray:
    """Edge each point is attached to: the nearest local street within LOCAL_DISTANCE, else
    the nearest street within MAX_DISTANCE, else -1."""
    points = shapely.points(x, z)
    out = np.full(len(x), -1, np.int64)
    local_tree = shapely.STRtree(lines[local])
    i, j = local_tree.query_nearest(points, max_distance=LOCAL_DISTANCE, all_matches=False)
    out[i] = edges[local][j]
    rest = np.flatnonzero(out < 0)
    if len(rest):
        tree = shapely.STRtree(lines)
        i, j = tree.query_nearest(points[rest], max_distance=MAX_DISTANCE, all_matches=False)
        out[rest[i]] = edges[j]
    return out


def build_demand() -> dict:
    started = time.monotonic()
    b_index = json.loads((OUTPUT_DIR / "buildings" / "buildings.json").read_text())
    b = read_packed(OUTPUT_DIR / "buildings" / b_index["file"], b_index)
    n_index = json.loads((OUTPUT_DIR / "network" / "net.json").read_text())
    net = read_packed(OUTPUT_DIR / "network" / n_index["file"], n_index)

    rings = b["buildingRings"][:-1].astype(np.int64)
    area, x, z = outer_rings(b["ringOrigin"], b["ringOffsets"], b["deltas"], rings)
    floor_area = area * storeys(b["levels"], b["eave"]) * NET_AREA

    def to_scene(c: np.ndarray) -> np.ndarray:
        return np.column_stack([c[:, 0] - ORIGIN_E, ORIGIN_N - c[:, 1]])

    boundary = shapely.transform(city_boundary(), to_scene)
    shapely.prepare(boundary)
    inside = shapely.contains_xy(boundary, x, z)
    centre = np.hypot(x, z) < CENTRE_RADIUS
    names, outlines = city_districts()
    population = district_population(names)
    district = np.full(len(x), len(names), np.int64)  # outside the City
    district[inside] = district_of(x[inside], z[inside], shapely.transform(outlines, to_scene))

    land_geoms, land_classes = read_landuse()
    landuse = classify_landuse(x, z, land_geoms, land_classes)
    home_share, work_share = use_shares(
        b_index["kinds"], b["kind"], landuse, area, b["eave"], centre
    )
    residents = spread(floor_area * home_share, district, [*population, OUTSIDE_POPULATION])
    jobs = spread(floor_area * work_share, (~inside).astype(np.int64), [JOBS, OUTSIDE_JOBS])

    edges, lines, local = street_lines(net, n_index)
    edge_of = attach(x, z, edges, lines, local)
    attached = edge_of >= 0
    n_edges = len(net["edgeFlags"])
    home = np.bincount(edge_of[attached], residents[attached], n_edges)
    work = np.bincount(edge_of[attached], jobs[attached], n_edges)
    used = np.flatnonzero((home > 0) | (work > 0))

    out_dir = OUTPUT_DIR / "demand"
    packed = write_packed(
        out_dir / "demand.bin.gz",
        {
            "demandEdge": used.astype(np.uint32),
            "demandHome": home[used].astype(np.float32),
            "demandWork": work[used].astype(np.float32),
        },
    )
    total_residents = float(home.sum())
    stats = {
        "residents": round(total_residents),
        "residentsInCity": round(float(residents[inside & attached].sum())),
        "jobs": round(float(work.sum())),
        "edges": len(used),
        "buildingsAttached": int(attached.sum()),
        "buildingsUnattached": int((~attached).sum()),
        "dailyCarTrips": round(total_residents * CAR_TRIPS_PER_RESIDENT),
    }
    # Residents and jobs the simulation has per district (buildings far from any street
    # have none).
    per_district = [
        {
            "name": name,
            "population": population[i],
            "residents": round(float(residents[attached & (district == i)].sum())),
            "jobs": round(float(jobs[attached & (district == i)].sum())),
        }
        for i, name in enumerate(names)
    ]
    (out_dir / "demand.json").write_text(
        json.dumps({**packed, **stats, "districts": per_district}, ensure_ascii=False)
    )
    log.info("demand: %s (%.0fs)", stats, time.monotonic() - started)
    return {"index": "demand/demand.json", **stats, "attribution": ATTRIBUTION}
