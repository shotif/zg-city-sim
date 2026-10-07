from pathlib import Path

from pipeline.config import ORIGIN_E, ORIGIN_N
from pipeline.simnet import pack_network, parse_net


def xy(x: float, z: float) -> str:
    return f"{ORIGIN_E + x},{ORIGIN_N - z}"


def edge(eid: str, a: str | None, b: str | None, start: tuple, end: tuple) -> str:
    ends = f'from="{a}" to="{b}"' if a else 'function="internal"'
    return (
        f'<edge id="{eid}" {ends}><lane id="{eid}_0" index="0" speed="13.9" length="10" '
        f'shape="{xy(*start)} {xy(*end)}"/></edge>'
    )


def junction(jid: str, x: float, z: float, extra: str = "") -> str:
    shape = f"{xy(x - 1, z - 1)} {xy(x + 1, z - 1)} {xy(x + 1, z + 1)}"
    return (
        f'<junction id="{jid}" type="priority" x="{ORIGIN_E + x}" y="{ORIGIN_N - z}" '
        f'shape="{shape}" {extra}>'
    )


def test_turns_waiting_inside_a_junction_are_exported(tmp_path: Path):
    # Turning left from the west waits at a point inside J for traffic from the east.
    net = tmp_path / "net.xml"
    net.write_text(
        "<net>"
        + edge(":J_0", None, None, (-5, 0), (0, 0))
        + edge(":J_3", None, None, (0, 0), (0, -5))
        + edge(":J_1", None, None, (5, 0), (-5, 0))
        + edge("in", "W", "J", (-100, 0), (-5, 0))
        + edge("north", "J", "N", (0, -5), (0, -100))
        + edge("opp", "E", "J", (100, 0), (5, 0))
        + edge("west", "J", "W", (-5, 0), (-100, 0))
        + junction(
            "J",
            0,
            0,
            'incLanes="in_0 opp_0" intLanes=":J_0_0 :J_1_0"',
        )
        + '<request index="0" response="10" foes="10" cont="1"/>'
        + '<request index="1" response="00" foes="01" cont="0"/></junction>'
        + junction(":J_3_0", 0, 0, 'incLanes=":J_0_0 opp_0" intLanes=":J_1_0"').replace(
            'type="priority"', 'type="internal"'
        )
        + "</junction>"
        + "".join(
            junction(j, x, z, 'incLanes="" intLanes=""') + "</junction>"
            for j, x, z in (("W", -100, 0), ("N", 0, -100), ("E", 100, 0))
        )
        + '<connection from="in" to="north" fromLane="0" toLane="0" via=":J_0_0" dir="l"'
        ' state="m"/>'
        + '<connection from=":J_0" to="north" fromLane="0" toLane="0" via=":J_3_0" dir="l"'
        ' state="m"/>'
        + '<connection from=":J_3" to="north" fromLane="0" toLane="0" dir="l" state="M"/>'
        + '<connection from="opp" to="west" fromLane="0" toLane="0" via=":J_1_0" dir="s"'
        ' state="M"/>'
        + '<connection from=":J_1" to="west" fromLane="0" toLane="0" dir="s" state="M"/>'
        + "</net>"
    )
    sumo = parse_net(net)
    arrays, _ = pack_network(sumo)
    # Lanes are renumbered by edge: each edge here has one lane, at its edge's start.
    edges = [e.id for e in sumo.edges]
    start = arrays["edgeLaneStart"]
    packed = {f"{eid}_0": int(start[i]) for i, eid in enumerate(edges)}
    assert list(arrays["waitLane"]) == [packed[":J_0_0"]]
    assert list(arrays["waitFoeOffsets"]) == [0, 2]
    assert sorted(arrays["waitFoes"]) == sorted([packed[":J_1_0"], packed["opp_0"]])
