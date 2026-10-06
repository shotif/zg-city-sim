"""Compare a simulated weekday with traffic counts and write docs/VALIDATION.md.

    gunzip -kf web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
    (cd sim && cargo run --release --example day -- ../web/public/data <run_dir>)
    python -m pipeline.validate <run_dir>

The day runner records how many vehicles drove onto every road in every hour. Each count
station inside the map is placed on the edges of its road nearest to the station's point,
one per direction, and the simulated vehicles on them are compared with the station's
count, estimated for a working day outside the summer (pipeline/counts.py): over the day,
and hour by hour where the publication charts the station's hourly traffic.
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
from .counts import STATIONS, WORKDAY_FACTOR, Station
from .gateways import road_refs, to_scene
from .packed import read_packed

# The opposite carriageway is at most this much further from the station's point (m).
OPPOSITE_SLACK = 150.0
PASSENGER = 1
# Transport models aim for GEH below this on hourly flows, at 85 % of count locations.
GEH_TARGET = 5.0
GEH_SHARE = 0.85


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


def road_edges(net: dict[str, np.ndarray], index: dict, station: Station) -> np.ndarray:
    """Drivable edges of the station's road: by number, or by street name for an
    unnumbered road."""
    internal = (net["edgeFlags"] & index["flags"]["internal"]) != 0
    lane0 = net["edgeLaneStart"]
    drivable = (net["laneAllow"][lane0] & PASSENGER) != 0
    if station.road:
        refs = [i for i, r in enumerate(index["refs"]) if station.road in road_refs(r)]
        on_road = np.isin(net["edgeRef"], refs)
    else:
        names = [i for i, n in enumerate(index["names"]) if n in station.road_names]
        on_road = np.isin(net["edgeName"], names)
    return np.flatnonzero(on_road & ~internal & drivable)


def place(net: dict[str, np.ndarray], index: dict, station: Station) -> Placement | None:
    """The station's counted edges: the nearest edge of its road, and the nearest one
    running the other way (the opposite direction or carriageway), if any."""
    candidates = road_edges(net, index, station)
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


def road_group(station: Station) -> str:
    if station.road.startswith("A"):
        return "motorways"
    if station.road.startswith("D"):
        return "state roads"
    return "county, local and unnumbered roads"


def hourly_geh(p: Placement, scale: float) -> np.ndarray | None:
    """GEH of the simulated (at full demand) and counted flow in each hour, if counted."""
    counted = p.station.workday_hourly
    if counted is None or p.hourly is None:
        return None
    return np.array([geh(m / scale, c) for m, c in zip(p.hourly, counted, strict=True)])


def report(
    placements: list[Placement],
    unplaced: list[Station],
    day: dict,
    hotspots: tuple[list[dict], dict[str, float]] | None = None,
    stuck: list[tuple[str, int]] | None = None,
    inputs: set[int] | None = None,
) -> str:
    """docs/VALIDATION.md. `inputs`: stations whose counts set traffic across the map's
    edge."""
    inputs = inputs or set()
    placed = sorted(
        (p for p in placements if p.hourly is not None), key=lambda p: -p.station.workday
    )
    used = [p for p in placed if p.station.id in inputs]
    checks = [p for p in placed if p.station.id not in inputs]

    # The run's volumes are compared at full demand: divided by the share it simulates.
    scale = float(day.get("demandScale", 1.0))

    def rows(group: list[Placement]) -> list[str]:
        out = []
        for p in group:
            s = p.station
            full = p.simulated / scale
            diff = (full - s.workday) / s.workday
            scaled = f" {fmt(full)} |" if scale != 1 else ""
            g = hourly_geh(p, scale)
            hours = f"{int((g < GEH_TARGET).sum())}/24" if g is not None else ""
            out.append(
                f"| {s.id} {s.name} | {s.road or 'none'} | {s.method} | {fmt(s.aadt)} | "
                f"{fmt(s.workday)} | {fmt(p.simulated)} |{scaled} {diff:+.0%} | "
                f"{geh(full, s.workday):.0f} | {hours} | {p.distance:.0f} m |"
            )
        return out

    def summary(group: list[Placement]) -> str:
        if not group:
            return "no stations"
        ratios = np.array([p.simulated / scale / p.station.workday for p in group])
        within = int(np.sum(np.abs(ratios - 1) <= 0.25))
        mape = float(np.mean(np.abs(ratios - 1)))
        total = sum(p.simulated / scale for p in group) / sum(p.station.workday for p in group)
        return (
            f"{within} of {len(group)} within ±25 %, mean absolute difference {mape:.0%}, "
            f"total simulated / counted {total:.2f}"
        )

    hours = sorted(day["hours"], key=lambda h: h["hour"])
    peak = max(hours, key=lambda h: h["running"])
    departed = day["departed"]
    sim_col = f"Simulated ({scale:.0%} demand) | At full demand" if scale != 1 else "Simulated"
    head = [
        f"| Station | Road | Count | PGDP | Working day | {sim_col} | Difference | GEH | "
        "Hours GEH < 5 | Placed within |",
        "|---|---|---|---:|---:|---:|" + ("---:|" if scale != 1 else "") + "---:|---:|---:|---:|",
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
    charted = [p for p in placed if p.station.workday_hourly is not None]
    groups = ["motorways", "state roads", "county, local and unnumbered roads"]
    lines = [
        "# Validation: a simulated weekday against traffic counts",
        "",
        "_Generated by `python -m pipeline.validate` from a full-day run of the engine "
        "(`sim/examples/day.rs`); see the end for how to repeat it._",
        "",
        "## What is compared",
        "",
        "Hrvatske ceste publishes a count for each of 914 stations on state, county and "
        "local roads and motorways: the PGDP, the average number of vehicles per day over the "
        "year, both directions together. For the stations it counts all year it also charts "
        "the average traffic in each hour of the day and on each day of the week. The "
        f"{len(placements) + len(unplaced)} stations inside the map are compared here, "
        f"{len(charted)} of them hour by hour.",
        "",
        "The simulation runs one working day (from 03:00 to 03:00) with everything it has: "
        "car and truck trips between homes and jobs, trips to, from and through places "
        "beyond the map, and ZET's trams and buses. Every vehicle that drives onto a road is "
        "counted, hour by hour; a station's simulated volume is the count on its road's "
        "edges nearest to the station, both directions.",
        "",
        "Counts are compared for an average working day outside July and August "
        '("Working day"), estimated from the charts: 24 times the average hourly traffic '
        "on Mondays to Fridays outside the summer. Stations without charts take the average "
        "day outside the summer (from PGDP and PLDP, the July and August average) times "
        f"{WORKDAY_FACTOR:.3f}, the median ratio of working days to all days at the charted "
        "stations. Hourly counts are the hourly chart outside the summer, scaled to the "
        "working day: the charts average all days of the week, so their peaks are a little "
        "flatter than a working day's.",
        "",
        "The tables give no coordinates. Each station is placed on its road between the "
        "junctions its section is named by (`pipeline/hc.py`, which reads the tables and "
        "the charts into `pipeline/data/hc_counts_2025.json`); the last column shows how far "
        "the nearest edge of that road is from the point chosen.",
        "",
        *scaled_note,
        "Stations whose counts set the traffic crossing the map's edge are listed apart: "
        "matching them shows the model carries those volumes in and out along the right "
        "roads, not that it predicts them.",
        "",
        "GEH compares a modelled flow M with a count C: √(2(M−C)²/(M+C)). Transport models "
        f"aim for GEH below {GEH_TARGET:g} on hourly flows at {GEH_SHARE:.0%} of count "
        "locations; on daily flows, about 15 times larger, the same relative error gives a "
        "GEH about 4 times higher.",
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
        "tag) as 18 s, about €0.08 at €16 an hour, so short trips take the free road beside "
        "a tolled motorway where it is not much slower. Drivers who cross the map's edge on a "
        "tolled motorway stay on it: they pay the toll anyway. At 36 s a kilometre the A11 "
        "carried half its toll counts and the D30 at Lekenik over twice its count.",
        "- **Traffic across the map's edge**: where a road's counted section crosses the "
        "map's edge, or ends within 2.5 km of it, the gateway there carries that station's "
        "working-day count; uncounted roads get a typical volume for their class "
        "(`pipeline/gateways.py`).",
        "- **Demand**: 0.65 car trips per resident of the City a day (Transport Master Plan "
        "survey), more in the towns around it, where more trips are by car (0.87 in Zagreb "
        "County and the others, 1.0 in Krapina-Zagorje); towns get their census population by "
        "settlement. "
        "Trips are spread over the hours of a weekday by the hourly profile measured at the "
        "charted stations. Traffic coming in crosses the map's edge 45 minutes ahead of the "
        "city's own trips. "
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
        "### Independent checks",
        "",
        *head,
        *rows(checks),
        "",
        f"Summary: {summary(checks)}.",
        "",
        *(
            f"- {name.capitalize()}: {summary(group)}."
            for name in groups
            if (group := [p for p in checks if road_group(p.station) == name])
        ),
        "",
        "### Roads that leave the map (counts used as inputs)",
        "",
        *head,
        *rows(used),
        "",
        f"Summary: {summary(used)}.",
    ]
    if unplaced:
        lines += [
            "",
            "Not placed on the network: "
            + ", ".join(f"{s.id} {s.name} ({s.road or 'unnumbered road'})" for s in unplaced)
            + ".",
        ]
    if charted:
        gehs = np.array([hourly_geh(p, scale) for p in charted])
        counted = np.array([p.station.workday_hourly for p in charted])
        simulated = np.array([p.hourly / scale for p in charted])
        ok = gehs < GEH_TARGET
        good_hours = int((ok.mean(axis=0) >= GEH_SHARE).sum())
        lines += [
            "",
            "### Hour by hour",
            "",
            f"At the {len(charted)} stations with hourly charts, {ok.mean():.0%} of the "
            f"station-hours have GEH below {GEH_TARGET:g}; the target of {GEH_SHARE:.0%} of "
            f"stations is met in {good_hours} of 24 hours. All stations together, vehicles per "
            "hour and each hour's share of the day:",
            "",
            "| Hour | Counted | Simulated (full demand) | Counted share | Simulated share | "
            "Stations GEH < 5 |",
            "|---|---:|---:|---:|---:|---:|",
        ]
        c_tot, s_tot = counted.sum(axis=0), simulated.sum(axis=0)
        for h in range(24):
            lines.append(
                f"| {h:02d}:00 | {fmt(c_tot[h])} | {fmt(s_tot[h])} | "
                f"{c_tot[h] / c_tot.sum():.1%} | {s_tot[h] / s_tot.sum():.1%} | "
                f"{ok[:, h].mean():.0%} |"
            )
        lines += [
            "",
            "Each station's busiest morning and afternoon hours, counted and simulated "
            "(full demand):",
            "",
            "| Station | Road | Morning peak counted | simulated | Afternoon peak counted | "
            "simulated | Hours GEH < 5 |",
            "|---|---|---|---:|---|---:|---:|",
        ]
        for p, g, c, m in zip(charted, gehs, counted, simulated, strict=True):
            am = 5 + int(np.argmax(c[5:11]))
            pm = 12 + int(np.argmax(c[12:20]))
            lines.append(
                f"| {p.station.id} {p.station.name} | {p.station.road or 'none'} | "
                f"{am:02d}:00 {fmt(c[am])} | {fmt(m[am])} | {pm:02d}:00 {fmt(c[pm])} | "
                f"{fmt(m[pm])} | {int((g < GEH_TARGET).sum())} |"
            )
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
        hot_rows, baseline = hotspots
        congested = [
            r for r in hot_rows if any(not math.isnan(r[k]) and r[k] < 0.45 for k in PEAKS)
        ]
        names = list(PEAKS)
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
            f"| Place | Reports | {names[0].replace('-', ':00-')}:00 | "
            f"{names[1].replace('-', ':00-')}:00 |",
            "|---|---:|---:|---:|",
        ]

        def cell(share: float) -> str:
            return "no traffic" if math.isnan(share) else f"{share:.0%} {band(share)}"

        for r in hot_rows:
            lines.append(
                f"| {r['name']} | {r['reports']} | {cell(r[names[0]])} | {cell(r[names[1]])} |"
            )
        lines += [
            "",
            f"{len(congested)} of {len(hot_rows)} places are congested in at least one peak. "
            "On all main roads (motorways, trunk, primary and secondary roads), "
            f"{baseline[names[0]]:.0%} of the length is congested at "
            f"{names[0].replace('-', ':00-')}:00 and {baseline[names[1]]:.0%} at "
            f"{names[1].replace('-', ':00-')}:00.",
        ]
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
        "The stations come from `pipeline/data/hc_counts_2025.json`, written by "
        "`pipeline/hc.py` from the published tables (see its docstring to rebuild it).",
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

    gateways = json.loads((OUTPUT_DIR / "demand" / "demand.json").read_text())["gatewayList"]
    inputs = {sid for g in gateways for sid in g.get("stations", [])}
    placements, unplaced = [], []
    for station in STATIONS:
        if not station.inside:
            continue
        p = place(net, index, station)
        if p is None:
            unplaced.append(station)
            continue
        p.hourly = counts[:, p.edges].sum(axis=1)
        placements.append(p)
    speeds = read_speeds(args.run_dir)
    hotspots = hotspot_rows(net, index, speeds) if speeds is not None else None
    stuck = stuck_places(net, index, day)
    args.out.write_text(report(placements, unplaced, day, hotspots, stuck, inputs))
    scale = float(day.get("demandScale", 1.0))
    for p in placements:
        s = p.station
        print(
            f"{s.id} {s.name:26s} {s.road or '-':5s} working day {s.workday:7,.0f}"
            f" simulated {p.simulated / scale:9,.0f}  edges {p.edges} ({p.distance:.0f} m)"
        )


if __name__ == "__main__":
    main()
