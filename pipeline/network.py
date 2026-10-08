"""Road network: OpenStreetMap -> SUMO netconvert -> packed arrays for the app.

The same SUMO network is the basis of the traffic simulation (milestone M2), so what the
app draws is exactly what vehicles will drive on.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import osmium
import shapely
import sumo

from .config import CACHE_DIR, OUTPUT_DIR

if TYPE_CHECKING:
    from .projects import Patch
from .osm import ATTRIBUTION as OSM_ATTRIBUTION
from .osm import fetch_osm
from .packed import write_packed
from .simnet import VCLASS_BITS, pack_network, parse_net

log = logging.getLogger(__name__)

DRIVABLE = {
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "road",
    "busway",
}
# Service roads that only matter to parking and walking, not to city traffic.
MINOR_SERVICE = {"parking_aisle", "driveway", "drive-through", "emergency_access"}
TRACKS = {"tram", "rail", "light_rail"}

# EPSG:3765 (HTRS96/TM); offsets are disabled so the network keeps absolute coordinates.
HTRS96_TM = (
    "+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 "
    "+towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
)

NETCONVERT_OPTIONS = [
    "--proj", HTRS96_TM,
    "--offset.disable-normalization", "true",
    "--geometry.remove",
    "--ramps.guess",
    # Merge junction clusters (OSM nodes a few metres apart) into one junction; the default
    # 10 m leaves thousands of sub-metre edges between them.
    "--junctions.join",
    "--junctions.join-dist", "15",
    "--roundabouts.guess",
    "--tls.guess-signals",
    # OSM maps many of Zagreb's signals on the approaches, a little way out from the junction,
    # often with one approach (a minor road, a level crossing) without one: allow 35 m and one
    # approach without a signal, or Slavonska avenija at Kruge runs as a give-way junction.
    "--tls.guess-signals.dist", "35",
    "--tls.guess-signals.slack", "1",
    "--tls.discard-simple",
    "--tls.join",
    "--tls.default-type", "actuated",
    "--osm.turn-lanes",
    "--osm.lane-access",
    "--osm.bike-access", "false",
    "--osm.sidewalks", "false",
    # Bridges and overpasses rise 6 m per OSM layer, with ramps graded smoothly.
    "--osm.layer-elevation", "6",
    "--osm.all-attributes", "true",
    # Road numbers (A1, D1, Ž1035): where roads leave the map and where traffic is counted.
    "--osm.extra-attributes", "bridge,tunnel,layer,ref,toll",
    # Tram tracks stay edges of their own: joining them into street lanes
    # (--edges.join-tram-dist) loses tram connections wherever the tracks leave the street.
    # Repair track topology: some OSM tracks are mapped against their direction, leaving
    # dead ends where two one-way tracks start at the same switch.
    "--railway.topology.repair",
    "--remove-edges.isolated",
    "--keep-edges.components", "1",
    "--output.street-names",
    "--output.original-names",
    "--junctions.corner-detail", "5",
    "--no-warnings",
]  # fmt: skip


def wanted_way(tags: osmium.osm.TagList) -> bool:
    highway = tags.get("highway")
    if highway in DRIVABLE:
        if tags.get("area") == "yes":
            return False
        return not (highway == "service" and tags.get("service") in MINOR_SERVICE)
    return tags.get("railway") in TRACKS


#: Version of the roads written for netconvert (`filter_roads`): bump it when they change, so
#: cached networks are built again.
ROADS_VERSION = 2

#: Road classes whose missing lane counts are taken from their neighbours (`infer_lanes`).
LANE_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary"}


def lane_count(tags: dict[str, str]) -> int | None:
    try:
        return int(tags["lanes"]) if "lanes" in tags else None
    except ValueError:
        return None


def infer_lanes(ways: dict[int, tuple[list[int], dict[str, str]]]) -> dict[int, int]:
    """Lane counts for main roads OpenStreetMap gives none: a way without `lanes` takes the
    fewest lanes of the ways joined to its ends with the same name (or number), class and
    one-way status, given or found in an earlier round, so counts spread along chains of
    untagged ways. Netconvert would give it one lane each
    way, so a short untagged way on a multi-lane avenue (Slavonska avenija, Zagrebačka
    cesta) became a one-lane bottleneck. Only counts above that default are returned."""

    def key(tags: dict[str, str]) -> tuple:
        return (tags.get("name") or tags.get("ref"), tags.get("highway"), tags.get("oneway"))

    by_end: dict[int, list[int]] = {}
    for wid, (nodes, _) in ways.items():
        for end in (nodes[0], nodes[-1]):
            by_end.setdefault(end, []).append(wid)
    known = {wid: n for wid, (_, tags) in ways.items() if (n := lane_count(tags))}
    inferred: dict[int, int] = {}
    for _ in range(4):
        found = {}
        for wid, (nodes, tags) in ways.items():
            if wid in known or "lanes:forward" in tags or not key(tags)[0]:
                continue
            around = [
                known[o]
                for end in (nodes[0], nodes[-1])
                for o in by_end[end]
                if o != wid and o in known and key(ways[o][1]) == key(tags)
            ]
            if around:
                found[wid] = min(around)
        if not found:
            break
        known.update(found)
        inferred.update(found)
    one_way = {wid for wid, (_, tags) in ways.items() if tags.get("oneway") in ("yes", "1")}
    return {w: n for w, n in inferred.items() if n >= (2 if w in one_way else 3)}


def filter_roads(src: Path, dst: Path, patch: Patch | None = None) -> dict:
    """Write drivable roads, tracks and their turn restrictions as OSM XML for netconvert,
    with a project's patch (pipeline/projects.py) applied if given."""
    patch_ways = patch.ways if patch else {}
    way_ids: set[int] = set()
    node_ids: set[int] = set()
    main: dict[int, tuple[list[int], dict[str, str]]] = {}
    for way in osmium.FileProcessor(str(src), osmium.osm.WAY):
        if way.id in patch_ways:
            way_ids.add(way.id)
        elif wanted_way(way.tags):
            way_ids.add(way.id)
            node_ids.update(n.ref for n in way.nodes)
            if way.tags.get("highway") in LANE_CLASSES and len(way.nodes) > 1:
                main[way.id] = ([n.ref for n in way.nodes], dict(way.tags))
    lanes = infer_lanes(main)
    for nodes, _ in patch_ways.values():
        node_ids.update(nodes)
    new_ways = {w: v for w, v in patch_ways.items() if w not in way_ids}
    new_nodes = patch.nodes if patch else {}
    node_tags = patch.node_tags if patch else {}

    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name("partial-" + dst.name)  # keeps the .osm suffix osmium needs
    writer = osmium.SimpleWriter(str(tmp), overwrite=True)
    restrictions = 0
    nodes_done = ways_done = False

    def finish_nodes() -> None:
        for node, (lon, lat, tags) in new_nodes.items():
            writer.add_node(osmium.osm.mutable.Node(location=(lon, lat), id=node, tags=tags))

    def finish_ways() -> None:
        for way, (nodes, tags) in new_ways.items():
            writer.add_way(osmium.osm.mutable.Way(nodes=nodes, id=way, tags=tags))

    for obj in osmium.FileProcessor(str(src)):
        if obj.is_node():
            if obj.id in node_ids:
                extra = node_tags.get(obj.id)
                writer.add_node(obj.replace(tags={**dict(obj.tags), **extra}) if extra else obj)
            continue
        if not nodes_done:
            finish_nodes()
            nodes_done = True
        if obj.is_way():
            if obj.id in patch_ways:
                nodes, tags = patch_ways[obj.id]
                writer.add_way(obj.replace(nodes=nodes, tags=tags))
            elif obj.id in lanes:
                writer.add_way(obj.replace(tags={**dict(obj.tags), "lanes": str(lanes[obj.id])}))
            elif obj.id in way_ids:
                writer.add_way(obj)
            continue
        if not ways_done:
            finish_ways()
            ways_done = True
        if obj.tags.get("type") == "restriction" and any(
            m.type == "w" and m.ref in way_ids for m in obj.members
        ):
            writer.add_relation(obj)
            restrictions += 1
    if not nodes_done:
        finish_nodes()
    if not ways_done:
        finish_ways()
    writer.close()
    tmp.rename(dst)
    return {
        "ways": len(way_ids) + len(new_ways),
        "nodes": len(node_ids),
        "restrictions": restrictions,
        "lanesInferred": len(lanes),
    }


