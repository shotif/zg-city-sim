"""Hrvatske ceste count tables: the stations in and around the map, placed on their roads,
with their hourly profiles.

    python -I -c "import sys; sys.path.insert(0, '.'); from pipeline import hc; hc.main()"

(`-I` keeps the downloads off Python's import path; the line puts the repository back.)

This downloads the 2025 tables (the CSV of 914 stations and the 911-page PDF, about 80 MB)
into pipeline/.cache/hc/ and an OpenStreetMap extract reaching about 20 km beyond the map,
then writes pipeline/data/hc_counts_2025.json, which pipeline/counts.py reads. It is not
part of `python -m pipeline all`: the result is committed, so CI needs neither the PDF nor
the tools that read it (pdfplumber, `pip install pdfplumber`, and pdftotext from
poppler-utils).

**Placing a station.** The tables give no coordinates. Each station counts a section of its
road between two junctions, named by the other road's number (Ž3036, D29, A3), by a
motorway interchange (čv. Lučko) or by a place. OpenStreetMap tags Croatian roads with the
same numbers (state roads "D1", county roads "3036", local roads "31102"), so the section
is found on the road between the junctions with those roads, as the pair of junctions
whose distance along the road best matches the section's length in the tables. The station
sits where the place it is named after projects onto the section, else halfway along it.

**Hourly profiles.** Chapter 7 of the PDF has a page of charts for each station counted
continuously all year. The average traffic in each hour of the day (chart 3) and on each
day of the week (chart 4) are drawn as vectors with value axes; they are read from the
drawing and scaled by the axis labels. The annual hourly line sums to the station's PGDP
within about 1 %, which checks the reading (`check` in the output).
"""

from __future__ import annotations

import csv
import heapq
import io
import json
import logging
import re
import shutil
import subprocess
import unicodedata
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import osmium
import shapely
from pyproj import Transformer
from scipy.spatial import cKDTree

from .config import CACHE_DIR, CRS, PIPELINE_DIR
from .osm import box_polygon, fetch_osm, world_polygon

log = logging.getLogger(__name__)

PAGE = "https://hrvatske-ceste.hr/hr/stranice/promet-i-sigurnost/dokumenti/14-brojenje-prometa"
FILES = "https://hrvatske-ceste.hr/uploads/documents/attachment_file/file"
CSV_URL = f"{FILES}/2016/Promet_na_cestama_Republike_Hrvatske_2025.csv"
PDF_URL = f"{FILES}/2010/Brojenje_prometa_na_cestama_Republike_Hrvatske_godine_2025.pdf"
OUT = PIPELINE_DIR / "data" / "hc_counts_2025.json"

# Stations are placed this far around the map (degrees): far enough to find the counted
# section of every road where it crosses the map's edge.
AROUND_LON = 0.25
AROUND_LAT = 0.18
DRIVABLE = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
    "road",
}
PLACES = {
    "city",
    "town",
    "village",
    "hamlet",
    "suburb",
    "quarter",
    "neighbourhood",
    "locality",
    "isolated_dwelling",
}
# A road passing within this distance (m) of another road's nodes meets it there.
CROSSING_GAP = 120.0
# A road meets a motorway at an interchange within this distance (m) of it: the ramps.
INTERCHANGE_GAP = 500.0
# Pieces of one road this close (m) are joined (gaps in its numbering).
GAP_BRIDGE = 150.0
# An interchange or place names a junction on the road within this distance (m).
NAMED_JUNCTION_GAP = 2_500.0
# The station's own place, if this close (m) to its section, positions it on the section.
NAMED_STATION_GAP = 3_000.0
# Section ends written as names in the tables, as OpenStreetMap names them.
ALIASES = {
    "zr. luka": "Zračna luka Franjo Tuđman",
    "V. Mlaka": "Velika Mlaka",
    "V. Gorica": "Velika Gorica",
    "gr. Slovenije": "Bregana",
}
# Ends the tables leave unnamed (G.A.P. is an administrative boundary).
UNKNOWN_ENDS = {"G.A.P.", "G.A.P", "GP", ". . ."}
# Chart colours (pdfplumber's stroking/non-stroking colours).
SERIES = {"summer": (1.0, 0.0, 0.0), "year": (0.0, 0.0, 0.0), "rest": (0.0, 0.8, 1.0)}

