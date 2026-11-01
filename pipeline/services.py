"""Today's services (M20a): primary schools, kindergartens, health care, fire stations and
police stations, each on its street and in its district, with the places it takes.

In the City they come from its own open data (data.zagreb.hr, Otvorena dozvola): primary
schools with their pupils, kindergartens, the health centres' sites (domovi zdravlja) and
police stations. Fire stations, and every service beyond the City, come from
OpenStreetMap. Places are counted where the data has them and estimated where not
(docs/DATA_SOURCES.md, M20a):

- Primary schools: their pupils in the City's data; beyond it, the mean of the City's, a
  branch school (područna škola) 100, a private one 100.
- Kindergartens: the 32,390 children in the City's 60 kindergartens (2025) shared among
  their buildings; a private or religious one 60.
- Health care: GP teams of 1,700 registered patients (HZZO's standard), as many in the City
  as its residents need at 1,563 a team (HZZO's mean, February 2025), shared among the
  health centres' sites; beyond the City, the same at a health centre and one team at a
  practice.

Fire stations are the professional brigades' (javne vatrogasne postrojbe), not volunteer
halls, and police stations the local ones (policijske postaje); they have no places, only
the roads their vehicles take (M20d).
"""

from __future__ import annotations

import csv
import json
import logging
import re
from pathlib import Path

import numpy as np
import osmium
import shapely
from pyproj import Transformer

from .buildings import city_boundary, city_districts, fetch_ckan
from .config import CACHE_DIR, CRS, ORIGIN_E, ORIGIN_N, OUTPUT_DIR
from .demand import attach, district_of, street_lines
from .osm import ATTRIBUTION as OSM_ATTRIBUTION
from .osm import fetch_osm
from .packed import read_packed

log = logging.getLogger(__name__)

KINDS = ["school", "kindergarten", "health", "fire", "police"]
CITY_KINDERGARTEN_CHILDREN = 32_390
BRANCH_SCHOOL_PLACES = 100
PRIVATE_SCHOOL_PLACES = 100
PRIVATE_KINDERGARTEN_PLACES = 60
GP_TEAM = 1700
GP_MEAN_LIST = 1563
# A health centre's site beyond the City: as many teams as the City's on average.
HEALTH_CENTRE = -1
# A regular school or kindergarten beyond the City: as the City's on average.
REGULAR = -2
# Two of a kind this close (m) with the same name, or one unnamed, are the same place
# (mapped as a building and as the grounds around it, say).
SAME_PLACE = 80.0
# A City school takes OpenStreetMap's name for it if mapped this close (m).
NAME_MATCH = 150.0

CITY_DATASETS = {
    "school": "geoportal-osnovne-skole",
    "kindergarten": "geoportal-djecji-vrtici",
    "health": "geoportal-domovi-zdravlja",
    "police": "geoportal-policija",
}
# The City's primary schools that teach pupils full-time (not art schools or care homes).
SCHOOL_TYPES = (
    "REDOVNA ŠKOLA",
    "PRIVATNA ŠKOLA",
    "VJERSKA ŠKOLA",
    "POSEBNA USTANOVA ZA DJECU S TEŠKOĆAMA",
)

CITY_ATTRIBUTION = {
    "name": "City of Zagreb, open data",
    "text": "Primary schools, kindergartens, health centres and police stations from the "
    "City's Geoportal on data.zagreb.hr. Otvorena dozvola (Open Licence of the Republic of "
    "Croatia).",
    "url": "https://data.zagreb.hr/",
}