def run_netconvert(
    osm_xml: Path, net_file: Path, joins: Path | None = None, join_output: Path | None = None
) -> None:
    """Build `net_file` from roads written by `filter_roads`; `joins`: junctions to join as
    well as those netconvert joins itself (`tram_joins`); `join_output`: where to write the
    junctions netconvert joined."""
    env = dict(os.environ)
    proj_data = Path(sumo.SUMO_HOME) / "data" / "proj"
    if proj_data.is_dir():
        env.setdefault("PROJ_DATA", str(proj_data))
        env.setdefault("PROJ_LIB", str(proj_data))
    tmp = net_file.with_name("partial-" + net_file.name)
    cmd = [str(Path(sumo.SUMO_HOME) / "bin" / "netconvert"), "--osm-files", str(osm_xml)]
    if joins is not None:
        cmd += ["--node-files", str(joins)]
    if join_output is not None:
        cmd += ["--junctions.join-output", str(join_output)]
    cmd += ["--output-file", str(tmp), *NETCONVERT_OPTIONS]
    subprocess.run(cmd, check=True, env=env, capture_output=True, text=True)
    tmp.rename(net_file)


#: Tram-only junctions (where tracks cross, split or merge) within this distance (m) of the
#: area a road junction covers are joined into it (`tram_joins`).
TRAM_JOIN_DIST = 3.0