ATTRIBUTION = {
    "name": "Hrvatske ceste, Brojenje prometa 2025",
    "text": "Traffic counts: Hrvatske ceste d.o.o., Brojenje prometa na cestama Republike "
    "Hrvatske godine 2025 (PGDP, average annual daily traffic; hourly profiles read from the "
    "publication's charts). Stations placed on OpenStreetMap roads by zg-city-sim.",
    "url": PAGE,
}


# --- The table ----------------------------------------------------------------------------


@dataclass
class Row:
    id: int
    name: str
    road: str | None  # OpenStreetMap ref, None for unnumbered roads
    table_road: str
    pgdp: int
    pldp: int | None
    method: str
    start: str
    end: str
    length_km: float


def osm_ref(code: str) -> str | None:
    """OpenStreetMap ref of a road number as the tables write it: "A3" and "D1" stay,
    a bare number of up to three digits is a state road ("1" -> "D1"), county and local
    roads are plain numbers ("Ž3063" -> "3063", "L31102" -> "31102")."""
    m = re.fullmatch(r"(A|D|DC|Ž|ŽC|L|LC)?\s*(\d+)", code.strip())
    if not m:
        return None
    prefix, number = m.groups()
    if prefix == "A":
        return "A" + number
    if prefix in ("D", "DC") or (prefix is None and len(number) <= 3):
        return "D" + number
    return number


def number(text: str) -> float | None:
    text = text.strip().replace(".", "").replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def read_table(path: Path) -> list[Row]:
    text = path.read_bytes().decode("cp1250")
    rows = []
    for rec in csv.reader(io.StringIO(text), delimiter=";"):
        if len(rec) < 9 or not rec[1].strip().isdigit():
            continue
        pgdp = number(rec[3])
        if pgdp is None:
            continue
        pldp = number(rec[4])
        rows.append(
            Row(
                id=int(rec[1]),
                name=rec[2].strip(),
                road=osm_ref(rec[0]),
                table_road=rec[0].strip(),
                pgdp=int(pgdp),
                pldp=int(pldp) if pldp is not None else None,
                method=rec[5].strip(),
                start=rec[6].strip(),
                end=rec[7].strip(),
                length_km=number(rec[8]) or 0.0,
            )
        )
    return rows


# --- Roads around the map ------------------------------------------------------------------


def fold(name: str) -> str:
    """Name for matching: lower case, no diacritics, no punctuation."""
    name = unicodedata.normalize("NFKD", name.casefold())
    name = "".join(c for c in name if not unicodedata.combining(c))
    name = name.replace("đ", "d")
    return re.sub(r"[^a-z0-9]+", " ", name).strip()


@dataclass
class Roads:
    """Numbered roads around the map as graphs, with named points (metres, EPSG:3765)."""

    pos: dict[int, tuple[float, float]] = field(default_factory=dict)
    #: ref -> node -> [(neighbour, metres)]
    graph: dict[str, dict[int, list[tuple[int, float]]]] = field(default_factory=dict)
    #: folded name -> points, for motorway interchanges and for places
    interchanges: dict[str, list[tuple[float, float]]] = field(default_factory=dict)
    places: dict[str, list[tuple[float, float]]] = field(default_factory=dict)
    _trees: dict[str, tuple[cKDTree, list[int]]] = field(default_factory=dict)

    def tree(self, ref: str) -> tuple[cKDTree, list[int]]:
        if ref not in self._trees:
            nodes = list(self.graph[ref])
            self._trees[ref] = (cKDTree([self.pos[n] for n in nodes]), nodes)
        return self._trees[ref]


