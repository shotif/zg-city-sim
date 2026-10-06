"""Traffic counts: Hrvatske ceste "Brojenje prometa na cestama Republike Hrvatske 2025".

The published tables have no coordinates, so the stations around Zagreb are placed here by
hand from their road and section names: `at` is a point on the counted section between the
two interchanges or places the station is named after (good to a few hundred metres).
Stations on motorways and main roads that go on beyond the map also give the volume of
traffic crossing the map's edge there (`leaves_map`: about where it does), less what leaves
or joins at interchanges between the station and the edge (`beyond`: the share estimated to
carry on, from the towns those interchanges serve).
"""

from __future__ import annotations

from dataclasses import dataclass

ATTRIBUTION = {
    "name": "Hrvatske ceste, Brojenje prometa 2025",
    "text": "Traffic counts: Hrvatske ceste d.o.o., Brojenje prometa na cestama Republike "
    "Hrvatske godine 2025 (PGDP, average annual daily traffic).",
    "url": "https://hrvatske-ceste.hr/hr/stranice/promet-i-sigurnost/dokumenti/14-brojenje-prometa",
}


@dataclass(frozen=True)
class Station:
    id: int
    name: str
    #: Road number as signposted; Slovenia's A2 continues Croatia's A3 west of Bregana.
    road: str
    #: PGDP 2025: average annual daily traffic, both directions (vehicles per day).
    aadt: int
    #: (lon, lat) on the counted section.
    at: tuple[float, float]
    #: (lon, lat) where the counted road leaves the map, for stations that measure the
    #: traffic crossing the map's edge.
    leaves_map: tuple[float, float] | None = None
    #: Share of the counted traffic that crosses the map's edge.
    beyond: float = 1.0


STATIONS = [
    # Motorways: each measures traffic to and from one direction beyond the map.
    # Past Zdenčina.
    Station(1916, "Lučko – jug", "A1", 49_357, (15.80, 45.695), (15.684, 45.648), 0.85),
    Station(2027, "Zagreb (istok) – istok", "A3", 37_638, (16.33, 45.73), (16.383, 45.688)),
    # Past Luka and Zabok.
    Station(1904, "Zaprešić – sjever", "A2", 27_397, (15.83, 45.89), (15.913, 46.025), 0.7),
    # Bregana, the border with Slovenia.
    Station(1910, "Bobovica – zapad", "A3", 18_415, (15.71, 45.837), (15.682, 45.859)),
    # Past Komin.
    Station(2002, "Sveta Helena – sjever", "A4", 17_586, (16.28, 45.95), (16.297, 46.05), 0.9),
    # Past Buševec and Lekenik.
    Station(2031, "Mraclin – jug", "A11", 12_422, (16.13, 45.605), (16.301, 45.501), 0.65),
    # State roads; those inside the map without `leaves_map` are independent checks.
    Station(1937, "Pojatno", "D1", 17_459, (15.818, 45.90), (15.892, 46.017), 0.85),
    # Past Buševec and Lekenik, towards Sisak and Petrinja.
    Station(2043, "Petina", "D30", 30_419, (16.117, 45.68), (16.237, 45.537), 0.6),
    Station(1933, "Sveta Nedelja", "D231", 22_764, (15.775, 45.80)),
    Station(1925, "Zaprešić – istok", "D225", 21_161, (15.826, 45.842)),
    Station(2063, "Popovec", "D3", 16_743, (16.15, 45.86)),
]
