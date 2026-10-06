import numpy as np

from pipeline.config import ORIGIN_E, ORIGIN_N
from pipeline.simnet import (
    ALL_BITS,
    VCLASS_BITS,
    encode_polylines,
    internal_edge_junction,
    parse_shape,
    permissions,
    response_words,
)


def test_parse_shape_maps_to_scene_axes_with_elevation():
    text = f"{ORIGIN_E + 100},{ORIGIN_N + 200} {ORIGIN_E},{ORIGIN_N},6.5"
    assert parse_shape(text) == [(100.0, -200.0, 0.0), (0.0, 0.0, 6.5)]


def test_permissions():
    assert permissions(None, None) == ALL_BITS
    assert permissions("tram", None) == VCLASS_BITS["tram"]
    no_rail = permissions(None, "tram rail_urban rail rail_electric rail_fast subway pedestrian")
    assert no_rail & VCLASS_BITS["passenger"]
    assert not no_rail & (VCLASS_BITS["tram"] | VCLASS_BITS["rail"] | VCLASS_BITS["pedestrian"])
    # Disallowing only "coach" keeps buses: "bus" is still allowed.
    assert permissions(None, "coach") & VCLASS_BITS["bus"]


def test_internal_edge_junction_keeps_underscores_in_junction_ids():
    assert internal_edge_junction(":1234_5") == "1234"
    assert internal_edge_junction(":cluster_1_2_7") == "cluster_1_2"


def test_response_words_reads_rightmost_char_as_link_zero():
    assert response_words("0110", 4) == [0b0110]
    assert response_words("1" + "0" * 32, 33) == [0, 1]


def test_encode_polylines_round_trips_and_splits_long_steps():
    shapes = [[(0.0, 0.0, 0.0), (1.5, -2.25, 6.0)], [], [(10.0, 0.0, 0.0), (1010.0, 0.0, 0.0)]]
    enc = encode_polylines(shapes)
    offsets = enc["offsets"]
    assert list(offsets[:3]) == [0, 2, 2]
    assert offsets[3] - offsets[2] > 2  # 1 km step split into int16-sized pieces
    delta = enc["delta"].reshape(-1, 2).astype(np.int64)
    x = enc["origin"][4] + np.cumsum(delta[offsets[2] : offsets[3], 0])
    assert x[0] == 1000 and x[-1] == 101000
    assert list(enc["elev"][:2]) == [0, 600]