def read_roads(pbf: Path) -> Roads:
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    roads = Roads()
    ways: list[tuple[list[str], list[int]]] = []
    lonlat: dict[int, tuple[float, float]] = {}
    for obj in osmium.FileProcessor(str(pbf)).with_locations():
        tags = obj.tags
        if obj.is_node():
            name = tags.get("name")
            if not name:
                continue
            point = (obj.location.lon, obj.location.lat)
            if tags.get("highway") == "motorway_junction":
                roads.interchanges.setdefault(fold(name), []).append(point)
            elif tags.get("place") in PLACES or tags.get("aeroway") == "aerodrome":
                roads.places.setdefault(fold(name), []).append(point)
        elif obj.is_way():
            if tags.get("aeroway") == "aerodrome" and tags.get("name"):
                pts = [(n.location.lon, n.location.lat) for n in obj.nodes if n.location.valid()]
                if pts:
                    centre = tuple(float(v) for v in np.mean(pts, axis=0))
                    roads.places.setdefault(fold(tags["name"]), []).append(centre)
            if tags.get("highway") not in DRIVABLE or not tags.get("ref"):
                continue
            refs = [r.strip().replace(" ", "") for r in tags["ref"].split(";") if r.strip()]
            nodes = [n.ref for n in obj.nodes if n.location.valid()]
            for n in obj.nodes:
                if n.location.valid():
                    lonlat[n.ref] = (n.location.lon, n.location.lat)
            ways.append((refs, nodes))
    ids = list(lonlat)
    e, n = to_crs.transform([lonlat[i][0] for i in ids], [lonlat[i][1] for i in ids])
    roads.pos = {i: (float(a), float(b)) for i, a, b in zip(ids, e, n, strict=True)}
    for refs, nodes in ways:
        for a, b in zip(nodes, nodes[1:], strict=False):
            pa, pb = roads.pos[a], roads.pos[b]
            d = float(np.hypot(pa[0] - pb[0], pa[1] - pb[1]))
            for ref in refs:
                g = roads.graph.setdefault(ref, defaultdict(list))
                g[a].append((b, d))
                g[b].append((a, d))
    for named in (roads.interchanges, roads.places):
        for key, points in named.items():
            px, py = to_crs.transform([p[0] for p in points], [p[1] for p in points])
            named[key] = [(float(a), float(b)) for a, b in zip(px, py, strict=True)]
    for graph in roads.graph.values():
        bridge_gaps(graph, roads.pos)
    return roads


def bridge_gaps(graph: dict[int, list[tuple[int, float]]], pos: dict) -> None:
    """Join the pieces of a road that OpenStreetMap leaves unnumbered for a few metres (often
    a roundabout): each piece to the nearest other piece within GAP_BRIDGE."""
    piece: dict[int, int] = {}
    for start in graph:
        if start in piece:
            continue
        piece[start] = start
        stack = [start]
        while stack:
            u = stack.pop()
            for v, _ in graph[u]:
                if v not in piece:
                    piece[v] = start
                    stack.append(v)
    roots = sorted(set(piece.values()))
    if len(roots) < 2:
        return
    nodes = list(graph)
    tree = cKDTree([pos[n] for n in nodes])
    for i, j in sorted(tree.query_pairs(GAP_BRIDGE)):
        a, b = nodes[i], nodes[j]
        if piece[a] != piece[b]:
            d = _dist(pos[a], pos[b])
            graph[a].append((b, d))
            graph[b].append((a, d))


def dijkstra(graph: dict[int, list[tuple[int, float]]], source: int, limit: float):
    dist = {source: 0.0}
    prev: dict[int, int] = {}
    heap = [(0.0, source)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist.get(u, float("inf")) or d > limit:
            continue
        for v, w in graph.get(u, ()):
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))
    return dist, prev


