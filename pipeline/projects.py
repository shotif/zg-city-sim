"""Planned road projects (M4c): each built into a road network of its own, for the app to
run in place of today's and compare with it.

A project is a patch over OpenStreetMap. Most of Zagreb's planned roads are already mapped
as `highway=proposed` or `highway=construction`; the patch brings those ways into service
with the tags they will have, carries their ends across the roads they will meet, makes a
junction wherever they cross a named road at grade, puts signals at the junctions the
project names, and lifts the parts over the Sava (or over a road) onto bridges. netconvert
builds the patched map with today's options, and demand, the timetable and the news are
placed on the result (`web/public/data/projects/<id>/`).

Edge ids differ from today's network, so the roads a project adds are found by shape: the
edges of its network that no edge of today's runs along.

Before and after numbers for each project come from `sim/examples/compare.rs`, run natively
over the morning peak, and are kept in `pipeline/data/projects/<id>.json`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np
import osmium
from scipy.spatial import cKDTree

from .config import CACHE_DIR, OUTPUT_DIR, PIPELINE_DIR
from .demand import build_demand
from .network import (
    NETCONVERT_OPTIONS,
    ROADS_VERSION,
    export_network,
    filter_roads,
    run_netconvert,
    wanted_way,
)
from .news import build_news
from .osm import ATTRIBUTION as OSM_ATTRIBUTION
from .osm import fetch_osm
from .packed import read_packed
from .transit import build_transit

log = logging.getLogger(__name__)

COMPARISONS = PIPELINE_DIR / "data" / "projects"
# Ids of the nodes and ways a patch adds, above any OpenStreetMap id.
NEW_ID = 1 << 40
# A crossing this close (m) to a node of the crossed way uses that node.
SNAP = 3.0
METRES_PER_DEGREE = 111_320.0


@dataclass(frozen=True)
class Extend:
    """Carry a way's end on along its last segment, across the roads named `road` within
    `reach` metres, with a junction at each crossing (both carriageways of a dual one)."""

    way: int
    end: str  # "start" or "end"
    road: str
    reach: float = 60.0


@dataclass(frozen=True)
class Bridge:
    """The part of a way `length` metres long centred where it passes `at` (lon, lat) is a
    bridge: over the Sava, or over a road it no longer meets (`Project.over`)."""

    way: int
    at: tuple[float, float]
    length: float
    name: str = ""


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    #: Where the project stands, as of the sources.
    status: str
    summary: str
    #: (title, url) of the reports the project is modelled on.
    sources: tuple[tuple[str, str], ...]
    #: OpenStreetMap ways the project opens, with the tags they get (replacing
    #: highway=proposed or construction and the proposed or construction class).
    ways: dict[int, dict[str, str]]
    extend: tuple[Extend, ...] = ()
    #: Named roads the project's ways cross at grade.
    cross: tuple[str, ...] = ()
    #: Named roads the project's ways pass over: junctions with them are taken out.
    over: tuple[str, ...] = ()
    #: Named roads whose junctions with the project's ways get signals.
    signals: tuple[str, ...] = ()
    bridges: tuple[Bridge, ...] = ()


ARTERIAL = {"oneway": "yes", "lanes": "2", "maxspeed": "50"}

PROJECTS: tuple[Project, ...] = (
    Project(
        id="jarunski-most",
        name="Jarunski most",
        status="Planned: construction from mid-2028, access roads by the end of 2027 "
        "(City of Zagreb, May 2026).",
        summary="A 625 m bridge over the Sava west of Lake Jarun with two lanes each way, "
        "on the corridor OpenStreetMap maps from Zagrebačka avenija past Horvaćanska cesta "
        "to Jadranska avenija in Novi Zagreb, with signals at the three junctions. The City "
        "expects it to take traffic off Jadranski most, Zagrebačka avenija, Horvaćanska and "
        "Savska cesta and the Remetinec roundabout. Its tram line is not simulated yet.",
        sources=(
            (
                "tportal, 5 May 2026: Tomašević predstavlja veliki projekt na zapadu Zagreba",
                "https://www.tportal.hr/vijesti/clanak/tomasevic-predstavlja-veliki-projekt-na-"
                "zapadu-zagreba-otkriva-detalje-izgradnje-jarunskog-mosta-20260505",
            ),
            (
                "Index.hr: Novi most preko Save imat će četiri trake, tramvaj i biciklističke "
                "staze",
                "https://www.index.hr/vijesti/clanak/zagreb-dobiva-novi-most-preko-save-"
                "gradnja-bi-trebala-poceti-2028/2797963.aspx",
            ),
        ),
        ways={934592251: {"highway": "primary", "lanes": "4", "maxspeed": "60"}},
        extend=(
            Extend(934592251, "start", "Zagrebačka avenija"),
            Extend(934592251, "end", "Jadranska avenija"),
        ),
        cross=("Horvaćanska cesta",),
        signals=("Zagrebačka avenija", "Horvaćanska cesta", "Jadranska avenija"),
        bridges=(Bridge(934592251, (15.90800, 45.78080), 625.0, "Jarunski most"),),
    ),
    Project(
        id="sarengradska",
        name="Šarengradska ulica",
        status="Planned: awaiting its building permit; work was announced for 2026, first "
        "from Ulica grada Vukovara to Zagrebačka avenija (City of Zagreb, October 2024).",
        summary="A new four-lane street west of Savska cesta, along the railway from Ulica "
        "grada Vukovara across Zagrebačka avenija to Selska cesta at the north end of "
        "Jadranski most, with signalled junctions: a second way into the centre from "
        "Jadranski most, to take traffic off Savska cesta.",
        sources=(
            (
                "tportal, 25 October 2024: Ključni Tomaševićev projekt čeka se 150 godina",
                "https://www.tportal.hr/vijesti/clanak/kljucni-tomasevicev-projekt-ceka-se-"
                "150-godina-od-prvog-se-dana-prica-necete-vi-tu-dugo-20241025",
            ),
        ),
        ways={
            1337191210: {"highway": "secondary", "name": "Šarengradska ulica", **ARTERIAL},
            1337191211: {"highway": "secondary", "name": "Šarengradska ulica", **ARTERIAL},
        },
        extend=(
            Extend(1337191210, "start", "Ulica grada Vukovara"),
            Extend(1337191211, "end", "Ulica grada Vukovara"),
            Extend(1337191210, "end", "Selska cesta"),
            Extend(1337191211, "start", "Selska cesta"),
        ),
        cross=("Zagrebačka avenija",),
        signals=("Ulica grada Vukovara", "Zagrebačka avenija", "Selska cesta"),
    ),
    Project(
        id="branimirova-sesvete",
        name="Branimirova to Sesvete",
        status="Under construction: the third stage, Ulica Ivana Ančića to Varaždinska cesta "
        "(about 800 m), started in 2025; the second, Brestovečka ulica to Ulica Ivana "
        "Ančića with a bridge over Kašinska cesta, is the last to be built (City of Zagreb).",
        summary="The extended Branimirova ulica, four lanes, carried on from Brestovečka "
        "ulica over Kašinska cesta to Varaždinska cesta in Sesvete, where it ends at a "
        "signalled junction: with the first stage, opened in June 2024, a second road "
        "between Dubrava and Sesvete beside Zagrebačka cesta.",
        sources=(
            (
                "tportal, 11 June 2024: Puštena u promet produžena Branimirova",
                "https://www.tportal.hr/vijesti/clanak/pustena-u-promet-produzena-"
                "branimirovu-evo-kako-izgleda-foto-20240611",
            ),
        ),
        ways={
            w: {"highway": "secondary", "name": "Ulica kneza Branimira", **ARTERIAL}
            for w in (1132431310, 1132431311, 1528605302, 1528605303)
        },
        over=("Kašinska cesta",),
        signals=("Varaždinska cesta",),
        bridges=(
            Bridge(1132431310, (16.10931, 45.83957), 120.0),
            Bridge(1132431311, (16.10930, 45.83963), 120.0),
            Bridge(1528605302, (16.10931, 45.83957), 120.0),
            Bridge(1528605303, (16.10930, 45.83963), 120.0),
        ),
    ),
    Project(
        id="a11-sarajevska",
        name="A11 into Sarajevska cesta",
        status="Under construction: the City's six-lane Sarajevska cesta was due at the end "
        "of 2025; Hrvatske autoceste's viaduct over the marshalling yard, which joins it to "
        "the A11, was held up by appeals over its tender (2024-2025).",
        summary="The A11 from Velika Gorica carried on from the Jakuševec interchange over "
        "the marshalling yard on two viaducts of about 700 m, straight into a widened "
        "Sarajevska cesta (three lanes each way) in Novi Zagreb, with a signalled junction "
        "at Jakuševečka ulica.",
        sources=(
            (
                "Croatia Week, 22 August 2024: Major avenue and tram line construction in "
                "Zagreb set to begin",
                "https://www.croatiaweek.com/major-avenue-and-tram-line-construction-in-"
                "zagreb-set-to-begin/",
            ),
        ),
        ways={
            **{
                w: {"highway": "motorway", "lanes": "2", "maxspeed": "80"}
                for w in (35073475, 766860186, 200361321, 766860185)
            },
            **{w: {"highway": "motorway_link", "maxspeed": "60"} for w in (766860183, 766860184)},
            **{
                w: {"highway": "secondary", "name": "Sarajevska cesta", "lanes": "3"}
                for w in (318276357, 401775199, 1344828268, 1565583000)
            },
        },
        signals=("Jakuševečka ulica",),
    ),
)


@dataclass
class Patch:
    """Changes to the filtered OpenStreetMap roads: ways replaced or added (id -> nodes,
    tags), nodes added (id -> lon, lat, tags) and tags added to existing nodes."""

    ways: dict[int, tuple[list[int], dict[str, str]]] = field(default_factory=dict)
    nodes: dict[int, tuple[float, float, dict[str, str]]] = field(default_factory=dict)
    node_tags: dict[int, dict[str, str]] = field(default_factory=dict)

    def digest(self) -> str:
        parts = [sorted(self.ways.items()), sorted(self.nodes.items())]
        data = json.dumps([*parts, sorted(self.node_tags.items())], sort_keys=True)
        return hashlib.sha1(data.encode()).hexdigest()[:10]


class Planner:
    """Works out a project's patch on the ways and node positions of the extract."""

    def __init__(self, project: Project, pbf: Path):
        self.project = project
        names = (
            {e.road for e in project.extend}
            | set(project.cross)
            | set(project.over)
            | set(project.signals)
        )
        self.ways: dict[int, list[int]] = {}
        self.tags: dict[int, dict[str, str]] = {}
        self.roads: dict[str, list[int]] = {n: [] for n in names}
        for way in osmium.FileProcessor(str(pbf), osmium.osm.WAY):
            name = way.tags.get("name")
            if way.id in project.ways:
                self.ways[way.id] = [n.ref for n in way.nodes]
                tags = {
                    t.k: t.v for t in way.tags if t.k not in ("highway", "proposed", "construction")
                }
                self.tags[way.id] = {**tags, **project.ways[way.id]}
            elif name in names and wanted_way(way.tags):
                self.ways[way.id] = [n.ref for n in way.nodes]
                self.tags[way.id] = dict(way.tags)
                self.roads[name].append(way.id)
        # OpenStreetMap ids come and go between extracts (CI keeps an older one): a way the
        # extract lacks is left out, and the project is built without it.
        missing = set(project.ways) - set(self.ways)
        if missing:
            log.warning("%s: ways not in the extract, left out: %s", project.id, sorted(missing))
        #: The project's ways the extract has, with the tags they get.
        self.opened = {w: t for w, t in project.ways.items() if w in self.ways}
        if not self.opened:
            raise ValueError(f"{project.id}: none of its ways is in the extract")
        needed = {n for nodes in self.ways.values() for n in nodes}
        self.pos: dict[int, tuple[float, float]] = {}
        for node in osmium.FileProcessor(str(pbf), osmium.osm.NODE):
            if node.id in needed:
                self.pos[node.id] = (node.location.lon, node.location.lat)
        self.lat0 = math.radians(np.mean([p[1] for p in self.pos.values()]))
        self.new_nodes: dict[int, tuple[float, float, dict[str, str]]] = {}
        self.node_tags: dict[int, dict[str, str]] = {}
        self.changed: set[int] = set(self.opened)
        self.next_id = NEW_ID

    # Positions in metres east and north.
    def xy(self, node: int) -> np.ndarray:
        lon, lat = self.pos[node]
        return self.to_xy(lon, lat)

    def to_xy(self, lon: float, lat: float) -> np.ndarray:
        return np.array([lon * math.cos(self.lat0), lat]) * METRES_PER_DEGREE

    def to_lonlat(self, p: np.ndarray) -> tuple[float, float]:
        return (p[0] / METRES_PER_DEGREE / math.cos(self.lat0), p[1] / METRES_PER_DEGREE)

    def add_node(self, p: np.ndarray) -> int:
        node = self.next_id
        self.next_id += 1
        lon, lat = self.to_lonlat(p)
        self.pos[node] = (lon, lat)
        self.new_nodes[node] = (lon, lat, {})
        return node

    def node_on(self, way: int, k: int, p: np.ndarray) -> int:
        """A node at `p` on segment k of a way: an end of the segment if within SNAP, else a
        new node inserted there."""
        nodes = self.ways[way]
        for n in (nodes[k], nodes[k + 1]):
            if np.linalg.norm(self.xy(n) - p) < SNAP:
                return n
        node = self.add_node(p)
        nodes.insert(k + 1, node)
        self.changed.add(way)
        return node

    def segments(self, way: int):
        nodes = self.ways[way]
        for k in range(len(nodes) - 1):
            yield k, self.xy(nodes[k]), self.xy(nodes[k + 1])

    @staticmethod
    def intersect(a, b, c, d) -> tuple[float, float] | None:
        """Parameters (s on a-b, t on c-d) where two segments cross, or None."""
        r, q = b - a, d - c
        den = r[0] * q[1] - r[1] * q[0]
        if abs(den) < 1e-9:
            return None
        w = c - a
        s = (w[0] * q[1] - w[1] * q[0]) / den
        t = (w[0] * r[1] - w[1] * r[0]) / den
        return (s, t) if 0 <= s <= 1 and 0 <= t <= 1 else None

    def extend(self, e: Extend) -> None:
        nodes = self.ways[e.way]
        tip, prev = (nodes[-1], nodes[-2]) if e.end == "end" else (nodes[0], nodes[1])
        a = self.xy(tip)
        direction = a - self.xy(prev)
        b = a + direction / np.linalg.norm(direction) * e.reach
        hits = []
        for road in self.roads[e.road]:
            if tip in self.ways[road]:
                continue
            for k, c, d in self.segments(road):
                st = self.intersect(a, b, c, d)
                if st and st[0] * e.reach > 1.0:
                    hits.append((st[0], road, k, a + (b - a) * st[0]))
        if not hits:
            log.warning("%s: way %d meets no %s ahead", self.project.id, e.way, e.road)
            return
        added = []
        # Furthest first, so earlier insertions keep the segment numbers of the rest.
        for _, road, k, p in sorted(hits, key=lambda h: (h[1], -h[2])):
            added.append((float(np.linalg.norm(p - a)), self.node_on(road, k, p)))
        chain = [n for _, n in sorted(added)]
        if e.end == "end":
            nodes.extend(chain)
        else:
            nodes[:0] = chain[::-1]

    def cross(self, name: str) -> int:
        """Junctions where the project's ways cross roads named `name`."""
        made = 0
        for way in self.opened:
            for road in self.roads[name]:
                while (found := self.crossing(way, road)) is not None:
                    k, j, p = found
                    node = self.node_on(road, j, p)
                    if node not in self.ways[way]:
                        self.ways[way].insert(k + 1, node)
                    made += 1
        return made

    def crossing(self, way: int, road: int) -> tuple[int, int, np.ndarray] | None:
        """The first place a way crosses a road without a shared node: (segment of the way,
        segment of the road, point)."""
        shared = [self.xy(n) for n in set(self.ways[way]) & set(self.ways[road])]
        for k, a, b in self.segments(way):
            for j, c, d in self.segments(road):
                st = self.intersect(a, b, c, d)
                if st is None:
                    continue
                p = a + (b - a) * st[0]
                if not any(np.linalg.norm(p - q) < SNAP for q in shared):
                    return k, j, p
        return None

    def over(self, name: str) -> None:
        """Take the project's ways off the roads named `name`: shared nodes become nodes of
        their own at the same place."""
        road_nodes = {n for road in self.roads[name] for n in self.ways[road]}
        replaced: dict[int, int] = {}
        for way in self.opened:
            nodes = self.ways[way]
            for k, n in enumerate(nodes):
                if n in road_nodes:
                    if n not in replaced:
                        replaced[n] = self.add_node(self.xy(n))
                    nodes[k] = replaced[n]

    def bridge(self, b: Bridge) -> None:
        """Split a way into the bridge and the parts either side."""
        nodes = self.ways[b.way]
        pts = [self.xy(n) for n in nodes]
        steps = [np.linalg.norm(q - p) for p, q in zip(pts, pts[1:], strict=False)]
        along = np.concatenate([[0.0], np.cumsum(steps)])
        centre = self.to_xy(*b.at)
        # Where the way passes nearest the centre, as a distance along it.
        best = (math.inf, 0.0)
        for k in range(len(pts) - 1):
            seg = pts[k + 1] - pts[k]
            u = float(np.clip(np.dot(centre - pts[k], seg) / max(np.dot(seg, seg), 1e-9), 0, 1))
            d = float(np.linalg.norm(pts[k] + seg * u - centre))
            if d < best[0]:
                best = (d, along[k] + u * np.linalg.norm(seg))
        if best[0] > 50:
            raise ValueError(f"{self.project.id}: way {b.way} passes {best[0]:.0f} m from {b.at}")
        cuts = []
        for s in (best[1] - b.length / 2, best[1] + b.length / 2):
            s = float(np.clip(s, 0.0, along[-1]))
            k = int(np.clip(np.searchsorted(along, s) - 1, 0, len(pts) - 2))
            seg_len = along[k + 1] - along[k]
            p = pts[k] + (pts[k + 1] - pts[k]) * ((s - along[k]) / max(seg_len, 1e-9))
            cuts.append((k, p))
        # The far cut first, so the near one keeps its segment number.
        last = self.node_on(b.way, *cuts[1])
        first = self.node_on(b.way, *cuts[0])
        nodes = self.ways[b.way]
        i, j = nodes.index(first), nodes.index(last)
        tags = self.tags[b.way]
        deck = {**tags, "bridge": "yes", "layer": "1"}
        if b.name:
            deck["name"] = b.name
        parts = [(nodes[: i + 1], tags), (nodes[i : j + 1], deck), (nodes[j:], tags)]
        parts = [(p, t) for p, t in parts if len(p) > 1]
        self.ways[b.way], self.tags[b.way] = parts[0]
        for p, t in parts[1:]:
            way = self.next_id
            self.next_id += 1
            self.ways[way], self.tags[way] = list(p), dict(t)
            self.changed.add(way)

    def plan(self) -> Patch:
        for name in self.project.over:
            self.over(name)
        for e in self.project.extend:
            if e.way in self.opened:
                self.extend(e)
        for name in self.project.cross:
            made = self.cross(name)
            if not made:
                log.warning("%s: crosses no %s", self.project.id, name)
        own = set(self.opened)
        for b in self.project.bridges:
            if b.way in self.opened:
                self.bridge(b)
        own |= {w for w in self.changed if w >= NEW_ID}
        project_nodes = {n for w in own for n in self.ways[w]}
        for name in self.project.signals:
            shared = project_nodes & {n for r in self.roads[name] for n in self.ways[r]}
            if not shared:
                log.warning("%s: no junction with %s for signals", self.project.id, name)
            for n in shared:
                if n in self.new_nodes:
                    self.new_nodes[n][2]["highway"] = "traffic_signals"
                else:
                    self.node_tags[n] = {"highway": "traffic_signals"}
        return Patch(
            ways={w: (self.ways[w], self.tags[w]) for w in sorted(self.changed)},
            nodes=dict(self.new_nodes),
            node_tags=dict(self.node_tags),
        )


