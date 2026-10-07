"""Lane counts taken from neighbouring ways where OpenStreetMap gives none."""

from pipeline.network import infer_lanes


def way(nodes, **tags):
    return (nodes, {"highway": "secondary", "name": "Slavonska avenija", "oneway": "yes", **tags})


def test_an_untagged_way_between_two_lane_ways_gets_two_lanes():
    ways = {
        1: way([1, 2], lanes="2"),
        2: way([2, 3]),
        3: way([3, 4]),
        4: way([4, 5], lanes="3"),
    }
    # Each untagged way takes the fewest lanes of the ways at its ends that have a count.
    assert infer_lanes(ways) == {2: 2, 3: 3}


def test_only_the_same_road_class_and_direction_count():
    ways = {
        1: way([1, 2], lanes="3", highway="primary"),
        2: way([2, 3]),
        3: way([3, 4], lanes="2", oneway="no"),
        4: way([5, 6], name="Other"),
    }
    assert infer_lanes(ways) == {}


def test_two_way_roads_need_more_than_one_lane_each_way():
    ways = {
        1: way([1, 2], lanes="2", oneway="no"),
        2: way([2, 3], oneway="no"),
        3: way([3, 4], lanes="4", oneway="no"),
        4: way([4, 5], oneway="no"),
    }
    # Two lanes on a two-way road is netconvert's default already.
    assert infer_lanes(ways) == {4: 4}
