import pytest

from pipeline.lorries import (
    HGV_TONNES,
    ZONE_STREETS,
    edge_max_weight,
    parse_maxweight,
    trace_zone,
    way_limit,
    zone_area,
)


def test_weights_are_read_in_tonnes():
    assert parse_maxweight("5") == 5.0
    assert parse_maxweight("7.5") == 7.5
    assert parse_maxweight("10 t") == 10.0
    assert parse_maxweight("3,5") == 3.5
    # None, other units and nonsense are no limit.
    for value in (None, "", "none", "3 st", "8000 lbs", "0"):
        assert parse_maxweight(value) is None


def test_a_ways_limit_is_the_lowest_of_its_weight_and_lorry_access():
    assert way_limit({"maxweight": "7.5"}) == 7.5
    assert way_limit({"maxweight": "10", "maxweight:hgv": "5"}) == 5.0
    # Lorries kept off, or let in only to reach places there: over 3.5 t is a lorry.
    for access in ("no", "destination", "delivery", "private"):
        assert way_limit({"hgv": access}) == HGV_TONNES
    assert way_limit({"hgv": "no", "maxweight": "2.5"}) == 2.5
    assert way_limit({"hgv": "yes"}) is None
    assert way_limit({}) is None


def test_edges_take_the_lowest_limit_of_the_ways_they_were_built_from():
    limits = {"1": 5.0, "2": 12.0, "3": 3.5}
    weights = edge_max_weight(["1", "-2", "2 3", "4", ""], limits)
    assert weights.tolist() == [50, 120, 35, 0, 0]


def street(*points):
    return [list(points)]


def test_the_zone_follows_its_streets_from_where_each_meets_the_next():
    # A square of streets, 1 km a side, each running on past the corners (as streets do),
    # named as the order's first four; the rest are not mapped and left out.
    names = [names[0] for names in ZONE_STREETS[:4]]
    streets = {
        names[0]: street((-100.0, 0.0), (1100.0, 0.0)),
        names[1]: street((1000.0, -100.0), (1000.0, 500.0), (1000.0, 1100.0)),
        names[2]: street((1100.0, 1000.0), (-100.0, 1000.0)),
        names[3]: street((0.0, 1100.0), (0.0, -100.0)),
    }
    # The corners are where the streets cross: add them as points of both.
    for name, line in streets.items():
        for corner in [(0.0, 0.0), (1000.0, 0.0), (1000.0, 1000.0), (0.0, 1000.0)]:
            pts = line[0]
            for i in range(len(pts) - 1):
                (x0, z0), (x1, z1) = pts[i], pts[i + 1]
                on_x = min(x0, x1) <= corner[0] <= max(x0, x1)
                on_z = min(z0, z1) <= corner[1] <= max(z0, z1)
                if on_x and on_z and corner not in pts:
                    pts.insert(i + 1, corner)
                    break
        streets[name] = [pts]
    zone = trace_zone(streets)
    assert zone_area(zone) == pytest.approx(1.0, rel=1e-6)
    assert {(round(x), round(z)) for x, z in zone} == {
        (0, 0),
        (1000, 0),
        (1000, 1000),
        (0, 1000),
    }


def test_no_zone_without_enough_streets():
    assert trace_zone({}) == []
    assert zone_area([]) == 0.0