def project_network(project: Project) -> tuple[Path, Patch]:
    """Cached SUMO network of today's extract with the project's patch."""
    pbf = fetch_osm()
    patch = Planner(project, pbf).plan()
    key = hashlib.sha1(
        (
            pbf.name + json.dumps(NETCONVERT_OPTIONS) + f"roads {ROADS_VERSION}" + patch.digest()
        ).encode()
    ).hexdigest()[:10]
    folder = CACHE_DIR / "network"
    net_file = folder / f"{project.id}_{key}.net.xml.gz"
    if net_file.exists() and net_file.stat().st_mtime >= pbf.stat().st_mtime:
        return net_file, patch
    roads = folder / f"roads_{project.id}_{key}.osm"
    log.info("%s: filtering roads: %s", project.id, filter_roads(pbf, roads, patch))
    log.info("%s: running netconvert", project.id)
    run_netconvert(roads, net_file)
    roads.unlink()
    return net_file, patch


def road_samples(root: Path, step: float = 10.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Points every `step` metres or closer along the first lane of each of a network's
    roads for cars (scene x, z), the edge of each and its heading there (degrees, 0-180)."""
    index = json.loads((root / "network" / "net.json").read_text())
    net = read_packed(root / "network" / index["file"], index)
    internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
    lane0 = net["edgeLaneStart"].astype(np.int64)
    cars = (net["laneAllow"][lane0] & index["vclassBits"]["passenger"]) != 0
    offsets = net["laneShapeOffsets"].astype(np.int64)
    origin = net["laneShapeOrigin"].reshape(-1, 2).astype(np.int64)
    delta = net["laneShapeDelta"].reshape(-1, 2).astype(np.int64)
    points, owners, headings = [], [], []
    for e in np.flatnonzero(~internal & cars):
        lane = lane0[e]
        pts = (origin[lane] + np.cumsum(delta[offsets[lane] : offsets[lane + 1]], axis=0)) / 100.0
        for p, q in zip(pts, pts[1:], strict=False):
            n = max(1, int(np.linalg.norm(q - p) // step))
            points.extend(p + (q - p) * (np.arange(n)[:, None] / n))
            owners.extend([e] * n)
            headings.extend([math.degrees(math.atan2(q[1] - p[1], q[0] - p[0])) % 180] * n)
    return np.asarray(points), np.asarray(owners), np.asarray(headings)


def new_edges(
    today: Path, project_root: Path, tolerance: float = 8.0, turn: float = 30.0
) -> tuple[list[int], tuple[float, float]]:
    """Edges of the project's network that no road of today's runs along (those with most of
    their points further than `tolerance` metres from any of today's roads running within
    `turn` degrees of their direction), and their middle."""
    base, _, base_heading = road_samples(today)
    points, owners, heading = road_samples(project_root)
    tree = cKDTree(base)
    near = tree.query_ball_point(points, tolerance)
    far = np.array(
        [
            not any(abs((base_heading[j] - h + 90) % 180 - 90) < turn for j in js)
            for js, h in zip(near, heading, strict=True)
        ]
    )
    total = np.bincount(owners)
    out = np.bincount(owners, far.astype(np.float64), len(total))
    added = np.flatnonzero((total > 0) & (out > 0.5 * total))
    centre = points[np.isin(owners, added)].mean(axis=0) if len(added) else np.zeros(2)
    return [int(e) for e in added], (round(float(centre[0])), round(float(centre[1])))


def build_project(project: Project) -> dict:
    root = OUTPUT_DIR / "projects" / project.id
    net_file, patch = project_network(project)
    network = export_network(net_file, root / "network")
    demand = build_demand(root)
    transit = build_transit(root)
    news = build_news(root)
    added, centre = new_edges(OUTPUT_DIR, root)
    log.info("%s: %d new edges, network %s", project.id, len(added), network["counts"])
    comparison = COMPARISONS / f"{project.id}.json"
    prefix = f"projects/{project.id}/"
    return {
        "id": project.id,
        "name": project.name,
        "status": project.status,
        "summary": project.summary,
        "sources": [{"title": t, "url": u} for t, u in project.sources],
        "layers": {
            "network": {
                **network,
                "index": prefix + network["index"],
                "attribution": OSM_ATTRIBUTION,
            },
            "demand": {**demand, "index": prefix + demand["index"]},
            "transit": {**transit, "index": prefix + transit["index"]},
            "news": {**news, "index": prefix + news["index"]},
        },
        "newEdges": added,
        "centre": centre,
        "patch": {"ways": len(patch.ways), "nodes": len(patch.nodes)},
        "comparison": json.loads(comparison.read_text()) if comparison.exists() else None,
    }


def build_projects(ids: list[str] | None = None) -> dict:
    """Every project (or those named), and the index the app reads."""
    out = OUTPUT_DIR / "projects"
    out.mkdir(parents=True, exist_ok=True)
    built = [build_project(p) for p in PROJECTS if not ids or p.id in ids]
    index = {"projects": built}
    (out / "projects.json").write_text(json.dumps(index, ensure_ascii=False))
    return {
        "index": "projects/projects.json",
        "projects": [{"id": p["id"], "name": p["name"]} for p in built],
    }


# Road classes the comparison lists roads of.
MAIN_ROADS = ("motorway", "trunk", "primary", "secondary", "tertiary")
# Roads listed are within this distance (m) of the project's new roads, and trips listed
# pass this close to them in a straight line: further away, single runs differ by noise.
NEAR_ROADS = 3_000.0
NEAR_TRIPS = 2_500.0
# The places of web/src/edit/compare.ts (scene x, z): travel times are compared between
# them.
PLACES = {
    "Brezovica": (-6770, 12690),
    "Črnomerec": (-3041, -1127),
    "Donja Dubrava": (6395, -805),
    "Donji grad": (291, 380),
    "Gornja Dubrava": (6075, -3729),
    "Gornji grad – Medveščak": (-113, -1104),
    "Maksimir": (2295, -1777),
    "Novi Zagreb – istok": (1526, 4983),
    "Novi Zagreb – zapad": (-2650, 5604),
    "Peščenica – Žitnjak": (4362, 1651),
    "Podsljeme": (722, -5725),
    "Podsused – Vrapče": (-7560, -967),
    "Sesvete": (11910, -4088),
    "Stenjevec": (-6004, 850),
    "Trešnjevka – jug": (-3967, 2532),
    "Trešnjevka – sjever": (-2749, 1331),
    "Trnje": (530, 1853),
    "Velika Gorica": (7286, 10882),
    "Samobor": (-20701, 1177),
    "Zaprešić": (-13185, -4977),
    "Dugo Selo": (20343, 1003),
}
# Roads listed: the most changed by vehicle-kilometres, and only with at least this many.
LISTED_ROADS = 8
MIN_ROAD_KM = 500.0


def road_km(root: Path, volumes: list[int], centre: tuple[float, float]) -> dict[str, float]:
    """Vehicle-kilometres driven on each named main road within NEAR_ROADS of `centre`,
    from vehicles per edge."""
    index = json.loads((root / "network" / "net.json").read_text())
    net = read_packed(root / "network" / index["file"], index)
    internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
    lane0 = net["edgeLaneStart"].astype(np.int64)
    length = net["laneLength"][lane0] / 1000.0
    types, names = index["types"], index["names"]
    main = np.array([t.removeprefix("highway.").split("|")[0] in MAIN_ROADS for t in types])
    pos = net["junctionPos"].reshape(-1, 2)
    mid = (pos[net["edgeFrom"]] + pos[net["edgeTo"]]) / 2
    near = np.hypot(mid[:, 0] - centre[0], mid[:, 1] - centre[1]) < NEAR_ROADS
    out: dict[str, float] = {}
    for e in np.flatnonzero(~internal & main[net["edgeType"]] & near):
        k = int(net["edgeName"][e])
        if k < len(names) and names[k] and volumes[e]:
            out[names[k]] = out.get(names[k], 0.0) + volumes[e] * float(length[e])
    return out


def passes_near(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> bool:
    """Whether the straight line from a to b passes within NEAR_TRIPS of c."""
    ab = np.subtract(b, a)
    t = np.clip(np.dot(np.subtract(c, a), ab) / max(float(np.dot(ab, ab)), 1.0), 0.0, 1.0)
    return float(np.hypot(*(np.add(a, ab * t) - c))) < NEAR_TRIPS


def average_runs(runs: list[dict]) -> dict:
    """One run from several of the same network with other random trips: per hour the
    mean of each measure and of each travel time (-1 where a run had no route), and the
    mean vehicles per edge."""
    if len(runs) == 1:
        return runs[0]
    hours = []
    for rows in zip(*(r["perHour"] for r in runs), strict=True):
        row = {"hour": rows[0]["hour"]}
        for k in ("delayHours", "vehicleKm", "arrived", "tripMinutes", "running"):
            row[k] = float(np.mean([h[k] for h in rows]))
        times = zip(*(h["travelSeconds"] for h in rows), strict=True)
        row["travelSeconds"] = [float(np.mean(t)) if all(x > 0 for x in t) else -1.0 for t in times]
        hours.append(row)
    volumes = np.mean([r["volumes"] for r in runs], axis=0)
    return {**runs[0], "perHour": hours, "volumes": volumes.tolist()}


def summarise(
    today_runs: list[dict],
    project_run: dict,
    root: Path,
    centre: tuple[float, float],
) -> dict:
    """Before and after numbers of a project from runs of sim/examples/compare.rs: today's
    network (the mean of runs with other random trips, which also show the noise) and the
    project's."""
    today_run = average_runs(today_runs)
    hours = []
    totals = {"today": {}, "project": {}}
    keys = ("delayHours", "vehicleKm", "arrived")
    for a, b in zip(today_run["perHour"], project_run["perHour"], strict=True):
        hours.append({"hour": a["hour"], **{k: [a[k], b[k]] for k in (*keys, "tripMinutes")}})
        for side, h in (("today", a), ("project", b)):
            for k in keys:
                totals[side][k] = round(totals[side].get(k, 0) + h[k], 1)
    for side, run in (("today", today_run), ("project", project_run)):
        trips = sum(h["arrived"] for h in run["perHour"])
        minutes = sum(h["arrived"] * h["tripMinutes"] for h in run["perHour"])
        totals[side]["tripMinutes"] = round(minutes / max(trips, 1), 2)

    # Travel times at the end of each hour: the mean change over the pairs of places, and
    # the pairs that changed most at the end of the busiest hour.
    places = today_run["places"]
    pairs = [(i, j) for i in range(len(places)) for j in range(len(places)) if i != j]
    travel = []
    for a, b in zip(today_run["perHour"], project_run["perHour"], strict=True):
        rel = [
            (q - p) / p
            for p, q in zip(a["travelSeconds"], b["travelSeconds"], strict=True)
            if p > 0 and q > 0
        ]
        travel.append({"hour": a["hour"] + 1, "mean": round(float(np.mean(rel)), 4)})

    # The pairs that changed most, on their travel times averaged over the hours (one
    # moment's times vary a lot in congestion).
    def mean_times(run: dict) -> list[float]:
        rows = [h["travelSeconds"] for h in run["perHour"]]
        return [
            float(np.mean(col)) if all(t > 0 for t in col) else -1.0
            for col in zip(*rows, strict=True)
        ]

    a, b = mean_times(today_run), mean_times(project_run)
    changes = sorted(
        (
            {"from": places[i], "to": places[j], "today": round(p), "project": round(q)}
            for (i, j), p, q in zip(pairs, a, b, strict=True)
            if p > 0 and q > 0 and passes_near(PLACES[places[i]], PLACES[places[j]], centre)
        ),
        key=lambda c: (c["project"] - c["today"]) / c["today"],
    )
    valid = [(p, q) for p, q in zip(a, b, strict=True) if p > 0 and q > 0]
    mean = float(np.mean([(q - p) / p for p, q in valid])) if valid else 0.0

    # Noise: how far runs of today's network with other random trips are apart.
    noise = None
    if len(today_runs) > 1:
        delays = [sum(h["delayHours"] for h in r["perHour"]) for r in today_runs]
        times = [mean_times(r) for r in today_runs]
        diffs = [
            abs(q - p) / ((p + q) / 2)
            for p, q in zip(times[0], times[1], strict=True)
            if p > 0 and q > 0
        ]
        noise = {
            "delay": round((max(delays) - min(delays)) / float(np.mean(delays)), 4),
            "travel": round(float(np.mean(diffs)), 4) if diffs else 0.0,
        }

    today_roads = road_km(OUTPUT_DIR, today_run["volumes"], centre)
    project_roads = road_km(root, project_run["volumes"], centre)
    roads = [
        {
            "name": n,
            "today": round(today_roads.get(n, 0.0)),
            "project": round(project_roads.get(n, 0.0)),
        }
        for n in set(today_roads) | set(project_roads)
        if max(today_roads.get(n, 0.0), project_roads.get(n, 0.0)) >= MIN_ROAD_KM
    ]
    roads.sort(key=lambda r: -abs(r["project"] - r["today"]))
    return {
        "computed": date.today().isoformat(),
        "fromHour": today_run["fromHour"],
        "hours": today_run["hours"],
        "demandScale": today_run["demandScale"],
        "totals": totals,
        "perHour": hours,
        "travel": {
            "perHour": travel,
            "mean": round(mean, 4),
            "faster": [c for c in changes[:3] if c["project"] < c["today"] * 0.995],
            "slower": [c for c in changes[::-1][:3] if c["project"] > c["today"] * 1.005],
        },
        "roads": roads[:LISTED_ROADS],
        "noise": noise,
    }


def main(argv: list[str] | None = None) -> None:
    """`python -m pipeline.projects compare <id> <project run> <today run> [<today run>...]`:
    write the project's before and after numbers to pipeline/data/projects/<id>.json, today
    as the mean of runs of today's network with other seeds."""
    import argparse

    parser = argparse.ArgumentParser(prog="python -m pipeline.projects")
    parser.add_argument("command", choices=["compare"])
    parser.add_argument("project")
    parser.add_argument("run", type=Path)
    parser.add_argument("today", type=Path, nargs="+")
    args = parser.parse_args(argv)
    project = next(p for p in PROJECTS if p.id == args.project)
    root = OUTPUT_DIR / "projects" / project.id
    index = json.loads((OUTPUT_DIR / "projects" / "projects.json").read_text())
    centre = next(p["centre"] for p in index["projects"] if p["id"] == project.id)
    data = summarise(
        [json.loads(t.read_text()) for t in args.today],
        json.loads(args.run.read_text()),
        root,
        tuple(centre),
    )
    COMPARISONS.mkdir(parents=True, exist_ok=True)
    out = COMPARISONS / f"{project.id}.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps({k: data[k] for k in ("totals", "roads")}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
