"""Land cover from ESA WorldCover 2021 (10 m), turned into the ground texture."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image
from rasterio.enums import Resampling
from scipy.ndimage import gaussian_filter

from .config import GROUND_RESOLUTION, OUTPUT_DIR, WORLD, Extent
from .rasters import fetch_window, lonlat_bounds, resample_to_grid

WORLDCOVER_URL = (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/"
    "v200/2021/map/ESA_WorldCover_10m_2021_v200_N45E015_Map.tif"
)

ATTRIBUTION = {
    "name": "ESA WorldCover 2021",
    "text": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) "
    "processed by ESA WorldCover consortium. CC BY 4.0.",
    "url": "https://esa-worldcover.org",
}

# WorldCover class -> (name, natural-looking sRGB colour seen from above in summer).
CLASSES: dict[int, tuple[str, tuple[int, int, int]]] = {
    10: ("Tree cover", (46, 72, 38)),
    20: ("Shrubland", (96, 108, 62)),
    30: ("Grassland", (118, 138, 78)),
    40: ("Cropland", (156, 150, 98)),
    50: ("Built-up", (128, 124, 118)),
    60: ("Bare / sparse vegetation", (170, 160, 138)),
    70: ("Snow and ice", (235, 238, 240)),
    80: ("Permanent water bodies", (52, 84, 104)),
    90: ("Herbaceous wetland", (84, 106, 74)),
    95: ("Mangroves", (40, 70, 50)),
    100: ("Moss and lichen", (140, 150, 120)),
}
TREE_COVER, BUILT_UP, WATER = 10, 50, 80
_FALLBACK = 30  # cells without data are drawn as grassland


def fetch_landcover() -> Path:
    path = fetch_window(WORLDCOVER_URL, "esa_worldcover_2021_N45E015", lonlat_bounds(WORLD))
    if path is None:
        raise RuntimeError("WorldCover tile does not cover the world extent")
    return path


def landcover_grid(resolution: float, extent: Extent = WORLD) -> np.ndarray:
    """Dominant WorldCover class per cell (uint8; 0 = no data), row 0 = north."""
    return resample_to_grid(
        [fetch_landcover()], extent, resolution, Resampling.mode, np.uint8, nodata=0
    )


def ground_colours(classes: np.ndarray, seed: int = 7) -> np.ndarray:
    """Colour a class grid, with subtle variation so flat areas don't look flat."""
    lut = np.empty((256, 3), np.float32)
    lut[:] = CLASSES[_FALLBACK][1]
    for cls, (_, rgb) in CLASSES.items():
        lut[cls] = rgb
    rgb = lut[classes]

    rng = np.random.default_rng(seed)
    broad = gaussian_filter(rng.standard_normal(classes.shape), sigma=6)
    broad /= np.abs(broad).max() or 1.0
    fine = rng.standard_normal(classes.shape) * 0.025
    rgb *= (1.0 + 0.10 * broad + fine)[..., None]

    # Soften class edges so the grid doesn't read as pixels.
    for c in range(3):
        rgb[..., c] = gaussian_filter(rgb[..., c], sigma=0.6)
    return np.clip(np.round(rgb), 0, 255).astype(np.uint8)


def build_ground() -> dict:
    classes = landcover_grid(GROUND_RESOLUTION)
    out = OUTPUT_DIR / "terrain" / "ground.webp"
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(ground_colours(classes), "RGB").save(out, quality=88, method=6)

    cols, rows = WORLD.grid(GROUND_RESOLUTION)
    counts = np.bincount(classes.ravel(), minlength=256)
    return {
        "file": "terrain/ground.webp",
        "width": cols,
        "height": rows,
        "resolution": GROUND_RESOLUTION,
        "classShare": {
            name: round(float(counts[cls]) / classes.size, 4)
            for cls, (name, _) in CLASSES.items()
            if counts[cls]
        },
        "attribution": ATTRIBUTION,
    }
