import numpy as np
import shapely

from pipeline.cycling import cycle_share, segments


def test_a_cycle_track_along_a_lane_covers_it():
    # A lane along x for 100 m, a side street's lane along y.
    lines = np.array(
        [
            shapely.LineString([(0, 0), (100, 0)]),
            shapely.LineString([(200, 0), (200, 100)]),
        ],
        dtype=object,
    )
    lanes = (np.arange(2), np.arange(2), np.array([100.0, 100.0]), lines)
    # A cycle track 5 m beside the first lane for its first 60 m, drawn the other way; a
    # cycle path crossing the side street.
    track = shapely.LineString([(60, 5), (0, 5)])
    across = shapely.LineString([(180, 50), (220, 50)])
    pieces, dirs = segments([track, across])
    share = cycle_share(lanes, pieces, dirs)
    # Samples every 10 m; the one at 65 m is within reach of the track's end.
    np.testing.assert_allclose(share, [0.7, 0.0])


def test_a_cycle_track_too_far_away_does_not_count():
    lines = np.array([shapely.LineString([(0, 0), (100, 0)])], dtype=object)
    lanes = (np.arange(1), np.arange(1), np.array([100.0]), lines)
    pieces, dirs = segments([shapely.LineString([(0, 20), (100, 20)])])
    assert cycle_share(lanes, pieces, dirs)[0] == 0
