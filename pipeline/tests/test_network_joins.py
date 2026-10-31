from pathlib import Path

from pipeline.config import ORIGIN_E, ORIGIN_N
from pipeline.network import cluster_id, tram_joins, write_joins


def xy(x: float, z: float) -> str:
    return f"{ORIGIN_E + x},{ORIGIN_N - z}"


def junction(jid: str, x: float, z: float, half: float = 1.0) -> str:
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    shape = " ".join(xy(x + dx * half, z + dz * half) for dx, dz in corners)
    return (
        f'<junction id="{jid}" type="priority" x="{ORIGIN_E + x}" y="{ORIGIN_N - z}" '
        f'incLanes="" intLanes="" shape="{shape}"/>'
    )


def edge(eid: str, a: str, b: str, allow: str, start: tuple, end: tuple) -> str:
    return (
        f'<edge id="{eid}" from="{a}" to="{b}"><lane id="{eid}_0" index="0" allow="{allow}" '
        f'speed="13.9" length="10" shape="{xy(*start)} {xy(*end)}"/></edge>'
    )


def test_cluster_id_is_netconverts():
    assert cluster_id(["1", "2"]) == "cluster_1_2"
    assert cluster_id(["1", "2", "3", "4", "5", "6"]) == "cluster_1_2_3_4_#2more"


def test_tram_junctions_in_a_road_junction_are_joined_into_it(tmp_path: Path):
    # A road junction 20 m across (netconvert joined OSM nodes 1 and 2 into it), with tram
    # tracks crossing inside it (node 5), splitting just past its edge (3) and far off (6).
    net = tmp_path / "net.xml"
    net.write_text(
        "<net>"
        + junction("cluster_1_2", 0, 0, half=10)
        + junction("7", -100, 0)
        + junction("5", 4, 3)
        + junction("3", 12, 0)
        + junction("6", 100, 0)
        + junction("8", 0, 100)
        + edge("road", "7", "cluster_1_2", "passenger bus", (-100, 0), (-10, 0))
        + edge("t1", "8", "cluster_1_2", "tram", (0, 100), (0, 10))
        + edge("t2", "cluster_1_2", "5", "tram", (0, 0), (4, 3))
        + edge("t3", "5", "3", "tram", (4, 3), (12, 0))
        + edge("t4", "3", "6", "tram", (12, 0), (100, 0))
        + "</net>"
    )
    joined = tmp_path / "joined.xml"
    joined.write_text('<nodes>\n    <join nodes="1 2"/>\n</nodes>\n')
    joins = tram_joins(net, joined)
    assert joins == [["1", "2", "3", "5"]]
    out = tmp_path / "joins.nod.xml"
    write_joins(joins, out)
    assert '<join nodes="1 2 3 5"/>' in out.read_text()
