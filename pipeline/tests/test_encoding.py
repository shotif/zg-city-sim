import numpy as np
import pytest

from pipeline.encoding import decode_terrain_rgb, encode_terrain_rgb


def test_terrain_rgb_round_trip_keeps_decimetres():
    heights = np.array([[-12.3, 0.0, 112.4], [1033.1, 4807.9, 8848.8]], dtype=np.float32)
    decoded = decode_terrain_rgb(encode_terrain_rgb(heights))
    np.testing.assert_allclose(decoded, heights, atol=0.051)


def test_terrain_rgb_matches_mapbox_reference_value():
    # 0 m encodes as 100000 = 0x0186A0 -> (1, 134, 160)
    rgb = encode_terrain_rgb(np.zeros((1, 1)))
    assert rgb[0, 0].tolist() == [1, 134, 160]


def test_terrain_rgb_rejects_nan():
    with pytest.raises(ValueError):
        encode_terrain_rgb(np.array([[np.nan]]))
