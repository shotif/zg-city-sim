"""Compare a simulated weekday with traffic counts and write docs/VALIDATION.md.

    gunzip -kf web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
    (cd sim && cargo run --release --example day -- ../web/public/data <run_dir>)
    python -m pipeline.validate <run_dir>

The day runner records how many vehicles drove onto every road in every hour. Each count
station is placed on the edges of its road nearest to the station's point, one per
direction, and the simulated vehicles on them are compared with the station's average
annual daily traffic (PGDP).
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import shapely

from .config import OUTPUT_DIR, REPO_ROOT
from .counts import STATIONS, Station
from .gateways import to_scene
from .packed import read_packed

# The opposite carriageway is at most this much further from the station's point (m).
OPPOSITE_SLACK = 150.0
PASSENGER = 1


@dataclass
class Placement:
    station: Station
    edges: list[int]
    #: Distance (m) from the station's point to the nearest counted edge.
    distance: float
    hourly: np.ndarray | None = None

    @property
    def simulated(self) -> float:
        return float(self.hourly.sum()) if self.hourly is not None else float("nan")


def geh(model: float, count: float) -> float:
    """GEH statistic of a modelled and a counted flow."""
    if model + count <= 0:
        return 0.0
    return math.sqrt(2 * (model - count) ** 2 / (model + count))


def edge_line(net: dict[str, np.ndarray], edge: int) -> shapely.LineString:
    """Centre of an edge's rightmost lane (scene x, z)."""
    lane = int(net["edgeLaneStart"][edge])
    offsets = net["laneShapeOffsets"]
    a, b = int(offsets[lane]), int(offsets[lane + 1])
    origin = net["laneShapeOrigin"].reshape(-1, 2)[lane].astype(np.int64)
    steps = net["laneShapeDelta"].reshape(-1, 2)[a:b].astype(np.int64)
    points = (origin + np.cumsum(steps, axis=0)) / 100.0
    if len(points) < 2:
        points = np.vstack([points, points + 0.01])
    return shapely.LineString(points)


def heading_at(line: shapely.LineString, point: shapely.Point) -> np.ndarray:
    """Unit direction of travel along `line` where it passes closest to `point`."""
    s = line.project(point)
    a = line.interpolate(max(0.0, s - 5.0))
    b = line.interpolate(min(line.length, s + 5.0))
    v = np.array([b.x - a.x, b.y - a.y])
    return v / max(float(np.hypot(*v)), 1e-9)


def place(net: dict[str, np.ndarray], index: dict, station: Station) -> Placement | None:
    """The station's counted edges: the nearest edge of its road, and the nearest one
    running the other way (the opposite direction or carriageway), if any."""
    refs = index["refs"]
    if station.road not in refs:
        return None
    internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
    lane0 = net["edgeLaneStart"]
    drivable = (net["laneAllow"][lane0] & PASSENGER) != 0
    candidates = np.flatnonzero((net["edgeRef"] == refs.index(station.road)) & ~internal & drivable)
    if len(candidates) == 0:
        return None
    x, z = to_scene(*station.at)
    point = shapely.Point(x, z)
    lines = [edge_line(net, int(e)) for e in candidates]
    dist = np.array([line.distance(point) for line in lines])
    first = int(np.argmin(dist))
    edges = [int(candidates[first])]
    forward = heading_at(lines[first], point)
    best = None
    for k in np.argsort(dist):
        if dist[k] > dist[first] + OPPOSITE_SLACK:
            break
        if np.dot(heading_at(lines[k], point), forward) < -0.5:
            best = int(candidates[k])
            break
    if best is not None:
        edges.append(best)
    return Placement(station, edges, float(dist[first]))


def read_counts(run_dir: Path) -> np.ndarray:
    """Vehicles that drove onto each edge in each hour of the day: (24, edges)."""
    raw = np.fromfile(run_dir / "edge_counts.bin", dtype="<u4")
    n = int(raw[0])
    return raw[1:].reshape(24, n)


def read_speeds(run_dir: Path) -> np.ndarray | None:
    """Mean speed as a share of the limit on each edge in each hour (0-254, 255 = no
    traffic): (24, edges)."""
    path = run_dir / "edge_speeds.bin"
    if not path.exists():
        return None
    raw = path.read_bytes()
    n = int(np.frombuffer(raw[:4], dtype="<u4")[0])
    return np.frombuffer(raw[4:], dtype=np.uint8).reshape(24, n)