PRIMARY_NAME = re.compile(r"^(osnovna škola|oš\b|područna škola|pš\b)", re.IGNORECASE)
BRANCH_NAME = re.compile(r"područn|\bpš\b", re.IGNORECASE)
PRIVATE_SCHOOL_NAME = re.compile(
    r"privatn|međunarodn|francusk|njemačk|waldorf|katoličk|američk|britansk", re.IGNORECASE
)
FIRE_NAME = re.compile(r"javna vatrogasna|\bjvp\b|vatrogasna postaja", re.IGNORECASE)
VOLUNTEER_NAME = re.compile(r"\bdvd\b|dobrovoljn|dobrovljn|gasilsk|prostovoljn", re.IGNORECASE)
POLICE_NAME = re.compile(r"policijska postaja", re.IGNORECASE)
HEALTH_CENTRE_NAME = re.compile(r"dom zdravlja", re.IGNORECASE)
GP_NAME = re.compile(r"obiteljsk|opće medicin|opće/obiteljsk|ambulanta", re.IGNORECASE)
SPECIALIST_NAME = re.compile(r"poliklinik|bolnic|klinik", re.IGNORECASE)
# Words a tidied name keeps in lower case after its first.
LOWER_WORDS = {
    "osnovna", "škola", "područna", "centar", "za", "odgoj", "i", "obrazovanje", "dječji",
    "vrtić", "s", "sa", "u", "na", "od", "do", "pri", "djecu", "teškoćama", "razvoju",
    "privatna", "katolička", "ulica", "cesta",
}  # fmt: skip
ROMAN = re.compile(r"^[ivxlc]+\.$")


def tidy_name(name: str) -> str:
    """A name written in capitals, as Croatian writes it ("OSNOVNA ŠKOLA IVANA GORANA
    KOVAČIĆA" to "Osnovna škola Ivana Gorana Kovačića")."""
    out = []
    for i, w in enumerate(name.lower().split()):
        if ROMAN.match(w) or w.strip("()") in ("oš", "pš"):
            out.append(w.upper())
        elif i > 0 and w in LOWER_WORDS:
            out.append(w)
        else:
            out.append("-".join(p[:1].upper() + p[1:] for p in w.split("-")))
    return " ".join(out)


def classify(tags: osmium.osm.TagList) -> tuple[str, int] | None:
    """The kind of service an OpenStreetMap feature is, and its places (`REGULAR` and
    `HEALTH_CENTRE`: as the City's); None if it is none of them."""
    amenity = tags.get("amenity")
    name = tags.get("name", "")
    if amenity == "school":
        levels = tags.get("isced:level", "")
        if "1" not in levels.split(";") and not PRIMARY_NAME.search(name):
            return None
        if BRANCH_NAME.search(name):
            return "school", BRANCH_SCHOOL_PLACES
        private = "private" in (tags.get("operator:type", ""), tags.get("operator", ""))
        if private or PRIVATE_SCHOOL_NAME.search(name):
            return "school", PRIVATE_SCHOOL_PLACES
        return "school", REGULAR
    if amenity == "kindergarten":
        private = "private" in (tags.get("operator:type", ""), tags.get("operator", ""))
        return "kindergarten", PRIVATE_KINDERGARTEN_PLACES if private else REGULAR
    if amenity in ("doctors", "clinic"):
        operator = tags.get("operator", "")
        if SPECIALIST_NAME.search(name) and not HEALTH_CENTRE_NAME.search(name):
            return None
        if HEALTH_CENTRE_NAME.search(name):
            return "health", HEALTH_CENTRE
        if GP_NAME.search(name) or HEALTH_CENTRE_NAME.search(operator):
            return "health", GP_TEAM
        return None
    if amenity == "fire_station":
        if FIRE_NAME.search(name) and not VOLUNTEER_NAME.search(name):
            return "fire", 0
        return None
    if amenity == "police":
        return ("police", 0) if POLICE_NAME.search(name) else None
    return None


