"""OpenStreetMap extract of the world area.

Extracts come from OSM US "Slice" (https://slice.openstreetmap.us), which cuts any polygon
out of a minutely updated planet. Geofabrik and Overpass don't respond from the cloud
environment this project is developed in.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import urllib.request
from pathlib import Path

from .config import CACHE_DIR, WORLD
from .rasters import lonlat_bounds

log = logging.getLogger(__name__)

SLICE_URL = "https://slice.openstreetmap.us"
MAX_AGE_DAYS = 7
POLL_SECONDS = 5
TIMEOUT_SECONDS = 15 * 60

ATTRIBUTION = {
    "name": "OpenStreetMap",
    "text": "© OpenStreetMap contributors. Open Database License (ODbL) 1.0.",
    "url": "https://www.openstreetmap.org/copyright",
}


def world_polygon() -> dict:
    west, south, east, north = lonlat_bounds(WORLD, margin_deg=0.01)
    ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
    return {"type": "Polygon", "coordinates": [[[round(x, 5), round(y, 5)] for x, y in ring]]}


def _request(url: str, data: bytes | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "zg-city-sim pipeline"})
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.status, response.read()


def fetch_osm(max_age_days: float = MAX_AGE_DAYS) -> Path:
    """Path to a cached .osm.pbf of the world area, fetched again when older than max_age_days."""
    polygon = world_polygon()
    key = hashlib.sha1(json.dumps(polygon, sort_keys=True).encode()).hexdigest()[:8]
    out = CACHE_DIR / "osm" / f"world_{key}.osm.pbf"
    if out.exists() and time.time() - out.stat().st_mtime < max_age_days * 86400:
        return out

    body = json.dumps({"RegionType": "geojson", "RegionData": polygon, "Name": "zg-city-sim"})
    status, reply = _request(f"{SLICE_URL}/api/", body.encode())
    if status != 201:
        raise RuntimeError(f"Slice refused the extract request: HTTP {status} {reply[:200]!r}")
    job = reply.decode().strip()
    log.info("requested OSM extract %s", job)

    deadline = time.monotonic() + TIMEOUT_SECONDS
    while True:
        progress = json.loads(_request(f"{SLICE_URL}/api/{job}")[1])
        if progress.get("Complete"):
            break
        if time.monotonic() > deadline:
            raise TimeoutError(f"OSM extract {job} not ready after {TIMEOUT_SECONDS}s")
        time.sleep(POLL_SECONDS)

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".partial")
    _, data = _request(f"{SLICE_URL}/files/{job}.osm.pbf")
    tmp.write_bytes(data)
    tmp.rename(out)
    log.info("OSM extract: %.1f MB, data as of %s", len(data) / 1e6, progress.get("Timestamp"))
    return out
