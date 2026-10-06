"""Congestion hotspots from news reports, placed on the road network for the app.

`pipeline/data/news.json` lists places in and around Zagreb that the news reported jams,
roadworks, closures or crashes at, and the reports themselves. Each place says where it is
by street names (a whole street, or the junction of two), by road number between two
points (motorway sections) or by a point; this step finds the edges that make it up, so
the app can draw the place and compare it with simulated traffic.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import shapely

from .config import OUTPUT_DIR, PIPELINE_DIR
from .gateways import to_scene
from .packed import read_packed

log = logging.getLogger(__name__)

SOURCE = PIPELINE_DIR / "data" / "news.json"
# Junction of two streets: the streets' own junctions, or ends of theirs this close (m).
JUNCTION_GAP = 60.0
# Edges of the two streets this close (m) to a junction belong to it.
JUNCTION_RADIUS = 250.0
# Motorway section: edges whose middle is this close (m) to the line through its points.
SECTION_WIDTH = 800.0
PASSENGER = 1

ATTRIBUTION = {
    "name": "Croatian online news, 2020-2026",
    "text": "Hotspots from news reports (tportal.hr, index.hr, dnevnik.hr, n1info.hr, net.hr, "
    "zagreb.info, telegram.hr and others), collected from search results; each report links "
    "to its article.",
    "url": "https://github.com/shotif/zg-city-sim/blob/main/pipeline/data/news.json",
}


@dataclass
class Place:
    edges: list[int]
    x: float
    z: float


class Resolver:
    """Finds the edges and a label position for a place description."""

    def __init__(self, net: dict[str, np.ndarray], index: dict) -> None:
        internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
        lane0 = net["edgeLaneStart"].astype(np.int64)
        drivable = (net["laneAllow"][lane0] & PASSENGER) != 0
        self.edges = np.flatnonzero(~internal & drivable)
        self.name = net["edgeName"][self.edges]
        self.ref = net["edgeRef"][self.edges] if "edgeRef" in net else None
        self.names = {n: i for i, n in enumerate(index["names"])}
        self.refs = {n: i for i, n in enumerate(index.get("refs", []))}
        self.frm = net["edgeFrom"][self.edges]
        self.to = net["edgeTo"][self.edges]
        self.junction = net["junctionPos"].reshape(-1, 2)
        self.mid = (self.junction[self.frm] + self.junction[self.to]) / 2

    def resolve(self, spec: dict) -> Place | None:
        if "junction" in spec:
            return self.crossing(*spec["junction"], gap=spec.get("gap", JUNCTION_GAP))
        if "street" in spec:
            return self.street(spec["street"], spec.get("near"), spec.get("radius"))
        if "road" in spec:
            return self.section(spec["road"], spec)
        if "point" in spec:
            x, z = to_scene(*spec["point"])
            near = np.flatnonzero(np.hypot(*(self.mid - [x, z]).T) <= spec.get("radius", 300))
            return Place(self.edges[near].tolist(), x, z) if len(near) else None
        raise ValueError(f"unknown place description {spec}")

    def _named(self, name: str) -> np.ndarray:
        """Indices (into self.edges) of the edges with this street name."""
        i = self.names.get(name)
        return np.flatnonzero(self.name == i) if i is not None else np.zeros(0, np.int64)

    def _label(self, sel: np.ndarray) -> tuple[float, float]:
        """A point on the selected edges near their middle."""
        centre = self.mid[sel].mean(axis=0)
        k = sel[np.argmin(np.hypot(*(self.mid[sel] - centre).T))]
        return float(self.mid[k, 0]), float(self.mid[k, 1])

    def street(self, name: str, near: list | None, radius: float | None) -> Place | None:
        sel = self._named(name)
        if near is not None and len(sel):
            x, z = to_scene(*near)
            sel = sel[np.hypot(*(self.mid[sel] - [x, z]).T) <= (radius or 1_000)]
        if len(sel) == 0:
            return None
        return Place(self.edges[sel].tolist(), *self._label(sel))

    def crossing(self, a: str, b: str, gap: float = JUNCTION_GAP) -> Place | None:
        sa, sb = self._named(a), self._named(b)
        if len(sa) == 0 or len(sb) == 0:
            return None
        ja = np.unique(np.concatenate([self.frm[sa], self.to[sa]]))
        jb = np.unique(np.concatenate([self.frm[sb], self.to[sb]]))
        common = np.intersect1d(ja, jb)
        if len(common):
            points = self.junction[common]
        else:
            # Streets that end at different nodes of one junction (dual carriageways, the
            # unnamed ring of a roundabout): the closest pair of their junctions.
            pa, pb = self.junction[ja], self.junction[jb]
            d = np.hypot(pa[:, None, 0] - pb[None, :, 0], pa[:, None, 1] - pb[None, :, 1])
            i, k = np.unravel_index(np.argmin(d), d.shape)
            if d[i, k] > gap:
                return None
            points = np.array([(pa[i] + pb[k]) / 2])
        # Streets may cross more than once; keep the first crossing and its nearby nodes.
        first = points[0]
        points = points[np.hypot(*(points - first).T) <= JUNCTION_RADIUS]
        x, z = points.mean(axis=0)
        sel = np.concatenate([sa, sb])
        sel = sel[np.hypot(*(self.mid[sel] - [x, z]).T) <= JUNCTION_RADIUS]
        return Place(self.edges[sel].tolist(), float(x), float(z))

    def section(self, road: str, spec: dict) -> Place | None:
        if self.ref is None or road not in self.refs:
            return None
        sel = np.flatnonzero(self.ref == self.refs[road])
        if "near" in spec:
            x, z = to_scene(*spec["near"])
            sel = sel[np.hypot(*(self.mid[sel] - [x, z]).T) <= spec.get("radius", 1_000)]
            label = (x, z)
        else:
            # Edges along a line through the section's points (its interchanges), not
            # beyond its ends.
            line = shapely.LineString([to_scene(*p) for p in spec["along"]])
            points = shapely.points(self.mid[sel])
            along = shapely.line_locate_point(line, points)
            inside = (along > 0) & (along < line.length)
            sel = sel[inside & (shapely.distance(line, points) <= SECTION_WIDTH)]
            label = None
        if len(sel) == 0:
            return None
        if label is None:
            label = self._label(sel)
        return Place(self.edges[sel].tolist(), float(label[0]), float(label[1]))


def build_news(root: Path = OUTPUT_DIR) -> dict:
    """The reports placed on the network in `root`, written there."""
    data = json.loads(SOURCE.read_text())
    index = json.loads((root / "network" / "net.json").read_text())
    net = read_packed(root / "network" / index["file"], index)
    resolver = Resolver(net, index)

    by_place: dict[str, list[dict]] = {}
    for report in data["reports"]:
        r = {k: v for k, v in report.items() if k != "hotspot" and v is not None}
        by_place.setdefault(report["hotspot"], []).append(r)
    hotspots = []
    unplaced = []
    for h in data["hotspots"]:
        place = next(filter(None, (resolver.resolve(spec) for spec in h["where"])), None)
        if place is None:
            unplaced.append(h["id"])
            continue
        reports = sorted(by_place.get(h["id"], []), key=lambda r: r.get("date", ""), reverse=True)
        hotspots.append(
            {
                "id": h["id"],
                "name": h["name"],
                "x": round(place.x, 1),
                "z": round(place.z, 1),
                "edges": place.edges,
                "reports": reports,
            }
        )
    if unplaced:
        log.warning("news: could not place %s", ", ".join(unplaced))
    out = root / "news" / "hotspots.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"about": data["about"], "hotspots": hotspots}, ensure_ascii=False))
    stats = {
        "hotspots": len(hotspots),
        "reports": sum(len(h["reports"]) for h in hotspots),
        "unplaced": unplaced,
    }
    log.info("news: %s", stats)
    return {"index": "news/hotspots.json", **stats, "attribution": ATTRIBUTION}
