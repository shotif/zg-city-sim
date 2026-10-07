import numpy as np
import shapely

from pipeline.zoning import (
    DEPTH,
    FRONTAGE,
    NO_EDGE,
    NO_PLAN,
    PLAN_IDS,
    SIDEWALK,
    make_lots,
    plan_arrays,
    plan_class,
)

INTERNAL, HAS_OPPOSITE = 16, 4
WIDTH = 3.2


def network(edges: list[dict]) -> tuple[dict[str, np.ndarray], dict]:
    """A packed network of one-lane edges: each {points, type, speed, flags}."""
    origin, delta, offsets = [], [], [0]
    for e in edges:
        pts = np.round(np.asarray(e["points"], float) * 100).astype(np.int64)
        origin.append(pts[0])
        steps = np.diff(pts, axis=0, prepend=pts[:1])
        delta.extend(steps)
        offsets.append(offsets[-1] + len(pts))
    lengths = [
        float(np.hypot(*np.diff(np.asarray(e["points"], float), axis=0).T).sum()) for e in edges
    ]
    n = len(edges)
    net = {
        "edgeFlags": np.array([e.get("flags", 0) for e in edges], np.uint8),
        "edgeType": np.array([e.get("type", 0) for e in edges], np.uint16),
        "edgeLaneStart": np.arange(n, dtype=np.uint32),
        "edgeLaneCount": np.ones(n, np.uint8),
        "laneAllow": np.ones(n, np.uint16),
        "laneLength": np.array(lengths, np.float32),
        "laneSpeed": np.array([e.get("speed", 13.9) for e in edges], np.float32),
        "laneWidth": np.full(n, WIDTH, np.float32),
        "laneShapeOffsets": np.array(offsets, np.uint32),
        "laneShapeOrigin": np.array(origin, np.int32).reshape(-1),
        "laneShapeDelta": np.array(delta, np.int16).reshape(-1),
    }
    index = {
        "types": ["highway.residential", "highway.motorway"],
        "flags": {"internal": INTERNAL, "hasOpposite": HAS_OPPOSITE},
        "vclassBits": {"passenger": 1},
    }
    return net, index


