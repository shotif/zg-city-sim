from pipeline.config import (
    GROUND_RESOLUTION,
    ORIGIN_E,
    ORIGIN_N,
    TERRAIN_RESOLUTION,
    WORLD,
    Extent,
)


def test_world_grids_are_whole_cells():
    assert WORLD.grid(TERRAIN_RESOLUTION) == (1920, 2000)
    assert WORLD.grid(GROUND_RESOLUTION) == (2400, 2500)


def test_origin_inside_world():
    assert WORLD.min_e < ORIGIN_E < WORLD.max_e
    assert WORLD.min_n < ORIGIN_N < WORLD.max_n


def test_grid_rejects_partial_cells():
    import pytest

    with pytest.raises(ValueError):
        Extent(0, 0, 100, 100).grid(30)
