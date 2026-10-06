"""Compare a simulated weekday with traffic counts and write docs/VALIDATION.md.

    gunzip -k web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
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


def fmt(n: float) -> str:
    return f"{n:,.0f}"


def report(placements: list[Placement], unplaced: list[Station], day: dict) -> str:
    """docs/VALIDATION.md."""
    placed = [p for p in placements if p.hourly is not None]
    inputs = [p for p in placed if p.station.leaves_map is not None]
    checks = [p for p in placed if p.station.leaves_map is None]

    def rows(group: list[Placement]) -> list[str]:
        out = []
        for p in group:
            s = p.station
            sim = p.simulated
            diff = (sim - s.aadt) / s.aadt
            out.append(
                f"| {s.id} {s.name} | {s.road} | {fmt(s.aadt)} | {fmt(sim)} | "
                f"{diff:+.0%} | {geh(sim, s.aadt):.0f} | {p.distance:.0f} m |"
            )
        return out

    def summary(group: list[Placement]) -> str:
        if not group:
            return "no stations"
        ratios = np.array([p.simulated / p.station.aadt for p in group])
        within = int(np.sum(np.abs(ratios - 1) <= 0.25))
        mape = float(np.mean(np.abs(ratios - 1)))
        total = sum(p.simulated for p in group) / sum(p.station.aadt for p in group)
        return (
            f"{within} of {len(group)} within ±25 %, mean absolute difference {mape:.0%}, "
            f"total simulated / counted {total:.2f}"
        )

    hours = sorted(day["hours"], key=lambda h: h["hour"])
    peak = max(hours, key=lambda h: h["running"])
    departed = day["departed"]
    head = [
        "| Station | Road | Counted (PGDP 2025) | Simulated | Difference | GEH | Placed within |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
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
        "Two caveats about what agreement means:",
        "",
        "- Stations on roads that leave the map (the motorways and the D1 north) also set "
        "how much traffic crosses the map's edge there. Matching them shows the model carries "
        "those volumes in and out correctly, not that it predicts them.",
        "- PGDP averages all days of the year, including weekends and the summer season, "
        "which raise traffic on the motorways to the coast and lower it in the city. A typical "
        "working day is within about ±15 % of it on most roads.",
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
        "gunzip -k web/public/data/{network/net,demand/demand,transit/transit}.bin.gz",
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
    args = parser.parse_args(argv)

    index = json.loads((OUTPUT_DIR / "network" / "net.json").read_text())
    net = read_packed(OUTPUT_DIR / "network" / index["file"], index)
    counts = read_counts(args.run_dir)
    if counts.shape[1] != len(net["edgeFlags"]):
        raise SystemExit("the run was made on a different network; run it again")
    day = json.loads((args.run_dir / "day.json").read_text())

    placements, unplaced = [], []
    for station in STATIONS:
        p = place(net, index, station)
        if p is None:
            unplaced.append(station)
            continue
        p.hourly = counts[:, p.edges].sum(axis=1)
        placements.append(p)
    args.out.write_text(report(placements, unplaced, day))
    for p in placements:
        print(
            f"{p.station.id} {p.station.name:24s} {p.station.road:5s} counted {p.station.aadt:7,d}"
            f" simulated {p.simulated:9,.0f}  edges {p.edges} ({p.distance:.0f} m)"
        )


if __name__ == "__main__":
    main()
