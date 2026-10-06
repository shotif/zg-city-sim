"""World definition shared by every pipeline step.

Coordinates are HTRS96/TM (EPSG:3765), Croatia's official projection, in metres.
The scene origin is Trg bana Jelačića. The app places a point at
x = E - ORIGIN_E, z = ORIGIN_N - N (north is -z), y = height above sea level.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

CRS = "EPSG:3765"

# Trg bana Jelačića (45.8131 N, 15.9772 E).
ORIGIN_E = 459_370.0
ORIGIN_N = 5_074_940.0
ORIGIN_LONLAT = (15.9772, 45.8131)


@dataclass(frozen=True)
class Extent:
    """Axis-aligned rectangle in EPSG:3765 metres."""

    min_e: float
    min_n: float
    max_e: float
    max_n: float

    @property
    def width(self) -> float:
        return self.max_e - self.min_e

    @property
    def height(self) -> float:
        return self.max_n - self.min_n

    def grid(self, resolution: float) -> tuple[int, int]:
        """Return (columns, rows) of a raster covering the extent at `resolution` m."""
        cols = self.width / resolution
        rows = self.height / resolution
        if not (cols.is_integer() and rows.is_integer()):
            raise ValueError(f"extent is not a whole number of {resolution} m cells")
        return int(cols), int(rows)


# The City of Zagreb (641 km²) plus a margin that takes in Samobor, Zaprešić,
# Velika Gorica, Dugo Selo and the A3 bypass: 48 km x 50 km.
WORLD = Extent(min_e=438_000.0, min_n=5_046_000.0, max_e=486_000.0, max_n=5_096_000.0)

TERRAIN_RESOLUTION = 25.0  # metres per heightmap sample
GROUND_RESOLUTION = 20.0  # metres per ground-texture pixel

PIPELINE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PIPELINE_DIR.parent
CACHE_DIR = PIPELINE_DIR / ".cache"
OUTPUT_DIR = REPO_ROOT / "web" / "public" / "data"
