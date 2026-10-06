"""Buildings: footprints and attributes from OpenStreetMap, packed for the app.

Heights come from OSM `height` / `building:levels` where mapped (about 3 % of buildings)
and otherwise from estimates by building type and footprint size. The City of Zagreb's
ZG3D model will replace the estimates.
"""

from __future__ import annotations

import json
import logging
import re

import numpy as np
import osmium
from pyproj import Transformer

from .config import CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR
from .osm import ATTRIBUTION as OSM_ATTRIBUTION
from .osm import fetch_osm
from .packed import write_packed

log = logging.getLogger(__name__)

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
            "kiosk",
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
FLAG_MEASURED = 1  # height from data, not estimated

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


def ring_area(xs: np.ndarray, zs: np.ndarray) -> float:
    return 0.5 * float(np.dot(xs, np.roll(zs, -1)) - np.dot(zs, np.roll(xs, -1)))


def build_buildings() -> dict:
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    points: list[np.ndarray] = []
    ring_offsets = [0]
    building_rings = [0]
    heights, min_heights, kinds, roofs, levels_out, flags = [], [], [], [], [], []
    total_points = 0

    for area in osmium.FileProcessor(str(fetch_osm())).with_areas():
        if not area.is_area():
            continue
        tags = area.tags
        building = tags.get("building")
        if not building or building == "no":
            continue
        rings: list[np.ndarray] = []
        for outer in area.outer_rings():
            group = [outer, *area.inner_rings(outer)]
            for ring in group:
                lon = np.fromiter((n.lon for n in ring), float)
                lat = np.fromiter((n.lat for n in ring), float)
                e, n = to_crs.transform(lon, lat)
                xz = np.column_stack([e - ORIGIN_E, ORIGIN_N - n])[:-1]  # drop closing point
                if len(xz) >= 3:
                    rings.append(xz)
            break  # one outer ring per building; multi-part buildings are rare
        if not rings:
            continue

        footprint = abs(ring_area(rings[0][:, 0], rings[0][:, 1]))
        kind = KIND_OF_TYPE.get(building, "other")
        levels = parse_metres(tags.get("building:levels"))
        roof_levels = parse_metres(tags.get("roof:levels"))
        measured = parse_metres(tags.get("height"))
        height = measured or estimate_height(kind, footprint, levels, roof_levels)
        min_height = parse_metres(tags.get("min_height"))
        if min_height is None and tags.get("building:min_level"):
            min_height = (parse_metres(tags.get("building:min_level")) or 0) * LEVEL_HEIGHT
        roof = tags.get("roof:shape")
        if roof is None:
            # Zagreb's houses and small buildings mostly have pitched tiled roofs.
            small = kind in ("house", "other") and footprint < 300 and height <= 10
            roof = "gabled" if small else "flat"

        for xz in rings:
            points.append(xz.astype(np.float32))
            total_points += len(xz)
            ring_offsets.append(total_points)
        building_rings.append(len(ring_offsets) - 1)
        heights.append(height)
        min_heights.append(min_height or 0.0)
        kinds.append(KINDS.index(kind))
        roofs.append(ROOF_SHAPES.index(roof) if roof in ROOF_SHAPES else ROOF_SHAPES.index("other"))
        levels_out.append(min(255, round(levels)) if levels else 0)
        flags.append(FLAG_MEASURED if measured or levels else 0)

    out_dir = OUTPUT_DIR / "buildings"
    packed = write_packed(
        out_dir / "buildings.bin.gz",
        {
            "points": np.concatenate(points).ravel(),
            "ringOffsets": np.asarray(ring_offsets, np.uint32),
            "buildingRings": np.asarray(building_rings, np.uint32),
            "height": np.asarray(heights, np.float32),
            "minHeight": np.asarray(min_heights, np.float32),
            "kind": np.asarray(kinds, np.uint8),
            "roofShape": np.asarray(roofs, np.uint8),
            "levels": np.asarray(levels_out, np.uint8),
            "flags": np.asarray(flags, np.uint8),
        },
    )
    index = {**packed, "kinds": KINDS, "roofShapes": ROOF_SHAPES, "flags": {"measured": 1}}
    (out_dir / "buildings.json").write_text(json.dumps(index))
    count = len(heights)
    measured_share = sum(flags) / count if count else 0
    log.info("buildings: %d, %.1f %% with measured height", count, measured_share * 100)
    return {
        "index": "buildings/buildings.json",
        "counts": {"buildings": count, "measuredHeights": int(sum(flags))},
        "attribution": OSM_ATTRIBUTION,
    }
