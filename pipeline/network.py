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
import sumolib

from .config import CACHE_DIR, ORIGIN_E, ORIGIN_N, OUTPUT_DIR
from .osm import ATTRIBUTION as OSM_ATTRIBUTION
from .osm import fetch_osm
from .packed import write_packed

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
    "--junctions.join",
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
    "--osm.extra-attributes", "bridge,tunnel,layer",
    # Tram tracks running along a street become tram-permitting lanes of that street.
    "--edges.join-tram-dist", "1.6",
    "--remove-edges.isolated",
    "--keep-edges.components", "1",
    "--output.street-names",
    "--output.original-names",
    "--junctions.corner-detail", "5",
    "--no-warnings",
]  # fmt: skip

# Vehicle-class bits in `laneAllow`.
VCLASS_BITS = {
    "passenger": 1,
    "bus": 2,
    "tram": 4,
    "truck": 8,
    "rail": 16,
    "bicycle": 32,
    "pedestrian": 64,
    "delivery": 128,
}

# Bits in `edgeFlags`.
FLAG_BRIDGE = 1
FLAG_TUNNEL = 2
FLAG_HAS_OPPOSITE = 4
FLAG_ROUNDABOUT = 8


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


def lane_permissions(lane: sumolib.net.lane.Lane) -> int:
    bits = 0
    for vclass, bit in VCLASS_BITS.items():
        if lane.allows(vclass):
            bits |= bit
    if lane.allows("rail_urban") or lane.allows("rail_electric"):
        bits |= VCLASS_BITS["rail"]
    return bits


def to_scene(points) -> list[tuple[float, float, float]]:
    """SUMO (E, N[, z]) -> scene (x, z, elevation offset)."""
    return [(p[0] - ORIGIN_E, ORIGIN_N - p[1], p[2] if len(p) > 2 else 0.0) for p in points]


def export_network(net_file: Path, out_dir: Path) -> dict:
    """Pack junctions, edges and lanes of the SUMO network into arrays for the app."""
    net = sumolib.net.readNet(str(net_file), withInternal=False, withPrograms=False)

    names: dict[str, int] = {}
    types: dict[str, int] = {}
    junction_types: dict[str, int] = {}

    def intern(table: dict[str, int], value: str) -> int:
        return table.setdefault(value, len(table))

    nodes = net.getNodes()
    node_index = {n.getID(): i for i, n in enumerate(nodes)}
    junction_pos, junction_type, junction_shape, junction_offsets = [], [], [], [0]
    for n in nodes:
        x, y = n.getCoord()[:2]
        junction_pos.append((x - ORIGIN_E, ORIGIN_N - y))
        junction_type.append(intern(junction_types, n.getType()))
        junction_shape.extend(to_scene(n.getShape3D()))
        junction_offsets.append(len(junction_shape))

    roundabout_edges = {
        e if isinstance(e, str) else e.getID() for r in net.getRoundabouts() for e in r.getEdges()
    }
    edges = [e for e in net.getEdges() if e.getFunction() == ""]
    edge_ids = {e.getID() for e in edges}

    edge_from, edge_to, edge_type, edge_flags, edge_speed, edge_name = [], [], [], [], [], []
    edge_lane_start, edge_lane_count = [], []
    lane_width, lane_allow, lane_shape, lane_offsets = [], [], [], [0]
    for e in edges:
        eid = e.getID()
        flags = 0
        if e.getParam("bridge", "no") not in ("no", ""):
            flags |= FLAG_BRIDGE
        if e.getParam("tunnel", "no") not in ("no", ""):
            flags |= FLAG_TUNNEL
        opposite = eid[1:] if eid.startswith("-") else "-" + eid
        if opposite in edge_ids:
            flags |= FLAG_HAS_OPPOSITE
        if eid in roundabout_edges:
            flags |= FLAG_ROUNDABOUT
        edge_from.append(node_index[e.getFromNode().getID()])
        edge_to.append(node_index[e.getToNode().getID()])
        edge_type.append(intern(types, e.getType()))
        edge_flags.append(flags)
        edge_speed.append(e.getSpeed())
        edge_name.append(intern(names, e.getName()) if e.getName() else 0xFFFFFFFF)
        edge_lane_start.append(len(lane_width))
        edge_lane_count.append(e.getLaneNumber())
        for lane in e.getLanes():
            lane_width.append(lane.getWidth())
            lane_allow.append(lane_permissions(lane))
            lane_shape.extend(to_scene(lane.getShape3D()))
            lane_offsets.append(len(lane_shape))

    arrays = {
        "junctionPos": np.asarray(junction_pos, np.float32).ravel(),
        "junctionType": np.asarray(junction_type, np.uint8),
        "junctionShapeOffsets": np.asarray(junction_offsets, np.uint32),
        "junctionShape": np.asarray(junction_shape, np.float32).ravel(),
        "edgeFrom": np.asarray(edge_from, np.uint32),
        "edgeTo": np.asarray(edge_to, np.uint32),
        "edgeType": np.asarray(edge_type, np.uint16),
        "edgeFlags": np.asarray(edge_flags, np.uint8),
        "edgeSpeed": np.asarray(edge_speed, np.float32),
        "edgeName": np.asarray(edge_name, np.uint32),
        "edgeLaneStart": np.asarray(edge_lane_start, np.uint32),
        "edgeLaneCount": np.asarray(edge_lane_count, np.uint8),
        "laneWidth": np.asarray(lane_width, np.float32),
        "laneAllow": np.asarray(lane_allow, np.uint16),
        "laneShapeOffsets": np.asarray(lane_offsets, np.uint32),
        "laneShape": np.asarray(lane_shape, np.float32).ravel(),
    }
    packed = write_packed(out_dir / "roads.bin.gz", arrays)
    index = {
        **packed,
        "pointStride": 3,
        "vclassBits": VCLASS_BITS,
        "flags": {
            "bridge": FLAG_BRIDGE,
            "tunnel": FLAG_TUNNEL,
            "hasOpposite": FLAG_HAS_OPPOSITE,
            "roundabout": FLAG_ROUNDABOUT,
        },
        "types": list(types),
        "junctionTypes": list(junction_types),
        "names": list(names),
    }
    (out_dir / "roads.json").write_text(json.dumps(index, ensure_ascii=False))

    road_km = sum(e.getLength() for e in edges if not e.getType().startswith("railway")) / 1000
    return {
        "index": "network/roads.json",
        "counts": {
            "junctions": len(nodes),
            "edges": len(edges),
            "lanes": len(lane_width),
            "trafficLights": len(net.getTrafficLights()),
            "roadKm": round(road_km),
        },
    }


def build_network() -> dict:
    net_file = build_sumo_network()
    summary = export_network(net_file, OUTPUT_DIR / "network")
    log.info("network: %s", summary["counts"])
    return {**summary, "attribution": OSM_ATTRIBUTION}
