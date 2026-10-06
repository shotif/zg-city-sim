import numpy as np
import shapely
from pyproj import Transformer

from pipeline.config import CRS, ORIGIN_E, ORIGIN_N
from pipeline.counts import Station
from pipeline.gateways import (
    CLASS_DAILY,
    NONE,
    Gateway,
    assign_volumes,
    pair_carriageways,
    road_class,
    road_ends,
)

TYPES = ["internal", "highway.primary", "highway.motorway", "highway.service", "railway.rail"]
INDEX = {"flags": {"internal": 16}, "types": TYPES, "refs": ["D1", "A3"]}


LONLAT = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)


def ll(x: float, z: float) -> tuple[float, float]:
    """(lon, lat) of a point in scene coordinates."""
    return LONLAT.transform(x + ORIGIN_E, ORIGIN_N - z)


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
    # The map is a 20 km box; an A1 section crosses its west edge, a D1 section lies 2 km
    # inside the map from where the D1 leaves it, and another 8 km inside.
    outline = shapely.box(-10_000, -10_000, 10_000, 10_000)
    a1 = Gateway(x=-12_000, z=0, road_class="motorway", ref="A1", entry=1, exit=2)
    d1 = Gateway(x=0, z=11_000, road_class="primary", ref="D1", entry=3, exit=4)
    d3 = Gateway(x=11_000, z=0, road_class="primary", ref="D3", entry=5, exit=6)
    other = Gateway(x=0, z=-11_000, road_class="secondary", ref="", entry=7, exit=8)
    stations = [
        Station(1, "crossing", "A1", 49_000, ll(-10_000, 0), path=(ll(-15_000, 0), ll(-5_000, 0))),
        Station(2, "near", "D1", 9_000, ll(0, 8_000), path=(ll(0, 7_000), ll(0, 8_500))),
        Station(3, "far inside", "D3", 9_000, ll(2_000, 0), path=(ll(1_000, 0), ll(2_000, 0))),
    ]
    assign_volumes([a1, d1, d3, other], stations, outline)
    assert a1.stations == [1] and a1.daily == stations[0].workday
    assert d1.stations == [2] and d1.daily == stations[1].workday
    assert d1.daily > stations[1].aadt  # a working day carries more than the year's average
    assert d3.stations == [] and d3.daily == CLASS_DAILY["primary"]
    assert other.daily == CLASS_DAILY["secondary"] and other.stations == []
