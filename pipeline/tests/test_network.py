from pipeline.config import ORIGIN_E, ORIGIN_N
from pipeline.network import to_scene


def test_to_scene_maps_projected_points_to_scene_axes():
    # 100 m east and 200 m north of the origin, 6 m elevation offset
    assert to_scene([(ORIGIN_E + 100, ORIGIN_N + 200, 6.0)]) == [(100.0, -200.0, 6.0)]
    assert to_scene([(ORIGIN_E, ORIGIN_N)]) == [(0.0, 0.0, 0.0)]
