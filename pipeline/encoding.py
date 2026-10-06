"""Compact encodings for rasters the browser decodes."""

from __future__ import annotations

import numpy as np

# Mapbox Terrain-RGB: height = -10000 + (R * 65536 + G * 256 + B) * 0.1 metres.
TERRAIN_RGB_OFFSET = 10_000.0
TERRAIN_RGB_SCALE = 0.1


def encode_terrain_rgb(height_m: np.ndarray) -> np.ndarray:
    """Encode heights in metres as an (rows, cols, 3) uint8 Terrain-RGB image."""
    value = np.round((height_m.astype(np.float64) + TERRAIN_RGB_OFFSET) / TERRAIN_RGB_SCALE)
    if np.isnan(value).any():
        raise ValueError("heights contain NaN")
    if value.min() < 0 or value.max() > 0xFFFFFF:
        raise ValueError("heights out of Terrain-RGB range")
    v = value.astype(np.uint32)
    return np.stack([(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF], axis=-1).astype(np.uint8)


def decode_terrain_rgb(rgb: np.ndarray) -> np.ndarray:
    """Inverse of encode_terrain_rgb, returns float32 heights in metres."""
    v = (
        rgb[..., 0].astype(np.uint32) * 65536
        + rgb[..., 1].astype(np.uint32) * 256
        + rgb[..., 2].astype(np.uint32)
    )
    return (v.astype(np.float64) * TERRAIN_RGB_SCALE - TERRAIN_RGB_OFFSET).astype(np.float32)
