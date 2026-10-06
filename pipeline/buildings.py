"""Buildings for the app.

Inside the City of Zagreb: footprints and measured heights from the City's ZG3D 2022 model
(357,683 buildings), with building type and roof shape taken from the OpenStreetMap
building that contains each footprint. Outside the City: OpenStreetMap footprints, with
heights from OSM tags where mapped and otherwise estimated from type and size.

Footprints are delta-encoded: each ring stores its first point in centimetres (int32) and
every following point as a centimetre offset from the previous one (int16).
"""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import osmium
import pyogrio
import shapely
from pyproj import Transformer

from .config import CACHE_DIR, CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR
from .osm import ATTRIBUTION as OSM_ATTRIBUTION
from .osm import fetch_osm
from .packed import write_packed

log = logging.getLogger(__name__)

CKAN_API = "https://data.zagreb.hr/api/3/action/package_show?id="
ZG3D_PACKAGE = "zg3d-2022-3d-model-gz"
BOUNDARY_PACKAGE = "grad-zagreb-prostorna-jedinica"

ZG3D_ATTRIBUTION = {
    "name": "ZG3D 2022, Grad Zagreb",
    "text": "Izvor: Grad Zagreb, ZG3D 2022 3D model (data.zagreb.hr), last modified 2025-05-07. "
    "Open Licence of the Republic of Croatia (Otvorena dozvola). Footprints simplified, "
    "heights derived from Z_Max - Z_Min.",
    "url": "https://data.zagreb.hr/dataset/zg3d-2022-3d-model-gz",
}

KINDS = ["house", "residential", "commercial", "industrial", "civic", "religious", "minor", "other"]
KIND_OF_TYPE = {
    **dict.fromkeys(
        ["house", "detached", "semidetached_house", "terrace", "bungalow", "villa"], "house"
    ),
    **dict.fromkeys(["residential", "apartments", "dormitory"], "residential"),
    **dict.fromkeys(
        ["commercial", "retail", "office", "hotel", "supermarket", "kiosk", "shop"], "commercial"
    ),
    **dict.fromkeys(
        ["industrial", "warehouse", "manufacture", "factory", "hangar", "storage_tank"],
        "industrial",
    ),
    **dict.fromkeys(
        [
            "school",
            "university",
            "college",
            "kindergarten",
            "hospital",
            "public",
            "civic",
            "government",
            "train_station",
            "transportation",
            "sports_hall",
            "stadium",
            "fire_station",
        ],
        "civic",
    ),
    **dict.fromkeys(
        ["church", "chapel", "cathedral", "mosque", "synagogue", "temple", "religious"],
        "religious",
    ),
    **dict.fromkeys(
        [
            "garage",
            "garages",
            "shed",
            "roof",
            "carport",
            "greenhouse",
            "barn",
            "farm_auxiliary",
            "hut",
            "cabin",
            "service",
            "container",
            "toilets",
        ],
        "minor",
    ),
}
ROOF_SHAPES = [
    "flat",
    "gabled",
    "hipped",
    "pyramidal",
    "skillion",
    "half-hipped",
    "gambrel",
    "mansard",
    "dome",
    "round",
    "other",
]
LEVEL_HEIGHT = 3.0  # metres per storey
SIMPLIFY_TOLERANCE = 0.3  # metres
MAX_HEIGHT = 250.0  # power-plant chimneys reach ~200 m
FLAG_MEASURED = 1  # height from data, not estimated
FLAG_ZG3D = 2  # footprint and height from the City's ZG3D model

_NUMBER = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def parse_metres(value: str | None) -> float | None:
    """Parse OSM lengths like "12", "12.5 m" or "12,5"; None if absent or nonsense."""
    if not value:
        return None
    match = _NUMBER.search(value)
    if not match:
        return None
    number = float(match.group().replace(",", "."))
    if "'" in value or "ft" in value:
        number *= 0.3048
    return number if 0 < number < 1000 else None