def cluster_id(nodes: list[str]) -> str:
    """Netconvert's id for the junction it joins from these OSM nodes (sorted as it writes
    them to its join output)."""
    more = f"_#{len(nodes) - 4}more" if len(nodes) > 4 else ""
    return "cluster_" + "_".join(nodes[:4]) + more


def tram_joins(net_file: Path, join_output: Path) -> list[list[str]]:
    """Junctions to join so trams and cars cross as movements of one junction.

    Netconvert joins road junctions a few metres apart into one, but not the junctions
    where only tram tracks meet. Across Zagreb's big tram crossings (Vukovarska at
    Držićeva) trams then pass a string of them on sub-metre track pieces just beyond the
    road junction, and a tram waiting at one stands across the road junction, holding up
    cars with a green light, for minutes when trams wait for each other. Each tram-only
    junction within `TRAM_JOIN_DIST` of a road junction's area (its outline's convex hull)
    is joined into the nearest such road junction, with the OSM nodes netconvert joined
    into that junction. Returns the node lists to join."""
    clusters: dict[str, list[str]] = {}
    for line in join_output.read_text().splitlines():
        line = line.strip()
        if line.startswith("<join nodes="):
            nodes = line.split('"')[1].split()
            clusters[cluster_id(nodes)] = nodes
    net = parse_net(net_file)
    tram, road = VCLASS_BITS["tram"], VCLASS_BITS["passenger"] | VCLASS_BITS["bus"]
    allow: dict[str, int] = {}
    tram_only: dict[str, bool] = {}
    for edge in net.edges:
        if edge.internal:
            continue
        bits = 0
        for lane in edge.lanes:
            bits |= net.lanes[lane].allow
        for node in (edge.from_node, edge.to_node):
            allow[node] = allow.get(node, 0) | bits
            is_tram = bits & tram != 0 and bits & road == 0
            tram_only[node] = tram_only.get(node, True) and is_tram
    roads = [
        j
        for j in net.junctions
        if allow.get(j.id, 0) & road and len(j.shape) >= 3 and not tram_only.get(j.id)
    ]
    outlines = [shapely.MultiPoint([(x, z) for x, z, _ in j.shape]) for j in roads]
    areas = shapely.buffer(shapely.convex_hull(outlines), TRAM_JOIN_DIST)
    tree = shapely.STRtree(areas)
    trams = [j for j in net.junctions if tram_only.get(j.id)]
    points = shapely.points([(j.x, j.z) for j in trams])
    joined: dict[int, list[str]] = {}
    for t, r in tree.query(points, predicate="within").T:
        joined.setdefault(int(t), []).append(int(r))
    into: dict[int, list[str]] = {}
    for t, candidates in joined.items():
        j = trams[t]
        r = min(candidates, key=lambda r: (roads[r].x - j.x) ** 2 + (roads[r].z - j.z) ** 2)
        into.setdefault(r, []).append(j.id)
    return [clusters.get(roads[r].id, [roads[r].id]) + sorted(ids) for r, ids in into.items()]