def town():
    """Ulica runs east from (0, 0) to (300, 0), both ways; Jednosmjerna one way north from
    (400, 200) to (400, 0)... and a motorway 200 m north. A house stands south of Ulica at
    x 100-115; a park the plan keeps covers Ulica's north side east of x 200; a pond lies
    south of Ulica's west end; the rest of the south side is planned for housing."""
    net, index = network(
        [
            {"points": [(0, 0), (300, 0)], "flags": HAS_OPPOSITE},
            {"points": [(300, 0), (0, 0)], "flags": HAS_OPPOSITE},
            {"points": [(400, 200), (400, 0)]},
            {"points": [(0, -200), (300, -200)], "type": 1, "speed": 30.0},
        ]
    )
    house = shapely.box(100, 8, 115, 20)
    park = shapely.box(200, -60, 320, -1)
    housing = shapely.box(-50, 1, 320, 80)
    plan = (np.array([park, housing]), np.array([PLAN_IDS["green"], PLAN_IDS["residential"]]))
    # Land cover at 10 m from (-100, -300): water under x 0-40, z 10-50.
    grid = np.full((60, 70), 30, np.uint8)
    grid[(10 + 300) // 10 : (50 + 300) // 10, (0 + 100) // 10 : (40 + 100) // 10] = 80
    cover = (grid, 10.0, -100.0, -300.0)
    points = (np.array([[107.0, 14.0]]), np.array([2.0]))
    return net, index, np.array([house]), plan, cover, points, house, park


def lot_shapes(lots: dict[str, np.ndarray]) -> np.ndarray:
    """Lot rectangles from their centre, direction, frontage and depth, as the app makes them."""
    u = np.column_stack([np.cos(lots["lotAngle"]), np.sin(lots["lotAngle"])])
    right = np.column_stack([-u[:, 1], u[:, 0]])
    c = np.column_stack([lots["lotX"], lots["lotZ"]])
    f = lots["lotFrontage"][:, None] / 2
    d = lots["lotDepth"][:, None] / 2
    corners = np.stack([c - u * f - right * d, c + u * f - right * d, c + u * f + right * d,
                        c - u * f + right * d], axis=1)  # fmt: skip
    return shapely.polygons(corners)


def test_lots_line_free_land_along_streets():
    net, index, footprints, plan, cover, points, house, park = town()
    lots = make_lots(net, index, footprints, plan, cover, points)
    stats = lots.pop("_stats")
    shapes = lot_shapes(lots)
    assert stats["lots"] == len(shapes) > 10
    # Lots front their street a pavement's width from its lane, both sides of Ulica.
    ulica = shapely.LineString([(0, 0), (300, 0)])
    on_ulica = np.isin(lots["lotEdge"], [0, 1])
    near = shapely.distance(shapes[on_ulica], ulica)
    assert np.allclose(near, WIDTH / 2 + SIDEWALK, atol=0.05)
    south = on_ulica & (lots["lotZ"] > 0)
    assert south.any() and (on_ulica & (lots["lotZ"] < 0)).any()
    # Ulica eastbound's lots are on its right (south), westbound's on the north.
    assert np.all(lots["lotZ"][lots["lotEdge"] == 0] > 0)
    assert np.all(lots["lotZ"][lots["lotEdge"] == 1] < 0)
    assert np.allclose(lots["lotFrontage"], FRONTAGE) and np.all(lots["lotDepth"] == DEPTH)
    # A one-way street has lots on both sides; the motorway has none.
    one_way = lots["lotX"][lots["lotEdge"] == 2]
    assert (one_way < 400).any() and (one_way > 400).any()
    assert not np.any(lots["lotEdge"] == 3)
    # Clear of the house, the park and the pond, and of each other.
    assert not shapely.intersects(shapes, house.buffer(1.9)).any()
    assert not shapely.within(shapely.centroid(shapes), park).any()
    pond = shapely.box(0, 10, 40, 50)
    assert not (shapely.area(shapely.intersection(shapes, pond)) > 1.0).any()
    for k, s in enumerate(shapes):
        others = np.delete(shapes, k)
        assert not (shapely.area(shapely.intersection(others, s)) > 1.0).any()
    # Planned use and context: housing south of Ulica, no plan east of it; the house's
    # two storeys around it.
    assert np.all(lots["lotPlan"][south] == PLAN_IDS["residential"])
    assert np.all(lots["lotPlan"][lots["lotEdge"] == 2] == NO_PLAN)
    by_house = np.hypot(lots["lotX"] - 107, lots["lotZ"] - 14) < 150
    assert np.all(lots["lotContext"][by_house] == 2)
    assert np.all(lots["lotContext"][~by_house] == 0)


def test_lots_know_the_green_around_them_and_loud_roads_near():
    net, index, footprints, plan, cover, points, *_ = town()
    grid = cover[0].copy()
    grid[:, (200 + 100) // 10 :] = 50  # built up east of x 200
    lots = make_lots(net, index, footprints, plan, (grid, *cover[1:]), points)
    lots.pop("_stats")
    west = lots["lotX"] < 100
    east = lots["lotX"] > 380
    assert west.any() and east.any()
    assert lots["lotGreen"][west].min() > 60 and lots["lotGreen"][east].max() < 15
    # The motorway 200 m north of Ulica is the loud road near it, as the crow flies.
    road = shapely.LineString([(0, -200), (300, -200)])
    d = shapely.distance(shapely.points(np.column_stack([lots["lotX"], lots["lotZ"]])), road)
    near = d < 249
    assert near.any() and (d > 251).any()
    assert np.all(lots["lotLoudEdge"][near] == 3)
    assert np.allclose(lots["lotLoudDistance"][near], np.round(d[near]), atol=1)
    assert np.all(lots["lotLoudEdge"][d > 251] == NO_EDGE)


def test_plan_uses_are_grouped():
    assert plan_class("Stambena namjena", "Pretežito stambena namjena") == PLAN_IDS["residential"]
    assert (
        plan_class("Mješovita namjena - pretežito stambena", "Pretežito stambena namjena")
        == (PLAN_IDS["mixed"])
    )
    assert (
        plan_class("Mješovita namjena - pretežito poslovna", "Pretežito poslovna namjena")
        == (PLAN_IDS["commercial"])
    )
    assert plan_class("Gospodarska namjena - poslovna", "Gospodarska namjena") == PLAN_IDS["office"]
    assert (
        plan_class("Gospodarska namjena - proizvodna", "Gospodarska namjena")
        == (PLAN_IDS["industrial"])
    )
    assert (
        plan_class("Gospodarska namjena - trgovački kompleksi", "Gospodarska namjena")
        == (PLAN_IDS["commercial"])
    )
    assert (
        plan_class("Javne zelene površine - javni park", "Javne zelene površine")
        == (PLAN_IDS["green"])
    )
    assert plan_class("Groblje", "Groblje") == PLAN_IDS["green"]
    assert (
        plan_class("Ostale poljoprivredne površine", "Poljoprivredne površine")
        == (PLAN_IDS["agricultural"])
    )
    assert (
        plan_class("Javna i društvena namjena - školska", "Javna i društvena namjena")
        == (PLAN_IDS["civic"])
    )
    assert plan_class("Benzinska postaja", "Prometne površine") == PLAN_IDS["transport"]


def test_plan_outlines_for_the_app():
    yard = shapely.Polygon(
        [(0, 0), (100, 0), (100, 100), (0, 100)], [[(40, 40), (60, 40), (60, 60)]]
    )
    two = shapely.MultiPolygon([shapely.box(200, 0, 210, 10), shapely.box(220, 0, 230, 10)])
    out = plan_arrays(np.array([yard, two]), np.array([1, 2], np.uint8))
    assert list(out["planClass"]) == [1, 2, 2]
    # The yard has an outer ring and a hole; the others one ring each.
    assert list(np.diff(out["planPolygonRings"])) == [2, 1, 1]
    assert out["planRingPoints"][-1] * 2 == len(out["planPoints"])
