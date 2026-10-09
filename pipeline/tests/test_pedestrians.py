import numpy as np
import shapely

from pipeline.pedestrians import JUNCTION_SIGNAL, ZEBRA, allocate, crossed_lanes, crossing_kind


def test_crossing_kinds():
    assert crossing_kind({"highway": "crossing", "crossing": "traffic_signals"}) == JUNCTION_SIGNAL
    assert crossing_kind({"highway": "crossing", "crossing:signals": "yes"}) == JUNCTION_SIGNAL
    assert crossing_kind({"highway": "crossing", "crossing": "zebra"}) == ZEBRA
    assert crossing_kind({"highway": "crossing"}) == ZEBRA
    assert crossing_kind({"highway": "crossing", "crossing": "unmarked"}) is None
    assert crossing_kind({"highway": "crossing", "crossing:markings": "no"}) is None


def test_a_crossing_takes_the_lanes_it_crosses():
    # A two-way street along x; eastbound lane at y = -1.6 ends 6 m before a junction at
    # x = 100, westbound at y = 1.6 starts there. A side street lane far off.
    lines = np.array(
        [
            shapely.LineString([(0, -1.6), (94, -1.6)]),
            shapely.LineString([(94, 1.6), (0, 1.6)]),
            shapely.LineString([(100, 30), (100, 200)]),
        ],
        dtype=object,
    )
    lanes = (np.arange(3), np.array([0, 1, 2]), np.array([94.0, 94.0, 170.0]), lines)
    tree = shapely.STRtree(lines)
    # Mid-block: both lanes, at their positions along them.
    hits = sorted(crossed_lanes(np.array([40.0, 0.0]), tree, lanes))
    assert [(i, round(pos), where) for i, pos, where in hits] == [(0, 40, "mid"), (1, 54, "mid")]
    # Just past the eastbound lane's end (inside the junction): that lane's end, and the
    # westbound lane's start.
    hits = sorted(crossed_lanes(np.array([97.0, 0.0]), tree, lanes))
    assert [(i, where) for i, _, where in hits] == [(0, "end"), (1, "start")]
    # Nowhere near a lane.
    assert crossed_lanes(np.array([50.0, 80.0]), tree, lanes) == []


def test_allocate_shares_or_spreads_by_distance():
    sinks = np.array([[0.0, 0.0], [100.0, 0.0], [1000.0, 0.0]])
    src = np.array([[0.0, 0.0]])
    shared = allocate(src, np.array([90.0]), sinks, 400.0, True)
    np.testing.assert_allclose(shared, [90 * 1 / 1.75, 90 * 0.75 / 1.75, 0])
    spread = allocate(src, np.array([90.0]), sinks, 400.0, False)
    np.testing.assert_allclose(spread, [90, 67.5, 0])