def estimate_height(
    kind: str, area: float, levels: float | None, roof_levels: float | None
) -> float:
    """Height of a building with no measured height, from its storeys or type and size."""
    if levels:
        return levels * LEVEL_HEIGHT + (roof_levels or 0) * 2.5 + 1.0
    if kind == "minor":
        return 3.0
    if kind == "house":
        return 7.5
    if kind == "religious":
        return 14.0
    if kind == "industrial":
        return 9.0
    if kind == "commercial":
        return 8.0 if area < 1500 else 12.0
    if kind == "civic":
        return 12.0
    if kind == "residential":
        return 9.0 if area < 200 else 15.0 if area < 700 else 21.0
    # building=yes: by footprint size, Zagreb's typical mix of houses and blocks
    if area < 40:
        return 3.0
    if area < 180:
        return 7.0
    if area < 450:
        return 10.0
    if area < 1500:
        return 14.0
    return 18.0


PITCHED = {"gabled", "hipped", "pyramidal", "half-hipped", "gambrel", "mansard"}


def pitched_roof_height(height: float) -> float:
    """Roof height for buildings without a measured shape."""
    return min(4.0, max(2.0, height * 0.3))


def default_roof(kind: str, area: float, height: float) -> str:
    """Zagreb's houses and small buildings mostly have pitched tiled roofs."""
    small = kind in ("house", "other", "minor") and area < 300 and height <= 10
    return "gabled" if small else "flat"


@dataclass
class BuildingSet:
    """Buildings in EPSG:3765 with per-building attributes."""

    geoms: list[shapely.Polygon] = field(default_factory=list)
    height: list[float] = field(default_factory=list)  # top of the roof
    eave: list[float] = field(default_factory=list)  # top of the walls
    min_height: list[float] = field(default_factory=list)
    kind: list[int] = field(default_factory=list)
    roof: list[int] = field(default_factory=list)
    levels: list[int] = field(default_factory=list)
    flags: list[int] = field(default_factory=list)
    year: list[int] = field(default_factory=list)

    def add(self, geom, height, eave, min_height, kind, roof, levels, flags, year=0) -> None:
        self.geoms.append(geom)
        self.height.append(height)
        self.eave.append(eave)
        self.min_height.append(min_height)
        self.kind.append(KINDS.index(kind))
        self.roof.append(
            ROOF_SHAPES.index(roof) if roof in ROOF_SHAPES else ROOF_SHAPES.index("other")
        )
        self.levels.append(levels)
        self.flags.append(flags)
        self.year.append(year)


def _get(url: str, timeout: int = 600) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "zg-city-sim pipeline"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def ckan_resource(package: str, fmt: str) -> tuple[str, str]:
    """(download URL, last-modified) of a resource of a data.zagreb.hr package."""
    result = json.loads(_get(CKAN_API + package, timeout=60))["result"]
    for resource in result["resources"]:
        if resource.get("format", "").lower() == fmt.lower():
            return resource["url"], resource.get("last_modified") or resource.get("created") or ""
    raise LookupError(f"{package} has no {fmt} resource")


def fetch_cached(url: str, path: Path) -> Path:
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    log.info("downloading %s", url)
    tmp = path.with_name(path.name + ".partial")
    tmp.write_bytes(_get(url, timeout=1800))
    tmp.rename(path)
    return path


def fetch_zg3d() -> Path:
    url, modified = ckan_resource(ZG3D_PACKAGE, "GeoJSON")
    stamp = re.sub(r"\D", "", modified)[:8] or "latest"
    return fetch_cached(url, CACHE_DIR / "zg3d" / f"zg3d_city_{stamp}.geojson")


def city_boundary() -> shapely.Geometry:
    """The City of Zagreb's official boundary (DGU register of spatial units), EPSG:3765."""
    url, modified = ckan_resource(BOUNDARY_PACKAGE, "SHP")
    stamp = re.sub(r"\D", "", modified)[:8] or "latest"
    path = fetch_cached(url, CACHE_DIR / "boundary" / f"rpj_grad_{stamp}.zip")
    _, _, wkb, _ = pyogrio.raw.read(f"/vsizip/{path}", read_geometry=True, columns=[])
    boundary = shapely.union_all(shapely.from_wkb(wkb))
    return shapely.force_2d(boundary)


