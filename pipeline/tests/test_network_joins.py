from pathlib import Path

from pipeline import network
from pipeline.config import ORIGIN_E, ORIGIN_N
from pipeline.network import cluster_id, merge_joins, split_joins, tram_joins, write_joins


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


def node(jid: str, x: float, z: float, kind: str = "priority") -> str:
    return junction(jid, x, z).replace('type="priority"', f'type="{kind}"')


def piece(eid: str, a: str, b: str, length: float, allow: str = "passenger") -> str:
    return edge(eid, a, b, allow, (0, 0), (length, 0)).replace('length="10"', f'length="{length}"')


def crossing_net(tmp_path: Path, east: str = "priority") -> Path:
    # A road (W-E) crossing a dual carriageway (nodes 1 and 3) with tram tracks between
    # them (2), the halves joined by road pieces 0.2 m long. Node 6 is where the road
    # widens 3 m past the far carriageway (two roads meet there: not a junction), and 8-9
    # another junction 30 m away.
    net = tmp_path / "net.xml"
    parts = [
        node("1", 0, 0),
        node("2", 6, 0),
        node("3", 12, 0, east),
        node("6", 15, 0),
        node("8", 45, 0),
        node("4", 0, -100),
        node("5", 0, 100),
        node("9", 45, 100),
        node("10", -100, 0),
        node("11", 6, -100),
        node("12", 6, 100),
        node("13", 12, -100),
        node("14", 12, 100),
        piece("w", "10", "1", 100),
        piece("a", "1", "2", 0.2),
        piece("b", "2", "3", 0.2),
        piece("c", "3", "6", 3),
        piece("d", "6", "8", 30),
        piece("s", "4", "1", 100),
        piece("s2", "1", "5", 100),
        piece("n", "14", "3", 100),
        piece("n2", "3", "13", 100),
        piece("e", "8", "9", 100),
        piece("e2", "9", "8", 100),
        piece("t1", "11", "2", 100, "tram"),
        piece("t2", "2", "12", 100, "tram"),
    ]
    net.write_text("<net>" + "".join(parts) + "</net>")
    return net


def test_a_crossing_split_in_parts_is_joined(tmp_path: Path):
    net = crossing_net(tmp_path)
    joined = tmp_path / "joined.xml"
    joined.write_text("<nodes>\n</nodes>\n")
    assert split_joins(net, joined) == [["1", "2", "3"]]


def test_signalled_parts_and_level_crossings_stay_apart_when_asked(tmp_path: Path, monkeypatch):
    joined = tmp_path / "joined.xml"
    joined.write_text("<nodes>\n</nodes>\n")
    net = crossing_net(tmp_path, east="traffic_light")
    assert split_joins(net, joined) == [["1", "2", "3"]]
    monkeypatch.setattr(network, "SPLIT_JOIN_SIGNALS", False)
    assert split_joins(net, joined) == []
    net = crossing_net(tmp_path, east="rail_crossing")
    monkeypatch.setattr(network, "SPLIT_JOIN_SIGNALS", True)
    assert split_joins(net, joined) == []


def test_joins_sharing_a_node_are_merged():
    trams = [["1", "2", "5"]]
    splits = [["2", "7"], ["8", "9"]]
    assert merge_joins(trams, splits) == [["1", "2", "5", "7"], ["8", "9"]]
