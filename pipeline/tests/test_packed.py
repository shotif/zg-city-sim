import numpy as np

from pipeline.packed import read_packed, write_packed


def test_packed_round_trip_is_aligned_and_deterministic(tmp_path):
    arrays = {
        "a": np.array([1, 2, 3], np.uint8),
        "b": np.array([1.5, -2.25], np.float32),
        "c": np.array([7], np.uint32),
    }
    index = write_packed(tmp_path / "x.bin.gz", arrays)
    assert all(spec["offset"] % 4 == 0 for spec in index["arrays"].values())
    assert index["byteLength"] == 16
    out = read_packed(tmp_path / "x.bin.gz", index)
    for name, array in arrays.items():
        np.testing.assert_array_equal(out[name], array)
    first = (tmp_path / "x.bin.gz").read_bytes()
    write_packed(tmp_path / "x.bin.gz", arrays)
    assert (tmp_path / "x.bin.gz").read_bytes() == first
