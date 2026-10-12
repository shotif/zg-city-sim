"""Lanes OpenStreetMap marks as merging, where the way after them is wider (M14b)."""

from pipeline.network import unfinished_merges


def way(nodes, lanes, turns=None):
    tags = {"highway": "motorway", "oneway": "yes", "lanes": str(lanes)}
    if turns:
        tags["turn:lanes"] = turns
    return (nodes, tags)


def test_merges_into_a_wider_way_run_on():
    ways = {
        # A toll plaza narrowing: four of seven lanes marked as merging, then six lanes.
        1: way([1, 2], 7, "none|none|none|merge_to_left|merge_to_left|merge_to_left|merge_to_left"),
        2: way([2, 3], 6, "none|none|merge_to_left|merge_to_left|merge_to_left|merge_to_left"),
        # An on-ramp's lane that ends where the road narrows to the lanes that run on.
        3: way([3, 4], 3, "none|none|merge_to_left"),
        4: way([4, 5], 2),
    }
    assert unfinished_merges(ways) == {1, 2}


def test_a_merge_at_the_end_of_the_map_stays():
    assert unfinished_merges({1: way([1, 2], 3, "none|none|merge_to_left")}) == set()
