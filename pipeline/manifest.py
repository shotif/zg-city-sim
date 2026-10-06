"""The data manifest the app loads first: world definition plus one entry per layer."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from .config import CRS, ORIGIN_E, ORIGIN_LONLAT, ORIGIN_N, OUTPUT_DIR, WORLD

MANIFEST_PATH = OUTPUT_DIR / "manifest.json"


def _base() -> dict:
    return {
        "version": 1,
        "crs": CRS,
        "origin": {"e": ORIGIN_E, "n": ORIGIN_N, "lon": ORIGIN_LONLAT[0], "lat": ORIGIN_LONLAT[1]},
        "extent": {
            "minE": WORLD.min_e,
            "minN": WORLD.min_n,
            "maxE": WORLD.max_e,
            "maxN": WORLD.max_n,
        },
        "layers": {},
    }


def update(layer: str, entry: dict, path: Path = MANIFEST_PATH) -> None:
    """Record `entry` under `layers[layer]`, keeping the other layers already built."""
    manifest = _base()
    if path.exists():
        manifest["layers"] = json.loads(path.read_text()).get("layers", {})
    manifest["layers"][layer] = entry
    manifest["generated"] = datetime.now(UTC).isoformat(timespec="seconds")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
