import numpy as np
import shapely

from pipeline.transit import parse_time, place_stop, tangent, weekday_service


def test_parse_time_past_midnight():
    assert parse_time("07:05:30") == 7 * 3600 + 5 * 60 + 30
    assert parse_time("25:10:00") == 25 * 3600 + 600


def test_weekday_service_picks_a_wednesday():
    calendar = [
        {"service_id": "x", "wednesday": "0", "start_date": "20260928"},
    ]
    calendar_dates = [
        {"service_id": "sat", "date": "20261003", "exception_type": "1"},
        {"service_id": "wk", "date": "20260930", "exception_type": "1"},
        {"service_id": "wk", "date": "20261001", "exception_type": "1"},
    ]
    assert weekday_service(calendar, calendar_dates) == ({"wk"}, "20260930")


def test_tangent_follows_the_line():
    line = shapely.LineString([(0, 0), (100, 0), (100, 100)])
    np.testing.assert_allclose(tangent(line, 20), [1, 0])
    np.testing.assert_allclose(tangent(line, 150), [0, 1])


def test_place_stop_takes_the_lane_running_the_routes_way():
    # Two lanes of a two-way street, 3 m apart; the stop is nearer the westbound one but the
    # route runs east.
    eastbound = shapely.LineString([(0, 0), (100, 0)])
    westbound = shapely.LineString([(100, 3), (0, 3)])
    lines = np.array([eastbound, westbound], dtype=object)
    tree = shapely.STRtree(lines)
    hit = place_stop(shapely.Point(25, 2.5), np.array([1.0, 0.0]), tree, lines, 30.0)
    assert hit is not None
    lane, frac = hit
    assert lane == 0
    assert abs(frac - 0.25) < 1e-6
    # Nothing in range.
    assert place_stop(shapely.Point(25, 500), np.array([1.0, 0.0]), tree, lines, 30.0) is None