# Hours compared for congestion: the busiest of the morning and of the afternoon.
PEAKS = {"07-08": 7, "16-17": 16}
# Traffic map bands (web/src/world/trafficLayer.ts): share of the speed limit.
BANDS = [(0.7, "flowing"), (0.45, "slow"), (0.2, "congested"), (0.0, "jammed")]
MAIN_ROADS = ("highway.motorway", "highway.trunk", "highway.primary", "highway.secondary")


def band(share: float) -> str:
    return next(name for low, name in BANDS if share >= low)


def place_share(speeds: np.ndarray, edges: np.ndarray, length: np.ndarray) -> float:
    """Length-weighted mean speed share on edges with traffic (nan without)."""
    ratio = speeds[edges].astype(np.float64)
    used = ratio < 255
    if not used.any():
        return float("nan")
    w = length[edges][used]
    return float((ratio[used] / 254 * w).sum() / w.sum())


def hotspot_rows(
    net: dict[str, np.ndarray], index: dict, speeds: np.ndarray
) -> tuple[list[dict], dict[str, float]]:
    """Simulated peak-hour speed at each news hotspot, and the share of main-road length
    that is congested (below 45 % of the limit) in each peak."""
    hotspots = json.loads((OUTPUT_DIR / "news" / "hotspots.json").read_text())["hotspots"]
    length = net["laneLength"][net["edgeLaneStart"]].astype(np.float64)
    rows = []
    for h in hotspots:
        edges = np.asarray(h["edges"], np.int64)
        rows.append(
            {
                "name": h["name"],
                "reports": len(h["reports"]),
                **{k: place_share(speeds[hour], edges, length) for k, hour in PEAKS.items()},
            }
        )
    internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
    main = np.isin(np.asarray(index["types"])[net["edgeType"]], MAIN_ROADS) & ~internal
    baseline = {}
    for k, hour in PEAKS.items():
        ratio = speeds[hour].astype(np.float64)
        used = main & (ratio < 255)
        congested = used & (ratio / 254 < 0.45)
        baseline[k] = float(length[congested].sum() / max(length[used].sum(), 1.0))
    return rows, baseline


def fmt(n: float) -> str:
    return f"{n:,.0f}"


# What to call an unnamed edge, by its type.
UNNAMED = {
    "internal": "inside junctions",
    "highway.service": "service roads",
    "railway.tram": "tram tracks",
    "highway.motorway_link": "motorway ramps",
    "highway.trunk_link": "expressway ramps",
    "highway.primary_link": "slip roads",
    "highway.secondary_link": "slip roads",
    "highway.tertiary_link": "slip roads",
}


def stuck_places(net: dict[str, np.ndarray], index: dict, day: dict) -> list[tuple[str, int]]:
    """Places vehicles were most often removed from (the run's top edges): each edge's road
    (by name, else number, else type) at the junction it leads to, named by the other roads
    meeting there."""
    names, refs, types = index["names"], index["refs"], index.get("types", [])

    def road(edge: int) -> str:
        name_i, ref_i = int(net["edgeName"][edge]), int(net["edgeRef"][edge])
        name = names[name_i] if name_i < len(names) else ""
        name = name or (refs[ref_i] if ref_i < len(refs) else "")
        if not name:
            type_i = int(net["edgeType"][edge])
            kind = types[type_i].split("|")[0] if type_i < len(types) else ""
            name = UNNAMED.get(kind, "unnamed streets")
        return name

    by_place: dict[str, int] = {}
    for edge, n in day.get("removedAt", []):
        here = road(edge)
        junction = net["edgeTo"][edge]
        others: list[str] = []
        for link in np.flatnonzero(net["linkJunction"] == junction):
            e = int(net["laneEdge"][net["linkFrom"][link]])
            name_i = int(net["edgeName"][e])
            other = names[name_i] if name_i < len(names) else ""
            if other and other != here and other not in others:
                others.append(other)
        place = f"{here} at {' / '.join(sorted(others)[:2])}" if others else here
        by_place[place] = by_place.get(place, 0) + int(n)
    return sorted(by_place.items(), key=lambda item: -item[1])


