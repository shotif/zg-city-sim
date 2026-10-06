import numpy as np
import pytest
import shapely

from pipeline.demand import (
    DISTRICT_POPULATION,
    LANDUSE_CLASSES,
    attach,
    classify_landuse,
    district_of,
    district_population,
    outer_rings,
    spread,
    storeys,
    use_shares,
)


def test_outer_rings_area_and_centroid():
    # A 10 m x 20 m rectangle at (100, 50) and a 4 m x 4 m square at (0, 0), delta-encoded
    # in centimetres with a zero first step, as pipeline/buildings.py writes them.
    origin = np.array([10000, 5000, 0, 0], np.int32)
    offsets = np.array([0, 4, 8], np.uint32)
    deltas = np.array([0, 0, 1000, 0, 0, 2000, -1000, 0, 0, 0, 400, 0, 0, 400, -400, 0], np.int16)
    area, cx, cz = outer_rings(origin, offsets, deltas, np.array([0, 1]))
    np.testing.assert_allclose(area, [200.0, 16.0])
    np.testing.assert_allclose(cx, [105.0, 2.0])
    np.testing.assert_allclose(cz, [60.0, 2.0])


def test_storeys_from_levels_or_wall_height():
    np.testing.assert_array_equal(
        storeys(np.array([3, 0, 0]), np.array([20.0, 7.0, 1.0])), [3, 2, 1]
    )


def test_use_shares():
    kinds = [
        "house",
        "residential",
        "commercial",
        "industrial",
        "civic",
        "religious",
        "minor",
        "other",
    ]
    # house; office; garage; unknown in industrial area; unknown big low hall; unknown small
    # with no land use; house in the centre.
    kind = np.array([0, 2, 6, 7, 7, 7, 0])
    landuse = np.array([-1, -1, -1, LANDUSE_CLASSES.index("industrial"), -1, -1, -1])
    area = np.array([100, 500, 20, 800, 5000, 150, 100.0])
    eave = np.array([6, 12, 3, 8, 9, 6, 6.0])
    centre = np.array([False] * 6 + [True])
    home, work = use_shares(kinds, kind, landuse, area, eave, centre)
    np.testing.assert_allclose(home, [1, 0, 0, 0, 0, 0.8, 0.7])
    np.testing.assert_allclose(work, [0, 1, 0, 1, 1, 0.2, 0.3])


def test_spread_matches_each_zones_total():
    floor = np.array([100.0, 300.0, 200.0, 600.0, 50.0])
    zone = np.array([0, 0, 1, 1, 2])
    # Zone 3 has no floor area: its total is dropped rather than divided by zero.
    np.testing.assert_allclose(spread(floor, zone, [1000, 80, 5, 7]), [250, 750, 20, 60, 5])


def test_district_population_matches_names_loosely():
    names = list(DISTRICT_POPULATION)
    names[0] = names[0].upper()
    names[5] = "Gornji grad – Medveščak"
    population = district_population(names[::-1])
    assert population[::-1] == list(DISTRICT_POPULATION.values())
    assert sum(population) == 767_131


def test_district_population_rejects_unknown_or_missing_districts():
    with pytest.raises(ValueError):
        district_population([*list(DISTRICT_POPULATION)[:-1], "Novi Zagreb"])
    with pytest.raises(ValueError):
        district_population(list(DISTRICT_POPULATION)[:-1])


def test_district_of_falls_back_to_the_nearest_district():
    west = shapely.box(0, 0, 10, 10)
    east = shapely.box(10.5, 0, 20, 10)
    x = np.array([5.0, 15.0, 10.4, 10.2])
    z = np.array([5.0, 5.0, 5.0, 5.0])
    np.testing.assert_array_equal(district_of(x, z, np.array([west, east])), [0, 1, 1, 0])


def test_classify_landuse_prefers_work_classes_where_areas_overlap():
    residential = shapely.box(0, 0, 100, 100)
    school = shapely.box(10, 10, 20, 20)
    out = classify_landuse(
        np.array([15.0, 50.0, 500.0]),
        np.array([15.0, 50.0, 500.0]),
        [residential, school],
        [LANDUSE_CLASSES.index("residential"), LANDUSE_CLASSES.index("civic")],
    )
    np.testing.assert_array_equal(
        out, [LANDUSE_CLASSES.index("civic"), LANDUSE_CLASSES.index("residential"), -1]
    )


def test_attach_prefers_local_streets_nearby():
    lines = np.array(
        [shapely.LineString([(0, 0), (100, 0)]), shapely.LineString([(0, 10), (100, 10)])],
        dtype=object,
    )
    edges = np.array([7, 9])
    local = np.array([False, True])  # edge 7 is an arterial, edge 9 a local street
    # Closer to the arterial, but the local street is within reach; then a far point.
    out = attach(np.array([50.0, 50.0]), np.array([-1.0, -5000.0]), edges, lines, local)
    np.testing.assert_array_equal(out, [9, -1])
