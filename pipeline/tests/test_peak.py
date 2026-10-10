import json

import numpy as np

from pipeline.peak import UNKNOWN, edge_middles, peak_shares
from pipeline.simnet import encode_polylines

INTERNAL = 16


def two_ways() -> dict[str, np.ndarray]:
    """A road both ways, 100 m along x (eastbound, then westbound 3.5 m beside it), and a
    junction's internal edge."""
    shapes = [
        [(0.0, 0.0, 0.0), (60.0, 0.0, 0.0), (100.0, 0.0, 0.0)],
        [(100.0, 3.5, 0.0), (0.0, 3.5, 0.0)],
        [(100.0, 0.0, 0.0), (102.0, 1.0, 0.0)],
    ]
    enc = encode_polylines(shapes)
    return {
        "edgeFlags": np.array([0, 0, INTERNAL], np.uint8),
        "edgeLaneStart": np.array([0, 1, 2], np.uint32),
        "edgeLaneCount": np.array([1, 1, 1], np.uint8),
        "laneAllow": np.array([1, 1, 1], np.uint16),
        "laneShapeOrigin": enc["origin"],
        "laneShapeOffsets": enc["offsets"],
        "laneShapeDelta": enc["delta"],
    }


def test_edges_are_found_by_their_middle_and_the_way_they_run(tmp_path):
    arrays = two_ways()
    x, z, heading = edge_middles(arrays, np.array([0, 1]))
    assert np.allclose(x, [50, 50]) and np.allclose(z, [0, 3.5])
    assert np.allclose(heading, [0, 180])
    # A slow piece eastbound: the westbound road beside it, 3.5 m away, is not it.
    path = tmp_path / "peak.json"
    path.write_text(json.dumps({"edges": [[51, 1, 2, 40]]}))
    assert list(peak_shares(arrays, INTERNAL, path)) == [40, UNKNOWN, UNKNOWN]
    # Without the file, every road is as fast as its limit allows.
    assert set(peak_shares(arrays, INTERNAL, tmp_path / "none.json")) == {UNKNOWN}
