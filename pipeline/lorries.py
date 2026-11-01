"""Lorry rules (M21): the roads OpenStreetMap closes to lorries or limits by weight, and
Zagreb's central zone, which lorries over 12 t may not drive into.

- A way's limit is its `maxweight` (or `maxweight:hgv`), or 3.5 t where `hgv` keeps lorries
  off it or lets them in only to reach places on it (`no`, `destination`, `delivery`,
  `private`): OpenStreetMap's heavy goods vehicles are those over 3.5 t. Netconvert reads
  neither tag. Each edge takes the lowest limit of the ways it was built from (`origId`),
  as `edgeMaxWeight` in tenths of a tonne (0: none). The engine's lorry routes count an hour
  for driving onto a road limited to less than the lorry weighs, so lorries use such roads
  only to reach places on them.
- The central zone is bounded by the streets the City's order names, not including them
  (Naredba o uvjetima prometovanja vozila u središnjem dijelu Grada Zagreba i pješačkim
  zonama, 2024, article 2); its article 4 keeps lorries over 12 t out, but by permit. The
  boundary follows each street as OpenStreetMap maps it, from where it meets the street
  before to where it meets the next (`trace_zone`), as `lorryZone` (x, z in turn).
"""

from __future__ import annotations

import heapq
import json
import logging
import re
from pathlib import Path

import numpy as np
import osmium
import shapely
from pyproj import Transformer

from .config import CACHE_DIR, CRS, ORIGIN_E, ORIGIN_N

log = logging.getLogger(__name__)

#: Version of what `lorry_rules` keeps: bump it when the rules read change.
VERSION = 1

#: OpenStreetMap's heavy goods vehicles (`hgv`) are those over 3.5 t.
HGV_TONNES = 3.5
#: `hgv` values that keep lorries off a road, or let them in only to reach places on it.
HGV_CLOSED = {"no", "destination", "delivery", "private"}

#: The central zone's boundary, in the order's words (article 2): the streets in turn, each
#: as OpenStreetMap names it (some under more than one name).
ZONE_STREETS: list[tuple[str, ...]] = [
    ("Ulica Republike Austrije",),
    ("Ulica Vatroslava Jagića",),
    ("Ulica Božidara Adžije",),
    ("Nova cesta",),
    ("Ulica Silvija Strahimira Kranjčevića",),
    ("Ulica Florijana Andrašeca",),
    ("Ulica grada Vukovara",),
    ("Avenija Marina Držića",),
    ("Ulica kneza Branimira",),
    ("Ulica Vjekoslava Heinzela",),
    ("Trg Eugena Kvaternika",),
    ("Ulica Dragutina Domjanića", "Ulica Dragutina M. Domjanića", "Dragutina Domjanića"),
    ("Voćarska cesta",),
    ("Bijenička cesta",),
    ("Aleja Hermanna Bolléa",),
    ("Mirogojska cesta",),
    ("Gupčeva zvijezda",),
    ("Ulica Antuna Vrančića",),
    ("Mlinarska cesta",),
    ("Jurjevska ulica",),
    ("Ilirski trg",),
    ("Opatička ulica",),
    ("Demetrova ulica",),
    ("Mesnička ulica",),
    ("Ilica",),
    ("Britanski trg",),
    ("Ilica",),
]
#: Lorries over this (t) may not drive into the zone (article 4).
ZONE_TONNES = 12.0
#: Streets of these names further than this (m) from the scene's origin, on Trg bana Josipa
#: Jelačića, are other places' (Nova cesta, Ilica).
ZONE_REACH = 4_000.0
#: Ways that are no street for traffic: their names are left out of the boundary.
NOT_STREETS = {
    "footway",
    "path",
    "steps",
    "cycleway",
    "pedestrian",
    "proposed",
    "construction",
    "platform",
    "corridor",
}
#: The zone's boundary simplified to within this (m).
ZONE_TOLERANCE = 2.0

ORDER_URL = (
    "https://zagreb.hr/UserDocsImages/promet/Naredba%20o%20uvjetima%20prometovanja%20vozila%20u%20"
    "sredi%C5%A1njem%20dijelu%20Grada%20Zagreba%20i%20pje%C5%A1a%C4%8Dkim%20zonama.pdf"
)


def parse_maxweight(value: str | None) -> float | None:
    """A `maxweight` in tonnes ("5", "7.5", "10 t"), or None if it is none or in other units."""
    if not value:
        return None
    m = re.fullmatch(r"\s*(\d+(?:[.,]\d+)?)\s*(t)?\s*", value)
    if not m:
        return None
    tonnes = float(m.group(1).replace(",", "."))
    return tonnes if tonnes > 0 else None


def way_limit(tags: dict[str, str]) -> float | None:
    """The weight (t) lorries may not exceed on a way, or None if it has no limit."""
    limits = [parse_maxweight(tags.get(k)) for k in ("maxweight", "maxweight:hgv")]
    if tags.get("hgv") in HGV_CLOSED:
        limits.append(HGV_TONNES)
    found = [x for x in limits if x is not None]
    return min(found) if found else None


def zone_names() -> set[str]:
    return {name for names in ZONE_STREETS for name in names}


