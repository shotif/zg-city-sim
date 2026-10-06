"""Packed typed arrays: one gzip-compressed binary blob plus a JSON index.

The browser reads the index, decompresses the blob and creates typed-array views on it
(web/src/data/packed.ts). Arrays are little-endian and 4-byte aligned.
"""

from __future__ import annotations

import gzip
from pathlib import Path

import numpy as np

DTYPES = {
    "u8": np.uint8,
    "i8": np.int8,
    "u16": np.uint16,
    "i16": np.int16,
    "u32": np.uint32,
    "i32": np.int32,
    "f32": np.float32,
}
_NAMES = {np.dtype(v): k for k, v in DTYPES.items()}


def write_packed(path: Path, arrays: dict[str, np.ndarray]) -> dict:
    """Write `arrays` to `path` (gzip) and return the index describing them."""
    index: dict[str, dict] = {}
    chunks: list[bytes] = []
    offset = 0
    for name, array in arrays.items():
        a = np.ascontiguousarray(array)
        kind = _NAMES.get(a.dtype)
        if kind is None:
            raise TypeError(f"{name}: unsupported dtype {a.dtype}")
        data = a.astype(a.dtype.newbyteorder("<"), copy=False).tobytes()
        index[name] = {"type": kind, "offset": offset, "length": int(a.size)}
        chunks.append(data)
        offset += len(data)
        pad = (-offset) % 4
        if pad:
            chunks.append(b"\0" * pad)
            offset += pad
    path.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 keeps the output byte-identical between runs with the same data.
    with (
        open(path, "wb") as raw,
        gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as f,
    ):
        for chunk in chunks:
            f.write(chunk)
    return {"file": path.name, "byteLength": offset, "arrays": index}


def read_packed(path: Path, index: dict) -> dict[str, np.ndarray]:
    """Inverse of write_packed (used by tests)."""
    blob = gzip.decompress(path.read_bytes())
    out = {}
    for name, spec in index["arrays"].items():
        dtype = np.dtype(DTYPES[spec["type"]]).newbyteorder("<")
        out[name] = np.frombuffer(blob, dtype=dtype, count=spec["length"], offset=spec["offset"])
    return out
