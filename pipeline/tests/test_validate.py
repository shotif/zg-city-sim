import math

import numpy as np

from pipeline.counts import Station
from pipeline.validate import Placement, band, geh, place_share, report, stuck_places


def test_geh():
    assert geh(100, 100) == 0
    assert math.isclose(geh(150, 100), math.sqrt(2 * 50**2 / 250))
    assert geh(0, 0) == 0


def test_band_matches_the_traffic_map():
    assert [band(s) for s in (0.9, 0.5, 0.3, 0.1)] == ["flowing", "slow", "congested", "jammed"]


def test_place_share_weights_by_length_and_skips_empty_edges():
    speeds = np.array([254, 127, 255], np.uint8)
    length = np.array([100.0, 300.0, 50.0])
    assert math.isclose(place_share(speeds, np.array([0, 1, 2]), length), (100 + 150) / 400)
    assert math.isnan(place_share(speeds, np.array([2]), length))


def test_report_separates_inputs_from_independent_checks():
    hourly = np.full(24, 1000.0)
    # A working day of 30,000 (1,250 an hour on weekdays), spread evenly over the hours.
    week = (1250.0,) * 5 + (900.0, 700.0)
    placed = [
        Placement(Station(1, "Edge", "A1", 20_000, (15.8, 45.7)), [1, 2], 30.0),
        Placement(
            Station(
                2,
                "Inside",
                "D1",
                28_000,
                (15.9, 45.8),
                hourly_rest=(1100.0,) * 24,
                weekday_rest=week,
            ),
            [3, 4],
            12.0,
        ),
    ]
    for p in placed:
        p.hourly = hourly
    day = {
        "departed": 1000,
        "arrived": 990,
        "removed": 5,
        "noRoute": 1,
        "notInserted": 2,
        "hours": [
            {
                "hour": h,
                "running": 10 * h,
                "outside": h,
                "stopped": 1,
                "meanSpeedKmh": 40.0,
                "departed": 40,
                "tripMinutes": 15.0,
                "tripKm": 8.0,
            }
            for h in range(24)
        ],
    }
    text = report(placed, [], day, inputs={1})
    independent = text.split("### Independent checks")[1].split("### Roads that leave")[0]
    assert "2 Inside" in independent and "1 Edge" not in independent
    # 24,000 simulated against 30,000 on a working day; 1,000 an hour against 1,250 is GEH
    # 7.5, so no hour is within GEH 5.
    assert "| 28,000 | 30,000 | 24,000 | -20% | 37 | 0/24 | 12 m |" in independent
    assert "0% of the station-hours have GEH below 5" in text
    assert "Busiest hour: 23:00" in text
    assert "At full demand" not in text

    stuck = [("Slavonska avenija", 300), ("Ulica kneza Branimira", 54)]
    text = report(placed, [], {**day, "removed": 400}, stuck=stuck)
    assert "account for 354 of the 400 removed" in text
    assert "| Slavonska avenija | 300 |" in text

    # A run of 80 % of the demand is compared at full demand: 30,000 against 30,000, and
    # every hour within GEH 5.
    text = report(placed, [], {**day, "demandScale": 0.8}, inputs={1})
    assert "| 30,000 | 24,000 | 30,000 | +0% | 0 | 24/24 |" in text
    assert "simulates 80% of the estimated demand" in text


def test_stuck_places_name_each_road_by_the_junction_it_leads_to():
    # Edges 0-2 lead to junction 0, where edge 3 (Savska) also comes in; edge 4 to junction 1.
    net = {
        "edgeName": np.array([0, 1, 0, 3, 2]),
        "edgeRef": np.array([5, 0, 5, 5, 5]),
        "edgeType": np.array([0, 0, 0, 0, 1]),
        "edgeTo": np.array([0, 0, 0, 0, 1]),
        "edgeLaneStart": np.arange(5),
        "laneEdge": np.arange(5),
        "linkFrom": np.array([0, 1, 2, 3, 4]),
        "linkJunction": np.array([0, 0, 0, 0, 1]),
    }
    index = {
        "names": ["Ulica Isidora Kršnjavoga", "", "", "Savska cesta"],
        "refs": ["D1"],
        "types": ["highway.secondary", "railway.tram"],
    }
    day = {"removedAt": [[0, 10], [1, 4], [2, 5], [4, 3]]}
    assert stuck_places(net, index, day) == [
        ("Ulica Isidora Kršnjavoga at Savska cesta", 15),
        ("D1 at Savska cesta / Ulica Isidora Kršnjavoga", 4),
        ("tram tracks", 3),
    ]
