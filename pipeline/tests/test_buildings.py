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
