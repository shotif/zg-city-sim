from pathlib import Path

import osmium

from pipeline.network import filter_roads
from pipeline.projects import NEW_ID, Bridge, Extend, Planner, Project


def write_map(path: Path) -> Path:
    """A dual carriageway, Avenija, east-west at 45.8000 and 45.8002 (about 22 m apart); a
    street, Ulica, east-west at 45.7994; and a proposed road from the south (45.7980) that
    stops 11 m short of Avenija, crossing Ulica on the way."""
    nodes = {
        1: (15.99, 45.8000),
        2: (16.01, 45.8000),
        3: (16.01, 45.8002),
        4: (15.99, 45.8002),
        5: (15.995, 45.7994),
        6: (16.005, 45.7994),
        11: (16.0, 45.7980),
        12: (16.0, 45.7990),
        13: (16.0, 45.7999),
    }
    ways = {
        1: ([1, 2], {"highway": "secondary", "name": "Avenija", "oneway": "yes"}),
        2: ([3, 4], {"highway": "secondary", "name": "Avenija", "oneway": "yes"}),
        3: ([5, 6], {"highway": "tertiary", "name": "Ulica"}),
        10: ([11, 12, 13], {"highway": "proposed", "proposed": "secondary"}),
    }
    writer = osmium.SimpleWriter(str(path), overwrite=True)
    for n, (lon, lat) in nodes.items():
        writer.add_node(osmium.osm.mutable.Node(location=(lon, lat), id=n, version=1))
    for w, (refs, tags) in ways.items():
        writer.add_way(osmium.osm.mutable.Way(nodes=refs, id=w, tags=tags, version=1))
    writer.close()
    return path


PROJECT = Project(
    id="test",
    name="Test road",
    status="",
    summary="",
    sources=(),
    ways={10: {"highway": "primary", "lanes": "4"}},
    extend=(Extend(10, "end", "Avenija"),),
    cross=("Ulica",),
    signals=("Avenija", "Ulica"),
    bridges=(Bridge(10, (16.0, 45.7985), 60.0, "Most"),),
)


def test_project_road_meets_both_carriageways_crosses_and_bridges(tmp_path):
    src = write_map(tmp_path / "map.osm")
    planner = Planner(PROJECT, src)
    patch = planner.plan()
    # Opened with its new tags, without the proposed ones, and split for the bridge: the
    # way keeps the part before it.
    assert patch.ways[10][1] == {"highway": "primary", "lanes": "4"}
    parts = [patch.ways[w][0] for w in sorted(patch.ways) if w == 10 or w >= NEW_ID]
    assert len(parts) == 3 and all(a[-1] == b[0] for a, b in zip(parts, parts[1:], strict=False))
    road = [n for part in parts for n in part]
    # Carried on across both carriageways: it ends on Avenija's far side.
    avenija = [n for w in (1, 2) for n in planner.ways[w]]
    assert road[-1] in planner.ways[2] and road[-2] in planner.ways[1]
    assert len(set(road) & set(avenija)) == 2
    # A junction with Ulica where they cross.
    crossing = set(road) & set(planner.ways[3])
    assert len(crossing) == 1
    (node,) = crossing
    assert abs(planner.pos[node][1] - 45.7994) < 1e-6
    # Signals at the three junctions.
    signals = {n for n, (_, _, tags) in patch.nodes.items() if tags.get("highway")}
    assert signals == set(road) & (set(avenija) | crossing)
    # The southern end is a 60 m bridge of its own, the rest stays a road.
    bridges = [w for w, (_, tags) in patch.ways.items() if tags.get("bridge") == "yes"]
    assert len(bridges) == 1 and bridges[0] >= NEW_ID
    deck = patch.ways[bridges[0]]
    assert deck[1]["name"] == "Most" and deck[1]["layer"] == "1"
    lats = [planner.pos[n][1] for n in deck[0]]
    assert abs((max(lats) - min(lats)) * 111_320 - 60) < 1.0


def test_patched_map_has_the_new_ways_and_nodes(tmp_path):
    src = write_map(tmp_path / "map.osm")
    patch = Planner(PROJECT, src).plan()
    out = tmp_path / "roads.osm"
    stats = filter_roads(src, out, patch)
    ways = {w.id: dict(w.tags) for w in osmium.FileProcessor(str(out), osmium.osm.WAY)}
    nodes = {n.id: dict(n.tags) for n in osmium.FileProcessor(str(out), osmium.osm.NODE)}
    assert ways[10]["highway"] == "primary"
    assert any(t.get("bridge") == "yes" for t in ways.values())
    assert set(patch.nodes) <= set(nodes)
    assert sum(t.get("highway") == "traffic_signals" for t in nodes.values()) == 3
    assert stats["ways"] == len(ways)


def test_ways_missing_from_an_older_extract_are_left_out(tmp_path, caplog):
    src = write_map(tmp_path / "map.osm")
    gone = 99
    project = Project(
        id="test",
        name="Test road",
        status="",
        summary="",
        sources=(),
        ways={10: {"highway": "primary"}, gone: {"highway": "primary"}},
        extend=(Extend(gone, "end", "Avenija"),),
        bridges=(Bridge(gone, (16.0, 45.7985), 60.0),),
    )
    patch = Planner(project, src).plan()
    assert gone not in patch.ways and patch.ways[10][1] == {"highway": "primary"}
    assert "left out: [99]" in caplog.text
    nothing = Project(**{**project.__dict__, "ways": {gone: {"highway": "primary"}}})
    try:
        Planner(nothing, src)
    except ValueError as error:
        assert "none of its ways" in str(error)
    else:
        raise AssertionError("a project with none of its ways is not built")
