"""Fetch windows of remote cloud-optimised GeoTIFFs and resample them onto world grids."""

from __future__ import annotations

import hashlib
import logging
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform_bounds
from rasterio.windows import Window

from .config import CACHE_DIR, CRS, Extent

log = logging.getLogger(__name__)

# Read only the blocks we need over HTTP range requests; never list remote directories.
GDAL_REMOTE_OPTIONS = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MAX_RETRY": "4",
    "GDAL_HTTP_RETRY_DELAY": "2",
}


def lonlat_bounds(extent: Extent, margin_deg: float = 0.01) -> tuple[float, float, float, float]:
    """(west, south, east, north) in degrees covering `extent`, with a safety margin."""
    west, south, east, north = transform_bounds(
        CRS, "EPSG:4326", extent.min_e, extent.min_n, extent.max_e, extent.max_n, densify_pts=21
    )
    return west - margin_deg, south - margin_deg, east + margin_deg, north + margin_deg


def fetch_window(url: str, name: str, bounds: tuple[float, float, float, float]) -> Path | None:
    """Cache the part of the remote raster at `url` that overlaps lon/lat `bounds`.

    Returns the local GeoTIFF path, or None when the raster does not overlap.
    """
    # The cache key includes the bounds, so changing the world extent fetches fresh windows.
    key = hashlib.sha1(repr([round(b, 6) for b in bounds]).encode()).hexdigest()[:8]
    out = CACHE_DIR / f"{name}_{key}.tif"
    if out.exists():
        return out
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    west, south, east, north = bounds
    with rasterio.Env(**GDAL_REMOTE_OPTIONS), rasterio.open("/vsicurl/" + url) as src:
        inv = ~src.transform
        c0, r0 = inv * (west, north)
        c1, r1 = inv * (east, south)
        c0, r0 = max(0, math.floor(c0)), max(0, math.floor(r0))
        c1, r1 = min(src.width, math.ceil(c1)), min(src.height, math.ceil(r1))
        if c1 <= c0 or r1 <= r0:
            return None
        window = Window(c0, r0, c1 - c0, r1 - r0)
        log.info("fetching %s window %dx%d from %s", name, window.width, window.height, url)
        data = src.read(1, window=window)
        profile = {
            "driver": "GTiff",
            "width": window.width,
            "height": window.height,
            "count": 1,
            "dtype": data.dtype,
            "crs": src.crs,
            "transform": src.window_transform(window),
            "nodata": src.nodata,
            "compress": "deflate",
            "tiled": True,
            "blockxsize": 512,
            "blockysize": 512,
        }
    tmp = out.with_name(out.name + ".partial")
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(data, 1)
    tmp.rename(out)
    return out


def resample_to_grid(
    sources: list[Path],
    extent: Extent,
    resolution: float,
    resampling: Resampling,
    dtype: type,
    nodata: float,
) -> np.ndarray:
    """Mosaic `sources` onto the extent's grid (row 0 = north, column 0 = west)."""
    cols, rows = extent.grid(resolution)
    dst_transform = from_origin(extent.min_e, extent.max_n, resolution, resolution)
    dst = np.full((rows, cols), nodata, dtype=dtype)
    for path in sources:
        with rasterio.open(path) as src:
            reproject(
                source=rasterio.band(src, 1),
                destination=dst,
                dst_transform=dst_transform,
                dst_crs=CRS,
                resampling=resampling,
                src_nodata=src.nodata,
                dst_nodata=nodata,
                init_dest_nodata=False,
            )
    return dst
