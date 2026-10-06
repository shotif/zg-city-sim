"""Terrain heights from the Copernicus GLO-30 digital elevation model."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image
from rasterio.enums import Resampling
from scipy.ndimage import gaussian_filter, grey_opening

from .config import OUTPUT_DIR, TERRAIN_RESOLUTION, WORLD
from .encoding import encode_terrain_rgb
from .landcover import BUILT_UP, landcover_grid
from .rasters import fetch_window, lonlat_bounds, resample_to_grid

# 1° x 1° tiles; the world's northern edge reaches just past 46° N.
COPERNICUS_TILES = (
    "Copernicus_DSM_COG_10_N45_00_E015_00_DEM",
    "Copernicus_DSM_COG_10_N45_00_E016_00_DEM",
    "Copernicus_DSM_COG_10_N46_00_E015_00_DEM",
    "Copernicus_DSM_COG_10_N46_00_E016_00_DEM",
)
COPERNICUS_URL = "https://copernicus-dem-30m.s3.amazonaws.com/{0}/{0}.tif"

ATTRIBUTION = {
    "name": "Copernicus DEM GLO-30",
    "text": "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under "
    "COPERNICUS by the European Union and ESA; all rights reserved.",
    "url": "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
}


def fetch_dem() -> list[Path]:
    bounds = lonlat_bounds(WORLD)
    paths = [fetch_window(COPERNICUS_URL.format(tile), tile, bounds) for tile in COPERNICUS_TILES]
    return [p for p in paths if p is not None]


def remove_buildings(
    height: np.ndarray, classes: np.ndarray, window_m: float = 125.0
) -> np.ndarray:
    """Flatten buildings out of the surface model in built-up areas.

    Copernicus GLO-30 is a surface model, so towers and blocks show up as bumps.
    A grey opening (erode, then dilate) removes features narrower than `window_m`;
    it is blended in by how built-up each cell is, leaving open terrain untouched.
    """
    size = max(3, round(window_m / TERRAIN_RESOLUTION) | 1)
    opened = grey_opening(height, size=(size, size))
    weight = gaussian_filter((classes == BUILT_UP).astype(np.float32), sigma=1.5)
    return (height * (1.0 - weight) + opened * weight).astype(np.float32)


def build_terrain() -> dict:
    height = resample_to_grid(
        fetch_dem(), WORLD, TERRAIN_RESOLUTION, Resampling.bilinear, np.float32, nodata=np.nan
    )
    if np.isnan(height).any():
        raise RuntimeError("DEM does not fully cover the world extent")
    height = remove_buildings(height, landcover_grid(TERRAIN_RESOLUTION))

    out = OUTPUT_DIR / "terrain" / "height.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(encode_terrain_rgb(height), "RGB").save(out, optimize=True)

    cols, rows = WORLD.grid(TERRAIN_RESOLUTION)
    return {
        "file": "terrain/height.png",
        "width": cols,
        "height": rows,
        "resolution": TERRAIN_RESOLUTION,
        "encoding": "terrain-rgb",
        "minHeight": round(float(height.min()), 1),
        "maxHeight": round(float(height.max()), 1),
        "attribution": ATTRIBUTION,
    }