def write_joins(joins: list[list[str]], path: Path) -> None:
    lines = [f'    <join nodes="{" ".join(nodes)}"/>' for nodes in joins]
    path.write_text("<nodes>\n" + "\n".join(lines) + "\n</nodes>\n")


def network_key(pbf: Path, extra: str = "") -> str:
    """Cache key of a network built from this OSM extract (and a project's `extra`)."""
    text = pbf.name + json.dumps(NETCONVERT_OPTIONS) + f"roads {ROADS_VERSION}"
    text += f" tram joins {TRAM_JOIN_DIST}" + extra
    return hashlib.sha1(text.encode()).hexdigest()[:10]


def build_sumo_network() -> Path:
    """Cached SUMO network for the current OSM extract and netconvert options, built twice:
    the second time with tram-only junctions joined into the road junctions around them
    (`tram_joins`, written next to it for the projects to use)."""
    pbf = fetch_osm()
    net_file = CACHE_DIR / "network" / f"zagreb_{network_key(pbf)}.net.xml.gz"
    joins = junction_joins_file(net_file)
    if net_file.exists() and joins.exists() and net_file.stat().st_mtime >= pbf.stat().st_mtime:
        return net_file
    roads = CACHE_DIR / "network" / f"roads_{pbf.name.split('.')[0]}_{ROADS_VERSION}.osm"
    if not roads.exists() or roads.stat().st_mtime < pbf.stat().st_mtime:
        log.info("filtering roads: %s", filter_roads(pbf, roads))
    log.info("running netconvert")
    first = net_file.with_name("first-" + net_file.name)
    joined = net_file.with_name("joined-" + joins.name)
    run_netconvert(roads, first, join_output=joined)
    found = tram_joins(first, joined)
    log.info("joining tram junctions into %d road junctions", len(found))
    write_joins(found, joins)
    run_netconvert(roads, net_file, joins=joins)
    first.unlink()
    joined.unlink()
    return net_file


def junction_joins_file(net_file: Path) -> Path:
    """The joins (`tram_joins`) the network was built with."""
    return net_file.with_name(net_file.name.split(".")[0] + ".joins.nod.xml")


def export_network(net_file: Path, out_dir: Path) -> dict:
    """Pack the SUMO network for the app (roads) and the traffic engine."""
    net = parse_net(net_file)
    arrays, tables = pack_network(net)
    for stale in ("roads.bin.gz", "roads.json"):
        (out_dir / stale).unlink(missing_ok=True)
    packed = write_packed(out_dir / "net.bin.gz", arrays)
    (out_dir / "net.json").write_text(json.dumps({**packed, **tables}, ensure_ascii=False))

    internal = arrays["edgeFlags"] & tables["flags"]["internal"] != 0
    lanes_internal = internal[arrays["laneEdge"]]
    road_types = {i for i, t in enumerate(tables["types"]) if t.startswith("highway")}
    lane0 = arrays["edgeLaneStart"]
    is_road = np.isin(arrays["edgeType"], list(road_types)) & ~internal
    road_km = float(arrays["laneLength"][lane0[is_road]].sum()) / 1000
    return {
        "index": "network/net.json",
        "counts": {
            "junctions": len(net.junctions),
            "edges": int((~internal).sum()),
            "lanes": int((~lanes_internal).sum()),
            "internalLanes": int(lanes_internal.sum()),
            "links": len(arrays["linkFrom"]),
            "trafficLights": len(net.tls),
            "roadKm": round(road_km),
        },
    }


def build_network() -> dict:
    net_file = build_sumo_network()
    summary = export_network(net_file, OUTPUT_DIR / "network")
    log.info("network: %s", summary["counts"])
    return {**summary, "attribution": OSM_ATTRIBUTION}