def _to_htrs(geoms: np.ndarray) -> np.ndarray:
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    return shapely.transform(
        geoms, lambda xy: np.column_stack(to_crs.transform(xy[:, 0], xy[:, 1]))
    )


def _simplify(geoms: np.ndarray) -> np.ndarray:
    simple = shapely.simplify(geoms, SIMPLIFY_TOLERANCE, preserve_topology=True)
    return np.where(shapely.is_valid(simple) | ~shapely.is_valid(geoms), simple, geoms)


def roof_from_volume(
    ridge: np.ndarray, mean: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Infer (roof top, wall top, pitched?) from a building's peak height and its mean height.

    The mean height (volume / footprint) tells the shape apart: a box has mean = peak, a
    pitched roof has mean = eave + roof / 2, and spires or towers on a lower body pull the
    peak far above the mean.
    """
    ratio = np.clip(mean / np.maximum(ridge, 1e-6), 0, 1)
    flat = ratio >= 0.9
    pitched = ~flat & (ratio >= 0.55) & (ridge < 40)
    eave = np.clip(2 * mean - ridge, 2.0, np.maximum(ridge - 1.0, 2.0))
    top = np.where(flat, ridge, np.where(pitched, ridge, mean))
    wall = np.where(flat, ridge, np.where(pitched, eave, mean))
    return top, wall, pitched


def covers_other_buildings(parts: np.ndarray, area: np.ndarray, limit: int = 3) -> np.ndarray:
    """Large footprints that contain several other footprints.

    The 2008 survey has a few square "buildings" of up to 200 x 200 m drawn over whole
    blocks whose real buildings are mapped separately; they are artifacts, not buildings.
    """
    big = np.flatnonzero(area > 2000)
    points = shapely.point_on_surface(parts)
    tree = shapely.STRtree(points)
    hits, inside = tree.query(parts[big], predicate="contains")
    contained = np.bincount(hits[big[hits] != inside], minlength=len(big))
    flagged = np.zeros(len(parts), bool)
    flagged[big[contained >= limit]] = True
    log.info("ZG3D: dropping %d footprints drawn over other buildings", int(flagged.sum()))
    return flagged


def read_zg3d(path: Path) -> dict[str, np.ndarray]:
    """Single-part footprints (EPSG:3765) with roof top, wall top and survey year."""
    meta, _, wkb, fields = pyogrio.raw.read(
        path, columns=["Z_Min", "Z_Max", "Volume", "Godina_izv"]
    )
    cols = dict(zip(meta["fields"], fields, strict=True))
    z_min = np.asarray(cols["Z_Min"], float)
    ridge = np.asarray(cols["Z_Max"], float) - z_min
    volume = np.asarray(cols["Volume"], float)
    year = np.array([int(y) if str(y).isdigit() else 0 for y in cols["Godina_izv"]], np.uint16)

    geoms = _simplify(_to_htrs(shapely.force_2d(shapely.from_wkb(wkb))))
    parts, owner = shapely.get_parts(geoms, return_index=True)
    part_area = shapely.area(parts)
    # Volume belongs to the whole record; share it between parts by area.
    record_area = np.bincount(owner, weights=part_area, minlength=len(geoms))[owner]
    ridge, year, z_min = ridge[owner], year[owner], z_min[owner]
    volume = volume[owner] * part_area / np.maximum(record_area, 1e-6)

    # Drop slivers and broken records; give very low "buildings" a minimal height.
    keep = (z_min > 50) & (part_area >= 4) & ~((ridge < 1) & (part_area < 20))
    keep &= ~covers_other_buildings(parts, part_area)
    ridge = np.clip(ridge, 2.0, MAX_HEIGHT)
    mean = np.where(volume > 0, volume / np.maximum(part_area, 1e-6), ridge)
    mean = np.clip(mean, 2.0, ridge)
    top, wall, pitched = roof_from_volume(ridge, mean)
    return {
        "geoms": parts[keep],
        "top": top[keep],
        "wall": wall[keep],
        "pitched": pitched[keep],
        "year": year[keep],
    }


def read_osm_buildings() -> tuple[list[shapely.Polygon], list[dict]]:
    """OSM building outlines (EPSG:3765) and their attributes."""
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    geoms: list[shapely.Polygon] = []
    attrs: list[dict] = []
    for area in osmium.FileProcessor(str(fetch_osm())).with_areas():
        if not area.is_area():
            continue
        tags = area.tags
        building = tags.get("building")
        if not building or building == "no":
            continue
        for outer in area.outer_rings():
            rings = []
            for ring in [outer, *area.inner_rings(outer)]:
                lon = np.fromiter((n.lon for n in ring), float)
                lat = np.fromiter((n.lat for n in ring), float)
                e, n = to_crs.transform(lon, lat)
                if len(e) >= 4:
                    rings.append(np.column_stack([e, n]))
            if rings:
                geoms.append(shapely.Polygon(rings[0], rings[1:]))
                attrs.append(
                    {
                        "kind": KIND_OF_TYPE.get(building, "other"),
                        "levels": parse_metres(tags.get("building:levels")),
                        "roof_levels": parse_metres(tags.get("roof:levels")),
                        "height": parse_metres(tags.get("height")),
                        "min_height": parse_metres(tags.get("min_height")),
                        "min_level": parse_metres(tags.get("building:min_level")),
                        "roof": tags.get("roof:shape"),
                    }
                )
            break  # one outer ring per OSM building; multi-part buildings are rare
    return geoms, attrs


def merge_buildings() -> BuildingSet:
    started = time.monotonic()
    boundary = city_boundary()
    shapely.prepare(boundary)
    osm_geoms, osm_attrs = read_osm_buildings()
    osm_array = _simplify(np.array(osm_geoms, dtype=object))
    osm_inside = shapely.contains_xy(
        boundary, *shapely.get_coordinates(shapely.point_on_surface(osm_array)).T
    )
    log.info("OSM: %d buildings (%d inside the City)", len(osm_array), int(osm_inside.sum()))

    out = BuildingSet()

    # Outside the City: OpenStreetMap.
    for geom, attr in zip(
        osm_array[~osm_inside], np.array(osm_attrs, dtype=object)[~osm_inside], strict=True
    ):
        area = float(shapely.area(geom))
        measured = attr["height"]
        height = measured or estimate_height(
            attr["kind"], area, attr["levels"], attr["roof_levels"]
        )
        min_height = attr["min_height"] or (attr["min_level"] or 0) * LEVEL_HEIGHT
        roof = attr["roof"] or default_roof(attr["kind"], area, height)
        flags = FLAG_MEASURED if measured or attr["levels"] else 0
        levels = min(255, round(attr["levels"])) if attr["levels"] else 0
        eave = height - pitched_roof_height(height) if roof in PITCHED else height
        out.add(geom, height, eave, min_height, attr["kind"], roof, levels, flags)

    # Inside the City: ZG3D footprints and heights, OSM type and roof where they overlap.
    zg3d = read_zg3d(fetch_zg3d())
    inside_geoms = osm_array[osm_inside]
    inside_attrs = np.array(osm_attrs, dtype=object)[osm_inside]
    tree = shapely.STRtree(inside_geoms)
    pairs = tree.query(shapely.point_on_surface(zg3d["geoms"]), predicate="within")
    match = np.full(len(zg3d["geoms"]), -1)
    match[pairs[0]] = pairs[1]
    for i, geom in enumerate(zg3d["geoms"]):
        attr = inside_attrs[match[i]] if match[i] >= 0 else None
        area = float(shapely.area(geom))
        top = float(zg3d["top"][i])
        kind = attr["kind"] if attr else ("minor" if area < 30 and top < 4 else "other")
        # The measured shape decides between flat and pitched; OSM only names the pitch type.
        if zg3d["pitched"][i]:
            roof = attr["roof"] if attr and attr["roof"] in PITCHED else "gabled"
        else:
            roof = "flat"
        levels = min(255, round(attr["levels"])) if attr and attr["levels"] else 0
        out.add(
            geom,
            top,
            float(zg3d["wall"][i]),
            0.0,
            kind,
            roof,
            levels,
            FLAG_MEASURED | FLAG_ZG3D,
            int(zg3d["year"][i]),
        )
    log.info(
        "ZG3D: %d footprints, %d matched to OSM, %d pitched (%.0fs)",
        len(zg3d["geoms"]),
        int((match >= 0).sum()),
        int(zg3d["pitched"].sum()),
        time.monotonic() - started,
    )
    return out


def encode_rings(geoms: list[shapely.Polygon]) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """Delta-encode footprint rings in scene centimetres (x = east, z = south).

    Returns the arrays and a mask of the buildings kept (degenerate outlines are dropped).
    """
    ring_origin: list[tuple[int, int]] = []
    ring_offsets = [0]
    building_rings = [0]
    deltas: list[np.ndarray] = []
    kept = np.zeros(len(geoms), bool)
    total = 0
    for b, geom in enumerate(geoms):
        if geom.is_empty or len(geom.exterior.coords) < 4:
            continue
        kept[b] = True
        for ring in [geom.exterior, *geom.interiors]:
            xy = np.asarray(ring.coords)[:-1]  # drop the closing point
            if len(xy) < 3:
                continue
            cm = np.round(
                np.column_stack([(xy[:, 0] - ORIGIN_E) * 100, (ORIGIN_N - xy[:, 1]) * 100])
            ).astype(np.int64)
            d = np.diff(cm, axis=0, prepend=cm[:1])
            if np.abs(d).max() > 32767:  # split edges longer than 327 m
                cm = _densify(cm)
                d = np.diff(cm, axis=0, prepend=cm[:1])
            ring_origin.append((int(cm[0, 0]), int(cm[0, 1])))
            deltas.append(d.astype(np.int16))
            total += len(d)
            ring_offsets.append(total)
        building_rings.append(len(ring_offsets) - 1)
    arrays = {
        "ringOrigin": np.asarray(ring_origin, np.int32).ravel(),
        "ringOffsets": np.asarray(ring_offsets, np.uint32),
        "buildingRings": np.asarray(building_rings, np.uint32),
        "deltas": np.concatenate(deltas).ravel(),
    }
    return arrays, kept


def _densify(cm: np.ndarray, max_step: int = 30000) -> np.ndarray:
    out = [cm[0]]
    for p, q in zip(cm[:-1], cm[1:], strict=True):
        steps = int(np.ceil(np.abs(q - p).max() / max_step))
        for s in range(1, steps + 1):
            out.append(np.round(p + (q - p) * s / steps).astype(np.int64))
    return np.asarray(out)


def build_buildings() -> dict:
    data = merge_buildings()
    arrays, kept = encode_rings(data.geoms)
    arrays |= {
        "height": np.asarray(data.height, np.float32)[kept],
        "eave": np.asarray(data.eave, np.float32)[kept],
        "minHeight": np.asarray(data.min_height, np.float32)[kept],
        "kind": np.asarray(data.kind, np.uint8)[kept],
        "roofShape": np.asarray(data.roof, np.uint8)[kept],
        "levels": np.asarray(data.levels, np.uint8)[kept],
        "flags": np.asarray(data.flags, np.uint8)[kept],
        "year": np.asarray(data.year, np.uint16)[kept],
    }
    if len(arrays["buildingRings"]) - 1 != len(arrays["height"]):
        raise RuntimeError("building outlines and attributes are out of step")
    out_dir = OUTPUT_DIR / "buildings"
    packed = write_packed(out_dir / "buildings.bin.gz", arrays)
    index = {
        **packed,
        "encoding": "delta-cm",
        "kinds": KINDS,
        "roofShapes": ROOF_SHAPES,
        "flags": {"measured": FLAG_MEASURED, "zg3d": FLAG_ZG3D},
    }
    (out_dir / "buildings.json").write_text(json.dumps(index))
    flags = arrays["flags"]
    counts = {
        "buildings": len(flags),
        "zg3d": int((flags & FLAG_ZG3D).astype(bool).sum()),
        "measuredHeights": int((flags & FLAG_MEASURED).astype(bool).sum()),
    }
    log.info("buildings: %s", counts)
    return {
        "index": "buildings/buildings.json",
        "counts": counts,
        "attribution": [ZG3D_ATTRIBUTION, OSM_ATTRIBUTION],
    }
