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

import numpy as np
import osmium
import sumo

from .config import CACHE_DIR, OUTPUT_DIR
from .osm import ATTRIBUTION as OSM_ATTRIBUTION
from .osm import fetch_osm
from .packed import write_packed
from .simnet import pack_network, parse_net

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
    "--osm.extra-attributes", "bridge,tunnel,layer,ref",
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


def filter_roads(src: Path, dst: Path) -> dict:
    """Write drivable roads, tracks and their turn restrictions as OSM XML for netconvert."""
    way_ids: set[int] = set()
    node_ids: set[int] = set()
    for way in osmium.FileProcessor(str(src), osmium.osm.WAY):
        if wanted_way(way.tags):
            way_ids.add(way.id)
            node_ids.update(n.ref for n in way.nodes)

    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name("partial-" + dst.name)  # keeps the .osm suffix osmium needs
    writer = osmium.SimpleWriter(str(tmp), overwrite=True)
    restrictions = 0
    for obj in osmium.FileProcessor(str(src)):
        if obj.is_node():
            if obj.id in node_ids:
                writer.add_node(obj)
        elif obj.is_way():
            if obj.id in way_ids:
                writer.add_way(obj)
        elif obj.tags.get("type") == "restriction" and any(
            m.type == "w" and m.ref in way_ids for m in obj.members
        ):
            writer.add_relation(obj)
            restrictions += 1
    writer.close()
    tmp.rename(dst)
    return {"ways": len(way_ids), "nodes": len(node_ids), "restrictions": restrictions}


def run_netconvert(osm_xml: Path, net_file: Path) -> None:
    env = dict(os.environ)
    proj_data = Path(sumo.SUMO_HOME) / "data" / "proj"
    if proj_data.is_dir():
        env.setdefault("PROJ_DATA", str(proj_data))
        env.setdefault("PROJ_LIB", str(proj_data))
    tmp = net_file.with_name("partial-" + net_file.name)
    cmd = [str(Path(sumo.SUMO_HOME) / "bin" / "netconvert"), "--osm-files", str(osm_xml)]
    cmd += ["--output-file", str(tmp), *NETCONVERT_OPTIONS]
    subprocess.run(cmd, check=True, env=env, capture_output=True, text=True)
    tmp.rename(net_file)


def build_sumo_network() -> Path:
    """Cached SUMO network for the current OSM extract and netconvert options."""
    pbf = fetch_osm()
    key = hashlib.sha1((pbf.name + json.dumps(NETCONVERT_OPTIONS)).encode()).hexdigest()[:10]
    net_file = CACHE_DIR / "network" / f"zagreb_{key}.net.xml.gz"
    if net_file.exists() and net_file.stat().st_mtime >= pbf.stat().st_mtime:
        return net_file
    roads = CACHE_DIR / "network" / f"roads_{pbf.name.split('.')[0]}.osm"
    if not roads.exists() or roads.stat().st_mtime < pbf.stat().st_mtime:
        log.info("filtering roads: %s", filter_roads(pbf, roads))
    log.info("running netconvert")
    run_netconvert(roads, net_file)
    return net_file


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
