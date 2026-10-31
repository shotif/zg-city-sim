import io
import urllib.error
from pathlib import Path

import pytest

from pipeline import buildings


def bad_gateway(url: str) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, 502, "Bad Gateway", {}, None)


def test_requests_are_tried_again_after_a_bad_gateway(monkeypatch):
    calls = []

    def urlopen(req, timeout):
        calls.append(req.full_url)
        if len(calls) < 3:
            raise bad_gateway(req.full_url)
        return io.BytesIO(b"ok")

    monkeypatch.setattr(buildings.urllib.request, "urlopen", urlopen)
    assert buildings._get("https://example.org/a", waits=(0, 0)) == b"ok"
    assert len(calls) == 3


def test_other_errors_and_a_third_bad_gateway_are_raised(monkeypatch):
    calls = []

    def not_found(req, timeout):
        calls.append(1)
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

    monkeypatch.setattr(buildings.urllib.request, "urlopen", not_found)
    with pytest.raises(urllib.error.HTTPError):
        buildings._get("https://example.org/a", waits=(0, 0))
    assert len(calls) == 1

    def always_bad(req, timeout):
        calls.append(1)
        raise bad_gateway(req.full_url)

    monkeypatch.setattr(buildings.urllib.request, "urlopen", always_bad)
    with pytest.raises(urllib.error.HTTPError):
        buildings._get("https://example.org/a", waits=(0, 0))
    assert len(calls) == 4


def test_the_newest_cached_copy_is_used_when_the_portal_is_down(monkeypatch, tmp_path: Path):
    def portal_down(package, fmt):
        raise bad_gateway("https://data.zagreb.hr/api/3/action/package_show?id=" + package)

    monkeypatch.setattr(buildings, "ckan_resource", portal_down)
    for stamp in ("20220623", "20240913"):
        (tmp_path / f"lanes_{stamp}.geojson").write_text("{}")
    path = buildings.fetch_ckan("lanes", "GeoJSON", lambda s: tmp_path / f"lanes_{s}.geojson")
    assert path.name == "lanes_20240913.geojson"
    # Nothing cached: the error stands.
    with pytest.raises(urllib.error.HTTPError):
        buildings.fetch_ckan("plan", "GeoJSON", lambda s: tmp_path / f"plan_{s}.geojson")