def path_to(prev: dict[int, int], source: int, target: int) -> list[int]:
    out = [target]
    while out[-1] != source:
        out.append(prev[out[-1]])
    return out[::-1]


def cluster(nodes: list[int], roads: Roads, gap: float = 300.0) -> list[int]:
    """One node per group of nearby candidate nodes (a junction's nodes, both carriageways)."""
    kept: list[int] = []
    for n in nodes:
        p = roads.pos[n]
        if all(np.hypot(p[0] - roads.pos[k][0], p[1] - roads.pos[k][1]) > gap for k in kept):
            kept.append(n)
    return kept


def junctions(roads: Roads, road: str, end: str) -> tuple[list[int], str]:
    """Nodes of `road` where the section end `end` is, and how they were found."""
    if end in UNKNOWN_ENDS:
        return [], "not named"
    other = osm_ref(end) if re.fullmatch(r"(A|D|DC|Ž|ŽC|L|LC)\s*\d+|\d{4,5}", end) else None
    if other is not None:
        if other not in roads.graph or other == road:
            return [], f"road {other} not found"
        # Shared nodes, or nodes within CROSSING_GAP (a roundabout between, or an interchange).
        graph = roads.graph[road]
        shared = [n for n in roads.graph[other] if n in graph]
        tree, nodes = roads.tree(road)
        other_tree, _ = roads.tree(other)
        gap = INTERCHANGE_GAP if other.startswith("A") else CROSSING_GAP
        near = {nodes[i] for group in other_tree.query_ball_tree(tree, gap) for i in group}
        return cluster(shared + sorted(near - set(shared)), roads), f"junction with {end}"
    name = ALIASES.get(end, end)
    is_interchange = name.startswith("čv.") or road.startswith("A")
    name = name.removeprefix("čv.").strip()
    points = named_points(roads.interchanges, name) if is_interchange else []
    points = points or named_points(roads.places, name)
    if not points:
        return [], f"{end} not found"
    tree, nodes = roads.tree(road)
    found = []
    for p in points:
        d, i = tree.query(p)
        if d < NAMED_JUNCTION_GAP:
            found.append(nodes[int(i)])
    return cluster(found, roads), ("interchange " if is_interchange else "") + name


def name_words(name: str) -> set[str]:
    """Words of a folded name, with "sv", "sveti", "sveta" as one."""
    return {
        ("sv" if w in ("sv", "sveti", "sveta", "svete") else w)
        for w in fold(name.replace("(", " ").replace(")", " ")).split()
    }


def named_points(named: dict[str, list], name: str) -> list[tuple[float, float]]:
    """Points named `name`: exactly, else whose name takes in all of its words
    ("Zdenčina" is OpenStreetMap's "Donja Zdenčina")."""
    if fold(name) in named:
        return named[fold(name)]
    words = name_words(name)
    return [p for key, pts in named.items() if words <= name_words(key) for p in pts]


def station_place(row: Row) -> str:
    """The place a station is named after: "Zaprešić - istok" -> "Zaprešić"."""
    name = row.name.split(" - ")[0]
    name = re.sub(r"\b(obilaznica|sj\. obilaz\.|centar)\b", "", name).strip()
    return ALIASES.get(name, name)


@dataclass
class Placed:
    row: Row
    path: list[tuple[float, float]]
    at: tuple[float, float]
    how: str
    #: Street names of an unnumbered road.
    road_names: list[str] | None = None


# Stations placed by hand: the tables give no road number.
MANUAL = {
    2014: {
        "at": (16.0510, 45.7221),
        "road_names": ["Zagrebačka cesta", "Zagrebačka ulica"],
        "placed": "by hand: the old road from Zagreb to Velika Gorica (Zagrebačka cesta, "
        "no road number) between Velika Mlaka and Velika Gorica",
    },
}


