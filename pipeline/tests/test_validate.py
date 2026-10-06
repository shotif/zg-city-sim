import math

import numpy as np

from pipeline.counts import Station
from pipeline.validate import Placement, band, geh, place_share, report, stuck_roads


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
    placed = [
        Placement(Station(1, "Edge", "A1", 20_000, (15.8, 45.7), (15.7, 45.6)), [1, 2], 30.0),
        Placement(Station(2, "Inside", "D1", 30_000, (15.9, 45.8)), [3, 4], 12.0),
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
    text = report(placed, [], day)
    independent = text.split("### Independent checks")[1].split("### Roads that leave")[0]
    assert "2 Inside" in independent and "1 Edge" not in independent
    # 24,000 simulated against 30,000 counted.
    assert "| 30,000 | 24,000 | -20% |" in independent
    assert "Busiest hour: 23:00" in text
    assert "At full demand" not in text

    stuck = [("Slavonska avenija", 300), ("Ulica kneza Branimira", 54)]
    text = report(placed, [], {**day, "removed": 400}, stuck=stuck)
    assert "account for 354 of the 400 removed" in text
    assert "| Slavonska avenija | 300 |" in text

    # A run of half the demand is compared at full demand: 48,000 against 30,000.
    text = report(placed, [], {**day, "demandScale": 0.5})
    assert "| 30,000 | 24,000 | 48,000 | +60% |" in text
    assert "simulates 50% of the estimated demand" in text


def test_stuck_roads_sums_the_edges_of_each_road():
    net = {"edgeName": np.array([0, 1, 0, 2]), "edgeRef": np.array([5, 0, 5, 5])}
    index = {"names": ["Slavonska avenija", "", ""], "refs": ["D1"]}
    day = {"removedAt": [[0, 10], [1, 4], [2, 5], [3, 1]]}
    assert stuck_roads(net, index, day) == [
        ("Slavonska avenija", 15),
        ("D1", 4),
        ("unnamed road", 1),
    ]