def read_osm(pbf: Path) -> tuple[dict[int, float], dict[str, list[list[tuple[float, float]]]]]:
    """Ways' limits by way id, and the zone's boundary streets as lines of scene points
    (x, z) by OpenStreetMap name."""
    limits: dict[int, float] = {}
    wanted = zone_names()
    street_ways: list[tuple[str, list[int]]] = []
    for way in osmium.FileProcessor(str(pbf), osmium.osm.WAY):
        tags = way.tags
        if "highway" not in tags:
            continue
        limit = way_limit({k: tags.get(k) for k in ("maxweight", "maxweight:hgv", "hgv")})
        if limit is not None:
            limits[way.id] = limit
        name = tags.get("name")
        if name in wanted and tags.get("highway") not in NOT_STREETS:
            street_ways.append((name, [n.ref for n in way.nodes]))
    needed = {n for _, nodes in street_ways for n in nodes}
    lonlat: dict[int, tuple[float, float]] = {}
    for node in osmium.FileProcessor(str(pbf), osmium.osm.NODE):
        if node.id in needed:
            lonlat[node.id] = (node.location.lon, node.location.lat)
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    streets: dict[str, list[list[tuple[float, float]]]] = {}
    for name, nodes in street_ways:
        pts = [lonlat[n] for n in nodes if n in lonlat]
        if len(pts) < 2:
            continue
        e, n = to_crs.transform([p[0] for p in pts], [p[1] for p in pts])
        line = [(float(x) - ORIGIN_E, ORIGIN_N - float(y)) for x, y in zip(e, n, strict=True)]
        if min(np.hypot(*p) for p in line) <= ZONE_REACH:
            streets.setdefault(name, []).append(line)
    return limits, streets


class Street:
    """A boundary street's ways as a graph of their points."""

    def __init__(self, lines: list[list[tuple[float, float]]]):
        index: dict[tuple[float, float], int] = {}
        self.points: list[tuple[float, float]] = []
        self.next: list[list[tuple[int, float]]] = []
        for line in lines:
            ids = []
            for p in line:
                key = (round(p[0], 2), round(p[1], 2))
                if key not in index:
                    index[key] = len(self.points)
                    self.points.append(p)
                    self.next.append([])
                ids.append(index[key])
            for a, b in zip(ids, ids[1:], strict=False):
                d = float(np.hypot(*np.subtract(self.points[a], self.points[b])))
                self.next[a].append((b, d))
                self.next[b].append((a, d))
        self.xy = np.asarray(self.points)

    def path(self, a: int, b: int) -> list[tuple[float, float]]:
        """The shortest way along the street from point a to point b (straight across if
        its ways do not join them)."""
        dist = {a: 0.0}
        back: dict[int, int] = {}
        heap = [(0.0, a)]
        while heap:
            d, u = heapq.heappop(heap)
            if u == b:
                break
            if d > dist[u]:
                continue
            for v, w in self.next[u]:
                if d + w < dist.get(v, float("inf")):
                    dist[v] = d + w
                    back[v] = u
                    heapq.heappush(heap, (d + w, v))
        if b not in dist:
            return [self.points[a], self.points[b]]
        out = [b]
        while out[-1] != a:
            out.append(back[out[-1]])
        return [self.points[i] for i in reversed(out)]


def meeting(s: Street, t: Street) -> tuple[int, int]:
    """Where two streets meet: the closest pair of their points."""
    d = np.hypot(s.xy[:, None, 0] - t.xy[None, :, 0], s.xy[:, None, 1] - t.xy[None, :, 1])
    i, j = np.unravel_index(int(np.argmin(d)), d.shape)
    return int(i), int(j)


def trace_zone(streets: dict[str, list[list[tuple[float, float]]]]) -> list[tuple[float, float]]:
    """The central zone's boundary, along the streets of `ZONE_STREETS` in turn (those not
    mapped are left out, their neighbours meeting directly)."""
    ring = []
    for names in ZONE_STREETS:
        lines = [line for name in names for line in streets.get(name, [])]
        if lines:
            ring.append((names[0], Street(lines)))
        else:
            log.warning("central zone: %s not found", names[0])
    if len(ring) < 3:
        return []
    out: list[tuple[float, float]] = []
    n = len(ring)
    for k in range(n):
        _, here = ring[k]
        start = meeting(ring[k - 1][1], here)[1]
        end = meeting(here, ring[(k + 1) % n][1])[0]
        out.extend(here.path(start, end))
    polygon = shapely.make_valid(shapely.Polygon(out))
    if polygon.geom_type != "Polygon":
        polygon = max(getattr(polygon, "geoms", [polygon]), key=lambda g: g.area)
    polygon = polygon.simplify(ZONE_TOLERANCE)
    return [(round(x, 1), round(z, 1)) for x, z in polygon.exterior.coords[:-1]]


def lorry_rules(pbf: Path) -> dict:
    """Ways' limits and the central zone, cached per OpenStreetMap extract."""
    cache = CACHE_DIR / "network" / f"lorries_{pbf.name.split('.')[0]}_{VERSION}.json"
    if cache.exists() and cache.stat().st_mtime >= pbf.stat().st_mtime:
        return json.loads(cache.read_text())
    limits, streets = read_osm(pbf)
    zone = trace_zone(streets)
    rules = {"limits": {str(k): v for k, v in limits.items()}, "zone": zone}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(rules))
    return rules


def edge_max_weight(origins: list[str], limits: dict[str, float]) -> np.ndarray:
    """Per edge, the lowest limit (0.1 t; 0: none) of the ways it was built from, given
    each edge's `origId` (way ids, space-separated; empty for junction lanes)."""
    out = np.zeros(len(origins), np.uint16)
    for e, ids in enumerate(origins):
        found = [limits[w.lstrip("-")] for w in ids.split() if w.lstrip("-") in limits]
        if found:
            out[e] = min(65535, max(1, round(10 * min(found))))
    return out


def zone_area(zone: list[tuple[float, float]]) -> float:
    """The zone's area (km²)."""
    return shapely.Polygon(zone).area / 1e6 if len(zone) >= 3 else 0.0
