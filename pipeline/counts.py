"""Traffic counts: Hrvatske ceste, "Brojenje prometa na cestama Republike Hrvatske 2025".

The stations in and around the map, placed on their roads by pipeline/hc.py from the
published tables (which give no coordinates) and stored in pipeline/data/hc_counts_2025.json
with the hourly and weekday profiles read from the publication's charts.

The simulation runs a typical working day, so each station's count is also estimated for an
average working day (Monday to Friday) outside July and August (`Station.workday`):
- stations with charts: 24 times their average hourly traffic on working days outside the
  summer;
- the others: the average day outside the summer, from PGDP and PLDP, times the median
  ratio of working days to all days at the stations with charts (`WORKDAY_FACTOR`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cached_property

import numpy as np

from .config import PIPELINE_DIR

SOURCE = PIPELINE_DIR / "data" / "hc_counts_2025.json"
# July and August, PLDP's months.
SUMMER_DAYS = 62

ATTRIBUTION = {
    "name": "Hrvatske ceste, Brojenje prometa 2025",
    "text": "Traffic counts: Hrvatske ceste d.o.o., Brojenje prometa na cestama Republike "
    "Hrvatske godine 2025 (PGDP, average annual daily traffic; hourly profiles read from the "
    "publication's charts). Stations placed on OpenStreetMap roads by zg-city-sim.",
    "url": "https://hrvatske-ceste.hr/hr/stranice/promet-i-sigurnost/dokumenti/14-brojenje-prometa",
}


@dataclass(frozen=True)
class Station:
    id: int
    name: str
    #: Road number as OpenStreetMap tags it: "A3", "D1", county and local roads by number
    #: alone ("3063"); "" for an unnumbered road, found by `road_names` instead.
    road: str
    #: PGDP 2025: average annual daily traffic, both directions (vehicles per day).
    aadt: int
    #: (lon, lat) of the station on its counted section.
    at: tuple[float, float]
    #: Whether the station is inside the map.
    inside: bool = True
    #: PLDP: average daily traffic in July and August, if counted.
    summer: int | None = None
    #: NAB continuous automatic count, PAB periodic, NB toll count.
    method: str = ""
    #: The counted section's ends, as the tables name them, and its length.
    section: tuple[str, str] = ("", "")
    length_km: float = 0.0
    #: How the station was placed.
    placed: str = ""
    #: The counted section, (lon, lat) points.
    path: tuple[tuple[float, float], ...] = ()
    road_names: tuple[str, ...] = ()
    #: Average vehicles per hour in each hour of the day outside the summer (all days).
    hourly_rest: tuple[float, ...] | None = None
    #: Average vehicles per hour on each day of the week outside the summer, Monday first.
    weekday_rest: tuple[float, ...] | None = None

    @property
    def rest_day(self) -> float:
        """Average daily traffic outside July and August."""
        if self.hourly_rest is not None:
            return float(sum(self.hourly_rest))
        if self.summer is None:
            return float(self.aadt)
        return (365 * self.aadt - SUMMER_DAYS * self.summer) / (365 - SUMMER_DAYS)

    @property
    def workday(self) -> float:
        """Estimated traffic on an average working day outside the summer (vehicles)."""
        if self.weekday_rest is not None:
            return 24 * float(np.mean(self.weekday_rest[:5]))
        return self.rest_day * WORKDAY_FACTOR

    @property
    def workday_hourly(self) -> np.ndarray | None:
        """Estimated vehicles in each hour of a working day outside the summer: the hourly
        profile of all days outside the summer, scaled to `workday`."""
        if self.hourly_rest is None:
            return None
        h = np.asarray(self.hourly_rest, np.float64)
        return h * self.workday / h.sum()

    @cached_property
    def label(self) -> str:
        return f"{self.id} {self.name}"


def load_stations() -> list[Station]:
    data = json.loads(SOURCE.read_text())
    out = []
    for s in data["stations"]:
        hourly = s.get("hourly", {}).get("rest")
        weekday = (s.get("weekday") or {}).get("rest")
        out.append(
            Station(
                id=s["id"],
                name=s["name"],
                road=s["road"] or "",
                aadt=s["pgdp"],
                at=tuple(s["at"]),
                inside=s["inside"],
                summer=s.get("pldp"),
                method=s.get("method", ""),
                section=tuple(s.get("section", ("", ""))),
                length_km=s.get("length_km", 0.0),
                placed=s.get("placed", ""),
                path=tuple(tuple(p) for p in s.get("path", ())),
                road_names=tuple(s.get("road_names", ())),
                hourly_rest=tuple(hourly) if hourly else None,
                weekday_rest=tuple(weekday) if weekday else None,
            )
        )
    return out


def workday_factor(stations: list[Station]) -> float:
    """Median ratio of a working day's traffic to the average day's, outside the summer, at
    the stations with charts."""
    ratios = [
        24 * float(np.mean(s.weekday_rest[:5])) / s.rest_day
        for s in stations
        if s.weekday_rest is not None and s.rest_day > 0
    ]
    return float(np.median(ratios)) if ratios else 1.0


STATIONS = load_stations()
WORKDAY_FACTOR = workday_factor(STATIONS)