def place(roads: Roads, row: Row) -> Placed | None:
    """The counted section of the station's road and the station's point on it."""
    if row.road is None or row.road not in roads.graph:
        return None
    graph = roads.graph[row.road]
    a_nodes, a_how = junctions(roads, row.road, row.start)
    b_nodes, b_how = junctions(roads, row.road, row.end)
    length = row.length_km * 1000.0
    best = None
    if a_nodes and b_nodes:
        for a in a_nodes:
            dist, prev = dijkstra(graph, a, max(3 * length, length + 5_000))
            for b in b_nodes:
                if b in dist and b != a:
                    miss = abs(dist[b] - length)
                    if best is None or miss < best[0]:
                        best = (miss, path_to(prev, a, b))
        how = f"between {a_how} and {b_how}"
    elif a_nodes or b_nodes:
        # One end only: the section runs its length from there towards the station's place.
        target = places_near(roads, station_place(row))
        if target is None:
            return None
        for a in a_nodes or b_nodes:
            dist, prev = dijkstra(graph, a, length * 1.15)
            ends = [n for n, d in dist.items() if length * 0.85 <= d <= length * 1.15]
            if not ends:
                continue
            end = min(ends, key=lambda n: min(_dist(roads.pos[n], t) for t in target))
            score = min(_dist(roads.pos[end], t) for t in target)
            if best is None or score < best[0]:
                best = (score, path_to(prev, a, end))
        how = (
            f"{row.length_km:g} km from {a_how if a_nodes else b_how} towards {station_place(row)}"
        )
    if best is None:
        return None
    line = shapely.LineString([roads.pos[n] for n in best[1]])
    if line.length < 1.0 or abs(line.length - length) > max(1_500.0, 0.5 * length):
        return None
    # A station far from the place it is named after is a section of the same road
    # numbers elsewhere. (Toll counts are named after interchanges, matched already.)
    named = places_near(roads, station_place(row)) if row.method != "NB" else None
    if named and min(line.distance(shapely.Point(t)) for t in named) > 10_000:
        return None
    at = line.interpolate(0.5, normalized=True)
    where = "halfway"
    # Toll counts cover the whole section between interchanges: halfway is as good as any.
    target = places_near(roads, station_place(row)) if row.method != "NB" else None
    if target:
        p = min(target, key=lambda t: line.distance(shapely.Point(t)))
        if line.distance(shapely.Point(p)) < NAMED_STATION_GAP:
            s = line.project(shapely.Point(p), normalized=True)
            at = line.interpolate(min(max(s, 0.15), 0.85), normalized=True)
            where = f"at {station_place(row)}"
    how += f", {line.length / 1000:.1f} km along {row.road} (tables: {row.length_km:g} km), {where}"
    coords = list(line.simplify(20.0).coords)
    return Placed(row, coords, (at.x, at.y), how)


def places_near(roads: Roads, name: str) -> list[tuple[float, float]] | None:
    return named_points(roads.places, name) or None


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return float(np.hypot(a[0] - b[0], a[1] - b[1]))


# --- Charts in the PDF ---------------------------------------------------------------------


def chart_pages(pdf: Path) -> dict[int, int]:
    """Page index of each station's chart page in chapter 7, by station id."""
    text = subprocess.run(
        ["pdftotext", "-layout", str(pdf), "-"], check=True, capture_output=True
    ).stdout.decode("utf-8", "replace")
    pages = {}
    for i, page in enumerate(text.split("\f")):
        m = re.search(r"^\s*AB (\d+), .*$", page, re.MULTILINE)
        if m and "SATNI PROMET" in page:
            pages.setdefault(int(m.group(1)), i)
    return pages


def colour(c) -> tuple[float, ...] | None:
    if c is None:
        return None
    if isinstance(c, (int, float)):
        return (float(c),) * 3
    c = tuple(float(v) for v in c)
    return c * 3 if len(c) == 1 else c


def same(a, b) -> bool:
    return (
        a is not None and len(a) == 3 and all(abs(x - y) < 0.02 for x, y in zip(a, b, strict=True))
    )


