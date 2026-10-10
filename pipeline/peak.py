"""Roads' speeds in the morning peak as the simulation has them (M10d), for car journey times.

    python -m pipeline.peak /tmp/day /tmp/day2     # day runs on today's network

writes `pipeline/data/peak_speeds.json`: every road piece where traffic moves below 90 % of
the speed limit from 07:00 to 09:00 on average over the runs, by where its middle is and
which way it runs, as kept by the network step: the network is rebuilt from newer
OpenStreetMap data on every push, which renumbers its edges. The network step gives each
edge the share of the limit of the piece it matches (`edgePeak`, %); 255 where none does
(traffic about as fast as the limit allows, or no data). Refresh the file with the
validation runs, from day runs on the network as built.
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from .config import OUTPUT_DIR, PIPELINE_DIR
from .packed import read_packed

log = logging.getLogger(__name__)

PEAK_FILE = PIPELINE_DIR / "data" / "peak_speeds.json"
# Hours averaged: the morning peak, 07:00 to 09:00.
HOURS = (7, 8)
# Pieces kept: traffic below this share of the limit.
KEEP_BELOW = 0.9
# A piece matches an edge whose middle is this close (m) and which runs this way (degrees).
MATCH_DISTANCE = 5.0
MATCH_HEADING = 30.0
UNKNOWN = 255
PASSENGER = 1


def edge_middles(
    arrays: dict[str, np.ndarray], edges: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The middle of each of `edges` along its rightmost lane (scene x, z) and its heading
    there (degrees, 0 along +x, counterclockwise towards +z)."""
    n = len(edges)
    lane0 = arrays["edgeLaneStart"].astype(np.int64)
    offsets = arrays["laneShapeOffsets"].astype(np.int64)
    origin = arrays["laneShapeOrigin"].reshape(-1, 2).astype(np.int64)
    delta = arrays["laneShapeDelta"].reshape(-1, 2).astype(np.int64)
    x = np.zeros(n)
    z = np.zeros(n)
    heading = np.zeros(n)
    for i, edge in enumerate(edges):
        lane = lane0[edge]
        a, b = offsets[lane], offsets[lane + 1]
        points = (origin[lane] + np.cumsum(delta[a:b], axis=0)) / 100.0
        if len(points) < 2:
            x[i], z[i] = points[0] if len(points) else (0.0, 0.0)
            continue
        seg = np.diff(points, axis=0)
        length = np.hypot(seg[:, 0], seg[:, 1])
        at = np.cumsum(length)
        half = at[-1] / 2
        k = min(int(np.searchsorted(at, half)), len(seg) - 1)
        t = (half - (at[k] - length[k])) / max(length[k], 1e-9)
        x[i], z[i] = points[k] + t * seg[k]
        heading[i] = np.degrees(np.arctan2(seg[k, 1], seg[k, 0]))
    return x, z, heading


def road_edges(arrays: dict[str, np.ndarray], internal_flag: int) -> np.ndarray:
    """Edges cars drive on in one lane or more, not inside junctions."""
    start = arrays["edgeLaneStart"].astype(np.int64)
    count = arrays["edgeLaneCount"].astype(np.int64)
    allow = np.zeros(len(start), np.uint32)
    for k in range(int(count.max(initial=0))):
        has = count > k
        allow[has] |= arrays["laneAllow"][start[has] + k]
    internal = (arrays["edgeFlags"] & internal_flag) != 0
    return ~internal & ((allow & PASSENGER) != 0)


def write_peak(run_dirs: list[Path], out: Path = PEAK_FILE) -> dict:
    """Peak speeds from day runs (validate.py's `edge_speeds.bin`) on the network built."""
    from .validate import read_speeds

    index = json.loads((OUTPUT_DIR / "network" / "net.json").read_text())
    arrays = read_packed(OUTPUT_DIR / "network" / "net.bin.gz", index)
    n = len(arrays["edgeFlags"])
    samples = []
    for run in run_dirs:
        speeds = read_speeds(run)
        if speeds is None or speeds.shape[1] != n:
            raise SystemExit(f"{run}: not a day run on this network ({n} edges)")
        samples.extend(speeds[h] for h in HOURS)
    stack = np.stack(samples).astype(np.float64)
    seen = stack != UNKNOWN
    hours = seen.sum(axis=0)
    share = np.where(hours > 0, np.where(seen, stack, 0).sum(axis=0) / np.maximum(hours, 1), 254)
    share /= 254
    keep = np.flatnonzero(road_edges(arrays, index["flags"]["internal"]) & (share < KEEP_BELOW))
    x, z, heading = edge_middles(arrays, keep)
    edges = [
        [round(float(x[i])), round(float(z[i])), round(float(heading[i])), round(share[e] * 100)]
        for i, e in enumerate(keep)
    ]
    out.write_text(
        json.dumps(
            {
                "about": "Share of the speed limit (%) traffic moves at, 07:00-09:00, on road "
                "pieces below 90 %: [x, z, heading in degrees, share], by the middle of "
                "the piece (pipeline/peak.py)",
                "runs": len(run_dirs),
                "edges": edges,
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    log.info("peak speeds: %d road pieces below %d %%", len(edges), KEEP_BELOW * 100)
    return {"pieces": len(edges)}


def peak_shares(
    arrays: dict[str, np.ndarray], internal_flag: int, path: Path = PEAK_FILE
) -> np.ndarray:
    """`edgePeak` for a network: each road edge's share of its limit in the morning peak (%)
    from the nearest piece in `path` running its way, else 255."""
    n = len(arrays["edgeFlags"])
    out = np.full(n, UNKNOWN, np.uint8)
    if not path.exists():
        return out
    pieces = np.asarray(json.loads(path.read_text())["edges"], dtype=np.float64).reshape(-1, 4)
    if len(pieces) == 0:
        return out
    roads = np.flatnonzero(road_edges(arrays, internal_flag))
    x, z, heading = edge_middles(arrays, roads)
    tree = cKDTree(pieces[:, :2])
    dist, nearest = tree.query(np.column_stack([x, z]), k=4, distance_upper_bound=MATCH_DISTANCE)
    for i, e in enumerate(roads):
        for d, k in zip(dist[i], nearest[i], strict=True):
            if not np.isfinite(d):
                break
            turn = abs((heading[i] - pieces[k, 2] + 180) % 360 - 180)
            if turn <= MATCH_HEADING:
                out[e] = int(np.clip(pieces[k, 3], 1, 100))
                break
    return out


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("runs", type=Path, nargs="+", help="day run directories")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(write_peak(args.runs))


if __name__ == "__main__":
    main()
