import pytest

from pipeline.buildings import estimate_height, parse_metres


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("12", 12.0),
        ("12.5 m", 12.5),
        ("12,5", 12.5),
        ("40'", 40 * 0.3048),
        (None, None),
        ("x", None),
    ],
)
def test_parse_metres(value, expected):
    assert parse_metres(value) == (pytest.approx(expected) if expected else None)


def test_estimate_height_prefers_storeys():
    assert estimate_height("residential", 500, levels=6, roof_levels=None) == pytest.approx(19.0)


def test_estimate_height_by_type_and_size():
    assert estimate_height("minor", 30, None, None) == 3.0
    assert estimate_height("house", 120, None, None) == 7.5
    assert estimate_height("other", 100, None, None) < estimate_height("other", 2000, None, None)


def test_roof_from_volume_tells_flat_pitched_and_towers_apart():
    import numpy as np

    from pipeline.buildings import roof_from_volume

    ridge = np.array([20.0, 9.0, 103.5])
    mean = np.array([19.5, 7.5, 35.9])  # box, house, cathedral with spires
    top, wall, pitched = roof_from_volume(ridge, mean)
    assert list(pitched) == [False, True, False]
    assert top[0] == wall[0] == 20.0
    assert top[1] == 9.0 and wall[1] == pytest.approx(6.0)
    assert top[2] == wall[2] == pytest.approx(35.9)


def test_covers_other_buildings_flags_block_outlines():
    import numpy as np
    import shapely

    from pipeline.buildings import covers_other_buildings

    block = shapely.box(0, 0, 200, 200)
    houses = [shapely.box(10 + 40 * i, 10, 30 + 40 * i, 30) for i in range(4)]
    hall = shapely.box(300, 0, 400, 50)  # big but standalone
    parts = np.array([block, *houses, hall], dtype=object)
    flagged = covers_other_buildings(parts, shapely.area(parts))
    assert list(flagged) == [True, False, False, False, False, False]