def evenly_spaced(grid: list[float], values: tuple[float, float]) -> list[float]:
    """The run of evenly spaced gridlines that takes in the plotted `values` (other charts'
    gridlines can line up with this one's)."""
    runs: list[list[float]] = []
    for g in grid:
        run = runs[-1] if runs else None
        if run and (len(run) == 1 or abs((g - run[-1]) - (run[-1] - run[-2])) < 0.6):
            run.append(g)
        else:
            runs.append([run[-1], g] if run and len(run) == 1 else [g])
    mid = (values[0] + values[1]) / 2
    runs = [r for r in runs if len(r) >= 3 and r[0] - 1 <= mid <= r[-1] + 1]
    return max(runs, key=len) if runs else []


def axis_fit(page, along: int, lo: float, hi: float, values: tuple[float, float]):
    """Linear map from page coordinate `along` (0 = x, 1 = y) to value, from the chart's
    gridlines across [lo, hi] (the other coordinate's span) and the numbers labelling
    them. `values` is the span of the plotted values along the value axis."""
    near = (values[0] - 200, values[1] + 200)
    other = 1 - along
    keys = (("x0", "x1"), ("top", "bottom"))
    lines = []
    for line in page.lines:
        a0, a1 = line[keys[along][0]], line[keys[along][1]]
        b0, b1 = line[keys[other][0]], line[keys[other][1]]
        if abs(a1 - a0) <= 0.5 and near[0] <= a0 <= near[1] and b0 <= lo + 5 and b1 >= hi - 5:
            lines.append(a0)
    lines.sort()
    grid = evenly_spaced(
        [g for i, g in enumerate(lines) if i == 0 or g - lines[i - 1] > 0.3], values
    )
    labels: list[tuple[float, str]] = []
    for g in grid:
        best = None
        for w in page.extract_words():
            if not re.fullmatch(r"\d+", w["text"]):
                continue
            centre = (w[keys[along][0]] + w[keys[along][1]]) / 2
            # Axis labels sit just outside the plot, beyond either end of the other axis.
            start, end = w[keys[other][0]], w[keys[other][1]]
            beyond = start - hi if start >= hi - 1 else lo - end if end <= lo + 1 else 99.0
            if abs(centre - g) < 2.5 and -1 <= beyond < 25 and (best is None or beyond < best[0]):
                best = (beyond, w["text"])
        if best:
            labels.append((g, best[1]))
    if len(labels) < 3:
        return None
    # Rotated labels can come out reversed ("0051" for 1500). Either reading may fit a
    # straight line ("02", "04" ...), so both are returned for the caller to choose.
    xs = np.array([g for g, _ in labels])
    fits = []
    for flip in (False, True):
        vs = np.array([float(t[::-1] if flip else t) for _, t in labels])
        b, a = np.polyfit(xs, vs, 1)
        if float(np.abs(a + b * xs - vs).max()) < 0.01 * max(float(np.ptp(vs)), 1.0):
            fits.append((float(a), float(b)))
    return fits


def closest(fits: list[tuple[float, float]], coords: np.ndarray, mean: float):
    """The axis reading whose values average nearest to `mean` (by ratio)."""
    if not fits:
        return None
    return min(
        fits, key=lambda f: abs(np.log(max(float(np.mean(f[0] + f[1] * coords)), 1e-3) / mean))
    )


