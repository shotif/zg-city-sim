import numpy as np
import shapely

from pipeline.counts import Station
from pipeline.gateways import (
    CLASS_DAILY,
    NONE,
    Gateway,
    assign_volumes,
    pair_carriageways,
    road_class,
    road_ends,
    to_scene,
)

TYPES = ["internal", "highway.primary", "highway.motorway", "highway.service", "railway.rail"]
INDEX = {"flags": {"internal": 16}, "types": TYPES, "refs": ["D1", "A3"]}


def network() -> dict[str, np.ndarray]:
    """A junction inside the map (0) with roads leaving it: a two-way primary road ending at
    junction 1, a motorway's two carriageways ending at 2 (in) and 3 (out), a service road
    ending at 4 and a railway ending at 5. The map is the box +-100 m around junction 0."""
    pos = [(0, 0), (500, 0), (0, 500), (40, 500), (-500, 0), (0, -500)]
    edges = [
        # from, to, type, ref
        (0, 1, 1, 0),
        (1, 0, 1, 0),
        (2, 0, 2, 1),
        (0, 3, 2, 1),
        (0, 4, 3, NONE),
        (4, 0, 3, NONE),
        (0, 5, 4, NONE),
    ]
    n = len(edges)
    return {
        "junctionPos": np.array(pos, np.float32).ravel(),
        "edgeFrom": np.array([e[0] for e in edges], np.uint32),
        "edgeTo": np.array([e[1] for e in edges], np.uint32),
        "edgeType": np.array([e[2] for e in edges], np.uint16),
        "edgeRef": np.array([e[3] for e in edges], np.uint32),
        "edgeFlags": np.zeros(n, np.uint8),
        "edgeLaneStart": np.arange(n, dtype=np.uint32),
        "edgeLaneCount": np.ones(n, np.uint8),
        # The railway's lane allows trains only.
        "laneAllow": np.array([1] * (n - 1) + [256], np.uint16),
    }


def test_road_class():
    assert road_class("highway.motorway_link") == "link"
    assert road_class("highway.service|psv") is None
    assert road_class("railway.tram") is None
    assert road_class("highway.secondary") == "secondary"


def test_road_ends_and_carriageways_become_gateways():
    ends = road_ends(network(), INDEX, shapely.box(-100, -100, 100, 100))
    by_place = {(g.x, g.z): g for g in ends}
    assert set(by_place) == {(500, 0), (0, 500), (40, 500)}
    assert (by_place[500, 0].entry, by_place[500, 0].exit) == (1, 0)
    assert by_place[500, 0].ref == "D1" and by_place[500, 0].road_class == "primary"
    gateways = pair_carriageways(ends)
    assert len(gateways) == 2
    motorway = next(g for g in gateways if g.road_class == "motorway")
    assert (motorway.entry, motorway.exit, motorway.ref) == (2, 3, "A3")
    assert (motorway.x, motorway.z) == (20, 500)


def test_carriageways_too_far_apart_stay_separate():
    a = Gateway(x=0, z=0, road_class="motorway", ref="A1", entry=1)
    b = Gateway(x=1000, z=0, road_class="motorway", ref="A1", exit=2)
    c = Gateway(x=10, z=0, road_class="motorway", ref="A2", exit=3)
    assert len(pair_carriageways([a, b, c])) == 3


def test_counted_roads_get_their_count():
    x, z = to_scene(15.684, 45.648)
    counted = Gateway(x=x + 300, z=z, road_class="motorway", ref="A1", entry=1, exit=2)
    other = Gateway(x=x + 9000, z=z, road_class="secondary", ref="", entry=3, exit=4)
    stations = [
        Station(1, "here", "A1", 49_000, (15.8, 45.7), (15.684, 45.648)),
        Station(2, "inside", "D1", 9_000, (15.8, 45.7)),
    ]
    assign_volumes([counted, other], stations)
    assert counted.daily == 49_000 and counted.stations == [1]
    assign_volumes(
        [counted],
        [Station(3, "before a junction", "A1", 40_000, (15.8, 45.7), (15.684, 45.648), 0.75)],
    )
    assert counted.daily == 30_000
    assert counted.through > 0.2
    assert other.daily == CLASS_DAILY["secondary"] and other.stations == []