def read_osm(path: Path) -> list[dict]:
    """Services in the OpenStreetMap extract at `path`: kind, name, places and position
    (scene x, z)."""
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    found = []
    for o in osmium.FileProcessor(str(path)).with_areas():
        if not (o.is_node() or o.is_area()):
            continue  # closed ways and multipolygons come again as areas
        kind = classify(o.tags)
        if kind is None:
            continue
        if o.is_node():
            lon, lat = o.location.lon, o.location.lat
        else:
            points = [(n.lon, n.lat) for ring in o.outer_rings() for n in ring]
            if len(points) < 3:
                continue
            c = shapely.Polygon(points).centroid
            lon, lat = c.x, c.y
        e, n = to_crs.transform(lon, lat)
        name = o.tags.get("name", "").strip()
        found.append(
            {"kind": kind[0], "name": name, "places": kind[1], "x": e - ORIGIN_E, "z": ORIGIN_N - n}
        )
    return found


def deduplicate(services: list[dict]) -> list[dict]:
    """One of each place mapped twice: same kind within `SAME_PLACE`, same name or unnamed.
    Named ones are kept over unnamed."""
    kept: list[dict] = []
    for s in sorted(services, key=lambda s: (s["name"] == "", s["kind"], s["name"])):
        twin = next(
            (
                k
                for k in kept
                if k["kind"] == s["kind"]
                and (not s["name"] or k["name"] == s["name"])
                and np.hypot(k["x"] - s["x"], k["z"] - s["z"]) < SAME_PLACE
            ),
            None,
        )
        if twin is None:
            kept.append(s)
    return kept


def city_rows(kind: str) -> list[dict]:
    """The City's open data for `kind`, as CSV rows."""
    package = CITY_DATASETS[kind]
    path = fetch_ckan(
        package, "CSV", lambda stamp: CACHE_DIR / "services" / f"{package}_{stamp}.csv"
    )
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def city_services(rows: dict[str, list[dict]], residents: float) -> list[dict]:
    """The City's own services from its data (`rows` by kind), with their places; schools
    without a pupil count take the median of those with one."""
    to_crs = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    out = []

    def add(kind: str, row: dict, name: str, places: float) -> None:
        try:
            lon, lat = float(row["X"]), float(row["Y"])
        except (KeyError, ValueError):
            return
        e, n = to_crs.transform(lon, lat)
        x, z = e - ORIGIN_E, ORIGIN_N - n
        out.append({"kind": kind, "name": name, "places": round(places), "x": x, "z": z})

    schools = [r for r in rows.get("school", []) if r.get("vrsta_odg_ust") in SCHOOL_TYPES]
    pupils = [int(r["br_uc"]) for r in schools if r.get("br_uc", "").strip().isdigit()]
    median = float(np.median(pupils)) if pupils else 0.0
    for r in schools:
        count = r.get("br_uc", "").strip()
        add("school", r, tidy_name(r["naziv"]), int(count) if count.isdigit() else median)
    kindergartens = rows.get("kindergarten", [])
    city_run = sum(r.get("vr_vrtica") == "Gradski vrtić" for r in kindergartens)
    for r in kindergartens:
        city = r.get("vr_vrtica") == "Gradski vrtić"
        address = r.get("adresa", "").strip()
        name = f"Dječji vrtić {tidy_name(r['naziv'])}" + (f", {address}" if address else "")
        places = CITY_KINDERGARTEN_CHILDREN / city_run if city else PRIVATE_KINDERGARTEN_PLACES
        add("kindergarten", r, name, places)
    sites = rows.get("health", [])
    teams = round(residents / GP_MEAN_LIST)
    for r in sites:
        address = r.get("Domovi_zdravlja_adresa", "").strip()
        name = r["Domovi_zdravlja_naziv"].strip() + (f", {address}" if address else "")
        add("health", r, name, teams * GP_TEAM / max(1, len(sites)))
    for r in rows.get("police", []):
        if POLICE_NAME.search(r.get("naziv", "")):
            add("police", r, r["naziv"].strip(), 0)
    return out