def read_charts(page, pgdp: int) -> dict | None:
    """Average hourly traffic per hour of the day and per day of the week (both directions),
    for the year, the summer (July, August) and the rest of the year. The annual values
    average about PGDP / 24, which settles how the axis labels read."""
    curves = [c for c in page.curves if len(c["pts"]) == 24]
    hourly: dict[str, list[float]] = {}
    for c in curves:
        col = colour(c.get("stroking_color"))
        pts = np.array(c["pts"], float)
        steps = np.abs(np.diff(pts, axis=0))
        along_hours = 0 if steps[:, 0].std() < steps[:, 1].std() and steps[:, 0].mean() > 1 else 1
        value_axis = 1 - along_hours
        lo, hi = pts[:, along_hours].min(), pts[:, along_hours].max()
        span = (pts[:, value_axis].min(), pts[:, value_axis].max())
        fit = closest(axis_fit(page, value_axis, lo, hi, span), pts[:, value_axis], pgdp / 24)
        if fit is None:
            continue
        a, b = fit
        for name, ref in SERIES.items():
            if same(col, ref):
                hourly[name] = [round(float(a + b * v), 1) for v in pts[:, value_axis]]
    if "year" not in hourly:
        return None
    weekly = read_weekdays(page, pgdp)
    return {"hourly": hourly, "weekday": weekly}


def read_weekdays(page, pgdp: int) -> dict[str, list[float]] | None:
    """Chart 4: average hourly traffic on each day of the week, three bars per day."""
    found: dict[tuple, tuple[str, dict]] = {}
    for r in page.rects:
        col = colour(r.get("non_stroking_color"))
        for name, ref in SERIES.items():
            if same(col, ref) and r["width"] > 1 and r["height"] > 1:
                key = tuple(round(r[k], 1) for k in ("x0", "x1", "top", "bottom"))
                found[key] = (name, r)
    # The bars stand on a common baseline: the edge coordinate most of them share.
    edges: dict[tuple[str, float], int] = defaultdict(int)
    for key in found:
        for k, v in zip(("x0", "x1", "top", "bottom"), key, strict=True):
            edges[(k, v)] += 1
    if not edges:
        return None
    (side, base), count = max(edges.items(), key=lambda kv: kv[1])
    if count < 21:
        return None
    bars = [(name, r) for key, (name, r) in found.items() if round(r[side], 1) == base]
    if len(bars) != 21:
        return None
    along = 0 if side in ("x0", "x1") else 1
    tip_key = {"x0": "x1", "x1": "x0", "top": "bottom", "bottom": "top"}[side]
    tips = np.array([r[tip_key] for _, r in bars])
    cross = ("top", "bottom") if along == 0 else ("x0", "x1")
    mids = np.array([(r[cross[0]] + r[cross[1]]) / 2 for _, r in bars])
    lo = min(r[cross[0]] for _, r in bars)
    hi = max(r[cross[1]] for _, r in bars)
    span = (min(base, tips.min()), max(base, tips.max()))
    fit = closest(axis_fit(page, along, lo, hi, span), tips, pgdp / 24)
    if fit is None:
        return None
    a, b = fit
    out: dict[str, list[float]] = {k: [] for k in SERIES}
    for k in np.argsort(mids):
        out[bars[k][0]].append(round(float(a + b * tips[k]), 1))
    if any(len(v) != 7 for v in out.values()):
        return None
    # Monday first: find which end the day labels PON. (Monday) and NED. (Sunday) are at.
    words = page.extract_words()
    key = cross[0]

    def at(names: tuple[str, ...]) -> float | None:
        hits = [
            w
            for w in words
            if fold(w["text"]) in names
            and lo - 20 <= w[key] <= hi + 20
            and abs(w[("x0", "top")[along]] - base) < 30
        ]
        return min(hits, key=lambda w: abs(w[key] - (lo + hi) / 2))[key] if hits else None

    mon, sun = at(("pon", "nop")), at(("ned", "den"))
    if mon is not None and sun is not None and mon > sun:
        out = {k: v[::-1] for k, v in out.items()}
    return out


# --- Main ------------------------------------------------------------------------------


def download(url: str, dest: Path) -> Path:
    """A plain download (the site refuses some clients; this one it accepts for files)."""
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "zg-city-sim pipeline"})
    tmp = dest.with_name(dest.name + ".partial")
    with urllib.request.urlopen(req, timeout=300) as response, tmp.open("wb") as f:
        shutil.copyfileobj(response, f)
    tmp.rename(dest)
    log.info("downloaded %s (%.1f MB)", url, dest.stat().st_size / 1e6)
    return dest