def report(
    placements: list[Placement],
    unplaced: list[Station],
    day: dict,
    hotspots: tuple[list[dict], dict[str, float]] | None = None,
    stuck: list[tuple[str, int]] | None = None,
) -> str:
    """docs/VALIDATION.md."""
    placed = [p for p in placements if p.hourly is not None]
    inputs = [p for p in placed if p.station.leaves_map is not None]
    checks = [p for p in placed if p.station.leaves_map is None]

    # The run's volumes are compared at full demand: divided by the share it simulates.
    scale = float(day.get("demandScale", 1.0))

    def rows(group: list[Placement]) -> list[str]:
        out = []
        for p in group:
            s = p.station
            sim = p.simulated
            full = sim / scale
            diff = (full - s.aadt) / s.aadt
            scaled = f" {fmt(full)} |" if scale != 1 else ""
            out.append(
                f"| {s.id} {s.name} | {s.road} | {fmt(s.aadt)} | {fmt(sim)} |{scaled} "
                f"{diff:+.0%} | {geh(full, s.aadt):.0f} | {p.distance:.0f} m |"
            )
        return out

    def summary(group: list[Placement]) -> str:
        if not group:
            return "no stations"
        ratios = np.array([p.simulated / scale / p.station.aadt for p in group])
        within = int(np.sum(np.abs(ratios - 1) <= 0.25))
        mape = float(np.mean(np.abs(ratios - 1)))
        total = sum(p.simulated / scale for p in group) / sum(p.station.aadt for p in group)
        return (
            f"{within} of {len(group)} within ±25 %, mean absolute difference {mape:.0%}, "
            f"total simulated / counted {total:.2f}"
        )

    hours = sorted(day["hours"], key=lambda h: h["hour"])
    peak = max(hours, key=lambda h: h["running"])
    departed = day["departed"]
    if scale != 1:
        head = [
            f"| Station | Road | Counted (PGDP 2025) | Simulated ({scale:.0%} demand) | "
            "At full demand | Difference | GEH | Placed within |",
            "|---|---|---:|---:|---:|---:|---:|---:|",
        ]
    else:
        head = [
            "| Station | Road | Counted (PGDP 2025) | Simulated | Difference | GEH | "
            "Placed within |",
            "|---|---|---:|---:|---:|---:|---:|",
        ]
    scaled_note = (
        [
            f"The run simulates {scale:.0%} of the estimated demand (see What was calibrated), "
            f"so its volumes are divided by {scale:g} before they are compared with the counts "
            '("At full demand"). That checks where the model sends traffic, not how much '
            "the simulated network can carry.",
            "",
        ]
        if scale != 1
        else []
    )
    lines = [
        "# Validation: a simulated weekday against traffic counts",
        "",
        "_Generated by `python -m pipeline.validate` from a full-day run of the engine "
        "(`sim/examples/day.rs`); see the end for how to repeat it._",
        "",
        "## What is compared",
        "",
        "Hrvatske ceste counts traffic on state roads and motorways and publishes each "
        "station's PGDP: the average number of vehicles per day over the year, both "
        "directions together. The simulation runs one weekday (from 03:00 to 03:00) with "
        "everything it has: car and truck trips between homes and jobs, trips to, from and "
        "through places beyond the map, and ZET's trams and buses. Every vehicle that drives "
        "onto a road is counted, hour by hour; a station's simulated volume is the day's "
        "count on its road's edges nearest to the station, both directions.",
        "",
        "The published tables have no coordinates, so each station was placed by hand from "
        "its road number and section name (`pipeline/counts.py`). The last column shows how "
        "far the nearest edge of that road is from the point chosen.",
        "",
        *scaled_note,
        "Two caveats about what agreement means:",
        "",
        "- Stations on roads that leave the map (the motorways, the D1 north and the D30 "
        "south-east) also set how much traffic crosses the map's edge there. Matching them "
        "shows the model carries those volumes in and out along the right roads, not that it "
        "predicts them.",
        "- PGDP averages all days of the year, including weekends and the summer season, "
        "which raise traffic on the motorways to the coast and lower it in the city. A typical "
        "working day is within about ±15 % of it on most roads.",
        "",
        "## What was calibrated",
        "",
        "- **Drivers**: a 1.0 s time gap, 2.2 m/s² acceleration and 2 m standing gap (IDM). A "
        "queue leaves a green light at about 1,970 cars per lane per hour (the Highway "
        "Capacity Manual's base saturation flow is 1,900; a test in `sim/src/tests.rs` "
        "keeps it between 1,700 and 2,100).",
        "- **Signals**: netconvert guesses the programs, and the engine reworks them "
        "(`sim/src/engine.rs`). Where a program lets opposite approaches go one after "
        "another, their phases are merged, with turns giving way to oncoming traffic "
        "(`merge_signal_phases`; ten programs, all at clusters of junctions netconvert "
        "joined). Each cycle's green time is split by the incoming lanes each phase lets go, "
        "tram tracks counting a quarter of a lane, and programs with four or more green "
        "phases get a 120 s cycle (`retime_signals`). Green phases stretch up to 20 s while "
        "traffic keeps arriving.",
        "- **Tolls**: routes count each kilometre of tolled motorway (OpenStreetMap's toll "
        "tag) as 36 s, about €0.08 at €8 an hour, so short trips take the free road beside a "
        "tolled motorway where it is not much slower. Drivers who cross the map's edge on a "
        "tolled motorway stay on it: they pay the toll anyway.",
        "- **Traffic across the map's edge**: the motorway stations, the D1 at Pojatno and "
        "the D30 at Petina set the volume where their road leaves the map, less the share "
        "estimated to leave at interchanges before the edge; uncounted roads get a typical "
        "volume for their class (`pipeline/gateways.py`).",
        "- **Demand**: 0.65 car trips per resident a day (Transport Master Plan survey), "
        "spread over the hours of a weekday. Traffic coming in crosses the map's edge 45 "
        "minutes ahead of the city's own trips. "
        + (
            f"This run simulates {scale:.0%} of that demand and of the traffic across the "
            "map's edge (`DEMAND_SCALE` in `pipeline/demand.py`): the simulated junctions "
            "carry less than Zagreb's real ones, and with more the evening peak locks up "
            "(known gaps in [PLAN.md](PLAN.md))."
            if scale != 1
            else "This run simulates all of it."
        ),
        "",
        "## Results",
        "",
        "### Independent checks: state roads inside the map",
        "",
        *head,
        *rows(checks),
        "",
        f"Summary: {summary(checks)}.",
        "",
        "### Roads that leave the map (volumes used as inputs)",
        "",
        *head,
        *rows(inputs),
        "",
        f"Summary: {summary(inputs)}.",
        "",
        "GEH compares a modelled flow M with a count C: √(2(M−C)²/(M+C)). Transport models "
        "aim for GEH below 5 on hourly flows; on daily flows, which are about 15 times "
        "larger, the same relative error gives a GEH about 4 times higher.",
    ]
    if unplaced:
        lines += [
            "",
            "Not placed: "
            + ", ".join(f"{s.id} {s.name} ({s.road or 'unnumbered road'})" for s in unplaced)
            + ".",
        ]
    lines += [
        "",
        "## The simulated day",
        "",
        f"- Trips started: {fmt(departed)}; finished: {fmt(day['arrived'])}.",
        f"- Removed after standing still for 5 minutes (gridlock): {fmt(day['removed'])} "
        f"({day['removed'] / max(departed, 1):.1%} of trips).",
        f"- Trips that found no route: {fmt(day['noRoute'])}; trips that could not start "
        f"within their waiting time: {fmt(day['notInserted'])}.",
        f"- Busiest hour: {peak['hour']:02d}:00 with {fmt(peak['running'])} vehicles on the "
        f"road on average ({fmt(peak['outside'])} of them coming from or going beyond the "
        f"map), mean speed {peak['meanSpeedKmh']:.0f} km/h.",
        "",
        "| Hour | Vehicles on the road | Crossing the map's edge | Mean speed (km/h) | "
        "Stopped | Trips started | Mean trip (min) | Mean trip (km) |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for h in hours:
        lines.append(
            f"| {h['hour']:02d}:00 | {fmt(h['running'])} | {fmt(h['outside'])} | "
            f"{h['meanSpeedKmh']:.0f} | {fmt(h['stopped'])} | {fmt(h['departed'])} | "
            f"{h['tripMinutes']:.1f} | {h['tripKm']:.1f} |"
        )
    if stuck:
        top = sum(n for _, n in stuck)
        lines += [
            "",
            "## Where vehicles get stuck",
            "",
            "Vehicles that stand still for 5 minutes are removed, as SUMO teleports them. "
            f"The 25 road sections that lost the most account for {fmt(top)} of the "
            f"{fmt(day['removed'])} removed; by place:",
            "",
            "| Place | Vehicles removed |",
            "|---|---:|",
            *(f"| {road} | {fmt(n)} |" for road, n in stuck[:10]),
        ]
    if hotspots:
        rows, baseline = hotspots
        congested = [r for r in rows if any(not math.isnan(r[k]) and r[k] < 0.45 for k in PEAKS)]
        lines += [
            "",
            "## Places the news reports jams at",
            "",
            "The app's news layer marks 39 places where Croatian news reported jams, "
            "roadworks, closures or crashes between 2020 and 2026. Many reports are about "
            "one-off works or crashes the simulation does not have, but chronic bottlenecks "
            "should be slow in the simulated peaks too. Mean speed as a share of the speed "
            "limit in the busiest hours (bands as on the traffic map: below 45 % is "
            "congested):",
            "",
            "| Place | Reports | 07:00-08:00 | 16:00-17:00 |",
            "|---|---:|---:|---:|",
        ]

        def cell(share: float) -> str:
            return "no traffic" if math.isnan(share) else f"{share:.0%} {band(share)}"

        for r in rows:
            lines.append(
                f"| {r['name']} | {r['reports']} | {cell(r['07-08'])} | {cell(r['16-17'])} |"
            )
        lines += [
            "",
            f"{len(congested)} of {len(rows)} places are congested in at least one peak. "
            "On all main roads (motorways, trunk, primary and secondary roads), "
            f"{baseline['07-08']:.0%} of the length is congested at 07:00-08:00 and "
            f"{baseline['16-17']:.0%} at 16:00-17:00.",
        ]
    lines += [
        "",
        "## Hourly profiles at the stations",
        "",
        "Simulated vehicles per hour, both directions:",
        "",
        "| Station | " + " | ".join(f"{h:02d}" for h in range(24)) + " |",
        "|---|" + "---:|" * 24,
    ]
    for p in placed:
        lines.append(
            f"| {p.station.name} ({p.station.road}) | "
            + " | ".join(fmt(v) for v in p.hourly)
            + " |"
        )
    lines += [
        "",
        "## How to repeat",
        "",
        "```sh",
        "python -m pipeline all",
        "gunzip -kf web/public/data/{network/net,demand/demand,transit/transit}.bin.gz",
        "(cd sim && cargo run --release --example day -- ../web/public/data /tmp/day)",
        "python -m pipeline.validate /tmp/day",
        "```",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m pipeline.validate", description=__doc__)
    parser.add_argument("run_dir", type=Path, help="output directory of the day runner")
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "docs" / "VALIDATION.md")
    parser.add_argument(
        "--demand-scale", type=float, help="demand scale of the run, if day.json lacks it"
    )
    args = parser.parse_args(argv)

    index = json.loads((OUTPUT_DIR / "network" / "net.json").read_text())
    net = read_packed(OUTPUT_DIR / "network" / index["file"], index)
    counts = read_counts(args.run_dir)
    if counts.shape[1] != len(net["edgeFlags"]):
        raise SystemExit("the run was made on a different network; run it again")
    day = json.loads((args.run_dir / "day.json").read_text())
    if args.demand_scale is not None:
        day.setdefault("demandScale", args.demand_scale)

    placements, unplaced = [], []
    for station in STATIONS:
        p = place(net, index, station)
        if p is None:
            unplaced.append(station)
            continue
        p.hourly = counts[:, p.edges].sum(axis=1)
        placements.append(p)
    speeds = read_speeds(args.run_dir)
    hotspots = hotspot_rows(net, index, speeds) if speeds is not None else None
    stuck = stuck_places(net, index, day)
    args.out.write_text(report(placements, unplaced, day, hotspots, stuck))
    for p in placements:
        print(
            f"{p.station.id} {p.station.name:24s} {p.station.road:5s} counted {p.station.aadt:7,d}"
            f" simulated {p.simulated:9,.0f}  edges {p.edges} ({p.distance:.0f} m)"
        )


if __name__ == "__main__":
    main()
