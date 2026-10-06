"""Travel demand: where people live and work, attached to the street network.

Every building gets residents and jobs from its floor area and use. The use comes from its
OpenStreetMap type, else from the OpenStreetMap land use around it, else from its shape.
Each of the City's 17 districts has its census population spread over the residential floor
area inside it, and each settlement (naselje) around the City has its census population
spread over the residential floor area inside its OpenStreetMap boundary. Jobs are spread
over work floor area. Each building is attached to the nearest street a car can use, and the
engine draws trips between street edges weighted by these numbers (sim/src/demand.rs).

Residents outside the City make more car trips than the City's: the home weights the engine
gets are residents times their car-trip rate relative to the City's (CAR_TRIP_RATE).
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
from .census import ATTRIBUTION as SETTLEMENTS_ATTRIBUTION
from .config import CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR, PIPELINE_DIR
from .counts import ATTRIBUTION as COUNTS_ATTRIBUTION
from .gateways import build_gateways, map_outline
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
DISTRICTS_ATTRIBUTION = {
    "name": "Grad Zagreb, gradske četvrti",
    "text": "City district outlines from the register of spatial units (DGU), published by the "
    "City of Zagreb on data.zagreb.hr, 2025-02-03. Otvorena dozvola.",
    "url": "https://data.zagreb.hr/dataset/gradske-cetvrti-prostorna-jedinica-mjesne-samouprave-za-podrucje-grada-zagreba",
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
# Jobs in the towns and municipalities around the City inside the map (Velika Gorica,
# Samobor, Zaprešić, Sveta Nedelja, Dugo Selo and smaller ones).
OUTSIDE_JOBS = 80_000
# Car trips per resident and day in the City: 1.84 trips per person (Master Plan survey),
# 46 % by car, 1.3 people per car.
CAR_TRIPS_PER_RESIDENT = 1.84 * 0.46 / 1.3
# Car trips per resident and day by county. The Master Plan's model has 1.84 trips per
# person in the City and in Krapina-Zagorje County and 1.90 in Zagreb County, of which (not
# walking) 52.2 %, 80.3 % and 67.3 % by car; scaled from the City's survey rate by those
# ratios. Counties outside the Master Plan area take Zagreb County's rate.
COUNTY_RATE = CAR_TRIPS_PER_RESIDENT * 1.90 / 1.84 * 67.3 / 52.2
CAR_TRIP_RATE = {
    "Grad Zagreb": CAR_TRIPS_PER_RESIDENT,
    "Zagrebačka": COUNTY_RATE,
    "Krapinsko-zagorska": CAR_TRIPS_PER_RESIDENT * 80.3 / 52.2,
}
SETTLEMENTS = PIPELINE_DIR / "data" / "census_2021_settlements.json"
# Share of the estimated demand the simulation runs (docs/VALIDATION.md). The simulated
# junctions carry less than Zagreb's real ones: at full demand the morning queues never
# clear, and at 70 % they still lock up by 10:00. Until junctions and signals are calibrated,
# the demand is scaled to what the network carries.
DEMAND_SCALE = 0.6
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
# Edges shorter than this (m) are pieces of junctions, not streets to start a trip on.
MIN_STREET_LENGTH = 20.0
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


def read_boundaries() -> tuple[
    list[tuple[str, shapely.Geometry]], list[tuple[str, shapely.Geometry]]
]:
    """OpenStreetMap outlines (scene coordinates) of settlements (admin level 8) and of towns
    and municipalities (level 7), with their names."""
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    out: dict[str, list[tuple[str, shapely.Geometry]]] = {"7": [], "8": []}
    for area in osmium.FileProcessor(str(fetch_osm())).with_areas():
        tags = area.tags
        if not area.is_area() or tags.get("boundary") != "administrative":
            continue
        level = tags.get("admin_level")
        if level not in out or not tags.get("name"):
            continue
        polys = []
        for outer in area.outer_rings():
            rings = []
            for ring in [outer, *area.inner_rings(outer)]:
                lon = np.fromiter((n.lon for n in ring), float)
                lat = np.fromiter((n.lat for n in ring), float)
                e, n = to_crs.transform(lon, lat)
                if len(e) >= 4:
                    rings.append(np.column_stack([e - ORIGIN_E, ORIGIN_N - n]))
            if rings:
                polys.append(shapely.Polygon(rings[0], rings[1:]))
        if polys:
            out[level].append((tags["name"], shapely.make_valid(shapely.MultiPolygon(polys))))
    return out["8"], out["7"]


def settlement_zones(
    x: np.ndarray, z: np.ndarray, outside: np.ndarray
) -> tuple[np.ndarray, list[float], list[float], dict]:
    """Census settlement of each building outside the City: (zone index per building, -1
    for none; the population of each zone inside the map; each zone's car trips per
    resident; statistics). A settlement's population is matched by its name and its town
    or municipality, and cut to the share of its outline inside the map."""
    census = json.loads(SETTLEMENTS.read_text())["settlements"]
    by_key = {
        (normalize_name(r["municipality"]), normalize_name(r["settlement"])): r for r in census
    }
    by_name: dict[str, list[dict]] = {}
    for r in census:
        by_name.setdefault(normalize_name(r["settlement"]), []).append(r)
    settlements, municipalities = read_boundaries()
    town_tree = shapely.STRtree([g for _, g in municipalities]) if municipalities else None
    world = map_outline()

    def town_of(geom: shapely.Geometry) -> str | None:
        if town_tree is None:
            return None
        hits = town_tree.query(geom.representative_point(), predicate="within")
        return (
            re.sub(r"^(Grad|Općina)\s+", "", municipalities[int(hits[0])][0]) if len(hits) else None
        )

    # By name and town where the town's outline is complete in the extract, else by a name
    # used once in these counties; names used more than once take the town of the nearest
    # settlement matched so far.
    rows: list[dict | None] = []
    for name, geom in settlements:
        town = town_of(geom)
        row = by_key.get((normalize_name(town), normalize_name(name))) if town else None
        if row is None and len(by_name.get(normalize_name(name), [])) == 1:
            row = by_name[normalize_name(name)][0]
        rows.append(row)
    matched = [i for i, r in enumerate(rows) if r is not None]
    if matched:
        near_tree = shapely.STRtree([settlements[i][1] for i in matched])
        for i, r in enumerate(rows):
            if r is not None:
                continue
            name, geom = settlements[i]
            j = matched[int(near_tree.nearest(geom.representative_point()))]
            town = rows[j]["municipality"]
            rows[i] = by_key.get((normalize_name(town), normalize_name(name)))
    zone = np.full(len(x), -1, np.int64)
    totals: list[float] = []
    rates: list[float] = []
    geoms = []
    unmatched = [settlements[i][0] for i, r in enumerate(rows) if r is None]
    for (_, geom), row in zip(settlements, rows, strict=True):
        if row is None or row["county"] == "Grad Zagreb":
            continue  # the City's districts have their own census population
        share = float(geom.intersection(world).area / max(geom.area, 1.0))
        totals.append(row["population"] * share)
        rates.append(CAR_TRIP_RATE.get(row["county"], COUNTY_RATE))
        geoms.append(geom)
    if geoms:
        tree = shapely.STRtree(geoms)
        idx = np.flatnonzero(outside)
        points, polys = tree.query(shapely.points(x[idx], z[idx]), predicate="within")
        zone[idx[points]] = polys
    stats = {
        "settlements": len(geoms),
        "settlementPopulation": round(sum(totals)),
        "settlementsUnmatched": len(unmatched),
    }
    return zone, totals, rates, stats


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
        & (net["laneLength"][lane0] >= MIN_STREET_LENGTH)
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
    home_area = floor_area * home_share
    residents = spread(home_area, district, [*population, 0.0])
    # Around the City: each settlement's census population over its homes; homes in no
    # matched settlement (Slovenia, gaps between outlines) at the settlements' mean density.
    zone, totals, zone_rates, settlement_stats = settlement_zones(x, z, ~inside)
    zoned = zone >= 0
    residents[zoned] = spread(home_area[zoned], zone[zoned], totals)
    density = sum(totals) / max(float(home_area[zoned].sum()), 1.0)
    rest = ~inside & ~zoned
    residents[rest] = home_area[rest] * density
    rate = np.full(len(x), CAR_TRIPS_PER_RESIDENT)
    rate[zoned] = np.asarray(zone_rates)[zone[zoned]]
    rate[rest] = COUNTY_RATE
    jobs = spread(floor_area * work_share, (~inside).astype(np.int64), [JOBS, OUTSIDE_JOBS])

    edges, lines, local = street_lines(net, n_index)
    edge_of = attach(x, z, edges, lines, local)
    attached = edge_of >= 0
    n_edges = len(net["edgeFlags"])
    people = np.bincount(edge_of[attached], residents[attached], n_edges)
    # The engine draws trips in proportion to these weights, and the runners take the day's
    # trips as the weights times the City's rate.
    trip_weight = residents * rate / CAR_TRIPS_PER_RESIDENT
    home = np.bincount(edge_of[attached], trip_weight[attached], n_edges)
    work = np.bincount(edge_of[attached], jobs[attached], n_edges)
    used = np.flatnonzero((home > 0) | (work > 0))
    gateway_arrays, gateways = build_gateways(net, n_index)

    out_dir = OUTPUT_DIR / "demand"
    packed = write_packed(
        out_dir / "demand.bin.gz",
        {
            "demandEdge": used.astype(np.uint32),
            "demandHome": home[used].astype(np.float32),
            "demandWork": work[used].astype(np.float32),
            **gateway_arrays,
        },
    )
    stats = {
        "residents": round(float(people.sum())),
        "residentsInCity": round(float(residents[inside & attached].sum())),
        "jobs": round(float(work.sum())),
        "edges": len(used),
        "buildingsAttached": int(attached.sum()),
        "buildingsUnattached": int((~attached).sum()),
        "dailyCarTrips": round(float(home.sum()) * CAR_TRIPS_PER_RESIDENT),
        **settlement_stats,
        "gateways": len(gateways),
        "gatewayDaily": round(sum(g["daily"] for g in gateways)),
        "demandScale": DEMAND_SCALE,
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
        json.dumps(
            {**packed, **stats, "districts": per_district, "gatewayList": gateways},
            ensure_ascii=False,
        )
    )
    log.info("demand: %s (%.0fs)", stats, time.monotonic() - started)
    return {
        "index": "demand/demand.json",
        **stats,
        "attribution": [
            ATTRIBUTION,
            DISTRICTS_ATTRIBUTION,
            SETTLEMENTS_ATTRIBUTION,
            COUNTS_ATTRIBUTION,
        ],
    }