def around_polygon() -> dict:
    ring = world_polygon()["coordinates"][0]
    west, south = ring[0]
    east, north = ring[2]
    return box_polygon(west - AROUND_LON, south - AROUND_LAT, east + AROUND_LON, north + AROUND_LAT)


def main() -> None:
    import pdfplumber

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cache = CACHE_DIR / "hc"
    table = read_table(download(CSV_URL, cache / "counts_2025.csv"))
    pdf_path = download(PDF_URL, cache / "counts_2025.pdf")
    roads = read_roads(fetch_osm(polygon=around_polygon(), name="around"))
    log.info(
        "%d stations in the tables, %d numbered roads around the map", len(table), len(roads.graph)
    )

    to_lonlat = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    ring = np.asarray(world_polygon()["coordinates"][0])
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    map_area = shapely.Polygon(np.column_stack(to_crs.transform(ring[:, 0], ring[:, 1])))

    placed = [p for row in table if (p := place(roads, row)) is not None]
    for row in table:
        if row.id in MANUAL:
            spec = MANUAL[row.id]
            at = to_crs.transform(*spec["at"])
            placed.append(Placed(row, [at, at], at, spec["placed"], spec["road_names"]))
    log.info("placed %d stations", len(placed))
    pages = chart_pages(pdf_path)
    stations = []
    with pdfplumber.open(pdf_path) as pdf:
        for p in sorted(placed, key=lambda p: p.row.id):
            row = p.row
            lon, lat = to_lonlat.transform(*p.at)
            line = np.array(p.path)
            path_ll = np.column_stack(to_lonlat.transform(line[:, 0], line[:, 1]))
            entry = {
                "id": row.id,
                "name": row.name,
                "road": row.road,
                **({"road_names": p.road_names} if p.road_names else {}),
                "pgdp": row.pgdp,
                "pldp": row.pldp,
                "method": row.method,
                "section": [row.start, row.end],
                "length_km": row.length_km,
                "at": [round(lon, 5), round(lat, 5)],
                "inside": bool(map_area.contains(shapely.Point(p.at))),
                "placed": p.how,
                "path": [[round(float(x), 5), round(float(y), 5)] for x, y in path_ll],
            }
            if row.id in pages:
                charts = read_charts(pdf.pages[pages[row.id]], row.pgdp)
                if charts:
                    total = sum(charts["hourly"]["year"])
                    charts["check"] = round(total / row.pgdp, 3)
                    if abs(total / row.pgdp - 1) > 0.03:
                        log.warning(
                            "%d %s: hourly line sums to %.0f, PGDP %d",
                            row.id,
                            row.name,
                            total,
                            row.pgdp,
                        )
                    entry.update(charts)
                else:
                    log.warning("%d %s: charts not read", row.id, row.name)
            stations.append(entry)
    out = {
        "source": ATTRIBUTION,
        "notes": "PGDP: average annual daily traffic, both directions. PLDP: average daily "
        "traffic in July and August. Method: NAB continuous automatic count, PAB periodic "
        "automatic count, NB toll count. hourly: average vehicles per hour in each hour of "
        "the day (00-01 first), over the year, the summer and the rest of the year. weekday: "
        "average vehicles per hour on each day of the week, Monday first. at, path: the "
        "station and its counted section, placed by zg-city-sim (see pipeline/hc.py).",
        "stations": stations,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    inside = sum(s["inside"] for s in stations)
    charts = sum("hourly" in s for s in stations)
    log.info(
        "wrote %s: %d stations (%d inside the map, %d with hourly profiles)",
        OUT,
        len(stations),
        inside,
        charts,
    )


if __name__ == "__main__":
    main()