def build_services(root: Path = OUTPUT_DIR) -> dict:
    n_index = json.loads((root / "network" / "net.json").read_text())
    net = read_packed(root / "network" / n_index["file"], n_index)
    residents = json.loads((root / "demand" / "demand.json").read_text())["residentsInCity"]

    def to_scene(c: np.ndarray) -> np.ndarray:
        return np.column_stack([c[:, 0] - ORIGIN_E, ORIGIN_N - c[:, 1]])

    boundary = shapely.transform(city_boundary(), to_scene)
    shapely.prepare(boundary)
    # The City's own services; OpenStreetMap's beyond it, and its fire stations everywhere.
    city = city_services({k: city_rows(k) for k in CITY_DATASETS}, residents)
    osm = deduplicate(read_osm(fetch_osm()))
    osm_x = np.array([s["x"] for s in osm])
    osm_z = np.array([s["z"] for s in osm])
    in_city = shapely.contains_xy(boundary, osm_x, osm_z)
    # A City school takes OpenStreetMap's name for it, which is written as Croatian writes.
    named = [(i, s) for i, s in enumerate(osm) if s["kind"] == "school" and s["name"]]
    for s in city:
        if s["kind"] != "school" or not named:
            continue
        d = [np.hypot(osm_x[i] - s["x"], osm_z[i] - s["z"]) for i, _ in named]
        k = int(np.argmin(d))
        if d[k] < NAME_MATCH:
            s["name"] = named[k][1]["name"]
    # Places beyond the City as the City's.
    city_schools = [s["places"] for s in city if s["kind"] == "school"]
    city_kgs = [
        s["places"]
        for s in city
        if s["kind"] == "kindergarten" and s["places"] != PRIVATE_KINDERGARTEN_PLACES
    ]
    city_sites = [s["places"] for s in city if s["kind"] == "health"]
    regular = {
        "school": float(np.mean(city_schools)) if city_schools else 0.0,
        "kindergarten": float(np.mean(city_kgs)) if city_kgs else 0.0,
    }
    site = float(np.mean(city_sites)) if city_sites else float(GP_TEAM)
    beyond = []
    for s, inside in zip(osm, in_city, strict=True):
        if inside and s["kind"] != "fire":
            continue
        if s["places"] == REGULAR:
            s["places"] = round(regular[s["kind"]])
        elif s["places"] == HEALTH_CENTRE:
            s["places"] = round(site)
        beyond.append(s)
    services = city + beyond
    x = np.array([s["x"] for s in services])
    z = np.array([s["z"] for s in services])
    # On the street in front; beyond the map's streets, left out.
    edges, lines, local = street_lines(net, n_index)
    edge = attach(x, z, edges, lines, local)
    inside = shapely.contains_xy(boundary, x, z)
    names, outlines = city_districts()
    district = np.full(len(x), -1, np.int64)
    if inside.any():
        district[inside] = district_of(x[inside], z[inside], shapely.transform(outlines, to_scene))
    out = []
    for s, e, d in zip(services, edge, district, strict=True):
        if e < 0:
            continue
        out.append(
            {
                "kind": s["kind"],
                "name": s["name"],
                "x": round(s["x"], 1),
                "z": round(s["z"], 1),
                "edge": int(e),
                "district": int(d),
                "places": int(s["places"]),
            }
        )
    out.sort(key=lambda s: (KINDS.index(s["kind"]), s["name"]))
    counts = {k: sum(s["kind"] == k for s in out) for k in KINDS}
    city_counts = {k: sum(s["kind"] == k and s["district"] >= 0 for s in out) for k in KINDS}
    places = {
        k: sum(s["places"] for s in out if s["kind"] == k and s["district"] >= 0) for k in KINDS
    }
    path = root / "services" / "services.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"kinds": KINDS, "districts": names, "services": out}, ensure_ascii=False)
    )
    log.info("services: %s, in the City %s, places in the City %s", counts, city_counts, places)
    return {
        "index": "services/services.json",
        "counts": counts,
        "inCity": city_counts,
        "placesInCity": places,
        "attribution": [CITY_ATTRIBUTION, OSM_ATTRIBUTION],
    }
