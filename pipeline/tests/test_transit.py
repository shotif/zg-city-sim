import numpy as np
import shapely

from pipeline.transit import (
    TrackGraph,
    along_shape,
    parse_time,
    place_stop,
    quickest_tracks,
    tangent,
    weekday_service,
)


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


def test_stops_on_an_out_and_back_route_go_on_their_own_side():
    # East along a street to a turning loop at x = 1000, then back west 6 m to the north.
    shape = shapely.LineString([(0, 0), (1000, 0), (1010, 3), (1000, 6), (0, 6)])
    # Stops in the order served: two going east (on y = 0), two coming back (on y = 6).
    stops = np.array([[200, 1], [600, 1], [600, 5], [200, 5]])
    at = along_shape(shape, stops)
    assert abs(at[0] - 200) < 5 and abs(at[1] - 600) < 5
    back = shape.length - 200
    assert abs(at[2] - (back - 400)) < 5 and abs(at[3] - back) < 5
    np.testing.assert_allclose(tangent(shape, at[3]), [-1, 0], atol=1e-6)


def rail_net(lengths: list[float], links: list[tuple[int, int]]) -> tuple[dict, dict]:
    """A rail network of one-lane edges at 20 m/s (lane i on edge i) and links between them."""
    n = len(lengths)
    net = {
        "edgeFlags": np.zeros(n, np.uint8),
        "edgeFrom": np.arange(n, dtype=np.uint32),
        "laneEdge": np.arange(n, dtype=np.uint32),
        "laneAllow": np.full(n, 16, np.uint16),
        "laneLength": np.asarray(lengths, np.float32),
        "laneSpeed": np.full(n, 20.0, np.float32),
        "linkFrom": np.asarray([a for a, _ in links], np.uint32),
        "linkTo": np.asarray([b for _, b in links], np.uint32),
        "linkVia": np.full(len(links), 0xFFFFFFFF, np.uint32),
    }
    return net, {"flags": {"internal": 1}}


def test_trains_take_the_platform_their_track_leads_to():
    # The train comes in on edge 0. The station after has two platforms: edge 2, nearest
    # the station, which the train can reach only by backing out of a 2 km siding (3, 4),
    # and edge 1, a little further off, straight ahead. Edge 5 leads nowhere.
    graph = TrackGraph(
        *rail_net([1000, 500, 500, 2000, 2000, 500], [(0, 1), (0, 3), (3, 4), (4, 2)]), 16
    )
    assert abs(graph.between(0, 0.5, 1, 0.5) - 37.5) < 0.01
    assert abs(graph.between(0, 0.5, 2, 0.5) - 237.5) < 0.01
    assert graph.between(1, 0.5, 0, 0.5) == np.inf
    picked = quickest_tracks(
        graph,
        [[(0, 0.5, 0.0)], [(2, 0.5, 0.0), (1, 0.5, 4.0)], [(5, 0.5, 0.0)]],
    )
    assert picked == [(0, 0.5), (1, 0.5), None]
    # A station no track leads to from the one before is left out, not the trip.
    assert quickest_tracks(graph, [[(5, 0.5, 0.0)], [(0, 0.2, 0.0)], [(1, 0.5, 0.0)]]) == [
        None,
        (0, 0.2),
        (1, 0.5),
    ]


def test_line_patterns_keep_the_main_ways_a_line_runs():
    from pipeline.transit import NO_STOP, line_patterns

    def trip(route, stops, headsign):
        return (0.0, 3, route, [(0, 0.0, 0.0, None)] * len(stops), headsign)

    # Line 0: ten trips each way, one short working; a train (line 1) entering the map.
    trips = [trip(0, [0, 1, 2], "East")] * 10 + [trip(0, [2, 1, 0], "West")] * 10
    trips += [trip(0, [0, 1], "Depot")]
    trips += [trip(1, [NO_STOP, 5, 6], "Dugo Selo")]
    refs = np.array(
        [
            r
            for t in trips
            for r in (
                [0, 1, 2]
                if t[4] == "East"
                else [2, 1, 0]
                if t[4] == "West"
                else [0, 1]
                if t[4] == "Depot"
                else [NO_STOP, 5, 6]
            )
        ],
        np.uint32,
    )
    lines = line_patterns(trips, refs)
    assert [line["route"] for line in lines] == [0, 1]
    assert lines[0]["trips"] == 21
    # The short working has under 5 % of the trips: left out.
    assert [(p["headsign"], p["stops"], p["trips"]) for p in lines[0]["patterns"]] == [
        ("East", [0, 1, 2], 10),
        ("West", [2, 1, 0], 10),
    ]
    # Where a train crosses the map's edge names no stop.
    assert lines[1]["patterns"][0]["stops"] == [5, 6]
